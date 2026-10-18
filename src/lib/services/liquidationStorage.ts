import { db as defaultDatabase, type Database } from '../db/database';
import { LiquidationEvent } from '../types';
import { VENUE_IDS } from '../exchange/types';
import { getLiquidationOrigin } from '../liquidation/origin';
import { createLogThrottle, suppressedSuffix } from '../utils/throttledLog';
import type { LighterLiquidationDetection } from '../liquidation/lighterLiquidationSource';

// global.liquidationRetentionDays default; 0 keeps everything
export const DEFAULT_LIQUIDATION_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// skip_reason of a Lighter detection that passed every gate but was not traded because the feed is in shadow mode
export const SHADOW_MODE_SKIP_REASON = 'shadow mode';

export type LiquidationRowSource = 'live' | 'backfill';
export type LiquidationFeedMode = 'live' | 'shadow';

export interface StoredLiquidation {
  id: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  order_type: string;
  quantity: number;
  price: number;
  average_price: number;
  volume_usdt: number;
  order_status: string;
  order_last_filled_quantity: number;
  order_filled_accumulated_quantity: number;
  order_trade_time: number;
  event_time: number;
  created_at: number;
  metadata: string | null;
  venue: string;                       // 'aster' | 'lighter'
  source: LiquidationRowSource;        // Recorded live, or loaded by a history backfill
  external_id: string | null;          // Venue's id for the liquidation (Lighter group key); null for Aster
  skip_reason: string | null;          // null = sent to the hunter (or, for backfill rows, passed the side gates)
  mode: LiquidationFeedMode | null;    // Lighter feed mode when recorded live
}

// Which rows a read returns. Lighter detections that a gate dropped (stale, LLP takeover, unverified side, ...)
// are not liquidations the bot would have traded: unless includeSkipped is set, only rows that were sent to the
// hunter or held back by shadow mode alone are returned.
export interface LiquidationScope {
  venue?: string;
  includeSkipped?: boolean;            // Default false
}

// ?venue= and ?includeSkipped= of the liquidation endpoints; an error message for an unknown venue
export function parseLiquidationScope(searchParams: URLSearchParams): LiquidationScope | { error: string } {
  const venue = searchParams.get('venue') || undefined;
  if (venue !== undefined && !(VENUE_IDS as readonly string[]).includes(venue)) {
    return { error: `venue must be one of: ${VENUE_IDS.join(', ')}` };
  }
  const includeSkipped = searchParams.get('includeSkipped');
  return { venue, includeSkipped: includeSkipped === 'true' || includeSkipped === '1' };
}

export interface LiquidationQueryParams extends LiquidationScope {
  symbol?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

export interface LiquidationStats {
  total_count: number;
  total_volume_usdt: number;
  avg_volume_usdt: number;
  max_volume_usdt: number;
  symbols: Array<{
    symbol: string;
    count: number;
    volume_usdt: number;
  }>;
}

// A venue liquidation as the detection recorder and the backfill write it (prices and quantities in bot units)
export interface LiquidationRecord {
  venue: string;
  source: LiquidationRowSource;
  externalId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  volumeUsdt: number;
  eventTime: number;                   // ms
  skipReason: string | null;
  mode: LiquidationFeedMode | null;
  metadata?: Record<string, unknown>;
}

export interface CandleRecord {
  venue: string;
  symbol: string;                      // Bot symbol
  interval: string;                    // '1m', ...
  openTime: number;                    // ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;                      // Base volume in bot units
}

const INSERT_COLUMNS = `
  symbol, side, order_type, quantity, price, average_price,
  volume_usdt, order_status, order_last_filled_quantity,
  order_filled_accumulated_quantity, order_trade_time,
  event_time, metadata, venue, source, external_id, skip_reason, mode
`;
const INSERT_VALUES = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
// Matches the partial unique index idx_liquidations_venue_external_id
const ON_EXTERNAL_ID_CONFLICT = 'ON CONFLICT(venue, external_id) WHERE external_id IS NOT NULL';

// WHERE conditions (and their parameters) of a scope
function scopeConditions(scope: LiquidationScope): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (scope.venue) {
    conditions.push('venue = ?');
    params.push(scope.venue);
  }
  if (!scope.includeSkipped) {
    conditions.push('(skip_reason IS NULL OR skip_reason = ?)');
    params.push(SHADOW_MODE_SKIP_REASON);
  }
  return { conditions, params };
}

