import type { LiquidationEvent } from '../types';
import { logErrorWithTimestamp, logWarnWithTimestamp, logWithTimestamp } from '../utils/timestamp';
import { getProfile, lighterStreamUrl, type LighterProfile, type LighterProfileName } from '../exchange/lighter/profiles';
import {
  LighterWsClient,
  normalizeLighterChannel,
  type LighterSocketFactory,
  type LighterWsClientOptions,
  type LighterWsDisconnectInfo,
  type LighterWsFrame,
} from '../exchange/lighter/ws';
import type { LiquidationSource, LiquidationSourceHooks } from './types';
import { lighterTimestampToMs } from '../exchange/lighter/time';
import {
  LIGHTER_LLP_ONLY_REASON,
  LIGHTER_TX_BOTH_SIDES_FAILURE,
  formatNumber,
  isRecord,
  lighterCrossCheckNotes,
  lighterExcludedAccounts,
  lighterGroupKey,
  lighterLiquidationEvent,
  lighterPositionGateFailures,
  lighterSawSignedSize,
  lighterTradeId,
  marketIdValue,
  nonNegativeNumber,
  parseLighterLiquidationFill,
  positiveNumber,
  resolveLighterMarket,
  summarizeLighterFills,
  tidy,
  type LighterForcedSide,
  type LighterLiquidationFill,
  type LighterLiquidationMarket,
  type LighterMarketResolver,
} from './lighterLiquidationCore';
import { setLiquidationOrigin } from './origin';

// Lighter liquidation feed (spec §2): public trade/{marketId} channels -> LiquidationEvent.
//
// Per frame (§2.5):
//  1. null / ping / pong / connected are handled by the WS client; error and shutdown frames too.
//  2. subscribed/trade* snapshots are NEVER emitted: their liquidation ids only seed the dedupe LRU.
//  3. update/trade* rows = [...trades, ...liquidation_trades] filtered to type === 'liquidation'
//     (deleverage / market-settlement have no order-book impact).
//  4. Dedupe on trade_id_str ?? String(trade_id) (LRU of 10k), across both arrays, channels and reconnects.
//  5. Group fills by market_id:tx_hash:takerOrderId (one liquidation sweeping several levels = one Trade per
//     maker fill); a group is flushed 300 ms after its last fill (at most 1 s after its first).
//  6. quantity = sum(size), price = averagePrice = sum(size*price)/sum(size), eventTime = max(timestamp).
//  7. Dropped for trading (still logged): older than 10 s, unmapped or disabled market, every fill against
//     the LLP / insurance fund, or any side verification gate failing (sideVerificationFailures).
// Forced side (§2.4): Lighter liquidation orders are internal IOC orders (LiquidationOrder = 8), so the
// liquidated account is the taker: is_maker_ask=false means the taker sold into bids = forced SELL (a long was
// liquidated); is_maker_ask=true = forced BUY. The gates only pass a group when the data agrees: the taker held a
// position the fill reduced without flipping (fields required), the fills sit on the expected side of the mid of
// the book from before the first fill (the newest market_stats whose exchange timestamp is earlier than the first
// fill's trade timestamp), and the tx has no fills on the other side.
//
// SHADOW MODE (§8 risk 1): with `live` false (the class default) every detected liquidation is logged with the
// gate results but onLiquidation is never called, so the hunter cannot trade on it.

export const LIGHTER_LIQUIDATION_MAX_AGE_MS = 10_000;
export const LIGHTER_LIQUIDATION_DEDUPE_CAPACITY = 10_000;
export const LIGHTER_LIQUIDATION_GROUP_DEBOUNCE_MS = 300;
export const LIGHTER_LIQUIDATION_GROUP_MAX_WAIT_MS = 1_000;
export const LIGHTER_TRADE_CHANNEL_FALLBACK_MS = 10_000;  // No ack on trade/{id} -> also try trade_fe/{id}
export const LIGHTER_MARKET_RESYNC_INTERVAL_MS = 60_000;
export const LIGHTER_MARKET_STATS_CHANNEL = 'market_stats/all';
export { LIGHTER_INSURANCE_FUND_OPERATOR_ACCOUNT_INDEX } from './lighterLiquidationCore';
const TIMESTAMP_SANITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const UNMAPPED_LOG_INTERVAL_MS = 60_000;

type TradeChannelKind = 'trade' | 'trade_fe';
type ForcedSide = LighterForcedSide;

// What the liquidation source needs to know about a market (lighterLiquidationCore.ts)
export type { LighterLiquidationMarket, LighterMarketResolver };

type ValueOrGetter<T> = T | (() => T);

export interface LighterLiquidationSourceOptions {
  profile?: LighterProfile | LighterProfileName; // Network; the stream URL comes from the profile table
  url?: string;                                  // Explicit stream URL (tests); overrides profile
  resolveSymbol: LighterMarketResolver;
  // Markets to subscribe: the ones mapped to configured bot symbols. Re-read every marketResyncIntervalMs
  // and on syncMarkets().
  marketIds: ValueOrGetter<Iterable<number>>;
  live?: boolean;                                // Default false: shadow mode, never calls onLiquidation
  // Accounts whose fills are never traded (GET /api/v1/systemConfig liquidity_pool_index, ...). Account 1
  // (insurance fund operator) and the market's insurance fund account are always excluded.
  excludedAccountIndexes?: ValueOrGetter<Iterable<number>>;
  maxEventAgeMs?: number;
  dedupeCapacity?: number;
  groupDebounceMs?: number;                      // 0 flushes at the end of each frame
  groupMaxWaitMs?: number;
  channelFallbackMs?: number;
  marketResyncIntervalMs?: number;               // 0 disables the periodic re-read
  createSocket?: LighterSocketFactory;           // Tests inject a fake WebSocket here
  ws?: Partial<Omit<LighterWsClientOptions, 'url' | 'createSocket' | 'now' | 'label'>>;
  now?: () => number;
  onDetection?: (detection: LighterLiquidationDetection) => void; // Every flushed group (shadow analysis, tests)
  onAlert?: (alert: LighterLiquidationAlert) => void;             // Coverage gaps and server error frames
}

