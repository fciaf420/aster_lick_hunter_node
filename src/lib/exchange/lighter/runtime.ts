import type { Config, LiquidationEvent } from '../../types';
import type { LiquidationSource, LiquidationSourceHooks } from '../../liquidation/types';
import type { VenueId } from '../types';
import { logErrorWithTimestamp, logWarnWithTimestamp, logWithTimestamp } from '../../utils/timestamp';
import {
  LighterLiquidationSource,
  type LighterLiquidationAlert,
  type LighterLiquidationMarket,
  type LighterLiquidationSourceOptions,
} from '../../liquidation/lighterLiquidationSource';
import {
  LIGHTER_OPEN_INTEREST_MAX_AGE_MS,
  LighterAdapter,
  type LighterCredentialsInput,
  type LighterMarketStatsSnapshot,
} from './LighterAdapter';
import type { LighterAccountStreamAlert } from './accountStream';
import { LighterHedgeAdapter, isLighterHedgeAdapter, type LighterHedgeAlert } from './LighterHedgeAdapter';
import { LighterHttpClient, type LighterHttpTransport } from './http';
import { LighterMarketCache, isOpenInterestCapped } from './markets';
import { LIGHTER_HEDGE_COI_RANGES, type LighterHedgeSide } from './nonce';
import { lighterHedgeState } from '../../config/types';
import {
  DEFAULT_LIGHTER_PROFILE,
  getProfile,
  isLighterProfileName,
  lighterStreamUrl,
  type LighterProfile,
  type LighterProfileName,
} from './profiles';
import { MARK_RATIO_TOLERANCE, evaluateMarkRatios, type LighterSymbolMapOptions } from './symbols';
import type { LighterSocketFactory } from './ws';

// Wiring between the bot's config and the Lighter modules (adapter, market cache, liquidation feed).
//
// - One market cache per network per process, shared by the adapter, the liquidation feed and the API routes,
//   so orderBookDetails is fetched once and every part sees the same symbol mapping.
// - Only the bot process may sign (allowSigning). Adapters built for Next.js API routes are read-only: their
//   signer loader throws LighterReadOnlyError, so they can show positions and balances (public reads) but never
//   send a tx or read private endpoints.
// - When the liquidation source and the trading venue differ, the 2% mark-ratio guard (spec §3.4) keeps a symbol
//   out of trading until Lighter's mark and the other venue's mark agree. It runs at start, after a short warm-up
//   and every 5 minutes, and fails closed.

type ConfigView = Pick<Config, 'symbols'> & Partial<Pick<Config, 'venues' | 'global'>>;
type ConfigGetter = () => ConfigView;

export const LIGHTER_DEFAULT_SLTP_SLIPPAGE_PCT = 1;
export const LIGHTER_DEFAULT_SEND_TX_PER_MIN = 60;
export const LIGHTER_MARK_GUARD_INTERVAL_MS = 5 * 60 * 1000;
export const LIGHTER_MARK_GUARD_WARMUP_MS = 15_000;          // Second run once the WS market_stats marks arrive
export const LIGHTER_MARK_GUARD_FRESH_STATS_MS = 10_000;     // WS mark younger than this beats a REST fetch
export const LIGHTER_SYSTEM_CONFIG_REFRESH_MS = 5 * 60 * 1000;
// Retries while systemConfig (the liquidity pool account) has never loaded; the last delay repeats
export const LIGHTER_SYSTEM_CONFIG_RETRY_MS: ReadonlyArray<number> = [2_000, 5_000, 10_000, 30_000, 60_000];

// ===== Settings =====

