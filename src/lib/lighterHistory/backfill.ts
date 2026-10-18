import { LighterApiError, LIGHTER_MAX_CANDLES, LIGHTER_MAX_PAGE_LIMIT, isLighterAuthFailure, type LighterHttpClient, type LighterHttpResponse } from '../exchange/lighter/http';
import { lighterTimestampToMs } from '../exchange/lighter/time';
import type { MappedLighterMarket } from '../exchange/lighter/markets';
import type { LighterSymbolRejection } from '../exchange/lighter/symbols';
import {
  LIGHTER_LLP_ONLY_REASON,
  LIGHTER_TX_BOTH_SIDES_FAILURE,
  isRecord,
  lighterCrossCheckNotes,
  lighterExcludedAccounts,
  lighterGroupKey,
  lighterLiquidationEvent,
  lighterPositionGateFailures,
  lighterSawSignedSize,
  lighterTradeId,
  nonNegativeNumber,
  parseLighterLiquidationFill,
  positiveNumber,
  summarizeLighterFills,
  tidy,
  type LighterForcedSide,
  type LighterLiquidationFill,
} from '../liquidation/lighterLiquidationCore';
import type { CandleRecord, LiquidationRecord, LiquidationStorage } from '../services/liquidationStorage';

// Lighter liquidation history from the public REST API (source A, free): GET /api/v1/trades?type=liquidation pages
// back from now to the window start, and GET /api/v1/candles fills the 1m candles of the same window. Fills are
// read, grouped and filtered by the same functions the live feed uses (lighterLiquidationCore.ts) and stored with
// the live feed's group key, so a liquidation recorded live and backfilled later is one row.
//
// What the backfill can't check: the live feed's book gate compares each fill with the best bid / ask from just
// before it, and there is no historical order book. Backfilled rows pass on the other gates (taker position,
// one-sided tx, LLP / insurance fund) and their metadata says the book check was not applied.
//
// The pages come newest first, but the live feed judges liquidations oldest first (the "taker sizes are signed"
// latch of the position gate depends on what it has seen so far). A market's liquidations are therefore collected
// first, then judged in time order and stored.

export const LIGHTER_BACKFILL_DEFAULT_DAYS = 7;
export const LIGHTER_BACKFILL_DEFAULT_DELAY_MS = 1_100;   // ~55 requests a minute
export const LIGHTER_BACKFILL_MAX_RETRIES = 5;
// The REST contract is unverified (the server may ignore type=liquidation and page through every trade): a market's
// paging stops after this many pages in a row without a liquidation row, and after this many pages in all
export const LIGHTER_BACKFILL_MAX_EMPTY_PAGES = 20;
export const LIGHTER_BACKFILL_MAX_PAGES = 2_000;                        // 200k fills of one market
const STORE_CHUNK = 500;                                                // Rows per write transaction (the bot writes too)
// Fills of one liquidation share a tx (and its timestamp): a group is complete once the pages reach fills a
// minute older than it
export const LIGHTER_BACKFILL_GROUP_SETTLE_MS = 60_000;
export const LIGHTER_CANDLE_INTERVAL = '1m';
const CANDLE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const LIGHTER_BACKFILL_BOOK_NOTE = 'book check not applied (no historical best bid/ask)';

export interface LighterBackfillMarket {
  botSymbol: string;
  marketId: number;
  lighterSymbol: string;
  multiplier: number;                        // Bot units per Lighter unit
  insuranceFundAccountIndex: number | null;
}