export interface LighterLiquidationBbo {
  bestBid: number | null;
  bestAsk: number | null;
  markPrice: number | null;
  ageMs: number;                       // Age of the oldest of bestBid / bestAsk / markPrice
  // Exchange time (market_stats frame timestamp, ms) of the newer of bestBid / bestAsk; null when either value
  // came in a frame without one. Orders the book snapshot against a fill's trade timestamp.
  bookTime: number | null;
  openInterest: number | null;         // Raw market_stats values (see markets.ts isOpenInterestCapped)
  openInterestLimit: number | null;
  openInterestAgeMs: number | null;    // Age of the older of the two; null until both arrived
}

export interface LighterLiquidationDetection {
  key: string;                    // marketId:txHash:takerOrderId
  marketId: number;
  botSymbol: string | null;
  side: ForcedSide;               // Forced order side (Binance forceOrder.o.S semantics)
  quantity: number;               // Lighter units, tradable fills only (all fills when none is tradable)
  averagePrice: number;
  notionalUsd: number;
  eventTime: number;
  ageMs: number;
  tradeIds: string[];
  excludedTradeIds: string[];     // Fills against the LLP / insurance fund
  txHash: string | null;
  event: LiquidationEvent | null; // In bot units; null when the market is unmapped
  live: boolean;
  emitted: boolean;               // onLiquidation was called
  dropReasons: string[];          // Why it was not tradable; empty when it was
  notes: string[];                // Cross-check results and data oddities (never gate trading)
  bbo: LighterLiquidationBbo | null;
}

export type LighterLiquidationAlert =
  | { kind: 'coverage-gap'; marketId: number; botSymbol: string | null; channels: string[]; message: string }
  | { kind: 'server-error'; code?: unknown; message: string };

// Trade timestamp in ms (shared with the adapter)
export { lighterTimestampToMs };

// Forced order side from the taker rule (§2.4, INFERRED): taker sold into bids -> forced SELL
export { lighterForcedSide } from './lighterLiquidationCore';

// Insertion-ordered LRU of trade ids
export class TradeIdLru {
  private readonly ids = new Map<string, true>();

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`invalid LRU capacity ${capacity}`);
  }

  get size(): number {
    return this.ids.size;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    if (this.ids.has(id)) this.ids.delete(id);
    this.ids.set(id, true);
    if (this.ids.size > this.capacity) {
      const oldest = this.ids.keys().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
  }
}

type Fill = LighterLiquidationFill;

interface Group {
  key: string;
  marketId: number;
  side: ForcedSide;
  fills: Fill[];
  firstAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

// Sides seen per (market, tx hash), so a tx with fills on both sides can be dropped
const TX_SIDES_WINDOW_MS = 60_000;

interface MarketSubscription {
  marketId: number;
  requested: Set<string>;   // Trade channels asked for in this session
  failed: Set<string>;
  active: string | null;    // First acked trade channel
  fallbackTimer: ReturnType<typeof setTimeout> | null;
  gapReported: boolean;
}

type StatKey = 'bestBid' | 'bestAsk' | 'markPrice' | 'openInterest' | 'openInterestLimit';

// Each value keeps the time it was last present in a frame, so a frame carrying only some fields never makes the
// others look fresh
interface MarketStats {
  fields: Partial<Record<StatKey, { value: number | null; at: number; exchangeAt: number | null }>>;
  receivedAt: number;   // First frame for this market (age when no price field ever arrived)
}

// Best bid / ask after each market_stats frame that changed either, stamped with the frame's exchange time
interface BookSnapshot {
  bestBid: number;
  bestAsk: number;
  bookTime: number;
  receivedAt: number;
}
const BOOK_HISTORY_MS = 30_000;
const BOOK_HISTORY_MAX = 300;

const STAT_FIELDS: ReadonlyArray<{ key: StatKey; field: string; parse: (value: unknown) => number | null }> = [
  { key: 'bestBid', field: 'best_bid_price', parse: positiveNumber },
  { key: 'bestAsk', field: 'best_ask_price', parse: positiveNumber },
  { key: 'markPrice', field: 'mark_price', parse: positiveNumber },
  { key: 'openInterest', field: 'open_interest', parse: nonNegativeNumber },
  { key: 'openInterestLimit', field: 'open_interest_limit', parse: nonNegativeNumber },
];
const PRICE_STAT_KEYS: ReadonlyArray<StatKey> = ['bestBid', 'bestAsk', 'markPrice'];

function readValue<T>(value: ValueOrGetter<T> | undefined): T | undefined {
  return typeof value === 'function' ? (value as () => T)() : value;
}

function tradeChannel(kind: TradeChannelKind, marketId: number): string {
  return `${kind}/${marketId}`;
}

// 'trade/1' or 'trade_fe/1' -> { kind, marketId }
function parseTradeChannel(channel: string): { kind: TradeChannelKind; marketId: number } | null {
  const match = /^(trade|trade_fe)\/(\d+)$/.exec(channel);
  if (!match) return null;
  const marketId = Number(match[2]);
  return Number.isSafeInteger(marketId) ? { kind: match[1] as TradeChannelKind, marketId } : null;
}

function tradeFrameKind(type: unknown): 'snapshot' | 'update' | null {
  switch (type) {
    case 'subscribed/trade':
    case 'subscribed/trade_fe':
      return 'snapshot';
    case 'update/trade':
    case 'update/trade_fe':
      return 'update';
    default:
      return null;
  }
}

export class LighterLiquidationSource implements LiquidationSource {
  readonly id = 'lighter' as const;
  readonly url: string;