function retentionCutoff(retentionDays: number, now: number): number | null {
  const days = Number.isFinite(retentionDays) ? retentionDays : DEFAULT_LIQUIDATION_RETENTION_DAYS;
  return days > 0 ? now - days * DAY_MS : null;
}

function recordParams(record: LiquidationRecord): unknown[] {
  return [
    record.symbol,
    record.side,
    'LIMIT',
    record.quantity,
    record.price,
    record.price,
    record.volumeUsdt,
    'FILLED',
    record.quantity,
    record.quantity,
    record.eventTime,
    record.eventTime,
    JSON.stringify(record.metadata ?? {}),
    record.venue,
    record.source,
    record.externalId,
    record.skipReason,
    record.mode,
  ];
}

// The row a Lighter feed detection becomes; null for markets that aren't mapped to a bot symbol
export function lighterDetectionRecord(detection: LighterLiquidationDetection): LiquidationRecord | null {
  const event = detection.event;
  if (!event) return null;
  let skipReason: string | null = null;
  if (!detection.emitted) {
    if (detection.dropReasons.length > 0) skipReason = detection.dropReasons.join('; ');
    else skipReason = detection.live ? 'not sent to the hunter' : SHADOW_MODE_SKIP_REASON;
  }
  return {
    venue: 'lighter',
    source: 'live',
    externalId: detection.key,
    symbol: event.symbol,
    side: event.side,
    quantity: event.quantity,
    price: event.price,
    volumeUsdt: event.qty * event.price,      // As the hunter measures it against the thresholds
    eventTime: event.eventTime,
    skipReason,
    mode: detection.live ? 'live' : 'shadow',
    metadata: {
      orderType: event.orderType,
      originalQty: event.qty,
      originalTime: event.time,
      marketId: detection.marketId,
      txHash: detection.txHash,
      notionalUsd: detection.notionalUsd,
      tradeIds: detection.tradeIds,
      excludedTradeIds: detection.excludedTradeIds,
      notes: detection.notes,
    },
  };
}

// A database that stays unusable fails every save: the error is logged once a minute
const SAVE_ERROR_LOG_INTERVAL_MS = 60_000;

export class LiquidationStorage {
  private readonly throttleSaveErrors = createLogThrottle(SAVE_ERROR_LOG_INTERVAL_MS);
  private readonly throttleDetectionErrors = createLogThrottle(SAVE_ERROR_LOG_INTERVAL_MS);

  constructor(private readonly db: Database = defaultDatabase) {}

  // The hunter's copy of a liquidation it received. Venue events carry their origin (the Lighter feed's group key),
  // so a liquidation the detection recorder already stored is not stored twice.
  async saveLiquidation(event: LiquidationEvent, volumeUSDT: number): Promise<void> {
    const origin = getLiquidationOrigin(event);
    const sql = `
      INSERT INTO liquidations (${INSERT_COLUMNS})
      VALUES ${INSERT_VALUES}
      ${ON_EXTERNAL_ID_CONFLICT} DO NOTHING
    `;

    const metadata = JSON.stringify({
      orderType: event.orderType,
      originalQty: event.qty,
      originalTime: event.time
    });

    const params = [
      event.symbol,
      event.side,
      event.orderType,
      event.quantity,
      event.price,
      event.averagePrice,
      volumeUSDT,
      event.orderStatus,
      event.orderLastFilledQuantity,
      event.orderFilledAccumulatedQuantity,
      event.orderTradeTime,
      event.eventTime,
      metadata,
      origin?.venue ?? 'aster',
      'live',
      origin?.externalId ?? null,
      null,
      origin?.mode ?? null
    ];

    try {
      await this.db.run(sql, params);
    } catch (error) {
      this.throttleSaveErrors((skipped) => console.error(`Error saving liquidation${suppressedSuffix(skipped)}:`, error));
    }
  }

