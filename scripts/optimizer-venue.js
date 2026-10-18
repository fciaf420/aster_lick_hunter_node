'use strict';

// Venue scope of the optimizer (optimize-config.js): whose liquidations it reads and where its prices come from.
//
//   aster   Rows with venue 'aster' (all rows of a database from before the venue column) and Aster klines:
//           exactly the optimizer as it was.
//   lighter Rows with venue 'lighter' (live detections and lighter:backfill rows). By default only the ones that
//           would have been traded: skip_reason null, or held back by shadow mode alone. --include-skipped adds the
//           detections a gate dropped (stale, LLP takeover, unverified side, ...). 1m prices come from the candles
//           table; missing ones are fetched with `npm run lighter:backfill -- --candles-only`.
//
// Lighter volumes are USDC; thresholds treat USDC as USDT.

const path = require('path');
const { spawnSync } = require('child_process');

const OPTIMIZER_VENUES = ['aster', 'lighter'];
// Copies of constants of the TypeScript side (checked by the same test)
const SHADOW_MODE_SKIP_REASON = 'shadow mode';      // SHADOW_MODE_SKIP_REASON in src/lib/services/liquidationStorage.ts
const LIGHTER_CANDLE_INTERVAL = '1m';                // LIGHTER_CANDLE_INTERVAL in src/lib/lighterHistory/backfill.ts
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const CANDLE_MAX_GAP_MS = 30 * MINUTE_MS;           // A longer hole means the candles need fetching
// REST base per Lighter network. A copy of PROFILES[name].apiUrl in src/lib/exchange/lighter/profiles.ts: this file
// runs under plain Node and can't import TypeScript. tests/lib/history/optimizer-venue.test.ts fails if they differ.
const LIGHTER_API_URLS = {
  mainnet: 'https://mainnet.zklighter.elliot.ai',
  testnet: 'https://testnet.zklighter.elliot.ai',
  robinhood: 'https://api.rh.lighter.xyz',
  robinhood_testnet: 'https://api.rh-testnet.lighter.xyz',
};

const LIGHTER_DATA_NOTE =
  'Lighter reports every liquidation fill as it happens (grouped per liquidation), while Aster\'s forceOrder ' +
  'stream sends at most one snapshot per symbol per second: Lighter liquidation counts and sizes differ, so ' +
  'thresholds suggested from Lighter data fit the Lighter feed only. Lighter volumes are USDC, treated as USDT.';

// --venue aster|lighter (or OPTIMIZER_VENUE; default global.exchange, else aster) and --include-skipped
// (or OPTIMIZER_INCLUDE_SKIPPED=1). Throws on an unknown venue.
function parseOptimizerVenueOptions(argv = [], env = {}, config = {}) {
  let venue;
  let includeSkipped;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--venue') {
      venue = argv[i + 1];
      i++;
    } else if (arg.startsWith('--venue=')) {
      venue = arg.slice('--venue='.length);
    } else if (arg === '--include-skipped') {
      includeSkipped = true;
    }
  }
  if (venue === undefined || venue === '') venue = env.OPTIMIZER_VENUE || (config && config.global && config.global.exchange) || 'aster';
  if (!OPTIMIZER_VENUES.includes(venue)) {
    throw new Error(`Unknown optimizer venue "${venue}". Expected one of: ${OPTIMIZER_VENUES.join(', ')}`);
  }
  if (includeSkipped === undefined) includeSkipped = env.OPTIMIZER_INCLUDE_SKIPPED === '1' || env.OPTIMIZER_INCLUDE_SKIPPED === 'true';
  return { venue, includeSkipped };
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function liquidationColumns(db) {
  return new Set(db.prepare('PRAGMA main.table_info(liquidations)').all().map(column => column.name));
}

// SQL condition selecting the venue's rows; null = every row (a database from before the venue column, Aster)
function venueCondition(columns, options) {
  // The condition goes into a TEMP VIEW, which can't take bound parameters: only a known venue is interpolated
  if (!OPTIMIZER_VENUES.includes(options.venue)) {
    throw new Error(`Unknown optimizer venue "${options.venue}". Expected one of: ${OPTIMIZER_VENUES.join(', ')}`);
  }
  if (!columns.has('venue')) return options.venue === 'aster' ? null : '0';
  const conditions = [`venue = '${options.venue}'`];
  if (options.venue === 'lighter' && !options.includeSkipped && columns.has('skip_reason')) {
    conditions.push(`(skip_reason IS NULL OR skip_reason = '${SHADOW_MODE_SKIP_REASON}')`);
  }
  return conditions.join(' AND ');
}

