/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import BetterSqlite from 'better-sqlite3';
import {
  CROSS_PAIR_STRATEGY_ID,
  MINUTE_MS,
  SINGLE_STRATEGY_ID,
  analyzePairs,
  hedgeStrategyId,
  selectEvents,
  type DeltaBaseline,
  type DeltaResult,
  type PairAnalysisOptions,
  type PairAnalysisResult,
  type StrategyHorizonResult,
} from '../../../src/lib/analysis/pairAnalysis';
import { loadPairAnalysisInput, type PairAnalysisQuery } from '../../../src/lib/analysis/pairAnalysisDb';
import {
  PAIR_ANALYSIS_CAVEAT,
  formatPairAnalysisReport,
  lighterCandleFetchCommand,
  missingCandleAdvice,
  pairAnalysisJson,
  type PairAnalysisReportContext,
} from '../../../src/lib/analysis/pairAnalysisReport';
import { lighterBackfillRetentionProblem, parseLighterBackfillArgs } from '../../../src/lib/lighterHistory/args';
import { HISTORY_TEST_TIMEOUT_MS, removeTmpDir } from '../history/tmp';
import { DAY, MINUTE, NOW, T0, at, flatPath, marketReturns, pathFromReturns, writeSyntheticDb, type SyntheticSpec } from './synthetic';

jest.setTimeout(HISTORY_TEST_TIMEOUT_MS);

const BTC = 'BTCUSDT';
const ETH = 'ETHUSDT';
const ALT = 'ALTUSDT';
const AAA = 'AAAUSDT';
const BBB = 'BBBUSDT';

let tmpDir: string;
let databases = 0;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-analysis-'));
});

afterEach(() => {
  removeTmpDir(tmpDir);
});

const baseOptions: PairAnalysisOptions = {
  horizonsMin: [15],
  hedgeSymbol: BTC,
  extraHedges: [],
  hedgeSizing: 'beta',
  betaLookbackMin: 240,
  betaMinObservations: 30,
  pairWindowSec: 120,
  feeBps: 0,
  slippageBps: 0,
  exitFill: 'exact',
  exitCarryMaxMin: 5,
  now: NOW,
  keepTrades: true,
};

interface Run {
  file: string;
  result: PairAnalysisResult;
  selection: ReturnType<typeof selectEvents>;
  input: ReturnType<typeof loadPairAnalysisInput>;
  context: PairAnalysisReportContext;
}

// The whole path the CLI takes: temp database -> read -> events -> analysis
async function run(
  spec: SyntheticSpec,
  over: { options?: Partial<PairAnalysisOptions>; query?: Partial<PairAnalysisQuery>; minUsd?: number; dedupeSec?: number; burstSum?: boolean; symbolRowLimit?: number } = {}
): Promise<Run> {
  const file = path.join(tmpDir, `liquidations-${++databases}.db`);       // A fresh file per run: rows are keyed by liquidation id
  await writeSyntheticDb(file, spec);
  const options = { ...baseOptions, ...over.options };
  const input = loadPairAnalysisInput(file, {
    venue: 'lighter',
    candleVenue: 'lighter',
    includeSkipped: false,
    hedgeSymbols: [options.hedgeSymbol, ...options.extraHedges],
    betaLookbackMin: options.betaLookbackMin,
    maxHorizonMin: Math.max(...options.horizonsMin),
    ...over.query,
  });
  const minUsd = over.minUsd ?? 0;
  const dedupeSec = over.dedupeSec ?? 60;
  const burstSum = over.burstSum ?? false;
  const selection = selectEvents(input.rows, { minUsd, dedupeSec, burstSum });
  const result = analyzePairs(selection.events, input.series, options);
  const context: PairAnalysisReportContext = {
    dbPath: file, venue: 'lighter', candleVenue: 'lighter', includeSkipped: false, minUsd, burstSum, dedupeSec, selection,
    candlesLoaded: input.candlesLoaded, notes: input.notes, now: options.now, symbolRowLimit: over.symbolRowLimit,
  };
  return { file, result, selection, input, context };
}

function cell(result: PairAnalysisResult, strategy: string, horizon: number): StrategyHorizonResult {
  const found = result.horizons.find(item => item.horizonMin === horizon)?.strategies.find(item => item.strategy === strategy);
  if (!found) throw new Error(`no ${strategy} result at ${horizon} min`);
  return found;
}

function onlyTrade(result: PairAnalysisResult, strategy: string, horizon: number) {
  const trades = cell(result, strategy, horizon).trades ?? [];
  expect(trades).toHaveLength(1);
  return trades[0];
}

function delta(result: PairAnalysisResult, strategy: string, baseline: DeltaBaseline, horizon = 15): DeltaResult {
  const found = result.horizons.find(item => item.horizonMin === horizon)?.deltas.find(item => item.strategy === strategy && item.baseline === baseline);
  if (!found) throw new Error(`no ${strategy} minus ${baseline} delta at ${horizon} min`);
  return found;
}

// One event on ALT, with BTC and ALT built from the same 1m returns so that ALT has a beta of exactly `beta` to BTC.
// Candle 260 is the entry candle; the 15-minute exit is candle 275 (candles in between keep the entry price).
function marketSpec(options: { side: 'BUY' | 'SELL'; btcMove: number; altMove: number; beta?: number; withBtc?: boolean }): SyntheticSpec {
  const returns = marketReturns(260);
  const btc = pathFromReturns(returns, 20_000, 1);
  const alt = pathFromReturns(returns, 50, options.beta ?? 2);
  const extend = (points: Array<[number, number]>, move: number): Array<[number, number]> => {
    const entry = points[points.length - 1][1];
    const out = [...points];
    for (let i = 261; i <= 275; i++) out.push([at(i), i === 275 ? entry * (1 + move) : entry]);
    return out;
  };
  return {
    liquidations: [{ symbol: ALT, side: options.side, eventTime: at(260) + 30_000 }],
    candles: { [ALT]: extend(alt, options.altMove), ...(options.withBtc === false ? {} : { [BTC]: extend(btc, options.btcMove) }) },
  };
}

describe('single leg', () => {
  // AAA: a long liquidation (forced SELL) at 10:30, bought at the close of minute 10. BBB: a short liquidation
  // (forced BUY), sold at the close of minute 200. Both then move +2%, +4% and -10% at 5, 15 and 60 minutes.
  const spec = (): SyntheticSpec => ({
    liquidations: [
      { symbol: AAA, side: 'SELL', eventTime: at(10) + 30_000 },
      { symbol: BBB, side: 'BUY', eventTime: at(200) + 30_000 },
    ],
    candles: {
      [AAA]: flatPath(0, 100, 100, { 15: 102, 25: 104, 70: 90 }),
      [BBB]: flatPath(190, 100, 100, { 205: 102, 215: 104, 260: 90 }),
    },
  });

  it('buys after a long liquidation and sells after a short one', async () => {
    const { result } = await run(spec(), { options: { horizonsMin: [5, 15, 60] } });
    const aaa = (horizon: number) => cell(result, SINGLE_STRATEGY_ID, horizon).bySymbol[AAA].meanBps;
    const bbb = (horizon: number) => cell(result, SINGLE_STRATEGY_ID, horizon).bySymbol[BBB].meanBps;
    expect([aaa(5), aaa(15), aaa(60)].map(value => Math.round(value!))).toEqual([200, 400, -1000]);
    expect([bbb(5), bbb(15), bbb(60)].map(value => Math.round(value!))).toEqual([-200, -400, 1000]);
    expect(cell(result, SINGLE_STRATEGY_ID, 5).metrics.n).toBe(2);
    expect(cell(result, SINGLE_STRATEGY_ID, 5).metrics.meanBps).toBeCloseTo(0, 6);
    expect(result.events).toMatchObject({ total: 2, long: 1, short: 1 });
  });

  it('records the direction and the (zero) costs of the trade', async () => {
    const { result } = await run(spec(), { options: { horizonsMin: [5] } });
    const trades = cell(result, SINGLE_STRATEGY_ID, 5).trades!;
    expect(trades.map(trade => [trade.symbol, trade.direction, trade.exposure])).toEqual([[AAA, 1, 1], [BBB, -1, 1]]);
    expect(trades.every(trade => trade.costBps === 0 && trade.netBps === trade.grossBps)).toBe(true);
  });
});