export interface LighterSettings {
  profile: LighterProfileName;
  liquidationsLive: boolean;
  sltpSlippagePct: number;
  sendTxPerMin: number;
  symbolOverrides?: LighterSymbolMapOptions['overrides'];
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

// config.venues.lighter with defaults applied (testnet, shadow mode, 1% SL/TP slippage, 60 tx/min)
export function readLighterSettings(config?: Partial<Pick<Config, 'venues'>> | null): LighterSettings {
  const lighter = config?.venues?.lighter;
  return {
    profile: isLighterProfileName(lighter?.profile) ? lighter.profile : DEFAULT_LIGHTER_PROFILE,
    liquidationsLive: lighter?.liquidationsLive === true,
    sltpSlippagePct: positiveNumber(lighter?.sltpSlippagePct, LIGHTER_DEFAULT_SLTP_SLIPPAGE_PCT),
    sendTxPerMin: Math.floor(positiveNumber(lighter?.sendTxPerMin, LIGHTER_DEFAULT_SEND_TX_PER_MIN)),
    symbolOverrides: lighter?.symbolOverrides,
  };
}

// The configured network. Unknown names fall back to testnet (the schema rejects them anyway); gated
// profiles (Robinhood) throw with the reason.
export function resolveLighterProfile(config?: Partial<Pick<Config, 'venues'>> | null): LighterProfile {
  return getProfile(readLighterSettings(config).profile);
}

// Public stream URL of the configured network (liquidation feed, private channels)
export function lighterStreamUrlFor(config?: Partial<Pick<Config, 'venues'>> | null): string {
  return lighterStreamUrl(resolveLighterProfile(config));
}

// Credentials as LighterAdapter reads them, bound to the configured profile
export function lighterCredentialsFrom(config?: Partial<Pick<Config, 'venues'>> | null): LighterCredentialsInput {
  const lighter = config?.venues?.lighter;
  if (!lighter) return null;
  return {
    profile: readLighterSettings(config).profile,
    accountIndex: lighter.accountIndex,
    apiKeyIndex: lighter.apiKeyIndex,
    apiKeyPrivateKey: lighter.apiKeyPrivateKey,
    apiKeyPublicKey: lighter.apiKeyPublicKey,
  };
}

// Hedge mode: credentials of the short account (venues.lighter.hedge.shortAccount), bound to the same profile as
// the main account (one network per process)
export function lighterShortCredentialsFrom(config?: Partial<Pick<Config, 'venues'>> | null): LighterCredentialsInput {
  const shortAccount = config?.venues?.lighter?.hedge?.shortAccount;
  if (!shortAccount) return null;
  return {
    profile: readLighterSettings(config).profile,
    accountIndex: shortAccount.accountIndex,
    apiKeyIndex: shortAccount.apiKeyIndex,
    apiKeyPrivateKey: shortAccount.apiKeyPrivateKey,
    apiKeyPublicKey: shortAccount.apiKeyPublicKey,
  };
}

// Bot symbols that may map to Lighter markets: the configured symbols plus explicit overrides
export function lighterSymbolOptions(config?: ConfigView | null): LighterSymbolMapOptions {
  return {
    allowlist: Object.keys(config?.symbols ?? {}),
    overrides: readLighterSettings(config).symbolOverrides,
  };
}

function symbolOptionsKey(options: LighterSymbolMapOptions): string {
  const allowlist = options.allowlist === 'all' ? ['*'] : [...options.allowlist].sort();
  return JSON.stringify([allowlist, options.overrides ?? null]);
}

// ===== Read-only adapters (Next.js API routes) =====

export const LIGHTER_READ_ONLY_MESSAGE =
  'Lighter signing only runs in the bot process. The dashboard can show Lighter positions and balances, ' +
  'but orders, cancels and private reads such as open orders go through the bot.';

export class LighterReadOnlyError extends Error {
  readonly code = 'LIGHTER_READ_ONLY';

  constructor(message: string = LIGHTER_READ_ONLY_MESSAGE) {
    super(message);
    this.name = 'LighterReadOnlyError';
  }
}

export function isLighterReadOnlyError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof LighterReadOnlyError) return true;
    if (typeof current === 'object' && (current as { code?: unknown }).code === 'LIGHTER_READ_ONLY') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function refuseSigner(): never {
  throw new LighterReadOnlyError();
}

// ===== Alerts =====

export type LighterRuntimeAlert =
  | { source: 'liquidations'; alert: LighterLiquidationAlert }
  | { source: 'account'; alert: LighterAccountStreamAlert }
  | { source: 'mark-guard'; symbol: string; message: string }
  // A tx the nonce manager stopped waiting for executed after all (or is still unresolved at its expiry)
  | { source: 'late-tx'; message: string }
  // Hedge mode (two sub-accounts): wrong-direction position, stream seed failure, accounts of different masters
  | { source: 'hedge'; alert: LighterHedgeAlert };

const defaultAlertSink = (event: LighterRuntimeAlert): void => {
  const message = event.source === 'mark-guard' || event.source === 'late-tx' ? event.message : event.alert.message;
  logErrorWithTimestamp(`Lighter ${event.source} alert: ${message}`);
};

let alertSink: (event: LighterRuntimeAlert) => void = defaultAlertSink;

// The bot routes alerts to its error log and the dashboard; the default only logs them
export function setLighterAlertSink(sink: ((event: LighterRuntimeAlert) => void) | null): void {
  alertSink = sink ?? defaultAlertSink;
}

function raiseAlert(event: LighterRuntimeAlert): void {
  try {
    alertSink(event);
  } catch (error) {
    logErrorWithTimestamp('Lighter: alert handler failed:', error);
  }
}

// ===== Per-network runtime (shared market data) =====

type StatsProvider = (marketId: number) => LighterMarketStatsSnapshot | null;

interface ProfileRuntime {
  profile: LighterProfile;
  http: LighterHttpClient;
  markets: LighterMarketCache;          // Configured symbols (+ overrides): trading and the liquidation feed
  catalog: LighterMarketCache | null;   // Every market that maps automatically: the dashboard's symbol picker
  getConfig: ConfigGetter | null;
  configPinned: boolean;                // getConfig is a live getter (the bot's); static configs don't replace it
  catalogGetConfig: ConfigGetter | null;
  symbolKey: string;
  statsProviders: Set<StatsProvider>;
  liquidityPoolIndex: number | null;
  systemConfigAt: number;
  systemConfigInflight: Promise<void> | null;
}

