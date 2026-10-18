// Pair-trade analysis of the liquidation signal. The bot trades contrarian after a liquidation (a forced SELL, a
// long being liquidated, becomes a BUY; a forced BUY becomes a SELL). This module replays those signals against 1m
// candles and asks whether hedged or paired versions of the same signal do better than the single leg:
//
//   single       the contrarian trade on the liquidated symbol
//   hedged       the same leg plus an opposite leg on a hedge symbol (BTC by default), sized by the beta of the
//                liquidated symbol to the hedge symbol over the minutes before the event
//   cross-pair   the contrarian legs of two symbols that were liquidated in opposite directions within a window:
//                long the one whose longs were liquidated, short the one whose shorts were, equal notional
//
// Pure: no database, no clock (the caller passes `now`), no console. scripts/pair-analysis.ts loads the rows and
// candles (pairAnalysisDb.ts), runs this and prints the report (pairAnalysisReport.ts).
//
// Timing. A 1m candle is keyed by its open time and closes one minute later. The entry is the close of the candle
// that contains the event (open = floor(eventTime / 1 minute) x 1 minute), so it is always after the liquidation's
// trade, by up to a minute; an event exactly on a minute boundary belongs to the candle that starts there. The exit is
// the close of the candle `horizon` minutes after the entry candle. A missing candle excludes the event from that
// strategy and horizon with a counted reason; nothing is interpolated unless the caller asks for `exitFill: 'carry'`,
// which lets a missing exit candle take the last close up to exitCarryMaxMin minutes before it (counted).
//
// Units. Returns are in bps of the notional of the liquidated symbol's leg ("the primary leg"), net of costs. A
// hedge leg of beta 1.5 adds 1.5x that notional of exposure, a cross pair adds 1x: `exposure` says how much gross
// notional a strategy deploys per unit of primary notional, so the mean can be compared per unit of exposure.
//
// Baselines. A hedged trade is compared with the single leg of the same event. A cross pair is compared twice: with
// the triggering event's single leg (the pair as a hedge of the trigger by its partner) and with both events' single
// legs, each entered at its own signal (what a bot that trades every symbol single-leg already holds). Only the
// second says whether executing the two legs as a pair adds anything.

export const MINUTE_MS = 60_000;
export const BPS = 10_000;

export const BETA_MIN = 0;
export const BETA_MAX = 3;
export const BETA_FALLBACK = 1;

export type TradeDirection = 1 | -1;                // 1 = long, -1 = short

export interface LiquidationRow {
  id: number;
  symbol: string;
  side: string;                                     // The liquidation order's side: SELL = a long was liquidated
  eventTime: number;                                // ms
  volumeUsdt: number;
  backfilled?: boolean;                             // Loaded by lighter:backfill: no book check (see docs)
}

export interface PairEvent {
  id: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  direction: TradeDirection;                        // The contrarian trade: SELL liquidation -> long
  eventTime: number;
  volumeUsdt: number;
  backfilled: boolean;
}

// Close price by candle open time (ms)
export type CandleSeries = ReadonlyMap<number, number>;

// The contrarian trade for a liquidation: long liquidations (forced SELL) lead to a BUY, short ones to a SELL
export function tradeDirection(side: 'BUY' | 'SELL'): TradeDirection {
  return side === 'SELL' ? 1 : -1;
}

// ===== Events =====

export interface EventSelectionOptions {
  minUsd: number;                                   // Row size (default) or burst total (burstSum) below which nothing is traded
  dedupeSec: number;                                // One event per symbol and side within this window
  burstSum?: boolean;                               // Apply minUsd to the burst's total instead of to each row
}

export interface EventSelection {
  events: PairEvent[];                              // Oldest first
  rows: number;
  invalid: number;                                  // Unknown side or non-finite time / size
  belowMinUsd: number;                              // Rows below minUsd (burstSum: rows of the bursts whose total is)
  collapsed: number;                                // Rows folded into an earlier event of the same burst
}

interface Burst {
  anchor: number;                                   // Time of the burst's first row
  rows: number;
  total: number;
  fired: boolean;
}

