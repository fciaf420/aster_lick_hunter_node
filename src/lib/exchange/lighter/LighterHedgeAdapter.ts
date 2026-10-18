import type { Kline, MarkPrice, Order } from '../../types';
import type {
  AccountHistory,
  AccountStream,
  AccountUpdateEvent,
  EntryMargin,
  ExchangeAdapter,
  OrderId,
  OrderRequest,
  ProtectiveOrdersRequest,
  RequestOptions,
  TickerPrice,
  UserDataBalance,
  UserDataEvent,
  UserDataHandlers,
  UserDataPosition,
  UserDataSubscription,
  VenueCapabilities,
  VenueOrder,
  VenuePosition,
} from '../types';
import { normalizeOrderId } from '../orderId';
import { logErrorWithTimestamp, logWarnWithTimestamp, logWithTimestamp } from '../../utils/timestamp';
import { LIGHTER_CAPABILITIES } from './capabilities';
import {
  LighterAccountStream,
  LighterAdapter,
  LighterOrderError,
  sumLighterDecimals,
  type LighterStartupReport,
} from './LighterAdapter';
import type { LighterMarketCache } from './markets';
import {
  LIGHTER_HEDGE_COI_RANGES,
  LIGHTER_MAX_CLIENT_ORDER_INDEX,
  lighterHedgeSideOfClientOrderIndex,
  type LighterClientOrderIndexRange,
  type LighterHedgeSide,
} from './nonce';
import type { LighterProfile, LighterProfileName } from './profiles';

export type { LighterHedgeSide } from './nonce';

// Hedge mode emulation on Lighter with two sub-accounts. Lighter nets one position per market per account, so every
// long lives on the "long account" (the main account) and every short on the "short account". The bot's hedge-mode
// logic (positionSide LONG / SHORT, separate SL/TP per side) then works as on a venue with native hedge mode.
//
// Money-safety rules enforced here:
// - Routing is by positionSide, which is required (LONG or SHORT). Opening orders exist only as BUY on the long
//   account and SELL on the short account; every other order is forced reduce-only, so the exchange never lets it
//   grow or flip a position.
// - Before every entry, the target account is read fresh; an account holding a position of the wrong direction
//   (a manual trade) refuses new entries until it is closed. Such positions stay protected (reduce-only SL/TP).
// - Errors from the inner adapters pass through unchanged (orderMayExist, mayExistUntil, code and response.data.code
//   must survive). This class only throws its own errors before anything is sent.
// - Merged reads never return a partial result, and the merged user stream never reports positions until both
//   accounts' full position sets are known: a partial set would make PositionManager drop the other side. Every
//   merged REST read of the positions (what PositionManager syncs from) also refreshes the stream's per-account state,
//   so an update of one account never carries an older view of the other one than PositionManager already has.
// - Each account's bot orders use their own client order index range, so an index says which account it is on.

export const LIGHTER_HEDGE_CAPABILITIES: VenueCapabilities = Object.freeze({
  ...LIGHTER_CAPABILITIES,
  hedgeMode: true,           // Emulated: longs on the main account, shorts on a second sub-account
}) as VenueCapabilities;

// Retry delays for reading an account's state over REST when its stream has not reported it (the last one repeats)
export const LIGHTER_HEDGE_SEED_RETRY_MS: ReadonlyArray<number> = [2_000, 5_000, 10_000, 30_000];

export const LIGHTER_HEDGE_POSITION_SIDE_MESSAGE = 'Lighter hedge mode (two sub-accounts): positionSide must be LONG or SHORT';
export const LIGHTER_HEDGE_ONE_WAY_MESSAGE =
  'Lighter hedge mode (two sub-accounts) cannot switch to one-way while running. ' +
  'Set position mode ONE_WAY (or turn hedge mode off in the Lighter settings) and restart the bot.';

const BINANCE_POSITION_MODE_CODE = -4061;   // Makes Hunter re-read the position mode and retry with the right side
const BINANCE_UNKNOWN_ORDER_CODE = -2011;
const SIDES: readonly LighterHedgeSide[] = ['LONG', 'SHORT'];

export interface LighterHedgeAlert {
  kind: 'wrong-sign' | 'different-master' | 'seed-failed';
  message: string;
  side?: LighterHedgeSide;
  symbol?: string;
}

export interface LighterHedgeAdapterOptions {
  long: LighterAdapter;                        // Main account (clientOrderIndexRange LIGHTER_HEDGE_COI_RANGES.LONG)
  short: LighterAdapter;                       // Short account (LIGHTER_HEDGE_COI_RANGES.SHORT)
  onAlert?: (alert: LighterHedgeAlert) => void;
  now?: () => number;
  seedRetryMs?: ReadonlyArray<number>;
}

export interface LighterHedgeStartupReport {
  profile: LighterProfileName;
  long: LighterStartupReport;
  short: LighterStartupReport;
  sameMaster: boolean | null;                  // null: an account's L1 address could not be read
  wrongSign: Array<{ side: LighterHedgeSide; symbol: string; positionAmt: string }>;
}

// Several inner calls failed (or one of a pair): names the account(s); the first inner error is kept as `cause`
export class LighterHedgeError extends Error {
  readonly failures: Partial<Record<LighterHedgeSide, unknown>>;

  constructor(message: string, failures: Partial<Record<LighterHedgeSide, unknown>>) {
    super(message);
    this.name = 'LighterHedgeError';
    this.failures = failures;
    (this as { cause?: unknown }).cause = failures.LONG ?? failures.SHORT;
  }
}

// G4 refusal: the account refuses every new entry until its wrong-direction position is closed, so a retry or a
// LIMIT -> MARKET fallback would be refused again (orderRefusalRepeats). Nothing was sent.
class LighterHedgeEntryRefusal extends LighterOrderError {
  readonly refusalRepeats = true;
}

