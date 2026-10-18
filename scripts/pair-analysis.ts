#!/usr/bin/env tsx
// Pair-trade analysis of the liquidation signal: would a hedged (BTC) or paired (two symbols liquidated in opposite
// directions) version of the bot's contrarian trade have done better than the single leg? Replays the liquidations and
// 1m candles in data/liquidations.db (LIQUIDATIONS_DB_PATH overrides the file, as for the bot, lighter:backfill and the
// optimizer) and prints, per strategy and horizon, net return statistics, pair-minus-single differences and a
// per-symbol breakdown. Read-only: it never writes the database, calls an exchange or touches the trading path. See
// docs/PAIR-ANALYSIS.md.
//
//   npm run analyze:pairs -- [--venue aster|lighter] [--include-skipped] [--symbols A,B] [--since T] [--until T]
//                            [--min-usd N] [--dedupe-sec 60] [--horizons 5,15,60] [--hedge-symbol BTCUSDT] [--extra-hedges ETHUSDT]
//                            [--beta-lookback 240] [--pair-window-sec 120] [--fee-bps 5] [--slippage-bps 0]
//                            [--json PATH [--json-trades]]
//
// Candles for the hedge symbol come from `npm run lighter:backfill -- --candles-only --symbols BTCUSDT --days N`; the
// report prints that command when they are missing.

import fs from 'fs';
import path from 'path';
import { defaultLiquidationsDbPath } from '../src/lib/db/database';
import { analyzePairs, selectEvents } from '../src/lib/analysis/pairAnalysis';
import { PAIR_ANALYSIS_USAGE, parsePairAnalysisArgs } from '../src/lib/analysis/pairAnalysisArgs';
import { loadPairAnalysisInput } from '../src/lib/analysis/pairAnalysisDb';
import { formatPairAnalysisReport, pairAnalysisJson, type PairAnalysisReportContext } from '../src/lib/analysis/pairAnalysisReport';

function main(): number {
  let args;
  try {
    args = parsePairAnalysisArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`analyze:pairs: ${error instanceof Error ? error.message : String(error)}\n`);
    console.error(PAIR_ANALYSIS_USAGE);
    return 2;
  }
  if (args.help) {
    console.log(PAIR_ANALYSIS_USAGE);
    return 0;
  }

  const dbPath = defaultLiquidationsDbPath();
  const hedgeSymbols = [args.hedgeSymbol, ...args.extraHedges];
  let input;
  try {
    input = loadPairAnalysisInput(dbPath, {
      venue: args.venue,
      candleVenue: args.candleVenue,
      includeSkipped: args.includeSkipped,
      symbols: args.symbols,
      sinceMs: args.since,
      untilMs: args.until,
      hedgeSymbols,
      betaLookbackMin: args.betaLookbackMin,
      maxHorizonMin: Math.max(...args.horizons),
    });
  } catch (error) {
    console.error(`analyze:pairs: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const selection = selectEvents(input.rows, { minUsd: args.minUsd, dedupeSec: args.dedupeSec });
  const now = Date.now();
  const result = analyzePairs(selection.events, input.series, {
    horizonsMin: args.horizons,
    hedgeSymbol: args.hedgeSymbol,
    extraHedges: args.extraHedges,
    hedgeSizing: args.hedgeSizing,
    betaLookbackMin: args.betaLookbackMin,
    betaMinObservations: args.betaMinObservations,
    pairWindowSec: args.pairWindowSec,
    feeBps: args.feeBps,
    slippageBps: args.slippageBps,
    now,
    keepTrades: args.jsonTrades,
  });
  const context: PairAnalysisReportContext = {
    dbPath,
    venue: args.venue,
    candleVenue: args.candleVenue,
    includeSkipped: args.includeSkipped,
    symbolsFilter: args.symbols,
    sinceMs: args.since,
    untilMs: args.until,
    minUsd: args.minUsd,
    dedupeSec: args.dedupeSec,
    selection,
    candlesLoaded: input.candlesLoaded,
    notes: input.notes,
    now,
  };

  console.log(formatPairAnalysisReport(result, context));
  if (args.json) {
    const target = path.resolve(args.json);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(pairAnalysisJson(result, context, now), null, 2)}\n`);
    console.log(`\nFull result written to ${target}`);
  }
  if (selection.events.length === 0) {
    console.error('\nanalyze:pairs: no liquidations in scope. Load some with npm run lighter:backfill (or let the bot record them), or widen the scope.');
    return 1;
  }
  return 0;
}

process.exitCode = main();