describe('scope of the events', () => {
  const rowsSpec = (): SyntheticSpec => ({
    liquidations: [
      { symbol: AAA, side: 'SELL', eventTime: at(10) },
      { symbol: AAA, side: 'SELL', eventTime: at(20), skipReason: 'shadow mode' },
      { symbol: AAA, side: 'SELL', eventTime: at(30), skipReason: 'stale: 12000 ms old (limit 10000 ms)' },
      { symbol: BBB, side: 'BUY', eventTime: at(40), source: 'backfill' },
      { symbol: AAA, side: 'SELL', eventTime: at(50), venue: 'aster' },
    ],
  });
  const query = { hedgeSymbols: [BTC], betaLookbackMin: 240, maxHorizonMin: 60, candleVenue: 'lighter' };

  it('reads the rows the Lighter optimizer reads: skip_reason empty or shadow mode, one venue', async () => {
    const file = path.join(tmpDir, 'scope.db');
    await writeSyntheticDb(file, rowsSpec());
    const lighter = loadPairAnalysisInput(file, { ...query, venue: 'lighter', includeSkipped: false });
    expect(lighter.rows.map(row => row.eventTime)).toEqual([at(10), at(20), at(40)]);
    expect(lighter.rows.map(row => row.backfilled)).toEqual([false, false, true]);
    expect(loadPairAnalysisInput(file, { ...query, venue: 'lighter', includeSkipped: true }).rows).toHaveLength(4);
    expect(loadPairAnalysisInput(file, { ...query, venue: 'aster', includeSkipped: false }).rows.map(row => row.eventTime)).toEqual([at(50)]);
    expect(loadPairAnalysisInput(file, { ...query, venue: 'lighter', includeSkipped: false, symbols: [BBB] }).rows).toHaveLength(1);
  });

  it('limits the events to a window of event time: from inclusive, until exclusive', async () => {
    const file = path.join(tmpDir, 'window.db');
    await writeSyntheticDb(file, rowsSpec());
    const read = (sinceMs?: number, untilMs?: number) =>
      loadPairAnalysisInput(file, { ...query, venue: 'lighter', includeSkipped: true, sinceMs, untilMs }).rows.map(row => row.eventTime);
    expect(read(at(20), at(40))).toEqual([at(20), at(30)]);
    expect(read(at(20))).toEqual([at(20), at(30), at(40)]);
    expect(read(undefined, at(20))).toEqual([at(10)]);
    expect(read(at(41), at(60))).toEqual([]);
  });

  it('applies the minimum size and carries the backfill flag into the events', async () => {
    const { selection } = await run(
      { liquidations: [{ symbol: AAA, side: 'SELL', eventTime: at(10), volumeUsdt: 500 }, { symbol: BBB, side: 'BUY', eventTime: at(40), volumeUsdt: 5_000, source: 'backfill' }] },
      { minUsd: 1000 }
    );
    expect(selection.events.map(event => [event.symbol, event.backfilled])).toEqual([[BBB, true]]);
    expect(selection.belowMinUsd).toBe(1);
  });

  it('applies the minimum size to each row, or with burstSum to the total of the burst', async () => {
    // Three 3000 USD liquidations of AAA within 40 s: no row reaches 5000, the burst does at its second row
    const burst: SyntheticSpec = { liquidations: [0, 20, 40].map(seconds => ({ symbol: AAA, side: 'SELL' as const, eventTime: at(10) + seconds * 1000, volumeUsdt: 3000 })) };
    const perRow = await run(burst, { minUsd: 5000 });
    expect(perRow.selection.events).toHaveLength(0);
    expect(perRow.selection.belowMinUsd).toBe(3);
    const summed = await run(burst, { minUsd: 5000, burstSum: true });
    expect(summed.selection.events.map(event => [event.eventTime - at(10), event.volumeUsdt])).toEqual([[20_000, 6000]]);
    expect(summed.selection).toMatchObject({ collapsed: 2, belowMinUsd: 0, rows: 3 });
    const text = formatPairAnalysisReport(summed.result, summed.context);
    expect(text).toContain('min size 5000 USD per burst (rows of a symbol and side within 60s added up)');
    expect(text).toContain('2 collapsed within 60s');
    expect(formatPairAnalysisReport(perRow.result, perRow.context)).toContain('min size 5000 USD per row');
    expect(JSON.parse(JSON.stringify(pairAnalysisJson(summed.result, summed.context, NOW))).scope).toMatchObject({ minUsd: 5000, burstSum: true });
  });

  it('enters a burst-sum event at the row that completes the total, not at the first row', async () => {
    // Two 3000 USD rows, at 10:50 and 11:10, together 6000. The bot acts when the second arrives, so the entry is the
    // close of candle 11 (110), not of candle 10 (100), where the first row was and before the total was known.
    const rows: SyntheticSpec = {
      liquidations: [50, 70].map(seconds => ({ symbol: AAA, side: 'SELL' as const, eventTime: at(10) + seconds * 1000, volumeUsdt: 3000 })),
      candles: { [AAA]: flatPath(0, 40, 100, { 11: 110, 16: 132 }), [BTC]: flatPath(0, 40, 20_000) },
    };
    const { result } = await run(rows, { minUsd: 5000, burstSum: true, options: { horizonsMin: [5] } });
    const trade = onlyTrade(result, SINGLE_STRATEGY_ID, 5);
    expect(trade.eventTime).toBe(at(11) + 10_000);
    expect(trade.entryCloseTime).toBe(at(12));
    expect(trade.grossBps).toBeCloseTo((132 / 110 - 1) * 1e4, 6);       // 20%, not the 32% of entering at the first row
  });

  it('reads an old database that has no venue columns as Aster rows only, and a missing file as an error', async () => {
    const file = path.join(tmpDir, 'old.db');
    const old = new BetterSqlite(file);
    old.exec(`CREATE TABLE liquidations (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, side TEXT NOT NULL, volume_usdt REAL NOT NULL, event_time INTEGER NOT NULL)`);
    old.prepare('INSERT INTO liquidations (symbol, side, volume_usdt, event_time) VALUES (?, ?, ?, ?)').run(AAA, 'SELL', 1000, at(10));
    old.close();
    const aster = loadPairAnalysisInput(file, { ...query, venue: 'aster', includeSkipped: false });
    expect(aster.rows).toHaveLength(1);
    expect(aster.notes.join(' ')).toMatch(/no candles table/);
    const lighter = loadPairAnalysisInput(file, { ...query, venue: 'lighter', includeSkipped: false });
    expect(lighter.rows).toHaveLength(0);
    expect(lighter.notes.join(' ')).toMatch(/predates the venue column/);
    expect(() => loadPairAnalysisInput(path.join(tmpDir, 'missing.db'), { ...query, venue: 'lighter', includeSkipped: false })).toThrow(/No database at .*missing\.db/);
  });

  it('prices with the candles of the chosen candle venue only', async () => {
    const spec: SyntheticSpec = { ...rowsSpec(), candles: { [AAA]: flatPath(0, 100, 100) }, candleVenue: 'lighter' };
    const file = path.join(tmpDir, 'venues.db');
    await writeSyntheticDb(file, spec);
    expect(loadPairAnalysisInput(file, { ...query, venue: 'lighter', includeSkipped: false }).candlesLoaded[AAA]).toBeGreaterThan(0);
    const aster = loadPairAnalysisInput(file, { ...query, venue: 'lighter', includeSkipped: false, candleVenue: 'aster' });
    expect(aster.candlesLoaded[AAA]).toBe(0);
    expect(aster.series.get(AAA)?.size).toBe(0);
  });
});