  // Every liquidation the Lighter feed detected, traded or not (skip_reason says why not). Merges with the
  // hunter's copy and with a backfilled row of the same liquidation: once a row says it was sent to the hunter
  // it keeps saying so, and the detection's metadata (trade ids, notes) replaces the thinner copy of the hunter or
  // the backfill (which has no book check). Returns false for unmapped markets (not stored).
  async saveLighterDetection(detection: LighterLiquidationDetection): Promise<boolean> {
    const record = lighterDetectionRecord(detection);
    if (!record) return false;
    // The thinner copy is told apart by its metadata: only a detection writes tradeIds. instr, not json_extract,
    // so the statement doesn't depend on SQLite's JSON functions being compiled in.
    await this.db.run(
      `INSERT INTO liquidations (${INSERT_COLUMNS})
       VALUES ${INSERT_VALUES}
       ${ON_EXTERNAL_ID_CONFLICT} DO UPDATE SET
         skip_reason = CASE
           WHEN liquidations.source = 'live' AND liquidations.skip_reason IS NULL THEN NULL
           ELSE excluded.skip_reason
         END,
         mode = COALESCE(excluded.mode, liquidations.mode),
         metadata = CASE
           WHEN liquidations.source = 'backfill' OR COALESCE(instr(liquidations.metadata, '"tradeIds"'), 0) = 0
           THEN excluded.metadata
           ELSE liquidations.metadata
         END,
         source = 'live'`,
      recordParams(record)
    );
    return true;
  }

  // saveLighterDetection for the feed's onDetection hook: a failure is logged (at most once a minute), not thrown,
  // because recording must never get in the way of trading
  async recordLighterDetection(detection: LighterLiquidationDetection): Promise<void> {
    try {
      await this.saveLighterDetection(detection);
    } catch (error) {
      this.throttleDetectionErrors((skipped) =>
        console.error(`Failed to store Lighter liquidation detection${suppressedSuffix(skipped)}:`, error instanceof Error ? error.message : error)
      );
    }
  }

  // Historical rows (one transaction). Rows already stored, live or from an earlier run, are left as they are.
  // Returns how many were new.
  async saveBackfilledLiquidations(records: LiquidationRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    return this.db.transaction(async () => {
      let inserted = 0;
      for (const record of records) {
        const result = await this.db.run(
          `INSERT INTO liquidations (${INSERT_COLUMNS}) VALUES ${INSERT_VALUES} ${ON_EXTERNAL_ID_CONFLICT} DO NOTHING`,
          recordParams(record)
        );
        inserted += result.changes;
      }
      return inserted;
    });
  }

