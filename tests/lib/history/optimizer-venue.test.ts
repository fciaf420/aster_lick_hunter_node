/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import BetterSqlite from 'better-sqlite3';
import { Database } from '../../../src/lib/db/database';
import { LiquidationStorage, SHADOW_MODE_SKIP_REASON, type LiquidationRecord } from '../../../src/lib/services/liquidationStorage';
import { LIGHTER_PROFILE_NAMES, PROFILES } from '../../../src/lib/exchange/lighter/profiles';
import { LIGHTER_CANDLE_INTERVAL } from '../../../src/lib/lighterHistory/backfill';
import type { LiquidationEvent } from '../../../src/lib/types';
import { HISTORY_TEST_TIMEOUT_MS, removeTmpDir } from './tmp';

// scripts/optimizer-venue.js: the venue scope of optimize-config.js (CommonJS, plain Node)
const venue = require('../../../scripts/optimizer-venue.js');

jest.setTimeout(HISTORY_TEST_TIMEOUT_MS);

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);

let tmpDir: string;
const connections: BetterSqlite.Database[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'optimizer-venue-'));
});

afterEach(() => {
  while (connections.length > 0) connections.pop()!.close();
  removeTmpDir(tmpDir);
});

function asterEvent(eventTime: number): LiquidationEvent {
  return {
    symbol: 'BTCUSDT', side: 'SELL', orderType: 'LIMIT', quantity: 1, price: 100, averagePrice: 100, orderStatus: 'FILLED',
    orderLastFilledQuantity: 1, orderFilledAccumulatedQuantity: 1, orderTradeTime: eventTime, eventTime, qty: 1, time: eventTime,
  };
}

function lighterRecord(externalId: string, skipReason: string | null, overrides: Partial<LiquidationRecord> = {}): LiquidationRecord {
  return {
    venue: 'lighter', source: 'live', externalId, symbol: 'BTCUSDT', side: 'BUY', quantity: 1, price: 100, volumeUsdt: 100,
    eventTime: NOW - 10 * MINUTE, skipReason, mode: 'shadow', ...overrides,
  };
}

// A migrated database: 2 Aster rows and Lighter rows that were traded, held back by shadow mode, or dropped
async function seededDatabase(): Promise<string> {
  const file = path.join(tmpDir, 'liquidations.db');
  const db = new Database(file);
  const storage = new LiquidationStorage(db);
  await storage.saveLiquidation(asterEvent(NOW - 5 * MINUTE), 100);
  await storage.saveLiquidation(asterEvent(NOW - 4 * MINUTE), 100);
  await storage.saveBackfilledLiquidations([
    lighterRecord('traded', null, { mode: 'live' }),
    lighterRecord('shadow', 'shadow mode'),
    lighterRecord('stale', 'stale: 12000 ms old (limit 10000 ms)'),
    lighterRecord('backfill-gated', 'side unverified: tx has fills on both sides', { source: 'backfill', mode: null }),
    lighterRecord('backfill-ok', null, { source: 'backfill', mode: null }),
  ]);
  await db.close();
  return file;
}

function readOnly(file: string): BetterSqlite.Database {
  const connection = new BetterSqlite(file, { readonly: true });
  connections.push(connection);
  return connection;
}

const count = (db: BetterSqlite.Database) => (db.prepare('SELECT COUNT(*) AS n FROM liquidations').get() as { n: number }).n;