// Rows -> events. Two ways to apply the size threshold, then bursts collapse: the first row of a symbol and side opens
// a window of dedupeSec, and later rows of that symbol and side inside it are dropped. The window is anchored on that
// row, not extended by the dropped ones, so a long cascade yields an event per window. A row exactly dedupeSec after
// the anchor opens a new burst.
//
// Per row (default): rows below minUsd are ignored first (the bot acts on a row that crosses its threshold), so the
// window is anchored on the first row that is big enough and the event is that row.
//
// Burst total (burstSum): every row belongs to the burst of its window, and the burst trades once its total reaches
// minUsd. That models the bot's rolling threshold (useThreshold), which adds up the liquidations of the last 60 s and
// acts when the sum crosses. The event is the row that makes the total cross, not the burst's first row: the bot cannot
// act before the sum is known, and entering at the first row would use the rest of the burst in advance. Its size is the
// running total at that row. A burst that never reaches minUsd is dropped, all its rows counted as belowMinUsd; one
// that does counts all its other rows as collapsed. With minUsd 0 both ways give the same events.
export function selectEvents(rows: readonly LiquidationRow[], options: EventSelectionOptions): EventSelection {
  const dedupeMs = options.dedupeSec * 1000;
  const usable = rows.filter(row => (row.side === 'BUY' || row.side === 'SELL') && Number.isFinite(row.eventTime) && Number.isFinite(row.volumeUsdt));
  const ordered = [...usable].sort((a, b) => a.eventTime - b.eventTime || a.id - b.id);
  const anchors = new Map<string, number>();
  const bursts = new Map<string, Burst>();
  const events: PairEvent[] = [];
  const invalid = rows.length - usable.length;
  let belowMinUsd = 0;
  let collapsed = 0;
  const emit = (row: LiquidationRow, volumeUsdt: number): void => {
    events.push({
      id: row.id,
      symbol: row.symbol,
      side: row.side as 'BUY' | 'SELL',
      direction: tradeDirection(row.side as 'BUY' | 'SELL'),
      eventTime: row.eventTime,
      volumeUsdt,
      backfilled: row.backfilled === true,
    });
  };
  const close = (burst: Burst): void => {
    if (burst.fired) collapsed += burst.rows - 1;
    else belowMinUsd += burst.rows;
  };
  for (const row of ordered) {
    const key = `${row.symbol}|${row.side}`;
    if (options.burstSum) {
      let burst = bursts.get(key);
      if (burst && row.eventTime - burst.anchor >= dedupeMs) {
        close(burst);
        burst = undefined;
      }
      if (!burst) {
        burst = { anchor: row.eventTime, rows: 0, total: 0, fired: false };
        bursts.set(key, burst);
      }
      burst.rows++;
      burst.total += row.volumeUsdt;
      if (!burst.fired && burst.total >= options.minUsd) {
        burst.fired = true;
        emit(row, burst.total);
      }
      continue;
    }
    if (row.volumeUsdt < options.minUsd) {
      belowMinUsd++;
      continue;
    }
    const anchor = anchors.get(key);
    if (anchor !== undefined && row.eventTime - anchor < dedupeMs) {
      collapsed++;
      continue;
    }
    anchors.set(key, row.eventTime);
    emit(row, row.volumeUsdt);
  }
  for (const burst of bursts.values()) close(burst);
  return { events, rows: rows.length, invalid, belowMinUsd, collapsed };
}

// ===== Candles =====

// Close prices by open time. Rows with a non-positive or non-finite close are dropped (a gap, not a price).
export function candleSeries(candles: Iterable<{ openTime: number; close: number }>): Map<number, number> {
  const series = new Map<number, number>();
  for (const candle of candles) {
    if (Number.isFinite(candle.openTime) && Number.isFinite(candle.close) && candle.close > 0) series.set(candle.openTime, candle.close);
  }
  return series;
}

// Open time of the entry candle of an event: the 1m candle that contains it. The entry is that candle's close, a
// moment after the liquidation's trade (up to a minute; a full minute for an event exactly on the boundary, which
// belongs to the candle starting there). The candle that ended at the boundary is never used: it predates the trade.
export function entryOpenTime(eventTime: number): number {
  return Math.floor(eventTime / MINUTE_MS) * MINUTE_MS;
}

type LegResult = { ok: true; ret: number; carried: boolean } | { ok: false; missing: 'entry' | 'exit' };

// Simple return of a symbol from the close of the entry candle to the close of the exit candle. With carryMaxMin > 0 a
// missing exit candle takes the last stored close up to carryMaxMin minutes before it (a minute without trades has no
// candle: the price stood where it last closed). The entry is never carried, and it is the oldest candle the search can
// reach: it exists, so the search stops there at the latest, and a candle before the entry is never taken.
function legReturn(series: CandleSeries | undefined, entryOpen: number, exitOpen: number, carryMaxMin = 0): LegResult {
  const entry = series?.get(entryOpen);
  if (entry === undefined) return { ok: false, missing: 'entry' };
  let exit = series?.get(exitOpen);
  let carried = false;
  for (let k = 1; exit === undefined && k <= carryMaxMin; k++) {
    exit = series?.get(exitOpen - k * MINUTE_MS);
    carried = exit !== undefined;
  }
  if (exit === undefined) return { ok: false, missing: 'exit' };
  return { ok: true, ret: exit / entry - 1, carried };
}

// ===== Beta =====

// Why a beta fell back to BETA_FALLBACK. An event can have two reasons (both series short of history).
export type BetaFallbackReason =
  | 'asset-short'                                   // The liquidated symbol had fewer than the minimum of 1m returns in the lookback
  | 'hedge-short'                                   // ... the hedge symbol did
  | 'hedge-flat';                                   // Enough returns, but the hedge never moved (no variance)

