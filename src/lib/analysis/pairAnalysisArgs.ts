import type { ExitFill, HedgeSizing } from './pairAnalysis';

export const PAIR_ANALYSIS_VENUES = ['aster', 'lighter'] as const;
export type PairAnalysisVenue = (typeof PAIR_ANALYSIS_VENUES)[number];

export const PAIR_ANALYSIS_DEFAULTS = {
  venue: 'lighter' as PairAnalysisVenue,
  minUsd: 0,
  dedupeSec: 60,
  horizons: [5, 15, 60],
  hedgeSymbol: 'BTCUSDT',
  hedgeSizing: 'beta' as HedgeSizing,
  betaLookbackMin: 240,
  betaMinObservations: 30,
  pairWindowSec: 120,
  exitFill: 'exact' as ExitFill,
  exitCarryMaxMin: 5,
  feeBps: 5,
  slippageBps: 0,
};

export const PAIR_ANALYSIS_USAGE = `Usage: npm run analyze:pairs -- [options]

Would a hedged or paired version of the contrarian liquidation trade have done better than the single leg? Replays
the stored liquidations against the stored 1m candles (data/liquidations.db, or LIQUIDATIONS_DB_PATH) and reports,
per strategy and horizon, the net return in bps, the paired differences (pair minus single, cross-pair also minus both
singles) and a per-symbol breakdown.
Read-only. Fill the database first with: npm run lighter:backfill

Events
  --venue aster|lighter       Whose liquidations to read (default ${PAIR_ANALYSIS_DEFAULTS.venue})
  --include-skipped           Also use detections the feed did not trade. Default scope: skip_reason is empty or
                              'shadow mode'. Only Lighter rows have a skip_reason, so for aster it changes nothing.
  --symbols A,B               Only these symbols (default: all)
  --since TIME                Only events at or after this UTC time: 2026-10-12 or 2026-10-12T06:00:00Z
  --until TIME                Only events before this UTC time (--since and --until split a run into halves
                              to check that a result holds out of sample). A trade near the split still uses up
                              to the longest horizon of the other half; see --until-exits.
  --until-exits               With --until: also leave out trades whose exit closes after it, so the first half
                              uses no prices of the second (counted as 'exit past --until')
  --min-usd N                 Ignore liquidations below N USD (default ${PAIR_ANALYSIS_DEFAULTS.minUsd}), judged row by row before bursts
                              collapse: one big liquidation trades, small ones that add up do not. See --burst-sum.
  --burst-sum                 Apply --min-usd to the total of the burst (rows of one symbol and side within
                              --dedupe-sec) instead of to each row: several small liquidations that add up trade, at
                              the row where the total crosses. Models the bot's 60 s rolling threshold (useThreshold).
  --dedupe-sec N              One event per symbol and side within N seconds (default ${PAIR_ANALYSIS_DEFAULTS.dedupeSec})
  --candle-venue aster|lighter  Whose candles to price with (default: the --venue). Only Lighter candles are
                              stored (npm run lighter:backfill); use --candle-venue lighter to price Aster events.

Strategies
  --horizons 5,15,60          Holding times in minutes (default ${PAIR_ANALYSIS_DEFAULTS.horizons.join(',')})
  --hedge-symbol BTCUSDT      The hedge leg of "hedged" (default ${PAIR_ANALYSIS_DEFAULTS.hedgeSymbol})
  --extra-hedges ETHUSDT      More hedge symbols, one extra "hedged" strategy each (default: none)
  --hedge-sizing beta|dollar  beta: hedge notional = beta x the leg (default). dollar: equal notional.
  --beta-lookback N           Minutes of 1m returns before the event for beta (default ${PAIR_ANALYSIS_DEFAULTS.betaLookbackMin})
  --beta-min-obs N            Fewer paired returns than this: beta 1 and counted as a fallback (default ${PAIR_ANALYSIS_DEFAULTS.betaMinObservations})
  --pair-window-sec N         Opposite-direction signal on another symbol within N seconds (default ${PAIR_ANALYSIS_DEFAULTS.pairWindowSec})
  --exit-fill exact|carry     exact: a missing exit candle (Lighter has none for a minute without trades) leaves the
                              event out (default). carry: use the last stored close at or before the exit minute, up
                              to --exit-carry-max-min back; the report counts how often.
  --exit-carry-max-min N      With --exit-fill carry: the furthest back to look (default ${PAIR_ANALYSIS_DEFAULTS.exitCarryMaxMin})

Costs (per leg and side)
  --fee-bps N                 Taker fee (default ${PAIR_ANALYSIS_DEFAULTS.feeBps} = 0.05%; Lighter standard accounts pay 0)
  --slippage-bps N            Extra cost per leg and side (default ${PAIR_ANALYSIS_DEFAULTS.slippageBps})

Output
  --json PATH                 Also write the full result as JSON
  --json-trades               With --json: include every trade (large)
  -h, --help                  This text`;