// ===== Helpers =====

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function otherSide(side: LighterHedgeSide): LighterHedgeSide {
  return side === 'LONG' ? 'SHORT' : 'LONG';
}

function hedgeSideOf(positionSide: unknown): LighterHedgeSide | null {
  return positionSide === 'LONG' || positionSide === 'SHORT' ? positionSide : null;
}

function accountName(side: LighterHedgeSide): string {
  return side === 'LONG' ? 'long account' : 'short account';
}

// The side of an order that reduces this account's position: SELL for the long account, BUY for the short one
function closingSide(side: LighterHedgeSide): 'BUY' | 'SELL' {
  return side === 'LONG' ? 'SELL' : 'BUY';
}

function isZeroAmount(value: string | undefined): boolean {
  return value !== undefined && value !== '' && Number(value) === 0;
}

// A long account holding a short, or a short account holding a long
function isWrongSign(side: LighterHedgeSide, amount: string): boolean {
  const value = Number(amount);
  return side === 'LONG' ? value < 0 : value > 0;
}

function isUnknownOrderError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as { code?: unknown; response?: { data?: { code?: unknown } } };
  return err.code === BINANCE_UNKNOWN_ORDER_CODE || err.response?.data?.code === BINANCE_UNKNOWN_ORDER_CODE;
}

// Anything that reduces the account's position: protective types, an explicit reduce-only or close-position flag, or
// the closing side of the account
function isReducing(request: OrderRequest & { closePosition?: unknown }, side: LighterHedgeSide): boolean {
  return request.type === 'STOP_MARKET' ||
    request.type === 'TAKE_PROFIT_MARKET' ||
    request.reduceOnly === true ||
    (request.reduceOnly as unknown) === 'true' ||
    Boolean(request.closePosition) ||
    request.side === closingSide(side);
}

function sameRange(a: LighterClientOrderIndexRange | null, b: LighterClientOrderIndexRange): boolean {
  return a !== null && a.offset === b.offset && a.span === b.span;
}

type SignRow = { symbol: string; positionAmt: string };

// ===== Adapter =====

export class LighterHedgeAdapter implements ExchangeAdapter {
  readonly id = 'lighter' as const;
  readonly capabilities = LIGHTER_HEDGE_CAPABILITIES;
  readonly history: AccountHistory;
  readonly profile: LighterProfile;
  readonly markets: LighterMarketCache;
  readonly long: LighterAdapter;
  readonly short: LighterAdapter;

  private readonly onAlert: ((alert: LighterHedgeAlert) => void) | undefined;
  private readonly now: () => number;
  private readonly seedRetryMs: ReadonlyArray<number>;
  // Per account: symbols whose position has the wrong direction for the account, with the signed amount
  private readonly wrongSign: Record<LighterHedgeSide, Map<string, string>> = { LONG: new Map(), SHORT: new Map() };
  // Open merged user streams (PositionManager's and the balance service's), refreshed by every merged positions read
  private readonly userStreams = new Set<LighterHedgeUserStream>();

  constructor(options: LighterHedgeAdapterOptions) {
    const { long, short } = options;
    if (long === short) {
      throw new Error('Lighter hedge mode needs two different adapters, one per sub-account');
    }
    if (long.profile.name !== short.profile.name) {
      throw new Error(
        `Lighter hedge mode: the long account is on ${long.profile.name} but the short account on ${short.profile.name}; ` +
        'both accounts must be on one network'
      );
    }
    if (long.markets !== short.markets) {
      throw new Error('Lighter hedge mode: both accounts must share one market cache');
    }
    if (!sameRange(long.clientOrderIndexRange, LIGHTER_HEDGE_COI_RANGES.LONG) || !sameRange(short.clientOrderIndexRange, LIGHTER_HEDGE_COI_RANGES.SHORT)) {
      throw new Error('Lighter hedge mode: each account adapter needs its own client order index range (LIGHTER_HEDGE_COI_RANGES LONG / SHORT)');
    }
    const longIndex = long.configuredAccountIndex();
    const shortIndex = short.configuredAccountIndex();
    if (longIndex !== null && longIndex === shortIndex) {
      throw new Error(`Lighter hedge mode: the short account index ${shortIndex} must differ from the main (long) account index`);
    }
    this.long = long;
    this.short = short;
    this.profile = long.profile;
    this.markets = long.markets;
    this.history = long.history;
    this.onAlert = options.onAlert;
    this.now = options.now ?? Date.now;
    this.seedRetryMs = options.seedRetryMs ?? LIGHTER_HEDGE_SEED_RETRY_MS;
  }

  private account(side: LighterHedgeSide): LighterAdapter {
    return side === 'LONG' ? this.long : this.short;
  }

  private label(side: LighterHedgeSide): string {
    const index = this.account(side).configuredAccountIndex();
    return `${accountName(side)}${index !== null ? ` ${index}` : ''}`;
  }

  hasCredentials(): boolean {
    return this.long.hasCredentials() && this.short.hasCredentials();
  }

  // Bot shutdown: both accounts stop settling released txs
  close(): void {
    this.long.close();
    this.short.close();
  }

  // ----- Alerts and wrong-direction positions -----

  private alert(alert: LighterHedgeAlert): void {
    logErrorWithTimestamp(`Lighter hedge [${alert.kind}]: ${alert.message}`);
    try {
      this.onAlert?.(alert);
    } catch (error) {
      logErrorWithTimestamp('Lighter hedge: onAlert failed:', errorText(error));
    }
  }

  private wrongSignMessage(side: LighterHedgeSide, symbol: string, amount: string): string {
    const index = this.account(side).configuredAccountIndex();
    const direction = side === 'LONG' ? 'long' : 'short';
    const held = side === 'LONG' ? 'short' : 'long';
    return `Lighter hedge: the ${direction} account (${index ?? '?'}) holds a ${held} ${symbol} position (${amount}), ` +
      `the wrong direction for this account (manual trade?). New ${direction} entries are refused until it is closed.`;
  }