export interface BetaEstimate {
  beta: number;                                     // The value used: clamped to [BETA_MIN, BETA_MAX], or the fallback
  raw: number | null;                               // The regression slope, null when it could not be estimated
  observations: number;                             // Minutes where both symbols had a 1m return
  assetReturns: number;                             // Minutes where the asset alone had one
  hedgeReturns: number;                             // ... and the hedge alone
  fallback: boolean;                                // Too little data (or a flat hedge): BETA_FALLBACK was used
  fallbackReasons: BetaFallbackReason[];            // Why, empty when there was no fallback
  clamped: boolean;                                 // The raw slope was outside the range
}

// Beta of the asset to the hedge: slope of the asset's 1m simple returns on the hedge's (the returns the legs earn),
// over the lookbackMin minutes that closed at or before the entry candle opened. The newest candle used opens one
// minute before the entry candle; the entry candle itself, where the liquidation's trade is, never counts. Only
// minutes where both symbols have the candle and the one before it count (no interpolation). With fewer than
// minObservations of them, or a hedge that did not move, the beta is BETA_FALLBACK and `fallback` says so, with the
// reasons: a series short of history is told from a flat hedge, so the advice to fetch candles names the right symbol.
export function estimateBeta(
  asset: CandleSeries | undefined,
  hedge: CandleSeries | undefined,
  entryOpen: number,
  lookbackMin: number,
  minObservations: number
): BetaEstimate {
  const assetReturns: number[] = [];
  const hedgeReturns: number[] = [];
  let assetOnly = 0;
  let hedgeOnly = 0;
  for (let k = 1; k <= lookbackMin; k++) {
    const open = entryOpen - k * MINUTE_MS;                    // This candle closes at entryOpen - (k - 1) minutes
    const a1 = asset?.get(open);
    const a0 = asset?.get(open - MINUTE_MS);
    const h1 = hedge?.get(open);
    const h0 = hedge?.get(open - MINUTE_MS);
    const assetHas = a1 !== undefined && a0 !== undefined;
    const hedgeHas = h1 !== undefined && h0 !== undefined;
    if (assetHas) assetOnly++;
    if (hedgeHas) hedgeOnly++;
    if (!assetHas || !hedgeHas) continue;
    assetReturns.push(a1 / a0 - 1);
    hedgeReturns.push(h1 / h0 - 1);
  }
  const n = assetReturns.length;
  const needed = Math.max(2, minObservations);
  let raw: number | null = null;
  if (n >= needed) {
    const assetMean = mean(assetReturns);
    const hedgeMean = mean(hedgeReturns);
    let covariance = 0;
    let variance = 0;
    for (let i = 0; i < n; i++) {
      covariance += (assetReturns[i] - assetMean) * (hedgeReturns[i] - hedgeMean);
      variance += (hedgeReturns[i] - hedgeMean) ** 2;
    }
    if (variance > 1e-18) raw = covariance / variance;
  }
  if (raw === null || !Number.isFinite(raw)) {
    const reasons: BetaFallbackReason[] = [];
    if (n < needed) {
      if (assetOnly < needed) reasons.push('asset-short');
      if (hedgeOnly < needed) reasons.push('hedge-short');
      // Each has enough returns but not in the same minutes: blame the thinner one, which is the one with the holes
      if (reasons.length === 0) reasons.push(assetOnly <= hedgeOnly ? 'asset-short' : 'hedge-short');
    } else {
      reasons.push('hedge-flat');
    }
    return { beta: BETA_FALLBACK, raw: null, observations: n, assetReturns: assetOnly, hedgeReturns: hedgeOnly, fallback: true, fallbackReasons: reasons, clamped: false };
  }
  const beta = Math.min(BETA_MAX, Math.max(BETA_MIN, raw));
  return { beta, raw, observations: n, assetReturns: assetOnly, hedgeReturns: hedgeOnly, fallback: false, fallbackReasons: [], clamped: beta !== raw };
}

// ===== Cross pairs =====

export interface CrossPair {
  trigger: PairEvent;                               // The later event: the pair exists once both signals are known
  partner: PairEvent;                               // The earlier one, on another symbol and in the opposite direction
}

function byTimeThenId(a: PairEvent, b: PairEvent): number {
  return a.eventTime - b.eventTime || a.id - b.id;
}

// Pairs events on different symbols that were liquidated in opposite directions within windowSec (inclusive). Events
// are walked oldest first and an event joins the most recent unpaired earlier event that fits (ties: the later row),
// so a pair is formed by its later event, only when both signals are known, and an event is in at most one pair.
export function matchCrossPairs(events: readonly PairEvent[], windowSec: number): CrossPair[] {
  const windowMs = windowSec * 1000;
  const pairs: CrossPair[] = [];
  const open: PairEvent[] = [];                     // Unpaired earlier events, oldest first
  let first = 0;
  for (const event of [...events].sort(byTimeThenId)) {
    while (first < open.length && event.eventTime - open[first].eventTime > windowMs) first++;
    let match = -1;
    for (let i = open.length - 1; i >= first; i--) {
      if (open[i].symbol !== event.symbol && open[i].direction !== event.direction) {
        match = i;
        break;
      }
    }
    if (match >= 0) {
      pairs.push({ trigger: event, partner: open[match] });
      open.splice(match, 1);
    } else {
      open.push(event);
    }
  }
  return pairs;
}

