#!/usr/bin/env tsx
// Lighter liquidation history for the optimizer: pages through the public trades API (type=liquidation) and the
// 1m candles of the configured symbols and stores them in data/liquidations.db (venue 'lighter', source
// 'backfill'). Safe to re-run or interrupt: rows already stored are skipped (unique venue + liquidation id), and
// candles are overwritten with the latest values. A symbol's liquidations are stored once its paging ends, so an
// interrupted symbol has stored nothing yet. See docs/LIGHTER-HISTORY.md.
//
//   npm run lighter:backfill -- [--profile mainnet|testnet] [--days 7] [--symbols BTCUSDT,ETHUSDT]
//                               [--no-candles] [--candles-only] [--dry-run] [--delay-ms 1100]
//                               [--max-pages 2000] [--force]
//
// Read-only on the exchange: it never signs a transaction. If the server refuses the trades request without an
// auth token, it signs one with the configured Lighter API key (or uses LIGHTER_AUTH_TOKEN); tokens are never
// printed (src/lib/lighterHistory/auth.ts).

import { loadConfig } from '../src/lib/bot/config';
import { db } from '../src/lib/db/database';
import { LighterHttpClient } from '../src/lib/exchange/lighter/http';
import { LighterMarketCache } from '../src/lib/exchange/lighter/markets';
import { getProfile } from '../src/lib/exchange/lighter/profiles';
import {
  LIGHTER_EXPORT_NOT_SUPPORTED,
  LIGHTER_BACKFILL_USAGE,
  lighterBackfillRetentionProblem,
  parseLighterBackfillArgs,
} from '../src/lib/lighterHistory/args';
import { lighterBackfillAuthSource } from '../src/lib/lighterHistory/auth';
import {
  LIGHTER_BACKFILL_MAX_EMPTY_PAGES,
  LIGHTER_BACKFILL_MAX_PAGES,
  backfillMarketsFor,
  backfillWindowStart,
  describeLighterBackfillStop,
  runLighterBackfill,
  type LighterBackfillReport,
} from '../src/lib/lighterHistory/backfill';
import { DEFAULT_LIQUIDATION_RETENTION_DAYS, liquidationStorage } from '../src/lib/services/liquidationStorage';
import type { Config } from '../src/lib/types';

function readLighterProfileName(config: Config): string {
  return config.venues?.lighter?.profile ?? 'testnet';
}

function printReport(report: LighterBackfillReport, dryRun: boolean, limits: { maxPages: number; maxEmptyPages: number }): void {
  console.log('');
  console.log(`Window ${new Date(report.fromMs).toISOString()} -> ${new Date(report.toMs).toISOString()}${dryRun ? ' (dry run: nothing stored)' : ''}`);
  for (const item of report.symbols) {
    const parts = [
      `${item.liquidations} liquidations (${item.gatePassed} pass the side gates)`,
      `${item.inserted} new`,
      `${item.fills} fills over ${item.tradePages} pages`,
    ];
    if (item.droppedFills > 0) parts.push(`${item.droppedFills} unusable fills`);
    if (item.candlePages > 0) parts.push(`${item.candles} candles`);
    const stop = item.stopReason ? describeLighterBackfillStop(item.stopReason, limits) : null;
    if (stop) parts.push(stop);
    console.log(`  ${item.symbol.padEnd(14)} ${parts.join(', ')}`);
  }
  if (report.authUsed) console.log('  (the trades API needed an auth token)');
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseLighterBackfillArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`lighter:backfill: ${error instanceof Error ? error.message : String(error)}\n`);
    console.error(LIGHTER_BACKFILL_USAGE);
    return 2;
  }
  if (args.help) {
    console.log(LIGHTER_BACKFILL_USAGE);
    return 0;
  }
  if (args.source === 'export') {
    console.error(LIGHTER_EXPORT_NOT_SUPPORTED);
    return 2;
  }

  const config = await loadConfig();
  const profileName = args.profile ?? readLighterProfileName(config);
  const profile = getProfile(profileName);
  const symbols = args.symbols ?? Object.keys(config.symbols ?? {});
  if (symbols.length === 0) {
    console.error('No symbols: configure some or pass --symbols');
    return 2;
  }

  const retention = config.global.liquidationRetentionDays ?? DEFAULT_LIQUIDATION_RETENTION_DAYS;
  const retentionProblem = lighterBackfillRetentionProblem(args, retention);
  if (retentionProblem) {
    console.error(`lighter:backfill: ${retentionProblem}`);
    return 2;
  }
  if (args.force && args.liquidations && !args.dryRun && retention > 0 && args.days > retention) {
    console.warn(
      `⚠️  --force: global.liquidationRetentionDays is ${retention}, so the bot's daily cleanup will delete the backfilled ` +
      `rows older than ${retention} days.`
    );
  }

  const client = new LighterHttpClient({ profile });
  const markets = new LighterMarketCache({
    profile,
    symbols: { allowlist: symbols, overrides: config.venues?.lighter?.symbolOverrides },
    httpGet: client.get,
  });
  await markets.load();
  const { markets: targets, missing } = backfillMarketsFor(symbols, markets.entries(), markets.rejectedSymbols());
  for (const item of missing) console.warn(`⚠️  ${item.symbol}: skipped (${item.reason})`);
  if (targets.length === 0) {
    console.error(`None of ${symbols.join(', ')} maps to a Lighter ${profile.label} market`);
    return 1;
  }

  // Without the liquidity pool account, LLP takeovers can't be told apart from book liquidations (as live)
  let liquidityPoolIndex: number | null = null;
  if (args.liquidations) {
    const systemConfig = await client.getSystemConfig();
    if (typeof systemConfig.liquidity_pool_index !== 'number') {
      console.error('Lighter systemConfig has no liquidity_pool_index: cannot tell LLP takeovers from book liquidations');
      return 1;
    }
    liquidityPoolIndex = systemConfig.liquidity_pool_index;
  }

  const now = Date.now();
  const fromMs = backfillWindowStart(args.days, now);
  console.log(
    `Lighter ${profile.label} backfill: ${targets.map(target => target.botSymbol).join(', ')}, last ${args.days} day(s)` +
    `${args.liquidations ? '' : ', candles only'}${args.candles ? '' : ', no candles'}${args.dryRun ? ', dry run' : ''}`
  );
  const report = await runLighterBackfill(
    {
      client,
      storage: liquidationStorage,
      getAuthToken: lighterBackfillAuthSource(config, profile),
      log: line => console.log(line),
    },
    {
      markets: targets,
      fromMs,
      toMs: now,
      liquidityPoolIndex,
      liquidations: args.liquidations,
      candles: args.candles,
      dryRun: args.dryRun,
      delayMs: args.delayMs,
      maxPages: args.maxPages,
    }
  );
  printReport(report, args.dryRun, { maxPages: args.maxPages ?? LIGHTER_BACKFILL_MAX_PAGES, maxEmptyPages: LIGHTER_BACKFILL_MAX_EMPTY_PAGES });
  // A limit ended some symbol's paging early: what was found is stored, but the window is incomplete
  return report.symbols.some(item => item.stopReason === 'no-liquidation-rows' || item.stopReason === 'page-cap') ? 1 : 0;
}

main()
  .then(async (code) => {
    await db.close();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(`lighter:backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    await db.close();
    process.exit(1);
  });
