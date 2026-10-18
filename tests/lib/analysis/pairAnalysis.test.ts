/**
 * @jest-environment node
 */
import {
  BETA_FALLBACK,
  candleSeries,
  countEventsWithPartner,
  entryOpenTime,
  estimateBeta,
  matchCrossPairs,
  maxDrawdown,
  median,
  percentile,
  selectEvents,
  stdev,
  summarizeDeltas,
  summarizeTrades,
  tradeDirection,
  type LiquidationRow,
  type PairEvent,
} from '../../../src/lib/analysis/pairAnalysis';
import { MINUTE, T0, at, marketReturns, pathFromReturns, toSeries } from './synthetic';

let nextId = 1;

function row(symbol: string, side: string, secondsAfterT0: number, volumeUsdt = 10_000): LiquidationRow {
  return { id: nextId++, symbol, side, eventTime: T0 + secondsAfterT0 * 1000, volumeUsdt };
}

function event(symbol: string, side: 'BUY' | 'SELL', secondsAfterT0: number): PairEvent {
  return { id: nextId++, symbol, side, direction: tradeDirection(side), eventTime: T0 + secondsAfterT0 * 1000, volumeUsdt: 10_000, backfilled: false };
}

describe('direction of the contrarian trade', () => {
  it('buys after a long liquidation (forced SELL) and sells after a short one (forced BUY)', () => {
    expect(tradeDirection('SELL')).toBe(1);
    expect(tradeDirection('BUY')).toBe(-1);
    const selection = selectEvents([row('AAAUSDT', 'SELL', 0), row('BBBUSDT', 'BUY', 0)], { minUsd: 0, dedupeSec: 60 });
    expect(selection.events.map(item => [item.symbol, item.direction])).toEqual([['AAAUSDT', 1], ['BBBUSDT', -1]]);
  });
});

describe('selectEvents', () => {
  it('keeps one event per symbol and side within the window, anchored on the kept row', () => {
    const rows = [
      row('AAAUSDT', 'SELL', 0),
      row('AAAUSDT', 'SELL', 30),
      row('AAAUSDT', 'SELL', 59),
      row('AAAUSDT', 'SELL', 60),       // Exactly the window after the anchor: a new event
      row('AAAUSDT', 'SELL', 100),      // 40 s after the second anchor, not 100 s after the first
      row('AAAUSDT', 'SELL', 119),
      row('AAAUSDT', 'SELL', 120),      // 60 s after the second anchor: a third event
    ];
    const selection = selectEvents(rows, { minUsd: 0, dedupeSec: 60 });
    expect(selection.events.map(item => (item.eventTime - T0) / 1000)).toEqual([0, 60, 120]);
    expect(selection.collapsed).toBe(4);
    expect(selection.rows).toBe(7);
  });

  it('treats other sides and other symbols as separate bursts', () => {
    const rows = [row('AAAUSDT', 'SELL', 0), row('AAAUSDT', 'BUY', 5), row('BBBUSDT', 'SELL', 10), row('AAAUSDT', 'SELL', 20)];
    const selection = selectEvents(rows, { minUsd: 0, dedupeSec: 60 });
    expect(selection.events.map(item => [item.symbol, item.side])).toEqual([['AAAUSDT', 'SELL'], ['AAAUSDT', 'BUY'], ['BBBUSDT', 'SELL']]);
    expect(selection.collapsed).toBe(1);
  });

  it('applies the size filter before the collapse and orders rows by time', () => {
    const rows = [
      row('AAAUSDT', 'SELL', 40, 50_000),   // Out of order on purpose
      row('AAAUSDT', 'SELL', 0, 500),       // Too small: it must not open the window
      row('AAAUSDT', 'SELL', 10, 20_000),
    ];
    const selection = selectEvents(rows, { minUsd: 1000, dedupeSec: 60 });
    expect(selection.events.map(item => [(item.eventTime - T0) / 1000, item.volumeUsdt])).toEqual([[10, 20_000]]);
    expect(selection.belowMinUsd).toBe(1);
    expect(selection.collapsed).toBe(1);
  });

  it('counts rows it cannot use and keeps the backfill flag', () => {
    const rows: LiquidationRow[] = [
      row('AAAUSDT', 'HOLD', 0),
      { id: nextId++, symbol: 'BBBUSDT', side: 'BUY', eventTime: Number.NaN, volumeUsdt: 1 },
      { ...row('CCCUSDT', 'BUY', 5), backfilled: true },
    ];
    const selection = selectEvents(rows, { minUsd: 0, dedupeSec: 60 });
    expect(selection.invalid).toBe(2);
    expect(selection.events).toHaveLength(1);
    expect(selection.events[0].backfilled).toBe(true);
  });

  it('with a dedupe window of 0 keeps every row', () => {
    const selection = selectEvents([row('AAAUSDT', 'SELL', 0), row('AAAUSDT', 'SELL', 0), row('AAAUSDT', 'SELL', 1)], { minUsd: 0, dedupeSec: 0 });
    expect(selection.events).toHaveLength(3);
  });
});

