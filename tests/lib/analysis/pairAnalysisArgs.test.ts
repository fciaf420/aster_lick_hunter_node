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
      minUsd: 0,
      dedupeSec: 60,
      horizons: [5, 15, 60],
      hedgeSymbol: 'BTCUSDT',
      extraHedges: [],
      hedgeSizing: 'beta',
      betaLookbackMin: 240,
      betaMinObservations: 30,
      pairWindowSec: 120,
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
    ]);
    expect(args).toEqual({
      venue: 'aster',
      candleVenue: 'lighter',
      includeSkipped: true,
      symbols: ['SOLUSDT', 'DOGEUSDT'],
      since: Date.UTC(2026, 9, 12),
      until: Date.UTC(2026, 9, 14, 4, 30),
      minUsd: 2500.5,
      dedupeSec: 30,
      horizons: [5, 15, 60],
      hedgeSymbol: 'ETHUSDT',
      extraHedges: ['BTCUSDT', 'SOLUSDT'],
      hedgeSizing: 'dollar',
      betaLookbackMin: 120,
      betaMinObservations: 20,
      pairWindowSec: 90,
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
    expect(() => parsePairAnalysisArgs(['--since', '2026-13-45'])).toThrow(/--since must be a UTC date or time/);
    expect(() => parsePairAnalysisArgs(['--since', '2026-10-12', '--until', '2026-10-12'])).toThrow(/--since must be before --until/);
    expect(() => parsePairAnalysisArgs(['--since', '2026-10-13', '--until', '2026-10-12'])).toThrow(/--since must be before --until/);
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
      '--venue', '--include-skipped', '--symbols', '--since', '--until', '--min-usd', '--dedupe-sec', '--candle-venue', '--horizons', '--hedge-symbol',
      '--extra-hedges', '--hedge-sizing', '--beta-lookback', '--beta-min-obs', '--pair-window-sec', '--fee-bps', '--slippage-bps',
      '--json', '--json-trades', '--help',
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