export interface LighterBackfillDeps {
  client: LighterHttpClient;                 // REST client of the profile (public requests)
  storage: Pick<LiquidationStorage, 'saveBackfilledLiquidations' | 'saveCandles'>;
  // Signs an auth token. Only asked for when the server refuses an unauthenticated request.
  getAuthToken?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface LighterBackfillOptions {
  markets: LighterBackfillMarket[];
  fromMs: number;                            // Window start
  toMs?: number;                             // Window end (default now)
  liquidityPoolIndex: number | null;         // systemConfig.liquidity_pool_index (LLP fills are not book liquidations)
  liquidations?: boolean;                    // Default true
  candles?: boolean;                         // Default true
  dryRun?: boolean;                          // Fetch and count, store nothing
  delayMs?: number;                          // Minimum time between requests
  maxPages?: number;                         // Trade pages per market (default LIGHTER_BACKFILL_MAX_PAGES)
  maxEmptyPages?: number;                    // Consecutive pages without a liquidation row (default LIGHTER_BACKFILL_MAX_EMPTY_PAGES)
}

// Why a market's trade paging ended
export type LighterBackfillStopReason =
  | 'window-start'           // Reached the start of the window
  | 'history-end'            // The API had nothing older (empty page, no next cursor)
  | 'no-liquidation-rows'    // Too many consecutive pages without a liquidation row (type=liquidation ignored?)
  | 'page-cap';              // Hit the page limit before the window start

export interface LighterBackfillSymbolReport {
  symbol: string;
  marketId: number;
  tradePages: number;
  fills: number;
  droppedFills: number;                      // Unparseable or without a timestamp
  liquidations: number;                      // Groups in the window
  gatePassed: number;                        // skip_reason null
  inserted: number;                          // New rows (0 in a dry run)
  reachedWindowStart: boolean;               // false: the history ran out first, or a limit stopped the paging
  stopReason: LighterBackfillStopReason | null;   // null: no liquidation paging was done
  oldestFillTime: number | null;
  candlePages: number;
  candles: number;
  candlesWritten: number;
}

export interface LighterBackfillReport {
  fromMs: number;
  toMs: number;
  authUsed: boolean;
  symbols: LighterBackfillSymbolReport[];
}

// The server wants an auth token and none can be signed
export class LighterBackfillAuthError extends Error {
  constructor(path: string, detail: string) {
    super(
      `Lighter ${path} refused the request without an auth token (${detail}). Set up Lighter API credentials for this ` +
      'profile in config.venues.lighter (the backfill then signs a read-only auth token with them), or pass a token ' +
      'in the LIGHTER_AUTH_TOKEN environment variable.'
    );
    this.name = 'LighterBackfillAuthError';
  }
}

export function backfillWindowStart(days: number, now: number): number {
  return now - days * DAY_MS;
}

// The requested bot symbols as Lighter markets (the bot's symbol mapping, overrides included), and why the others
// can't be backfilled
export function backfillMarketsFor(
  symbols: readonly string[],
  entries: readonly MappedLighterMarket[],
  rejected: readonly LighterSymbolRejection[] = []
): { markets: LighterBackfillMarket[]; missing: Array<{ symbol: string; reason: string }> } {
  const bySymbol = new Map(entries.map((entry) => [entry.botSymbol, entry]));
  const markets: LighterBackfillMarket[] = [];
  const missing: Array<{ symbol: string; reason: string }> = [];
  for (const symbol of symbols) {
    const entry = bySymbol.get(symbol);
    if (entry) {
      markets.push({
        botSymbol: entry.botSymbol,
        marketId: entry.marketId,
        lighterSymbol: entry.lighterSymbol,
        multiplier: entry.multiplier,
        insuranceFundAccountIndex: entry.market.insuranceFundAccountIndex,
      });
    } else {
      missing.push({ symbol, reason: rejected.find((item) => item.botSymbol === symbol)?.reason ?? 'no Lighter market with that name' });
    }
  }
  return { markets, missing };
}

function bodyCode(data: unknown): number | null {
  return isRecord(data) && typeof data.code === 'number' ? data.code : null;
}

function bodyMessage(data: unknown): string {
  if (isRecord(data) && typeof data.message === 'string' && data.message !== '') return data.message;
  if (typeof data === 'string' && data !== '') return data.length > 200 ? `${data.slice(0, 200)}...` : data;
  return 'request failed';
}

// 401, the documented token failure, or an error that says it is about auth (a bare 403 is more likely a block)
function needsAuth(response: LighterHttpResponse): boolean {
  if (response.status === 401 || isLighterAuthFailure(response)) return true;
  const code = bodyCode(response.data);
  return (response.status !== 200 || (code !== null && code !== 200)) && /auth/i.test(bodyMessage(response.data));
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

type Query = Record<string, string | number | boolean | undefined>;

interface Group {
  key: string;
  fills: LighterLiquidationFill[];
  oldest: number;
  newest: number;
}

// What the report and the log say about a stop that is not the normal end of the paging (null: nothing to say)
export function describeLighterBackfillStop(
  reason: LighterBackfillStopReason,
  limits: { maxPages: number; maxEmptyPages: number }
): string | null {
  switch (reason) {
    case 'history-end':
      return 'the trade history ends before the window start';
    case 'no-liquidation-rows':
      return `stopped after ${limits.maxEmptyPages} consecutive pages without a liquidation row (the server may be ignoring ` +
        'type=liquidation); the window is incomplete';
    case 'page-cap':
      return `stopped at the limit of ${limits.maxPages} pages before the window start; raise --max-pages or shorten --days ` +
        '(the window is incomplete)';
    default:
      return null;
  }
}

export class LighterHistoryBackfill {
  private readonly client: LighterHttpClient;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private lastRequestAt = -Infinity;
  private delayMs = LIGHTER_BACKFILL_DEFAULT_DELAY_MS;
  private authHeader: string | null = null;
  private sawSignedSizeBefore = false;

  constructor(private readonly deps: LighterBackfillDeps) {
    this.client = deps.client;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
  }

  async run(options: LighterBackfillOptions): Promise<LighterBackfillReport> {
    const toMs = options.toMs ?? this.now();
    this.delayMs = Math.max(0, options.delayMs ?? LIGHTER_BACKFILL_DEFAULT_DELAY_MS);
    const report: LighterBackfillReport = { fromMs: options.fromMs, toMs, authUsed: false, symbols: [] };
    for (const market of options.markets) {
      const symbolReport: LighterBackfillSymbolReport = {
        symbol: market.botSymbol, marketId: market.marketId, tradePages: 0, fills: 0, droppedFills: 0, liquidations: 0,
        gatePassed: 0, inserted: 0, reachedWindowStart: false, stopReason: null, oldestFillTime: null, candlePages: 0, candles: 0,
        candlesWritten: 0,
      };
      report.symbols.push(symbolReport);
      if (options.liquidations !== false) await this.backfillLiquidations(market, options, toMs, symbolReport);
      if (options.candles !== false) await this.backfillCandles(market, options, toMs, symbolReport);
    }
    report.authUsed = this.authHeader !== null;
    return report;
  }

  // ===== Liquidations =====

  private async backfillLiquidations(
    market: LighterBackfillMarket,
    options: LighterBackfillOptions,
    toMs: number,
    report: LighterBackfillSymbolReport
  ): Promise<void> {
    const label = `${market.botSymbol} (Lighter ${market.lighterSymbol}, market ${market.marketId})`;
    const limits = {
      maxPages: Math.max(1, Math.floor(options.maxPages ?? LIGHTER_BACKFILL_MAX_PAGES)),
      maxEmptyPages: Math.max(1, Math.floor(options.maxEmptyPages ?? LIGHTER_BACKFILL_MAX_EMPTY_PAGES)),
    };
    const stopBefore = options.fromMs - LIGHTER_BACKFILL_GROUP_SETTLE_MS;
    const seen = new Set<string>();
    const groups = new Map<string, Group>();
    const txSides = new Map<string, Set<LighterForcedSide>>();
    let cursor: string | undefined;
    let oldestSeen = Infinity;
    let pagesWithoutLiquidations = 0;
    let stopReason: LighterBackfillStopReason;

    for (;;) {
      const body = await this.getJson('/api/v1/trades', {
        type: 'liquidation',
        market_id: market.marketId,
        sort_by: 'timestamp',
        sort_dir: 'desc',
        limit: LIGHTER_MAX_PAGE_LIMIT,
        cursor,
      });
      report.tradePages++;
      const rows = Array.isArray(body.trades) ? body.trades : [];
      let liquidationRows = 0;

      for (const row of rows) {
        if (!isRecord(row) || row.type !== 'liquidation') continue;
        liquidationRows++;
        const tradeId = lighterTradeId(row);
        if (tradeId === null) {
          report.droppedFills++;
          continue;
        }
        if (seen.has(tradeId)) continue;
        seen.add(tradeId);
        // Any age is fine here; a row without a usable timestamp can't be placed in the window
        const parsed = parseLighterLiquidationFill(row, tradeId, market.marketId, { now: this.now, timestampWindowMs: Infinity });
        if ('error' in parsed || parsed.fill.timeFallback) {
          report.droppedFills++;
          continue;
        }
        const fill = parsed.fill;
        report.fills++;
        oldestSeen = Math.min(oldestSeen, fill.time);
        if (fill.time < stopBefore || fill.time > toMs) continue;
        const key = lighterGroupKey(fill);
        const group = groups.get(key) ?? { key, fills: [], oldest: fill.time, newest: fill.time };
        group.fills.push(fill);
        group.oldest = Math.min(group.oldest, fill.time);
        group.newest = Math.max(group.newest, fill.time);
        groups.set(key, group);
        if (fill.txHash !== null) {
          const txKey = `${fill.marketId}:${fill.txHash}`;
          const sides = txSides.get(txKey) ?? new Set<LighterForcedSide>();
          sides.add(fill.side);
          txSides.set(txKey, sides);
        }
      }

      report.oldestFillTime = Number.isFinite(oldestSeen) ? oldestSeen : null;
      pagesWithoutLiquidations = liquidationRows === 0 ? pagesWithoutLiquidations + 1 : 0;
      const nextCursor = typeof body.next_cursor === 'string' && body.next_cursor !== '' ? body.next_cursor : undefined;

      this.log(
        `${label}: page ${report.tradePages}, ${report.fills} fills, ${groups.size} liquidations` +
        (report.oldestFillTime !== null ? `, back to ${iso(report.oldestFillTime)}` : '')
      );
      if (oldestSeen < stopBefore) {
        stopReason = 'window-start';
      } else if (rows.length === 0 || nextCursor === undefined || nextCursor === cursor) {
        stopReason = 'history-end';
      } else if (pagesWithoutLiquidations >= limits.maxEmptyPages) {
        stopReason = 'no-liquidation-rows';
      } else if (report.tradePages >= limits.maxPages) {
        stopReason = 'page-cap';
      } else {
        cursor = nextCursor;
        continue;
      }
      break;
    }

    report.stopReason = stopReason;
    report.reachedWindowStart = stopReason === 'window-start';
    const note = describeLighterBackfillStop(stopReason, limits);
    if (note !== null) {
      this.log(`${label}: ${note}` + (report.oldestFillTime !== null ? ` (oldest liquidation ${iso(report.oldestFillTime)})` : ' (no liquidations)'));
    }

    // At the page cap the paging may have cut a liquidation's fills in two: only the groups it has moved a minute
    // past are complete. Otherwise (window start, end of the history, pages without any liquidation row after them)
    // every group is.
    const cut = stopReason === 'page-cap';
    const complete = [...groups.values()].filter((group) => !cut || group.oldest - oldestSeen > LIGHTER_BACKFILL_GROUP_SETTLE_MS);
    if (complete.length < groups.size) {
      this.log(`${label}: ${groups.size - complete.length} liquidation(s) at the oldest edge left out (their fills may continue past the last page)`);
    }
    await this.storeGroups(market, options, complete, txSides, report);
  }

  // Judges the liquidations oldest first, as the live feed meets them, and stores them
  private async storeGroups(
    market: LighterBackfillMarket,
    options: LighterBackfillOptions,
    groups: Group[],
    txSides: Map<string, Set<LighterForcedSide>>,
    report: LighterBackfillSymbolReport
  ): Promise<void> {
    const chronological = [...groups].sort((a, b) => a.newest - b.newest || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const records: LiquidationRecord[] = [];
    for (const group of chronological) {
      const record = this.groupRecord(market, options, group, txSides);
      if (!record) continue;
      report.liquidations++;
      if (record.skipReason === null) report.gatePassed++;
      records.push(record);
    }
    if (options.dryRun) return;
    for (let i = 0; i < records.length; i += STORE_CHUNK) {
      report.inserted += await this.deps.storage.saveBackfilledLiquidations(records.slice(i, i + STORE_CHUNK));
    }
  }

  // One liquidation as the live feed would have read it, minus the book check; null when outside the window.
  // Updates the signed-size latch, so call it in time order.
  private groupRecord(
    market: LighterBackfillMarket,
    options: LighterBackfillOptions,
    group: Group,
    txSides: Map<string, Set<LighterForcedSide>>
  ): LiquidationRecord | null {
    const fills = group.fills;
    const side = fills[0].side;
    const excludedAccounts = lighterExcludedAccounts(
      { insuranceFundAccountIndex: market.insuranceFundAccountIndex },
      () => (options.liquidityPoolIndex !== null ? [options.liquidityPoolIndex] : [])
    );
    const summary = summarizeLighterFills(fills, excludedAccounts);
    if (lighterSawSignedSize(summary.counted)) this.sawSignedSizeBefore = true;   // As the live feed's cross-check does
    if (summary.eventTime < options.fromMs) return null;

    const dropReasons: string[] = [];
    if (summary.tradable.length === 0) dropReasons.push(LIGHTER_LLP_ONLY_REASON);
    const txHash = fills[0].txHash;
    if (txHash !== null && (txSides.get(`${fills[0].marketId}:${txHash}`)?.size ?? 0) > 1) {
      dropReasons.push(LIGHTER_TX_BOTH_SIDES_FAILURE);
    }
    dropReasons.push(...lighterPositionGateFailures(side, summary.counted, this.sawSignedSizeBefore));
    const notes = [...lighterCrossCheckNotes(side, summary.counted, this.sawSignedSizeBefore), LIGHTER_BACKFILL_BOOK_NOTE];
    if (summary.excluded.length > 0 && summary.tradable.length > 0) {
      notes.push(`${summary.excluded.length} fill(s) against the LLP / insurance fund left out of the volume`);
    }

    const event = lighterLiquidationEvent(
      { botSymbol: market.botSymbol, multiplier: market.multiplier },
      side,
      summary.quantity,
      summary.averagePrice,
      summary.eventTime
    );
    return {
      venue: 'lighter',
      source: 'backfill',
      externalId: group.key,
      symbol: event.symbol,
      side: event.side,
      quantity: event.quantity,
      price: event.price,
      volumeUsdt: event.qty * event.price,
      eventTime: event.eventTime,
      skipReason: dropReasons.length > 0 ? dropReasons.join('; ') : null,
      mode: null,
      metadata: {
        orderType: event.orderType,
        originalQty: event.qty,
        originalTime: event.time,
        marketId: market.marketId,
        txHash,
        notionalUsd: tidy(summary.usdAmount),
        tradeIds: summary.counted.map((fill) => fill.tradeId),
        excludedTradeIds: summary.excluded.map((fill) => fill.tradeId),
        notes,
      },
    };
  }

  // ===== Candles =====

  // 1m candles in windows of 500 (the per-call maximum), oldest first, in bot units
  private async backfillCandles(
    market: LighterBackfillMarket,
    options: LighterBackfillOptions,
    toMs: number,
    report: LighterBackfillSymbolReport
  ): Promise<void> {
    const span = LIGHTER_MAX_CANDLES * CANDLE_MS;
    const first = Math.floor(options.fromMs / CANDLE_MS) * CANDLE_MS;
    for (let start = first; start <= toMs; start += span) {
      const end = Math.min(start + span - 1, toMs);
      const body = await this.getJson('/api/v1/candles', {
        market_id: market.marketId,
        resolution: LIGHTER_CANDLE_INTERVAL,
        start_timestamp: start,
        end_timestamp: end,
        count_back: LIGHTER_MAX_CANDLES,
      });
      report.candlePages++;
      const candles = (Array.isArray(body.c) ? body.c : [])
        .map((raw) => parseLighterCandle(raw, market))
        .filter((candle): candle is CandleRecord => candle !== null && candle.openTime >= start && candle.openTime <= end);
      report.candles += candles.length;
      if (candles.length > 0 && !options.dryRun) report.candlesWritten += await this.deps.storage.saveCandles(candles);
      if (report.candlePages % 10 === 0 || end >= toMs) {
        this.log(`${market.botSymbol}: ${report.candles} candles (${LIGHTER_CANDLE_INTERVAL}) up to ${iso(end)}`);
      }
    }
  }

  // ===== HTTP =====

  // GET with a minimum gap between requests, backoff on 429 / 5xx / network errors, and an auth token once the
  // server asks for one
  private async getJson(path: string, query: Query): Promise<Record<string, unknown>> {
    let authRetried = false;
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      let response: LighterHttpResponse;
      try {
        response = await this.client.request({
          method: 'GET',
          url: this.client.url(path, query),
          headers: this.authHeader ? { authorization: this.authHeader } : undefined,
        });
      } catch (error) {
        if (attempt >= LIGHTER_BACKFILL_MAX_RETRIES) throw error;
        await this.backoff(path, attempt, error instanceof Error ? error.message : String(error));
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt >= LIGHTER_BACKFILL_MAX_RETRIES) {
          throw new LighterApiError(path, response.status, bodyCode(response.data), bodyMessage(response.data));
        }
        await this.backoff(path, attempt, `HTTP ${response.status}`);
        continue;
      }

      if (needsAuth(response)) {
        const detail = `HTTP ${response.status}: ${bodyMessage(response.data)}`;
        if (this.authHeader === null) {
          if (!this.deps.getAuthToken) throw new LighterBackfillAuthError(path, detail);
          this.log(`Lighter ${path} needs an auth token (${detail}); signing one with the configured Lighter key`);
          this.authHeader = await this.deps.getAuthToken();
          continue;
        }
        if (!authRetried && this.deps.getAuthToken) {
          authRetried = true;
          this.authHeader = await this.deps.getAuthToken();
          continue;
        }
        throw new LighterApiError(path, response.status, bodyCode(response.data), `auth token rejected: ${bodyMessage(response.data)}`);
      }

      const code = bodyCode(response.data);
      if (response.status !== 200 || (code !== null && code !== 200) || !isRecord(response.data)) {
        throw new LighterApiError(path, response.status, code, response.status === 200 && code === null ? 'unexpected response body' : bodyMessage(response.data));
      }
      return response.data;
    }
  }

  private async pace(): Promise<void> {
    const wait = this.lastRequestAt + this.delayMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }

  private async backoff(path: string, attempt: number, why: string): Promise<void> {
    const ms = Math.min(2_000 * 2 ** attempt, 60_000);
    this.log(`Lighter ${path}: ${why}; retrying in ${ms / 1000}s (attempt ${attempt + 2} of ${LIGHTER_BACKFILL_MAX_RETRIES + 1})`);
    await this.sleep(ms);
  }
}

// A candle in bot units; null when it has no usable time or prices (zero values are omitted on the wire)
export function parseLighterCandle(raw: unknown, market: Pick<LighterBackfillMarket, 'botSymbol' | 'multiplier'>): CandleRecord | null {
  if (!isRecord(raw)) return null;
  const openTime = lighterTimestampToMs(raw.t);
  const open = positiveNumber(raw.o);
  const high = positiveNumber(raw.h);
  const low = positiveNumber(raw.l);
  const close = positiveNumber(raw.c);
  if (openTime === null || open === null || high === null || low === null || close === null) return null;
  const volume = nonNegativeNumber(raw.v) ?? 0;
  const multiplier = market.multiplier;
  const price = (value: number) => (multiplier === 1 ? value : tidy(value / multiplier));
  return {
    venue: 'lighter',
    symbol: market.botSymbol,
    interval: LIGHTER_CANDLE_INTERVAL,
    openTime,
    open: price(open),
    high: price(high),
    low: price(low),
    close: price(close),
    volume: multiplier === 1 ? volume : tidy(volume * multiplier),
  };
}

export function runLighterBackfill(deps: LighterBackfillDeps, options: LighterBackfillOptions): Promise<LighterBackfillReport> {
  return new LighterHistoryBackfill(deps).run(options);
}