describe('entry candle', () => {
  it('is the first candle that closes at or after the event, never one that closed before it', () => {
    expect(entryOpenTime(at(10) + 30_000)).toBe(at(10));      // Inside minute 10: enters at its close
    expect(entryOpenTime(at(10) + 1)).toBe(at(10));
    expect(entryOpenTime(at(10) + MINUTE - 1)).toBe(at(10));
    expect(entryOpenTime(at(10))).toBe(at(9));                // Exactly on the boundary: the candle that ends there
    for (let offset = 0; offset < 5 * MINUTE; offset += 7_321) {
      const eventTime = at(100) + offset;
      const open = entryOpenTime(eventTime);
      expect(open % MINUTE).toBe(0);
      expect(open + MINUTE).toBeGreaterThanOrEqual(eventTime);          // The close is not before the event
      expect(open + MINUTE - eventTime).toBeLessThan(MINUTE);           // ... and it is the first such close
    }
  });
});

describe('candleSeries', () => {
  it('drops candles without a usable close instead of treating them as a price', () => {
    const series = candleSeries([
      { openTime: at(0), close: 100 },
      { openTime: at(1), close: 0 },
      { openTime: at(2), close: Number.NaN },
      { openTime: at(3), close: -5 },
    ]);
    expect([...series.keys()]).toEqual([at(0)]);
  });
});