describe('btc-hedged', () => {
  it('removes a pure market move: the hedge cancels what a market-only mover earns', async () => {
    const up = await run(marketSpec({ side: 'SELL', btcMove: 0.01, altMove: 0.02 }));
    const single = onlyTrade(up.result, SINGLE_STRATEGY_ID, 15);
    const hedged = onlyTrade(up.result, hedgeStrategyId(BTC), 15);
    expect(single.netBps).toBeCloseTo(200, 6);
    expect(hedged.beta).toBeCloseTo(2, 6);
    expect(hedged.netBps).toBeCloseTo(0, 6);                  // ALT +2% = beta 2 x BTC +1%
    expect(hedged.exposure).toBeCloseTo(3, 6);
    expect(up.result.hedges[0]).toMatchObject({ symbol: BTC, events: 1, betaFallbacks: 0, betaClamped: 0 });
    expect(up.result.hedges[0].meanBeta).toBeCloseTo(2, 6);

    const down = await run(marketSpec({ side: 'SELL', btcMove: -0.01, altMove: -0.02 }));
    expect(onlyTrade(down.result, SINGLE_STRATEGY_ID, 15).netBps).toBeCloseTo(-200, 6);
    expect(onlyTrade(down.result, hedgeStrategyId(BTC), 15).netBps).toBeCloseTo(0, 6);
  });

  it('removes it for a short trade too (the hedge leg flips with the side)', async () => {
    const { result } = await run(marketSpec({ side: 'BUY', btcMove: 0.01, altMove: 0.02 }));
    expect(onlyTrade(result, SINGLE_STRATEGY_ID, 15).netBps).toBeCloseTo(-200, 6);
    expect(onlyTrade(result, hedgeStrategyId(BTC), 15).netBps).toBeCloseTo(0, 6);
    expect(onlyTrade(result, hedgeStrategyId(BTC), 15).direction).toBe(-1);
  });

  it('keeps what the market did not explain, and pays for the hedge when the market helps', async () => {
    // ALT bounces 3% while BTC falls 1%: long ALT, short 2 x BTC earns 3% + 2% = 5%
    const bounce = await run(marketSpec({ side: 'SELL', btcMove: -0.01, altMove: 0.03 }));
    expect(onlyTrade(bounce.result, SINGLE_STRATEGY_ID, 15).netBps).toBeCloseTo(300, 6);
    expect(onlyTrade(bounce.result, hedgeStrategyId(BTC), 15).netBps).toBeCloseTo(500, 6);
    expect(delta(bounce.result, hedgeStrategyId(BTC), 'single')).toMatchObject({ stats: { n: 1 } });
    expect(delta(bounce.result, hedgeStrategyId(BTC), 'single').stats.meanBps).toBeCloseTo(200, 6);
    expect(bounce.result.horizons[0].deltas.filter(item => item.strategy === hedgeStrategyId(BTC))).toHaveLength(1);   // A hedge has the one baseline
    // ALT moves on its own while BTC stands still: the hedge changes nothing
    const alone = await run(marketSpec({ side: 'SELL', btcMove: 0, altMove: 0.02 }));
    expect(onlyTrade(alone.result, hedgeStrategyId(BTC), 15).netBps).toBeCloseTo(200, 6);
  });

  it('sizes the hedge 1:1 with --hedge-sizing dollar', async () => {
    const { result } = await run(marketSpec({ side: 'SELL', btcMove: 0.01, altMove: 0.02 }), { options: { hedgeSizing: 'dollar' } });
    const hedged = onlyTrade(result, hedgeStrategyId(BTC), 15);
    expect(hedged.beta).toBe(1);
    expect(hedged.netBps).toBeCloseTo(100, 6);                // 2% - 1%
    expect(hedged.exposure).toBe(2);
    expect(result.strategies.find(strategy => strategy.id === hedgeStrategyId(BTC))?.label).toBe('btc-hedged-1:1');
  });

  it('adds a strategy per extra hedge symbol, each with its own beta', async () => {
    const returns = marketReturns(260);
    const entryMove = (points: Array<[number, number]>, move: number): Array<[number, number]> => {
      const entry = points[points.length - 1][1];
      return [...points, ...Array.from({ length: 15 }, (_, i) => [at(261 + i), i === 14 ? entry * (1 + move) : entry] as [number, number])];
    };
    const spec: SyntheticSpec = {
      liquidations: [{ symbol: ALT, side: 'SELL', eventTime: at(260) + 30_000 }],
      candles: {
        [ALT]: entryMove(pathFromReturns(returns, 50, 2.5), 0.025),
        [BTC]: entryMove(pathFromReturns(returns, 20_000, 1), 0.01),
        [ETH]: entryMove(pathFromReturns(returns, 3_000, 1.25), 0.0125),
      },
    };
    const { result } = await run(spec, { options: { extraHedges: [ETH] }, query: { hedgeSymbols: [BTC, ETH] } });
    expect(result.strategies.map(strategy => strategy.label)).toEqual(['single', 'btc-hedged', 'eth-hedged', 'cross-pair']);
    expect(onlyTrade(result, hedgeStrategyId(BTC), 15)).toMatchObject({ beta: expect.closeTo(2.5, 6) });
    expect(onlyTrade(result, hedgeStrategyId(ETH), 15)).toMatchObject({ beta: expect.closeTo(2, 6) });
    expect(onlyTrade(result, hedgeStrategyId(BTC), 15).netBps).toBeCloseTo(0, 6);
    expect(onlyTrade(result, hedgeStrategyId(ETH), 15).netBps).toBeCloseTo(0, 6);
  });

  it('excludes an event on the hedge symbol itself from its hedge', async () => {
    const spec = marketSpec({ side: 'SELL', btcMove: 0.01, altMove: 0.02 });
    spec.liquidations!.push({ symbol: BTC, side: 'SELL', eventTime: at(150) + 30_000 });
    const { result } = await run(spec);
    expect(cell(result, SINGLE_STRATEGY_ID, 15).metrics.n).toBe(2);
    expect(cell(result, hedgeStrategyId(BTC), 15).metrics.n).toBe(1);
    expect(cell(result, hedgeStrategyId(BTC), 15).excluded).toEqual({ 'hedge-is-event-symbol': 1 });
    expect(result.hedges[0].events).toBe(1);                  // No beta was estimated for BTC on BTC
  });

  it('falls back to beta 1 without enough history, and counts it', async () => {
    const spec = marketSpec({ side: 'SELL', btcMove: 0.01, altMove: 0.02 });
    // Keep only the last 20 minutes of history: too few paired returns for the default minimum of 30
    for (const symbol of [ALT, BTC]) spec.candles![symbol] = spec.candles![symbol].filter(([open]) => open >= at(240));
    const { result } = await run(spec);
    expect(result.hedges[0]).toMatchObject({ events: 1, betaFallbacks: 1, betaClamped: 0 });
    // Both series are short of history here, and each is told apart
    expect(result.hedges[0].betaFallbackReasons).toEqual({ 'asset-short': 1, 'hedge-short': 1, 'hedge-flat': 0 });
    expect(result.hedges[0].shortAssets).toEqual({ [ALT]: 1 });
    expect(onlyTrade(result, hedgeStrategyId(BTC), 15).beta).toBe(1);
  });

  it('tells a short asset, a short hedge and a flat hedge apart', async () => {
    const shortAsset = marketSpec({ side: 'SELL', btcMove: 0.01, altMove: 0.02 });
    shortAsset.candles![ALT] = shortAsset.candles![ALT].filter(([open]) => open >= at(240));
    const asset = await run(shortAsset);
    expect(asset.result.hedges[0].betaFallbackReasons).toEqual({ 'asset-short': 1, 'hedge-short': 0, 'hedge-flat': 0 });
    expect(asset.result.hedges[0].shortAssets).toEqual({ [ALT]: 1 });

    const shortHedge = marketSpec({ side: 'SELL', btcMove: 0.01, altMove: 0.02 });
    shortHedge.candles![BTC] = shortHedge.candles![BTC].filter(([open]) => open >= at(240));
    const hedge = await run(shortHedge);
    expect(hedge.result.hedges[0].betaFallbackReasons).toEqual({ 'asset-short': 0, 'hedge-short': 1, 'hedge-flat': 0 });
    expect(hedge.result.hedges[0].shortAssets).toEqual({});

    const flat = marketSpec({ side: 'SELL', btcMove: 0, altMove: 0.02 });
    flat.candles![BTC] = flatPath(0, 276, 20_000);
    const flatRun = await run(flat);
    expect(flatRun.result.hedges[0]).toMatchObject({ betaFallbacks: 1, betaFallbackReasons: { 'asset-short': 0, 'hedge-short': 0, 'hedge-flat': 1 }, shortAssets: {} });
  });

  it('counts clamped betas', async () => {
    const { result } = await run(marketSpec({ side: 'SELL', btcMove: 0.01, altMove: 0.02, beta: 5 }));
    expect(result.hedges[0]).toMatchObject({ betaFallbacks: 0, betaClamped: 1 });
    expect(onlyTrade(result, hedgeStrategyId(BTC), 15).beta).toBe(3);
  });
});

describe('cross-pair', () => {
  // AAA: a long liquidation (buy) at 100:10. BBB: a short liquidation (sell) 95 s later, at 101:45. The pair is
  // entered when the second signal arrives, at the close of minute 101, where AAA stands at 50 (it was 100 a minute
  // earlier). After 15 minutes AAA is at 51.5 (+3%) and BBB at 198 (-1%): long AAA gains 3%, short BBB gains 1%.
  const spec = (secondEvent = at(101) + 45_000): SyntheticSpec => ({
    liquidations: [
      { symbol: AAA, side: 'SELL', eventTime: at(100) + 10_000 },
      { symbol: BBB, side: 'BUY', eventTime: secondEvent },
    ],
    candles: {
      [AAA]: flatPath(95, 40, 100, { 101: 50, 116: 51.5 }),
      [BBB]: flatPath(95, 40, 200, { 116: 198 }),
    },
  });

  it('goes long the long-liquidation symbol and short the short-liquidation symbol, entered at the later signal', async () => {
    const { result } = await run(spec());
    const trade = onlyTrade(result, CROSS_PAIR_STRATEGY_ID, 15);
    expect(trade).toMatchObject({ symbol: BBB, partner: AAA, direction: -1, exposure: 2 });
    expect(trade.netBps).toBeCloseTo(400, 6);                 // +3% on the long AAA leg + 1% on the short BBB leg
    expect(trade.entryCloseTime).toBe(at(102));
    expect(trade.entryCloseTime).toBeGreaterThanOrEqual(at(100) + 10_000);
    expect(trade.entryCloseTime).toBeGreaterThanOrEqual(at(101) + 45_000);
    expect(result.events).toMatchObject({ total: 2, withPartner: 2, pairs: 1 });
  });

  it('reports pair minus the trigger\'s single leg, and minus both singles', async () => {
    const { result } = await run(spec());
    const single = cell(result, SINGLE_STRATEGY_ID, 15).bySymbol;
    expect(single[AAA].meanBps).toBeCloseTo(0, 6);            // AAA alone: flat from candle 100 to 115
    expect(single[BBB].meanBps).toBeCloseTo(100, 6);          // BBB alone, short: +1%
    const trigger = delta(result, CROSS_PAIR_STRATEGY_ID, 'single');
    expect(trigger.stats.n).toBe(1);
    expect(trigger.stats.meanBps).toBeCloseTo(400 - 100, 6);  // BBB alone short: +1% = 100 bps
    expect(trigger.bySymbol[BBB].meanBps).toBeCloseTo(300, 6);
    // Both singles: AAA on its own signal earned 0, so the baseline is 0 + 100
    const both = delta(result, CROSS_PAIR_STRATEGY_ID, 'both-singles');
    expect(both.stats.n).toBe(1);
    expect(both.stats.meanBps).toBeCloseTo(400 - (100 + 0), 6);
    expect(both.bySymbol[BBB].meanBps).toBeCloseTo(300, 6);
  });

  it('forms no pair when the second signal comes after the window', async () => {
    const { result } = await run(spec(at(100) + 10_000 + 121_000));
    expect(result.events).toMatchObject({ withPartner: 0, pairs: 0 });
    expect(cell(result, CROSS_PAIR_STRATEGY_ID, 15).metrics.n).toBe(0);
    const edge = await run(spec(at(100) + 10_000 + 120_000));
    expect(edge.result.events.pairs).toBe(1);
  });

  it('excludes a pair whose partner has no candle at the entry or exit, and says so', async () => {
    const s = spec();
    s.candles![AAA] = s.candles![AAA].filter(([open]) => open !== at(116));
    const { result } = await run(s);
    expect(cell(result, CROSS_PAIR_STRATEGY_ID, 15)).toMatchObject({ excluded: { 'partner-candle-missing': 1 }, excludedTotal: 1 });
    expect(cell(result, CROSS_PAIR_STRATEGY_ID, 15).metrics.n).toBe(0);
    expect(result.gapSymbols[AAA]).toBe(1);
  });

  it('gives a paired t statistic over several pairs', async () => {
    // Three pairs 200 minutes apart; the long AAA leg gains 1%, 3% and 5%, so pair minus single is 100, 300, 500 bps
    const gains = [0.01, 0.03, 0.05];
    const shortFalls = [0.01, 0.02, 0.03];
    const overridesA: Record<number, number> = {};
    const overridesB: Record<number, number> = {};
    const liquidations: SyntheticSpec['liquidations'] = [];
    gains.forEach((gain, j) => {
      const c = 100 + 200 * j;
      overridesA[c + 16] = 100 * (1 + gain);
      overridesB[c + 16] = 200 * (1 - shortFalls[j]);
      liquidations.push({ symbol: AAA, side: 'SELL', eventTime: at(c) + 10_000 }, { symbol: BBB, side: 'BUY', eventTime: at(c + 1) + 45_000 });
    });
    const { result } = await run({ liquidations, candles: { [AAA]: flatPath(0, 800, 100, overridesA), [BBB]: flatPath(0, 800, 200, overridesB) } });
    expect(result.events.pairs).toBe(3);
    const trigger = delta(result, CROSS_PAIR_STRATEGY_ID, 'single').stats;
    expect(trigger.n).toBe(3);
    expect(trigger.meanBps).toBeCloseTo(300, 6);
    expect(trigger.stdevBps).toBeCloseTo(200, 6);
    expect(trigger.tStat).toBeCloseTo(300 / (200 / Math.sqrt(3)), 6);
    expect(trigger.winRate).toBe(1);
    const pair = cell(result, CROSS_PAIR_STRATEGY_ID, 15).metrics;
    expect(pair.n).toBe(3);
    expect(pair.meanBps).toBeCloseTo(((100 + 100) + (300 + 200) + (500 + 300)) / 3, 6);   // Each pair: AAA gain + BBB fall
  });
});

