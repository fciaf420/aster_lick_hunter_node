import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { createLogThrottle, suppressedSuffix } from '../utils/throttledLog';

// LIQUIDATIONS_DB_PATH points the bot, the history backfill and tests at another file
export function defaultLiquidationsDbPath(): string {
  return process.env.LIQUIDATIONS_DB_PATH || path.join(process.cwd(), 'data', 'liquidations.db');
}

export interface RunResult {
  changes: number;
  lastID: number;
}

export interface DatabaseOptions {
  busyTimeoutMs?: number;              // How long a statement waits for another process's lock (default 5000)
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;
// Another process (bot, backfill, web app) can hold the write lock past the busy timeout while it migrates or
// writes a big batch: the schema step is retried a few times before the open fails
const SCHEMA_ATTEMPTS = 4;
const SCHEMA_RETRY_DELAY_MS = 250;
// A database that stays unusable fails every query the same way: log the open error once a minute
const OPEN_ERROR_LOG_INTERVAL_MS = 60_000;

// Columns added after the first release (also in SCHEMA, for new files), with what existing rows get: every row
// recorded before them came from Aster's live forceOrder stream through the hunter
const LIQUIDATION_COLUMN_MIGRATIONS: ReadonlyArray<{ name: string; definition: string }> = [
  { name: 'venue', definition: "TEXT NOT NULL DEFAULT 'aster'" },
  { name: 'source', definition: "TEXT NOT NULL DEFAULT 'live'" },    // 'live' | 'backfill'
  { name: 'external_id', definition: 'TEXT' },                       // Venue's id for the liquidation (Lighter group key)
  { name: 'skip_reason', definition: 'TEXT' },                       // null = sent to the hunter
  { name: 'mode', definition: 'TEXT' },                              // 'live' | 'shadow' | null (Lighter feed mode)
];

// New files get the full table from this statement; older files are brought up to date by the column migration
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS liquidations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    order_type TEXT,
    quantity REAL NOT NULL,
    price REAL NOT NULL,
    average_price REAL,
    volume_usdt REAL NOT NULL,
    order_status TEXT,
    order_last_filled_quantity REAL,
    order_filled_accumulated_quantity REAL,
    order_trade_time INTEGER,
    event_time INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    metadata TEXT,
    venue TEXT NOT NULL DEFAULT 'aster',
    source TEXT NOT NULL DEFAULT 'live',
    external_id TEXT,
    skip_reason TEXT,
    mode TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_liquidations_event_time
    ON liquidations(event_time);

  CREATE INDEX IF NOT EXISTS idx_liquidations_symbol
    ON liquidations(symbol);

  CREATE INDEX IF NOT EXISTS idx_liquidations_created_at
    ON liquidations(created_at);

  CREATE INDEX IF NOT EXISTS idx_liquidations_symbol_event_time
    ON liquidations(symbol, event_time);
`;

// After the column migration: the dedupe key of venue liquidations (live recording and backfill land in one row)
// and the candle store (open_time in ms, prices and volume in bot units)
const SCHEMA_V2 = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_liquidations_venue_external_id
    ON liquidations(venue, external_id) WHERE external_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_liquidations_venue_symbol_event_time
    ON liquidations(venue, symbol, event_time);

  CREATE TABLE IF NOT EXISTS candles (
    venue TEXT NOT NULL,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    open_time INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (venue, symbol, interval, open_time)
  );
`;

export class Database {
  private static instance: Database;
  readonly path: string;
  private readonly busyTimeoutMs: number;
  private connection: sqlite3.Database | null = null;
  private ready: Promise<sqlite3.Database> | null = null;
  private transactionTail: Promise<void> = Promise.resolve();
  private readonly throttleOpenErrors = createLogThrottle(OPEN_ERROR_LOG_INTERVAL_MS);

  // The file is opened, and its schema created or migrated, on first use
  constructor(dbPath: string = defaultLiquidationsDbPath(), options: DatabaseOptions = {}) {
    this.path = dbPath;
    this.busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  }

  static getInstance(): Database {
    if (!Database.instance) {
      Database.instance = new Database();
    }
    return Database.instance;
  }

  private logOpenError(what: string, error: unknown): void {
    this.throttleOpenErrors((skipped) => console.error(`${what}${suppressedSuffix(skipped)}:`, error));
  }

