import fs from 'fs';
import { LIGHTER_CANDLE_INTERVAL } from '../lighterHistory/backfill';
import { SHADOW_MODE_SKIP_REASON } from '../services/liquidationStorage';
import { MINUTE_MS, candleSeries, type CandleSeries, type LiquidationRow } from './pairAnalysis';

// Reads what pairAnalysis.ts needs from the SQLite file the bot, lighter:backfill and the optimizer share: the
// `liquidations` and `candles` tables. Read-only (like the optimizer's connection), so it can run while the bot does.
// better-sqlite3 has no bundled types here, hence the small interface for the part used.

interface ReadonlyStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface ReadonlyConnection {
  prepare(sql: string): ReadonlyStatement;
  close(): void;
}

type ConnectionConstructor = new (file: string, options: { readonly: boolean; fileMustExist: boolean }) => ReadonlyConnection;

export interface PairAnalysisQuery {
  venue: string;                                    // Whose liquidations
  candleVenue: string;                              // Whose candles
  includeSkipped: boolean;                          // Also the detections a gate dropped
  symbols?: readonly string[];
  sinceMs?: number;                                 // Event time, inclusive
  untilMs?: number;                                 // Event time, exclusive
  hedgeSymbols: readonly string[];                  // Their candles are loaded too
  betaLookbackMin: number;
  maxHorizonMin: number;
}

export interface PairAnalysisInput {
  dbPath: string;
  rows: LiquidationRow[];                           // Oldest first
  series: Map<string, CandleSeries>;                // Close by open time, per bot symbol
  candlesLoaded: Record<string, number>;
  notes: string[];                                  // Things the database lacks (old schema, no candles table)
}

function tableExists(db: ReadonlyConnection, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function tableColumns(db: ReadonlyConnection, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA main.table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name));
}

// The tradable scope of the Lighter optimizer (scripts/optimizer-venue.js): skip_reason empty, or held back by shadow
// mode alone; includeSkipped adds the detections a gate dropped. A database from before the venue column holds Aster
// rows only. The scope is the same for both venues; see the skip_reason condition below for why it is harmless for Aster.
export function loadPairAnalysisInput(dbPath: string, query: PairAnalysisQuery): PairAnalysisInput {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`No database at ${dbPath}. Record or load liquidations first (npm run lighter:backfill), or set LIQUIDATIONS_DB_PATH.`);
  }
  const BetterSqlite = require('better-sqlite3') as ConnectionConstructor;
  const db = new BetterSqlite(dbPath, { readonly: true, fileMustExist: true });
  try {
    const notes: string[] = [];
    const rows: LiquidationRow[] = [];
    if (!tableExists(db, 'liquidations')) {
      notes.push('The database has no liquidations table.');
    } else {
      const columns = tableColumns(db, 'liquidations');
      const conditions: string[] = [];
      const params: unknown[] = [];
      let readable = true;
      if (columns.has('venue')) {
        conditions.push('venue = ?');
        params.push(query.venue);
      } else if (query.venue !== 'aster') {
        notes.push(`The database predates the venue column: all its liquidations are Aster's, so there are none for ${query.venue}.`);
        readable = false;
      }
      // Only the Lighter detection recorder and lighter:backfill write a skip_reason. Aster rows come from
      // LiquidationStorage.saveLiquidation, which always stores NULL, and rows from before the column have none, so for
      // --venue aster this condition keeps every row and --include-skipped changes nothing.
      if (!query.includeSkipped && columns.has('skip_reason')) {
        conditions.push('(skip_reason IS NULL OR skip_reason = ?)');
        params.push(SHADOW_MODE_SKIP_REASON);
      }
      if (query.symbols && query.symbols.length > 0) {
        conditions.push(`symbol IN (${query.symbols.map(() => '?').join(', ')})`);
        params.push(...query.symbols);
      }
      if (query.sinceMs !== undefined) {
        conditions.push('event_time >= ?');
        params.push(query.sinceMs);
      }
      if (query.untilMs !== undefined) {
        conditions.push('event_time < ?');
        params.push(query.untilMs);
      }
      if (readable) {
        const source = columns.has('source') ? 'source' : "'live' AS source";
        const sql = `SELECT id, symbol, side, event_time, volume_usdt, ${source} FROM main.liquidations` +
          `${conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY event_time, id`;
        for (const row of db.prepare(sql).all(...params) as Array<{ id: number; symbol: string; side: string; event_time: number; volume_usdt: number; source: string }>) {
          rows.push({ id: row.id, symbol: row.symbol, side: row.side, eventTime: row.event_time, volumeUsdt: row.volume_usdt, backfilled: row.source === 'backfill' });
        }
      }
    }

    const series = new Map<string, CandleSeries>();
    const candlesLoaded: Record<string, number> = {};
    if (rows.length > 0) {
      if (!tableExists(db, 'candles')) {
        notes.push('The database has no candles table.');
      } else {
        // From the beta lookback (plus the candle before its first return) before the first event to the last
        // exit (plus the entry candle and a margin) after the last
        const from = rows[0].eventTime - (query.betaLookbackMin + 3) * MINUTE_MS;
        const to = rows[rows.length - 1].eventTime + (query.maxHorizonMin + 3) * MINUTE_MS;
        const statement = db.prepare('SELECT open_time, close FROM main.candles WHERE venue = ? AND symbol = ? AND interval = ? AND open_time >= ? AND open_time <= ?');
        const symbols = new Set([...rows.map(row => row.symbol), ...query.hedgeSymbols]);
        for (const symbol of [...symbols].sort()) {
          const found = statement.all(query.candleVenue, symbol, LIGHTER_CANDLE_INTERVAL, from, to) as Array<{ open_time: number; close: number }>;
          const loaded = candleSeries(found.map(candle => ({ openTime: candle.open_time, close: candle.close })));
          series.set(symbol, loaded);
          candlesLoaded[symbol] = loaded.size;
        }
      }
    }
    return { dbPath, rows, series, candlesLoaded, notes };
  } finally {
    db.close();
  }
}