describe('cross-pair against both singles', () => {
  // The pair is entered at the later signal, so its AAA leg is the partner leg entered late. A bot that trades every
  // symbol single-leg already holds AAA from AAA's own signal, one minute earlier, and BBB from BBB's.
  //   AAA: a long liquidation (buy) at 100:10 s -> own entry at the close of minute 100.
  //   BBB: a short liquidation (sell) at 101:45 s -> entry at the close of minute 101, which is also the pair's entry.
  // 15-minute horizon. AAA closes 100 at minute 100 (own entry), 102 at 101 (the pair's entry), 103 at 115 (own exit),
  // 104.04 at 116 (the pair's exit). BBB closes 200 at 101 and 198 at 116.
  //   AAA on its own signal: 100 -> 103, +300 bps. The AAA leg of the pair: 102 -> 104.04, +200 bps. BBB short: +100 bps.
  //   pair = 200 + 100 = 300. Trigger single (BBB) = 100. Both singles = 100 + 300 = 400.
  //   pair minus trigger single = +200 (the late partner leg), pair minus both singles = -100.
  const spec = (): SyntheticSpec => ({
    liquidations: [
      { symbol: AAA, side: 'SELL', eventTime: at(100) + 10_000 },
      { symbol: BBB, side: 'BUY', eventTime: at(101) + 45_000 },
    ],
    candles: {
      [AAA]: flatPath(95, 40, 100, { 101: 102, 115: 103, 116: 104.04 }),
      [BBB]: flatPath(95, 40, 200, { 116: 198 }),
    },
  });

  it('is the late partner leg minus what the partner\'s own signal earned', async () => {
    const { result } = await run(spec());
    const singles = cell(result, SINGLE_STRATEGY_ID, 15).bySymbol;
    expect(singles[AAA].meanBps).toBeCloseTo(300, 6);
    expect(singles[BBB].meanBps).toBeCloseTo(100, 6);
    expect(onlyTrade(result, CROSS_PAIR_STRATEGY_ID, 15).netBps).toBeCloseTo(300, 6);
    const trigger = delta(result, CROSS_PAIR_STRATEGY_ID, 'single');
    const both = delta(result, CROSS_PAIR_STRATEGY_ID, 'both-singles');
    expect(trigger.stats).toMatchObject({ n: 1, winRate: 1 });
    expect(trigger.stats.meanBps).toBeCloseTo(200, 6);
    expect(both.stats).toMatchObject({ n: 1, winRate: 0, tStat: null });
    expect(both.stats.meanBps).toBeCloseTo(-100, 6);
    expect(both.bySymbol[BBB].meanBps).toBeCloseTo(-100, 6);         // By the triggering symbol, like the trade
    expect(both.horizonMin).toBe(15);
  });

  it('is independent of the costs: the pair and the two singles pay for two legs each', async () => {
    const { result } = await run(spec(), { options: { feeBps: 5, slippageBps: 2 } });
    expect(onlyTrade(result, CROSS_PAIR_STRATEGY_ID, 15).costBps).toBeCloseTo(28, 9);
    expect(delta(result, CROSS_PAIR_STRATEGY_ID, 'single').stats.meanBps).toBeCloseTo(200 - 14, 6);     // The partner leg pays 14 more
    expect(delta(result, CROSS_PAIR_STRATEGY_ID, 'both-singles').stats.meanBps).toBeCloseTo(-100, 6);
  });

  it('gives a paired t statistic for each baseline over the same pairs', async () => {
    // Three pairs 200 minutes apart, all as above except the numbers. The AAA leg on its own signal earns a (candle c+15),
    // the same leg entered a minute later earns l (candle c+16), BBB falls s (candle c+16). Pair minus trigger single is l,
    // pair minus both singles is l - a.
    const ownGains = [0.03, 0.01, 0.0];
    const lateGains = [0.02, 0.02, 0.03];
    const shortFalls = [0.01, 0.02, 0.03];
    const overridesA: Record<number, number> = {};
    const overridesB: Record<number, number> = {};
    const liquidations: SyntheticSpec['liquidations'] = [];
    ownGains.forEach((own, j) => {
      const c = 100 + 200 * j;
      overridesA[c + 15] = 100 * (1 + own);
      overridesA[c + 16] = 100 * (1 + lateGains[j]);
      overridesB[c + 16] = 200 * (1 - shortFalls[j]);
      liquidations.push({ symbol: AAA, side: 'SELL', eventTime: at(c) + 10_000 }, { symbol: BBB, side: 'BUY', eventTime: at(c + 1) + 45_000 });
    });
    const { result } = await run({ liquidations, candles: { [AAA]: flatPath(0, 800, 100, overridesA), [BBB]: flatPath(0, 800, 200, overridesB) } });
    expect(result.events.pairs).toBe(3);
    const trigger = delta(result, CROSS_PAIR_STRATEGY_ID, 'single').stats;       // 200, 200, 300
    expect(trigger.n).toBe(3);
    expect(trigger.meanBps).toBeCloseTo(700 / 3, 6);
    expect(trigger.stdevBps).toBeCloseTo(Math.sqrt(10_000 / 3), 6);
    expect(trigger.tStat).toBeCloseTo(7, 6);
    const both = delta(result, CROSS_PAIR_STRATEGY_ID, 'both-singles').stats;    // -100, +100, +300
    expect(both.n).toBe(3);
    expect(both.meanBps).toBeCloseTo(100, 6);
    expect(both.stdevBps).toBeCloseTo(200, 6);
    expect(both.tStat).toBeCloseTo(100 / (200 / Math.sqrt(3)), 6);
    expect(both.winRate).toBeCloseTo(2 / 3, 10);
    expect(delta(result, CROSS_PAIR_STRATEGY_ID, 'both-singles').bySymbol[BBB].meanBps).toBeCloseTo(100, 6);
  });

  it('only counts pairs whose two single legs both exist, and says how many', async () => {
    const s = spec();
    s.candles![AAA] = s.candles![AAA].filter(([open]) => open !== at(100));     // AAA has no candle at its own entry
    const { result } = await run(s);
    expect(cell(result, SINGLE_STRATEGY_ID, 15).excluded).toEqual({ 'entry-candle-missing': 1 });
    expect(cell(result, CROSS_PAIR_STRATEGY_ID, 15).metrics.n).toBe(1);        // The pair itself enters at minute 101
    expect(delta(result, CROSS_PAIR_STRATEGY_ID, 'single').stats.n).toBe(1);
    expect(delta(result, CROSS_PAIR_STRATEGY_ID, 'both-singles').stats).toEqual({ n: 0, meanBps: null, stdevBps: null, tStat: null, winRate: null });
  });

  it('is in the report, in the paired-difference table and the per-symbol table, and in the JSON', async () => {
    const { result, context } = await run(spec());
    const text = formatPairAnalysisReport(result, context);
    expect(text).toContain('Paired differences, same events');
    expect(text).toMatch(/cross-pair minus trigger single\s+1\s+\+200\.0/);
    expect(text).toMatch(/cross-pair minus both singles\s+1\s+-100\.0/);
    expect(text).toMatch(/d cross-pair\s+d cross-pair both/);
    expect(text).toContain('this is what executing the pair has to beat');
    const parsed = JSON.parse(JSON.stringify(pairAnalysisJson(result, context, NOW)));
    const deltas = parsed.horizons[0].deltas.filter((item: DeltaResult) => item.strategy === CROSS_PAIR_STRATEGY_ID);
    expect(deltas.map((item: DeltaResult) => item.baseline)).toEqual(['single', 'both-singles']);
    expect(deltas[1].stats.meanBps).toBeCloseTo(-100, 6);
    expect(parsed.horizons[0].strategies.find((item: StrategyHorizonResult) => item.strategy === CROSS_PAIR_STRATEGY_ID).trades[0].partnerEventId).toBeGreaterThan(0);
  });

  it('shows no explanation of the cross-pair rows when there is no pair', async () => {
    const apart = spec();
    apart.liquidations![1] = { symbol: BBB, side: 'BUY', eventTime: at(100) + 10_000 + 121_000 };       // One second past the window
    const { result, context } = await run(apart);
    expect(result.events.pairs).toBe(0);
    expect(formatPairAnalysisReport(result, context)).not.toContain('what executing the pair has to beat');
  });
});