export interface PairAnalysisArgs {
  venue: PairAnalysisVenue;
  candleVenue: PairAnalysisVenue;
  includeSkipped: boolean;
  symbols?: string[];
  since?: number;                                   // ms, inclusive
  until?: number;                                   // ms, exclusive
  untilExits: boolean;                              // Also leave out trades whose exit closes after `until`
  minUsd: number;
  burstSum: boolean;                                // minUsd applies to the burst total, not to each row
  dedupeSec: number;
  horizons: number[];
  hedgeSymbol: string;
  extraHedges: string[];
  hedgeSizing: HedgeSizing;
  betaLookbackMin: number;
  betaMinObservations: number;
  pairWindowSec: number;
  exitFill: ExitFill;
  exitCarryMaxMin: number;
  feeBps: number;
  slippageBps: number;
  json?: string;
  jsonTrades: boolean;
  help: boolean;
}

function symbolList(text: string, flag: string): string[] {
  const symbols = text.split(',').map(symbol => symbol.trim().toUpperCase()).filter(symbol => symbol !== '');
  if (symbols.length === 0) throw new Error(`${flag} needs at least one symbol`);
  return [...new Set(symbols)];
}

// A UTC time: a date, or a date and time with Z or an offset. A time without a zone would depend on the machine.
const UTC_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2})))?$/;