describe('estimateBeta', () => {
  const returns = marketReturns(400);
  const hedge = toSeries(pathFromReturns(returns, 100, 1));
  const entryOpen = at(260);

  it('recovers the beta of a synthetic correlated series', () => {
    const asset = toSeries(pathFromReturns(returns, 50, 2));
    const estimate = estimateBeta(asset, hedge, entryOpen, 240, 30);
    expect(estimate.beta).toBeCloseTo(2, 8);
    expect(estimate.raw).toBeCloseTo(2, 8);
    expect(estimate.observations).toBe(240);
    expect(estimate.fallback).toBe(false);
    expect(estimate.clamped).toBe(false);
  });

  it('clamps to [0, 3]', () => {
    const steep = estimateBeta(toSeries(pathFromReturns(returns, 50, 5)), hedge, entryOpen, 240, 30);
    expect(steep.raw).toBeCloseTo(5, 8);
    expect(steep.beta).toBe(3);
    expect(steep.clamped).toBe(true);
    expect(steep.fallback).toBe(false);

    const inverse = estimateBeta(toSeries(pathFromReturns(returns, 50, -1)), hedge, entryOpen, 240, 30);
    expect(inverse.raw).toBeCloseTo(-1, 8);
    expect(inverse.beta).toBe(0);
    expect(inverse.clamped).toBe(true);

    const edge = estimateBeta(toSeries(pathFromReturns(returns, 50, 3)), hedge, entryOpen, 240, 30);
    expect(edge.beta).toBeCloseTo(3, 8);
  });

  it('uses only the minutes that closed before the entry candle opened', () => {
    const asset = pathFromReturns(returns, 50, 2);
    const clean = estimateBeta(toSeries(asset), hedge, entryOpen, 240, 30);
    // Wild moves from the entry candle on, in the asset only: they must not reach the estimate
    const tainted = new Map(asset);
    for (let i = 260; i < 300; i++) tainted.set(at(i), i % 2 === 0 ? 5 : 500);
    expect(estimateBeta(tainted, hedge, entryOpen, 240, 30)).toEqual(clean);
    // ... and neither does the lookback reach past its length
    const old = new Map(asset);
    for (let i = 0; i < 18; i++) old.set(at(i), i % 2 === 0 ? 5 : 500);
    expect(estimateBeta(old, hedge, entryOpen, 240, 30).beta).toBeCloseTo(2, 8);
  });

  it('falls back to beta 1 with too little data, and says so', () => {
    const asset = pathFromReturns(returns, 50, 2);
    // Candles for the last 29 minutes before the entry only: 29 returns, below the minimum of 30
    const recent = (from: number) => toSeries(asset.filter(([open]) => open >= at(from)));
    const few = estimateBeta(recent(230), recent(230), entryOpen, 240, 30);
    expect(few).toMatchObject({ beta: BETA_FALLBACK, raw: null, fallback: true, clamped: false, observations: 29 });
    const enough = estimateBeta(recent(229), toSeries(pathFromReturns(returns, 100, 1).filter(([open]) => open >= at(229))), entryOpen, 240, 30);
    expect(enough).toMatchObject({ fallback: false, observations: 30 });
    expect(enough.beta).toBeCloseTo(2, 8);
  });

  it('falls back when the hedge or the asset has no candles, or the hedge never moved', () => {
    const asset = toSeries(pathFromReturns(returns, 50, 2));
    expect(estimateBeta(asset, undefined, entryOpen, 240, 30)).toMatchObject({ beta: 1, fallback: true, observations: 0 });
    expect(estimateBeta(undefined, hedge, entryOpen, 240, 30)).toMatchObject({ beta: 1, fallback: true, observations: 0 });
    const flat = new Map(pathFromReturns(returns.map(() => 0), 100, 1));
    expect(estimateBeta(asset, flat, entryOpen, 240, 30)).toMatchObject({ beta: 1, raw: null, fallback: true, observations: 240 });
  });

  it('never interpolates: minutes without a candle (or the one before it) are skipped', () => {
    const asset = toSeries(pathFromReturns(returns, 50, 2));
    // Every other hedge candle missing: no minute has both its candle and the one before it
    const sparse = new Map([...hedge].filter(([open]) => ((open - T0) / MINUTE) % 2 === 0));
    expect(estimateBeta(asset, sparse, entryOpen, 240, 30)).toMatchObject({ fallback: true, observations: 0 });
    // One missing candle costs the two returns around it
    const holed = new Map(hedge);
    holed.delete(at(200));
    const estimate = estimateBeta(asset, holed, entryOpen, 240, 30);
    expect(estimate.observations).toBe(238);
    expect(estimate.beta).toBeCloseTo(2, 8);
  });
});