describe('venue options', () => {
  it('defaults to the configured trading venue, then aster', () => {
    expect(venue.parseOptimizerVenueOptions([], {}, { global: { exchange: 'lighter' } })).toEqual({ venue: 'lighter', includeSkipped: false });
    expect(venue.parseOptimizerVenueOptions([], {}, { global: {} })).toEqual({ venue: 'aster', includeSkipped: false });
    expect(venue.parseOptimizerVenueOptions([], {}, undefined)).toEqual({ venue: 'aster', includeSkipped: false });
  });

  it('takes --venue / --include-skipped over the environment and the config', () => {
    const config = { global: { exchange: 'lighter' } };
    expect(venue.parseOptimizerVenueOptions(['--venue', 'aster'], {}, config).venue).toBe('aster');
    expect(venue.parseOptimizerVenueOptions(['--venue=lighter', '--include-skipped'], {}, {})).toEqual({ venue: 'lighter', includeSkipped: true });
    expect(venue.parseOptimizerVenueOptions([], { OPTIMIZER_VENUE: 'aster', OPTIMIZER_INCLUDE_SKIPPED: '1' }, config))
      .toEqual({ venue: 'aster', includeSkipped: true });
    expect(venue.parseOptimizerVenueOptions([], { OPTIMIZER_VENUE: '' }, config).venue).toBe('lighter');   // Service: unset
    expect(() => venue.parseOptimizerVenueOptions(['--venue', 'hyperliquid'], {}, {})).toThrow(/Unknown optimizer venue/);
  });
});

describe('liquidation scope', () => {
  it('aster reads only Aster rows', async () => {
    const db = readOnly(await seededDatabase());
    expect(venue.scopeLiquidationsToVenue(db, { venue: 'aster', includeSkipped: false })).toEqual({ scoped: true, condition: "venue = 'aster'" });
    expect(count(db)).toBe(2);
    // Every unqualified query of the optimizer sees the scope
    expect(db.prepare('SELECT COUNT(*) AS n FROM liquidations WHERE symbol = ? AND side = ?').get('BTCUSDT', 'SELL')).toEqual({ n: 2 });
  });

  it('lighter reads the rows that would have traded (null or shadow mode only) by default', async () => {
    const db = readOnly(await seededDatabase());
    venue.scopeLiquidationsToVenue(db, { venue: 'lighter', includeSkipped: false });
    const ids = db.prepare('SELECT external_id FROM liquidations ORDER BY external_id').all().map((row: any) => row.external_id);
    expect(ids).toEqual(['backfill-ok', 'shadow', 'traded']);
  });

  it('lighter --include-skipped adds the dropped detections', async () => {
    const db = readOnly(await seededDatabase());
    venue.scopeLiquidationsToVenue(db, { venue: 'lighter', includeSkipped: true });
    expect(count(db)).toBe(5);
  });

  it('a database from before the venue column is all Aster: unscoped for aster, empty for lighter', () => {
    const file = path.join(tmpDir, 'old.db');
    const writer = new BetterSqlite(file);
    writer.exec(`CREATE TABLE liquidations (id INTEGER PRIMARY KEY, symbol TEXT, side TEXT, volume_usdt REAL, price REAL, event_time INTEGER);
      INSERT INTO liquidations (symbol, side, volume_usdt, price, event_time) VALUES ('ASTERUSDT', 'SELL', 10, 1, ${NOW});`);
    writer.close();

    const aster = readOnly(file);
    expect(venue.scopeLiquidationsToVenue(aster, { venue: 'aster', includeSkipped: false })).toEqual({ scoped: false, condition: null });
    expect(count(aster)).toBe(1);
    const lighter = readOnly(file);
    venue.scopeLiquidationsToVenue(lighter, { venue: 'lighter', includeSkipped: false });
    expect(count(lighter)).toBe(0);
  });

  it('picks the busiest scoped symbol for the coverage report', async () => {
    const db = readOnly(await seededDatabase());
    venue.scopeLiquidationsToVenue(db, { venue: 'lighter', includeSkipped: false });
    expect(venue.busiestSymbol(db, ['ETHUSDT', 'BTCUSDT'])).toBe('BTCUSDT');
    expect(venue.busiestSymbol(db, ['ETHUSDT'])).toBeNull();
  });
});