// Date.parse rolls an impossible date over (2026-02-30 is March 2, T24:00 the next day), so the parts are checked
// against the calendar: the date must survive a round trip through Date.UTC, and the clock parts must be in range.
function utcTime(text: string, flag: string): number {
  const match = UTC_TIME.exec(text);
  if (!match) throw new Error(`${flag} must be a UTC date or time such as 2026-10-12 or 2026-10-12T06:00:00Z, not "${text}"`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  const roundTrips = calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
  const [hour, minute, second, offsetHour, offsetMinute] = [match[4], match[5], match[6], match[8], match[9]].map(part => (part === undefined ? 0 : Number(part)));
  const clockInRange = hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59;
  const ms = roundTrips && clockInRange ? Date.parse(text) : NaN;
  if (!Number.isFinite(ms)) throw new Error(`${flag} is not a real date or time: "${text}"`);
  return ms;
}

function venueName(text: string, flag: string): PairAnalysisVenue {
  if (!(PAIR_ANALYSIS_VENUES as readonly string[]).includes(text)) {
    throw new Error(`${flag} must be one of: ${PAIR_ANALYSIS_VENUES.join(', ')}, not "${text}"`);
  }
  return text as PairAnalysisVenue;
}

// argv after the script name. Throws with a readable message on bad input.
export function parsePairAnalysisArgs(argv: readonly string[]): PairAnalysisArgs {
  const args: PairAnalysisArgs = {
    venue: PAIR_ANALYSIS_DEFAULTS.venue,
    candleVenue: PAIR_ANALYSIS_DEFAULTS.venue,
    includeSkipped: false,
    untilExits: false,
    minUsd: PAIR_ANALYSIS_DEFAULTS.minUsd,
    burstSum: false,
    dedupeSec: PAIR_ANALYSIS_DEFAULTS.dedupeSec,
    horizons: [...PAIR_ANALYSIS_DEFAULTS.horizons],
    hedgeSymbol: PAIR_ANALYSIS_DEFAULTS.hedgeSymbol,
    extraHedges: [],
    hedgeSizing: PAIR_ANALYSIS_DEFAULTS.hedgeSizing,
    betaLookbackMin: PAIR_ANALYSIS_DEFAULTS.betaLookbackMin,
    betaMinObservations: PAIR_ANALYSIS_DEFAULTS.betaMinObservations,
    pairWindowSec: PAIR_ANALYSIS_DEFAULTS.pairWindowSec,
    exitFill: PAIR_ANALYSIS_DEFAULTS.exitFill,
    exitCarryMaxMin: PAIR_ANALYSIS_DEFAULTS.exitCarryMaxMin,
    feeBps: PAIR_ANALYSIS_DEFAULTS.feeBps,
    slippageBps: PAIR_ANALYSIS_DEFAULTS.slippageBps,
    jsonTrades: false,
    help: false,
  };
  let candleVenue: PairAnalysisVenue | undefined;

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      i++;
      return next;
    };
    const number = (min: number, integer = false): number => {
      const text = value();
      const parsed = text.trim() === '' ? NaN : Number(text);
      if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isInteger(parsed))) {
        throw new Error(`${flag} must be ${integer ? 'a whole number' : 'a number'} of ${min} or more, not "${text}"`);
      }
      return parsed;
    };

    switch (flag) {
      case '--venue':
        args.venue = venueName(value(), flag);
        break;
      case '--candle-venue':
        candleVenue = venueName(value(), flag);
        break;
      case '--include-skipped':
        args.includeSkipped = true;
        break;
      case '--symbols':
        args.symbols = symbolList(value(), flag);
        break;
      case '--since':
        args.since = utcTime(value(), flag);
        break;
      case '--until':
        args.until = utcTime(value(), flag);
        break;
      case '--until-exits':
        args.untilExits = true;
        break;
      case '--min-usd':
        args.minUsd = number(0);
        break;
      case '--burst-sum':
        args.burstSum = true;
        break;
      case '--dedupe-sec':
        args.dedupeSec = number(0);
        break;
      case '--horizons': {
        const text = value();
        const horizons = text.split(',').map(part => part.trim()).filter(part => part !== '').map(Number);
        if (horizons.length === 0 || horizons.some(horizon => !Number.isInteger(horizon) || horizon < 1)) {
          throw new Error(`--horizons must be whole minutes of 1 or more, comma separated, not "${text}"`);
        }
        args.horizons = [...new Set(horizons)].sort((a, b) => a - b);
        break;
      }
      case '--hedge-symbol':
        args.hedgeSymbol = symbolList(value(), flag)[0];
        break;
      case '--extra-hedges':
        args.extraHedges = symbolList(value(), flag);
        break;
      case '--hedge-sizing': {
        const sizing = value();
        if (sizing !== 'beta' && sizing !== 'dollar') throw new Error(`--hedge-sizing must be beta or dollar, not "${sizing}"`);
        args.hedgeSizing = sizing;
        break;
      }
      case '--beta-lookback':
        args.betaLookbackMin = number(10, true);
        break;
      case '--beta-min-obs':
        args.betaMinObservations = number(2, true);
        break;
      case '--pair-window-sec':
        args.pairWindowSec = number(0);
        break;
      case '--exit-fill': {
        const fill = value();
        if (fill !== 'exact' && fill !== 'carry') throw new Error(`--exit-fill must be exact or carry, not "${fill}"`);
        args.exitFill = fill;
        break;
      }
      case '--exit-carry-max-min':
        args.exitCarryMaxMin = number(1, true);
        break;
      case '--fee-bps':
        args.feeBps = number(0);
        break;
      case '--slippage-bps':
        args.slippageBps = number(0);
        break;
      case '--json': {
        const target = value();
        if (target.trim() === '') throw new Error('--json needs a file path');
        args.json = target;
        break;
      }
      case '--json-trades':
        args.jsonTrades = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`unknown option ${raw}`);
    }
  }

  if (args.help) return args;
  args.candleVenue = candleVenue ?? args.venue;
  args.extraHedges = args.extraHedges.filter(symbol => symbol !== args.hedgeSymbol);
  if (args.since !== undefined && args.until !== undefined && args.since >= args.until) {
    throw new Error('--since must be before --until');
  }
  if (args.untilExits && args.until === undefined) throw new Error('--until-exits needs --until TIME');
  if (args.jsonTrades && args.json === undefined) throw new Error('--json-trades needs --json PATH');
  if (args.betaMinObservations > args.betaLookbackMin) {
    throw new Error(`--beta-min-obs (${args.betaMinObservations}) cannot exceed --beta-lookback (${args.betaLookbackMin})`);
  }
  return args;
}
