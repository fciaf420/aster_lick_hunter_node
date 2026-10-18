import { createHash } from 'crypto';
import type { Kline, MarkPrice, Order } from '../../types';
import type { AccountUpdate } from '../../api/userDataStream';
import type {
  AccountHistory,
  AccountStream,
  AccountUpdateEvent,
  ExchangeAdapter,
  OrderId,
  OrderRequest,
  ProtectiveOrdersRequest,
  RequestOptions,
  TickerPrice,
  UserDataEvent,
  UserDataHandlers,
  UserDataSubscription,
  VenueOrder,
  VenuePosition,
} from '../types';
import { normalizeOrderId } from '../orderId';
import { logErrorWithTimestamp, logWarnWithTimestamp, logWithTimestamp } from '../../utils/timestamp';
import {
  createLighterUserStream,
  isLighterOrderTerminal,
  lighterOrderId,
  mapLighterOrderStatus,
  mapLighterOrderType,
  mapLighterTimeInForce,
  parseLighterOrder,
  type LighterAccountStreamAlert,
  type LighterAuthTokenRequest,
  type LighterOrderSnapshot,
  type LighterUserStreamDeps,
} from './accountStream';
import { LIGHTER_CAPABILITIES } from './capabilities';
import {
  LIGHTER_ALL_MARKETS_ID,
  LIGHTER_CANDLE_RESOLUTIONS,
  LighterApiError,
  LighterAuthTokenManager,
  LighterHttpClient,
  type LighterAccountPosition,
  type LighterCandleResolution,
  type LighterDetailedAccount,
  type LighterHttpTransport,
  type LighterOrder,
  type LighterSimpleOrder,
} from './http';
import { LighterMarketError, isOpenInterestCapped, leverageToImf, type LighterMarketCache, type MappedLighterMarket } from './markets';
import {
  LIGHTER_MAX_CLIENT_ORDER_INDEX,
  LIGHTER_ORDER_ROLE,
  LighterClientOrderIndexGenerator,
  LighterNonceManager,
  LighterTxFailedError,
  LighterTxRejectedError,
  LighterTxUnknownError,
  MemoryLighterTxJournal,
  SqliteLighterTxJournal,
  type LighterClientOrderIndexRange,
  type LighterLateOutcome,
  type LighterOrderRole,
  type LighterTxJournal,
} from './nonce';
import { isDefinitelyNotPlaced, orderMayExist } from '../orderErrors';
import { getProfile, lighterStreamUrl, type LighterProfile, type LighterProfileName } from './profiles';
import { lighterTimestampToMs } from './time';
import {
  QUOTE_DECIMALS,
  formatScaled,
  fromPriceUnits,
  limitPriceRounding,
  scaleDecimal,
  toBaseAmountUnits,
  worstPriceUnits,
} from './scaling';
import {
  LIGHTER_CANCEL_ALL_TIME_IN_FORCE,
  LIGHTER_GROUPING_TYPE,
  LIGHTER_MARGIN_MODE,
  LIGHTER_ORDER_TYPE,
  LIGHTER_TIME_IN_FORCE,
  loadLighterSigner,
  type LighterOrderParams,
  type LighterSignedTx,
  type LighterSigner,
  type LoadLighterSignerOptions,
} from './signer';
import { LighterSendRateLimiter, LighterTxSender, type LighterTxWatcher } from './txSender';
import type { LighterSocketFactory } from './ws';

// Lighter (zkLighter) execution venue (lighter spec §5.5). Every order, cancel and leverage change is a signed
// L2 tx sent through the nonce manager (§5.1) and only reported once it has executed and, for orders, been
// read back by client order index (§5.3). Positions, orders and balances are returned in the Binance-style
// shapes the bot reads, with USDC as the margin asset.
//
// Money-safety rules enforced here (spec §8):
// - Trading waits for the startup checks: profile-bound credentials, the registered public key, an auth
//   token the exchange accepts, and a key that may take liquidity (risks 5, 20).
// - Only mapped, tradable markets accept new positions; precision and limits come from the market cache and
//   unknown symbols throw instead of falling back to defaults (risks 3, 4).
// - Stop loss / take profit are always reduce-only, sized from the confirmed position, never size 0, with one
//   explicit expiry for both OCO legs (risks 13, 14, 15). Reduce-only orders never exceed the position.
// - MARKET and trigger orders carry an explicit worst price from the BBO / trigger +- slippage (risk 23).
// - Order ids are client order indexes (numbers below 2^48); exchange order indexes stay exact (risk 12).

export const LIGHTER_ORDER_EXPIRY_MS = 28 * 24 * 60 * 60 * 1000;   // GTT / trigger orders: now + 28 days
export const LIGHTER_DEFAULT_MAX_SLIPPAGE_BPS = 50;                 // Bot default for maxSlippageBps
export const LIGHTER_DEFAULT_SLTP_SLIPPAGE_BPS = 100;               // Worst price after a trigger: 1% (FE default)
export const LIGHTER_BBO_MAX_AGE_MS = 3000;                         // Older market_stats BBO -> REST order book
export const LIGHTER_MARK_MAX_AGE_MS = 10_000;
export const LIGHTER_OPEN_INTEREST_MAX_AGE_MS = 60_000;             // market_stats open interest older than this is ignored
export const LIGHTER_VERIFY_FAILURE_BACKOFF_MS = 30_000;
// REST /account can trail the WS position the bot reacts to: re-read it this many times before refusing or
// cutting a reduce-only order
export const LIGHTER_REDUCE_ONLY_RECHECKS = 3;
export const LIGHTER_REDUCE_ONLY_RECHECK_MS = 500;
const BINANCE_UNKNOWN_ORDER_CODE = -2011;                           // The bot treats it as "already gone"
const BINANCE_REDUCE_ONLY_REJECTED_CODE = -2022;

// ===== Credentials =====

export interface LighterCredentials {
  profile: LighterProfileName;
  accountIndex: number;
  apiKeyIndex: number;
  apiKeyPrivateKey: string;   // 40 bytes hex (80 chars), optional 0x
  apiKeyPublicKey: string;    // As registered on the exchange (GET /api/v1/apikeys)
}

export type LighterCredentialsInput = Record<string, unknown> | LighterCredentials | null | undefined;

function readIndex(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value.trim())) return Number(value.trim());
  return null;
}

function readHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return /^(0x)?[0-9a-fA-F]+$/.test(text) && text !== '' ? text : null;
}

function normalizeHex(value: string): string {
  return value.trim().replace(/^0x/i, '').toLowerCase();
}

