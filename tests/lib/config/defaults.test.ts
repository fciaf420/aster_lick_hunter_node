/**
 * @jest-environment node
 */
import { promises as fs, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigLoader } from '@/lib/config/configLoader';
import {
  BUILT_IN_SYMBOL_SETTING_DEFAULTS,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_VERSION,
  DEFAULT_LIGHTER_VENUE_SETTINGS,
  GLOBAL_SETTING_DEFAULTS,
  SHIPPED_SYMBOL_SETTING_DEFAULTS,
  symbolSettingDefault,
  type SymbolSettingDefaultField,
} from '@/lib/config/defaults';
import { LIGHTER_DEFAULT_SEND_TX_PER_MIN, LIGHTER_DEFAULT_SLTP_SLIPPAGE_PCT } from '@/lib/exchange/lighter/runtime';

// The config form shows what an empty field falls back to (GLOBAL_SETTING_DEFAULTS, symbolSettingDefault, ...). That
// is only true while these constants say what the bot really does: they are pinned here to config.default.json (which
// the config loader fills a missing setting from), to the loader itself, and to the code that applies the rest.

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const defaultFile = JSON.parse(read('config.default.json'));

const SYMBOL_FIELDS: SymbolSettingDefaultField[] = ['maxPositionMarginUSDT', 'vwapLookback', 'thresholdTimeWindow', 'thresholdCooldown'];

describe('what config.default.json fills in', () => {
  it('is what the global settings say', () => {
    expect(GLOBAL_SETTING_DEFAULTS).toEqual({
      maxOpenPositions: defaultFile.global.maxOpenPositions,
      liquidationRetentionDays: defaultFile.global.liquidationRetentionDays,
      dashboardPort: defaultFile.global.server.dashboardPort,
      websocketPort: defaultFile.global.server.websocketPort,
    });
    // The settings DEFAULT_CONFIG (the loader's fallback without the file) shares
    expect(DEFAULT_CONFIG.global.liquidationRetentionDays).toBe(GLOBAL_SETTING_DEFAULTS.liquidationRetentionDays);
    expect(DEFAULT_CONFIG.global.server?.dashboardPort).toBe(GLOBAL_SETTING_DEFAULTS.dashboardPort);
    expect(DEFAULT_CONFIG.global.server?.websocketPort).toBe(GLOBAL_SETTING_DEFAULTS.websocketPort);
  });

  it('is what the symbols it lists say, and lists no symbol that is not mirrored', () => {
    expect(Object.keys(SHIPPED_SYMBOL_SETTING_DEFAULTS).sort()).toEqual(Object.keys(defaultFile.symbols).sort());
    for (const [symbol, shipped] of Object.entries<Record<string, unknown>>(defaultFile.symbols)) {
      for (const field of SYMBOL_FIELDS) {
        expect([symbol, field, SHIPPED_SYMBOL_SETTING_DEFAULTS[symbol][field]]).toEqual([symbol, field, shipped[field]]);
      }
    }
  });

  it('is what the Lighter settings say', () => {
    expect(DEFAULT_LIGHTER_VENUE_SETTINGS).toEqual(defaultFile.venues.lighter);
  });
});

describe('what the bot applies to a setting that is left out', () => {
  let tmpDir: string;
  let loader: any;
  let originalState: Record<string, unknown>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'defaults-config-'));
    loader = ConfigLoader.getInstance() as any;
    originalState = {
      userConfigPath: loader.userConfigPath,
      legacyConfigPath: loader.legacyConfigPath,
      defaultConfigPath: loader.defaultConfigPath,
      config: loader.config,
    };
    // Temp files only: the real config.user.json is never read or written
    loader.userConfigPath = path.join(tmpDir, 'config.user.json');
    loader.legacyConfigPath = path.join(tmpDir, 'config.json');
    loader.defaultConfigPath = path.join(tmpDir, 'config.default.json');
    await fs.writeFile(loader.defaultConfigPath, read('config.default.json'));
  });

  afterEach(async () => {
    Object.assign(loader, originalState);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('is filled in by the config loader, from config.default.json, as the form says', async () => {
    const symbol = { longVolumeThresholdUSDT: 1, shortVolumeThresholdUSDT: 1, tradeSize: 0.001, leverage: 5, tpPercent: 5, slPercent: 2 };
    await fs.writeFile(loader.userConfigPath, JSON.stringify({
      api: { apiKey: '', secretKey: '' },
      symbols: { ASTERUSDT: { ...symbol }, BTCUSDT: { ...symbol } },
      global: { riskPercent: 5, paperMode: true, exchange: 'aster', liquidationSource: 'aster', server: {} },
      version: DEFAULT_CONFIG_VERSION,
    }));
    const loaded = await loader.loadConfig();

    expect(loaded.global.maxOpenPositions).toBe(GLOBAL_SETTING_DEFAULTS.maxOpenPositions);
    expect(loaded.global.liquidationRetentionDays).toBe(GLOBAL_SETTING_DEFAULTS.liquidationRetentionDays);
    expect(loaded.global.server.dashboardPort).toBe(GLOBAL_SETTING_DEFAULTS.dashboardPort);
    expect(loaded.global.server.websocketPort).toBe(GLOBAL_SETTING_DEFAULTS.websocketPort);

    // The symbol the file lists gets its values, any other symbol nothing: the bot's own value applies to it
    for (const field of SYMBOL_FIELDS) {
      expect([field, loaded.symbols.ASTERUSDT[field]]).toEqual([field, symbolSettingDefault('ASTERUSDT', field)]);
      expect([field, loaded.symbols.BTCUSDT[field]]).toEqual([field, undefined]);
    }
  });

  it('differs by symbol where the file lists one and the bot has its own value', () => {
    expect(symbolSettingDefault('ASTERUSDT', 'vwapLookback')).toBe(200);
    expect(symbolSettingDefault('BTCUSDT', 'vwapLookback')).toBe(100);
    expect(symbolSettingDefault('ASTERUSDT', 'maxPositionMarginUSDT')).toBe(200);
    // No limit is a value too: none
    expect(symbolSettingDefault('BTCUSDT', 'maxPositionMarginUSDT')).toBeUndefined();
    // Names that are on Object.prototype are not symbols the file lists
    expect(symbolSettingDefault('constructor', 'vwapLookback')).toBe(100);
    expect(symbolSettingDefault('__proto__', 'maxPositionMarginUSDT')).toBeUndefined();
  });
});