  // Update one account's wrong-direction flags from a read of its positions. scope: the one symbol a filtered read
  // covered (undefined: the read listed every position of the account). A newly flagged symbol alerts once; the
  // alert re-arms after the flag clears.
  private noteSigns(side: LighterHedgeSide, rows: ReadonlyArray<SignRow>, scope?: string): void {
    const flags = this.wrongSign[side];
    const found = new Map<string, string>();
    for (const row of rows) {
      if (scope !== undefined && row.symbol !== scope) continue;
      if (isWrongSign(side, row.positionAmt)) found.set(row.symbol, row.positionAmt);
    }
    for (const symbol of [...flags.keys()]) {
      if ((scope === undefined || symbol === scope) && !found.has(symbol)) flags.delete(symbol);
    }
    for (const [symbol, amount] of found) {
      const known = flags.has(symbol);
      flags.set(symbol, amount);
      if (!known) this.alert({ kind: 'wrong-sign', side, symbol, message: this.wrongSignMessage(side, symbol, amount) });
    }
  }

  // G4: a fresh read of the target account before every entry; any wrong-direction position refuses it (nothing sent)
  private async assertEntryAllowed(side: LighterHedgeSide, symbol: string): Promise<void> {
    const positions = await this.account(side).getPositions(undefined, { bypassRateLimit: true });
    this.noteSigns(side, positions);
    const flags = this.wrongSign[side];
    if (flags.size === 0) return;
    const [flagged, amount] = flags.has(symbol) ? [symbol, flags.get(symbol) as string] : [...flags][0];
    throw new LighterHedgeEntryRefusal(this.wrongSignMessage(side, flagged, amount));
  }

  // ----- Startup checks -----

  async verifyStartup(): Promise<LighterHedgeStartupReport> {
    const longIndex = this.long.configuredAccountIndex();
    const shortIndex = this.short.configuredAccountIndex();
    if (longIndex !== null && longIndex === shortIndex) {
      throw new Error(`Lighter hedge mode: the short account index ${shortIndex} must differ from the main (long) account index`);
    }

    const checks = await Promise.allSettled([this.long.verifyStartup(), this.short.verifyStartup()]);
    const failures: Partial<Record<LighterHedgeSide, unknown>> = {};
    const problems: string[] = [];
    checks.forEach((result, i) => {
      if (result.status === 'fulfilled') return;
      const side = SIDES[i];
      const adapter = this.account(side);
      const key = adapter.configuredApiKeyIndex();
      failures[side] = result.reason;
      problems.push(`${this.label(side)}${key !== null ? ` key ${key}` : ''}: ${errorText(result.reason).replace(/^Lighter:\s*/, '')}`);
    });
    if (problems.length > 0) {
      throw new LighterHedgeError(`Lighter hedge mode startup checks failed: ${problems.join('; ')}`, failures);
    }
    const [longReport, shortReport] = checks.map(result => (result as PromiseFulfilledResult<LighterStartupReport>).value);

    // Same master: sub-accounts of one master share the L1 address. Informational, never blocking.
    let sameMaster: boolean | null = null;
    const identities = await Promise.allSettled([this.long.getAccountIdentity(), this.short.getAccountIdentity()]);
    const [longId, shortId] = identities.map(result => (result.status === 'fulfilled' ? result.value.l1Address : null));
    if (longId && shortId) {
      sameMaster = longId.toLowerCase() === shortId.toLowerCase();
      if (!sameMaster) {
        const message = `the long account ${longReport.accountIndex} and the short account ${shortReport.accountIndex} belong to different L1 addresses ` +
          '(not sub-accounts of one master). Hedge mode still works, but funds cannot move between them as sub-account transfers.';
        logWarnWithTimestamp(`Lighter hedge: ${message}`);
        this.alert({ kind: 'different-master', message });
      }
    } else {
      logWithTimestamp('Lighter hedge: could not read both accounts\' L1 addresses; skipping the same-master check');
    }

    // Wrong-direction positions (flags and alerts). The read before every entry is what enforces it, so a failed
    // read here is only logged.
    const scans = await Promise.allSettled(SIDES.map(side => this.account(side).getPositions(undefined, { bypassRateLimit: true })));
    scans.forEach((result, i) => {
      if (result.status === 'fulfilled') this.noteSigns(SIDES[i], result.value);
      else logWarnWithTimestamp(`Lighter hedge: could not scan the ${accountName(SIDES[i])} for wrong-direction positions: ${errorText(result.reason)}`);
    });
    const wrongSign = SIDES.flatMap(side => [...this.wrongSign[side]].map(([symbol, positionAmt]) => ({ side, symbol, positionAmt })));

    logWithTimestamp(
      `Lighter hedge mode: startup checks passed for the long account ${longReport.accountIndex} (key ${longReport.apiKeyIndex}) ` +
      `and the short account ${shortReport.accountIndex} (key ${shortReport.apiKeyIndex})`
    );
    return { profile: this.profile.name, long: longReport, short: shortReport, sameMaster, wrongSign };
  }

  // ----- Stream URLs and market data (the long account's adapter; both share one market cache) -----

  getMarkPriceStreamUrl(): string {
    return this.long.getMarkPriceStreamUrl();
  }

  getKlineStreamUrl(subscriptions: { symbol: string; interval: string }[]): string {
    return this.long.getKlineStreamUrl(subscriptions);
  }

  getExchangeInfo(options?: RequestOptions): Promise<any> {
    return this.long.getExchangeInfo(options);
  }