  private readonly options: LighterLiquidationSourceOptions;
  private readonly now: () => number;
  private readonly maxEventAgeMs: number;
  private readonly groupDebounceMs: number;
  private readonly groupMaxWaitMs: number;
  private readonly channelFallbackMs: number;
  private readonly marketResyncIntervalMs: number;
  private readonly seen: TradeIdLru;

  private liveMode: boolean;
  private running = false;
  private client: LighterWsClient | null = null;
  private onLiquidation: ((event: LiquidationEvent) => void) | null = null;
  private hooks: LiquidationSourceHooks = {};
  private resyncTimer: ReturnType<typeof setInterval> | null = null;

  private readonly markets = new Map<number, MarketSubscription>();
  private readonly preferredKind = new Map<number, TradeChannelKind>(); // Learned from earlier sessions
  private readonly groups = new Map<string, Group>();
  private readonly txSides = new Map<string, { sides: Set<ForcedSide>; at: number }>();
  private readonly marketStats = new Map<number, MarketStats>();
  private readonly bookHistory = new Map<number, BookSnapshot[]>();
  private readonly unmappedLoggedAt = new Map<number, number>();
  private warnedNoMarkets = false;
  private sawSignedSizeBefore = false;

  constructor(options: LighterLiquidationSourceOptions) {
    if (typeof options.resolveSymbol !== 'function') throw new Error('LighterLiquidationSource needs resolveSymbol');
    if (options.url) {
      this.url = options.url;
    } else if (options.profile) {
      const profile = typeof options.profile === 'string' ? getProfile(options.profile) : options.profile;
      this.url = lighterStreamUrl(profile);
    } else {
      throw new Error('LighterLiquidationSource needs a Lighter profile (or an explicit stream url)');
    }
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.liveMode = options.live === true;
    this.maxEventAgeMs = options.maxEventAgeMs ?? LIGHTER_LIQUIDATION_MAX_AGE_MS;
    this.groupDebounceMs = options.groupDebounceMs ?? LIGHTER_LIQUIDATION_GROUP_DEBOUNCE_MS;
    this.groupMaxWaitMs = options.groupMaxWaitMs ?? LIGHTER_LIQUIDATION_GROUP_MAX_WAIT_MS;
    this.channelFallbackMs = options.channelFallbackMs ?? LIGHTER_TRADE_CHANNEL_FALLBACK_MS;
    this.marketResyncIntervalMs = options.marketResyncIntervalMs ?? LIGHTER_MARKET_RESYNC_INTERVAL_MS;
    this.seen = new TradeIdLru(options.dedupeCapacity ?? LIGHTER_LIQUIDATION_DEDUPE_CAPACITY);
  }

  get live(): boolean {
    return this.liveMode;
  }

  // Switch between shadow and live at runtime (config reload). Groups already pending use the new mode.
  setLive(live: boolean): void {
    if (this.liveMode === live) return;
    this.liveMode = live;
    this.logMode();
  }

  start(onLiquidation: (event: LiquidationEvent) => void, hooks: LiquidationSourceHooks = {}): void {
    if (this.running) this.stop();
    this.onLiquidation = onLiquidation;
    this.hooks = hooks;
    this.running = true;
    this.logMode();

    this.client = new LighterWsClient(
      {
        ...this.options.ws,
        url: this.url,
        createSocket: this.options.createSocket,
        now: this.now,
        label: 'Lighter liquidations',
      },
      {
        onMessage: (frame, raw) => this.handleFrame(frame, raw),
        onSessionReady: () => this.handleSessionReady(),
        onDisconnected: (info) => this.handleDisconnected(info),
        onFrameError: (error, raw) => this.callHook(() => this.hooks.onError?.(error, { kind: 'message', rawMessage: raw })),
        onServerError: (error) => this.handleServerError(error),
        onChannelAcked: (channel) => this.handleChannelAcked(channel),
        onChannelFailed: (channel, attempts) => this.handleChannelFailed(channel, attempts),
        onShutdownNotice: (closeInMs) => {
          logWithTimestamp(`Lighter liquidations: server shutdown notice (closes in ${closeInMs ?? '?'} ms); reconnecting now`);
        },
      }
    );

    this.syncMarkets();
    this.client.subscribe(LIGHTER_MARKET_STATS_CHANNEL);
    if (this.marketResyncIntervalMs > 0) {
      this.resyncTimer = setInterval(() => this.syncMarkets(), this.marketResyncIntervalMs);
    }
    this.client.start();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.resyncTimer) clearInterval(this.resyncTimer);
    this.resyncTimer = null;
    for (const sub of this.markets.values()) this.clearFallback(sub);
    this.markets.clear();
    // Pending groups are dropped: nothing is emitted after stop
    for (const group of this.groups.values()) {
      if (group.timer) clearTimeout(group.timer);
    }
    this.groups.clear();
    this.txSides.clear();
    const client = this.client;
    this.client = null;
    client?.stop();
  }