describe('the values the bot applies to a symbol that sets none', () => {
  const sources = ['src/lib/bot/hunter.ts', 'src/lib/services/vwapStreamer.ts', 'src/app/api/vwap/[symbol]/route.ts', 'src/lib/services/thresholdMonitor.ts'];
  const numbersAfter = (field: string) =>
    sources.flatMap((file) => Array.from(read(file).matchAll(new RegExp(`${field}\\s*\\|\\|\\s*(\\d+)`, 'g'))).map((match) => [file, Number(match[1])] as const));

  // The fallback is written out where it is applied. A change there that is not made in defaults.ts (or the other
  // way round) would make the form promise a value the bot does not use; once the code reads the constants instead,
  // there is nothing left to compare.
  it.each([
    ['vwapLookback', BUILT_IN_SYMBOL_SETTING_DEFAULTS.vwapLookback],
    ['thresholdTimeWindow', BUILT_IN_SYMBOL_SETTING_DEFAULTS.thresholdTimeWindow],
    ['thresholdCooldown', BUILT_IN_SYMBOL_SETTING_DEFAULTS.thresholdCooldown],
  ])('uses the same %s as the form shows', (field, expected) => {
    for (const [file, value] of numbersAfter(field)) expect([file, value]).toEqual([file, expected]);
  });

  it('is applied by the threshold monitor when a symbol has no window or cooldown', async () => {
    // The module starts a timer of its own when it loads: under fake timers it never runs
    jest.useFakeTimers();
    try {
      const { ThresholdMonitor } = await import('@/lib/services/thresholdMonitor');
      const monitor = new ThresholdMonitor();
      try {
        expect(monitor.getCooldownPeriod()).toBe(BUILT_IN_SYMBOL_SETTING_DEFAULTS.thresholdCooldown);
        monitor.updateConfig({
          api: { apiKey: '', secretKey: '' },
          global: { paperMode: true, riskPercent: 1, useThresholdSystem: true },
          symbols: { BTCUSDT: { longVolumeThresholdUSDT: 1, shortVolumeThresholdUSDT: 1, tradeSize: 1, leverage: 1, tpPercent: 1, slPercent: 1, useThreshold: true } },
        });
        expect(monitor.getThresholdStatus('BTCUSDT')?.timeWindow).toBe(BUILT_IN_SYMBOL_SETTING_DEFAULTS.thresholdTimeWindow);
      } finally {
        monitor.destroy();
      }
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the values the bot applies to the settings of the global and Lighter groups', () => {
  it('uses the retention, ports and Lighter limits the form shows', () => {
    expect(read('src/lib/services/liquidationStorage.ts')).toContain(`DEFAULT_LIQUIDATION_RETENTION_DAYS = ${GLOBAL_SETTING_DEFAULTS.liquidationRetentionDays};`);
    for (const file of ['src/bot/index.ts', 'src/providers/WebSocketProvider.tsx', 'src/hooks/useWebSocketUrl.ts', 'scripts/get-config-ports.js']) {
      for (const match of read(file).matchAll(/(websocketPort|dashboardPort)\s*\|\|\s*(\d+)/g)) {
        expect([file, match[1], Number(match[2])]).toEqual([file, match[1], GLOBAL_SETTING_DEFAULTS[match[1] as 'websocketPort' | 'dashboardPort']]);
      }
    }
    expect(LIGHTER_DEFAULT_SLTP_SLIPPAGE_PCT).toBe(DEFAULT_LIGHTER_VENUE_SETTINGS.sltpSlippagePct);
    expect(LIGHTER_DEFAULT_SEND_TX_PER_MIN).toBe(DEFAULT_LIGHTER_VENUE_SETTINGS.sendTxPerMin);
  });
});