describe('costs', () => {
  it('charges fee and slippage on both sides of every leg', async () => {
    const options = { feeBps: 5, slippageBps: 2 };
    const market = await run(marketSpec({ side: 'SELL', btcMove: 0.01, altMove: 0.02 }), { options });
    const single = onlyTrade(market.result, SINGLE_STRATEGY_ID, 15);
    expect(single.costBps).toBeCloseTo(14, 9);                         // 2 sides x (5 + 2)
    expect(single.netBps).toBeCloseTo(200 - 14, 6);
    const hedged = onlyTrade(market.result, hedgeStrategyId(BTC), 15);
    expect(hedged.costBps).toBeCloseTo(14 * (1 + 2), 6);               // The primary leg plus a hedge leg of beta 2
    expect(hedged.netBps).toBeCloseTo(0 - 42, 6);

    const dollar = await run(marketSpec({ side: 'SELL', btcMove: 0.01, altMove: 0.02 }), { options: { ...options, hedgeSizing: 'dollar' } });
    expect(onlyTrade(dollar.result, hedgeStrategyId(BTC), 15).costBps).toBeCloseTo(28, 9);
  });

  it('charges both legs of a cross pair', async () => {
    const spec: SyntheticSpec = {
      liquidations: [{ symbol: AAA, side: 'SELL', eventTime: at(100) + 10_000 }, { symbol: BBB, side: 'BUY', eventTime: at(101) + 45_000 }],
      candles: { [AAA]: flatPath(95, 40, 100, { 116: 103 }), [BBB]: flatPath(95, 40, 200, { 116: 198 }) },
    };
    const { result } = await run(spec, { options: { feeBps: 5, slippageBps: 2 } });
    const pair = onlyTrade(result, CROSS_PAIR_STRATEGY_ID, 15);
    expect(pair.grossBps).toBeCloseTo(300 + 100, 6);
    expect(pair.costBps).toBeCloseTo(28, 9);                           // 2 legs x 2 sides x 7
    expect(pair.netBps).toBeCloseTo(372, 6);
    // The same event on its own pays for one leg
    const single = cell(result, SINGLE_STRATEGY_ID, 15).trades!.find(trade => trade.symbol === BBB)!;
    expect(single.costBps).toBeCloseTo(14, 9);
    expect(single.netBps).toBeCloseTo(100 - 14, 6);
  });
});

describe('gaps', () => {
  // Five AAA long liquidations 100 minutes apart (candles 100, 200, ..., 500), prices that always move, and holes:
  //   2nd: the 5-minute exit candle is missing (the one after it is there)
  //   3rd: the entry candle is missing
  //   4th: the BTC candle at the 5-minute exit is missing
  //   5th: its 60-minute exit has not closed yet at `now`
  const gapSpec = (): SyntheticSpec => {
    const aaa: Array<[number, number]> = Array.from({ length: 600 }, (_, i) => [at(i), 100 + (i % 7)]);
    const btc: Array<[number, number]> = Array.from({ length: 600 }, (_, i) => [at(i), 1000 + (i % 5)]);
    return {
      liquidations: [100, 200, 300, 400, 500].map(c => ({ symbol: AAA, side: 'SELL' as const, eventTime: at(c) + 30_000 })),
      candles: {
        [AAA]: aaa.filter(([open]) => open !== at(205) && open !== at(300)),
        [BTC]: btc.filter(([open]) => open !== at(405)),
      },
    };
  };
  const gapOptions: Partial<PairAnalysisOptions> = { horizonsMin: [5, 15, 60], betaLookbackMin: 60, betaMinObservations: 10, now: at(561) - 1 };

  it('excludes the event from that strategy and horizon only, with a counted reason, and never interpolates', async () => {
    const { result } = await run(gapSpec(), { options: gapOptions });
    const single = (horizon: number) => cell(result, SINGLE_STRATEGY_ID, horizon);
    expect(single(5).metrics.n).toBe(3);
    expect(single(5).excluded).toEqual({ 'exit-candle-missing': 1, 'entry-candle-missing': 1 });
    expect(single(15).metrics.n).toBe(4);
    expect(single(15).excluded).toEqual({ 'entry-candle-missing': 1 });
    expect(single(60).metrics.n).toBe(3);
    expect(single(60).excluded).toEqual({ 'entry-candle-missing': 1, 'horizon-not-elapsed': 1 });

    const hedged = (horizon: number) => cell(result, hedgeStrategyId(BTC), horizon);
    expect(hedged(5).metrics.n).toBe(2);
    expect(hedged(5).excluded).toEqual({ 'exit-candle-missing': 1, 'entry-candle-missing': 1, 'hedge-candle-missing': 1 });
    expect(hedged(15).metrics.n).toBe(4);
    expect(hedged(60).metrics.n).toBe(3);

    // Every event is either in the strategy or excluded with a reason
    for (const horizon of result.horizons) {
      for (const strategy of horizon.strategies.filter(item => item.strategy !== CROSS_PAIR_STRATEGY_ID)) {
        expect(strategy.metrics.n + strategy.excludedTotal).toBe(result.events.total);
      }
    }
    // Only gaps that fetching could fill name a symbol; a horizon that has not elapsed does not
    expect(result.gapSymbols).toEqual({ [AAA]: 2, [BTC]: 1 });
  });

  it('computes the other events from their own candles, not from a neighbour', async () => {
    const { result } = await run(gapSpec(), { options: { ...gapOptions, horizonsMin: [5] } });
    const trades = cell(result, SINGLE_STRATEGY_ID, 5).trades!;
    expect(trades.map(trade => trade.eventTime)).toEqual([at(100) + 30_000, at(400) + 30_000, at(500) + 30_000]);
    // Candle i closes at 100 + i % 7: entry at 100 -> 100 + 100 % 7 = 102, exit at 105 -> 100 + 105 % 7 = 100
    expect(trades[0].grossBps).toBeCloseTo((100 / 102 - 1) * 1e4, 6);
  });

  it('reports a horizon that has not elapsed as such, not as a gap', async () => {
    const { result } = await run(gapSpec(), { options: { ...gapOptions, now: at(100) + 30_000 } });
    expect(cell(result, SINGLE_STRATEGY_ID, 5).excluded['horizon-not-elapsed']).toBe(5);
    expect(result.gapSymbols).toEqual({});
  });
});