  // Re-read marketIds and subscribe / unsubscribe the difference (call after a market refresh or config change)
  syncMarkets(): void {
    if (!this.running || !this.client) return;
    const wanted = new Set<number>();
    let raw: Iterable<number> | undefined;
    try {
      raw = readValue(this.options.marketIds);
    } catch (error) {
      logErrorWithTimestamp('Lighter liquidations: reading the market list failed; keeping the current subscriptions:', error);
      return;
    }
    for (const value of raw ?? []) {
      const marketId = marketIdValue(value);
      if (marketId === null) {
        logWarnWithTimestamp(`Lighter liquidations: ignoring invalid market id ${String(value)}`);
        continue;
      }
      wanted.add(marketId);
    }

    for (const marketId of wanted) {
      if (this.markets.has(marketId)) continue;
      const sub: MarketSubscription = {
        marketId,
        requested: new Set(),
        failed: new Set(),
        active: null,
        fallbackTimer: null,
        gapReported: false,
      };
      this.markets.set(marketId, sub);
      this.subscribeMarket(sub);
    }
    for (const [marketId, sub] of this.markets) {
      if (wanted.has(marketId)) continue;
      this.clearFallback(sub);
      for (const channel of sub.requested) this.client.unsubscribe(channel);
      this.markets.delete(marketId);
      logWithTimestamp(`Lighter liquidations: unsubscribed market ${marketId} (${this.symbolLabel(marketId)})`);
    }

    if (wanted.size === 0 && !this.warnedNoMarkets) {
      this.warnedNoMarkets = true;
      logWarnWithTimestamp('Lighter liquidations: no Lighter market maps to a configured symbol; the feed is idle');
    } else if (wanted.size > 0) {
      this.warnedNoMarkets = false;
    }
  }

  // Latest market_stats values for a market (BBO cross-check; also usable for the mark-ratio guard)
  getMarketStats(marketId: number): LighterLiquidationBbo | null {
    const stats = this.marketStats.get(marketId);
    if (!stats) return null;
    const now = this.now();
    const { fields } = stats;
    const priceTimes = PRICE_STAT_KEYS.map((key) => fields[key]?.at).filter((at): at is number => at !== undefined);
    const oi = fields.openInterest;
    const limit = fields.openInterestLimit;
    const bidAt = fields.bestBid?.exchangeAt ?? null;
    const askAt = fields.bestAsk?.exchangeAt ?? null;
    return {
      bestBid: fields.bestBid?.value ?? null,
      bestAsk: fields.bestAsk?.value ?? null,
      markPrice: fields.markPrice?.value ?? null,
      ageMs: now - (priceTimes.length > 0 ? Math.min(...priceTimes) : stats.receivedAt),
      bookTime: bidAt !== null && askAt !== null ? Math.max(bidAt, askAt) : null,
      openInterest: oi?.value ?? null,
      openInterestLimit: limit?.value ?? null,
      openInterestAgeMs: oi && limit ? now - Math.min(oi.at, limit.at) : null,
    };
  }

  // ===== Subscriptions =====

  private subscribeMarket(sub: MarketSubscription): void {
    const client = this.client;
    if (!client) return;
    const primary = tradeChannel(this.preferredKind.get(sub.marketId) ?? 'trade', sub.marketId);
    sub.requested.add(primary);
    client.subscribe(primary);
    // Before the session is ready the fallback timer starts in handleSessionReady
    if (client.isSessionReady) this.armFallback(sub);
  }

  private handleSessionReady(): void {
    logWithTimestamp(`Lighter liquidations: connected; subscribing ${this.markets.size} market(s)`);
    const client = this.client;
    if (!client) return;
    for (const sub of this.markets.values()) {
      this.clearFallback(sub);
      sub.active = null;
      sub.failed.clear();
      sub.gapReported = false;
      const primary = tradeChannel(this.preferredKind.get(sub.marketId) ?? 'trade', sub.marketId);
      // Start each session from the preferred channel only
      for (const channel of sub.requested) {
        if (channel !== primary) client.unsubscribe(channel);
      }
      sub.requested = new Set([primary]);
      client.subscribe(primary);
      this.armFallback(sub);
    }
    this.callHook(() => this.hooks.onConnected?.());
  }

  private armFallback(sub: MarketSubscription): void {
    this.clearFallback(sub);
    sub.fallbackTimer = setTimeout(() => {
      sub.fallbackTimer = null;
      this.requestFallback(sub, `no ack within ${this.channelFallbackMs} ms`);
    }, this.channelFallbackMs);
  }

  private clearFallback(sub: MarketSubscription): void {
    if (sub.fallbackTimer) clearTimeout(sub.fallbackTimer);
    sub.fallbackTimer = null;
  }

  // Subscribe the market's other trade channel (trade/{id} <-> trade_fe/{id}) unless one is already acked
  private requestFallback(sub: MarketSubscription, why: string): void {
    const client = this.client;
    if (!client || sub.active || this.markets.get(sub.marketId) !== sub) return;
    for (const kind of ['trade', 'trade_fe'] as const) {
      const channel = tradeChannel(kind, sub.marketId);
      if (sub.requested.has(channel)) continue;
      logWarnWithTimestamp(
        `Lighter liquidations: ${[...sub.requested].join(', ')} for ${this.symbolLabel(sub.marketId)}: ${why}; also subscribing ${channel}`
      );
      sub.requested.add(channel);
      client.subscribe(channel);
      return;
    }
  }