describe('Lighter prices from the candles table', () => {
  function candle(openTime: number, close = 100) {
    return { venue: 'lighter', symbol: 'BTCUSDT', interval: '1m', openTime, open: close, high: close + 1, low: close - 1, close, volume: 2 };
  }

  async function databaseWithCandles(openTimes: number[]): Promise<string> {
    const file = await seededDatabase();
    const db = new Database(file);
    await new LiquidationStorage(db).saveCandles(openTimes.map((t) => candle(t)));
    await db.close();
    return file;
  }

  it('reads stored candles as price points without fetching when they cover the window', async () => {
    const times = Array.from({ length: 121 }, (_, i) => NOW - 120 * MINUTE + i * MINUTE);
    const db = readOnly(await databaseWithCandles(times));
    venue.scopeLiquidationsToVenue(db, { venue: 'lighter', includeSkipped: false });
    const fetchCandles = jest.fn(() => true);
    const getPrices = venue.createLighterPriceSource({ db, cwd: tmpDir, now: () => NOW, fetchCandles, log: () => undefined });
    const prices = getPrices('BTCUSDT', '1m', 120);
    expect(fetchCandles).not.toHaveBeenCalled();
    expect(prices).toHaveLength(121);
    expect(prices[0]).toEqual({ timestamp: NOW - 120 * MINUTE, open: 100, high: 101, low: 99, close: 100, volume: 2 });
  });

  it('fetches missing candles once per symbol (lighter:backfill --candles-only) and re-reads them', async () => {
    const file = await databaseWithCandles([NOW - 5 * MINUTE]);
    const db = readOnly(file);
    venue.scopeLiquidationsToVenue(db, { venue: 'lighter', includeSkipped: false });
    const fetchCandles = jest.fn((symbol: string, fromMs: number, toMs: number) => {
      const writer = new BetterSqlite(file);
      const insert = writer.prepare('INSERT OR REPLACE INTO candles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      // One transaction: an fsync per candle made this the slowest test on a busy disk
      writer.transaction(() => {
        for (let t = fromMs; t <= toMs; t += MINUTE) insert.run('lighter', symbol, '1m', t, 1, 1, 1, 1, 0);
      })();
      writer.close();
      return true;
    });
    const getPrices = venue.createLighterPriceSource({ db, cwd: tmpDir, now: () => NOW, fetchCandles, log: () => undefined });

    const prices = getPrices('BTCUSDT', '1m', 60);
    // The window reaches back to an hour before the oldest liquidation (NOW - 10 min) or totalCandles, whichever is older
    expect(fetchCandles).toHaveBeenCalledWith('BTCUSDT', NOW - 70 * MINUTE, NOW, tmpDir);
    expect(prices.length).toBe(71);
    getPrices('BTCUSDT', '1m', 90);
    expect(fetchCandles).toHaveBeenCalledTimes(1);
  });

  it('finds holes in candle coverage', () => {
    const at = (minutes: number) => ({ timestamp: NOW + minutes * MINUTE });
    expect(venue.candleGaps([at(0), at(1), at(2)], NOW, NOW + 2 * MINUTE)).toEqual([]);
    expect(venue.candleGaps([at(0), at(45)], NOW, NOW + 45 * MINUTE)).toEqual([[NOW, NOW + 45 * MINUTE]]);
    expect(venue.candleGaps([], NOW, NOW + 60 * MINUTE)).toEqual([[NOW, NOW + 60 * MINUTE]]);
    expect(venue.candleGaps([at(40)], NOW, NOW + 40 * MINUTE)).toEqual([[NOW, NOW + 40 * MINUTE]]);
  });
});

describe('copies of the TypeScript side', () => {
  // scripts/optimizer-venue.js runs under plain Node and can't import TypeScript: it repeats these
  it('knows the same Lighter REST hosts as the network profiles', () => {
    expect(venue.LIGHTER_API_URLS).toEqual(Object.fromEntries(LIGHTER_PROFILE_NAMES.map((name) => [name, PROFILES[name].apiUrl])));
  });

  it('uses the shadow-mode skip reason and the candle interval the recorder and the backfill write', () => {
    expect(venue.SHADOW_MODE_SKIP_REASON).toBe(SHADOW_MODE_SKIP_REASON);
    expect(venue.LIGHTER_CANDLE_INTERVAL).toBe(LIGHTER_CANDLE_INTERVAL);
  });
});

describe('venue condition guard', () => {
  const columns = new Set(['venue', 'skip_reason']);

  it('builds the condition of a known venue only', () => {
    expect(venue.venueCondition(columns, { venue: 'aster', includeSkipped: false })).toBe("venue = 'aster'");
    expect(venue.venueCondition(columns, { venue: 'lighter', includeSkipped: false })).toBe(
      "venue = 'lighter' AND (skip_reason IS NULL OR skip_reason = 'shadow mode')"
    );
    expect(venue.venueCondition(columns, { venue: 'lighter', includeSkipped: true })).toBe("venue = 'lighter'");
  });

  it('never interpolates an unknown venue, whatever the columns', () => {
    for (const bad of ["lighter' OR '1'='1", 'hyperliquid', '', undefined, null]) {
      expect(() => venue.venueCondition(columns, { venue: bad, includeSkipped: false })).toThrow(/Unknown optimizer venue/);
      expect(() => venue.venueCondition(new Set(), { venue: bad, includeSkipped: false })).toThrow(/Unknown optimizer venue/);
    }
  });

  it('refuses to scope a database to an unknown venue', async () => {
    const db = readOnly(await seededDatabase());
    expect(() => venue.scopeLiquidationsToVenue(db, { venue: "x'; DROP TABLE liquidations; --", includeSkipped: false })).toThrow(/Unknown optimizer venue/);
    expect(count(db)).toBe(7);
  });
});

describe('book check note', () => {
  it('counts the in-scope liquidations the book check was not applied to (backfilled rows)', async () => {
    const db = readOnly(await seededDatabase());
    venue.scopeLiquidationsToVenue(db, { venue: 'lighter', includeSkipped: false });
    // traded, shadow and backfill-ok are in scope; only the last one was loaded without the book check
    expect(venue.bookCheckNote(db)).toMatch(/^Book check: not applied to 1 of 3 in-scope liquidation\(s\) \(backfilled/);
    expect(venue.bookCheckNote(db)).toMatch(/lean optimistic/);

    const all = readOnly(await seededDatabase());
    venue.scopeLiquidationsToVenue(all, { venue: 'lighter', includeSkipped: true });
    expect(venue.bookCheckNote(all)).toMatch(/not applied to 2 of 5 in-scope/);
  });

  it('says so when every in-scope liquidation was recorded live, and for a database without the source column', async () => {
    const file = path.join(tmpDir, 'live-only.db');
    const db = new Database(file);
    await new LiquidationStorage(db).saveBackfilledLiquidations([lighterRecord('a', null), lighterRecord('b', 'shadow mode')]);
    await db.close();
    const live = readOnly(file);
    venue.scopeLiquidationsToVenue(live, { venue: 'lighter', includeSkipped: false });
    expect(venue.bookCheckNote(live)).toBe('Book check: applied to all 2 in-scope liquidation(s) (none are backfilled)');

    const old = path.join(tmpDir, 'old-note.db');
    const writer = new BetterSqlite(old);
    writer.exec('CREATE TABLE liquidations (id INTEGER PRIMARY KEY, symbol TEXT, side TEXT, volume_usdt REAL, price REAL, event_time INTEGER)');
    writer.close();
    expect(venue.bookCheckNote(readOnly(old))).toBe('Book check: every in-scope liquidation was recorded live');
  });
});

describe('fetching candles with lighter:backfill', () => {
  const run = (spawn: jest.Mock, log: jest.Mock) => venue.fetchLighterCandles('BTCUSDT', NOW - 2 * 24 * 60 * MINUTE, NOW, tmpDir, { spawn, log });

  it('captures the script output (stdout is parsed by the optimizer service, stderr is logged as an error there)', () => {
    const spawn = jest.fn(() => ({ status: 0, stdout: 'Lighter testnet backfill: BTCUSDT\nWindow ...\n', stderr: '' }));
    const log = jest.fn();
    expect(run(spawn, log)).toBe(true);
    const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { stdio: unknown; cwd: string }];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(expect.arrayContaining([path.join(tmpDir, 'scripts', 'lighter-backfill.ts'), '--candles-only', '--symbols', 'BTCUSDT', '--days', '2.0000']));
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(options.cwd).toBe(tmpDir);
    // One progress line, none of the script's own output
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/^ {3}Fetched BTCUSDT candles in [\d.]+s$/);
  });

  it('shows what the script printed only when it fails', () => {
    const output = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const spawn = jest.fn(() => ({ status: 1, stdout: output, stderr: 'lighter:backfill failed: HTTP 403\n' }));
    const log = jest.fn();
    expect(run(spawn, log)).toBe(false);
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines[0]).toMatch(/lighter:backfill --candles-only for BTCUSDT failed \(exit code 1\):/);
    expect(lines).toContain('      lighter:backfill failed: HTTP 403');
    expect(lines).toContain('      line 29');
    expect(lines.some((line) => line.endsWith('line 10'))).toBe(false);   // Only the tail
  });

  it('reports a script that could not be started', () => {
    const spawn = jest.fn(() => ({ status: null, signal: null, error: new Error('spawn ENOENT'), stdout: null, stderr: null }));
    const log = jest.fn();
    expect(run(spawn, log)).toBe(false);
    expect(String(log.mock.calls[0][0])).toMatch(/failed \(spawn ENOENT\)$/);
  });
});

