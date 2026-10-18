/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import BetterSqlite from 'better-sqlite3';
import sqlite3 from 'sqlite3';
import { Database } from '../../../src/lib/db/database';
import {
  LiquidationStorage,
  SHADOW_MODE_SKIP_REASON,
  lighterDetectionRecord,
  parseLiquidationScope,
  type LiquidationRecord,
} from '../../../src/lib/services/liquidationStorage';
import { CleanupScheduler } from '../../../src/lib/services/cleanupScheduler';
import { setLiquidationOrigin } from '../../../src/lib/liquidation/origin';
import type { LighterLiquidationDetection } from '../../../src/lib/liquidation/lighterLiquidationSource';
import type { LiquidationEvent } from '../../../src/lib/types';
import { HISTORY_TEST_TIMEOUT_MS, holdLock, killLockHolders, removeTmpDir } from './tmp';

jest.setTimeout(HISTORY_TEST_TIMEOUT_MS);

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);

let tmpDir: string;
const open: Database[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liq-history-'));
});

afterEach(async () => {
  killLockHolders();
  while (open.length > 0) await open.pop()!.close();
  removeTmpDir(tmpDir);
});

function database(file = 'liquidations.db'): Database {
  const db = new Database(path.join(tmpDir, file));
  open.push(db);
  return db;
}

function event(overrides: Partial<LiquidationEvent> = {}): LiquidationEvent {
  const time = overrides.eventTime ?? NOW;
  return {
    symbol: 'BTCUSDT',
    side: 'SELL',
    orderType: 'LIMIT',
    quantity: 0.5,
    price: 100000,
    averagePrice: 100000,
    orderStatus: 'FILLED',
    orderLastFilledQuantity: 0.5,
    orderFilledAccumulatedQuantity: 0.5,
    orderTradeTime: time,
    eventTime: time,
    qty: 0.5,
    time,
    ...overrides,
  };
}

function detection(overrides: Partial<LighterLiquidationDetection> = {}): LighterLiquidationDetection {
  const ev = event();
  return {
    key: '1:abc:42',
    marketId: 1,
    botSymbol: 'BTCUSDT',
    side: 'SELL',
    quantity: 0.5,
    averagePrice: 100000,
    notionalUsd: 50000,
    eventTime: NOW,
    ageMs: 300,
    tradeIds: ['7', '8'],
    excludedTradeIds: [],
    txHash: 'abc',
    event: ev,
    live: true,
    emitted: true,
    dropReasons: [],
    notes: [],
    bbo: null,
    ...overrides,
  };
}

function backfillRecord(overrides: Partial<LiquidationRecord> = {}): LiquidationRecord {
  return {
    venue: 'lighter',
    source: 'backfill',
    externalId: '1:abc:42',
    symbol: 'BTCUSDT',
    side: 'SELL',
    quantity: 0.5,
    price: 100000,
    volumeUsdt: 50000,
    eventTime: NOW,
    skipReason: null,
    mode: null,
    ...overrides,
  };
}

// The liquidations table as the first release created it, with one row
async function createOldDatabase(file: string): Promise<void> {
  const raw = new sqlite3.Database(file);
  await new Promise<void>((resolve, reject) => raw.exec(`
    CREATE TABLE liquidations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, side TEXT NOT NULL, order_type TEXT,
      quantity REAL NOT NULL, price REAL NOT NULL, average_price REAL, volume_usdt REAL NOT NULL, order_status TEXT,
      order_last_filled_quantity REAL, order_filled_accumulated_quantity REAL, order_trade_time INTEGER,
      event_time INTEGER NOT NULL, created_at INTEGER DEFAULT (strftime('%s', 'now')), metadata TEXT
    );
    INSERT INTO liquidations (symbol, side, quantity, price, volume_usdt, event_time) VALUES ('ASTERUSDT', 'SELL', 10, 1.5, 15, ${NOW});
  `, (err) => (err ? reject(err) : resolve())));
  await new Promise<void>((resolve) => raw.close(() => resolve()));
}