describe('exit-fill carry', () => {
  // AAA: a long liquidation at 100:30 (entry candle 100, closing 100). Candles 101-104 close at 101, 102, 103 and 104;
  // 105, the 5-minute exit, is missing, as are 106 and 107. Carry-forward takes the last close at or before the exit.
  const spec = (): SyntheticSpec => ({
    liquidations: [{ symbol: AAA, side: 'SELL', eventTime: at(100) + 30_000 }],
    candles: {
      [AAA]: flatPath(90, 40, 100, { 101: 101, 102: 102, 103: 103, 104: 104 }).filter(([open]) => open < at(105) || open > at(107)),
      [BTC]: flatPath(0, 200, 20_000),
    },
  });

  it('leaves the event out by default, with a counted reason', async () => {
    const { result } = await run(spec(), { options: { horizonsMin: [5] } });
    expect(cell(result, SINGLE_STRATEGY_ID, 5)).toMatchObject({ excluded: { 'exit-candle-missing': 1 }, carried: 0 });
    expect(cell(result, SINGLE_STRATEGY_ID, 5).metrics.n).toBe(0);
  });

  it('takes the last stored close at or before the exit minute, and counts it', async () => {
    const { result } = await run(spec(), { options: { horizonsMin: [5], exitFill: 'carry' } });
    const single = cell(result, SINGLE_STRATEGY_ID, 5);
    expect(single.metrics.n).toBe(1);
    expect(single.carried).toBe(1);
    expect(single.excludedTotal).toBe(0);
    expect(single.trades![0].grossBps).toBeCloseTo(400, 6);            // Entry 100, exit carried from candle 104 (104)
    expect(single.trades![0].carriedLegs).toBe(1);
    expect(result.gapSymbols).toEqual({});                            // A carried exit is not a gap to fetch
    expect(result.options).toMatchObject({ exitFill: 'carry', exitCarryMaxMin: 5 });
  });

  it('looks back no further than the bound, and never before the entry candle', async () => {
    // Bound 1: candle 104 is the only one it may take
    expect(cell((await run(spec(), { options: { horizonsMin: [5], exitFill: 'carry', exitCarryMaxMin: 1 } })).result, SINGLE_STRATEGY_ID, 5).trades![0].grossBps).toBeCloseTo(400, 6);
    // Without candles 103 and 104 a bound of 1 finds nothing, a bound of 2 reaches candle 102
    const sparse = spec();
    sparse.candles![AAA] = sparse.candles![AAA].filter(([open]) => open !== at(103) && open !== at(104));
    const none = await run(sparse, { options: { horizonsMin: [5], exitFill: 'carry', exitCarryMaxMin: 1 } });
    expect(cell(none.result, SINGLE_STRATEGY_ID, 5)).toMatchObject({ excluded: { 'exit-candle-missing': 1 }, carried: 0 });
    const reaches = await run(sparse, { options: { horizonsMin: [5], exitFill: 'carry', exitCarryMaxMin: 3 } });
    expect(cell(reaches.result, SINGLE_STRATEGY_ID, 5).trades![0].grossBps).toBeCloseTo(200, 6);
    // Only the entry candle is left in the window: it is the last close at or before the exit (return 0), but candle 99,
    // before the entry, is never taken
    const bare = spec();
    bare.candles![AAA] = flatPath(90, 10, 90).concat([[at(100), 100]]);
    const entryOnly = await run(bare, { options: { horizonsMin: [5], exitFill: 'carry', exitCarryMaxMin: 30 } });
    expect(cell(entryOnly.result, SINGLE_STRATEGY_ID, 5).trades![0].grossBps).toBeCloseTo(0, 9);
  });

  it('does not carry an entry', async () => {
    const s = spec();
    s.candles![AAA] = s.candles![AAA].filter(([open]) => open !== at(100));
    const { result } = await run(s, { options: { horizonsMin: [5], exitFill: 'carry' } });
    expect(cell(result, SINGLE_STRATEGY_ID, 5)).toMatchObject({ excluded: { 'entry-candle-missing': 1 }, carried: 0 });
    expect(result.gapSymbols).toEqual({ [AAA]: 1 });
  });

  it('carries the exit of a hedge leg and of a partner leg too, counting a trade once however many legs were carried', async () => {
    const s = spec();
    // BTC stands still but loses its exit candle; the AAA exit is carried as well: the hedged trade has two carried legs
    s.candles![BTC] = s.candles![BTC].filter(([open]) => open !== at(105));
    const { result } = await run(s, { options: { horizonsMin: [5], exitFill: 'carry' } });
    const hedged = cell(result, hedgeStrategyId(BTC), 5);
    expect(hedged.metrics.n).toBe(1);
    expect(hedged.trades![0].carriedLegs).toBe(2);
    expect(hedged.carried).toBe(1);
    const exact = await run(s, { options: { horizonsMin: [5] } });
    expect(cell(exact.result, hedgeStrategyId(BTC), 5).carried).toBe(0);

    // A pair: BBB (a short liquidation) triggers at 101:10; the partner AAA's exit candle (106) is missing, 105 stands
    const pair: SyntheticSpec = {
      liquidations: [{ symbol: AAA, side: 'SELL', eventTime: at(100) + 30_000 }, { symbol: BBB, side: 'BUY', eventTime: at(101) + 10_000 }],
      candles: {
        [AAA]: flatPath(90, 40, 100, { 101: 100, 105: 110 }).filter(([open]) => open !== at(106)),
        [BBB]: flatPath(90, 40, 200, { 106: 190 }),
      },
    };
    const exactPair = await run(pair, { options: { horizonsMin: [5] } });
    expect(cell(exactPair.result, CROSS_PAIR_STRATEGY_ID, 5)).toMatchObject({ excluded: { 'partner-candle-missing': 1 } });
    const carriedPair = await run(pair, { options: { horizonsMin: [5], exitFill: 'carry' } });
    const trade = onlyTrade(carriedPair.result, CROSS_PAIR_STRATEGY_ID, 5);
    expect(trade.carriedLegs).toBe(1);
    expect(trade.netBps).toBeCloseTo((0.1 + 0.05) * 1e4, 6);          // AAA 100 -> 110 (carried from 105), BBB 200 -> 190 short
  });

  it('says so in the report: the fill mode, and how many trades used a carried exit', async () => {
    const carried = await run(spec(), { options: { horizonsMin: [5], exitFill: 'carry' } });
    const text = formatPairAnalysisReport(carried.result, carried.context);
    expect(text).toContain('Exit fill: carry-forward (a missing exit candle takes the last stored close up to 5 min before it');
    expect(text).toContain('exit carried forward (last close within 5 min): single 1 of 1 trades');
    const exact = formatPairAnalysisReport((await run(spec(), { options: { horizonsMin: [5] } })).result, carried.context);
    expect(exact).toContain('Exit fill: exact (a missing exit candle leaves the event out)');
    expect(exact).not.toContain('exit carried forward');
  });
});

describe('bias of the events lost to a missing exit candle', () => {
  // Three AAA long liquidations (candles 100, 200, 300), all flat at 100 except:
  //   1st: +1% at 15 min (candle 115); its 5-minute exit candle (105) is missing
  //   2nd: 0% at 5 min, +3% at 15 min
  //   3rd: 0% at 5 min, 0% at 15 min
  // At 5 min the 1st is left out and the table shows the other two; the 1st's 15-minute result is +100 against +133.3
  // for all three.
  const spec = (): SyntheticSpec => ({
    liquidations: [100, 200, 300].map(c => ({ symbol: AAA, side: 'SELL' as const, eventTime: at(c) + 30_000 })),
    candles: {
      [AAA]: flatPath(90, 260, 100, { 115: 101, 215: 103 }).filter(([open]) => open !== at(105)),
      [BTC]: flatPath(90, 260, 20_000),
    },
  });

  it('gives the left-out events\' single-leg mean and count at the horizons where they do have candles, next to the mean of all', async () => {
    const { result } = await run(spec(), { options: { horizonsMin: [5, 15] } });
    expect(cell(result, SINGLE_STRATEGY_ID, 5).metrics.n).toBe(2);
    const five = result.horizons[0].exitGapBias;
    expect(five.events).toBe(1);
    expect(five.elsewhere).toHaveLength(1);
    expect(five.elsewhere[0]).toMatchObject({ horizonMin: 15, n: 1 });
    expect(five.elsewhere[0].meanBps).toBeCloseTo(100, 6);
    expect(five.elsewhere[0].allMeanBps).toBeCloseTo((100 + 300 + 0) / 3, 6);
    expect(result.horizons[1].exitGapBias).toEqual({ events: 0, elsewhere: [] });
  });

  it('prints one line per horizon and puts the field in the JSON', async () => {
    const { result, context } = await run(spec(), { options: { horizonsMin: [5, 15] } });
    const text = formatPairAnalysisReport(result, context);
    expect(text).toContain('Exit-candle bias: 1 event(s) lack an exit candle at 5 min and are left out. Their single-leg mean net bps [n] at the horizons where they do have candles: 15 min +100.0 [1] (all events +133.3)');
    expect(text).toContain('Exit-candle bias: no event lacks its exit candle at 15 min.');
    const parsed = JSON.parse(JSON.stringify(pairAnalysisJson(result, context, NOW)));
    expect(parsed.horizons[0].exitGapBias).toMatchObject({ events: 1, elsewhere: [{ horizonMin: 15, n: 1 }] });
  });

  it('says so when a single horizon leaves nothing to compare with, and when carry-forward removes the gap', async () => {
    const one = await run(spec(), { options: { horizonsMin: [5] } });
    expect(one.result.horizons[0].exitGapBias).toEqual({ events: 1, elsewhere: [] });
    expect(formatPairAnalysisReport(one.result, one.context)).toContain('none (no other horizon in this run has a result for them)');
    const carried = await run(spec(), { options: { horizonsMin: [5, 15], exitFill: 'carry' } });
    expect(carried.result.horizons[0].exitGapBias.events).toBe(0);
    expect(cell(carried.result, SINGLE_STRATEGY_ID, 5).metrics.n).toBe(3);
  });

  it('only counts exit-candle gaps, not a missing entry or a horizon that has not elapsed', async () => {
    const s = spec();
    s.candles![AAA] = s.candles![AAA].filter(([open]) => open !== at(200));
    const { result } = await run(s, { options: { horizonsMin: [5, 15], now: at(316) } });
    expect(result.horizons[0].exitGapBias.events).toBe(1);             // The 1st only; the 2nd lost its entry, the 3rd's 15-min exit has not closed
    expect(result.horizons[1].exitGapBias.events).toBe(0);
  });
});