// Validate stored credentials. Accepts the catalog's field names (apiPrivateKey) too. Never echoes secrets.
export function parseLighterCredentials(input: LighterCredentialsInput): { credentials: LighterCredentials | null; problems: string[] } {
  const raw = (input ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const profile = typeof raw.profile === 'string' ? raw.profile.trim() : '';
  const accountIndex = readIndex(raw.accountIndex);
  const apiKeyIndex = readIndex(raw.apiKeyIndex);
  const privateKey = readHex(raw.apiKeyPrivateKey ?? raw.apiPrivateKey);
  const publicKey = readHex(raw.apiKeyPublicKey ?? raw.apiPublicKey);
  if (!profile) problems.push('profile missing (credentials must name the Lighter network they belong to)');
  if (accountIndex === null || accountIndex < 1) problems.push('accountIndex missing or invalid');
  if (apiKeyIndex === null || apiKeyIndex > 254) problems.push('apiKeyIndex missing or outside 0..254');
  if (!privateKey || normalizeHex(privateKey).length !== 80) problems.push('API private key missing or not 40 bytes of hex');
  if (!publicKey) problems.push('API public key missing');
  if (problems.length > 0) return { credentials: null, problems };
  return {
    credentials: {
      profile: profile as LighterProfileName,
      accountIndex: accountIndex as number,
      apiKeyIndex: apiKeyIndex as number,
      apiKeyPrivateKey: privateKey as string,
      apiKeyPublicKey: publicKey as string,
    },
    problems,
  };
}

// ===== Mapping helpers =====
// Built on the account stream's helpers so REST results (getOpenOrders, placeOrder, cancelOrder) carry exactly the
// ids, decimals and statuses of the ORDER_TRADE_UPDATE events (spec §4.5).

const LIMIT_PRICED_TYPES: ReadonlySet<string> = new Set(['LIMIT', 'STOP', 'TAKE_PROFIT']);

// Lighter timestamps: unit unverified (spec §9 Q3); normalized by magnitude like the liquidation feed
export const lighterTimeToMs = lighterTimestampToMs;

function snapshotOf(order: LighterOrder): LighterOrderSnapshot {
  const snapshot = parseLighterOrder(order);
  if (!snapshot) {
    throw new Error(`Lighter returned an order without id, market, side, status or type (order_id ${String(order.order_id)})`);
  }
  return snapshot;
}

// Binance X of a Lighter order; null for an unknown status, which callers must never read as "inactive"
export function lighterOrderStatus(order: LighterOrder): string | null {
  return mapLighterOrderStatus(snapshotOf(order));
}

function isPositiveDecimal(value: string | undefined): boolean {
  if (value === undefined) return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function isZeroDecimal(value: string | undefined): boolean {
  return value === undefined || value === '' || Number(value) === 0;
}

export interface LighterVenueOrder extends VenueOrder {
  timeInForce: string;
  avgPrice: string;
  lighterStatus: string;
  lighterOrderId: string;
  lighterPrice: string;
  triggerStatus: string;
}

export function toLighterVenueOrder(
  order: LighterOrder,
  botSymbol: string,
  botClientOrderId: string | undefined,
  now: number = Date.now()
): LighterVenueOrder {
  const snapshot = snapshotOf(order);
  const type = mapLighterOrderType(snapshot.type);
  const filled = Number(snapshot.filledBase);
  const quote = Number(snapshot.filledQuote);
  return {
    symbol: botSymbol,
    orderId: lighterOrderId(snapshot),
    clientOrderId: botClientOrderId || (snapshot.clientOrderIndex > 0 ? String(snapshot.clientOrderIndex) : ''),
    price: LIMIT_PRICED_TYPES.has(type) ? snapshot.price : '0',
    origQty: snapshot.initialBase,
    executedQty: snapshot.filledBase,
    status: mapLighterOrderStatus(snapshot) ?? 'NEW',
    type,
    side: snapshot.isAsk ? 'SELL' : 'BUY',
    stopPrice: snapshot.triggerPrice,
    time: lighterTimeToMs(order.created_at) ?? lighterTimeToMs(order.timestamp) ?? now,
    updateTime: lighterTimeToMs(order.updated_at) ?? lighterTimeToMs(order.timestamp) ?? now,
    workingType: 'MARK_PRICE',
    origType: type,
    positionSide: 'BOTH',
    reduceOnly: snapshot.reduceOnly,
    timeInForce: mapLighterTimeInForce(snapshot.timeInForce),
    avgPrice: filled > 0 && Number.isFinite(quote) ? String(quote / filled) : '0',
    lighterStatus: snapshot.status,
    lighterOrderId: snapshot.orderId,
    lighterPrice: snapshot.price,
    triggerStatus: snapshot.triggerStatus ?? '',
  };
}

// Leverage from a position's initial_margin_fraction percent string ("20.00" = 5x)
function leverageFromImfPercent(percent: string | undefined): number | null {
  const value = Number(percent);
  return Number.isFinite(value) && value > 0 ? Math.round(100 / value) : null;
}

function imfTicksFromPercent(percent: string | undefined): number | null {
  const value = Number(percent);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null;
}

// Signed decimal string -> micro units (6 decimals, extra digits truncated); null when unreadable
function toMicro(value: string | number | undefined | null): bigint | null {
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'number' ? (Number.isFinite(value) ? value.toFixed(QUOTE_DECIMALS) : '') : value.trim();
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const units = scaleDecimal(`${match[2]}${match[3] ? `.${match[3]}` : ''}`, QUOTE_DECIMALS, 'floor');
  return match[1] ? -units : units;
}

function microToString(units: bigint): string {
  return trimDecimal(formatScaled(units, QUOTE_DECIMALS));
}

function trimDecimal(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') || '0' : text;
}

function sumMicro(values: Array<string | undefined | null>): bigint {
  let total = BigInt(0);
  for (const value of values) total += toMicro(value) ?? BigInt(0);
  return total;
}

// Exact sum of decimal strings at 6 decimals (USDC), e.g. the balances of two sub-accounts. Digits past the 6th are
// truncated; missing or unreadable values count as 0.
export function sumLighterDecimals(values: Array<string | undefined | null>): string {
  return microToString(sumMicro(values));
}

function signedPositionAmount(position: LighterAccountPosition): string {
  const size = position.position ?? '0';
  if (isZeroDecimal(size)) return '0';
  return position.sign === -1 ? `-${size}` : size;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ===== Errors =====

// Order-level failures, with a Binance-style response.data so the bot's error handling reads them
export class LighterOrderError extends Error {
  readonly code: number | null;
  readonly response: { status: null; data: { code: number | null; msg: string; message: string } };

  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = 'LighterOrderError';
    this.code = code;
    this.response = { status: null, data: { code, msg: message, message } };
  }
}

// ===== Adapter =====

// Fresh market_stats data (e.g. LighterLiquidationSource.getMarketStats): BBO and mark, with the age of the oldest of
// the three, plus open interest and its limit (raw market_stats values) with their own age
export interface LighterMarketStatsSnapshot {
  bestBid: number | null;
  bestAsk: number | null;
  markPrice: number | null;
  ageMs: number;
  openInterest?: number | null;
  openInterestLimit?: number | null;
  openInterestAgeMs?: number | null;
}

export type CreateLighterUserStream = (deps: LighterUserStreamDeps, handlers: UserDataHandlers) => Promise<UserDataSubscription>;

export interface LighterSymbolTradeSettings {
  maxSlippageBps?: number;
}

export interface LighterAdapterOptions {
  profile: LighterProfile | LighterProfileName;
  // Read on every use, so config reloads apply; a changed key re-runs the startup checks
  credentials: LighterCredentialsInput | (() => LighterCredentialsInput);
  markets: LighterMarketCache;                 // Same profile; shared with the liquidation source
  http?: LighterHttpClient;
  transport?: LighterHttpTransport;            // For the default HTTP client
  signer?: LighterSigner;                      // Injected signer (tests); otherwise loaded on first use
  loadSigner?: (options: LoadLighterSignerOptions) => LighterSigner;
  signerLibraryPath?: string;
  journal?: LighterTxJournal | 'sqlite' | 'memory';   // Default 'sqlite' (data/lighter.db), opened on first trade
  journalPath?: string;
  symbolSettings?: (botSymbol: string) => LighterSymbolTradeSettings | undefined;
  defaultMaxSlippageBps?: number;
  sltpSlippageBps?: number;
  ocoFallback?: boolean;                       // Retry a refused OCO as two orders in one sendTxBatch (spec §5.5 step 6)
  sendTxPerMinute?: number;
  sendTxBurst?: number;
  confirmTimeoutMs?: number;
  pollIntervalMs?: number;
  marketStats?: (marketId: number) => LighterMarketStatsSnapshot | null | undefined;
  // Hedge mode (two sub-accounts): this account's client order index range (LIGHTER_HEDGE_COI_RANGES). Unset: the
  // plain one-way indexes.
  clientOrderIndexRange?: LighterClientOrderIndexRange;
  txWatcher?: LighterTxWatcher;
  createUserStream?: CreateLighterUserStream;  // Default: createLighterUserStream (accountStream.ts)
  wsFactory?: LighterSocketFactory;
  onUserStreamAlert?: (alert: LighterAccountStreamAlert) => void;
  // Outcome of a tx the nonce manager released to the background (it may have executed after all)
  onLateTxOutcome?: (outcome: LighterLateOutcome) => void;
  maxLockedResolveMs?: number;
  markPriceStreamUrl?: () => string;
  klineStreamUrl?: (subscriptions: { symbol: string; interval: string }[]) => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface SignerContext {
  fingerprint: string;
  credentials: LighterCredentials;
  signer: LighterSigner;
  auth: LighterAuthTokenManager;
}

interface TradingContext extends SignerContext {
  nonces: LighterNonceManager;
  sender: LighterTxSender;
  journal: LighterTxJournal;
}

export interface LighterStartupReport {
  profile: LighterProfileName;
  accountIndex: number;
  apiKeyIndex: number;
  networkId: number | null;
  userTier: string | null;
  takerFeeTick: number | null;
  journal: { accepted: number; expired: number; unknown: number };
}

export interface LighterPlacedOrder extends Order {
  orderId: number;            // The client order index: the same id getOpenOrders and the user stream (o.i) report
  executedQty: string;
  avgPrice: string;
  lighterStatus: string;
  lighterOrderId: string;
  txHash: string;
}

const MINUTE_MS = 60_000;
const INTERVAL_MS: Readonly<Record<LighterCandleResolution, number>> = {
  '1m': MINUTE_MS,
  '5m': 5 * MINUTE_MS,
  '15m': 15 * MINUTE_MS,
  '30m': 30 * MINUTE_MS,
  '1h': 60 * MINUTE_MS,
  '4h': 240 * MINUTE_MS,
  '12h': 720 * MINUTE_MS,
  '1d': 1440 * MINUTE_MS,
};

export class LighterAdapter implements ExchangeAdapter {
  readonly id = 'lighter' as const;
  readonly capabilities = LIGHTER_CAPABILITIES;
  readonly history: AccountHistory;
  readonly profile: LighterProfile;
  readonly markets: LighterMarketCache;
  readonly http: LighterHttpClient;
  readonly clientOrderIndexRange: LighterClientOrderIndexRange | null;

  private readonly options: LighterAdapterOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly coi: LighterClientOrderIndexGenerator;
  private readonly authProxy = { getAuthToken: (opts?: { forceRefresh?: boolean }) => this.signerContext().auth.getAuthToken(opts) };
  private signerCtx: SignerContext | null = null;
  private tradingCtx: TradingContext | null = null;
  private verifying: { fingerprint: string; promise: Promise<TradingContext> } | null = null;
  private verifyFailure: { fingerprint: string; at: number; error: Error } | null = null;
  private journalInstance: LighterTxJournal | null = null;
  // Every nonce manager this adapter made (a credential change replaces the current one, but the old one may
  // still be settling released txs)
  private readonly nonceManagers = new Set<LighterNonceManager>();
  private readonly userDataHandlers = new Set<UserDataHandlers>();
  private readonly warned = new Set<string>();

  constructor(options: LighterAdapterOptions) {
    this.options = options;
    this.profile = typeof options.profile === 'string' ? getProfile(options.profile) : options.profile;
    if (options.markets.profile.name !== this.profile.name) {
      throw new Error(`Lighter adapter (${this.profile.name}) was given market data for ${options.markets.profile.name}`);
    }
    this.markets = options.markets;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    this.clientOrderIndexRange = options.clientOrderIndexRange
      ? Object.freeze({ offset: options.clientOrderIndexRange.offset, span: options.clientOrderIndexRange.span })
      : null;
    this.coi = new LighterClientOrderIndexGenerator(this.now, this.clientOrderIndexRange ?? undefined);
    this.http = options.http ?? new LighterHttpClient({ profile: this.profile, transport: options.transport, auth: this.authProxy });
    if (this.http.profile.name !== this.profile.name) {
      throw new Error(`Lighter adapter (${this.profile.name}) was given an HTTP client for ${this.http.profile.name}`);
    }
    const noHistory = <T>(what: string) => async (): Promise<T[]> => {
      this.warnOnce(`history:${what}`, `Lighter: ${what} history is not available yet; returning no records`);
      return [];
    };
    this.history = {
      getIncomeHistory: noHistory('income'),
      getTimeRangeIncome: noHistory('income'),
      aggregateDailyPnLWithTrades: noHistory('daily PnL'),
      aggregateBySymbolWithTrades: noHistory('per-symbol PnL'),
      getAllOrders: noHistory('order'),
      getUserTrades: noHistory('trade'),
    };
  }

  // ----- Credentials, signer and startup checks -----

  private readCredentials(): { credentials: LighterCredentials | null; problems: string[] } {
    const source = this.options.credentials;
    return parseLighterCredentials(typeof source === 'function' ? source() : source);
  }

  hasCredentials(): boolean {
    return this.readCredentials().credentials !== null;
  }

  private rawCredentials(): Record<string, unknown> {
    try {
      const source = this.options.credentials;
      const value = typeof source === 'function' ? source() : source;
      return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  // The configured account index, even when other credential fields are missing (no network, never throws)
  configuredAccountIndex(): number | null {
    const index = readIndex(this.rawCredentials().accountIndex);
    return index !== null && index >= 1 ? index : null;
  }

  // The configured API key index (no network, never throws)
  configuredApiKeyIndex(): number | null {
    const index = readIndex(this.rawCredentials().apiKeyIndex);
    return index !== null && index <= 254 ? index : null;
  }

  private requireCredentials(): LighterCredentials {
    const { credentials, problems } = this.readCredentials();
    if (!credentials) {
      throw new Error(`Lighter credentials are incomplete: ${problems.join('; ')}`);
    }
    if (credentials.profile !== this.profile.name) {
      throw new Error(
        `Lighter credentials belong to profile "${credentials.profile}" but the bot is set to "${this.profile.name}". ` +
        'Keys, account indexes and nonces are per network; refusing to mix them.'
      );
    }
    return credentials;
  }

  private fingerprintOf(credentials: LighterCredentials): string {
    return createHash('sha256')
      .update([credentials.profile, credentials.accountIndex, credentials.apiKeyIndex,
        normalizeHex(credentials.apiKeyPublicKey), normalizeHex(credentials.apiKeyPrivateKey)].join(':'))
      .digest('hex');
  }

  // Signer and auth tokens for the current credentials (no network). Loads the native signer on first use.
  private signerContext(): SignerContext {
    const credentials = this.requireCredentials();
    const fingerprint = this.fingerprintOf(credentials);
    if (this.signerCtx?.fingerprint === fingerprint) return this.signerCtx;
    const signer = this.options.signer ?? (this.options.loadSigner ?? loadLighterSigner)({
      chainId: this.profile.chainId,
      accountIndex: credentials.accountIndex,
      apiKeyIndex: credentials.apiKeyIndex,
      apiKeyPrivateKey: credentials.apiKeyPrivateKey,
      libraryPath: this.options.signerLibraryPath,
    });
    if (signer.chainId !== this.profile.chainId || signer.accountIndex !== credentials.accountIndex || signer.apiKeyIndex !== credentials.apiKeyIndex) {
      throw new Error(
        `Lighter signer is set up for chain ${signer.chainId} account ${signer.accountIndex} key ${signer.apiKeyIndex}, ` +
        `expected chain ${this.profile.chainId} account ${credentials.accountIndex} key ${credentials.apiKeyIndex}`
      );
    }
    const auth = new LighterAuthTokenManager({ createToken: deadline => signer.createAuthToken(deadline), now: this.now });
    this.signerCtx = { fingerprint, credentials, signer, auth };
    this.tradingCtx = null;
    return this.signerCtx;
  }

  private journal(): LighterTxJournal {
    if (this.journalInstance) return this.journalInstance;
    const option = this.options.journal ?? 'sqlite';
    if (typeof option === 'object') {
      this.journalInstance = option;
    } else if (option === 'memory') {
      this.journalInstance = new MemoryLighterTxJournal();
    } else {
      try {
        this.journalInstance = new SqliteLighterTxJournal({ filePath: this.options.journalPath, profile: this.profile.name, now: this.now });
      } catch (error) {
        logErrorWithTimestamp(`Lighter: cannot open the tx journal (${errorText(error)}); keeping it in memory, so it will not survive a restart`);
        this.journalInstance = new MemoryLighterTxJournal();
      }
    }
    return this.journalInstance;
  }

  // Bot shutdown: stop settling released txs in the background. Unresolved ones stay in the journal for the next
  // start's reconcile.
  close(): void {
    for (const nonces of this.nonceManagers) nonces.dispose();
  }

  // Run the startup checks (spec §1.1 rule 4, §8 risks 5 and 20). Trading methods call this themselves and
  // refuse to trade until it passes; calling it at startup surfaces problems early.
  async verifyStartup(): Promise<LighterStartupReport> {
    const ctx = await this.ensureVerified();
    return (ctx as TradingContext & { report: LighterStartupReport }).report;
  }

  private async ensureVerified(): Promise<TradingContext> {
    const signerCtx = this.signerContext();
    if (this.tradingCtx?.fingerprint === signerCtx.fingerprint) return this.tradingCtx;
    if (this.verifying?.fingerprint === signerCtx.fingerprint) return this.verifying.promise;
    const failure = this.verifyFailure;
    if (failure && failure.fingerprint === signerCtx.fingerprint && this.now() - failure.at < LIGHTER_VERIFY_FAILURE_BACKOFF_MS) {
      throw failure.error;
    }
    const promise = this.runStartupChecks(signerCtx).then(
      ctx => {
        this.tradingCtx = ctx;
        this.verifyFailure = null;
        return ctx;
      },
      (error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.verifyFailure = { fingerprint: signerCtx.fingerprint, at: this.now(), error: err };
        throw err;
      }
    ).finally(() => {
      if (this.verifying?.promise === promise) this.verifying = null;
    });
    this.verifying = { fingerprint: signerCtx.fingerprint, promise };
    return promise;
  }

  private async runStartupChecks(ctx: SignerContext): Promise<TradingContext> {
    const { credentials } = ctx;
    const where = `${this.profile.label} account ${credentials.accountIndex} key ${credentials.apiKeyIndex}`;

    const status = await this.http.getStatus();
    const networkId = typeof status.network_id === 'number' ? status.network_id : null;
    if (networkId !== null && networkId !== this.profile.chainId) {
      // Whether network_id is the chain id is unverified (spec §9 Q17): log, don't gate
      logWarnWithTimestamp(`Lighter: ${this.profile.apiUrl} reports network_id ${networkId}; profile chain id is ${this.profile.chainId}`);
    }

    const keys = await this.http.getApiKeys(credentials.accountIndex, credentials.apiKeyIndex);
    const registered = keys.find(key => key.api_key_index === credentials.apiKeyIndex) ?? (keys.length === 1 ? keys[0] : undefined);
    if (!registered || typeof registered.public_key !== 'string' || registered.public_key === '') {
      throw new Error(`Lighter: API key ${credentials.apiKeyIndex} is not registered for account ${credentials.accountIndex} on ${this.profile.label}`);
    }
    if (normalizeHex(registered.public_key) !== normalizeHex(credentials.apiKeyPublicKey)) {
      throw new Error(`Lighter: the configured public key does not match the key registered for ${where}. Check the profile and key index.`);
    }

    // Needs an auth token the exchange accepts, so it also proves the private key matches the registered key
    const makerOnly = await this.http.getMakerOnlyApiKeys(credentials.accountIndex);
    if (makerOnly.includes(credentials.apiKeyIndex)) {
      throw new Error(`Lighter: API key ${credentials.apiKeyIndex} of account ${credentials.accountIndex} is maker-only; every taker entry would be rejected. Use a key without that restriction.`);
    }

    let userTier: string | null = null;
    let takerFeeTick: number | null = null;
    try {
      const limits = await this.http.getAccountLimits(credentials.accountIndex);
      userTier = limits.user_tier_name ?? limits.user_tier ?? null;
      takerFeeTick = typeof limits.current_taker_fee_tick === 'number' ? limits.current_taker_fee_tick : null;
    } catch (error) {
      logWarnWithTimestamp(`Lighter: could not read the account tier: ${errorText(error)}`);
    }

    await this.markets.ensureLoaded();

    const journal = this.journal();
    const sender = new LighterTxSender({
      http: this.http,
      limiter: new LighterSendRateLimiter({
        perMinute: this.options.sendTxPerMinute,
        burst: this.options.sendTxBurst,
        now: this.now,
        sleep: this.options.sleep,
      }),
      txWatcher: this.options.txWatcher,
      confirmTimeoutMs: this.options.confirmTimeoutMs,
      pollIntervalMs: this.options.pollIntervalMs,
      now: this.now,
      sleep: this.options.sleep,
    });
    const nonces = new LighterNonceManager({
      accountIndex: credentials.accountIndex,
      apiKeyIndex: credentials.apiKeyIndex,
      fetchNextNonce: callOptions => this.http.getNextNonce(credentials.accountIndex, credentials.apiKeyIndex, callOptions),
      send: (tx, callOptions) => sender.send(tx, callOptions),
      sendBatch: (txs, callOptions) => sender.sendBatch(txs, callOptions),
      lookupTx: (hash, callOptions) => sender.lookupTx(hash, callOptions),
      journal,
      maxLockedResolveMs: this.options.maxLockedResolveMs,
      onLateOutcome: this.options.onLateTxOutcome,
      now: this.now,
      sleep: this.options.sleep,
    });
    this.nonceManagers.add(nonces);
    const reconciled = await nonces.reconcileJournal();

    const report: LighterStartupReport = {
      profile: this.profile.name,
      accountIndex: credentials.accountIndex,
      apiKeyIndex: credentials.apiKeyIndex,
      networkId,
      userTier,
      takerFeeTick,
      journal: reconciled,
    };
    logWithTimestamp(
      `Lighter: startup checks passed for ${where} (chain ${this.profile.chainId}${userTier ? `, tier ${userTier}` : ''}` +
      `${takerFeeTick !== null ? `, taker fee ${takerFeeTick / 1e4}%` : ''})`
    );
    return Object.assign({ ...ctx, nonces, sender, journal }, { report });
  }

  // Auth token for private REST and WS (never log it). Honours the account stream's request: a rejected token
  // (forceNew) or one with less than minValidMs left is replaced.
  getAuthToken(request?: Partial<LighterAuthTokenRequest> & { forceRefresh?: boolean }): Promise<string> {
    const auth = this.signerContext().auth;
    const remainingMs = auth.deadlineSec * 1000 - this.now();
    const tooShort = request?.minValidMs !== undefined && auth.deadlineSec > 0 && remainingMs <= request.minValidMs;
    return auth.getAuthToken({ forceRefresh: request?.forceRefresh === true || request?.forceNew === true || tooShort });
  }

  // ----- Stream URLs -----

  getMarkPriceStreamUrl(): string {
    if (this.options.markPriceStreamUrl) return this.options.markPriceStreamUrl();
    this.warnOnce('stream:markPrice', 'Lighter: no Binance-format mark price stream; price consumers fall back to REST (getMarkPrice)');
    return lighterStreamUrl(this.profile);
  }

  getKlineStreamUrl(subscriptions: { symbol: string; interval: string }[]): string {
    if (this.options.klineStreamUrl) return this.options.klineStreamUrl(subscriptions);
    this.warnOnce('stream:kline', 'Lighter: no Binance-format kline stream; VWAP consumers fall back to REST (getKlines)');
    return lighterStreamUrl(this.profile);
  }

  // ----- Market data -----

  async getExchangeInfo(_options?: RequestOptions): Promise<any> {
    await this.markets.ensureLoaded();
    return this.markets.exchangeInfo();
  }

  // Mapped market usable for prices and orders: multiplier 1 only (x1000 mappings serve the liquidation feed)
  private priceMarket(symbol: string, allowUntradable = true): MappedLighterMarket {
    const mapped = this.markets.getBySymbol(symbol, { allowUntradable });
    if (mapped.multiplier !== 1) {
      throw new LighterMarketError(
        `${symbol} maps to Lighter ${mapped.lighterSymbol} x${mapped.multiplier}; it is a liquidation feed only, not tradable on Lighter`,
        'MULTIPLIER',
        symbol
      );
    }
    return mapped;
  }

  private freshStats(marketId: number, maxAgeMs: number): LighterMarketStatsSnapshot | null {
    const stats = this.options.marketStats?.(marketId);
    return stats && stats.ageMs >= 0 && stats.ageMs <= maxAgeMs ? stats : null;
  }

  private async detailsFor(marketId?: number): Promise<Array<Record<string, unknown>>> {
    const body = await this.http.getOrderBookDetails(marketId);
    const list = Array.isArray(body.order_book_details) ? (body.order_book_details as Array<Record<string, unknown>>) : [];
    return marketId === undefined ? list : list.filter(item => item.market_id === marketId);
  }

  private static priceText(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return String(value);
    if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) && Number(value) > 0) return value;
    return null;
  }

  async getMarkPrice(symbol?: string): Promise<MarkPrice | MarkPrice[]> {
    await this.markets.ensureLoaded();
    if (symbol) {
      const mapped = this.priceMarket(symbol);
      const stats = this.freshStats(mapped.marketId, LIGHTER_MARK_MAX_AGE_MS);
      if (stats?.markPrice) {
        return { symbol, markPrice: String(stats.markPrice), indexPrice: String(stats.markPrice) };
      }
      const [details] = await this.detailsFor(mapped.marketId);
      const mark = LighterAdapter.priceText(details?.mark_price);
      if (!mark) throw new LighterApiError('/api/v1/orderBookDetails', 200, null, `no mark price for ${symbol}`);
      return { symbol, markPrice: mark, indexPrice: LighterAdapter.priceText(details?.index_price) ?? mark };
    }
    const byId = new Map((await this.detailsFor()).map(item => [item.market_id, item]));
    const result: MarkPrice[] = [];
    for (const entry of this.markets.entries()) {
      if (entry.multiplier !== 1) continue;
      const details = byId.get(entry.marketId);
      const mark = LighterAdapter.priceText(details?.mark_price);
      if (mark) result.push({ symbol: entry.botSymbol, markPrice: mark, indexPrice: LighterAdapter.priceText(details?.index_price) ?? mark });
    }
    return result;
  }

  // The price the bot checks SL/TP against (PositionManager's underwater and past-TP checks). Lighter triggers on
  // mark and this adapter refuses a trigger already crossed against mark (markFor), so it returns that same mark:
  // fresh market_stats, else REST mark_price; the last trade price only when no mark exists. With the last price,
  // a stop moved just past last could still sit on the wrong side of mark and be refused on every retry.
  async getTickerPrice(symbol: string, _options?: RequestOptions): Promise<TickerPrice> {
    await this.markets.ensureLoaded();
    const mapped = this.priceMarket(symbol);
    const stats = this.freshStats(mapped.marketId, LIGHTER_MARK_MAX_AGE_MS);
    if (stats?.markPrice && stats.markPrice > 0) return { symbol, price: String(stats.markPrice) };
    const [details] = await this.detailsFor(mapped.marketId);
    const price = LighterAdapter.priceText(details?.mark_price) ?? LighterAdapter.priceText(details?.last_trade_price);
    if (!price) throw new LighterApiError('/api/v1/orderBookDetails', 200, null, `no mark or last price for ${symbol}`);
    return { symbol, price };
  }

  // Mark first, as getTickerPrice
  async getAllTickerPrices(_options?: RequestOptions): Promise<TickerPrice[]> {
    await this.markets.ensureLoaded();
    const byId = new Map((await this.detailsFor()).map(item => [item.market_id, item]));
    const result: TickerPrice[] = [];
    for (const entry of this.markets.entries()) {
      if (entry.multiplier !== 1) continue;
      const details = byId.get(entry.marketId);
      const price = LighterAdapter.priceText(details?.mark_price) ?? LighterAdapter.priceText(details?.last_trade_price);
      if (price) result.push({ symbol: entry.botSymbol, price });
    }
    return result;
  }

  // Candles for VWAP (spec §3.5). Binance intervals without a Lighter resolution are refused.
  async getKlines(symbol: string, interval: string = '1m', limit: number = 500): Promise<Kline[]> {
    await this.markets.ensureLoaded();
    const mapped = this.priceMarket(symbol);
    if (!(LIGHTER_CANDLE_RESOLUTIONS as readonly string[]).includes(interval)) {
      throw new Error(`Lighter has no ${interval} candles (available: ${LIGHTER_CANDLE_RESOLUTIONS.join(', ')})`);
    }
    const resolution = interval as LighterCandleResolution;
    const count = Math.max(1, Math.min(500, Math.floor(limit)));
    const end = this.now();
    const start = end - (count + 1) * INTERVAL_MS[resolution];
    const candles = await this.http.getCandles(mapped.marketId, resolution, start, end, count);
    const klines: Kline[] = [];
    for (const candle of candles) {
      const openTime = lighterTimeToMs(candle.t);
      if (openTime === null || candle.o === undefined || candle.h === undefined || candle.l === undefined || candle.c === undefined) continue;
      klines.push({
        openTime,
        open: String(candle.o),
        high: String(candle.h),
        low: String(candle.l),
        close: String(candle.c),
        volume: candle.v === undefined || candle.v === null ? '0' : String(candle.v),
      });
    }
    klines.sort((a, b) => a.openTime - b.openTime);
    return klines.slice(-count);
  }

  // Price levels from individual resting orders (orderBookOrders returns orders, not levels)
  private levels(orders: LighterSimpleOrder[], sizeDecimals: number, side: 'asks' | 'bids'): Array<[string, string]> {
    const byPrice = new Map<string, { price: number; size: bigint }>();
    for (const order of orders) {
      const price = order.price;
      const remaining = order.remaining_base_amount ?? order.initial_base_amount;
      if (!price || !remaining || !(Number(price) > 0)) continue;
      let size: bigint;
      try {
        size = scaleDecimal(remaining, sizeDecimals, 'floor');
      } catch {
        continue;
      }
      if (size <= BigInt(0)) continue;
      const key = String(Number(price));
      const level = byPrice.get(key) ?? { price: Number(price), size: BigInt(0) };
      level.size += size;
      byPrice.set(key, level);
    }
    return [...byPrice.entries()]
      .sort((a, b) => (side === 'asks' ? a[1].price - b[1].price : b[1].price - a[1].price))
      .map(([price, level]) => [price, trimDecimal(formatScaled(level.size, sizeDecimals))]);
  }

  async getOrderBook(symbol: string, limit: number = 5): Promise<any> {
    await this.markets.ensureLoaded();
    const mapped = this.priceMarket(symbol);
    const depth = Math.max(1, Math.floor(limit));
    const book = await this.http.getOrderBookOrders(mapped.marketId, Math.min(250, Math.max(50, depth * 5)));
    const time = this.now();
    return {
      lastUpdateId: time,
      E: time,
      T: time,
      bids: this.levels(book.bids, mapped.market.sizeDecimals, 'bids').slice(0, depth),
      asks: this.levels(book.asks, mapped.market.sizeDecimals, 'asks').slice(0, depth),
    };
  }

  async getBookTicker(symbol: string): Promise<any> {
    await this.markets.ensureLoaded();
    const mapped = this.priceMarket(symbol);
    const book = await this.getOrderBook(symbol, 1);
    const [bid] = book.bids as Array<[string, string]>;
    const [ask] = book.asks as Array<[string, string]>;
    if (!bid || !ask) throw new LighterApiError('/api/v1/orderBookOrders', 200, null, `empty order book for ${symbol} (market ${mapped.marketId})`);
    return { symbol, bidPrice: bid[0], bidQty: bid[1], askPrice: ask[0], askQty: ask[1], time: book.T };
  }

  // Best bid / ask for a MARKET worst price: market_stats when fresh (<= 3 s), else the REST order book
  private async bestBidAsk(mapped: MappedLighterMarket): Promise<{ bestBid: string | number | null; bestAsk: string | number | null; source: string }> {
    const stats = this.freshStats(mapped.marketId, LIGHTER_BBO_MAX_AGE_MS);
    if (stats && stats.bestBid && stats.bestAsk && stats.bestBid > 0 && stats.bestAsk > 0) {
      return { bestBid: stats.bestBid, bestAsk: stats.bestAsk, source: 'market_stats' };
    }
    const book = await this.http.getOrderBookOrders(mapped.marketId, 20);
    const best = (orders: LighterSimpleOrder[], pick: (a: number, b: number) => boolean): string | null => {
      let chosen: string | null = null;
      for (const order of orders) {
        if (!order.price || !(Number(order.price) > 0) || isZeroDecimal(order.remaining_base_amount ?? order.initial_base_amount)) continue;
        if (chosen === null || pick(Number(order.price), Number(chosen))) chosen = order.price;
      }
      return chosen;
    };
    return { bestBid: best(book.bids, (a, b) => a > b), bestAsk: best(book.asks, (a, b) => a < b), source: 'orderBookOrders' };
  }

  // Mark price to validate triggers against (spec §5.5 step 3)
  private async markFor(mapped: MappedLighterMarket): Promise<number> {
    const stats = this.freshStats(mapped.marketId, LIGHTER_MARK_MAX_AGE_MS);
    if (stats?.markPrice && stats.markPrice > 0) return stats.markPrice;
    const [details] = await this.detailsFor(mapped.marketId);
    const mark = LighterAdapter.priceText(details?.mark_price);
    if (!mark) throw new LighterOrderError(`Lighter: no mark price for ${mapped.botSymbol}; cannot validate trigger prices`);
    return Number(mark);
  }

  // ----- Account -----

  private accountIndex(): number {
    return this.requireCredentials().accountIndex;
  }

  private async account(): Promise<LighterDetailedAccount> {
    return this.http.getAccount(this.accountIndex(), { activeOnly: false });
  }

  private positionMark(position: LighterAccountPosition, mapped: MappedLighterMarket): string {
    const stats = this.freshStats(mapped.marketId, LIGHTER_MARK_MAX_AGE_MS);
    if (stats?.markPrice) return String(stats.markPrice);
    const size = Number(position.position);
    const value = Number(position.position_value);
    if (size > 0 && Number.isFinite(value) && value > 0) return String(value / size);   // position_value = |size| x mark (inferred)
    return mapped.market.markPrice !== null ? String(mapped.market.markPrice) : '0';
  }

  private toVenuePosition(position: LighterAccountPosition, mapped: MappedLighterMarket, now: number): VenuePosition {
    const isolated = position.margin_mode === 1;
    const leverage = leverageFromImfPercent(position.initial_margin_fraction)
      ?? (mapped.market.defaultInitialMarginFraction > 0 ? Math.round(10000 / mapped.market.defaultInitialMarginFraction) : 0);
    return {
      symbol: mapped.botSymbol,
      positionAmt: signedPositionAmount(position),
      entryPrice: position.avg_entry_price ?? '0',
      markPrice: this.positionMark(position, mapped),
      unRealizedProfit: position.unrealized_pnl ?? '0',
      liquidationPrice: position.liquidation_price ?? '0',
      leverage: String(leverage),
      marginType: isolated ? 'isolated' : 'cross',
      isolatedMargin: isolated ? position.allocated_margin ?? '0' : '0',
      isAutoAddMargin: 'false',
      positionSide: 'BOTH',
      updateTime: now,
    };
  }

  // Mapped (bot symbol, multiplier 1) positions. Positions in markets the bot doesn't map are left out (and
  // logged once): the bot never manages them.
  private mappedPositions(account: LighterDetailedAccount): Array<{ position: LighterAccountPosition; mapped: MappedLighterMarket }> {
    const result: Array<{ position: LighterAccountPosition; mapped: MappedLighterMarket }> = [];
    for (const position of account.positions ?? []) {
      if (typeof position.market_id !== 'number') continue;
      const mapped = this.markets.findByMarketId(position.market_id);
      if (!mapped || mapped.multiplier !== 1) {
        if (!isZeroDecimal(position.position)) {
          this.warnOnce(`unmapped-position:${position.market_id}`,
            `Lighter: open position in ${position.symbol ?? `market ${position.market_id}`} is not mapped to a bot symbol; the bot leaves it alone`);
        }
        continue;
      }
      result.push({ position, mapped });
    }
    return result;
  }

  async getPositions(symbol?: string, _options?: RequestOptions): Promise<VenuePosition[]> {
    await this.markets.ensureLoaded();
    const account = await this.account();
    const now = this.now();
    return this.mappedPositions(account)
      .filter(({ mapped }) => !symbol || mapped.botSymbol === symbol)
      .map(({ position, mapped }) => this.toVenuePosition(position, mapped, now));
  }

  private openOrderClientId(coi: number | undefined): string | undefined {
    if (typeof coi !== 'number' || coi <= 0) return undefined;
    const record = this.journalInstance?.getClientOrder(coi);
    return record?.botClientOrderId || undefined;
  }

  async getOpenOrders(symbol?: string, _options?: RequestOptions): Promise<VenueOrder[]> {
    await this.markets.ensureLoaded();
    const marketId = symbol ? this.priceMarket(symbol).marketId : LIGHTER_ALL_MARKETS_ID;
    const orders = await this.http.getActiveOrders(this.accountIndex(), marketId);
    const now = this.now();
    const result: VenueOrder[] = [];
    for (const order of orders) {
      if (typeof order.market_index !== 'number') continue;
      const mapped = this.markets.findByMarketId(order.market_index);
      if (!mapped || mapped.multiplier !== 1 || (symbol && mapped.botSymbol !== symbol)) {
        if (!mapped) this.warnOnce(`unmapped-order:${order.market_index}`, `Lighter: open orders in unmapped market ${order.market_index} are not shown to the bot`);
        continue;
      }
      let venueOrder: LighterVenueOrder;
      try {
        venueOrder = toLighterVenueOrder(order, mapped.botSymbol, this.openOrderClientId(order.client_order_index), now);
      } catch (error) {
        logErrorWithTimestamp(`Lighter: skipping an unreadable open order on ${mapped.botSymbol}: ${errorText(error)}`);
        continue;
      }
      if (lighterOrderStatus(order) === null) {
        // Listed as active, so it is active: never infer "inactive" from an unknown status (spec §8 risk 9)
        logErrorWithTimestamp(`Lighter: order ${order.order_id ?? '?'} on ${mapped.botSymbol} has unknown status "${order.status}"; treating it as open`);
      }
      result.push(venueOrder);
    }
    return result;
  }

  private balanceFigures(account: LighterDetailedAccount) {
    const positions = this.mappedPositions(account).map(({ position }) => position);
    const allPositions = account.positions ?? [];
    const wallet = toMicro(account.collateral) ?? BigInt(0);
    const isolatedAllocated = sumMicro(allPositions.filter(p => p.margin_mode === 1).map(p => p.allocated_margin));
    const unrealized = sumMicro(allPositions.map(p => p.unrealized_pnl));
    const crossUnrealized = sumMicro(allPositions.filter(p => p.margin_mode !== 1).map(p => p.unrealized_pnl));
    const available = toMicro(account.available_balance) ?? BigInt(0);
    const crossInitial = toMicro(account.cross_initial_margin_requirement);
    let initialMargin: bigint;
    if (crossInitial !== null) {
      initialMargin = crossInitial + isolatedAllocated;
    } else {
      initialMargin = BigInt(0);
      for (const position of allPositions) {
        const value = Math.abs(Number(position.position_value ?? 0));
        const imf = Number(position.initial_margin_fraction ?? 0);
        if (Number.isFinite(value) && Number.isFinite(imf)) initialMargin += toMicro((value * imf) / 100) ?? BigInt(0);
      }
    }
    const marginBalance = toMicro(account.total_asset_value) ?? wallet + unrealized;
    return {
      positions,
      wallet: microToString(wallet),
      crossWallet: microToString(wallet - isolatedAllocated),
      unrealized: microToString(unrealized),
      crossUnrealized: microToString(crossUnrealized),
      available: microToString(available),
      initialMargin: microToString(initialMargin),
      maintMargin: microToString(toMicro(account.cross_maintenance_margin_requirement) ?? BigInt(0)),
      marginBalance: microToString(marginBalance),
    };
  }

  // Binance /fapi/v2/balance shape, margin asset USDC (spec §4.1)
  async getBalance(): Promise<any> {
    const account = await this.account();
    const figures = this.balanceFigures(account);
    return [{
      accountAlias: `lighter-${this.profile.name}`,
      asset: LIGHTER_CAPABILITIES.marginAsset,
      balance: figures.wallet,
      crossWalletBalance: figures.crossWallet,
      crossUnPnl: figures.crossUnrealized,
      availableBalance: figures.available,
      maxWithdrawAmount: figures.available,
      marginAvailable: true,
      updateTime: this.now(),
    }];
  }

  // Binance /fapi/v4/account shape (spec §4.1 getAccountInfo)
  async getAccountInfo(): Promise<any> {
    await this.markets.ensureLoaded();
    const account = await this.account();
    const figures = this.balanceFigures(account);
    const now = this.now();
    const positions = this.mappedPositions(account).map(({ position, mapped }) => {
      const venue = this.toVenuePosition(position, mapped, now);
      const value = Number(position.position_value ?? 0);
      const imf = Number(position.initial_margin_fraction ?? 0);
      const initial = Number.isFinite(value) && Number.isFinite(imf) ? (Math.abs(value) * imf) / 100 : 0;
      return {
        symbol: venue.symbol,
        positionAmt: venue.positionAmt,
        entryPrice: venue.entryPrice,
        unrealizedProfit: venue.unRealizedProfit,
        initialMargin: initial.toFixed(QUOTE_DECIMALS),
        positionInitialMargin: initial.toFixed(QUOTE_DECIMALS),
        maintMargin: '0',
        openOrderInitialMargin: '0',
        leverage: venue.leverage,
        isolated: venue.marginType === 'isolated',
        isolatedWallet: venue.isolatedMargin,
        positionSide: 'BOTH',
        notional: venue.positionAmt.startsWith('-') && !isZeroDecimal(position.position_value) ? `-${position.position_value}` : position.position_value ?? '0',
        maxNotional: '0',
        updateTime: now,
      };
    });
    const asset = LIGHTER_CAPABILITIES.marginAsset;
    return {
      feeTier: 0,
      canTrade: true,
      canDeposit: true,
      canWithdraw: true,
      updateTime: now,
      multiAssetsMargin: false,
      totalInitialMargin: figures.initialMargin,
      totalMaintMargin: figures.maintMargin,
      totalWalletBalance: figures.wallet,
      totalUnrealizedProfit: figures.unrealized,
      totalMarginBalance: figures.marginBalance,
      totalPositionInitialMargin: figures.initialMargin,
      totalOpenOrderInitialMargin: '0',
      totalCrossWalletBalance: figures.crossWallet,
      totalCrossUnPnl: figures.crossUnrealized,
      availableBalance: figures.available,
      maxWithdrawAmount: figures.available,
      assets: [{
        asset,
        walletBalance: figures.wallet,
        unrealizedProfit: figures.unrealized,
        marginBalance: figures.marginBalance,
        maintMargin: figures.maintMargin,
        initialMargin: figures.initialMargin,
        positionInitialMargin: figures.initialMargin,
        openOrderInitialMargin: '0',
        crossWalletBalance: figures.crossWallet,
        crossUnPnl: figures.crossUnrealized,
        availableBalance: figures.available,
        maxWithdrawAmount: figures.available,
        marginAvailable: true,
        updateTime: now,
      }],
      positions,
      lighter: {
        profile: this.profile.name,
        accountIndex: this.accountIndex(),
        collateral: account.collateral ?? '0',
        totalAssetValue: account.total_asset_value ?? null,
        crossAssetValue: account.cross_asset_value ?? null,
      },
    };
  }

  // The account's L1 (master) address from the public GET /account: sub-accounts of one master share it. Works on a
  // read-only adapter. l1Address is null when the exchange leaves it out.
  async getAccountIdentity(): Promise<{ accountIndex: number; l1Address: string | null }> {
    const accountIndex = this.accountIndex();
    const account = await this.http.getAccount(accountIndex, { activeOnly: false });
    const l1Address = typeof account.l1_address === 'string' && account.l1_address.trim() !== '' ? account.l1_address.trim() : null;
    return { accountIndex, l1Address };
  }

  // One netted position per market
  async getHedgeMode(): Promise<boolean> {
    return false;
  }

  async setHedgeMode(enabled: boolean): Promise<void> {
    if (enabled) {
      throw new Error('Lighter has no hedge mode (one netted position per market). Use ONE_WAY position mode.');
    }
  }

  // Current initial margin fraction (1/10000 ticks) of a market from the account, or null when unknown
  private async currentImf(marketId: number): Promise<number | null> {
    const account = await this.account();
    const position = (account.positions ?? []).find(p => p.market_id === marketId);
    return imfTicksFromPercent(position?.initial_margin_fraction);
  }

  // UpdateLeverage (tx 20, cross margin). Clamped to the market maximum, imf = ceil(10000 / leverage)
  // (spec §5.5, §8 risk 17), skipped when already set, verified against the account afterwards.
  async setLeverage(symbol: string, leverage: number): Promise<any> {
    const ctx = await this.ensureVerified();
    const mapped = this.priceMarket(symbol);
    const target = leverageToImf(mapped.market, leverage);
    if (target.capped) {
      logWarnWithTimestamp(`Lighter: ${symbol} leverage ${leverage}x capped to the market maximum ${mapped.market.maxLeverage}x`);
    }
    const reported = Math.round(10000 / target.initialMarginFraction);
    const before = await this.currentImf(mapped.marketId);
    if (before === target.initialMarginFraction) {
      return { symbol, leverage: reported, effectiveLeverage: target.effectiveLeverage, initialMarginFraction: target.initialMarginFraction, unchanged: true };
    }
    const submission = await ctx.nonces.submit(nonce => ctx.signer.signUpdateLeverage({
      marketIndex: mapped.marketId,
      initialMarginFraction: target.initialMarginFraction,
      marginMode: LIGHTER_MARGIN_MODE.CROSS,
      nonce,
    }));
    await this.requireExecuted(ctx, submission.tx, `leverage change on ${symbol}`);
    const after = await this.currentImf(mapped.marketId);
    if (after !== null && after !== target.initialMarginFraction) {
      throw new LighterOrderError(
        `Lighter: leverage change on ${symbol} executed but the account shows initial margin fraction ${after} instead of ${target.initialMarginFraction}`
      );
    }
    logWithTimestamp(`Lighter: ${symbol} leverage set to ${target.effectiveLeverage.toFixed(2)}x (initial margin fraction ${target.initialMarginFraction}/10000)`);
    this.emitUserData({ e: 'ACCOUNT_CONFIG_UPDATE', E: this.now(), T: this.now(), ac: { s: symbol, l: reported } });
    return { symbol, leverage: reported, effectiveLeverage: target.effectiveLeverage, initialMarginFraction: target.initialMarginFraction, txHash: submission.tx.txHash };
  }

  // ----- User data -----

  // Delegates to the account stream (accountStream.ts): it owns the private WS, auth refresh and reconcile.
  // The adapter adds the persisted client order ids, fresh marks and its own synthesized events (leverage).
  async subscribeUserData(handlers: UserDataHandlers): Promise<UserDataSubscription> {
    const ctx = this.signerContext();
    const create = this.options.createUserStream ?? createLighterUserStream;
    const stream = await create({
      profile: this.profile,
      accountIndex: ctx.credentials.accountIndex,
      apiKeyIndex: ctx.credentials.apiKeyIndex,
      getAuthToken: request => this.getAuthToken(request),
      markets: this.markets,
      http: this.http,
      wsFactory: this.options.wsFactory,
      getMarkPrice: marketId => this.freshStats(marketId, LIGHTER_MARK_MAX_AGE_MS)?.markPrice ?? null,
      resolveClientOrderId: clientOrderIndex => this.openOrderClientId(clientOrderIndex),
      onAlert: this.options.onUserStreamAlert,
    }, handlers);
    this.userDataHandlers.add(handlers);
    let closed = false;
    return {
      close: async () => {
        if (closed) return;
        closed = true;
        this.userDataHandlers.delete(handlers);
        await stream.close();
      },
    };
  }

  private emitUserData(event: UserDataEvent): void {
    for (const handlers of this.userDataHandlers) {
      try {
        handlers.onEvent(event);
      } catch (error) {
        logErrorWithTimestamp('Lighter: user data handler failed:', errorText(error));
      }
    }
  }

  createAccountStream(): AccountStream {
    return new LighterAccountStream(this);
  }

  // ----- Orders -----

  private orderRole(request: OrderRequest & { newClientOrderId?: unknown }, reduceOnly: boolean): LighterOrderRole {
    if (request.type === 'STOP_MARKET') return LIGHTER_ORDER_ROLE.STOP_LOSS;
    if (request.type === 'TAKE_PROFIT_MARKET') return LIGHTER_ORDER_ROLE.TAKE_PROFIT;
    const clientId = typeof request.newClientOrderId === 'string' ? request.newClientOrderId : '';
    if (clientId.startsWith('al_sl_')) return LIGHTER_ORDER_ROLE.STOP_LOSS;
    if (clientId.startsWith('al_tp_')) return LIGHTER_ORDER_ROLE.TAKE_PROFIT;
    return reduceOnly ? LIGHTER_ORDER_ROLE.OTHER : LIGHTER_ORDER_ROLE.ENTRY;
  }

  // Reduce-only size from the confirmed position (spec §5.5 step 1, §8 risk 7): the position must exist on the
  // side being reduced; a larger request is cut to the position size. The bot reacts to the WS position, which REST
  // /account can trail by a moment (the account stream itself waits for a second reply before trusting an absence),
  // so a missing or smaller position is re-read a few times (about 1.5 s) before the order is refused or cut.
  // A cut is logged as an error and returned as `shortfall`: placeProtectiveOrders reports it in `errors`, which
  // PositionManager logs (error DB, high severity); its periodic check (30 s) compares the SL/TP size with the
  // position and replaces orders that are too small.
  private async reduceOnlySize(
    mapped: MappedLighterMarket,
    side: 'BUY' | 'SELL',
    baseAmount: number,
    what: string
  ): Promise<{ size: number; shortfall: string | null }> {
    let size = 0;
    let signed = 0;
    let reduces = false;
    for (let attempt = 0; ; attempt++) {
      const account = await this.account();
      const position = (account.positions ?? []).find(p => p.market_id === mapped.marketId);
      size = position && !isZeroDecimal(position.position)
        ? toBaseAmountUnits(position.position as string, mapped.market.sizeDecimals, 'floor', { allowZero: true })
        : 0;
      signed = position?.sign === -1 ? -size : size;
      reduces = (side === 'SELL' && signed > 0) || (side === 'BUY' && signed < 0);
      if ((reduces && baseAmount <= size) || attempt >= LIGHTER_REDUCE_ONLY_RECHECKS) break;
      await this.sleep(LIGHTER_REDUCE_ONLY_RECHECK_MS);
    }
    if (!reduces) {
      throw new LighterOrderError(
        `Lighter: ${what} on ${mapped.botSymbol} needs a ${side === 'SELL' ? 'long' : 'short'} position to reduce, ` +
        `but the account shows ${signed === 0 ? 'none' : signed > 0 ? 'a long' : 'a short'}`,
        BINANCE_REDUCE_ONLY_REJECTED_CODE
      );
    }
    if (baseAmount > size) {
      const requested = this.markets.fromBaseAmount(mapped.botSymbol, baseAmount);
      const held = this.markets.fromBaseAmount(mapped.botSymbol, size);
      const shortfall = `${what} sized ${held}, below the requested ${requested}: the account still shows the smaller position`;
      logErrorWithTimestamp(`Lighter: ${shortfall} on ${mapped.botSymbol}`);
      return { size, shortfall };
    }
    return { size: baseAmount, shortfall: null };
  }

  // Trigger direction against mark, as the FE checks it (spec §5.5 step 3). A trigger already crossed would
  // fire at once.
  private checkTrigger(kind: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET', side: 'BUY' | 'SELL', trigger: number, mark: number, symbol: string): void {
    // side SELL protects a long: SL below mark, TP above. side BUY protects a short: SL above, TP below.
    const mustBeBelow = (kind === 'STOP_MARKET') === (side === 'SELL');
    const ok = mustBeBelow ? trigger < mark : trigger > mark;
    if (!ok) {
      const label = kind === 'STOP_MARKET' ? 'stop loss' : 'take profit';
      throw new LighterOrderError(
        `Lighter: ${label} trigger ${trigger} for ${symbol} must be ${mustBeBelow ? 'below' : 'above'} the mark price ${mark}; ` +
        'Order would immediately trigger'
      );
    }
  }

  private orderExpiry(): number {
    return this.now() + LIGHTER_ORDER_EXPIRY_MS;
  }

  // Spec §8 risk 16: once open_interest x 2 reaches the limit the exchange accepts reduce-only orders only, so a new
  // position would be cancelled after a signed tx and a confirm wait (and a LIMIT entry would fall back to MARKET).
  // Refused here when fresh market_stats shows the cap. Without fresh data (no Lighter feed running, e.g. Aster
  // liquidations) or with unreadable values the entry is sent: the exchange refuses it and rejectIfDead reports
  // that, so nothing phantom is opened, and an unverified field never stops all trading.
  private assertOpenInterestRoom(mapped: MappedLighterMarket): void {
    const stats = this.options.marketStats?.(mapped.marketId);
    const ageMs = stats?.openInterestAgeMs;
    if (!stats || typeof ageMs !== 'number' || ageMs < 0 || ageMs > LIGHTER_OPEN_INTEREST_MAX_AGE_MS) return;
    const capped = isOpenInterestCapped(stats.openInterest, stats.openInterestLimit);
    if (capped === true) {
      throw new LighterOrderError(
        `Lighter: ${mapped.botSymbol} is at its open interest cap (open interest ${stats.openInterest}, limit ${stats.openInterestLimit}); ` +
        'the exchange only accepts reduce-only orders there'
      );
    }
    if (capped === null) {
      this.warnOnce(`oi-unreadable:${mapped.marketId}`,
        `Lighter: market_stats for ${mapped.botSymbol} has no readable open interest / limit; the open interest cap is not checked`);
    }
  }

  private slippageBps(symbol: string): number {
    const configured = this.options.symbolSettings?.(symbol)?.maxSlippageBps;
    const bps = configured ?? this.options.defaultMaxSlippageBps ?? LIGHTER_DEFAULT_MAX_SLIPPAGE_BPS;
    if (!(bps > 0) || bps >= 10_000) throw new LighterOrderError(`Lighter: invalid maxSlippageBps ${bps} for ${symbol}`);
    return bps;
  }

  private sltpSlippageBps(): number {
    return this.options.sltpSlippageBps ?? LIGHTER_DEFAULT_SLTP_SLIPPAGE_BPS;
  }

  // Trigger price units and the worst fill price after the trigger for a protective order
  private triggerAndWorst(mapped: MappedLighterMarket, side: 'BUY' | 'SELL', triggerPrice: number | string): { trigger: number; worst: number } {
    const trigger = this.markets.toPrice(mapped.botSymbol, triggerPrice, limitPriceRounding(side));
    const worst = worstPriceUnits(fromPriceUnits(trigger, mapped.market.priceDecimals), side, this.sltpSlippageBps(), mapped.market.priceDecimals);
    return { trigger, worst };
  }

  private async requireExecuted(ctx: TradingContext, tx: LighterSignedTx, what: string): Promise<void> {
    const confirmation = await ctx.sender.confirmTx(tx.txHash);
    if (confirmation.status === 'executed') return;
    if (confirmation.status === 'failed') {
      throw new LighterTxFailedError(`Lighter ${what} failed: ${confirmation.message}`, {
        code: confirmation.code, txHash: tx.txHash, detail: confirmation.message,
      });
    }
    throw new LighterTxUnknownError(`Lighter ${what} was accepted but not confirmed within the timeout; check the account before retrying`, {
      txHash: tx.txHash, detail: 'confirmation timeout', expiredAt: tx.expiredAt,
    });
  }

  // §5.3: tx executed (or the orders visible), then the orders read back by client order index
  private async confirmOrders(ctx: TradingContext, txs: LighterSignedTx[], cois: number[], what: string): Promise<Map<number, LighterOrder>> {
    const started = this.now();
    const confirmations = await Promise.all(txs.map(tx => ctx.sender.confirmTx(tx.txHash)));
    const failed = confirmations.find(c => c.status === 'failed');
    if (failed && failed.status === 'failed') {
      throw new LighterTxFailedError(`Lighter ${what} failed: ${failed.message}`, {
        code: failed.code, txHash: failed.tx.hash ?? null, detail: failed.message,
      });
    }
    const executed = confirmations.every(c => c.status === 'executed');
    const budget = (this.options.confirmTimeoutMs ?? 15_000) - (this.now() - started);
    const found = await ctx.sender.findOrders(ctx.credentials.accountIndex, cois, {
      timeoutMs: executed ? Math.max(2000, budget) : 1000,
      done: map => cois.every(coi => map.has(coi) && map.get(coi)?.status !== 'in-progress'),
    });
    const missing = cois.filter(coi => !found.has(coi));
    if (missing.length > 0) {
      // Either way the orders may exist (an executed tx whose orders are not visible yet, or a tx still pending):
      // the caller must not place replacements. A pending tx can execute until its ExpiredAt; an executed one's
      // orders have no such bound.
      throw new LighterTxUnknownError(
        executed
          ? `Lighter ${what} executed but order ${missing.join(', ')} is not visible on the account`
          : `Lighter ${what} was accepted but not confirmed within the timeout; it may still execute`,
        {
          txHash: txs[0]?.txHash ?? null,
          detail: executed ? 'order not visible' : 'confirmation timeout',
          expiredAt: executed || txs.length === 0 ? null : Math.max(...txs.map(tx => tx.expiredAt)),
        }
      );
    }
    return found;
  }

  private placedOrder(
    order: LighterOrder,
    request: { symbol: string; side: 'BUY' | 'SELL'; type: string },
    coi: number,
    botClientOrderId: string,
    tx: LighterSignedTx
  ): LighterPlacedOrder {
    const status = lighterOrderStatus(order);
    if (status === null) {
      logErrorWithTimestamp(`Lighter: order ${coi} on ${request.symbol} has unknown status "${order.status}"; reporting it as NEW`);
    }
    const filled = order.filled_base_amount ?? '0';
    const filledQuote = Number(order.filled_quote_amount ?? '0');
    const avg = Number(filled) > 0 && Number.isFinite(filledQuote) ? filledQuote / Number(filled) : 0;
    const isLimit = request.type === 'LIMIT';
    return {
      symbol: request.symbol,
      orderId: coi,
      clientOrderId: botClientOrderId || String(coi),
      side: request.side,
      type: request.type,
      quantity: Number(order.initial_base_amount ?? '0'),
      price: isLimit ? Number(order.price ?? '0') : avg,
      status: status ?? 'NEW',
      updateTime: lighterTimeToMs(order.updated_at) ?? this.now(),
      executedQty: filled,
      avgPrice: String(avg),
      lighterStatus: order.status ?? '',
      lighterOrderId: order.order_id ?? '',
      txHash: tx.txHash,
    };
  }

  // A placed order that the exchange cancelled at once (margin, slippage, liquidity, post-only, ...) without any
  // fill did not happen: report it as a failure, never as a placed order
  private rejectIfDead(order: LighterOrder, what: string): void {
    const status = order.status ?? '';
    if (isLighterOrderTerminal(status) && status !== 'filled' && !isPositiveDecimal(order.filled_base_amount)) {
      throw new LighterOrderError(`Lighter ${what} was not placed: the exchange cancelled it (${status})`);
    }
  }

  async placeOrder(request: OrderRequest): Promise<Order> {
    const req = request as OrderRequest & { newClientOrderId?: unknown; closePosition?: unknown };
    const { symbol, side, type } = req;
    if (side !== 'BUY' && side !== 'SELL') throw new LighterOrderError(`Lighter: invalid side ${String(side)}`);
    if (!['LIMIT', 'MARKET', 'STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(type)) {
      throw new LighterOrderError(`Lighter: order type ${String(type)} is not supported`);
    }
    if (req.positionSide && req.positionSide !== 'BOTH') {
      throw new LighterOrderError('Lighter has no hedge mode: positionSide must be BOTH', -4061);
    }
    if (req.timeInForce === 'FOK') throw new LighterOrderError('Lighter has no fill-or-kill orders');
    if (req.closePosition === true || req.closePosition === 'true') {
      throw new LighterOrderError('Lighter: closePosition orders are not supported; pass an explicit quantity');
    }
    const quantity = Number(req.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new LighterOrderError(`Lighter: invalid quantity ${String(req.quantity)}`);

    const protective = type === 'STOP_MARKET' || type === 'TAKE_PROFIT_MARKET';
    // Protective orders are always reduce-only, whatever the request says (spec §8 risk 13)
    const reduceOnly = protective || req.reduceOnly === true;
    const ctx = await this.ensureVerified();
    const mapped = reduceOnly ? this.priceMarket(symbol, true) : this.priceMarket(symbol, false);
    const what = `${type} ${side} ${symbol}`;
    if (!reduceOnly) this.assertOpenInterestRoom(mapped);

    let baseAmount = this.markets.toBaseAmount(symbol, req.quantity, 'floor');
    if (reduceOnly) baseAmount = (await this.reduceOnlySize(mapped, side, baseAmount, what)).size;

    let price: number;
    let triggerPrice = 0;
    let orderType: LighterOrderParams['type'];
    let timeInForce: LighterOrderParams['timeInForce'];
    let orderExpiry = 0;
    if (type === 'LIMIT') {
      if (req.price === undefined || !(Number(req.price) > 0)) throw new LighterOrderError(`Lighter: LIMIT order on ${symbol} needs a price`);
      price = this.markets.toPrice(symbol, req.price, limitPriceRounding(side));
      orderType = LIGHTER_ORDER_TYPE.LIMIT;
      if (req.timeInForce === 'IOC') {
        timeInForce = LIGHTER_TIME_IN_FORCE.IOC;
      } else {
        timeInForce = req.timeInForce === 'GTX' ? LIGHTER_TIME_IN_FORCE.POST_ONLY : LIGHTER_TIME_IN_FORCE.GTT;
        orderExpiry = this.orderExpiry();
      }
    } else if (type === 'MARKET') {
      const bbo = await this.bestBidAsk(mapped);
      const reference = side === 'BUY' ? bbo.bestAsk : bbo.bestBid;
      if (reference === null || !(Number(reference) > 0)) {
        throw new LighterOrderError(`Lighter: no ${side === 'BUY' ? 'ask' : 'bid'} in the ${symbol} order book; cannot price a MARKET order`);
      }
      price = this.markets.worstPrice(symbol, reference, side, this.slippageBps(symbol));
      orderType = LIGHTER_ORDER_TYPE.MARKET;
      timeInForce = LIGHTER_TIME_IN_FORCE.IOC;
    } else {
      if (req.stopPrice === undefined || !(Number(req.stopPrice) > 0)) throw new LighterOrderError(`Lighter: ${type} on ${symbol} needs a stopPrice`);
      const { trigger, worst } = this.triggerAndWorst(mapped, side, req.stopPrice);
      this.checkTrigger(type as 'STOP_MARKET' | 'TAKE_PROFIT_MARKET', side, Number(fromPriceUnits(trigger, mapped.market.priceDecimals)), await this.markFor(mapped), symbol);
      price = worst;
      triggerPrice = trigger;
      orderType = type === 'STOP_MARKET' ? LIGHTER_ORDER_TYPE.STOP_LOSS : LIGHTER_ORDER_TYPE.TAKE_PROFIT;
      timeInForce = LIGHTER_TIME_IN_FORCE.IOC;
      orderExpiry = this.orderExpiry();
    }
    this.markets.assertOrderLimits(symbol, baseAmount, price, { reduceOnly });

    const role = this.orderRole(req, reduceOnly);
    const coi = this.coi.next(role);
    const botClientOrderId = typeof req.newClientOrderId === 'string' ? req.newClientOrderId : '';
    ctx.journal.saveClientOrder({ clientOrderIndex: coi, botClientOrderId, symbol, marketId: mapped.marketId, role, createdAt: this.now() });

    const params: LighterOrderParams = {
      marketIndex: mapped.marketId,
      clientOrderIndex: coi,
      baseAmount,
      price,
      isAsk: side === 'SELL',
      type: orderType,
      timeInForce,
      reduceOnly,
      triggerPrice,
      orderExpiry,
    };
    const submission = await ctx.nonces.submit(nonce => ctx.signer.signCreateOrder({ ...params, nonce }), { clientOrderIndexes: [coi] });
    const orders = await this.confirmOrders(ctx, [submission.tx], [coi], what);
    const order = orders.get(coi) as LighterOrder;
    this.rejectIfDead(order, what);
    const placed = this.placedOrder(order, { symbol, side, type }, coi, botClientOrderId, submission.tx);
    logWithTimestamp(`Lighter: ${what} order ${coi} ${placed.status} (${order.status}), size ${fromBaseUnitsText(this.markets, symbol, baseAmount)}`);
    return placed;
  }

  // Stop loss + take profit as one native OCO (grouped tx 28, spec §5.5): both legs reduce-only, sized from
  // the confirmed position, one explicit expiry. Errors are returned per leg, never thrown.
  async placeProtectiveOrders(request: ProtectiveOrdersRequest): Promise<{ stopLoss?: Order; takeProfit?: Order; errors: string[] }> {
    const { symbol, side } = request;
    const fail = (error: unknown) => {
      const message = errorText(error);
      return { errors: [`SL: ${message}`, `TP: ${message}`], mayExist: orderMayExist(error) };
    };
    let ctx: TradingContext;
    let mapped: MappedLighterMarket;
    let legs: { sl: LighterOrderParams; tp: LighterOrderParams };
    let shortfall: string | null = null;
    try {
      if (side !== 'BUY' && side !== 'SELL') throw new LighterOrderError(`Lighter: invalid side ${String(side)}`);
      if (request.positionSide && request.positionSide !== 'BOTH') {
        throw new LighterOrderError('Lighter has no hedge mode: positionSide must be BOTH', -4061);
      }
      ctx = await this.ensureVerified();
      mapped = this.priceMarket(symbol, true);
      const what = `SL/TP ${side} ${symbol}`;
      let baseAmount = this.markets.toBaseAmount(symbol, request.quantity, 'floor');
      const sized = await this.reduceOnlySize(mapped, side, baseAmount, what);   // Never 0 (risk 14)
      baseAmount = sized.size;
      shortfall = sized.shortfall;
      const sl = this.triggerAndWorst(mapped, side, request.stopLossPrice);
      const tp = this.triggerAndWorst(mapped, side, request.takeProfitPrice);
      const mark = await this.markFor(mapped);
      const pd = mapped.market.priceDecimals;
      this.checkTrigger('STOP_MARKET', side, Number(fromPriceUnits(sl.trigger, pd)), mark, symbol);
      this.checkTrigger('TAKE_PROFIT_MARKET', side, Number(fromPriceUnits(tp.trigger, pd)), mark, symbol);
      this.markets.assertOrderLimits(symbol, baseAmount, sl.worst, { reduceOnly: true });
      this.markets.assertOrderLimits(symbol, baseAmount, tp.worst, { reduceOnly: true });
      const expiry = this.orderExpiry();   // One explicit expiry for both legs (risk 15)
      const leg = (type: LighterOrderParams['type'], trigger: number, worst: number): LighterOrderParams => ({
        marketIndex: mapped.marketId,
        clientOrderIndex: 0,
        baseAmount,
        price: worst,
        isAsk: side === 'SELL',
        type,
        timeInForce: LIGHTER_TIME_IN_FORCE.IOC,
        reduceOnly: true,   // Always (risk 13)
        triggerPrice: trigger,
        orderExpiry: expiry,
      });
      legs = { sl: leg(LIGHTER_ORDER_TYPE.STOP_LOSS, sl.trigger, sl.worst), tp: leg(LIGHTER_ORDER_TYPE.TAKE_PROFIT, tp.trigger, tp.worst) };
    } catch (error) {
      logErrorWithTimestamp(`Lighter: SL/TP for ${symbol} not placed:`, errorText(error));
      return fail(error);
    }

    const assign = () => {
      const slCoi = this.coi.next(LIGHTER_ORDER_ROLE.STOP_LOSS);
      const tpCoi = this.coi.next(LIGHTER_ORDER_ROLE.TAKE_PROFIT);
      const stamp = this.now() % 10_000_000_000;
      const ids = { sl: `al_sl_${symbol}_${stamp}`, tp: `al_tp_${symbol}_${stamp}` };
      ctx.journal.saveClientOrder({ clientOrderIndex: slCoi, botClientOrderId: ids.sl, symbol, marketId: mapped.marketId, role: LIGHTER_ORDER_ROLE.STOP_LOSS, createdAt: this.now() });
      ctx.journal.saveClientOrder({ clientOrderIndex: tpCoi, botClientOrderId: ids.tp, symbol, marketId: mapped.marketId, role: LIGHTER_ORDER_ROLE.TAKE_PROFIT, createdAt: this.now() });
      return {
        sl: { ...legs.sl, clientOrderIndex: slCoi },
        tp: { ...legs.tp, clientOrderIndex: tpCoi },
        ids,
      };
    };

    const finish = (orders: Map<number, LighterOrder>, placed: ReturnType<typeof assign>, txs: LighterSignedTx[]) => {
      const result: { stopLoss?: Order; takeProfit?: Order; errors: string[] } = { errors: shortfall ? [shortfall] : [] };
      const legResult = (label: 'SL' | 'TP', params: LighterOrderParams, botId: string, type: string) => {
        const order = orders.get(params.clientOrderIndex);
        if (!order) {
          result.errors.push(`${label}: order ${params.clientOrderIndex} not found after placement`);
          return undefined;
        }
        try {
          this.rejectIfDead(order, `${label} ${symbol}`);
        } catch (error) {
          result.errors.push(`${label}: ${errorText(error)}`);
          return undefined;
        }
        return this.placedOrder(order, { symbol, side, type }, params.clientOrderIndex, botId, txs[label === 'SL' ? 0 : txs.length - 1]);
      };
      result.stopLoss = legResult('SL', placed.sl, placed.ids.sl, 'STOP_MARKET');
      result.takeProfit = legResult('TP', placed.tp, placed.ids.tp, 'TAKE_PROFIT_MARKET');
      return result;
    };

    const placedOco = assign();
    try {
      const submission = await ctx.nonces.submit(
        nonce => ctx.signer.signGroupedOrders({ groupingType: LIGHTER_GROUPING_TYPE.OCO, orders: [placedOco.sl, placedOco.tp], nonce }),
        { clientOrderIndexes: [placedOco.sl.clientOrderIndex, placedOco.tp.clientOrderIndex] }
      );
      const orders = await this.confirmOrders(ctx, [submission.tx], [placedOco.sl.clientOrderIndex, placedOco.tp.clientOrderIndex], `SL/TP OCO on ${symbol}`);
      const result = finish(orders, placedOco, [submission.tx]);
      logWithTimestamp(`Lighter: OCO SL/TP on ${symbol}: SL ${result.stopLoss ? placedOco.sl.clientOrderIndex : 'failed'}, TP ${result.takeProfit ? placedOco.tp.clientOrderIndex : 'failed'}`);
      return result;
    } catch (error) {
      // Only a definite "not executed" may fall back. An unknown outcome or an unconfirmed OCO may exist on the
      // exchange, and a second pair of orders would double the protection size.
      const refused = (error instanceof LighterTxRejectedError || error instanceof LighterTxFailedError) && isDefinitelyNotPlaced(error);
      if (!refused || this.options.ocoFallback === false) {
        logErrorWithTimestamp(`Lighter: OCO SL/TP on ${symbol} failed:`, errorText(error));
        return fail(error);
      }
      // A refused OCO with explicit sizes (spec §9 Q10): fall back to two orders in one batch on the same key
      logWarnWithTimestamp(`Lighter: OCO SL/TP on ${symbol} refused (${errorText(error)}); sending SL and TP as two orders in one batch`);
      try {
        const placed = assign();
        const batch = await ctx.nonces.submitBatch([
          nonce => ctx.signer.signCreateOrder({ ...placed.sl, nonce }),
          nonce => ctx.signer.signCreateOrder({ ...placed.tp, nonce }),
        ], { clientOrderIndexes: [placed.sl.clientOrderIndex, placed.tp.clientOrderIndex] });
        const orders = await this.confirmOrders(ctx, batch.txs, [placed.sl.clientOrderIndex, placed.tp.clientOrderIndex], `SL/TP batch on ${symbol}`)
          .catch(async (confirmError: unknown) => {
            // One leg may have gone through: report what exists
            const partial = await ctx.sender.findOrders(ctx.credentials.accountIndex, [placed.sl.clientOrderIndex, placed.tp.clientOrderIndex], { timeoutMs: 0 });
            if (partial.size === 0) throw confirmError;
            return partial;
          });
        return finish(orders, placed, batch.txs);
      } catch (fallbackError) {
        logErrorWithTimestamp(`Lighter: SL/TP batch on ${symbol} failed:`, errorText(fallbackError));
        return fail(fallbackError);
      }
    }
  }

  // Cancel by client order index, or by exchange order_index for orders placed outside the bot (spec §5.5).
  // An order that is already filled or cancelled (e.g. the OCO sibling the exchange cancelled) counts as
  // success; an order the exchange doesn't know raises Binance code -2011, which the bot treats as gone.
  async cancelOrder(symbol: string, orderId: OrderId): Promise<any> {
    const ctx = await this.ensureVerified();
    const mapped = this.priceMarket(symbol, true);
    const id = normalizeOrderId(orderId);
    const isClientIndex = typeof id === 'number' && Number.isSafeInteger(id) && id >= 1 && id <= LIGHTER_MAX_CLIENT_ORDER_INDEX;
    if (!isClientIndex && !(typeof id === 'number' ? Number.isSafeInteger(id) && id > LIGHTER_MAX_CLIENT_ORDER_INDEX : /^\d+$/.test(id))) {
      throw new LighterOrderError(`Lighter: invalid order id ${String(orderId)}`);
    }
    const unknownOrder = () => new LighterOrderError(`Lighter: order ${String(id)} on ${symbol} is not open (unknown, filled or cancelled)`, BINANCE_UNKNOWN_ORDER_CODE);

    // Throws when the lookup itself fails: a failed read must never look like "order unknown"
    const lookup = async (): Promise<LighterOrder | undefined> => {
      if (isClientIndex) {
        const orders = await this.http.getOrdersByClientOrderIndex(ctx.credentials.accountIndex, [id as number]);
        return orders.find(order => order.client_order_index === id);
      }
      const active = await this.http.getActiveOrders(ctx.credentials.accountIndex, mapped.marketId);
      return active.find(order => order.order_id === String(id));
    };

    const existing = await lookup();
    if (!existing) throw unknownOrder();
    if (typeof existing.market_index === 'number' && existing.market_index !== mapped.marketId) {
      throw new LighterOrderError(`Lighter: order ${String(id)} belongs to market ${existing.market_index}, not ${symbol} (market ${mapped.marketId})`);
    }
    const clientOrderId = this.openOrderClientId(existing.client_order_index) ?? String(id);
    const result = (order: LighterOrder, alreadyTerminal: boolean) => ({
      symbol,
      orderId: id,
      clientOrderId,
      status: lighterOrderStatus(order) ?? 'CANCELED',
      lighterStatus: order.status ?? '',
      alreadyTerminal,
    });
    if (isLighterOrderTerminal(existing.status ?? '')) {
      return result(existing, true);
    }

    const index = isClientIndex ? (id as number) : String(id);
    const submission = await ctx.nonces.submit(nonce => ctx.signer.signCancelOrder({ marketIndex: mapped.marketId, index, nonce }));
    try {
      await this.requireExecuted(ctx, submission.tx, `cancel of order ${String(id)} on ${symbol}`);
    } catch (error) {
      // It may have filled or been cancelled by the exchange meanwhile; that is a success for the caller.
      // If the order can't be read, the original error stands.
      let after: LighterOrder | undefined;
      try {
        after = await lookup();
      } catch {
        throw error;
      }
      if (!isClientIndex && !after) return { symbol, orderId: id, clientOrderId, status: 'CANCELED', lighterStatus: '', alreadyTerminal: true };
      if (after && isLighterOrderTerminal(after.status ?? '')) return result(after, true);
      throw error;
    }
    if (!isClientIndex) {
      const after = await lookup();
      if (after) throw new LighterOrderError(`Lighter: cancel of order ${String(id)} on ${symbol} executed but the order is still open`);
      return { symbol, orderId: id, clientOrderId, status: 'CANCELED', lighterStatus: 'canceled', alreadyTerminal: false };
    }
    const found = await ctx.sender.findOrders(ctx.credentials.accountIndex, [id as number], {
      timeoutMs: 5000,
      done: map => isLighterOrderTerminal(map.get(id as number)?.status ?? ''),
    });
    const after = found.get(id as number);
    if (!after || !isLighterOrderTerminal(after.status ?? '')) {
      throw new LighterOrderError(`Lighter: cancel of order ${String(id)} on ${symbol} executed but the order still shows ${after?.status ?? 'nothing'}`);
    }
    return result(after, false);
  }

  // Cancel every order of one market, SL/TP included (tx 16, immediate, market-scoped)
  async cancelAllOrders(symbol: string): Promise<any> {
    const ctx = await this.ensureVerified();
    const mapped = this.priceMarket(symbol, true);
    const submission = await ctx.nonces.submit(nonce => ctx.signer.signCancelAll({
      timeInForce: LIGHTER_CANCEL_ALL_TIME_IN_FORCE.IMMEDIATE,
      time: 0,
      marketIndex: mapped.marketId,
      nonce,
    }));
    await this.requireExecuted(ctx, submission.tx, `cancel-all on ${symbol}`);
    return { code: 200, msg: 'The operation of cancel all open order is done.', symbol, txHash: submission.tx.txHash };
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    logWarnWithTimestamp(message);
  }
}

function fromBaseUnitsText(markets: LighterMarketCache, symbol: string, units: number): string {
  try {
    return markets.fromBaseAmount(symbol, units);
  } catch {
    return String(units);
  }
}

// Balance-service stream (Binance AccountUpdate shape) on top of subscribeUserData
export class LighterAccountStream implements AccountStream {
  private subscription: UserDataSubscription | null = null;
  private connected = false;

  constructor(private readonly adapter: Pick<LighterAdapter, 'subscribeUserData'>) {}

  async start(onAccountUpdate?: (data: AccountUpdate) => void): Promise<void> {
    if (this.subscription) return;
    this.subscription = await this.adapter.subscribeUserData({
      onEvent: event => {
        if (event.e === 'ACCOUNT_UPDATE' && onAccountUpdate) onAccountUpdate(toAccountUpdate(event));
      },
      onConnected: () => {
        this.connected = true;
      },
      onDisconnected: () => {
        this.connected = false;
      },
    });
    this.connected = true;
  }

  async stop(): Promise<void> {
    const subscription = this.subscription;
    this.subscription = null;
    this.connected = false;
    if (subscription) await subscription.close();
  }

  isHealthy(): boolean {
    return this.subscription !== null && this.connected;
  }
}

export function toAccountUpdate(event: AccountUpdateEvent): AccountUpdate {
  return {
    eventType: 'ACCOUNT_UPDATE',
    eventTime: event.E,
    transactionTime: event.T ?? event.E,
    updateData: {
      reasonType: event.a.m ?? 'ORDER',
      balances: (event.a.B ?? []).map(balance => ({
        asset: balance.a,
        walletBalance: balance.wb,
        crossWalletBalance: balance.cw ?? balance.wb,
        balanceChange: balance.bc ?? '0',
      })),
      positions: (event.a.P ?? []).map(position => ({
        symbol: position.s,
        positionAmount: position.pa,
        entryPrice: position.ep,
        accumulatedRealized: position.cr ?? '0',
        unrealizedPnL: position.up,
        marginType: position.mt,
        isolatedWallet: position.iw ?? '0',
        positionSide: position.ps ?? 'BOTH',
      })),
    },
  };
}