  getMarkPrice(symbol?: string): Promise<MarkPrice | MarkPrice[]> {
    return this.long.getMarkPrice(symbol);
  }

  getTickerPrice(symbol: string, options?: RequestOptions): Promise<TickerPrice> {
    return this.long.getTickerPrice(symbol, options);
  }

  getAllTickerPrices(options?: RequestOptions): Promise<TickerPrice[]> {
    return this.long.getAllTickerPrices(options);
  }

  getKlines(symbol: string, interval?: string, limit?: number): Promise<Kline[]> {
    return this.long.getKlines(symbol, interval, limit);
  }

  getOrderBook(symbol: string, limit?: number): Promise<any> {
    return this.long.getOrderBook(symbol, limit);
  }

  getBookTicker(symbol: string): Promise<any> {
    return this.long.getBookTicker(symbol);
  }

  // ----- Account (merged; never partial) -----

  // Both accounts in the Binance hedge shape: long rows positionSide LONG, short rows SHORT, amounts as the account
  // holds them (zero rows kept). Rejects when either account cannot be read. The open merged user streams take the
  // result over before the caller sees it: an account whose stream is behind (reconnecting, a lost or late update)
  // would otherwise list an older position set in the next merged ACCOUNT_UPDATE than the caller just read, and
  // PositionManager would cancel the SL/TP of a live position on that account.
  async getPositions(symbol?: string, options?: RequestOptions): Promise<VenuePosition[]> {
    const streams = [...this.userStreams];
    const marks = streams.map(stream => stream.positionMarks());
    const [longRows, shortRows] = await Promise.all([this.long.getPositions(symbol, options), this.short.getPositions(symbol, options)]);
    this.noteSigns('LONG', longRows, symbol);
    this.noteSigns('SHORT', shortRows, symbol);
    streams.forEach((stream, i) => stream.applyRestPositions(marks[i], { LONG: longRows, SHORT: shortRows }, symbol));
    return [
      ...longRows.map(row => ({ ...row, positionSide: 'LONG' })),
      ...shortRows.map(row => ({ ...row, positionSide: 'SHORT' })),
    ];
  }

  async getOpenOrders(symbol?: string, options?: RequestOptions): Promise<VenueOrder[]> {
    const [longOrders, shortOrders] = await Promise.all([this.long.getOpenOrders(symbol, options), this.short.getOpenOrders(symbol, options)]);
    return [
      ...longOrders.map(order => ({ ...order, positionSide: 'LONG' })),
      ...shortOrders.map(order => ({ ...order, positionSide: 'SHORT' })),
    ];
  }

  // One USDC entry with the exact sums of both accounts; the per-account entries under lighterHedge
  async getBalance(): Promise<any> {
    const [longBalances, shortBalances] = await Promise.all([this.long.getBalance(), this.short.getBalance()]);
    const longEntry = longBalances[0] ?? {};
    const shortEntry = shortBalances[0] ?? {};
    const sum = (field: string) => sumLighterDecimals([longEntry[field], shortEntry[field]]);
    return [{
      accountAlias: `lighter-${this.profile.name}-hedge`,
      asset: LIGHTER_CAPABILITIES.marginAsset,
      balance: sum('balance'),
      crossWalletBalance: sum('crossWalletBalance'),
      crossUnPnl: sum('crossUnPnl'),
      availableBalance: sum('availableBalance'),
      maxWithdrawAmount: sum('maxWithdrawAmount'),
      marginAvailable: true,
      updateTime: this.now(),
      lighterHedge: { LONG: longEntry, SHORT: shortEntry },
    }];
  }

  async getAccountInfo(): Promise<any> {
    const [longInfo, shortInfo] = await Promise.all([this.long.getAccountInfo(), this.short.getAccountInfo()]);
    const now = this.now();
    const sums: Record<string, string> = {};
    const totalFields = new Set<string>(['availableBalance', 'maxWithdrawAmount']);
    for (const info of [longInfo, shortInfo]) {
      for (const [key, value] of Object.entries(info ?? {})) {
        if (key.startsWith('total') && typeof value === 'string') totalFields.add(key);
      }
    }
    for (const field of totalFields) sums[field] = sumLighterDecimals([longInfo?.[field], shortInfo?.[field]]);

    const longAsset = (Array.isArray(longInfo?.assets) ? longInfo.assets[0] : null) ?? {};
    const shortAsset = (Array.isArray(shortInfo?.assets) ? shortInfo.assets[0] : null) ?? {};
    const asset: Record<string, unknown> = { asset: LIGHTER_CAPABILITIES.marginAsset };
    for (const key of new Set([...Object.keys(longAsset), ...Object.keys(shortAsset)])) {
      if (key === 'asset') continue;
      const values = [longAsset[key], shortAsset[key]];
      if (values.some(value => typeof value === 'string')) asset[key] = sumLighterDecimals(values.map(v => (typeof v === 'string' ? v : undefined)));
    }
    asset.marginAvailable = true;
    asset.updateTime = now;

    const longPositions: any[] = Array.isArray(longInfo?.positions) ? longInfo.positions : [];
    const shortPositions: any[] = Array.isArray(shortInfo?.positions) ? shortInfo.positions : [];
    this.noteSigns('LONG', longPositions);
    this.noteSigns('SHORT', shortPositions);
    const summary = (side: LighterHedgeSide, info: any) => ({
      accountIndex: info?.lighter?.accountIndex ?? this.account(side).configuredAccountIndex(),
      totalWalletBalance: info?.totalWalletBalance ?? '0',
      availableBalance: info?.availableBalance ?? '0',
      totalUnrealizedProfit: info?.totalUnrealizedProfit ?? '0',
      totalMarginBalance: info?.totalMarginBalance ?? '0',
    });

    return {
      feeTier: longInfo?.feeTier ?? 0,
      canTrade: longInfo?.canTrade !== false && shortInfo?.canTrade !== false,
      canDeposit: longInfo?.canDeposit !== false && shortInfo?.canDeposit !== false,
      canWithdraw: longInfo?.canWithdraw !== false && shortInfo?.canWithdraw !== false,
      updateTime: now,
      multiAssetsMargin: false,
      ...sums,
      assets: [asset],
      positions: [
        ...longPositions.map(position => ({ ...position, positionSide: 'LONG' })),
        ...shortPositions.map(position => ({ ...position, positionSide: 'SHORT' })),
      ],
      lighter: { profile: this.profile.name, hedge: true, accounts: { LONG: longInfo?.lighter, SHORT: shortInfo?.lighter } },
      lighterHedge: { LONG: summary('LONG', longInfo), SHORT: summary('SHORT', shortInfo) },
    };
  }