describe('schema migration', () => {
  it('adds the venue columns to an existing database: old rows become Aster live rows', async () => {
    const file = path.join(tmpDir, 'old.db');
    await createOldDatabase(file);
    const db = database('old.db');

    const columns = (await db.all<{ name: string }>('PRAGMA table_info(liquidations)')).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['venue', 'source', 'external_id', 'skip_reason', 'mode']));
    const row = await db.get('SELECT symbol, venue, source, external_id, skip_reason, mode FROM liquidations');
    expect(row).toEqual({ symbol: 'ASTERUSDT', venue: 'aster', source: 'live', external_id: null, skip_reason: null, mode: null });

    const indexes = await db.all<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'liquidations'");
    const unique = indexes.find((index) => index.name === 'idx_liquidations_venue_external_id');
    expect(unique?.sql.replace(/\s+/g, ' ')).toMatch(/UNIQUE INDEX .*\(venue, external_id\) WHERE external_id IS NOT NULL/);
    const candles = await db.all<{ name: string }>('PRAGMA table_info(candles)');
    expect(candles.map((c) => c.name)).toEqual(['venue', 'symbol', 'interval', 'open_time', 'open', 'high', 'low', 'close', 'volume']);
  });

  it('is idempotent: reopening a migrated database changes nothing', async () => {
    const file = path.join(tmpDir, 'old.db');
    await createOldDatabase(file);
    const first = database('old.db');
    await first.initialize();
    await first.close();
    const second = database('old.db');
    expect(await second.get<{ n: number }>('SELECT COUNT(*) AS n FROM liquidations')).toEqual({ n: 1 });
  });

  it('opens the file lazily (importing storage does not create a database)', async () => {
    const db = database('lazy.db');
    expect(fs.existsSync(path.join(tmpDir, 'lazy.db'))).toBe(false);
    await db.initialize();
    expect(fs.existsSync(path.join(tmpDir, 'lazy.db'))).toBe(true);
  });
});