describe('matchCrossPairs', () => {
  it('pairs opposite-direction signals on different symbols within the window, the later one triggering', () => {
    const a = event('AAAUSDT', 'SELL', 0);            // Long liquidation: buy
    const b = event('BBBUSDT', 'BUY', 100);           // Short liquidation: sell
    const pairs = matchCrossPairs([b, a], 120);       // Input order does not matter
    expect(pairs).toHaveLength(1);
    expect(pairs[0].trigger.symbol).toBe('BBBUSDT');
    expect(pairs[0].partner.symbol).toBe('AAAUSDT');
    expect(pairs[0].trigger.direction).toBe(-1);      // Short the symbol with the short-liquidation signal
    expect(pairs[0].partner.direction).toBe(1);       // Long the symbol with the long-liquidation signal
    expect(pairs[0].trigger.eventTime).toBeGreaterThanOrEqual(pairs[0].partner.eventTime);
  });

  it('includes the window edge and excludes anything past it', () => {
    expect(matchCrossPairs([event('AAAUSDT', 'SELL', 0), event('BBBUSDT', 'BUY', 120)], 120)).toHaveLength(1);
    expect(matchCrossPairs([event('AAAUSDT', 'SELL', 0), event('BBBUSDT', 'BUY', 121)], 120)).toHaveLength(0);
    expect(matchCrossPairs([event('AAAUSDT', 'SELL', 0), event('BBBUSDT', 'BUY', 121)], 121)).toHaveLength(1);
    expect(matchCrossPairs([event('AAAUSDT', 'SELL', 0), event('BBBUSDT', 'BUY', 0)], 120)).toHaveLength(1);   // Same instant
  });

  it('needs different symbols and opposite directions', () => {
    expect(matchCrossPairs([event('AAAUSDT', 'SELL', 0), event('AAAUSDT', 'BUY', 10)], 120)).toHaveLength(0);
    expect(matchCrossPairs([event('AAAUSDT', 'SELL', 0), event('BBBUSDT', 'SELL', 10)], 120)).toHaveLength(0);
    expect(matchCrossPairs([event('AAAUSDT', 'BUY', 0), event('BBBUSDT', 'BUY', 10)], 120)).toHaveLength(0);
  });

  it('pairs an event with the most recent fitting partner, once', () => {
    const a1 = event('AAAUSDT', 'SELL', 0);
    const a2 = event('CCCUSDT', 'SELL', 50);
    const b = event('BBBUSDT', 'BUY', 100);
    const c = event('DDDUSDT', 'BUY', 110);
    const pairs = matchCrossPairs([a1, a2, b, c], 120);
    // b takes a2 (the most recent), c takes the one left (a1); nobody is used twice
    expect(pairs.map(pair => [pair.trigger.symbol, pair.partner.symbol])).toEqual([['BBBUSDT', 'CCCUSDT'], ['DDDUSDT', 'AAAUSDT']]);
    const third = event('EEEUSDT', 'BUY', 115);
    expect(matchCrossPairs([a1, a2, b, c, third], 120)).toHaveLength(2);
  });

  it('counts the events that have a partner whether or not the matching used it', () => {
    const events = [event('AAAUSDT', 'SELL', 0), event('BBBUSDT', 'BUY', 10), event('CCCUSDT', 'BUY', 20), event('DDDUSDT', 'SELL', 1000)];
    expect(matchCrossPairs(events, 120)).toHaveLength(1);            // B pairs with A, so A is used up and C stays unpaired
    expect(countEventsWithPartner(events, 120)).toBe(3);             // ... but C also had a partner in A
    expect(countEventsWithPartner(events, 5)).toBe(0);
  });
});