// Shadows the liquidations table with a TEMP VIEW of the venue's rows, so every query of the optimizer reads the
// venue without being rewritten (unqualified names resolve to the temp schema first). Works on a read-only
// connection.
function scopeLiquidationsToVenue(db, options) {
  if (!hasTable(db, 'liquidations')) return { scoped: false, condition: null };
  const condition = venueCondition(liquidationColumns(db), options);
  if (condition === null) return { scoped: false, condition: null };
  db.exec(`CREATE TEMP VIEW liquidations AS SELECT * FROM main.liquidations WHERE ${condition}`);
  return { scoped: true, condition };
}

// One line on the in-scope rows the live feed's book check never saw: backfilled rows (there is no historical order
// book), which pass the other gates only. A Lighter run on them leans optimistic.
function bookCheckNote(db) {
  if (!hasTable(db, 'liquidations') || !liquidationColumns(db).has('source')) {
    return 'Book check: every in-scope liquidation was recorded live';
  }
  const row = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN source = 'backfill' THEN 1 ELSE 0 END) AS unchecked FROM liquidations").get();
  const total = row.total || 0;
  const unchecked = row.unchecked || 0;
  if (unchecked === 0) return `Book check: applied to all ${total} in-scope liquidation(s) (none are backfilled)`;
  return `Book check: not applied to ${unchecked} of ${total} in-scope liquidation(s) (backfilled: they pass the non-book gates ` +
    'only, so results lean optimistic; see docs/LIGHTER-HISTORY.md)';
}

// The scoped symbol with the most liquidations (the coverage report), or null
function busiestSymbol(db, symbols) {
  let best = null;
  for (const symbol of symbols) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM liquidations WHERE symbol = ?').get(symbol);
    if (row && row.n > 0 && (best === null || row.n > best.n)) best = { symbol, n: row.n };
  }
  return best ? best.symbol : null;
}

// Candles as the optimizer's price points, oldest first
function readCandles(db, venue, symbol, interval, fromMs, toMs) {
  if (!hasTable(db, 'candles')) return [];
  return db.prepare(`
    SELECT open_time AS timestamp, open, high, low, close, volume
    FROM main.candles
    WHERE venue = ? AND symbol = ? AND interval = ? AND open_time >= ? AND open_time <= ?
    ORDER BY open_time
  `).all(venue, symbol, interval, fromMs, toMs);
}

// Holes longer than maxGapMs at the start, between candles and at the end of [fromMs, toMs]
function candleGaps(candles, fromMs, toMs, maxGapMs = CANDLE_MAX_GAP_MS) {
  const gaps = [];
  let previous = fromMs;
  for (const candle of candles) {
    if (candle.timestamp - previous > maxGapMs) gaps.push([previous, candle.timestamp]);
    previous = Math.max(previous, candle.timestamp);
  }
  if (toMs - previous > maxGapMs) gaps.push([previous, toMs]);
  return gaps;
}