describe('Lighter account snapshot', () => {
  it('maps the public account to the balance / account / positions shapes the optimizer reads', async () => {
    const httpGet = jest.fn(async () => ({
      code: 200,
      accounts: [{
        index: 42, collateral: '1000.5', available_balance: '800', total_asset_value: '1010',
        cross_initial_margin_requirement: '150', cross_maintenance_margin_requirement: '50',
        positions: [
          { symbol: 'BTC', sign: -1, position: '0.01', avg_entry_price: '97000', position_value: '980', unrealized_pnl: '-10', allocated_margin: '0', initial_margin_fraction: '10.00' },
          { symbol: 'ETH', sign: 1, position: '0', position_value: '0' },
        ],
      }],
    }));
    const snapshot = await venue.getLighterAccountSnapshot({ venues: { lighter: { profile: 'mainnet', accountIndex: 42 } } }, httpGet);
    expect(httpGet).toHaveBeenCalledWith('https://mainnet.zklighter.elliot.ai/api/v1/account?by=index&value=42&active_only=true');
    expect(snapshot.balance).toEqual({ totalWalletBalance: 1000.5, availableBalance: 800, crossMargin: 0 });
    expect(snapshot.accountInfo).toMatchObject({ totalMarginBalance: 1010, totalWalletBalance: 1000.5, totalUnrealizedProfit: -10, totalInitialMargin: 150 });
    expect(snapshot.positions).toEqual([
      { symbol: 'BTC', positionAmt: '-0.01', entryPrice: '97000', markPrice: '98000', unRealizedProfit: '-10', initialMargin: '0', leverage: '10' },
    ]);
  });

  it('is empty without an account index or when the request fails', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const httpGet = jest.fn(async () => {
      throw new Error('network down');
    });
    expect(await venue.getLighterAccountSnapshot({ venues: { lighter: {} } }, httpGet)).toMatchObject({ accountInfo: null, positions: [] });
    expect(httpGet).not.toHaveBeenCalled();
    expect((await venue.getLighterAccountSnapshot({ venues: { lighter: { accountIndex: 1 } } }, httpGet)).balance.totalWalletBalance).toBe(0);
  });
});