// Events that have at least one event on another symbol in the opposite direction within +-windowSec, whether or not
// the one-to-one matching used it
export function countEventsWithPartner(events: readonly PairEvent[], windowSec: number): number {
  const windowMs = windowSec * 1000;
  const sorted = [...events].sort(byTimeThenId);
  const withPartner = new Set<number>();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i - 1; j >= 0 && sorted[i].eventTime - sorted[j].eventTime <= windowMs; j--) {
      if (sorted[j].symbol !== sorted[i].symbol && sorted[j].direction !== sorted[i].direction) {
        withPartner.add(sorted[i].id);
        withPartner.add(sorted[j].id);
      }
    }
  }
  return withPartner.size;
}

// ===== Statistics =====

export function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Sample standard deviation; null for fewer than two values
export function stdev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

export function median(values: readonly number[]): number | null {
  return percentile(values, 50);
}

// Linear interpolation between the closest ranks (the usual "type 7" percentile); null for no values
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

// t statistic of a mean; null without two values or a spread
export function tStatistic(meanValue: number, sd: number | null, n: number): number | null {
  return sd !== null && sd > 0 && n >= 2 ? meanValue / (sd / Math.sqrt(n)) : null;
}

// Largest peak-to-trough fall of the cumulative sum of the returns, in the order given (sequential, equal weight:
// every event is one unit, positions are not compounded or overlapped). The curve starts at 0, so a loss before the
// first gain counts. Returned as a non-negative number.
export function maxDrawdown(returns: readonly number[]): number {
  let cumulative = 0;
  let peak = 0;
  let worst = 0;
  for (const value of returns) {
    cumulative += value;
    if (cumulative > peak) peak = cumulative;
    if (peak - cumulative > worst) worst = peak - cumulative;
  }
  return worst;
}

export interface Metrics {
  n: number;
  meanBps: number | null;
  medianBps: number | null;
  stdevBps: number | null;
  winRate: number | null;                           // Share of trades with a positive net return
  tStat: number | null;                             // t statistic of the mean (null when there is no spread)
  sharpe: number | null;                            // mean / stdev per trade, not annualised
  p5Bps: number | null;                             // 5th percentile of the net return (the tail)
  maxDrawdownBps: number | null;                    // Cumulative, sequential, equal-weight event P&L
  meanExposure: number | null;                      // Gross notional per unit of primary notional
  meanPerExposureBps: number | null;                // meanBps / meanExposure
}

const EMPTY_METRICS: Metrics = {
  n: 0, meanBps: null, medianBps: null, stdevBps: null, winRate: null, tStat: null, sharpe: null, p5Bps: null,
  maxDrawdownBps: null, meanExposure: null, meanPerExposureBps: null,
};

// Metrics of trades in the order they were entered
export function summarizeTrades(trades: ReadonlyArray<{ netBps: number; exposure: number }>): Metrics {
  if (trades.length === 0) return { ...EMPTY_METRICS };
  const returns = trades.map(trade => trade.netBps);
  const meanBps = mean(returns);
  const sd = stdev(returns);
  const meanExposure = mean(trades.map(trade => trade.exposure));
  return {
    n: trades.length,
    meanBps,
    medianBps: median(returns),
    stdevBps: sd,
    winRate: returns.filter(value => value > 0).length / returns.length,
    tStat: tStatistic(meanBps, sd, returns.length),
    sharpe: sd !== null && sd > 0 ? meanBps / sd : null,
    p5Bps: percentile(returns, 5),
    maxDrawdownBps: maxDrawdown(returns),
    meanExposure,
    meanPerExposureBps: meanExposure > 0 ? meanBps / meanExposure : null,
  };
}

export interface DeltaStats {
  n: number;
  meanBps: number | null;
  stdevBps: number | null;
  tStat: number | null;                             // Paired t statistic of the mean difference
  winRate: number | null;                           // Share of events where the strategy beat the single leg
}

export function summarizeDeltas(deltas: readonly number[]): DeltaStats {
  if (deltas.length === 0) return { n: 0, meanBps: null, stdevBps: null, tStat: null, winRate: null };
  const meanBps = mean(deltas);
  const sd = stdev(deltas);
  return {
    n: deltas.length,
    meanBps,
    stdevBps: sd,
    tStat: tStatistic(meanBps, sd, deltas.length),
    winRate: deltas.filter(value => value > 0).length / deltas.length,
  };
}

// ===== Analysis =====

export type HedgeSizing = 'beta' | 'dollar';
export type ExitFill = 'exact' | 'carry';