describe('horizon alignment', () => {
  // AAA: a long liquidation at 60:30, inside minute 60. The candle before it (minute 59) closed at 100, minute 60
  // closes at 110 and minute 61 at 130; five minutes after the entry (candle 65) it closes at 121.
  // BBB: a long liquidation exactly on the minute 160. The candle that ended there (159) closed at 70, before the
  // liquidation's trade; the candle that starts there (160) closes at 100 and is the entry; five minutes later
  // (candle 165) it closes at 105.
  const spec = (): SyntheticSpec => ({
    liquidations: [
      { symbol: AAA, side: 'SELL', eventTime: at(60) + 30_000 },
      { symbol: BBB, side: 'SELL', eventTime: at(160) },
    ],
    candles: {
      [AAA]: flatPath(50, 40, 110, { 59: 100, 61: 130, 65: 121 }),
      [BBB]: flatPath(150, 40, 50, { 159: 70, 160: 100, 165: 105 }),
    },
  });

  it('enters at the close of the candle that contains the event and exits exactly the horizon later', async () => {
    const { result } = await run(spec(), { options: { horizonsMin: [5] } });
    const [aaa, bbb] = cell(result, SINGLE_STRATEGY_ID, 5).trades!;
    expect(aaa.symbol).toBe(AAA);
    expect(aaa.grossBps).toBeCloseTo((121 / 110 - 1) * 1e4, 6);       // Not from the 100 before the event, not from the 130 after
    expect(bbb.symbol).toBe(BBB);
    expect(bbb.grossBps).toBeCloseTo((105 / 100 - 1) * 1e4, 6);       // The candle that starts at the event, not the one that ended there (70)
    expect(bbb.entryCloseTime).toBe(at(161));
    expect(bbb.exitCloseTime).toBe(at(166));
    for (const trade of [aaa, bbb]) {
      expect(trade.entryCloseTime).toBeGreaterThan(trade.eventTime);
      expect(trade.entryCloseTime - trade.eventTime).toBeLessThanOrEqual(MINUTE);
      expect(trade.exitCloseTime - trade.entryCloseTime).toBe(5 * MINUTE_MS);
    }
  });

  it('keeps entry after the event for every trade and horizon', async () => {
    const { result } = await run(spec(), { options: { horizonsMin: [1, 5, 15] } });
    for (const horizon of result.horizons) {
      for (const strategy of horizon.strategies) {
        for (const trade of strategy.trades ?? []) {
          expect(trade.entryCloseTime).toBeGreaterThan(trade.eventTime);
          expect(trade.entryCloseTime - trade.eventTime).toBeLessThanOrEqual(MINUTE);
          expect(trade.exitCloseTime - trade.entryCloseTime).toBe(horizon.horizonMin * MINUTE_MS);
        }
      }
    }
    expect(cell(result, SINGLE_STRATEGY_ID, 15).trades).toHaveLength(2);
  });

  it('enters the partner leg of a pair, and every leg, at the candle that contains the later signal', async () => {
    // A long liquidation of AAA and a short one of BBB exactly on the boundary 20 s later: BBB triggers, in candle 101
    const { result } = await run({
      liquidations: [{ symbol: AAA, side: 'SELL', eventTime: at(100) + 40_000 }, { symbol: BBB, side: 'BUY', eventTime: at(101) }],
      candles: { [AAA]: flatPath(95, 40, 100, { 100: 80, 101: 100, 106: 110 }), [BBB]: flatPath(95, 40, 200, { 100: 150, 101: 200, 106: 190 }) },
    }, { options: { horizonsMin: [5] } });
    const pair = onlyTrade(result, CROSS_PAIR_STRATEGY_ID, 5);
    expect(pair.symbol).toBe(BBB);
    expect(pair.entryCloseTime).toBe(at(102));
    expect(pair.netBps).toBeCloseTo((0.1 + 0.05) * 1e4, 6);           // AAA 100 -> 110 long, BBB 200 -> 190 short; not from 80 or 150
  });

  it('counts an exit that closes at `now` as not elapsed, one that closed before it as known', async () => {
    const quiet: SyntheticSpec = { liquidations: [{ symbol: AAA, side: 'SELL', eventTime: at(100) + 30_000 }], candles: { [AAA]: flatPath(95, 20, 100) } };
    const exitClose = at(106);                                           // Entry candle 100, exit candle 105 closes at minute 106
    const exact = await run(quiet, { options: { horizonsMin: [5], now: exitClose } });
    expect(cell(exact.result, SINGLE_STRATEGY_ID, 5)).toMatchObject({ excluded: { 'horizon-not-elapsed': 1 }, excludedTotal: 1 });
    expect(cell(exact.result, SINGLE_STRATEGY_ID, 5).metrics.n).toBe(0);
    expect(exact.result.gapSymbols).toEqual({});
    const after = await run(quiet, { options: { horizonsMin: [5], now: exitClose + 1 } });
    expect(cell(after.result, SINGLE_STRATEGY_ID, 5).metrics.n).toBe(1);
  });

  it('with --until-exits leaves out trades whose exit closes after the deadline, and keeps the ones that close at it', async () => {
    const spec2: SyntheticSpec = {
      liquidations: [100, 200].map(c => ({ symbol: AAA, side: 'SELL' as const, eventTime: at(c) + 30_000 })),
      candles: { [AAA]: flatPath(90, 140, 100), [BTC]: flatPath(90, 140, 20_000) },
    };
    const options = { horizonsMin: [5, 15] };
    const without = await run(spec2, { options });
    expect(cell(without.result, SINGLE_STRATEGY_ID, 15).metrics.n).toBe(2);
    // Event 1 exits at the close of minute 106 (5 min) and 116 (15 min); event 2 at 206 and 216
    const edge = await run(spec2, { options: { ...options, exitDeadline: at(116) } });
    expect(cell(edge.result, SINGLE_STRATEGY_ID, 5)).toMatchObject({ excluded: { 'exit-after-until': 1 } });
    expect(cell(edge.result, SINGLE_STRATEGY_ID, 5).trades!.map(trade => trade.eventTime)).toEqual([at(100) + 30_000]);
    expect(cell(edge.result, SINGLE_STRATEGY_ID, 15)).toMatchObject({ excluded: { 'exit-after-until': 1 } });
    expect(cell(edge.result, SINGLE_STRATEGY_ID, 15).trades!.map(trade => trade.exitCloseTime)).toEqual([at(116)]);
    const tight = await run(spec2, { options: { ...options, exitDeadline: at(116) - 1 } });
    expect(cell(tight.result, SINGLE_STRATEGY_ID, 5).metrics.n).toBe(1);
    expect(cell(tight.result, SINGLE_STRATEGY_ID, 15).metrics.n).toBe(0);
    expect(cell(tight.result, SINGLE_STRATEGY_ID, 15).excluded).toEqual({ 'exit-after-until': 2 });
    // The hedged strategy is left out for the same reason, and the report names it
    expect(cell(tight.result, hedgeStrategyId(BTC), 15).excluded).toEqual({ 'exit-after-until': 2 });
    expect(formatPairAnalysisReport(tight.result, tight.context)).toContain('exit past --until 2');
    expect(tight.result.gapSymbols).toEqual({});                         // Not a gap that fetching candles would fill
  });
});

describe('drawdown through the analysis', () => {
  it('is the largest fall of the cumulative P&L of the events in the order they were entered', async () => {
    // Four events, 5-minute returns of +100, -300, +50 and -200 bps: cumulative 100, -200, -150, -350
    const exits: Record<number, number> = { 105: 101, 205: 97, 305: 100.5, 405: 98 };
    const { result } = await run({
      liquidations: [100, 200, 300, 400].map(c => ({ symbol: AAA, side: 'SELL' as const, eventTime: at(c) + 30_000 })),
      candles: { [AAA]: flatPath(90, 330, 100, exits) },
    }, { options: { horizonsMin: [5] } });
    const metrics = cell(result, SINGLE_STRATEGY_ID, 5).metrics;
    expect(cell(result, SINGLE_STRATEGY_ID, 5).trades!.map(trade => Math.round(trade.netBps))).toEqual([100, -300, 50, -200]);
    expect(metrics.maxDrawdownBps).toBeCloseTo(450, 6);                   // From the peak of 100 to -350
    expect(metrics.meanBps).toBeCloseTo(-87.5, 6);
    expect(metrics.winRate).toBe(0.5);
  });
});