// Fetches 1m candles of one symbol from fromMs to now into the database (lighter:backfill --candles-only). The
// script's output is captured, not passed through: this process's stdout is what optimizerService parses and its
// stderr is logged there as an error. It is shown only when the script fails. deps: spawn, log (tests).
function fetchLighterCandles(symbol, fromMs, now, cwd, deps = {}) {
  const spawn = deps.spawn || spawnSync;
  const log = deps.log || console.log;
  const days = Math.max((now - fromMs) / DAY_MS, 1 / 24);
  const tsxCli = require.resolve('tsx/cli');
  const script = path.join(cwd, 'scripts', 'lighter-backfill.ts');
  const startedAt = Date.now();
  const result = spawn(
    process.execPath,
    [tsxCli, script, '--candles-only', '--symbols', symbol, '--days', days.toFixed(4)],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  );
  if (result.status === 0) {
    log(`   Fetched ${symbol} candles in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    return true;
  }
  const how = result.error ? result.error.message : result.status !== null ? `exit code ${result.status}` : `signal ${result.signal}`;
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim().split('\n').slice(-15);
  log(`   ⚠️  lighter:backfill --candles-only for ${symbol} failed (${how})${output[0] ? ':' : ''}`);
  for (const line of output) if (line) log(`      ${line}`);
  return false;
}

// getPrices(symbol, interval, totalCandles) for the Lighter venue: the last totalCandles minutes, stretched back to
// the symbol's oldest liquidation, from the candles table. Gaps are fetched once per symbol and run.
function createLighterPriceSource({ db, cwd, now = Date.now, fetchCandles = fetchLighterCandles, log = console.log }) {
  const cache = new Map();
  const fetched = new Set();
  return function getPrices(symbol, interval = LIGHTER_CANDLE_INTERVAL, totalCandles = 10080) {
    if (interval !== LIGHTER_CANDLE_INTERVAL) {
      log(`   ⚠️  Lighter prices are stored at ${LIGHTER_CANDLE_INTERVAL} only (asked for ${interval})`);
      return [];
    }
    const key = `${symbol}:${interval}:${totalCandles}`;
    if (cache.has(key)) return cache.get(key);

    const toMs = now();
    let fromMs = Math.floor((toMs - totalCandles * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
    const oldest = db.prepare('SELECT MIN(event_time) AS first FROM liquidations WHERE symbol = ?').get(symbol);
    if (oldest && typeof oldest.first === 'number' && oldest.first - 60 * MINUTE_MS < fromMs) {
      fromMs = Math.floor((oldest.first - 60 * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
    }

    let candles = readCandles(db, 'lighter', symbol, interval, fromMs, toMs);
    const gaps = candleGaps(candles, fromMs, toMs);
    if (gaps.length > 0 && !fetched.has(symbol)) {
      fetched.add(symbol);
      log(`   Fetching Lighter ${interval} candles for ${symbol} (${gaps.length} gap(s) in the stored ones)...`);
      if (fetchCandles(symbol, gaps[0][0], toMs, cwd)) {
        candles = readCandles(db, 'lighter', symbol, interval, fromMs, toMs);
      } else {
        log(`   ⚠️  Fetching Lighter candles for ${symbol} failed; using the ${candles.length} stored candle(s)`);
      }
    }
    cache.set(key, candles);
    return candles;
  };
}

function toNumber(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

// The Lighter account (public GET /api/v1/account) in the shapes the optimizer reads from Aster's balance, account
// and positionRisk endpoints. Zero balance without an account index.
async function getLighterAccountSnapshot(config, httpGet) {
  const empty = { balance: { totalWalletBalance: 0, availableBalance: 0, crossMargin: 0 }, accountInfo: null, positions: [] };
  const lighter = (config && config.venues && config.venues.lighter) || {};
  const base = LIGHTER_API_URLS[lighter.profile || 'testnet'];
  const accountIndex = lighter.accountIndex;
  if (!base || accountIndex === undefined || accountIndex === null || accountIndex === '') {
    console.log('ℹ️  No Lighter account index configured: account balance taken as 0');
    return empty;
  }
  try {
    const body = await httpGet(`${base}/api/v1/account?by=index&value=${encodeURIComponent(String(accountIndex))}&active_only=true`);
    const accounts = Array.isArray(body && body.accounts) ? body.accounts : [];
    const account = accounts.find(item => item.index === Number(accountIndex) || item.account_index === Number(accountIndex)) || accounts[0];
    if (!account) throw new Error(`account ${accountIndex} not found`);
    const positions = (Array.isArray(account.positions) ? account.positions : [])
      .filter(position => toNumber(position.position) !== 0)
      .map(position => {
        const size = toNumber(position.position);
        const imf = toNumber(position.initial_margin_fraction);
        return {
          symbol: String(position.symbol || position.market_id),
          positionAmt: String(position.sign === -1 ? -size : size),
          entryPrice: position.avg_entry_price,
          markPrice: size > 0 ? String(toNumber(position.position_value) / size) : '0',
          unRealizedProfit: position.unrealized_pnl,
          initialMargin: position.allocated_margin,
          leverage: imf > 0 ? String(100 / imf) : '1',
        };
      });
    const unrealized = positions.reduce((sum, position) => sum + toNumber(position.unRealizedProfit), 0);
    return {
      balance: {
        totalWalletBalance: toNumber(account.collateral),
        availableBalance: toNumber(account.available_balance),
        crossMargin: 0,
      },
      accountInfo: {
        totalMarginBalance: toNumber(account.total_asset_value),
        totalWalletBalance: toNumber(account.collateral),
        totalUnrealizedProfit: unrealized,
        totalInitialMargin: toNumber(account.cross_initial_margin_requirement),
        totalMaintMargin: toNumber(account.cross_maintenance_margin_requirement),
      },
      positions,
    };
  } catch (error) {
    console.error('❌ Failed to fetch the Lighter account:', error && error.message ? error.message : error);
    return empty;
  }
}

module.exports = {
  OPTIMIZER_VENUES,
  LIGHTER_API_URLS,
  LIGHTER_CANDLE_INTERVAL,
  SHADOW_MODE_SKIP_REASON,
  LIGHTER_DATA_NOTE,
  parseOptimizerVenueOptions,
  venueCondition,
  scopeLiquidationsToVenue,
  bookCheckNote,
  busiestSymbol,
  readCandles,
  candleGaps,
  fetchLighterCandles,
  createLighterPriceSource,
  getLighterAccountSnapshot,
};