describe('database file', () => {
  const tableInfo = (db: Database, table: string) =>
    db.all<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>(`PRAGMA table_info(${table})`);

  const tableInfoOf = (db: Database) => tableInfo(db, 'liquidations');

  function alterStatements(spy: jest.SpyInstance): string[] {
    return spy.mock.calls.map((call) => String(call[0])).filter((sql) => /ALTER TABLE/i.test(sql));
  }

  it('creates a new file with the full schema, without any ALTER', async () => {
    const exec = jest.spyOn(sqlite3.Database.prototype, 'exec');
    try {
      const fresh = database('fresh.db');
      await fresh.initialize();
      expect(alterStatements(exec)).toEqual([]);

      // Same columns, in the same order, with the same types and defaults as an old file after the migration
      await createOldDatabase(path.join(tmpDir, 'old.db'));
      const migrated = database('old.db');
      await migrated.initialize();
      expect(alterStatements(exec)).toHaveLength(5);
      expect(await tableInfo(fresh, 'liquidations')).toEqual(await tableInfo(migrated, 'liquidations'));
      expect(await fresh.all("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name"))
        .toEqual(await migrated.all("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name"));
    } finally {
      exec.mockRestore();
    }
  });

  it('is migrated by one writer when the bot, the backfill and the web app open the same file at once', async () => {
    // Three connections: each one waiting for the lock holds a thread of libuv's pool (4 threads), and the holder
    // needs one more to finish, so a fourth waiter would stall this test (not the bot: it has one connection)
    for (const kind of ['new', 'old']) {
      const file = path.join(tmpDir, `${kind}-race.db`);
      if (kind === 'old') await createOldDatabase(file);
      const opens = Array.from({ length: 3 }, () => new Database(file));
      open.push(...opens);
      await Promise.all(opens.map((db) => db.initialize()));
      for (const db of opens) {
        const columns = (await tableInfo(db, 'liquidations')).map((column) => column.name);
        expect(columns).toEqual(expect.arrayContaining(['venue', 'source', 'external_id', 'skip_reason', 'mode']));
        expect(new Set(columns).size).toBe(columns.length);
      }
      expect((await opens[0].get<{ n: number }>('SELECT COUNT(*) AS n FROM liquidations'))!.n).toBe(kind === 'old' ? 1 : 0);
    }
  });

  it('leaves the file untouched when the schema step fails: it is one transaction', async () => {
    const file = path.join(tmpDir, 'broken.db');
    await createOldDatabase(file);
    // The last statement of the step (the unique index) can't be created over a table of that name
    const raw = new BetterSqlite(file);
    raw.exec('CREATE TABLE idx_liquidations_venue_external_id (x)');
    raw.close();
    const db = database('broken.db');
    await db.initialize();   // Fails and is logged, not thrown
    await expect(db.get('SELECT 1')).rejects.toThrow(/already a table named idx_liquidations_venue_external_id/);

    // The columns added before the failure went with it, and no transaction is left open
    const check = new BetterSqlite(file);
    try {
      const names = () => (check.prepare('PRAGMA table_info(liquidations)').all() as Array<{ name: string }>).map((column) => column.name);
      expect(names()).not.toContain('venue');
      expect(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'candles'").get()).toEqual({ n: 0 });
      check.exec('DROP TABLE idx_liquidations_venue_external_id');
    } finally {
      check.close();
    }
    expect(await db.get('SELECT symbol, venue FROM liquidations')).toEqual({ symbol: 'ASTERUSDT', venue: 'aster' });
  });

  it('waits for, and retries after, another process holding the write lock', async () => {
    const file = path.join(tmpDir, 'locked.db');
    await createOldDatabase(file);
    const holder = await holdLock(file, 'write');
    // Busy timeout 20 ms: the first attempt fails with SQLITE_BUSY; the retries (250 ms apart) outlast the lock
    const db = new Database(file, { busyTimeoutMs: 20 });
    open.push(db);
    const opening = db.initialize();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await holder.release();
    await opening;
    expect(await db.get<{ venue: string }>('SELECT venue FROM liquidations')).toEqual({ venue: 'aster' });
  });

  it('retries the schema step when a reader blocks its commit', async () => {
    const file = path.join(tmpDir, 'reader.db');
    await createOldDatabase(file);
    const reader = await holdLock(file, 'read');
    // The step gets the write lock and does its DDL, but COMMIT waits for the reader (20 ms) and fails: it is retried
    const db = new Database(file, { busyTimeoutMs: 20 });
    open.push(db);
    const opening = db.initialize();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await reader.release();
    await opening;
    const columns = (await tableInfoOf(db)).map((column) => column.name);
    expect(columns.filter((name) => name === 'venue')).toHaveLength(1);
    expect(await db.get('SELECT symbol, venue FROM liquidations')).toEqual({ symbol: 'ASTERUSDT', venue: 'aster' });
  });

  it('gives up with the busy error when the lock outlasts every retry, and opens once it is free', async () => {
    const file = path.join(tmpDir, 'stuck.db');
    await createOldDatabase(file);
    const holder = await holdLock(file, 'write');
    const db = new Database(file, { busyTimeoutMs: 10 });
    open.push(db);
    await expect(db.get('SELECT 1')).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
    await holder.release();
    expect(await db.get('SELECT venue FROM liquidations')).toEqual({ venue: 'aster' });   // The failed open is retried
  });

  it('close() waits for an open that is still in flight instead of leaking its connection', async () => {
    const db = new Database(path.join(tmpDir, 'closing.db'));
    const opening = db.initialize();
    await db.close();
    await opening;
    expect((db as any).connection).toBeNull();
    expect((db as any).ready).toBeNull();
    // Usable again: the next query opens a new connection
    expect(await db.get('SELECT 1 AS one')).toEqual({ one: 1 });
    await db.close();
  });

  it('close() is quiet when the open it waits for fails, and when nothing was opened', async () => {
    fs.writeFileSync(path.join(tmpDir, 'plain-file'), 'x');
    const db = new Database(path.join(tmpDir, 'plain-file', 'liquidations.db'));
    const opening = db.initialize();
    await expect(db.close()).resolves.toBeUndefined();
    await opening;
    await expect(new Database(path.join(tmpDir, 'never-opened.db')).close()).resolves.toBeUndefined();
  });
});

describe('hunter path (Aster unchanged)', () => {
  it('stores Aster events as before, one row per event, with the new columns at their defaults', async () => {
    const storage = new LiquidationStorage(database());
    await storage.saveLiquidation(event(), 50000);
    await storage.saveLiquidation(event(), 50000);
    const { liquidations, total } = await storage.getLiquidations();
    expect(total).toBe(2);
    expect(liquidations[0]).toMatchObject({
      symbol: 'BTCUSDT', side: 'SELL', volume_usdt: 50000, venue: 'aster', source: 'live', external_id: null, skip_reason: null, mode: null,
    });
    expect(JSON.parse(liquidations[0].metadata!)).toEqual({ orderType: 'LIMIT', originalQty: 0.5, originalTime: NOW });
  });
});

describe('Lighter detection recording and dedupe', () => {
  it('records the hunter copy and the detection of one liquidation once (detection first)', async () => {
    const storage = new LiquidationStorage(database());
    const d = detection();
    setLiquidationOrigin(d.event!, { venue: 'lighter', externalId: d.key, mode: 'live' });
    expect(await storage.saveLighterDetection(d)).toBe(true);
    await storage.saveLiquidation(d.event!, 50000);
    const { liquidations, total } = await storage.getLiquidations({ venue: 'lighter' });
    expect(total).toBe(1);
    expect(liquidations[0]).toMatchObject({ external_id: '1:abc:42', source: 'live', skip_reason: null, mode: 'live' });
    expect(JSON.parse(liquidations[0].metadata!)).toMatchObject({ marketId: 1, txHash: 'abc', tradeIds: ['7', '8'] });
  });

  it('records it once when the hunter copy lands first, and the detection\'s metadata replaces the hunter\'s', async () => {
    const storage = new LiquidationStorage(database());
    const d = detection({ notes: ['BBO check ok'] });
    setLiquidationOrigin(d.event!, { venue: 'lighter', externalId: d.key, mode: 'live' });
    await storage.saveLiquidation(d.event!, 50000);
    // The hunter's copy has the plain event metadata
    const copy = (await storage.getLiquidations()).liquidations[0];
    expect(JSON.parse(copy.metadata!)).toEqual({ orderType: 'LIMIT', originalQty: 0.5, originalTime: NOW });

    await storage.saveLighterDetection(d);
    const { liquidations, total } = await storage.getLiquidations();
    expect(total).toBe(1);
    expect(liquidations[0]).toMatchObject({ venue: 'lighter', skip_reason: null, mode: 'live' });
    expect(JSON.parse(liquidations[0].metadata!)).toMatchObject({
      orderType: 'LIMIT', marketId: 1, txHash: 'abc', tradeIds: ['7', '8'], excludedTradeIds: [], notes: ['BBO check ok'],
    });
  });

  it('a detection replaces the metadata of a backfilled row of the same liquidation (the book check was applied)', async () => {
    const storage = new LiquidationStorage(database());
    await storage.saveBackfilledLiquidations([backfillRecord({
      metadata: { marketId: 1, txHash: 'abc', tradeIds: ['7'], excludedTradeIds: [], notes: ['book check not applied (no historical best bid/ask)'] },
    })]);
    const before = (await storage.getLiquidations()).liquidations[0];
    expect(before.source).toBe('backfill');
    expect(JSON.parse(before.metadata!).notes).toEqual(['book check not applied (no historical best bid/ask)']);

    await storage.saveLighterDetection(detection({ notes: ['BBO check ok'] }));
    const { liquidations, total } = await storage.getLiquidations();
    expect(total).toBe(1);
    expect(liquidations[0]).toMatchObject({ source: 'live', mode: 'live', skip_reason: null });
    expect(JSON.parse(liquidations[0].metadata!)).toMatchObject({ tradeIds: ['7', '8'], notes: ['BBO check ok'] });
  });

  it('keeps the metadata of the first detection when the same liquidation is detected again', async () => {
    const storage = new LiquidationStorage(database());
    await storage.saveLighterDetection(detection({ notes: ['first flush'], tradeIds: ['7'] }));
    await storage.saveLighterDetection(detection({ notes: ['second flush'], tradeIds: ['7', '8'] }));
    const metadata = JSON.parse((await storage.getLiquidations()).liquidations[0].metadata!);
    expect(metadata).toMatchObject({ notes: ['first flush'], tradeIds: ['7'] });
  });

  it('a backfill that finds a live row leaves its metadata alone', async () => {
    const storage = new LiquidationStorage(database());
    await storage.saveLighterDetection(detection({ notes: ['BBO check ok'] }));
    await storage.saveBackfilledLiquidations([backfillRecord({ metadata: { tradeIds: ['7'], notes: ['book check not applied'] } })]);
    const row = (await storage.getLiquidations()).liquidations[0];
    expect(row.source).toBe('live');
    expect(JSON.parse(row.metadata!).notes).toEqual(['BBO check ok']);
  });

  it('stores shadow-mode and dropped detections with the reason they were not traded', async () => {
    const storage = new LiquidationStorage(database());
    await storage.saveLighterDetection(detection({ key: '1:s:1', live: false, emitted: false }));
    await storage.saveLighterDetection(detection({
      key: '1:d:2', emitted: false, dropReasons: ['stale: 20000 ms old (limit 10000 ms)', 'side unverified: tx has fills on both sides'],
    }));
    const rows = (await storage.getLiquidations({ venue: 'lighter', includeSkipped: true })).liquidations;
    const byKey = Object.fromEntries(rows.map((row) => [row.external_id, row]));
    expect(byKey['1:s:1']).toMatchObject({ skip_reason: SHADOW_MODE_SKIP_REASON, mode: 'shadow' });
    expect(byKey['1:d:2']).toMatchObject({
      skip_reason: 'stale: 20000 ms old (limit 10000 ms); side unverified: tx has fills on both sides', mode: 'live',
    });
  });

  it('does not store detections of unmapped markets', async () => {
    const storage = new LiquidationStorage(database());
    expect(await storage.saveLighterDetection(detection({ event: null, botSymbol: null }))).toBe(false);
    expect((await storage.getLiquidations()).total).toBe(0);
    expect(lighterDetectionRecord(detection({ event: null }))).toBeNull();
  });

  it('keeps a liquidation that was sent to the hunter marked as sent when a later flush of its key was dropped', async () => {
    const storage = new LiquidationStorage(database());
    await storage.saveLighterDetection(detection());
    await storage.saveLighterDetection(detection({ emitted: false, dropReasons: ['stale: 11000 ms old (limit 10000 ms)'] }));
    expect((await storage.getLiquidations()).liquidations[0].skip_reason).toBeNull();
  });

  it('never duplicates backfill and live rows, whichever comes first', async () => {
    const storage = new LiquidationStorage(database());
    // Live first: the backfill leaves the live row alone
    await storage.saveLighterDetection(detection({ live: false, emitted: false }));
    expect(await storage.saveBackfilledLiquidations([backfillRecord()])).toBe(0);
    // Backfill first: the live detection takes the row over
    expect(await storage.saveBackfilledLiquidations([backfillRecord({ externalId: '1:later:9' })])).toBe(1);
    await storage.saveLighterDetection(detection({ key: '1:later:9', live: false, emitted: false }));

    const rows = (await storage.getLiquidations()).liquidations;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ source: 'live', skip_reason: SHADOW_MODE_SKIP_REASON, mode: 'shadow' });
  });

  it('skips backfilled rows already stored (resume)', async () => {
    const storage = new LiquidationStorage(database());
    const records = [backfillRecord({ externalId: 'a' }), backfillRecord({ externalId: 'b', skipReason: 'side unverified: x' })];
    expect(await storage.saveBackfilledLiquidations(records)).toBe(2);
    expect(await storage.saveBackfilledLiquidations(records)).toBe(0);
    const rows = (await storage.getLiquidations({ includeSkipped: true })).liquidations;
    expect(rows.map((row) => [row.external_id, row.source, row.skip_reason]).sort()).toEqual([
      ['a', 'backfill', null],
      ['b', 'backfill', 'side unverified: x'],
    ]);
  });

  it('keeps the same id on different venues apart', async () => {
    const storage = new LiquidationStorage(database());
    await storage.saveBackfilledLiquidations([backfillRecord({ externalId: 'x' }), backfillRecord({ externalId: 'x', venue: 'other' })]);
    expect((await storage.getLiquidations()).total).toBe(2);
  });
});