describe('report', () => {
  it('prints the caveat, the strategies and, with the hedge candles missing, the exact command to fetch them', async () => {
    const run1 = await run(marketSpec({ side: 'SELL', btcMove: 0.01, altMove: 0.02, withBtc: false }), { options: { now: T0 + 3 * DAY } });
    const text = formatPairAnalysisReport(run1.result, run1.context);
    expect(text).toContain(PAIR_ANALYSIS_CAVEAT);
    expect(PAIR_ANALYSIS_CAVEAT).toMatch(/in-sample/);
    expect(PAIR_ANALYSIS_CAVEAT).toMatch(/backfilled Lighter rows skip the book-side gate/);
    expect(PAIR_ANALYSIS_CAVEAT).toMatch(/funding is ignored/);
    expect(PAIR_ANALYSIS_CAVEAT).toMatch(/1m closes/);
    for (const label of ['single', 'btc-hedged', 'cross-pair', '=== Horizon 15 min ===', 'Paired differences', 'btc-hedged minus single', 'Per symbol']) expect(text).toContain(label);
    expect(text).toContain('hedge candle missing 1');

    const advice = missingCandleAdvice(run1.result, run1.context)!;
    expect(advice.symbols.map(item => item.symbol)).toEqual([BTC]);
    expect(advice.command).toBe('npm run lighter:backfill -- --candles-only --symbols BTCUSDT --days 3');
    expect(text).toContain('Missing candles');
    expect(text).toContain(advice.command!);

    // The command is accepted by the backfill's own parser: candles only, for a symbol that need not be configured
    const parsed = parseLighterBackfillArgs(advice.command!.split(' -- ')[1].split(' '));
    expect(parsed).toMatchObject({ candles: true, liquidations: false, symbols: [BTC], days: 3 });
    expect(lighterBackfillRetentionProblem(parsed, 7)).toBeNull();
  });

  it('lists every symbol that lacks candles in one command, and reaches back far enough for the beta lookback', async () => {
    expect(lighterCandleFetchCommand([BTC, ETH], 9.1)).toBe('npm run lighter:backfill -- --candles-only --symbols BTCUSDT,ETHUSDT --days 9.1');
    const { result, context } = await run(marketSpec({ side: 'SELL', btcMove: 0.01, altMove: 0.02, withBtc: false }), { options: { now: T0 + 3 * DAY } });
    // 3 days minus the 17.5 minutes before the first needed candle (event 260.5 min, less 243 min) -> 2.99 days -> 3
    expect(missingCandleAdvice(result, context)!.days).toBe(3);
    const later = missingCandleAdvice(result, { ...context, now: T0 + 3 * DAY + 2 * 60 * MINUTE })!;
    expect(later.days).toBe(3.1);
  });

  it('does not offer a fetch command for candles of a venue the backfill cannot load', async () => {
    const { result, context } = await run(marketSpec({ side: 'SELL', btcMove: 0.01, altMove: 0.02, withBtc: false }));
    const advice = missingCandleAdvice(result, { ...context, candleVenue: 'aster' })!;
    expect(advice.command).toBeNull();
    expect(advice.note).toMatch(/--candle-venue lighter/);
  });

  it('has nothing to say about candles when none are missing', async () => {
    const { result, context } = await run(marketSpec({ side: 'SELL', btcMove: 0.01, altMove: 0.02 }));
    expect(missingCandleAdvice(result, context)).toBeNull();
    expect(formatPairAnalysisReport(result, context)).not.toContain('Missing candles');
  });

  describe('advice for a beta that fell back', () => {
    const shorten = (spec: SyntheticSpec, symbol: string): SyntheticSpec => {
      spec.candles![symbol] = spec.candles![symbol].filter(([open]) => open >= at(240));        // 20 minutes of history
      return spec;
    };

    it('suggests the hedge only when the hedge was short of history', async () => {
      const { result, context } = await run(shorten(marketSpec({ side: 'SELL', btcMove: 0.01, altMove: 0.02 }), BTC));
      expect(result.hedges[0]).toMatchObject({ betaFallbacks: 1, betaFallbackReasons: { 'asset-short': 0, 'hedge-short': 1, 'hedge-flat': 0 } });
      const advice = missingCandleAdvice(result, context)!;
      expect(advice.symbols).toEqual([{ symbol: BTC, reason: 'hedge: too little data for beta before 1 of 1 events (beta 1 used)' }]);
      expect(advice.command).toMatch(/--symbols BTCUSDT /);
    });

    it('names the liquidated symbol, not the hedge, when the liquidated symbol was short of history', async () => {
      const { result, context } = await run(shorten(marketSpec({ side: 'SELL', btcMove: 0.01, altMove: 0.02 }), ALT));
      expect(result.hedges[0]).toMatchObject({ betaFallbacks: 1, betaFallbackReasons: { 'asset-short': 1, 'hedge-short': 0, 'hedge-flat': 0 }, shortAssets: { [ALT]: 1 } });
      const advice = missingCandleAdvice(result, context)!;
      expect(advice.symbols.map(item => item.symbol)).toEqual([ALT]);
      expect(advice.symbols[0].reason).toBe('too little history before 1 of its events to estimate beta (beta 1 used)');
      expect(advice.command).toMatch(/--symbols ALTUSDT /);
      expect(advice.command).not.toContain(BTC);
      const text = formatPairAnalysisReport(result, context);
      expect(text).not.toContain('hedge: too little data');
      expect(text).toContain('asset short of history 1, hedge short of history 0, hedge flat 0');
      expect(text).toContain(`${ALT}: too little history`);
    });

    it('names both when both were short, and nobody when the hedge merely did not move', async () => {
      const both = shorten(shorten(marketSpec({ side: 'SELL', btcMove: 0.01, altMove: 0.02 }), ALT), BTC);
      const bothRun = await run(both);
      expect(missingCandleAdvice(bothRun.result, bothRun.context)!.symbols.map(item => item.symbol)).toEqual([ALT, BTC]);
      const flat = marketSpec({ side: 'SELL', btcMove: 0, altMove: 0.02 });
      flat.candles![BTC] = flatPath(0, 276, 20_000);
      const flatRun = await run(flat);
      expect(flatRun.result.hedges[0].betaFallbackReasons['hedge-flat']).toBe(1);
      expect(missingCandleAdvice(flatRun.result, flatRun.context)).toBeNull();                  // Fetching would not change a flat hedge
      expect(formatPairAnalysisReport(flatRun.result, flatRun.context)).toContain('hedge flat 1');
    });

    it('does not repeat itself for an asset that is short against several hedges', async () => {
      const spec = shorten(marketSpec({ side: 'SELL', btcMove: 0.01, altMove: 0.02 }), ALT);
      spec.candles![ETH] = spec.candles![BTC];
      const { result, context } = await run(spec, { options: { extraHedges: [ETH] }, query: { hedgeSymbols: [BTC, ETH] } });
      const advice = missingCandleAdvice(result, context)!;
      expect(advice.symbols).toEqual([{ symbol: ALT, reason: 'too little history before 1 of its events to estimate beta (beta 1 used)' }]);
    });
  });

  describe('per-symbol table', () => {
    // Three symbols with one long liquidation each, in different hours so that no pair forms
    const manySymbols = (): SyntheticSpec => ({
      liquidations: [AAA, BBB, ALT].map((symbol, i) => ({ symbol, side: 'SELL' as const, eventTime: at(100 + 200 * i) + 30_000 })),
      candles: Object.fromEntries([AAA, BBB, ALT, BTC].map(symbol => [symbol, flatPath(0, 800, 100)])),
    });

    it('cuts the table at symbolRowLimit and says how many symbols were left out', async () => {
      const { result, context } = await run(manySymbols(), { symbolRowLimit: 2 });
      const text = formatPairAnalysisReport(result, context);
      const table = text.slice(text.indexOf('Per symbol'));
      expect(table).toContain('  ... 1 more symbol(s); all of them are in the --json output');
      expect(table.match(/^(AAAUSDT|BBBUSDT|ALTUSDT)\s/gm)).toHaveLength(2);
      // Everything is still in the JSON
      const parsed = JSON.parse(JSON.stringify(pairAnalysisJson(result, context, NOW)));
      expect(Object.keys(parsed.horizons[0].strategies[0].bySymbol).sort()).toEqual([AAA, ALT, BBB].sort());
    });

    it('shows every symbol, with no cut line, when they fit', async () => {
      const { result, context } = await run(manySymbols(), { symbolRowLimit: 3 });
      const text = formatPairAnalysisReport(result, context);
      expect(text).not.toContain('more symbol(s)');
      expect(text.slice(text.indexOf('Per symbol')).match(/^(AAAUSDT|BBBUSDT|ALTUSDT)\s/gm)).toHaveLength(3);
      const byDefault = await run(manySymbols());
      expect(formatPairAnalysisReport(byDefault.result, byDefault.context)).not.toContain('more symbol(s)');       // The default is 25
    });
  });

  it('writes a JSON result that survives a round trip, with trades only on request', async () => {
    const withTrades = await run(marketSpec({ side: 'SELL', btcMove: 0.01, altMove: 0.02 }));
    const parsed = JSON.parse(JSON.stringify(pairAnalysisJson(withTrades.result, withTrades.context, NOW)));
    expect(parsed.caveats[0]).toMatch(/in-sample/);
    expect(parsed.venue).toBe('lighter');
    expect(parsed.strategies.map((strategy: { label: string }) => strategy.label)).toEqual(['single', 'btc-hedged', 'cross-pair']);
    expect(parsed.horizons[0].strategies[0].trades).toHaveLength(1);
    const without = await run(marketSpec({ side: 'SELL', btcMove: 0.01, altMove: 0.02 }), { options: { keepTrades: false } });
    expect(JSON.parse(JSON.stringify(pairAnalysisJson(without.result, without.context, NOW))).horizons[0].strategies[0].trades).toBeUndefined();
  });

  it('says so when there are no events', async () => {
    const { result, context } = await run({ liquidations: [] });
    expect(formatPairAnalysisReport(result, context)).toContain('No events to analyse.');
  });
});