  // The margin an entry on this side would use: only that account (Hunter's pre-trade available-margin check)
  async getEntryMargin(positionSide: 'LONG' | 'SHORT'): Promise<EntryMargin> {
    const side = hedgeSideOf(positionSide);
    if (!side) throw new LighterOrderError(LIGHTER_HEDGE_POSITION_SIDE_MESSAGE, BINANCE_POSITION_MODE_CODE);
    const [entry] = await this.account(side).getBalance();
    return { totalWalletBalance: String(entry?.balance ?? '0'), availableBalance: String(entry?.availableBalance ?? '0') };
  }

  async getHedgeMode(): Promise<boolean> {
    return true;
  }

  async setHedgeMode(enabled: boolean): Promise<void> {
    if (!enabled) throw new Error(LIGHTER_HEDGE_ONE_WAY_MESSAGE);
  }

  // With the entry's positionSide (Hunter, before every entry): only the account that entry goes to, so a failure on
  // the other account never blocks it; each account's leverage is set before each of its own entries. Its error
  // passes through unchanged. Without one: both accounts in parallel, rejecting with the account(s) that failed.
  async setLeverage(symbol: string, leverage: number, positionSide?: 'LONG' | 'SHORT'): Promise<any> {
    const side = hedgeSideOf(positionSide);
    if (side) return this.account(side).setLeverage(symbol, leverage);
    const results = await Promise.allSettled([this.long.setLeverage(symbol, leverage), this.short.setLeverage(symbol, leverage)]);
    const [longResult, shortResult] = this.settledPair(results, `leverage change on ${symbol}`);
    return { symbol, leverage: longResult?.leverage ?? shortResult?.leverage ?? leverage, accounts: { LONG: longResult, SHORT: shortResult } };
  }

  // Values of a pair of settled inner calls; throws a LighterHedgeError naming the failed account(s) otherwise
  private settledPair(results: PromiseSettledResult<any>[], what: string): [any, any] {
    const failures: Partial<Record<LighterHedgeSide, unknown>> = {};
    const parts: string[] = [];
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        failures[SIDES[i]] = result.reason;
        parts.push(`the ${accountName(SIDES[i])}: ${errorText(result.reason)}`);
      }
    });
    if (parts.length > 0) throw new LighterHedgeError(`Lighter hedge: ${what} failed for ${parts.join('; and for ')}`, failures);
    return [(results[0] as PromiseFulfilledResult<any>).value, (results[1] as PromiseFulfilledResult<any>).value];
  }

  // ----- User data (merged stream) -----

  async subscribeUserData(handlers: UserDataHandlers): Promise<UserDataSubscription> {
    if (typeof handlers?.onEvent !== 'function') throw new Error('handlers.onEvent is required');
    const stream: LighterHedgeUserStream = new LighterHedgeUserStream({
      accounts: { LONG: this.long, SHORT: this.short },
      noteSigns: (side, rows) => this.noteSigns(side, rows),
      alert: alert => this.alert(alert),
      label: side => this.label(side),
      seedRetryMs: this.seedRetryMs,
      onClosed: () => this.userStreams.delete(stream),
    }, handlers);
    this.userStreams.add(stream);
    await stream.open();
    return stream;
  }

  createAccountStream(): AccountStream {
    return new LighterAccountStream(this);
  }

  // ----- Orders -----

  async placeOrder(request: OrderRequest): Promise<Order> {
    const req = request as OrderRequest & { closePosition?: unknown };
    const side = hedgeSideOf(req.positionSide);
    if (!side) throw new LighterOrderError(LIGHTER_HEDGE_POSITION_SIDE_MESSAGE, BINANCE_POSITION_MODE_CODE);
    if (req.side !== 'BUY' && req.side !== 'SELL') throw new LighterOrderError(`Lighter: invalid side ${String(req.side)}`);
    const account = this.account(side);
    // G2: everything but an opening order is reduce-only, so it can never grow or flip the account's position
    if (isReducing(req, side)) {
      return account.placeOrder({ ...req, positionSide: 'BOTH', reduceOnly: true } as OrderRequest);
    }
    // G1 + G4: only BUY opens on the long account and only SELL on the short account, after a fresh sign check
    await this.assertEntryAllowed(side, req.symbol);
    return account.placeOrder({ ...req, positionSide: 'BOTH' } as OrderRequest);
  }

  async placeProtectiveOrders(request: ProtectiveOrdersRequest): Promise<{ stopLoss?: Order; takeProfit?: Order; errors: string[]; mayExist?: boolean }> {
    const side = hedgeSideOf(request.positionSide);
    if (!side) {
      logErrorWithTimestamp(`Lighter hedge: SL/TP for ${request.symbol} not placed: ${LIGHTER_HEDGE_POSITION_SIDE_MESSAGE}`);
      return { errors: [`SL: ${LIGHTER_HEDGE_POSITION_SIDE_MESSAGE}`, `TP: ${LIGHTER_HEDGE_POSITION_SIDE_MESSAGE}`] };
    }
    return this.account(side).placeProtectiveOrders({ ...request, positionSide: 'BOTH', reduceOnly: true });
  }

  // A bot order's client order index names its account (by range); an exchange order_index does not, so the long
  // account is asked first. Only "unknown order" (-2011) moves on to the other account: the inner cancel looks the
  // order up on its own account first and signs nothing for an order it does not have.
  async cancelOrder(symbol: string, orderId: OrderId): Promise<any> {
    const id = normalizeOrderId(orderId);
    const isClientIndex = typeof id === 'number' && Number.isSafeInteger(id) && id >= 1 && id <= LIGHTER_MAX_CLIENT_ORDER_INDEX;
    const primarySide = (isClientIndex ? lighterHedgeSideOfClientOrderIndex(id as number) : null) ?? 'LONG';
    try {
      return await this.account(primarySide).cancelOrder(symbol, id);
    } catch (error) {
      if (!isUnknownOrderError(error)) throw error;
      try {
        return await this.account(otherSide(primarySide)).cancelOrder(symbol, id);
      } catch (fallbackError) {
        throw isUnknownOrderError(fallbackError) ? error : fallbackError;
      }
    }
  }

  // positionSide LONG / SHORT: that account only. Omitted: both accounts (both are attempted; rejects naming the
  // account(s) that failed).
  async cancelAllOrders(symbol: string, positionSide?: string): Promise<any> {
    const side = hedgeSideOf(positionSide);
    if (side) return this.account(side).cancelAllOrders(symbol);
    const results = await Promise.allSettled([this.long.cancelAllOrders(symbol), this.short.cancelAllOrders(symbol)]);
    const [longResult, shortResult] = this.settledPair(results, `cancel-all on ${symbol}`);
    return { code: 200, msg: 'The operation of cancel all open order is done.', symbol, accounts: { LONG: longResult, SHORT: shortResult } };
  }
}

