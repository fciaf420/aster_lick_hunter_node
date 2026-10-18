import { Config, LighterVenueConfig } from './types';

export const DEFAULT_CONFIG_VERSION = '1.3.0';

// Lighter settings that apply until the user changes them (credentials have no default)
export const DEFAULT_LIGHTER_VENUE_SETTINGS = {
  profile: 'testnet',          // Testnet until the operator explicitly picks mainnet
  liquidationsLive: false,     // Shadow mode: Lighter liquidations are logged, never traded
  sltpSlippagePct: 1,          // SL/TP worst price 1% beyond the trigger (Lighter frontend default)
  sendTxPerMin: 60,            // Conservative until the standard-tier limit is known
} as const satisfies LighterVenueConfig;

export const DEFAULT_CONFIG: Config = {
  api: {
    apiKey: '',
    secretKey: '',
  },
  symbols: {
    BTCUSDT: {
      longVolumeThresholdUSDT: 10000,
      shortVolumeThresholdUSDT: 10000,
      tradeSize: 0.001,
      maxPositionMarginUSDT: 5000,
      leverage: 5,
      tpPercent: 5,
      slPercent: 2,
      priceOffsetBps: 5,
      maxSlippageBps: 50,
      orderType: 'LIMIT',
      vwapProtection: true,
      vwapTimeframe: '1m',
      vwapLookback: 200,
    },
    ETHUSDT: {
      longVolumeThresholdUSDT: 5000,
      shortVolumeThresholdUSDT: 5000,
      tradeSize: 0.01,
      maxPositionMarginUSDT: 3000,
      leverage: 10,
      tpPercent: 4,
      slPercent: 1.5,
      priceOffsetBps: 5,
      maxSlippageBps: 50,
      orderType: 'LIMIT',
      vwapProtection: true,
      vwapTimeframe: '1m',
      vwapLookback: 200,
    },
  },
  global: {
    riskPercent: 5,
    paperMode: true,
    positionMode: 'HEDGE',
    maxOpenPositions: 10,
    liquidationRetentionDays: 7,
    exchange: 'aster',
    liquidationSource: 'aster',
    server: {
      dashboardPassword: '',
      dashboardPort: 3000,
      websocketPort: 8080,
      useRemoteWebSocket: false,
      websocketHost: null,
    },
  },
  venues: {
    lighter: { ...DEFAULT_LIGHTER_VENUE_SETTINGS },
  },
  version: DEFAULT_CONFIG_VERSION,
};

export const DEFAULT_SYMBOL_CONFIG = {
  longVolumeThresholdUSDT: 5000,
  shortVolumeThresholdUSDT: 5000,
  tradeSize: 0.001,
  maxPositionMarginUSDT: 1000,
  leverage: 5,
  tpPercent: 3,
  slPercent: 1.5,
  priceOffsetBps: 5,
  maxSlippageBps: 50,
  orderType: 'LIMIT' as const,
  vwapProtection: true,
  vwapTimeframe: '1m',
  vwapLookback: 200,
};

// ===== What a setting left empty falls back to =====
// The config form shows these where a field may be left empty. The bot loads a config.user.json that leaves a
// setting out by filling it in from config.default.json (addMissingFields in migrator.ts): the global settings for
// everyone, the symbol settings only for the symbols that file lists. Any other symbol gets the bot's own value
// (hunter.ts, vwapStreamer.ts, thresholdMonitor.ts), or no limit. tests/lib/config/defaults.test.ts keeps the
// values that mirror config.default.json equal to it, and the bot's own values equal to the code that applies them.
// (DEFAULT_CONFIG.global.maxOpenPositions is not one of them: it is what a config the loader creates starts with,
// written out, and not a fallback.)

export const GLOBAL_SETTING_DEFAULTS = {
  maxOpenPositions: 5,
  liquidationRetentionDays: 7,
  dashboardPort: 3000,
  websocketPort: 8080,
} as const;

export interface SymbolSettingDefaults {
  maxPositionMarginUSDT?: number;
  vwapLookback?: number;
  thresholdTimeWindow?: number;   // ms
  thresholdCooldown?: number;     // ms
}

export type SymbolSettingDefaultField = keyof SymbolSettingDefaults;

// What the bot applies to any symbol that sets none of these: no margin limit, VWAP over 100 candles, a 60 s volume
// window and a 30 s cooldown between triggers
export const BUILT_IN_SYMBOL_SETTING_DEFAULTS: SymbolSettingDefaults = {
  vwapLookback: 100,
  thresholdTimeWindow: 60_000,
  thresholdCooldown: 30_000,
};

// What config.default.json fills in for the symbols it lists
export const SHIPPED_SYMBOL_SETTING_DEFAULTS: Record<string, SymbolSettingDefaults> = {
  ASTERUSDT: {
    maxPositionMarginUSDT: 200,
    vwapLookback: 200,
    thresholdTimeWindow: 60_000,
    thresholdCooldown: 30_000,
  },
};

// The value a symbol setting has while it is empty, or undefined when it has none (no limit)
export function symbolSettingDefault(symbol: string, field: SymbolSettingDefaultField): number | undefined {
  const shipped = Object.prototype.hasOwnProperty.call(SHIPPED_SYMBOL_SETTING_DEFAULTS, symbol)
    ? SHIPPED_SYMBOL_SETTING_DEFAULTS[symbol]
    : undefined;
  return shipped?.[field] ?? BUILT_IN_SYMBOL_SETTING_DEFAULTS[field];
}