  private handleChannelAcked(channel: string): void {
    if (channel === LIGHTER_MARKET_STATS_CHANNEL) {
      logWithTimestamp('Lighter liquidations: market_stats/all subscribed (BBO cross-check available)');
      return;
    }
    const parsed = parseTradeChannel(channel);
    const sub = parsed ? this.markets.get(parsed.marketId) : undefined;
    if (!parsed || !sub || !this.client) return;

    if (sub.active === null) {
      sub.active = channel;
      this.preferredKind.set(parsed.marketId, parsed.kind);
      this.clearFallback(sub);
      // One live trade channel per market: drop the other one
      for (const other of sub.requested) {
        if (other !== channel) this.client.unsubscribe(other);
      }
      sub.requested = new Set([channel]);
      logWithTimestamp(`Lighter liquidations: subscribed ${channel} (${this.symbolLabel(parsed.marketId)})`);
    } else if (sub.active !== channel) {
      this.client.unsubscribe(channel);
      sub.requested.delete(channel);
    }
  }

  private handleChannelFailed(channel: string, attempts: number): void {
    if (channel === LIGHTER_MARKET_STATS_CHANNEL) {
      logWarnWithTimestamp(
        `Lighter liquidations: ${channel} was not acked after ${attempts} attempts; BBO cross-checks are unavailable until reconnect`
      );
      return;
    }
    const parsed = parseTradeChannel(channel);
    const sub = parsed ? this.markets.get(parsed.marketId) : undefined;
    if (!parsed || !sub || sub.active) return;
    sub.failed.add(channel);

    const pending = [...sub.requested].filter((requested) => !sub.failed.has(requested));
    if (pending.length > 0) return;
    if (sub.requested.size < 2) {
      this.requestFallback(sub, `not acked after ${attempts} attempts`);
      return;
    }
    if (sub.gapReported) return;
    sub.gapReported = true;
    const botSymbol = this.botSymbolOf(sub.marketId);
    const channels = [...sub.requested];
    const message =
      `COVERAGE GAP: no Lighter trade channel acked for ${this.symbolLabel(sub.marketId)} ` +
      `(${channels.join(', ')}); its liquidations are not seen until the next reconnect`;
    logErrorWithTimestamp(`Lighter liquidations: ${message}`);
    this.options.onAlert?.({ kind: 'coverage-gap', marketId: sub.marketId, botSymbol, channels, message });
  }

  private handleDisconnected(info: LighterWsDisconnectInfo): void {
    for (const sub of this.markets.values()) {
      this.clearFallback(sub);
      sub.active = null;
    }
    const { error, reconnectDelayMs } = info;
    if (error && reconnectDelayMs !== null) {
      this.callHook(() => this.hooks.onError?.(error, { kind: 'connection', url: this.url, reconnectDelayMs }));
    }
    if (info.reason !== 'stopped') {
      const delay = info.reconnectDelayMs === null ? 'not reconnecting' : `reconnecting in ${info.reconnectDelayMs} ms`;
      logWarnWithTimestamp(`Lighter liquidations: disconnected (${info.reason}${info.error ? `: ${info.error.message}` : ''}); ${delay}`);
    }
    this.callHook(() => this.hooks.onDisconnected?.({ reconnectDelayMs }));
  }

  private handleServerError(error: { code?: unknown; message?: unknown }): void {
    const message = typeof error.message === 'string' ? error.message : JSON.stringify(error.message ?? error);
    logWarnWithTimestamp(`Lighter liquidations: server error frame (code ${String(error.code ?? '?')}): ${message}`);
    this.options.onAlert?.({ kind: 'server-error', code: error.code, message });
  }

  // ===== Frames =====

  private handleFrame(frame: LighterWsFrame, _raw: string): void {
    if (!this.running) return;
    if (frame.type === 'subscribed/market_stats' || frame.type === 'update/market_stats') {
      this.updateMarketStats(frame);
      return;
    }
    const kind = tradeFrameKind(frame.type);
    if (!kind) return;

    const channelMarketId = typeof frame.channel === 'string'
      ? parseTradeChannel(normalizeLighterChannel(frame.channel))?.marketId ?? null
      : null;
    const rows = this.liquidationRows(frame);

    if (kind === 'snapshot') {
      // Snapshots carry recent history: never emit, only remember the ids
      let seeded = 0;
      for (const row of rows) {
        const tradeId = lighterTradeId(row);
        if (tradeId === null) continue;
        this.seen.add(tradeId);
        seeded++;
      }
      if (seeded > 0) {
        logWithTimestamp(
          `Lighter liquidations: ${frame.channel} snapshot holds ${seeded} recent liquidation fill(s); recorded as seen, not traded`
        );
      }
      return;
    }

    const touched = new Set<Group>();
    for (const row of rows) {
      const tradeId = lighterTradeId(row);
      if (tradeId === null) {
        logWarnWithTimestamp('Lighter liquidations: dropping a liquidation row without trade_id (cannot dedupe):', JSON.stringify(row));
        continue;
      }
      if (this.seen.has(tradeId)) continue; // Duplicate across arrays, channels or reconnects
      this.seen.add(tradeId);

      const fill = this.parseFill(row, tradeId, channelMarketId);
      if (!fill) continue;
      touched.add(this.addToGroup(fill));
    }

    for (const group of touched) this.scheduleFlush(group);
  }