interface RuntimeOptions {
  transport?: LighterHttpTransport;
  now?: () => number;
}

const runtimes = new Map<LighterProfileName, ProfileRuntime>();
const feeds = new Set<LighterLiquidationFeed>();
const guards = new Set<LighterMarkRatioGuard>();
const signingAdapters = new Set<LighterAdapter>();
let runtimeOptions: RuntimeOptions = {};

// Tests: route Lighter REST calls through a fake transport. Applies to runtimes created afterwards.
export function configureLighterRuntime(options: RuntimeOptions): void {
  runtimeOptions = { ...options };
}

function runtimeFor(profile: LighterProfile): ProfileRuntime {
  const existing = runtimes.get(profile.name);
  if (existing) return existing;
  const http = new LighterHttpClient({ profile, transport: runtimeOptions.transport });
  const runtime: ProfileRuntime = {
    profile,
    http,
    markets: null as unknown as LighterMarketCache,
    catalog: null,
    getConfig: null,
    configPinned: false,
    catalogGetConfig: null,
    symbolKey: '',
    statsProviders: new Set(),
    liquidityPoolIndex: null,
    systemConfigAt: 0,
    systemConfigInflight: null,
  };
  runtime.markets = new LighterMarketCache({
    profile,
    symbols: () => lighterSymbolOptions(runtime.getConfig?.()),
    httpGet: url => http.get(url),
    now: runtimeOptions.now,
  });
  runtimes.set(profile.name, runtime);
  return runtime;
}

// Point the shared cache at a config. A live getter (the bot passes one that follows config reloads) pins the
// binding; a static config (one API request) only applies while nothing is pinned, so a stray snapshot can
// never freeze the bot's symbol mapping. The map is rebuilt right away when the configured symbols changed
// (otherwise it follows the 5-minute refresh).
function bindConfig(runtime: ProfileRuntime, getConfig: ConfigGetter, live: boolean): void {
  if (live) {
    runtime.getConfig = getConfig;
    runtime.configPinned = true;
  } else if (!runtime.configPinned) {
    runtime.getConfig = getConfig;
  }
  refreshSymbolMap(runtime);
}

function refreshSymbolMap(runtime: ProfileRuntime): void {
  let key: string;
  try {
    key = symbolOptionsKey(lighterSymbolOptions(runtime.getConfig?.()));
  } catch (error) {
    logErrorWithTimestamp('Lighter: reading the configured symbols failed:', error);
    return;
  }
  if (key === runtime.symbolKey) return;
  runtime.symbolKey = key;
  if (runtime.markets.isLoaded()) {
    runtime.markets.setSymbolOptions(() => lighterSymbolOptions(runtime.getConfig?.()));
  }
}

// Shared market cache for the configured symbols on this network. Pass live=true with a getter that follows
// config reloads (the bot), false for a one-off config (an API request).
export function getLighterMarketCache(profile: LighterProfile, getConfig?: ConfigGetter, live = false): LighterMarketCache {
  const runtime = runtimeFor(profile);
  if (getConfig) bindConfig(runtime, getConfig, live);
  return runtime.markets;
}

// Market cache listing every Lighter market under its default bot symbol (BTC -> BTCUSDT), plus overrides.
// Read-only listings only (symbol picker): trading always goes through getLighterMarketCache.
export function getLighterCatalogMarketCache(profile: LighterProfile, getConfig?: ConfigGetter): LighterMarketCache {
  const runtime = runtimeFor(profile);
  if (getConfig) runtime.catalogGetConfig = getConfig;
  if (!runtime.catalog) {
    runtime.catalog = new LighterMarketCache({
      profile,
      symbols: () => ({ allowlist: 'all', overrides: readLighterSettings(runtime.catalogGetConfig?.()).symbolOverrides }),
      httpGet: url => runtime.http.get(url),
      now: runtimeOptions.now,
    });
  }
  return runtime.catalog;
}

// Latest WS market_stats snapshot for a market from any running Lighter liquidation feed on this network
function marketStatsFor(runtime: ProfileRuntime, marketId: number): LighterMarketStatsSnapshot | null {
  for (const provider of runtime.statsProviders) {
    const stats = provider(marketId);
    if (stats) return stats;
  }
  return null;
}

