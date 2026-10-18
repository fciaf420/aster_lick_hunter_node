import { Database } from '../../../src/lib/db/database';
import { LiquidationStorage, type CandleRecord, type LiquidationRecord } from '../../../src/lib/services/liquidationStorage';

// Synthetic liquidations and candles for the pair-analysis suites: a real database file (the same schema the bot and
// lighter:backfill create), filled with prices built so that the right answer is known.

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);          // A minute boundary
export const NOW = T0 + 40 * DAY;                         // After every candle used

export interface SyntheticLiquidation {
  symbol: string;
  side: 'BUY' | 'SELL';
  eventTime: number;
  volumeUsdt?: number;                                    // Default 10000
  venue?: string;                                         // Default lighter
  skipReason?: string | null;                             // Default null (tradable)
  source?: 'live' | 'backfill';                           // Default live
}

export interface SyntheticSpec {
  liquidations?: SyntheticLiquidation[];
  candles?: Record<string, Array<[number, number]>>;      // Symbol -> [open time, close]
  candleVenue?: string;                                   // Default lighter
}

export async function writeSyntheticDb(file: string, spec: SyntheticSpec): Promise<void> {
  const db = new Database(file);
  try {
    await db.initialize();                                // Creates the file and schema even when there is nothing to write
    const storage = new LiquidationStorage(db);
    const records: LiquidationRecord[] = (spec.liquidations ?? []).map((row, index) => ({
      venue: row.venue ?? 'lighter',
      source: row.source ?? 'live',
      externalId: `synthetic-${index}`,
      symbol: row.symbol,
      side: row.side,
      quantity: 1,
      price: row.volumeUsdt ?? 10_000,
      volumeUsdt: row.volumeUsdt ?? 10_000,
      eventTime: row.eventTime,
      skipReason: row.skipReason ?? null,
      mode: null,
    }));
    await storage.saveBackfilledLiquidations(records);
    const candles: CandleRecord[] = [];
    for (const [symbol, points] of Object.entries(spec.candles ?? {})) {
      for (const [openTime, close] of points) {
        candles.push({ venue: spec.candleVenue ?? 'lighter', symbol, interval: '1m', openTime, open: close, high: close, low: close, close, volume: 1 });
      }
    }
    await storage.saveCandles(candles);
  } finally {
    await db.close();
  }
}

// Open time of the candle `index` minutes after T0
export const at = (index: number): number => T0 + index * MINUTE;

// [open time, close] for `count` candles from candle index `from`: `base`, except the indexes in `overrides`
export function flatPath(from: number, count: number, base: number, overrides: Record<number, number> = {}): Array<[number, number]> {
  return Array.from({ length: count }, (_, i) => [at(from + i), overrides[from + i] ?? base] as [number, number]);
}

// Deterministic pseudo-random numbers in [0, 1)
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 1m log returns of a made-up market, roughly +-0.1% a minute
export function marketReturns(count: number, seed = 7): number[] {
  const random = mulberry32(seed);
  return Array.from({ length: count }, () => (random() - 0.5) * 0.002);
}

// Candles from index 0: the close of candle i + 1 is the close of candle i times exp(multiplier x returns[i]), so an
// asset built with multiplier 2 from the same returns as the hedge has a beta of exactly 2. Returns [open, close][].
export function pathFromReturns(returns: readonly number[], base: number, multiplier = 1): Array<[number, number]> {
  const points: Array<[number, number]> = [[at(0), base]];
  let price = base;
  returns.forEach((value, i) => {
    price *= Math.exp(multiplier * value);
    points.push([at(i + 1), price]);
  });
  return points;
}

// The same path as a Map of closes by open time, for the pure functions
export function toSeries(points: ReadonlyArray<[number, number]>): Map<number, number> {
  return new Map(points);
}