  private open(): Promise<sqlite3.Database> {
    if (!this.ready) {
      const ready = new Promise<sqlite3.Database>((resolve, reject) => {
        const dir = path.dirname(this.path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const connection = new sqlite3.Database(this.path, (err) => {
          if (err) {
            this.logOpenError('Error opening database', err);
            reject(err);
            return;
          }
          console.log('Connected to SQLite database at:', this.path);
          // The bot and the backfill script may write at the same time
          connection.configure('busyTimeout', this.busyTimeoutMs);
          this.initializeSchema(connection).then(
            () => {
              this.connection = connection;
              resolve(connection);
            },
            (error) => {
              this.logOpenError('Error creating schema', error);
              connection.close(() => undefined);
              reject(error);
            }
          );
        });
      });
      // A failed open is retried on the next call
      ready.catch(() => {
        if (this.ready === ready) this.ready = null;
      });
      this.ready = ready;
    }
    return this.ready;
  }

  // The bot, the backfill and the web app may open the same new or old file at the same moment. The whole step runs
  // in one write transaction, so one of them creates / migrates and the others see the finished schema.
  private async initializeSchema(connection: sqlite3.Database): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.applySchema(connection);
        break;
      } catch (error) {
        if (!isBusyError(error) || attempt >= SCHEMA_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, SCHEMA_RETRY_DELAY_MS));
      }
    }
    console.log('Database schema initialized');
  }

  private async applySchema(connection: sqlite3.Database): Promise<void> {
    await exec(connection, 'BEGIN IMMEDIATE');   // Waits for the write lock (busy timeout); fails with SQLITE_BUSY after it
    try {
      await exec(connection, SCHEMA);
      // Read inside the transaction: nobody can add the columns between this check and the ALTERs below
      const columns = await all<{ name: string }>(connection, 'PRAGMA table_info(liquidations)');
      const existing = new Set(columns.map(column => column.name));
      for (const column of LIQUIDATION_COLUMN_MIGRATIONS) {
        if (existing.has(column.name)) continue;
        try {
          await exec(connection, `ALTER TABLE liquidations ADD COLUMN ${column.name} ${column.definition}`);
        } catch (error) {
          // A failed statement leaves the transaction open. Another connection added the column first.
          if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) throw error;
        }
      }
      await exec(connection, SCHEMA_V2);
      await exec(connection, 'COMMIT');
    } catch (error) {
      await exec(connection, 'ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  async run(sql: string, params: any[] = []): Promise<RunResult> {
    const connection = await this.open();
    return new Promise((resolve, reject) => {
      connection.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes, lastID: this.lastID });
      });
    });
  }

  async get<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
    const connection = await this.open();
    return new Promise((resolve, reject) => {
      connection.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row as T);
      });
    });
  }

  async all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return all<T>(await this.open(), sql, params);
  }

  // Runs fn inside BEGIN / COMMIT (ROLLBACK when it throws). Other statements sent through this instance meanwhile
  // join the transaction, so use it only where nothing else writes through the same instance (the backfill).
  // Transactions on this instance run one at a time.
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.transactionTail.then(async () => {
      await this.run('BEGIN IMMEDIATE');
      try {
        const value = await fn();
        await this.run('COMMIT');
        return value;
      } catch (error) {
        await this.run('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
    this.transactionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  // An open still in flight is waited for, so the connection it is about to hand out is closed too
  async close(): Promise<void> {
    if (this.ready) await this.ready.catch(() => undefined);
    const connection = this.connection;
    this.connection = null;
    this.ready = null;
    if (!connection) return;
    await new Promise<void>((resolve) => {
      connection.close((err) => {
        if (err) {
          console.error('Error closing database:', err);
        } else {
          console.log('Database connection closed');
        }
        resolve();
      });
    });
  }

  // Opens the file and creates or migrates the schema. Failures are logged, not thrown (the bot runs on without
  // liquidation history; every query retries the open).
  async initialize(): Promise<void> {
    try {
      await this.open();
    } catch {
      // Logged by open()
    }
  }
}

// SQLITE_BUSY / SQLITE_LOCKED: another connection holds the lock past the busy timeout
function isBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || /database is (locked|busy)/i.test(error instanceof Error ? error.message : String(error));
}

function exec(connection: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function all<T>(connection: sqlite3.Database, sql: string, params: any[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    connection.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows as T[]);
    });
  });
}

export const db = Database.getInstance();