export function isLighterHedgeAdapter(value: unknown): value is LighterHedgeAdapter {
  return value instanceof LighterHedgeAdapter;
}

// ===== Merged user data stream =====

interface AccountStreamState {
  positions: UserDataPosition[];               // Open positions only, ps = the account's side
  streamOpen: Set<string>;                     // Symbols the account's own stream last reported open
  reports: number;                             // Counts the account's position reports (stream baseline and updates, REST seed)
  replacedAt: number;                          // `reports` at the last full replacement (baseline or REST seed)
  reportedAt: Map<string, number>;             // `reports` at which the account's stream last named a symbol (open or zero)
  balance: UserDataBalance | null;
  known: boolean;                              // Full position set known (baseline, an ACCOUNT_UPDATE or the REST seed)
  connected: boolean;
  subscription: UserDataSubscription | null;
  seedTimer: ReturnType<typeof setTimeout> | null;
}

interface HedgeUserStreamDeps {
  accounts: Record<LighterHedgeSide, LighterAdapter>;
  noteSigns: (side: LighterHedgeSide, rows: ReadonlyArray<SignRow>) => void;
  alert: (alert: LighterHedgeAlert) => void;
  label: (side: LighterHedgeSide) => string;
  seedRetryMs: ReadonlyArray<number>;
  onClosed?: () => void;
}

function newAccountState(): AccountStreamState {
  return {
    positions: [], streamOpen: new Set(), reports: 0, replacedAt: 0, reportedAt: new Map(),
    balance: null, known: false, connected: false, subscription: null, seedTimer: null,
  };
}

function zeroKey(side: LighterHedgeSide, symbol: string): string {
  return `${side}:${symbol}`;
}

function marginBalanceOf(balances: UserDataBalance[] | undefined): UserDataBalance | null {
  if (!Array.isArray(balances)) return null;
  return balances.find(balance => balance.a === LIGHTER_CAPABILITIES.marginAsset) ?? null;
}

function toUserDataPosition(position: VenuePosition, side: LighterHedgeSide): UserDataPosition {
  const result: UserDataPosition = {
    s: position.symbol,
    pa: position.positionAmt,
    ep: position.entryPrice,
    up: position.unRealizedProfit,
    mt: position.marginType,
    iw: position.isolatedMargin,
    ps: side,
  };
  if (position.markPrice && Number(position.markPrice) > 0) result.mp = position.markPrice;
  if (position.liquidationPrice && Number(position.liquidationPrice) > 0) result.lp = position.liquidationPrice;
  return result;
}

// Both accounts' user streams as one. ORDER_TRADE_UPDATE is forwarded at once with o.ps set to the account's side.
// ACCOUNT_UPDATE is merged: PositionManager treats a symbol listed in P as authoritative for every position of that
// symbol it tracks, so P always carries both accounts' full open position sets, and nothing is emitted until both
// are known (from the stream's baseline, any ACCOUNT_UPDATE of that account, or a REST read).
class LighterHedgeUserStream implements UserDataSubscription {
  private readonly state: Record<LighterHedgeSide, AccountStreamState> = { LONG: newAccountState(), SHORT: newAccountState() };
  private closed = false;
  private closing: Promise<void> | null = null;
  private reportedConnected = false;
  // An ACCOUNT_UPDATE held until both accounts are known: its header, the zero rows and balance changes since the
  // last emitted event
  private pending: { E: number; T?: number; m?: string } | null = null;
  private readonly pendingZeros = new Map<string, UserDataPosition>();
  private pendingBc: string[] = [];
  private reconnectSync: Promise<void> | null = null;

  constructor(private readonly deps: HedgeUserStreamDeps, private readonly handlers: UserDataHandlers) {}