export interface PairAnalysisOptions {
  horizonsMin: readonly number[];
  hedgeSymbol: string;
  extraHedges: readonly string[];
  hedgeSizing: HedgeSizing;                         // beta: sized by the estimated beta. dollar: 1:1 notional.
  betaLookbackMin: number;
  betaMinObservations: number;
  pairWindowSec: number;
  feeBps: number;                                   // Per leg and side
  slippageBps: number;                              // Per leg and side
  exitFill: ExitFill;                               // exact: a missing exit candle excludes the event. carry: see exitCarryMaxMin.
  exitCarryMaxMin: number;                          // carry: how far back from the exit minute the last close may be
  exitDeadline?: number;                            // Trades whose exit candle closes after this (ms) are excluded
  now: number;                                      // Exits that close at or after this are not yet known
  keepTrades?: boolean;                             // Put every trade in the result
}

export type ExclusionReason =
  | 'horizon-not-elapsed'                           // The exit candle closes at or after `now`
  | 'exit-after-until'                              // ... after exitDeadline (--until-exits)
  | 'entry-candle-missing'                          // The liquidated symbol has no candle at the entry
  | 'exit-candle-missing'                           // ... or at the exit
  | 'hedge-is-event-symbol'                         // A hedge on itself
  | 'hedge-candle-missing'                          // The hedge symbol has no candle at the entry or the exit
  | 'partner-candle-missing';                       // Same, for the other symbol of a cross pair

export interface TradeRecord {
  eventId: number;
  symbol: string;
  partner?: string;                                 // Cross pair: the other symbol
  partnerEventId?: number;                          // ... and its event
  hedge?: string;
  direction: TradeDirection;
  eventTime: number;
  entryCloseTime: number;                           // After eventTime, by at most a minute
  exitCloseTime: number;
  beta?: number;
  grossBps: number;
  costBps: number;
  netBps: number;
  exposure: number;
  carriedLegs?: number;                             // Legs whose exit candle was missing and took the last close (exitFill carry)
}

export interface StrategyInfo {
  id: string;                                       // single | hedged:<SYMBOL> | cross-pair
  label: string;                                    // single | btc-hedged | cross-pair
  description: string;
}

export interface StrategyHorizonResult {
  strategy: string;
  horizonMin: number;
  metrics: Metrics;
  excluded: Partial<Record<ExclusionReason, number>>;
  excludedTotal: number;
  carried: number;                                  // Trades with a carried-forward exit (always 0 with exitFill exact)
  bySymbol: Record<string, Metrics>;                // By the liquidated (cross pair: the triggering) symbol
  trades?: TradeRecord[];
}

// What a strategy is compared with, event by event
//   single        the single leg of the same (for a cross pair: the triggering) event
//   both-singles  cross pair only: the single legs of the trigger and of its partner, each entered at its own signal
export type DeltaBaseline = 'single' | 'both-singles';

export interface DeltaResult {
  strategy: string;                                 // The strategy compared
  baseline: DeltaBaseline;
  horizonMin: number;
  stats: DeltaStats;                                // Over the events both have a result for
  bySymbol: Record<string, DeltaStats>;
}

// The events the single leg lost at a horizon to a missing exit candle (they have an entry candle), and what the
// single leg did for them at the horizons where they do have candles. Their absence biases the table above it when
// the missing minute says something about the move (a quiet minute, a halted market).
export interface ExitGapBias {
  events: number;
  elsewhere: Array<{
    horizonMin: number;
    n: number;                                      // Of those events, the ones with a single-leg result at this horizon
    meanBps: number | null;                         // Their mean net return
    allMeanBps: number | null;                      // The mean net return of every event with a result at this horizon
  }>;
}

export interface HedgeDiagnostics {
  symbol: string;
  sizing: HedgeSizing;
  events: number;                                   // Events with a beta estimate (the event symbol is not the hedge)
  betaFallbacks: number;                            // Too little data or a flat hedge: beta 1 was used
  betaFallbackReasons: Record<BetaFallbackReason, number>;   // Events per reason (an event can have two)
  shortAssets: Record<string, number>;              // Liquidated symbol -> its events whose beta fell back for want of its own history
  betaClamped: number;
  meanBeta: number | null;
  medianBeta: number | null;
}

export interface HorizonResult {
  horizonMin: number;
  strategies: StrategyHorizonResult[];
  deltas: DeltaResult[];
  exitGapBias: ExitGapBias;
}

export interface PairAnalysisResult {
  options: Omit<PairAnalysisOptions, 'keepTrades'>;
  events: {
    total: number;
    long: number;                                   // Long liquidations (forced SELL): the bot buys
    short: number;
    backfilled: number;
    bySymbol: Record<string, number>;
    firstEventTime: number | null;
    lastEventTime: number | null;
    withPartner: number;                            // Events with an opposite-direction event on another symbol within the window
    pairs: number;                                  // Cross pairs formed (one-to-one, the later event triggers)
  };
  strategies: StrategyInfo[];
  horizons: HorizonResult[];
  hedges: HedgeDiagnostics[];
  gapSymbols: Record<string, number>;               // Symbol -> events that lacked one of its candles (not counting horizons not yet elapsed)
}

export function hedgeLabel(symbol: string, sizing: HedgeSizing = 'beta'): string {
  const base = symbol.replace(/USDT$/, '').toLowerCase();
  return `${base}-hedged${sizing === 'dollar' ? '-1:1' : ''}`;
}