describe('what the dashboard lists', () => {
  // Aster, traded, shadow-mode and backfilled rows are liquidations; dropped detections and gated backfill rows are not
  async function seed(storage: LiquidationStorage): Promise<void> {
    await storage.saveLiquidation(event({ eventTime: NOW - 1000 }), 50000);
    await storage.saveLighterDetection(detection({ key: '1:traded:1', eventTime: NOW - 2000 }));
    await storage.saveLighterDetection(detection({ key: '1:shadow:2', live: false, emitted: false }));
    await storage.saveLighterDetection(detection({ key: '1:dropped:3', emitted: false, dropReasons: ['stale: 20000 ms old (limit 10000 ms)'] }));
    await storage.saveBackfilledLiquidations([
      backfillRecord({ externalId: '1:bf-ok:4', eventTime: NOW - 4000 }),
      backfillRecord({ externalId: '1:bf-gated:5', eventTime: NOW - 5000, skipReason: 'side unverified: tx has fills on both sides' }),
    ]);
  }

  const ids = (rows: Array<{ external_id: string | null }>) => rows.map((row) => row.external_id ?? 'aster').sort();

  it('lists only the rows that were traded, held back by shadow mode alone, or loaded without a gate failure', async () => {
    const storage = new LiquidationStorage(database());
    await seed(storage);
    const { liquidations, total } = await storage.getLiquidations();
    expect(total).toBe(4);
    expect(ids(liquidations)).toEqual(['1:bf-ok:4', '1:shadow:2', '1:traded:1', 'aster']);
    // Rows say where they came from and why they were held back
    expect(liquidations.find((row) => row.external_id === '1:shadow:2')).toMatchObject({ venue: 'lighter', skip_reason: SHADOW_MODE_SKIP_REASON });
    expect(liquidations.find((row) => row.external_id === null)).toMatchObject({ venue: 'aster', skip_reason: null });
  });

  it('lists every detection with includeSkipped', async () => {
    const storage = new LiquidationStorage(database());
    await seed(storage);
    const { liquidations, total } = await storage.getLiquidations({ includeSkipped: true });
    expect(total).toBe(6);
    expect(liquidations.find((row) => row.external_id === '1:dropped:3')?.skip_reason).toMatch(/^stale/);
  });

  it('filters by venue, on top of the skip filter', async () => {
    const storage = new LiquidationStorage(database());
    await seed(storage);
    expect(ids((await storage.getLiquidations({ venue: 'lighter' })).liquidations)).toEqual(['1:bf-ok:4', '1:shadow:2', '1:traded:1']);
    expect((await storage.getLiquidations({ venue: 'lighter', includeSkipped: true })).total).toBe(5);
    expect((await storage.getLiquidations({ venue: 'aster' })).total).toBe(1);
    expect((await storage.getLiquidations({ venue: 'hyperliquid' })).total).toBe(0);
  });

  it('applies the same scope to the statistics and the recent list', async () => {
    const storage = new LiquidationStorage(database());
    await seed(storage);
    const now = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const stats = await storage.getStatistics(3600);
      expect(stats.total_count).toBe(4);
      expect(stats.symbols).toEqual([expect.objectContaining({ symbol: 'BTCUSDT', count: 4 })]);
      expect((await storage.getStatistics(3600, { includeSkipped: true })).total_count).toBe(6);
      expect((await storage.getStatistics(3600, { venue: 'lighter' })).total_count).toBe(3);
      expect((await storage.getStatistics(3600, { venue: 'aster', includeSkipped: true })).total_count).toBe(1);
    } finally {
      now.mockRestore();
    }
    expect(ids(await storage.getRecentLiquidations(50))).toEqual(['1:bf-ok:4', '1:shadow:2', '1:traded:1', 'aster']);
    expect(await storage.getRecentLiquidations(50, { includeSkipped: true })).toHaveLength(6);
  });

  it('parses the endpoint parameters', () => {
    expect(parseLiquidationScope(new URLSearchParams(''))).toEqual({ venue: undefined, includeSkipped: false });
    expect(parseLiquidationScope(new URLSearchParams('venue=lighter&includeSkipped=true'))).toEqual({ venue: 'lighter', includeSkipped: true });
    expect(parseLiquidationScope(new URLSearchParams('includeSkipped=1'))).toMatchObject({ includeSkipped: true });
    expect(parseLiquidationScope(new URLSearchParams('includeSkipped=false'))).toMatchObject({ includeSkipped: false });
    expect(parseLiquidationScope(new URLSearchParams("venue=x'; DROP TABLE liquidations"))).toEqual({ error: expect.stringMatching(/venue must be one of/) });
  });
});

