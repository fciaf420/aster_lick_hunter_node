/**
 * @jest-environment node
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PAIR_ANALYSIS_DEFAULTS, PAIR_ANALYSIS_USAGE, parsePairAnalysisArgs } from '../../../src/lib/analysis/pairAnalysisArgs';
import { HISTORY_TEST_TIMEOUT_MS, removeTmpDir } from '../history/tmp';
import { T0, flatPath, writeSyntheticDb } from './synthetic';

describe('parsePairAnalysisArgs', () => {
  it('has the documented defaults', () => {
    expect(parsePairAnalysisArgs([])).toEqual({
      venue: 'lighter',
      candleVenue: 'lighter',
      includeSkipped: false,
      untilExits: false,
      minUsd: 0,
      burstSum: false,
      dedupeSec: 60,
      horizons: [5, 15, 60],
      hedgeSymbol: 'BTCUSDT',
      extraHedges: [],
      hedgeSizing: 'beta',
      betaLookbackMin: 240,
      betaMinObservations: 30,
      pairWindowSec: 120,
      exitFill: 'exact',
      exitCarryMaxMin: 5,
      feeBps: 5,
      slippageBps: 0,
      jsonTrades: false,
      help: false,
    });
    expect(PAIR_ANALYSIS_DEFAULTS.venue).toBe('lighter');
  });

  it('reads every option, with a space or an equals sign', () => {
    const args = parsePairAnalysisArgs([
      '--venue', 'aster', '--candle-venue=lighter', '--include-skipped', '--symbols', 'solusdt, dogeusdt,SOLUSDT',
      '--since', '2026-10-12', '--until=2026-10-14T06:30:00+02:00', '--min-usd', '2500.5', '--dedupe-sec=30', '--horizons', '60,5,15,5', '--hedge-symbol', 'ethusdt', '--extra-hedges=BTCUSDT,SOLUSDT',
      '--hedge-sizing', 'dollar', '--beta-lookback', '120', '--beta-min-obs=20', '--pair-window-sec', '90',
      '--fee-bps', '0', '--slippage-bps=1.5', '--json', 'out/pairs.json', '--json-trades',
      '--until-exits', '--burst-sum', '--exit-fill', 'carry', '--exit-carry-max-min=3',
    ]);
    expect(args).toEqual({
      venue: 'aster',
      candleVenue: 'lighter',
      includeSkipped: true,
      symbols: ['SOLUSDT', 'DOGEUSDT'],
      since: Date.UTC(2026, 9, 12),
      until: Date.UTC(2026, 9, 14, 4, 30),
      untilExits: true,
      minUsd: 2500.5,
      burstSum: true,
      dedupeSec: 30,
      horizons: [5, 15, 60],
      hedgeSymbol: 'ETHUSDT',
      extraHedges: ['BTCUSDT', 'SOLUSDT'],
      hedgeSizing: 'dollar',
      betaLookbackMin: 120,
      betaMinObservations: 20,
      pairWindowSec: 90,
      exitFill: 'carry',
      exitCarryMaxMin: 3,
      feeBps: 0,
      slippageBps: 1.5,
      json: 'out/pairs.json',
      jsonTrades: true,
      help: false,
    });
  });

  it('prices events with the candles of their own venue unless told otherwise', () => {
    expect(parsePairAnalysisArgs(['--venue', 'aster']).candleVenue).toBe('aster');
    expect(parsePairAnalysisArgs(['--venue', 'aster', '--candle-venue', 'lighter']).candleVenue).toBe('lighter');
    expect(parsePairAnalysisArgs(['--candle-venue', 'aster']).venue).toBe('lighter');
  });

  it('drops the main hedge symbol from the extra hedges', () => {
    expect(parsePairAnalysisArgs(['--extra-hedges', 'btcusdt,ETHUSDT']).extraHedges).toEqual(['ETHUSDT']);
  });

  it('reads --since and --until as UTC and refuses a time with no zone or a reversed window', () => {
    expect(parsePairAnalysisArgs(['--since', '2026-10-12T06:00:00Z']).since).toBe(Date.UTC(2026, 9, 12, 6));
    expect(parsePairAnalysisArgs(['--until', '2026-10-12T06:00Z']).until).toBe(Date.UTC(2026, 9, 12, 6));
    expect(parsePairAnalysisArgs([]).since).toBeUndefined();
    expect(() => parsePairAnalysisArgs(['--since', '2026-10-12 06:00'])).toThrow(/--since must be a UTC date or time/);
    expect(() => parsePairAnalysisArgs(['--until', '2026-10-12T06:00:00'])).toThrow(/--until must be a UTC date or time/);
    expect(() => parsePairAnalysisArgs(['--since', 'yesterday'])).toThrow(/--since must be a UTC date or time/);
    expect(() => parsePairAnalysisArgs(['--since', '2026-13-45'])).toThrow(/--since is not a real date or time/);
    expect(() => parsePairAnalysisArgs(['--since', '2026-10-12', '--until', '2026-10-12'])).toThrow(/--since must be before --until/);
    expect(() => parsePairAnalysisArgs(['--since', '2026-10-13', '--until', '2026-10-12'])).toThrow(/--since must be before --until/);
  });

  it('rejects a date that does not exist instead of rolling it over', () => {
    // Date.parse turns 2026-02-30 into March 2 and T24:00 into the next day; the window would silently move
    for (const impossible of ['2026-02-30', '2026-02-29', '2026-04-31', '2026-00-10', '2026-10-00', '2026-10-32', '2026-02-30T10:00:00Z', '2026-10-12T24:00:00Z',
      '2026-10-12T23:60:00Z', '2026-10-12T23:59:60Z', '2026-10-12T10:00:00+24:00', '2026-10-12T10:00:00+05:60']) {
      expect(() => parsePairAnalysisArgs(['--since', impossible])).toThrow(/--since is not a real date or time/);
      expect(() => parsePairAnalysisArgs(['--until', impossible])).toThrow(/--until is not a real date or time/);
    }
    // ... while the real ones around them pass, including the leap day
    expect(parsePairAnalysisArgs(['--since', '2028-02-29']).since).toBe(Date.UTC(2028, 1, 29));
    expect(parsePairAnalysisArgs(['--since', '2026-02-28']).since).toBe(Date.UTC(2026, 1, 28));
    expect(parsePairAnalysisArgs(['--since', '2026-10-31']).since).toBe(Date.UTC(2026, 9, 31));
    expect(parsePairAnalysisArgs(['--since', '2026-10-12T23:59:59Z']).since).toBe(Date.UTC(2026, 9, 12, 23, 59, 59));
    expect(parsePairAnalysisArgs(['--since', '2026-10-12T00:00:00.500+05:30']).since).toBe(Date.UTC(2026, 9, 11, 18, 30, 0, 500));
  });

  it('needs --until for --until-exits', () => {
    expect(parsePairAnalysisArgs(['--until', '2026-10-14', '--until-exits'])).toMatchObject({ until: Date.UTC(2026, 9, 14), untilExits: true });
    expect(() => parsePairAnalysisArgs(['--until-exits'])).toThrow(/--until-exits needs --until TIME/);
    expect(() => parsePairAnalysisArgs(['--since', '2026-10-12', '--until-exits'])).toThrow(/--until-exits needs --until TIME/);
  });

  it('reads --burst-sum and the exit fill, with their checks', () => {
    expect(parsePairAnalysisArgs(['--min-usd', '5000', '--burst-sum'])).toMatchObject({ minUsd: 5000, burstSum: true });
    expect(parsePairAnalysisArgs(['--exit-fill', 'exact']).exitFill).toBe('exact');
    expect(parsePairAnalysisArgs(['--exit-fill=carry'])).toMatchObject({ exitFill: 'carry', exitCarryMaxMin: 5 });
    expect(() => parsePairAnalysisArgs(['--exit-fill', 'fill'])).toThrow(/--exit-fill must be exact or carry, not "fill"/);
    expect(() => parsePairAnalysisArgs(['--exit-fill'])).toThrow(/--exit-fill needs a value/);
    expect(() => parsePairAnalysisArgs(['--exit-carry-max-min', '0'])).toThrow(/--exit-carry-max-min must be a whole number of 1 or more/);
    expect(() => parsePairAnalysisArgs(['--exit-carry-max-min', '2.5'])).toThrow(/--exit-carry-max-min must be a whole number/);
  });

  it('recognises help without validating the rest', () => {
    expect(parsePairAnalysisArgs(['--help']).help).toBe(true);
    expect(parsePairAnalysisArgs(['-h']).help).toBe(true);
    expect(parsePairAnalysisArgs(['--json-trades', '--help']).help).toBe(true);
  });

  it('rejects bad input with a message that names the option', () => {
    expect(() => parsePairAnalysisArgs(['--frobnicate'])).toThrow(/unknown option --frobnicate/);
    expect(() => parsePairAnalysisArgs(['stray'])).toThrow(/unknown option stray/);
    expect(() => parsePairAnalysisArgs(['--venue'])).toThrow(/--venue needs a value/);
    expect(() => parsePairAnalysisArgs(['--symbols', '--include-skipped'])).toThrow(/--symbols needs a value/);
    expect(() => parsePairAnalysisArgs(['--venue', 'hyperliquid'])).toThrow(/--venue must be one of: aster, lighter, not "hyperliquid"/);
    expect(() => parsePairAnalysisArgs(['--candle-venue', 'x'])).toThrow(/--candle-venue must be one of/);
    expect(() => parsePairAnalysisArgs(['--min-usd', '-1'])).toThrow(/--min-usd must be a number of 0 or more/);
    expect(() => parsePairAnalysisArgs(['--fee-bps', 'abc'])).toThrow(/--fee-bps must be a number/);
    expect(() => parsePairAnalysisArgs(['--slippage-bps', ''])).toThrow(/--slippage-bps must be a number/);
    expect(() => parsePairAnalysisArgs(['--dedupe-sec=-5'])).toThrow(/--dedupe-sec/);
    expect(() => parsePairAnalysisArgs(['--pair-window-sec', 'NaN'])).toThrow(/--pair-window-sec/);
    expect(() => parsePairAnalysisArgs(['--horizons', '5,x'])).toThrow(/--horizons must be whole minutes/);
    expect(() => parsePairAnalysisArgs(['--horizons', '0'])).toThrow(/--horizons must be whole minutes/);
    expect(() => parsePairAnalysisArgs(['--horizons', '1.5'])).toThrow(/--horizons must be whole minutes/);
    expect(() => parsePairAnalysisArgs(['--horizons', ','])).toThrow(/--horizons must be whole minutes/);
    expect(() => parsePairAnalysisArgs(['--hedge-sizing', 'half'])).toThrow(/--hedge-sizing must be beta or dollar/);
    expect(() => parsePairAnalysisArgs(['--beta-lookback', '5'])).toThrow(/--beta-lookback must be a whole number of 10 or more/);
    expect(() => parsePairAnalysisArgs(['--beta-lookback', '60.5'])).toThrow(/--beta-lookback must be a whole number/);
    expect(() => parsePairAnalysisArgs(['--beta-min-obs', '1'])).toThrow(/--beta-min-obs/);
    expect(() => parsePairAnalysisArgs(['--beta-lookback', '20', '--beta-min-obs', '30'])).toThrow(/cannot exceed --beta-lookback/);
    expect(() => parsePairAnalysisArgs(['--symbols', ' , '])).toThrow(/--symbols needs at least one symbol/);
    expect(() => parsePairAnalysisArgs(['--json-trades'])).toThrow(/--json-trades needs --json PATH/);
    expect(() => parsePairAnalysisArgs(['--json='])).toThrow(/--json needs a file path/);
  });

  it('documents every option in the usage text', () => {
    for (const flag of [
      '--venue', '--include-skipped', '--symbols', '--since', '--until', '--until-exits', '--min-usd', '--burst-sum', '--dedupe-sec', '--candle-venue',
      '--horizons', '--hedge-symbol', '--extra-hedges', '--hedge-sizing', '--beta-lookback', '--beta-min-obs', '--pair-window-sec',
      '--exit-fill', '--exit-carry-max-min', '--fee-bps', '--slippage-bps', '--json', '--json-trades', '--help',
    ]) {
      expect(PAIR_ANALYSIS_USAGE).toContain(flag);
    }
  });
});

describe('scripts/pair-analysis.ts', () => {
  jest.setTimeout(HISTORY_TEST_TIMEOUT_MS * 4);
  const repo = path.join(__dirname, '..', '..', '..');
  const tsxCli = require.resolve('tsx/cli');
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-analysis-cli-'));
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  const cli = (args: string[], dbPath?: string) =>
    spawnSync(process.execPath, [tsxCli, 'scripts/pair-analysis.ts', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, ...(dbPath ? { LIQUIDATIONS_DB_PATH: dbPath } : {}) },
    });

  it('prints the usage for --help, and for a bad option exits 2 with the reason', () => {
    const help = cli(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: npm run analyze:pairs');
    const bad = cli(['--horizons', 'soon']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('analyze:pairs: --horizons must be whole minutes');
    const impossible = cli(['--since', '2026-02-30']);
    expect(impossible.status).toBe(2);
    expect(impossible.stderr).toContain('analyze:pairs: --since is not a real date or time: "2026-02-30"');
  });

  it('says where to get a database when there is none', () => {
    const result = cli([], path.join(tmpDir, 'nothing.db'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/No database at .*nothing\.db.*lighter:backfill/);
  });

  it('reads the database LIQUIDATIONS_DB_PATH names, prints the report and writes the JSON', async () => {
    const file = path.join(tmpDir, 'liquidations.db');
    // Recent candles and a long liquidation 30 minutes ago that bounces 2% within 15 minutes
    const now = Date.now();
    const start = Math.floor(now / 60_000) * 60_000 - 120 * 60_000;
    const index = (ms: number) => Math.round((ms - T0) / 60_000);
    const first = index(start);
    const eventAt = start + 60 * 60_000 + 30_000;
    await writeSyntheticDb(file, {
      liquidations: [{ symbol: 'AAAUSDT', side: 'SELL', eventTime: eventAt }],
      candles: { AAAUSDT: flatPath(first, 120, 100, { [index(eventAt - 30_000) + 15]: 102 }), BTCUSDT: flatPath(first, 120, 20_000) },
    });
    const json = path.join(tmpDir, 'out', 'pairs.json');
    const result = cli(['--horizons', '15', '--fee-bps', '0', '--json', json], file);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CAVEAT: in-sample only');
    expect(result.stdout).toContain('=== Horizon 15 min ===');
    expect(result.stdout).toMatch(/single\s+1\s+\+200\.0/);
    expect(result.stdout).toContain(`Full result written to ${json}`);
    const written = JSON.parse(fs.readFileSync(json, 'utf8'));
    expect(written.horizons[0].strategies[0]).toMatchObject({ strategy: 'single', metrics: { n: 1 } });
    expect(written.horizons[0].strategies[0].metrics.meanBps).toBeCloseTo(200, 6);
    expect(written.horizons[0].strategies[0].trades).toBeUndefined();
  });
});

describe('scripts/pair-analysis.ts scope options, end to end', () => {
  jest.setTimeout(HISTORY_TEST_TIMEOUT_MS * 4);
  const repo = path.join(__dirname, '..', '..', '..');
  const tsxCli = require.resolve('tsx/cli');
  let tmpDir: string;
  let file: string;

  // Four long liquidations of AAAUSDT, 30 minutes apart, in the last four hours (the CLI uses the real clock):
  //   A at +30 min and D at +120 min: tradable.  B at +60 min: held back by shadow mode, also tradable.
  //   C at +90 min: dropped by a gate (a skip_reason), so only --include-skipped reads it.
  const MIN = 60_000;
  const base = Math.floor(Date.now() / MIN) * MIN - 240 * MIN;
  const time = (minutes: number) => base + minutes * MIN + 10_000;
  const index = (ms: number) => Math.round((ms - T0) / MIN);

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-analysis-scope-'));
    file = path.join(tmpDir, 'liquidations.db');
    await writeSyntheticDb(file, {
      liquidations: [
        { symbol: 'AAAUSDT', side: 'SELL', eventTime: time(30) },
        { symbol: 'AAAUSDT', side: 'SELL', eventTime: time(60), skipReason: 'shadow mode' },
        { symbol: 'AAAUSDT', side: 'SELL', eventTime: time(90), skipReason: 'stale: 12000 ms old (limit 10000 ms)' },
        { symbol: 'AAAUSDT', side: 'SELL', eventTime: time(120) },
      ],
      candles: { AAAUSDT: flatPath(index(base), 240, 100), BTCUSDT: flatPath(index(base), 240, 20_000) },
    });
  });

  afterAll(() => {
    removeTmpDir(tmpDir);
  });

  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, [tsxCli, 'scripts/pair-analysis.ts', '--horizons', '15', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, LIQUIDATIONS_DB_PATH: file },
    });
    const events = /Events: (\d+) rows -> (\d+) events/.exec(result.stdout);
    return { ...result, rows: events ? Number(events[1]) : null, events: events ? Number(events[2]) : null };
  };
  const iso = (ms: number) => new Date(ms).toISOString();
  const isoNoMs = (ms: number) => iso(ms).replace(/\.\d+Z$/, 'Z');

  it('reads the tradable rows by default, and with --include-skipped the dropped detection too', () => {
    const tradable = run([]);
    expect(tradable.status).toBe(0);
    expect([tradable.rows, tradable.events]).toEqual([3, 3]);
    expect(tradable.stdout).toContain("tradable rows (skip_reason empty or 'shadow mode')");
    expect(tradable.stdout).not.toMatch(/Lighter optimizer/);                // The scope text is venue-neutral
    const all = run(['--include-skipped']);
    expect([all.rows, all.events]).toEqual([4, 4]);
    expect(all.stdout).toContain('all detections, including the ones the feed did not trade');
  });

  it('takes events from --since (inclusive)', () => {
    const since = run(['--since', iso(time(60))]);
    expect([since.rows, since.events]).toEqual([2, 2]);                      // B (exactly at --since) and D
    expect(since.stdout).toContain(`events from ${isoNoMs(time(60))}`);
    expect(run(['--since', iso(time(60) + 1)]).events).toBe(1);              // One millisecond later B is out
  });

  it('takes events before --until (exclusive)', () => {
    const until = run(['--until', iso(time(120))]);
    expect([until.rows, until.events]).toEqual([2, 2]);                      // A and B; D is exactly at --until
    expect(until.stdout).toContain(`before ${isoNoMs(time(120))}`);
    expect(run(['--until', iso(time(120) + 1)]).events).toBe(3);
  });

  it('combines --since, --until and --include-skipped', () => {
    expect(run(['--since', iso(time(60)), '--until', iso(time(120))]).events).toBe(1);                      // B
    const wide = run(['--since', iso(time(60)), '--until', iso(time(120)), '--include-skipped']);
    expect([wide.rows, wide.events]).toEqual([2, 2]);                                                       // B and C
    const none = run(['--since', iso(time(61)), '--until', iso(time(89))]);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('no liquidations in scope');
  });

  it('leaves out the trades that exit after --until with --until-exits', () => {
    // --until is 5 minutes after B: A exits (15 min) well before it, B's exit is 10 minutes past it
    const until = iso(time(60) + 5 * MIN);
    const plain = run(['--since', iso(time(0)), '--until', until]);
    expect(plain.stdout).toMatch(/single\s+2\s/);
    const exits = run(['--since', iso(time(0)), '--until', until, '--until-exits']);
    expect(exits.status).toBe(0);
    expect(exits.stdout).toMatch(/single\s+1\s/);
    expect(exits.stdout).toContain('excluded from single: exit past --until 1');
    expect(exits.stdout).toContain(`trades exiting after ${isoNoMs(time(60) + 5 * MIN)} left out`);
    expect(run(['--until-exits']).status).toBe(2);                           // Needs --until
  });
});