async function refreshSystemConfig(runtime: ProfileRuntime, now: () => number): Promise<void> {
  if (runtime.systemConfigInflight) return runtime.systemConfigInflight;
  if (runtime.systemConfigAt > 0 && now() - runtime.systemConfigAt < LIGHTER_SYSTEM_CONFIG_REFRESH_MS) return;
  runtime.systemConfigInflight = (async () => {
    try {
      const systemConfig = await runtime.http.getSystemConfig();
      const index = systemConfig.liquidity_pool_index;
      if (typeof index === 'number' && Number.isSafeInteger(index) && index >= 0) {
        if (runtime.liquidityPoolIndex !== index) {
          logWithTimestamp(`Lighter liquidations: excluding fills against the liquidity pool account ${index}`);
        }
        runtime.liquidityPoolIndex = index;
      } else if (runtime.systemConfigAt === 0) {
        logWarnWithTimestamp('Lighter: systemConfig names no liquidity pool account; only insurance fund fills are excluded from liquidations');
      }
      runtime.systemConfigAt = now();
    } catch (error) {
      logWarnWithTimestamp(`Lighter: could not read systemConfig (liquidity pool account); retrying later: ${errorText(error)}`);
    } finally {
      runtime.systemConfigInflight = null;
    }
  })();
  return runtime.systemConfigInflight;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ===== Adapter =====

export interface CreateLighterAdapterOptions {
  getConfig?: () => ConfigView;
  // Load the native signer when needed (bot process only). Off: read-only adapter (Next.js routes).
  allowSigning?: boolean;
  // Every Lighter market instead of the configured ones (symbol picker); implies read-only
  catalog?: boolean;
  // Hedge mode: the inner adapter of one side. LONG trades the main account, SHORT the short account; each uses
  // its own client order index range and labels its alerts. Unset: the plain one-way adapter.
  hedgeSide?: LighterHedgeSide;
}

const HEDGE_SIDE_LABELS: Readonly<Record<LighterHedgeSide, string>> = { LONG: '[long account]', SHORT: '[short account]' };

export function createLighterAdapter(config: ConfigView, options: CreateLighterAdapterOptions = {}): LighterAdapter {
  const getConfig: ConfigGetter = options.getConfig ?? (() => config);
  const settings = readLighterSettings(getConfig());
  const profile = getProfile(settings.profile);
  const runtime = runtimeFor(profile);
  const markets = options.catalog
    ? getLighterCatalogMarketCache(profile, getConfig)
    : getLighterMarketCache(profile, getConfig, options.getConfig !== undefined);
  const signing = options.allowSigning === true && !options.catalog;
  const hedgeSide = options.catalog ? undefined : options.hedgeSide;
  const label = (message: string) => (hedgeSide ? `${HEDGE_SIDE_LABELS[hedgeSide]} ${message}` : message);
  const readCredentials = hedgeSide === 'SHORT' ? lighterShortCredentialsFrom : lighterCredentialsFrom;
  const adapter = new LighterAdapter({
    profile,
    credentials: options.catalog ? null : () => readCredentials(getConfig()),
    markets,
    transport: runtimeOptions.transport,
    ...(signing ? {} : { loadSigner: refuseSigner, journal: 'memory' as const }),
    ...(hedgeSide ? { clientOrderIndexRange: LIGHTER_HEDGE_COI_RANGES[hedgeSide] } : {}),
    symbolSettings: botSymbol => getConfig().symbols?.[botSymbol],
    sltpSlippageBps: Math.round(settings.sltpSlippagePct * 100),
    sendTxPerMinute: settings.sendTxPerMin,
    marketStats: marketId => marketStatsFor(runtime, marketId),
    onUserStreamAlert: alert => raiseAlert({ source: 'account', alert: hedgeSide ? { ...alert, message: label(alert.message) } : alert }),
    onLateTxOutcome: outcome => {
      if (outcome.outcome === 'not-executed') return;
      raiseAlert({
        source: 'late-tx',
        message: label(outcome.outcome === 'executed'
          ? `A Lighter tx (nonce ${outcome.nonce}) the bot had stopped waiting for executed after all (${outcome.detail}); check the account. Positions it opened are protected on the next sync.`
          : `A Lighter tx (nonce ${outcome.nonce}) is still unresolved at its expiry (${outcome.detail}); check the account.`),
      });
    },
    now: runtimeOptions.now,
  });
  // Only the bot process signs; its adapters are closed on shutdown
  if (signing) signingAdapters.add(adapter);
  return adapter;
}

// The trading adapter for the configured Lighter setup: the plain one-way adapter, or, when hedge mode is on
// (lighterHedgeState: venue Lighter, position mode HEDGE, hedge.enabled, complete short account), the composite
// that keeps longs on the main account and shorts on the short account. Read once: switching needs a restart.
export function createLighterVenueAdapter(config: ConfigView, options: CreateLighterAdapterOptions = {}): LighterAdapter | LighterHedgeAdapter {
  if (options.catalog || options.hedgeSide) return createLighterAdapter(config, options);
  const getConfig: ConfigGetter = options.getConfig ?? (() => config);
  if (lighterHedgeState(getConfig()).mode !== 'on') return createLighterAdapter(config, options);
  return new LighterHedgeAdapter({
    long: createLighterAdapter(config, { ...options, hedgeSide: 'LONG' }),
    short: createLighterAdapter(config, { ...options, hedgeSide: 'SHORT' }),
    onAlert: alert => raiseAlert({ source: 'hedge', alert }),
  });
}

// One-way Lighter with a short account still configured (hedge mode off, or on but incomplete): the bot neither
// trades nor maintains that account. Its SL/TP orders stay on the exchange only until they expire (28 days, never
// renewed) and are not resized when a position changes. The startup warning names the positions left there (a
// read-only public read; skipped when the account cannot be read, e.g. incomplete keys). Null: no short account.
export async function lighterUnmanagedShortAccountWarning(config: ConfigView): Promise<string | null> {
  const shortIndex = config?.venues?.lighter?.hedge?.shortAccount?.accountIndex;
  if (shortIndex === undefined) return null;
  let left: string;
  const adapter = createLighterAdapter(config, { hedgeSide: 'SHORT' });   // Read-only: never signs
  try {
    const open = (await adapter.getPositions()).filter(position => Number(position.positionAmt) !== 0);
    left = open.length === 0
      ? 'It holds no open positions.'
      : `Positions left there: ${open.map(position => `${position.symbol} ${position.positionAmt}`).join(', ')}.`;
  } catch (error) {
    left = `Its positions could not be read (${errorText(error)}).`;
  } finally {
    adapter.close();
  }
  return `Lighter: short account ${shortIndex} is not managed in one-way mode. Positions there keep their exchange ` +
    `SL/TP only until those expire (28 days after they were placed; the bot neither renews nor resizes them). ${left}`;
}

// A Lighter trading adapter of either kind (startup checks, market refresh)
export function isLighterVenueAdapter(value: unknown): value is LighterAdapter | LighterHedgeAdapter {
  return value instanceof LighterAdapter || isLighterHedgeAdapter(value);
}

// ===== Mark-ratio guard (spec §3.4) =====

export type VenueMarkPrices = () => Promise<Map<string, number>>;

export interface MarkGuardStatus {
  ok: boolean;
  reason?: string;
  ratio?: number | null;
}

export interface LighterMarkRatioGuardOptions {
  markets: LighterMarkCacheView;
  http: Pick<LighterHttpClient, 'getOrderBookDetails'>;
  getConfig: ConfigGetter;
  otherVenue: string;                          // Label for logs, e.g. 'Aster'
  getOtherMarks: VenueMarkPrices;              // Bot symbol -> mark on the other venue
  getLighterStats?: (marketId: number) => LighterMarketStatsSnapshot | null;
  intervalMs?: number;
  warmupMs?: number;
  tolerance?: number;
}

type LighterMarkCacheView = Pick<LighterMarketCache, 'entries' | 'isLoaded' | 'ensureLoaded'>;

// Keeps a configured symbol out of trading while |lighterMark / otherVenueMark - 1| > 2%: a x1000 or
// wrong-instrument mapping would otherwise trade on every liquidation. Fails closed: a symbol is blocked until a
// check has passed, and a failed fetch keeps the previous results.
export class LighterMarkRatioGuard {
  private readonly options: LighterMarkRatioGuardOptions;
  private results = new Map<string, MarkGuardStatus>();
  private hasRun = false;
  private running: Promise<void> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private warmup: ReturnType<typeof setTimeout> | null = null;

  constructor(options: LighterMarkRatioGuardOptions) {
    this.options = options;
  }

  start(): void {
    if (this.interval) return;
    guards.add(this);
    void this.run();
    const warmupMs = this.options.warmupMs ?? LIGHTER_MARK_GUARD_WARMUP_MS;
    if (warmupMs > 0) {
      this.warmup = setTimeout(() => void this.run(), warmupMs);
      (this.warmup as { unref?: () => void }).unref?.();
    }
    this.interval = setInterval(() => void this.run(), this.options.intervalMs ?? LIGHTER_MARK_GUARD_INTERVAL_MS);
    (this.interval as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.warmup) clearTimeout(this.warmup);
    this.interval = null;
    this.warmup = null;
    guards.delete(this);
  }

  status(botSymbol: string): MarkGuardStatus {
    const result = this.results.get(botSymbol);
    if (result) return result;
    return {
      ok: false,
      reason: this.hasRun
        ? `${botSymbol} is not mapped to a Lighter market`
        : `the Lighter / ${this.options.otherVenue} mark-ratio check has not passed yet`,
    };
  }

  run(): Promise<void> {
    this.running ??= this.check().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async check(): Promise<void> {
    const { markets, getConfig, otherVenue } = this.options;
    try {
      await markets.ensureLoaded();
    } catch (error) {
      logWarnWithTimestamp(`Lighter mark-ratio guard: market data unavailable (${errorText(error)}); keeping the last results`);
      return;
    }
    let configured: Record<string, unknown>;
    try {
      configured = getConfig().symbols ?? {};
    } catch (error) {
      logErrorWithTimestamp('Lighter mark-ratio guard: reading the config failed:', error);
      return;
    }
    const entries = markets.entries().filter(entry => configured[entry.botSymbol] !== undefined);

    let otherMarks: Map<string, number>;
    try {
      otherMarks = await this.options.getOtherMarks();
    } catch (error) {
      logWarnWithTimestamp(`Lighter mark-ratio guard: ${otherVenue} mark prices unavailable (${errorText(error)}); keeping the last results`);
      return;
    }

    const freshStats = (marketId: number) => {
      const stats = this.options.getLighterStats?.(marketId);
      return stats && stats.markPrice && stats.ageMs >= 0 && stats.ageMs <= LIGHTER_MARK_GUARD_FRESH_STATS_MS ? stats.markPrice : null;
    };
    let restMarks: Map<number, number> | null = null;
    if (entries.some(entry => freshStats(entry.marketId) === null)) {
      try {
        restMarks = lighterMarksFromDetails(await this.options.http.getOrderBookDetails());
      } catch (error) {
        logWarnWithTimestamp(`Lighter mark-ratio guard: Lighter mark prices unavailable (${errorText(error)})`);
      }
    }

    const { passed, failed } = evaluateMarkRatios(
      entries,
      entry => freshStats(entry.marketId) ?? restMarks?.get(entry.marketId) ?? null,
      botSymbol => otherMarks.get(botSymbol) ?? null,
      this.options.tolerance ?? MARK_RATIO_TOLERANCE
    );

    const next = new Map<string, MarkGuardStatus>();
    for (const entry of passed) next.set(entry.botSymbol, { ok: true });
    for (const { entry, result } of failed) {
      next.set(entry.botSymbol, { ok: false, ratio: result.ratio, reason: `Lighter ${entry.lighterSymbol} vs ${otherVenue}: ${result.reason ?? 'mark ratio check failed'}` });
    }
    for (const [symbol, status] of next) {
      const before = this.results.get(symbol);
      // Alert once when a symbol becomes blocked; the reason carries the ratio, which changes every run
      if (!status.ok && before?.ok !== false) {
        logErrorWithTimestamp(`Lighter mark-ratio guard: ${symbol} disabled for trading - ${status.reason}`);
        raiseAlert({ source: 'mark-guard', symbol, message: `${symbol} disabled: ${status.reason}` });
      } else if (status.ok && before?.ok === false) {
        logWithTimestamp(`Lighter mark-ratio guard: ${symbol} passed again; trading re-enabled`);
      }
    }
    this.results = next;
    if (!this.hasRun) {
      logWithTimestamp(`Lighter mark-ratio guard (vs ${otherVenue}): ${passed.length} symbol(s) passed, ${failed.length} blocked`);
    }
    this.hasRun = true;
  }
}

function lighterMarksFromDetails(body: Record<string, unknown>): Map<number, number> {
  const marks = new Map<number, number>();
  const list = Array.isArray(body.order_book_details) ? (body.order_book_details as Array<Record<string, unknown>>) : [];
  for (const item of list) {
    const mark = Number(item.mark_price);
    if (typeof item.market_id === 'number' && Number.isFinite(mark) && mark > 0) marks.set(item.market_id, mark);
  }
  return marks;
}

// ===== Liquidation feeds =====

export interface LighterLiquidationFeedOptions {
  getConfig?: () => ConfigView;
  venue: VenueId;                       // Trading venue; the mark-ratio guard runs when it is not Lighter
  getVenueMarks?: VenueMarkPrices;      // That venue's marks (required for the guard; without it trading is blocked)
  venueLabel?: string;
  createSocket?: LighterSocketFactory;  // Tests
  guardWarmupMs?: number;
  guardIntervalMs?: number;
  // Source timings and the per-detection callback (tests, shadow-mode analysis)
  sourceOptions?: Partial<Pick<LighterLiquidationSourceOptions,
    'groupDebounceMs' | 'groupMaxWaitMs' | 'maxEventAgeMs' | 'marketResyncIntervalMs' | 'channelFallbackMs' | 'ws' | 'onDetection'>>;
}

// Lighter liquidation feed for the hunter: the trade-stream source (shadow mode unless liquidationsLive) wired
// to the shared market cache, the LLP / insurance-fund exclusions and, across venues, the mark-ratio guard.
export class LighterLiquidationFeed implements LiquidationSource {
  readonly id = 'lighter' as const;
  readonly source: LighterLiquidationSource;
  readonly guard: LighterMarkRatioGuard | null;
  readonly profile: LighterProfile;
  private readonly runtime: ProfileRuntime;
  private readonly getConfig: ConfigGetter;
  private readonly venue: VenueId;
  private readonly statsProvider: StatsProvider;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private systemConfigTimer: ReturnType<typeof setTimeout> | null = null;
  private systemConfigAttempts = 0;

  constructor(config: ConfigView, options: LighterLiquidationFeedOptions) {
    this.getConfig = options.getConfig ?? (() => config);
    const settings = readLighterSettings(this.getConfig());
    this.profile = getProfile(settings.profile);
    this.runtime = runtimeFor(this.profile);
    bindConfig(this.runtime, this.getConfig, options.getConfig !== undefined);
    this.venue = options.venue;
    const now = runtimeOptions.now ?? Date.now;

    this.guard = options.venue === 'lighter'
      ? null
      : new LighterMarkRatioGuard({
        markets: this.runtime.markets,
        http: this.runtime.http,
        getConfig: this.getConfig,
        otherVenue: options.venueLabel ?? options.venue,
        getOtherMarks: options.getVenueMarks ?? (() => Promise.reject(new Error(`no mark price source for ${options.venue}`))),
        getLighterStats: marketId => this.source.getMarketStats(marketId),
        warmupMs: options.guardWarmupMs,
        intervalMs: options.guardIntervalMs,
      });

    this.source = new LighterLiquidationSource({
      ...options.sourceOptions,
      profile: this.profile,
      resolveSymbol: marketId => this.resolve(marketId),
      marketIds: () => this.marketIds(),
      live: settings.liquidationsLive,
      excludedAccountIndexes: () => (this.runtime.liquidityPoolIndex !== null ? [this.runtime.liquidityPoolIndex] : []),
      createSocket: options.createSocket,
      now,
      onAlert: alert => raiseAlert({ source: 'liquidations', alert }),
    });
    this.statsProvider = marketId => this.source.getMarketStats(marketId);
  }

  get live(): boolean {
    return this.source.live;
  }

  getMarketStats(marketId: number): LighterMarketStatsSnapshot | null {
    return this.source.getMarketStats(marketId);
  }

  // Configured symbols that map to a Lighter market
  private marketIds(): number[] {
    const configured = this.getConfig().symbols ?? {};
    return this.runtime.markets.entries()
      .filter(entry => configured[entry.botSymbol] !== undefined)
      .map(entry => entry.marketId);
  }

  private resolve(marketId: number): LighterLiquidationMarket | undefined {
    const mapped = this.runtime.markets.findByMarketId(marketId);
    if (!mapped) return undefined;
    let disabledReason: string | undefined;
    if (mapped.market.status !== 'active') {
      disabledReason = `Lighter ${mapped.lighterSymbol} is inactive`;
    } else if (this.venue === 'lighter' && mapped.multiplier !== 1) {
      disabledReason = `${mapped.botSymbol} maps to Lighter ${mapped.lighterSymbol} x${mapped.multiplier}, which is a liquidation feed only`;
    } else if (this.venue === 'lighter' && !mapped.market.tradable) {
      disabledReason = `Lighter ${mapped.lighterSymbol} is not tradable (${mapped.market.untradableReasons.join(', ') || 'refuses new positions'})`;
    } else if (this.venue === 'lighter' && this.openInterestCapped(marketId)) {
      disabledReason = `Lighter ${mapped.lighterSymbol} is at its open interest cap (reduce-only)`;
    } else if (this.runtime.systemConfigAt === 0) {
      // Without the liquidity pool account, LLP takeovers (whose forced side is the least certain, spec §2.4,
      // §8 risk 1) can't be told apart from book liquidations: nothing is traded until systemConfig loads
      disabledReason = 'liquidity pool account not known yet (systemConfig not loaded)';
    } else if (this.guard) {
      const status = this.guard.status(mapped.botSymbol);
      if (!status.ok) disabledReason = `mark-ratio guard: ${status.reason}`;
    }
    return {
      botSymbol: mapped.botSymbol,
      multiplier: mapped.multiplier,
      insuranceFundAccountIndex: mapped.market.insuranceFundAccountIndex,
      disabledReason,
    };
  }

  // Fresh market_stats shows the market at its open interest cap (the exchange then only takes reduce-only orders)
  private openInterestCapped(marketId: number): boolean {
    const stats = this.source.getMarketStats(marketId);
    if (!stats || stats.openInterestAgeMs === null || stats.openInterestAgeMs > LIGHTER_OPEN_INTEREST_MAX_AGE_MS) return false;
    return isOpenInterestCapped(stats.openInterest, stats.openInterestLimit) === true;
  }

  // GET systemConfig now, and again on a short backoff until it has loaded once (the 5-minute market refresh keeps
  // it current afterwards)
  private loadSystemConfig(): void {
    if (this.systemConfigTimer) clearTimeout(this.systemConfigTimer);
    this.systemConfigTimer = null;
    const now = runtimeOptions.now ?? Date.now;
    void refreshSystemConfig(this.runtime, now).then(() => {
      if (!this.started || this.runtime.systemConfigAt > 0) {
        this.systemConfigAttempts = 0;
        return;
      }
      if (this.systemConfigTimer) return;
      const delays = LIGHTER_SYSTEM_CONFIG_RETRY_MS;
      const delay = delays[Math.min(this.systemConfigAttempts++, delays.length - 1)];
      this.systemConfigTimer = setTimeout(() => {
        this.systemConfigTimer = null;
        if (this.started) this.loadSystemConfig();
      }, delay);
      (this.systemConfigTimer as { unref?: () => void }).unref?.();
    });
  }

  start(onLiquidation: (event: LiquidationEvent) => void, hooks?: LiquidationSourceHooks): void {
    if (this.started) this.stop();
    this.started = true;
    feeds.add(this);
    this.runtime.statsProviders.add(this.statsProvider);
    const now = runtimeOptions.now ?? Date.now;

    this.source.start(onLiquidation, hooks);
    this.unsubscribe = this.runtime.markets.onUpdate(() => {
      this.source.syncMarkets();
      void refreshSystemConfig(this.runtime, now);
    });
    this.runtime.markets.startAutoRefresh();
    this.loadSystemConfig();
    this.runtime.markets.ensureLoaded().then(
      () => this.source.syncMarkets(),
      error => logErrorWithTimestamp(`Lighter liquidations: loading ${this.profile.label} markets failed; retrying with the 5-minute refresh:`, errorText(error))
    );
    this.guard?.start();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.systemConfigTimer) clearTimeout(this.systemConfigTimer);
    this.systemConfigTimer = null;
    this.systemConfigAttempts = 0;
    this.guard?.stop();
    this.source.stop();
    this.runtime.statsProviders.delete(this.statsProvider);
    feeds.delete(this);
  }

  // Config reload: shadow / live switch and the subscribed markets
  applyConfig(): void {
    const live = readLighterSettings(this.getConfig()).liquidationsLive;
    if (live !== this.source.live) {
      logWarnWithTimestamp(`Lighter liquidations: switching to ${live ? 'LIVE (liquidations will be traded)' : 'shadow mode (logged only)'}`);
      this.source.setLive(live);
    }
    this.source.syncMarkets();
  }
}

// Another venue's liquidation feed (e.g. Aster forceOrder) while trading on Lighter: events for configured
// symbols only reach the hunter while the mark-ratio guard passes for them. Unconfigured symbols pass through
// (the hunter only shows them).
export class MarkGuardedLiquidationSource implements LiquidationSource {
  readonly id: LiquidationSource['id'];
  private readonly loggedBlocks = new Map<string, string>();

  constructor(
    private readonly inner: LiquidationSource,
    readonly guard: LighterMarkRatioGuard,
    private readonly getConfig: ConfigGetter
  ) {
    this.id = inner.id;
  }

  start(onLiquidation: (event: LiquidationEvent) => void, hooks?: LiquidationSourceHooks): void {
    this.guard.start();
    this.inner.start(event => {
      if (this.getConfig().symbols?.[event.symbol] !== undefined) {
        const status = this.guard.status(event.symbol);
        if (!status.ok) {
          if (this.loggedBlocks.get(event.symbol) !== status.reason) {
            this.loggedBlocks.set(event.symbol, status.reason ?? '');
            logWarnWithTimestamp(`Lighter: ignoring ${event.symbol} liquidations while it is blocked: ${status.reason}`);
          }
          return;
        }
        this.loggedBlocks.delete(event.symbol);
      }
      onLiquidation(event);
    }, hooks);
  }

  stop(): void {
    this.inner.stop();
    this.guard.stop();
  }
}

export interface GuardForLighterVenueOptions {
  getConfig?: () => ConfigView;
  otherVenue: string;
  getOtherMarks: VenueMarkPrices;
  warmupMs?: number;
  intervalMs?: number;
}

// Mark-ratio guard for trading on Lighter with liquidations from another venue
export function createLighterVenueGuard(config: ConfigView, options: GuardForLighterVenueOptions): LighterMarkRatioGuard {
  const getConfig: ConfigGetter = options.getConfig ?? (() => config);
  const profile = resolveLighterProfile(getConfig());
  const runtime = runtimeFor(profile);
  bindConfig(runtime, getConfig, options.getConfig !== undefined);
  return new LighterMarkRatioGuard({
    markets: runtime.markets,
    http: runtime.http,
    getConfig,
    otherVenue: options.otherVenue,
    getOtherMarks: options.getOtherMarks,
    getLighterStats: marketId => marketStatsFor(runtime, marketId),
    warmupMs: options.warmupMs,
    intervalMs: options.intervalMs,
  });
}

// ===== Lifecycle =====

// Bot: start the 5-minute market refresh for the configured network
export function startLighterMarketRefresh(config: ConfigView): LighterMarketCache {
  const cache = getLighterMarketCache(resolveLighterProfile(config));
  cache.startAutoRefresh();
  return cache;
}

// Bot config reload: rebuild the symbol mapping now and apply the shadow / live switch
export function applyLighterConfig(): void {
  for (const runtime of runtimes.values()) refreshSymbolMap(runtime);
  for (const feed of feeds) feed.applyConfig();
  for (const guard of guards) void guard.run();
}

// Bot shutdown: stop timers and background tx settling (feeds are stopped by the hunter)
export function stopLighterRuntime(): void {
  for (const adapter of signingAdapters) adapter.close();
  signingAdapters.clear();
  for (const guard of [...guards]) guard.stop();
  for (const runtime of runtimes.values()) {
    runtime.markets.stop();
    runtime.catalog?.stop();
  }
}

// Tests: forget every shared cache, feed and option
export function resetLighterRuntime(): void {
  for (const feed of [...feeds]) feed.stop();
  stopLighterRuntime();
  runtimes.clear();
  feeds.clear();
  guards.clear();
  runtimeOptions = {};
  alertSink = defaultAlertSink;
}