describe('failing saves', () => {
  const failingDb = () => ({ run: jest.fn().mockRejectedValue(new Error('disk I/O error')) }) as unknown as Database;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs a database that stays broken once a minute, not on every save', async () => {
    let clock = NOW;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const storage = new LiquidationStorage(failingDb());
    for (let i = 0; i < 5; i++) await storage.saveLiquidation(event(), 1);
    for (let i = 0; i < 5; i++) await storage.recordLighterDetection(detection());
    const lines = () => (console.error as jest.Mock).mock.calls.map((call) => String(call[0]));
    expect(lines()).toEqual(['Error saving liquidation:', 'Failed to store Lighter liquidation detection:']);

    clock += 61_000;
    await storage.saveLiquidation(event(), 1);
    await storage.recordLighterDetection(detection());
    expect(lines().slice(2)).toEqual([
      'Error saving liquidation (4 similar errors since the last one):',
      'Failed to store Lighter liquidation detection (4 similar errors since the last one):',
    ]);
  });

  it('recordLighterDetection never throws', async () => {
    const storage = new LiquidationStorage(failingDb());
    await expect(storage.recordLighterDetection(detection())).resolves.toBeUndefined();
    await expect(storage.saveLighterDetection(detection())).rejects.toThrow('disk I/O error');
  });

  it('logs open errors of the database file once a minute too', async () => {
    let clock = NOW;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    fs.writeFileSync(path.join(tmpDir, 'not-a-directory'), 'x');
    const db = database(path.join('not-a-directory', 'liquidations.db'));
    for (let i = 0; i < 4; i++) await expect(db.get('SELECT 1')).rejects.toBeDefined();
    const opens = () => (console.error as jest.Mock).mock.calls.filter((call) => String(call[0]).startsWith('Error opening database'));
    expect(opens()).toHaveLength(1);
    clock += 61_000;
    await expect(db.get('SELECT 1')).rejects.toBeDefined();
    expect(opens().map((call) => String(call[0]))).toEqual([
      'Error opening database:',
      'Error opening database (3 similar errors since the last one):',
    ]);
  });
});

