import type { Config, LighterVenueConfig, SymbolConfig } from '@/lib/types';
import type { VenueId } from '@/lib/exchange/types';
import { getVenueEntry } from '@/lib/exchange/catalog';
import { lighterShortAccountProblems } from '@/lib/config/types';

// Plain helpers of the config form (no React): the config it starts from, the symbol it adds, and finding the
// first invalid field when a save is refused.

export type ConfigTab = 'api' | 'global' | 'symbols';

// The parts of a config that decide whether hedge position mode can be chosen
interface HedgeCheckConfig {
  global?: { exchange?: VenueId };
  venues?: { lighter?: LighterVenueConfig };
}

// Lighter has no native hedge mode; it is emulated with a second sub-account for the shorts once that is set up
export function lighterHedgeConfigured(config: HedgeCheckConfig): boolean {
  const lighter = config.venues?.lighter;
  return getVenueEntry(config.global?.exchange).id === 'lighter' &&
    lighter?.hedge?.enabled === true &&
    lighterShortAccountProblems(lighter).length === 0;
}

// Whether position mode HEDGE can be chosen for the selected trading venue
export function hedgePositionModeAvailable(config: HedgeCheckConfig): boolean {
  return getVenueEntry(config.global?.exchange).supportsHedgeMode || lighterHedgeConfigured(config);
}

// The config the form starts from: the one it was given, with the parts a config always has filled in.
// Nothing is changed on the given config.
export function buildInitialConfig(current?: Config): Config {
  if (current) {
    return {
      ...current,
      api: current.api ?? { apiKey: '', secretKey: '' },
      global: current.global ?? {
        riskPercent: 2,
        paperMode: true,
        positionMode: 'HEDGE',
        maxOpenPositions: 10,
        useThresholdSystem: false,
        exchange: 'aster',
        liquidationSource: 'aster',
        server: {
          dashboardPassword: '',
          dashboardPort: 3000,
          websocketPort: 8080,
          useRemoteWebSocket: false,
          websocketHost: null,
        },
        rateLimit: {
          maxRequestWeight: 2400,
          maxOrderCount: 1200,
          reservePercent: 30,
          enableBatching: true,
          queueTimeout: 30000,
          enableDeduplication: true,
          deduplicationWindowMs: 1000,
          parallelProcessing: true,
          maxConcurrentRequests: 3,
        },
      },
      symbols: current.symbols ?? {},
    };
  }

  // Default config if none provided
  return {
    api: {
      apiKey: '',
      secretKey: '',
    },
    global: {
      riskPercent: 2,
      paperMode: true,
      positionMode: 'HEDGE',
      maxOpenPositions: 10,
      useThresholdSystem: false,
      exchange: 'aster',
      liquidationSource: 'aster',
      server: {
        dashboardPassword: 'admin',
        dashboardPort: 3000,
        websocketPort: 8080,
        useRemoteWebSocket: false,
        websocketHost: null,
      },
      rateLimit: {
        maxRequestWeight: 2400,
        maxOrderCount: 1200,
        reservePercent: 30,
        enableBatching: true,
        queueTimeout: 30000,
        parallelProcessing: true,
        maxConcurrentRequests: 3,
      },
    },
    symbols: {},
    version: '1.2.0',
  };
}

// Settings of a symbol that was just added
export function getDefaultSymbolConfig(): SymbolConfig {
  return {
    longVolumeThresholdUSDT: 10000,  // For long positions (buy on sell liquidations)
    shortVolumeThresholdUSDT: 10000, // For short positions (sell on buy liquidations)
    leverage: 10,
    tradeSize: 100,
    maxPositionMarginUSDT: 10000,
    slPercent: 2,
    tpPercent: 3,
    priceOffsetBps: 5,      // 5 basis points offset for limit orders
    maxSlippageBps: 50,     // 50 basis points max slippage
    orderType: 'LIMIT' as const,
    vwapProtection: false,  // VWAP protection disabled by default
    vwapTimeframe: '1m',    // Default to 1 minute timeframe
    vwapLookback: 100,      // Default to 100 candles
  };
}

// react-hook-form addresses a field by a path ("symbols.BTCUSDT.leverage"), so a symbol name cannot hold the
// characters a path is split on. Exchange symbols are letters, digits, dashes and the like.
export const SYMBOL_NAME_PATTERN = /^[^.[\]"']+$/;

// ===== Finding the first invalid field =====

interface ErrorLeaf {
  path: string;
  message: string;
}

// The invalid fields in the order the resolver reported them. A leaf of the errors object has a type and a message
// (and a ref to the element, which is not looked into).
export function collectErrors(errors: unknown, prefix = ''): ErrorLeaf[] {
  if (typeof errors !== 'object' || errors === null) return [];
  const node = errors as Record<string, unknown>;
  if (typeof node.type === 'string' && typeof node.message === 'string') return [{ path: prefix, message: node.message }];
  return Object.entries(node)
    .filter(([key]) => key !== 'ref')
    .flatMap(([key, child]) => collectErrors(child, prefix ? `${prefix}.${key}` : key));
}

// The tab a field lives on: exchange, credentials and Lighter settings; global and server settings; symbols
export function tabForPath(path: string): ConfigTab {
  if (path === 'global.exchange' || path === 'global.liquidationSource') return 'api';
  if (path.startsWith('global.')) return 'global';
  if (path.startsWith('symbols.')) return 'symbols';
  return 'api';
}

const TAB_ORDER: ConfigTab[] = ['api', 'global', 'symbols'];

// The invalid field that comes first on screen: the first tab with one, then the order of the resolver
export function firstInvalid(errors: unknown): (ErrorLeaf & { tab: ConfigTab; symbol?: string }) | undefined {
  const leaves = collectErrors(errors).map((leaf, index) => ({ ...leaf, index, tab: tabForPath(leaf.path) }));
  leaves.sort((a, b) => TAB_ORDER.indexOf(a.tab) - TAB_ORDER.indexOf(b.tab) || a.index - b.index);
  const first = leaves[0];
  if (!first) return undefined;
  return { path: first.path, message: first.message, tab: first.tab, symbol: /^symbols\.([^.]+)\./.exec(first.path)?.[1] };
}

// "symbols.BTCUSDT.tpPercent" -> "BTCUSDT tp percent"; names the field in the toast without its value
export function describePath(path: string): string {
  const words = (part: string) => (part === part.toUpperCase() ? part : part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase());
  return path
    .replace(/^(symbols|global|api|venues)\./, '')
    .replace(/^server\./, '')
    .split('.')
    .map(words)
    .join(' ');
}