  async open(): Promise<void> {
    const results = await Promise.allSettled(SIDES.map(side => this.deps.accounts[side].subscribeUserData(this.handlersFor(side))));
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') this.state[SIDES[i]].subscription = result.value;
    });
    const failed = results.findIndex(result => result.status === 'rejected');
    if (failed >= 0) {
      logErrorWithTimestamp(`Lighter hedge: could not open the ${this.deps.label(SIDES[failed])} user stream; closing the other one`);
      await this.close();
      throw (results[failed] as PromiseRejectedResult).reason;
    }
    for (const side of SIDES) {
      if (!this.state[side].known) void this.seed(side, 0);
    }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const subscriptions: UserDataSubscription[] = [];
    for (const side of SIDES) {
      const state = this.state[side];
      if (state.seedTimer) clearTimeout(state.seedTimer);
      state.seedTimer = null;
      if (state.subscription) subscriptions.push(state.subscription);
      state.subscription = null;
    }
    this.deps.onClosed?.();
    this.closing = Promise.allSettled(subscriptions.map(subscription => subscription.close())).then(results => {
      for (const result of results) {
        if (result.status === 'rejected') logErrorWithTimestamp('Lighter hedge: closing an account stream failed:', errorText(result.reason));
      }
    });
    return this.closing;
  }

  private handlersFor(side: LighterHedgeSide): UserDataHandlers {
    const handlers: UserDataHandlers = {
      onEvent: event => this.onEvent(side, event),
      onBaseline: snapshot => this.onBaseline(side, snapshot),
      onConnected: () => this.onConnected(side),
      onDisconnected: error => this.onDisconnected(side, error),
      onError: error => this.onError(side, error),
    };
    if (this.handlers.beforeReconnect) handlers.beforeReconnect = () => this.beforeReconnect();
    return handlers;
  }

  // ----- Account state -----

  private bothKnown(): boolean {
    return this.state.LONG.known && this.state.SHORT.known;
  }

  private markKnown(side: LighterHedgeSide): void {
    const state = this.state[side];
    state.known = true;
    if (state.seedTimer) clearTimeout(state.seedTimer);
    state.seedTimer = null;
  }

  // The account's full open position set, from its stream's baseline (fromStream) or a REST seed. A held zero row of
  // a position that is open again is dropped.
  private replacePositions(side: LighterHedgeSide, rows: UserDataPosition[], fromStream: boolean): void {
    const state = this.state[side];
    const open = rows.filter(row => !isZeroAmount(row.pa)).map(row => ({ ...row, ps: side }));
    state.reports++;
    state.replacedAt = state.reports;
    if (fromStream) {
      state.streamOpen = new Set(open.map(row => row.s));
      for (const row of rows) state.reportedAt.set(row.s, state.reports);
    }
    state.positions = open;
    this.positionsChanged(side, open);
  }

  // An ACCOUNT_UPDATE of the account's stream: its full open set plus zero rows for the positions it reported open
  // before. A position read over REST that this stream has never reported stays: the stream is behind (an update it
  // missed or has not delivered yet); once it sees the position it reports it, and its close as a zero row.
  private updatePositions(side: LighterHedgeSide, rows: UserDataPosition[]): void {
    const state = this.state[side];
    const named = new Set(rows.map(row => row.s));
    const open = rows.filter(row => !isZeroAmount(row.pa)).map(row => ({ ...row, ps: side }));
    const unseen = state.positions.filter(row => !named.has(row.s) && !state.streamOpen.has(row.s));
    state.reports++;
    for (const symbol of named) state.reportedAt.set(symbol, state.reports);
    state.streamOpen = new Set(open.map(row => row.s));
    state.positions = [...open, ...unseen];
    this.positionsChanged(side, open);
  }

  private positionsChanged(side: LighterHedgeSide, opened: UserDataPosition[]): void {
    for (const row of opened) this.pendingZeros.delete(zeroKey(side, row.s));
    this.markKnown(side);
    this.deps.noteSigns(side, this.state[side].positions.map(row => ({ symbol: row.s, positionAmt: row.pa })));
  }

  // Where each account's position reports stand, taken before a merged REST read is sent
  positionMarks(): Record<LighterHedgeSide, number> {
    return { LONG: this.state.LONG.reports, SHORT: this.state.SHORT.reports };
  }

  // A merged REST read of the positions (all symbols, or one): each known account's cache takes it over, except for
  // a symbol its stream named after the read was sent (that report is the newer one) and except after a full
  // replacement in the meantime. Nothing is emitted: the caller has the result itself.
  applyRestPositions(marks: Record<LighterHedgeSide, number>, rows: Record<LighterHedgeSide, VenuePosition[]>, symbol?: string): void {
    if (this.closed) return;
    for (const side of SIDES) {
      const state = this.state[side];
      const mark = marks[side];
      if (!state.known || state.replacedAt > mark) continue;
      const applies = (s: string) => (symbol === undefined || s === symbol) && (state.reportedAt.get(s) ?? 0) <= mark;
      const rest = new Map<string, UserDataPosition>();
      for (const row of rows[side]) {
        if (applies(row.symbol) && !isZeroAmount(row.positionAmt)) rest.set(row.symbol, toUserDataPosition(row, side));
      }
      const next: UserDataPosition[] = [];
      for (const row of state.positions) {
        if (!applies(row.s)) next.push(row);
        else if (rest.has(row.s)) next.push(rest.get(row.s) as UserDataPosition);
        // else: REST shows it closed
      }
      for (const [s, row] of rest) {
        if (!state.positions.some(position => position.s === s)) next.push(row);
        this.pendingZeros.delete(zeroKey(side, s));
      }
      state.positions = next;
    }
  }

  // (a) The account stream's starting state: overwrites, never replayed as an event
  private onBaseline(side: LighterHedgeSide, snapshot: AccountUpdateEvent): void {
    if (this.closed) return;
    this.replacePositions(side, snapshot.a?.P ?? [], true);
    const balance = marginBalanceOf(snapshot.a?.B);
    if (balance) this.state[side].balance = { ...balance, bc: '0' };
    if (this.pending) this.flush();
  }

  // (c) REST, for an account whose stream has reported nothing yet. Discarded when (a) or (b) arrives meanwhile.
  private async seed(side: LighterHedgeSide, attempt: number): Promise<void> {
    const state = this.state[side];
    state.seedTimer = null;
    if (this.closed || state.known) return;
    const account = this.deps.accounts[side];
    try {
      const [positions, balances] = await Promise.all([account.getPositions(undefined, { bypassRateLimit: true }), account.getBalance()]);
      if (this.closed || state.known) return;
      const entry = Array.isArray(balances) ? balances[0] : null;
      if (entry && typeof entry.balance === 'string') {
        state.balance = { a: LIGHTER_CAPABILITIES.marginAsset, wb: entry.balance, cw: entry.crossWalletBalance ?? entry.balance, bc: '0' };
      }
      this.replacePositions(side, positions.map(position => toUserDataPosition(position, side)), false);
      logWithTimestamp(`Lighter hedge: ${this.deps.label(side)} positions read over REST for the merged user stream`);
      if (this.pending) this.flush();
    } catch (error) {
      if (this.closed || state.known) return;
      if (attempt === 0) {
        this.deps.alert({
          kind: 'seed-failed',
          side,
          message: `could not read the ${this.deps.label(side)} positions for the merged user stream (${errorText(error)}); ` +
            'position updates are held until both accounts are known. Retrying.',
        });
      }
      const delays = this.deps.seedRetryMs.length > 0 ? this.deps.seedRetryMs : LIGHTER_HEDGE_SEED_RETRY_MS;
      state.seedTimer = setTimeout(() => void this.seed(side, attempt + 1), delays[Math.min(attempt, delays.length - 1)]);
    }
  }

  // ----- Events -----

  private onEvent(side: LighterHedgeSide, event: UserDataEvent): void {
    if (this.closed) return;
    if (event.e === 'ACCOUNT_UPDATE') {
      this.onAccountUpdate(side, event);
    } else if (event.e === 'ORDER_TRADE_UPDATE') {
      this.emit({ ...event, o: { ...event.o, ps: side } });
    } else {
      this.emit(event);
    }
  }

  // (b) Each ACCOUNT_UPDATE carries the account's full open position set (plus zero rows for closed ones)
  private onAccountUpdate(side: LighterHedgeSide, event: AccountUpdateEvent): void {
    const rows = event.a?.P;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (isZeroAmount(row.pa)) this.pendingZeros.set(zeroKey(side, row.s), { ...row, ps: side });
      }
      this.updatePositions(side, rows);
    }
    const balance = marginBalanceOf(event.a?.B);
    if (balance) {
      this.state[side].balance = balance;
      this.pendingBc.push(balance.bc ?? '0');
    }
    this.pending = { E: event.E, T: event.T, m: event.a?.m };
    if (this.bothKnown()) this.flush();
  }

  private flush(): void {
    const header = this.pending;
    if (!header || this.closed || !this.bothKnown()) return;
    this.pending = null;
    const long = this.state.LONG;
    const short = this.state.SHORT;
    const positions = [...long.positions, ...short.positions, ...this.pendingZeros.values()];
    this.pendingZeros.clear();
    let balances: UserDataBalance[] = [];
    if (long.balance && short.balance) {
      balances = [{
        a: LIGHTER_CAPABILITIES.marginAsset,
        wb: sumLighterDecimals([long.balance.wb, short.balance.wb]),
        cw: sumLighterDecimals([long.balance.cw ?? long.balance.wb, short.balance.cw ?? short.balance.wb]),
        bc: sumLighterDecimals(this.pendingBc),
      }];
      this.pendingBc = [];
    }
    const event: AccountUpdateEvent = {
      e: 'ACCOUNT_UPDATE',
      E: header.E,
      ...(header.T !== undefined ? { T: header.T } : {}),
      a: { ...(header.m !== undefined ? { m: header.m } : {}), B: balances, P: positions },
    };
    this.emit(event);
  }

  private emit(event: UserDataEvent): void {
    if (this.closed) return;
    try {
      this.handlers.onEvent(event);
    } catch (error) {
      logErrorWithTimestamp('Lighter hedge: user data handler failed:', errorText(error));
    }
  }

  // ----- Connection -----

  private onConnected(side: LighterHedgeSide): void {
    if (this.closed) return;
    this.state[side].connected = true;
    if (this.reportedConnected || !SIDES.every(s => this.state[s].connected)) return;
    this.reportedConnected = true;
    this.safely(() => this.handlers.onConnected?.());
  }

  private onDisconnected(side: LighterHedgeSide, error?: Error): void {
    if (this.closed) return;
    this.state[side].connected = false;
    if (!this.reportedConnected) return;
    this.reportedConnected = false;
    this.safely(() => this.handlers.onDisconnected?.(error));
  }

  private onError(side: LighterHedgeSide, error: Error): void {
    if (this.closed) return;
    const named = new Error(`Lighter ${accountName(side)} stream: ${errorText(error)}`);
    this.safely(() => this.handlers.onError?.(named));
  }

  // Both streams may drop together: one re-sync serves both
  private beforeReconnect(): Promise<void> {
    const run = this.handlers.beforeReconnect;
    if (this.closed || !run) return Promise.resolve();
    if (this.reconnectSync) return this.reconnectSync;
    const sync = (async () => {
      await run.call(this.handlers);
    })().finally(() => {
      if (this.reconnectSync === sync) this.reconnectSync = null;
    });
    this.reconnectSync = sync;
    return sync;
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      logErrorWithTimestamp('Lighter hedge: user data handler error:', errorText(error));
    }
  }
}
