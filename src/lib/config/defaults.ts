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