  // [...trades, ...liquidation_trades] filtered to type === 'liquidation'
  private liquidationRows(frame: LighterWsFrame): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = [];
    const take = (list: unknown, source: 'trades' | 'liquidation_trades') => {
      if (!Array.isArray(list)) return;
      for (const row of list) {
        if (!isRecord(row)) continue;
        if (row.type === 'liquidation') {
          rows.push(row);
        } else if (source === 'liquidation_trades') {
          // Diagnostics for shadow mode: liquidation_trades is expected to hold only liquidations
          logWarnWithTimestamp(
            `Lighter liquidations: ignoring liquidation_trades row ${String(row.trade_id_str ?? row.trade_id)} of type ${String(row.type)}`
          );
        }
      }
    };
    take(frame.trades, 'trades');
    take(frame.liquidation_trades, 'liquidation_trades');
    return rows;
  }

  private parseFill(row: Record<string, unknown>, tradeId: string, channelMarketId: number | null): Fill | null {
    // timestamp, else transaction_time; one more than 24 h off the local clock is unusable (receive time is
    // used and noted). A timestamp ahead of the clock is clamped to now.
    const parsed = parseLighterLiquidationFill(row, tradeId, channelMarketId, { now: this.now, timestampWindowMs: TIMESTAMP_SANITY_WINDOW_MS });
    if ('error' in parsed) {
      logWarnWithTimestamp(`Lighter liquidations: dropping liquidation fill ${tradeId}: ${parsed.error}`);
      return null;
    }
    return parsed.fill;
  }

  private addToGroup(fill: Fill): Group {
    const key = lighterGroupKey(fill);
    let group = this.groups.get(key);
    if (!group) {
      group = {
        key,
        marketId: fill.marketId,
        side: fill.side,
        fills: [],
        firstAt: this.now(),
        timer: null,
      };
      this.groups.set(key, group);
    }
    group.fills.push(fill);
    this.noteTxSide(fill);
    return group;
  }

  private txSideKey(marketId: number, txHash: string): string {
    return `${marketId}:${txHash}`;
  }

  private noteTxSide(fill: Fill): void {
    if (fill.txHash === null) return;
    const now = this.now();
    for (const [key, entry] of this.txSides) {
      if (now - entry.at > TX_SIDES_WINDOW_MS) this.txSides.delete(key);
    }
    const key = this.txSideKey(fill.marketId, fill.txHash);
    const entry = this.txSides.get(key) ?? { sides: new Set<ForcedSide>(), at: now };
    entry.sides.add(fill.side);
    this.txSides.set(key, entry);
  }

  private scheduleFlush(group: Group): void {
    if (group.timer) clearTimeout(group.timer);
    group.timer = null;
    if (this.groupDebounceMs <= 0) {
      this.flushGroup(group);
      return;
    }
    const remaining = Math.max(0, group.firstAt + this.groupMaxWaitMs - this.now());
    group.timer = setTimeout(() => this.flushGroup(group), Math.min(this.groupDebounceMs, remaining));
  }

  private flushGroup(group: Group): void {
    if (this.groups.get(group.key) !== group) return;
    this.groups.delete(group.key);
    if (group.timer) clearTimeout(group.timer);
    group.timer = null;
    if (!this.running) return;

    try {
      this.processGroup(group);
    } catch (error) {
      this.callHook(() => this.hooks.onError?.(error, { kind: 'message', rawMessage: `Lighter liquidation group ${group.key}` }));
    }
  }

  private processGroup(group: Group): void {
    const now = this.now();
    const resolved = this.resolveMarket(group.marketId);
    const market = resolved.market;
    const { tradable, excluded, counted, quantity, averagePrice, eventTime, usdAmount: usdSum } =
      summarizeLighterFills(group.fills, this.excludedAccounts(market));
    const ageMs = now - eventTime;

    const dropReasons: string[] = [];
    if (!market) dropReasons.push(resolved.error ?? `market ${group.marketId} is not mapped to a configured symbol`);
    else if (market.disabledReason) dropReasons.push(`market disabled: ${market.disabledReason}`);
    if (tradable.length === 0) {
      dropReasons.push(LIGHTER_LLP_ONLY_REASON);
    }
    if (ageMs > this.maxEventAgeMs) dropReasons.push(`stale: ${ageMs} ms old (limit ${this.maxEventAgeMs} ms)`);

    const notes: string[] = [];
    if (excluded.length > 0 && tradable.length > 0) {
      notes.push(`${excluded.length} fill(s) against the LLP / insurance fund left out of the volume`);
    }
    if (counted.some((fill) => fill.timeFallback)) {
      notes.push('no usable trade timestamp (missing or more than 24 h off); used receive time');
    }
    const maxAhead = Math.max(...counted.map((fill) => fill.aheadMs));
    if (maxAhead > 1000) notes.push(`trade timestamp ${maxAhead} ms ahead of the local clock; clamped to now (check clock sync)`);
    const mismatched = counted.find((fill) => fill.mismatchedChannelMarketId !== null);
    if (mismatched) {
      notes.push(`row market_id ${group.marketId} differs from channel market ${mismatched.mismatchedChannelMarketId}`);
    }
    notes.push(...this.crossChecks(group.side, counted));

    // market_stats and trades are separate channels, so a stats frame showing the book after this liquidation
    // can arrive before its trade frame: the book is picked by exchange time, from before the first fill
    const firstFillTime = group.fills.some((fill) => fill.timeFallback) ? null : Math.min(...group.fills.map((fill) => fill.time));
    const bbo = firstFillTime === null ? null : this.bookBefore(group.marketId, firstFillTime);
    notes.push(this.bboNote(group.side, counted, bbo));
    dropReasons.push(...this.sideVerificationFailures(group, counted, bbo, firstFillTime));

    const live = this.liveMode;
    let event: LiquidationEvent | null = null;
    if (market) {
      event = lighterLiquidationEvent(market, group.side, quantity, averagePrice, eventTime);
      // Storage files the hunter's copy and the detection record under the same id
      setLiquidationOrigin(event, { venue: 'lighter', externalId: group.key, mode: live ? 'live' : 'shadow' });
    }

    const emit = live && dropReasons.length === 0 && event !== null && this.onLiquidation !== null;
    const detection: LighterLiquidationDetection = {
      key: group.key,
      marketId: group.marketId,
      botSymbol: market?.botSymbol ?? null,
      side: group.side,
      quantity,
      averagePrice,
      notionalUsd: tidy(usdSum),
      eventTime,
      ageMs,
      tradeIds: counted.map((fill) => fill.tradeId),
      excludedTradeIds: excluded.map((fill) => fill.tradeId),
      txHash: group.fills[0].txHash,
      event,
      live,
      emitted: emit,
      dropReasons,
      notes,
      bbo,
    };

    this.logDetection(detection, !market);
    try {
      this.options.onDetection?.(detection);
    } catch (error) {
      logErrorWithTimestamp('Lighter liquidations: onDetection handler failed:', error);
    }

    if (emit && event) {
      try {
        this.onLiquidation?.(event);
      } catch (error) {
        this.callHook(() => this.hooks.onError?.(error, { kind: 'message', rawMessage: JSON.stringify(event) }));
      }
    }
  }

  // Gates that must all pass before a liquidation is traded (applied in shadow mode too, so its log shows them).
  // Lighter liquidation orders are internal IOC orders, so the liquidated account is the taker; each gate checks
  // that the data agrees, and anything missing fails closed.
  private sideVerificationFailures(group: Group, fills: Fill[], bbo: LighterLiquidationBbo | null, firstFillTime: number | null): string[] {
    const failures: string[] = [];
    const side = group.side;

    // A tx whose fills sit on both sides of the book is not a one-directional forced order
    if (group.fills[0].txHash !== null) {
      const sides = this.txSides.get(this.txSideKey(group.marketId, group.fills[0].txHash))?.sides;
      if (sides && sides.size > 1) failures.push(LIGHTER_TX_BOTH_SIDES_FAILURE);
    }

    // The taker must have held a position that each fill reduced without flipping
    failures.push(...lighterPositionGateFailures(side, fills, this.sawSignedSizeBefore));

    // Book check against the best bid / ask from before the first fill (bookBefore): a forced SELL fills at or
    // below the mid, a forced BUY at or above it (every fill)
    if (firstFillTime === null) {
      failures.push('side unverified: no trade timestamp to find the best bid/ask from before the fill');
    } else if (!bbo || bbo.bestBid === null || bbo.bestAsk === null || bbo.bookTime === null ||
        bbo.ageMs > this.maxEventAgeMs || firstFillTime - bbo.bookTime > this.maxEventAgeMs) {
      failures.push('side unverified: no fresh best bid/ask from before the fill to check the prices against');
    } else {
      const mid = (bbo.bestBid + bbo.bestAsk) / 2;
      if (side === 'SELL' && fills.some((fill) => fill.price > mid)) {
        failures.push(`side unverified: forced SELL filled above the mid ${formatNumber(mid)}`);
      } else if (side === 'BUY' && fills.some((fill) => fill.price < mid)) {
        failures.push(`side unverified: forced BUY filled below the mid ${formatNumber(mid)}`);
      }
    }

    return failures;
  }

  // §2.4 cross-checks (a) and (b), also logged as notes for diagnosis (the gates above decide trading)
  private crossChecks(side: ForcedSide, fills: Fill[]): string[] {
    if (lighterSawSignedSize(fills)) this.sawSignedSizeBefore = true;
    return lighterCrossCheckNotes(side, fills, this.sawSignedSizeBefore);
  }

  // §2.4 cross-check (c): a forced SELL prints at or below the best bid, a forced BUY at or above the best ask
  private bboNote(side: ForcedSide, fills: Fill[], bbo: LighterLiquidationBbo | null): string {
    if (!bbo) return 'BBO check: no market_stats yet';
    const reference = side === 'SELL' ? bbo.bestBid : bbo.bestAsk;
    if (reference === null) return `BBO check: no best ${side === 'SELL' ? 'bid' : 'ask'} in market_stats`;
    if (side === 'SELL') {
      const highest = Math.max(...fills.map((fill) => fill.price));
      return highest <= reference
        ? `BBO check ok: forced SELL fills <= best bid ${formatNumber(reference)} (stats ${bbo.ageMs} ms old)`
        : `BBO CHECK MISMATCH: forced SELL filled at ${formatNumber(highest)} above best bid ${formatNumber(reference)} (stats ${bbo.ageMs} ms old; side may be inverted)`;
    }
    const lowest = Math.min(...fills.map((fill) => fill.price));
    return lowest >= reference
      ? `BBO check ok: forced BUY fills >= best ask ${formatNumber(reference)} (stats ${bbo.ageMs} ms old)`
      : `BBO CHECK MISMATCH: forced BUY filled at ${formatNumber(lowest)} below best ask ${formatNumber(reference)} (stats ${bbo.ageMs} ms old; side may be inverted)`;
  }

  private logDetection(detection: LighterLiquidationDetection, unmapped: boolean): void {
    const now = this.now();
    if (unmapped) {
      // Usually a market that was just unmapped: log at most once a minute per market
      const last = this.unmappedLoggedAt.get(detection.marketId);
      if (last !== undefined && now - last < UNMAPPED_LOG_INTERVAL_MS) return;
      this.unmappedLoggedAt.set(detection.marketId, now);
    }

    const mode = detection.live ? 'LIVE' : 'SHADOW';
    const symbol = detection.botSymbol ?? `market ${detection.marketId}`;
    const fills = detection.tradeIds.length + detection.excludedTradeIds.length;
    const head =
      `Lighter liquidation [${mode}] ${symbol}: forced ${detection.side} ${formatNumber(detection.quantity)} @ ` +
      `${formatNumber(detection.averagePrice)} ($${detection.notionalUsd.toFixed(2)}), ${fills} fill(s), ` +
      `age ${detection.ageMs} ms, tx ${detection.txHash ? detection.txHash.slice(0, 16) : '?'}`;
    let outcome: string;
    if (detection.emitted) outcome = 'sent to the hunter';
    else if (detection.dropReasons.length > 0) outcome = `not traded: ${detection.dropReasons.join('; ')}`;
    else outcome = 'not traded: shadow mode';
    const line = `${head} -> ${outcome}${detection.notes.length > 0 ? ` | ${detection.notes.join(' | ')}` : ''}`;

    if (detection.notes.some((note) => note.startsWith('CHECK') || note.startsWith('BBO CHECK MISMATCH'))) {
      logWarnWithTimestamp(line);
    } else {
      logWithTimestamp(line);
    }
  }

  // ===== Market data =====

  private updateMarketStats(frame: LighterWsFrame): void {
    const stats = frame.market_stats;
    if (!isRecord(stats)) return;
    const receivedAt = this.now();
    const exchangeAt = lighterTimestampToMs(frame.timestamp);
    for (const [key, value] of Object.entries(stats)) {
      if (!isRecord(value)) continue;
      const marketId = marketIdValue(value.market_id ?? key);
      if (marketId === null) continue;
      const stats = this.marketStats.get(marketId) ?? { fields: {}, receivedAt };
      // Update frames may carry only some fields: the others keep their last value and the time it arrived
      for (const { key, field, parse } of STAT_FIELDS) {
        if (field in value) stats.fields[key] = { value: parse(value[field]), at: receivedAt, exchangeAt };
      }
      this.marketStats.set(marketId, stats);
      if ('best_bid_price' in value || 'best_ask_price' in value) this.recordBook(marketId, stats, receivedAt);
    }
  }

  private recordBook(marketId: number, stats: MarketStats, receivedAt: number): void {
    const bid = stats.fields.bestBid;
    const ask = stats.fields.bestAsk;
    const history = this.bookHistory.get(marketId) ?? [];
    while (history.length > 0 && (receivedAt - history[0].receivedAt > BOOK_HISTORY_MS || history.length >= BOOK_HISTORY_MAX)) {
      history.shift();
    }
    // A book without an exchange time cannot be placed before a fill, so it is left out
    if (bid?.value != null && ask?.value != null && bid.exchangeAt !== null && ask.exchangeAt !== null) {
      history.push({ bestBid: bid.value, bestAsk: ask.value, bookTime: Math.max(bid.exchangeAt, ask.exchangeAt), receivedAt });
    }
    this.bookHistory.set(marketId, history);
  }

  // The newest best bid / ask stamped before `time` (exchange ms): the book as it was before a fill there
  private bookBefore(marketId: number, time: number): LighterLiquidationBbo | null {
    const history = this.bookHistory.get(marketId);
    const current = this.getMarketStats(marketId);
    if (!history || !current) return null;
    // Newest book by exchange time (not arrival order) that is strictly older than the fill; on equal exchange
    // times the later arrival is the newer update
    let best: (typeof history)[number] | null = null;
    for (const book of history) {
      if (book.bookTime < time && (best === null || book.bookTime >= best.bookTime)) best = book;
    }
    if (!best) return null;
    return { ...current, bestBid: best.bestBid, bestAsk: best.bestAsk, ageMs: this.now() - best.receivedAt, bookTime: best.bookTime };
  }

  private resolveMarket(marketId: number): { market: LighterLiquidationMarket | null; error?: string } {
    return resolveLighterMarket(this.options.resolveSymbol, marketId);
  }

  private excludedAccounts(market: LighterLiquidationMarket | null): Set<number> {
    return lighterExcludedAccounts(
      market,
      () => readValue(this.options.excludedAccountIndexes),
      (error) => logErrorWithTimestamp('Lighter liquidations: reading the excluded accounts failed:', error)
    );
  }

  private botSymbolOf(marketId: number): string | null {
    return this.resolveMarket(marketId).market?.botSymbol ?? null;
  }

  private symbolLabel(marketId: number): string {
    const botSymbol = this.botSymbolOf(marketId);
    return botSymbol ? `${botSymbol}, market ${marketId}` : `market ${marketId}`;
  }

  private callHook(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      logErrorWithTimestamp('Lighter liquidations: hunter hook failed:', error);
    }
  }

  private logMode(): void {
    if (this.liveMode) {
      logWarnWithTimestamp('Lighter liquidations: LIVE mode - detected liquidations are sent to the hunter and can trigger trades');
    } else {
      logWithTimestamp('Lighter liquidations: SHADOW mode - liquidations are logged only, never sent to the hunter');
    }
  }
}
