import { isLighterProfileName, type LighterProfileName } from '../exchange/lighter/profiles';
import { LIGHTER_BACKFILL_DEFAULT_DAYS, LIGHTER_BACKFILL_DEFAULT_DELAY_MS, LIGHTER_BACKFILL_MAX_PAGES } from './backfill';

export const LIGHTER_BACKFILL_USAGE = `Usage: npm run lighter:backfill -- [options]

Loads Lighter liquidation history (and 1m candles) into data/liquidations.db for the optimizer.

  --profile mainnet|testnet   Lighter network (default: venues.lighter.profile from the config)
  --days N                    How far back to go (default ${LIGHTER_BACKFILL_DEFAULT_DAYS}; fractions allowed)
  --symbols BTCUSDT,ETHUSDT   Bot symbols (default: the configured symbols that map to Lighter markets)
  --no-candles                Skip the 1m candles
  --candles-only              Only the 1m candles (the optimizer uses this to fill gaps)
  --dry-run                   Fetch and count, store nothing
  --delay-ms N                Minimum gap between requests (default ${LIGHTER_BACKFILL_DEFAULT_DELAY_MS})
  --max-pages N               Trade pages (100 fills each) per symbol before it gives up (default ${LIGHTER_BACKFILL_MAX_PAGES})
  --force                     Backfill more days than global.liquidationRetentionDays allows (see below)
  --source trades|export      trades (default): the free public trades API.
                              export: the paid historical export (not supported yet).

The bot deletes liquidations and candles older than global.liquidationRetentionDays (default 7) once a day, so a
longer --days is refused: set global.liquidationRetentionDays to at least --days (or 0 to keep everything) first,
or pass --force.`;

export interface LighterBackfillArgs {
  profile?: LighterProfileName;
  days: number;
  symbols?: string[];
  candles: boolean;
  liquidations: boolean;
  dryRun: boolean;
  delayMs: number;
  maxPages?: number;
  force: boolean;
  source: 'trades' | 'export';
  help: boolean;
}

// argv after the script name. Throws with a readable message on bad input.
export function parseLighterBackfillArgs(argv: readonly string[]): LighterBackfillArgs {
  const args: LighterBackfillArgs = {
    days: LIGHTER_BACKFILL_DEFAULT_DAYS,
    candles: true,
    liquidations: true,
    dryRun: false,
    delayMs: LIGHTER_BACKFILL_DEFAULT_DELAY_MS,
    force: false,
    source: 'trades',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      i++;
      return next;
    };
    switch (flag) {
      case '--profile': {
        const profile = value();
        if (!isLighterProfileName(profile)) throw new Error(`--profile must be mainnet or testnet, not "${profile}"`);
        args.profile = profile;
        break;
      }
      case '--days': {
        const text = value();
        const days = Number(text);
        if (!Number.isFinite(days) || days <= 0) throw new Error(`--days must be a positive number, not "${text}"`);
        args.days = days;
        break;
      }
      case '--symbols': {
        const symbols = value().split(',').map((symbol) => symbol.trim().toUpperCase()).filter((symbol) => symbol !== '');
        if (symbols.length === 0) throw new Error('--symbols needs at least one symbol');
        args.symbols = [...new Set(symbols)];
        break;
      }
      case '--no-candles':
        args.candles = false;
        break;
      case '--candles-only':
        args.liquidations = false;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--delay-ms': {
        const text = value();
        const delay = Number(text);
        if (!Number.isFinite(delay) || delay < 0) throw new Error(`--delay-ms must be 0 or more, not "${text}"`);
        args.delayMs = delay;
        break;
      }
      case '--max-pages': {
        const text = value();
        const pages = Number(text);
        if (!Number.isInteger(pages) || pages < 1) throw new Error(`--max-pages must be a whole number of 1 or more, not "${text}"`);
        args.maxPages = pages;
        break;
      }
      case '--force':
        args.force = true;
        break;
      case '--source': {
        const source = value();
        if (source !== 'trades' && source !== 'export') throw new Error(`--source must be trades or export, not "${source}"`);
        args.source = source;
        break;
      }
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`unknown option ${raw}`);
    }
  }
  if (!args.candles && !args.liquidations) throw new Error('--no-candles and --candles-only leave nothing to do');
  return args;
}

// Why a run is refused: its window is longer than the retention, so the bot's next daily cleanup would delete the
// older rows again. null when it may go ahead. Dry runs store nothing, and candles-only runs (the optimizer filling
// gaps) reach back at most the retention plus an hour, so neither is held to the retention.
export function lighterBackfillRetentionProblem(
  args: Pick<LighterBackfillArgs, 'days' | 'liquidations' | 'dryRun' | 'force'>,
  retentionDays: number
): string | null {
  if (args.force || args.dryRun || !args.liquidations || !(retentionDays > 0) || args.days <= retentionDays) return null;
  return (
    `--days ${args.days} is longer than global.liquidationRetentionDays (${retentionDays}). The bot deletes liquidations ` +
    `and candles older than ${retentionDays} days once a day, so everything older would be removed again. Set ` +
    `global.liquidationRetentionDays to at least ${Math.ceil(args.days)} (0 keeps everything) in config.user.json or on ` +
    'the Config page, or pass --force to backfill anyway.'
  );
}

// The paid source: GET /api/v1/export/historicalTrades (one-time 100 LIT L2 transfer, auth) returns a presigned
// URL per UTC day, but neither the SDK nor the OpenAPI spec documents the file behind it
export const LIGHTER_EXPORT_NOT_SUPPORTED =
  'The Lighter historical trades export (/api/v1/export/historicalTrades) is not supported yet: it needs a one-time ' +
  '100 LIT transfer and an auth token, and the format of the file it links to is not documented in the Lighter SDK ' +
  'or API spec, so the backfill does not guess it. Use the default source (--source trades), which pages through ' +
  'the free public trades API.';