describe('statistics', () => {
  it('computes percentiles by linear interpolation', () => {
    const values = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 5)).toBeCloseTo(5, 10);
    expect(percentile(values, 50)).toBeCloseTo(50, 10);
    expect(percentile(values, 100)).toBe(100);
    expect(percentile([10, 20], 50)).toBe(15);
    expect(percentile([7], 5)).toBe(7);
    expect(percentile([], 5)).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it('summarizes trades: mean, median, stdev, win rate, t, sharpe, tail, drawdown', () => {
    const returns = [2, 4, 4, 4, 5, 5, 7, 9];
    const metrics = summarizeTrades(returns.map(netBps => ({ netBps, exposure: 1 })));
    expect(metrics.n).toBe(8);
    expect(metrics.meanBps).toBeCloseTo(5, 10);
    expect(metrics.medianBps).toBeCloseTo(4.5, 10);
    expect(metrics.stdevBps).toBeCloseTo(Math.sqrt(32 / 7), 10);
    expect(metrics.winRate).toBe(1);
    expect(metrics.tStat).toBeCloseTo(5 / (Math.sqrt(32 / 7) / Math.sqrt(8)), 10);
    expect(metrics.sharpe).toBeCloseTo(5 / Math.sqrt(32 / 7), 10);
    expect(metrics.p5Bps).toBeCloseTo(2 + (4 - 2) * 0.35, 10);       // rank 0.35 of the sorted values
    expect(metrics.maxDrawdownBps).toBe(0);
    expect(metrics.meanExposure).toBe(1);
    expect(metrics.meanPerExposureBps).toBeCloseTo(5, 10);
  });

  it('counts a win only for a positive net return and divides the mean by the exposure', () => {
    const metrics = summarizeTrades([{ netBps: 10, exposure: 3 }, { netBps: 0, exposure: 3 }, { netBps: -4, exposure: 3 }, { netBps: 6, exposure: 3 }]);
    expect(metrics.winRate).toBe(0.5);
    expect(metrics.meanBps).toBe(3);
    expect(metrics.meanPerExposureBps).toBe(1);
  });

  it('reports no spread-based figure for fewer than two trades or no variation', () => {
    expect(summarizeTrades([])).toMatchObject({ n: 0, meanBps: null, tStat: null, maxDrawdownBps: null });
    expect(summarizeTrades([{ netBps: 5, exposure: 1 }])).toMatchObject({ n: 1, meanBps: 5, stdevBps: null, tStat: null, sharpe: null });
    expect(summarizeTrades([{ netBps: 5, exposure: 1 }, { netBps: 5, exposure: 1 }])).toMatchObject({ stdevBps: 0, tStat: null, sharpe: null });
    expect(stdev([1])).toBeNull();
  });

  it('summarizes paired differences with a paired t statistic', () => {
    const deltas = [10, 20, 30, 40];
    const stats = summarizeDeltas(deltas);
    expect(stats.n).toBe(4);
    expect(stats.meanBps).toBe(25);
    expect(stats.tStat).toBeCloseTo(25 / (stdev(deltas)! / 2), 10);
    expect(stats.winRate).toBe(1);
    expect(summarizeDeltas([])).toEqual({ n: 0, meanBps: null, stdevBps: null, tStat: null, winRate: null });
    expect(summarizeDeltas([-1, 1])).toMatchObject({ meanBps: 0, tStat: 0, winRate: 0.5 });
  });
});

describe('maxDrawdown', () => {
  it('is the largest fall of the cumulative P&L from its running peak', () => {
    // Cumulative: 10, 5, -3, 17, -13. Falls: 10 -> -3 is 13, 17 -> -13 is 30.
    expect(maxDrawdown([10, -5, -8, 20, -30])).toBe(30);
    // Cumulative: 10, 5, -3, 17, 12. Largest fall is 13 (from the peak of 10 to -3).
    expect(maxDrawdown([10, -5, -8, 20, -5])).toBe(13);
  });

  it('starts from zero, so a loss before the first gain counts', () => {
    expect(maxDrawdown([-5, -5])).toBe(10);
    expect(maxDrawdown([-5, 3, -1])).toBe(5);          // Cumulative -5, -2, -3: peak 0, trough -5
  });

  it('is zero without losses or without trades', () => {
    expect(maxDrawdown([])).toBe(0);
    expect(maxDrawdown([1, 2, 3])).toBe(0);
    expect(maxDrawdown([0, 0])).toBe(0);
  });

  it('depends on the order, not just the values', () => {
    expect(maxDrawdown([5, -3, -3, 5, -3, -3])).toBe(7);       // Cumulative 5, 2, -1, 4, 1, -2: from the peak of 5 to -2
    expect(maxDrawdown([-3, -3, 5, 5, -3, -3])).toBe(6);       // Cumulative -3, -6, -1, 4, 1, -2: 0 to -6, and 4 to -2
  });
});