  async getLiquidations(params: LiquidationQueryParams = {}): Promise<{
    liquidations: StoredLiquidation[];
    total: number;
  }> {
    const { conditions, params: queryParams } = scopeConditions(params);

    if (params.symbol) {
      conditions.push('symbol = ?');
      queryParams.push(params.symbol);
    }

    if (params.from) {
      conditions.push('event_time >= ?');
      queryParams.push(params.from);
    }

    if (params.to) {
      conditions.push('event_time <= ?');
      queryParams.push(params.to);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countSql = `SELECT COUNT(*) as total FROM liquidations ${whereClause}`;
    const countResult = await this.db.get<{ total: number }>(countSql, queryParams);
    const total = countResult?.total || 0;

    const limit = params.limit || 100;
    const offset = params.offset || 0;

    const sql = `
      SELECT * FROM liquidations
      ${whereClause}
      ORDER BY event_time DESC
      LIMIT ? OFFSET ?
    `;

    const liquidations = await this.db.all<StoredLiquidation>(
      sql,
      [...queryParams, limit, offset]
    );

    return { liquidations, total };
  }

  // Deletes liquidations whose event is older than the retention (event time, so backfilled rows age like live
  // ones). retentionDays 0 keeps everything.
  async cleanupOldLiquidations(retentionDays: number = DEFAULT_LIQUIDATION_RETENTION_DAYS, now: number = Date.now()): Promise<number> {
    const cutoff = retentionCutoff(retentionDays, now);
    if (cutoff === null) {
      console.log('Liquidation retention is 0 days (keep forever): nothing cleaned up');
      return 0;
    }

    const result = await this.db.run('DELETE FROM liquidations WHERE event_time < ?', [cutoff]);

    console.log(`Cleaned up ${result.changes} liquidations older than ${retentionDays} days`);
    return result.changes;
  }

  // Candles follow the liquidation retention
  async cleanupOldCandles(retentionDays: number = DEFAULT_LIQUIDATION_RETENTION_DAYS, now: number = Date.now()): Promise<number> {
    const cutoff = retentionCutoff(retentionDays, now);
    if (cutoff === null) return 0;
    const result = await this.db.run('DELETE FROM candles WHERE open_time < ?', [cutoff]);
    if (result.changes > 0) console.log(`Cleaned up ${result.changes} candles older than ${retentionDays} days`);
    return result.changes;
  }

  // Window over the event time (backfilled rows are stored long after their event)
  async getStatistics(timeWindowSeconds: number = 86400, scope: LiquidationScope = {}): Promise<LiquidationStats> {
    try {
      const since = Date.now() - timeWindowSeconds * 1000;
      const { conditions, params: scopeParams } = scopeConditions(scope);
      const whereClause = ['event_time >= ?', ...conditions].join(' AND ');
      const queryParams = [since, ...scopeParams];

      const statsSql = `
        SELECT
          COUNT(*) as total_count,
          SUM(volume_usdt) as total_volume_usdt,
          AVG(volume_usdt) as avg_volume_usdt,
          MAX(volume_usdt) as max_volume_usdt
        FROM liquidations
        WHERE ${whereClause}
      `;

      const stats = await this.db.get<{
        total_count: number;
        total_volume_usdt: number;
        avg_volume_usdt: number;
        max_volume_usdt: number;
      }>(statsSql, queryParams);

      const symbolsSql = `
        SELECT
          symbol,
          COUNT(*) as count,
          SUM(volume_usdt) as volume_usdt
        FROM liquidations
        WHERE ${whereClause}
        GROUP BY symbol
        ORDER BY volume_usdt DESC
        LIMIT 10
      `;

      const symbols = await this.db.all<{
        symbol: string;
        count: number;
        volume_usdt: number;
      }>(symbolsSql, queryParams);

      return {
        total_count: stats?.total_count || 0,
        total_volume_usdt: stats?.total_volume_usdt || 0,
        avg_volume_usdt: stats?.avg_volume_usdt || 0,
        max_volume_usdt: stats?.max_volume_usdt || 0,
        symbols: symbols || []
      };
    } catch (error) {
      console.error('Error getting liquidation statistics:', error);
      // Return empty stats on error
      return {
        total_count: 0,
        total_volume_usdt: 0,
        avg_volume_usdt: 0,
        max_volume_usdt: 0,
        symbols: []
      };
    }
  }

  async getRecentLiquidations(limit: number = 50, scope: LiquidationScope = {}): Promise<StoredLiquidation[]> {
    const { conditions, params } = scopeConditions(scope);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT * FROM liquidations
      ${whereClause}
      ORDER BY event_time DESC
      LIMIT ?
    `;

    return await this.db.all<StoredLiquidation>(sql, [...params, limit]);
  }

  // Upsert (the newest candle is still forming when first stored). Returns how many rows were written.
  async saveCandles(candles: CandleRecord[]): Promise<number> {
    if (candles.length === 0) return 0;
    return this.db.transaction(async () => {
      let written = 0;
      for (const candle of candles) {
        const result = await this.db.run(
          `INSERT INTO candles (venue, symbol, interval, open_time, open, high, low, close, volume)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(venue, symbol, interval, open_time) DO UPDATE SET
             open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume`,
          [candle.venue, candle.symbol, candle.interval, candle.openTime, candle.open, candle.high, candle.low, candle.close, candle.volume]
        );
        written += result.changes;
      }
      return written;
    });
  }

  async getCandles(venue: string, symbol: string, interval: string, fromMs: number, toMs: number): Promise<CandleRecord[]> {
    const rows = await this.db.all<{
      venue: string; symbol: string; interval: string; open_time: number;
      open: number; high: number; low: number; close: number; volume: number;
    }>(
      `SELECT * FROM candles WHERE venue = ? AND symbol = ? AND interval = ? AND open_time >= ? AND open_time <= ?
       ORDER BY open_time`,
      [venue, symbol, interval, fromMs, toMs]
    );
    return rows.map(row => ({
      venue: row.venue,
      symbol: row.symbol,
      interval: row.interval,
      openTime: row.open_time,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    }));
  }
}

export const liquidationStorage = new LiquidationStorage();