describe('retention', () => {
  async function seed(storage: LiquidationStorage): Promise<void> {
    await storage.saveLiquidation(event({ eventTime: NOW - 10 * DAY_MS }), 1);   // Aster, 10 days old
    await storage.saveLiquidation(event({ eventTime: NOW - 2 * DAY_MS }), 1);    // Aster, 2 days old
    await storage.saveBackfilledLiquidations([
      backfillRecord({ externalId: 'old', eventTime: NOW - 20 * DAY_MS }),          // Stored now, 20 days old
      backfillRecord({ externalId: 'new', eventTime: NOW - DAY_MS }),
    ]);
    await storage.saveCandles([
      { venue: 'lighter', symbol: 'BTCUSDT', interval: '1m', openTime: NOW - 9 * DAY_MS, open: 1, high: 1, low: 1, close: 1, volume: 0 },
      { venue: 'lighter', symbol: 'BTCUSDT', interval: '1m', openTime: NOW - DAY_MS, open: 1, high: 1, low: 1, close: 1, volume: 0 },
    ]);
  }

  it('deletes liquidations and candles by event time, backfilled rows included', async () => {
    const storage = new LiquidationStorage(database());
    await seed(storage);
    expect(await storage.cleanupOldLiquidations(7, NOW)).toBe(2);
    expect(await storage.cleanupOldCandles(7, NOW)).toBe(1);
    const remaining = (await storage.getLiquidations()).liquidations.map((row) => row.event_time).sort();
    expect(remaining).toEqual([NOW - 2 * DAY_MS, NOW - DAY_MS]);
    expect(await storage.getCandles('lighter', 'BTCUSDT', '1m', 0, NOW)).toHaveLength(1);
  });

  it('keeps everything with retention 0', async () => {
    const storage = new LiquidationStorage(database());
    await seed(storage);
    expect(await storage.cleanupOldLiquidations(0, NOW)).toBe(0);
    expect(await storage.cleanupOldCandles(0, NOW)).toBe(0);
    expect((await storage.getLiquidations()).total).toBe(4);
  });

  it('honours a longer retention', async () => {
    const storage = new LiquidationStorage(database());
    await seed(storage);
    expect(await storage.cleanupOldLiquidations(30, NOW)).toBe(0);
    expect(await storage.cleanupOldLiquidations(15, NOW)).toBe(1);
  });

  it('the scheduler reads the configured retention on every run (default 7, 0 = forever)', () => {
    const scheduler = new CleanupScheduler(24);
    expect(scheduler.retentionDays()).toBe(7);
    let days: number | undefined = 30;
    (scheduler as any).getRetentionDays = () => days;
    expect(scheduler.retentionDays()).toBe(30);
    days = 0;
    expect(scheduler.retentionDays()).toBe(0);
    days = -1;
    expect(scheduler.retentionDays()).toBe(7);
  });
});

describe('candles', () => {
  it('upserts candles and reads a window in time order', async () => {
    const storage = new LiquidationStorage(database());
    const candle = { venue: 'lighter', symbol: 'ETHUSDT', interval: '1m', open: 10, high: 12, low: 9, close: 11, volume: 3 };
    expect(await storage.saveCandles([
      { ...candle, openTime: NOW + 60_000 },
      { ...candle, openTime: NOW },
    ])).toBe(2);
    await storage.saveCandles([{ ...candle, openTime: NOW + 60_000, close: 15, high: 15 }]);   // The forming candle moved
    const rows = await storage.getCandles('lighter', 'ETHUSDT', '1m', NOW, NOW + 60_000);
    expect(rows.map((row) => [row.openTime, row.close, row.high])).toEqual([[NOW, 11, 12], [NOW + 60_000, 15, 15]]);
    expect(await storage.getCandles('aster', 'ETHUSDT', '1m', NOW, NOW + 60_000)).toEqual([]);
  });
});