export function hedgeStrategyId(symbol: string): string {
  return `hedged:${symbol}`;
}

export const SINGLE_STRATEGY_ID = 'single';
export const CROSS_PAIR_STRATEGY_ID = 'cross-pair';

interface Accumulator {
  trades: TradeRecord[];
  excluded: Map<ExclusionReason, number>;
}

interface BetaAccumulator {
  events: number;
  fallbacks: number;
  clamped: number;
  betas: number[];
  reasons: Record<BetaFallbackReason, number>;
  shortAssets: Map<string, number>;
}

export function analyzePairs(
  events: readonly PairEvent[],
  series: ReadonlyMap<string, CandleSeries>,
  options: PairAnalysisOptions
): PairAnalysisResult {
  const sortedEvents = [...events].sort(byTimeThenId);
  const hedgeSymbols = [...new Set([options.hedgeSymbol, ...options.extraHedges])];
  const costPerLeg = 2 * (options.feeBps + options.slippageBps);     // Round trip, bps of that leg's notional
  const horizons = [...new Set(options.horizonsMin)].sort((a, b) => a - b);
  const carryMaxMin = options.exitFill === 'carry' ? options.exitCarryMaxMin : 0;

  const strategies: StrategyInfo[] = [
    { id: SINGLE_STRATEGY_ID, label: 'single', description: 'Contrarian trade on the liquidated symbol' },
    ...hedgeSymbols.map(symbol => ({
      id: hedgeStrategyId(symbol),
      label: hedgeLabel(symbol, options.hedgeSizing),
      description: options.hedgeSizing === 'dollar'
        ? `Single leg plus an opposite ${symbol} leg of equal notional`
        : `Single leg plus an opposite ${symbol} leg sized by beta (${options.betaLookbackMin} min of 1m returns, clamped to [${BETA_MIN}, ${BETA_MAX}])`,
    })),
    { id: CROSS_PAIR_STRATEGY_ID, label: 'cross-pair', description: 'Long the symbol with the long-liquidation signal, short the one with the short-liquidation signal, equal notional' },
  ];

  const accumulators = new Map<string, Accumulator>();
  const accumulator = (strategy: string, horizon: number): Accumulator => {
    const key = `${strategy}|${horizon}`;
    let found = accumulators.get(key);
    if (!found) {
      found = { trades: [], excluded: new Map() };
      accumulators.set(key, found);
    }
    return found;
  };
  const exclude = (strategy: string, horizon: number, reason: ExclusionReason): void => {
    const excluded = accumulator(strategy, horizon).excluded;
    excluded.set(reason, (excluded.get(reason) ?? 0) + 1);
  };

  const gapEvents = new Map<string, Set<number>>();
  const noteGap = (symbol: string, eventId: number): void => {
    let ids = gapEvents.get(symbol);
    if (!ids) {
      ids = new Set();
      gapEvents.set(symbol, ids);
    }
    ids.add(eventId);
  };
  const exitGapEvents = new Map<number, Set<number>>();            // Horizon -> events whose own exit candle is missing

  const pairs = matchCrossPairs(sortedEvents, options.pairWindowSec);
  const partnerOf = new Map(pairs.map(pair => [pair.trigger.id, pair.partner]));

  const betaDiagnostics = new Map<string, BetaAccumulator>(hedgeSymbols.map(symbol => [symbol, {
    events: 0, fallbacks: 0, clamped: 0, betas: [], reasons: { 'asset-short': 0, 'hedge-short': 0, 'hedge-flat': 0 }, shortAssets: new Map(),
  }]));

  for (const event of sortedEvents) {
    const entryOpen = entryOpenTime(event.eventTime);
    const entryCloseTime = entryOpen + MINUTE_MS;
    const asset = series.get(event.symbol);

    // Beta does not depend on the horizon
    const betas = new Map<string, BetaEstimate>();
    for (const hedge of hedgeSymbols) {
      if (hedge === event.symbol) continue;
      const estimate: BetaEstimate = options.hedgeSizing === 'dollar'
        ? { beta: 1, raw: 1, observations: 0, assetReturns: 0, hedgeReturns: 0, fallback: false, fallbackReasons: [], clamped: false }
        : estimateBeta(asset, series.get(hedge), entryOpen, options.betaLookbackMin, options.betaMinObservations);
      betas.set(hedge, estimate);
      const diagnostics = betaDiagnostics.get(hedge)!;
      diagnostics.events++;
      if (estimate.fallback) diagnostics.fallbacks++;
      for (const reason of estimate.fallbackReasons) diagnostics.reasons[reason]++;
      if (estimate.fallbackReasons.includes('asset-short')) diagnostics.shortAssets.set(event.symbol, (diagnostics.shortAssets.get(event.symbol) ?? 0) + 1);
      if (estimate.clamped) diagnostics.clamped++;
      diagnostics.betas.push(estimate.beta);
    }
    const partner = partnerOf.get(event.id);

    for (const horizon of horizons) {
      const exitOpen = entryOpen + horizon * MINUTE_MS;
      const exitCloseTime = exitOpen + MINUTE_MS;
      let primaryReason: ExclusionReason | null = null;      // Why the liquidated symbol's own leg has no return
      let primaryReturn = 0;
      let primaryCarried = 0;
      if (exitCloseTime >= options.now) {
        primaryReason = 'horizon-not-elapsed';               // The candle cannot exist yet, or not be stored
      } else if (options.exitDeadline !== undefined && exitCloseTime > options.exitDeadline) {
        primaryReason = 'exit-after-until';
      } else {
        const leg = legReturn(asset, entryOpen, exitOpen, carryMaxMin);
        if (leg.ok) {
          primaryReturn = leg.ret;
          primaryCarried = leg.carried ? 1 : 0;
        } else {
          primaryReason = leg.missing === 'entry' ? 'entry-candle-missing' : 'exit-candle-missing';
        }
      }
      if (primaryReason === 'entry-candle-missing' || primaryReason === 'exit-candle-missing') noteGap(event.symbol, event.id);
      if (primaryReason === 'exit-candle-missing') {
        const ids = exitGapEvents.get(horizon) ?? new Set<number>();
        ids.add(event.id);
        exitGapEvents.set(horizon, ids);
      }

      const record = (strategy: string, legs: number, extra: Partial<TradeRecord>, gross: number, exposure: number, carriedLegs: number): void => {
        const costBps = costPerLeg * legs;
        const grossBps = gross * BPS;
        accumulator(strategy, horizon).trades.push({
          eventId: event.id,
          symbol: event.symbol,
          direction: event.direction,
          eventTime: event.eventTime,
          entryCloseTime,
          exitCloseTime,
          grossBps,
          costBps,
          netBps: grossBps - costBps,
          exposure,
          ...(carriedLegs > 0 ? { carriedLegs } : {}),
          ...extra,
        });
      };

      // single
      if (primaryReason !== null) {
        exclude(SINGLE_STRATEGY_ID, horizon, primaryReason);
      } else {
        record(SINGLE_STRATEGY_ID, 1, {}, event.direction * primaryReturn, 1, primaryCarried);
      }

      // hedged: the same leg plus an opposite hedge leg of beta times its notional
      for (const hedge of hedgeSymbols) {
        const id = hedgeStrategyId(hedge);
        if (hedge === event.symbol) {
          exclude(id, horizon, 'hedge-is-event-symbol');
        } else if (primaryReason !== null) {
          exclude(id, horizon, primaryReason);
        } else {
          const hedgeLeg = legReturn(series.get(hedge), entryOpen, exitOpen, carryMaxMin);
          if (!hedgeLeg.ok) {
            exclude(id, horizon, 'hedge-candle-missing');
            noteGap(hedge, event.id);
          } else {
            const beta = betas.get(hedge)!.beta;
            record(id, 1 + beta, { hedge, beta }, event.direction * (primaryReturn - beta * hedgeLeg.ret), 1 + beta, primaryCarried + (hedgeLeg.carried ? 1 : 0));
          }
        }
      }

      // cross-pair: this event's contrarian leg and the partner's, which points the other way. Both legs are entered at
      // this event's entry candle (the later signal): the partner's leg is entered late, and that is what it is
      // compared with, in the deltas below, against the partner's own single leg.
      if (partner) {
        if (primaryReason !== null) {
          exclude(CROSS_PAIR_STRATEGY_ID, horizon, primaryReason);
        } else {
          const partnerLeg = legReturn(series.get(partner.symbol), entryOpen, exitOpen, carryMaxMin);
          if (!partnerLeg.ok) {
            exclude(CROSS_PAIR_STRATEGY_ID, horizon, 'partner-candle-missing');
            noteGap(partner.symbol, event.id);
          } else {
            record(
              CROSS_PAIR_STRATEGY_ID, 2, { partner: partner.symbol, partnerEventId: partner.id },
              event.direction * primaryReturn + partner.direction * partnerLeg.ret, 2, primaryCarried + (partnerLeg.carried ? 1 : 0)
            );
          }
        }
      }
    }
  }

  const horizonResults: HorizonResult[] = horizons.map(horizon => {
    const results: StrategyHorizonResult[] = strategies.map(strategy => {
      const found = accumulators.get(`${strategy.id}|${horizon}`) ?? { trades: [], excluded: new Map() };
      const bySymbol: Record<string, Metrics> = {};
      for (const symbol of [...new Set(found.trades.map(trade => trade.symbol))].sort()) {
        bySymbol[symbol] = summarizeTrades(found.trades.filter(trade => trade.symbol === symbol));
      }
      const excluded: Partial<Record<ExclusionReason, number>> = Object.fromEntries(found.excluded);
      const result: StrategyHorizonResult = {
        strategy: strategy.id,
        horizonMin: horizon,
        metrics: summarizeTrades(found.trades),
        excluded,
        excludedTotal: [...found.excluded.values()].reduce((sum, count) => sum + count, 0),
        carried: found.trades.filter(trade => (trade.carriedLegs ?? 0) > 0).length,
        bySymbol,
      };
      if (options.keepTrades) result.trades = found.trades;
      return result;
    });

    // Each strategy minus a baseline, on the events both have a result for. The baseline of a hedged trade is the single
    // leg of its event. A cross pair has two: the trigger's single leg, and the single legs of the trigger and of its
    // partner together (each at its own entry candle and horizon, as a bot that trades every symbol single-leg holds
    // them). Both have the pair's exposure, and the costs of two legs, so the costs cancel in the second.
    const singleByEvent = new Map((accumulators.get(`${SINGLE_STRATEGY_ID}|${horizon}`)?.trades ?? []).map(trade => [trade.eventId, trade.netBps]));
    const delta = (strategyId: string, baseline: DeltaBaseline, baselineOf: (trade: TradeRecord) => number | undefined): DeltaResult => {
      const all: number[] = [];
      const bySymbolDeltas = new Map<string, number[]>();
      for (const trade of accumulators.get(`${strategyId}|${horizon}`)?.trades ?? []) {
        const base = baselineOf(trade);
        if (base === undefined) continue;
        const difference = trade.netBps - base;
        all.push(difference);
        const list = bySymbolDeltas.get(trade.symbol) ?? [];
        list.push(difference);
        bySymbolDeltas.set(trade.symbol, list);
      }
      const bySymbol: Record<string, DeltaStats> = {};
      for (const symbol of [...bySymbolDeltas.keys()].sort()) bySymbol[symbol] = summarizeDeltas(bySymbolDeltas.get(symbol)!);
      return { strategy: strategyId, baseline, horizonMin: horizon, stats: summarizeDeltas(all), bySymbol };
    };
    const deltas: DeltaResult[] = [];
    for (const strategy of strategies) {
      if (strategy.id === SINGLE_STRATEGY_ID) continue;
      deltas.push(delta(strategy.id, 'single', trade => singleByEvent.get(trade.eventId)));
      if (strategy.id === CROSS_PAIR_STRATEGY_ID) {
        deltas.push(delta(strategy.id, 'both-singles', trade => {
          const trigger = singleByEvent.get(trade.eventId);
          const partner = trade.partnerEventId === undefined ? undefined : singleByEvent.get(trade.partnerEventId);
          return trigger === undefined || partner === undefined ? undefined : trigger + partner;
        }));
      }
    }

    // What the single leg did, at the other horizons, for the events that have no exit candle at this one
    const gapIds = exitGapEvents.get(horizon) ?? new Set<number>();
    const elsewhere: ExitGapBias['elsewhere'] = [];
    for (const other of horizons) {
      if (other === horizon) continue;
      const singles = accumulators.get(`${SINGLE_STRATEGY_ID}|${other}`)?.trades ?? [];
      const lost = singles.filter(trade => gapIds.has(trade.eventId)).map(trade => trade.netBps);
      if (lost.length === 0) continue;
      elsewhere.push({ horizonMin: other, n: lost.length, meanBps: mean(lost), allMeanBps: singles.length > 0 ? mean(singles.map(trade => trade.netBps)) : null });
    }
    return { horizonMin: horizon, strategies: results, deltas, exitGapBias: { events: gapIds.size, elsewhere } };
  });

  const bySymbol: Record<string, number> = {};
  for (const event of sortedEvents) bySymbol[event.symbol] = (bySymbol[event.symbol] ?? 0) + 1;

  const { keepTrades: _keepTrades, ...echoed } = options;
  return {
    options: { ...echoed, horizonsMin: horizons },
    events: {
      total: sortedEvents.length,
      long: sortedEvents.filter(event => event.direction === 1).length,
      short: sortedEvents.filter(event => event.direction === -1).length,
      backfilled: sortedEvents.filter(event => event.backfilled).length,
      bySymbol,
      firstEventTime: sortedEvents.length > 0 ? sortedEvents[0].eventTime : null,
      lastEventTime: sortedEvents.length > 0 ? sortedEvents[sortedEvents.length - 1].eventTime : null,
      withPartner: countEventsWithPartner(sortedEvents, options.pairWindowSec),
      pairs: pairs.length,
    },
    strategies,
    horizons: horizonResults,
    hedges: hedgeSymbols.map(symbol => {
      const diagnostics = betaDiagnostics.get(symbol)!;
      return {
        symbol,
        sizing: options.hedgeSizing,
        events: diagnostics.events,
        betaFallbacks: diagnostics.fallbacks,
        betaFallbackReasons: diagnostics.reasons,
        shortAssets: Object.fromEntries([...diagnostics.shortAssets.entries()].sort(([a], [b]) => a.localeCompare(b))),
        betaClamped: diagnostics.clamped,
        meanBeta: diagnostics.betas.length > 0 ? mean(diagnostics.betas) : null,
        medianBeta: median(diagnostics.betas),
      };
    }),
    gapSymbols: Object.fromEntries([...gapEvents.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([symbol, ids]) => [symbol, ids.size])),
  };
}
