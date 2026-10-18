import type { ApiCredentials, Config } from '../types';
import type { ExchangeAdapter, LiquidationSourceId, VenueId } from './types';
import type { LiquidationSource, LiquidationSourceDeps } from '../liquidation/types';
import { AsterAdapter } from './aster/AsterAdapter';
import { ASTER_FORCE_ORDER_STREAM_URL, AsterForceOrderSource } from '../liquidation/asterForceOrderSource';
import {
  DEFAULT_LIQUIDATION_SOURCE,
  DEFAULT_VENUE,
  getLiquidationSourceEntry,
  getVenueEntry,
  isSelectableStatus,
} from './catalog';
import {
  LighterLiquidationFeed,
  MarkGuardedLiquidationSource,
  createLighterAdapter,
  createLighterVenueAdapter,
  createLighterVenueGuard,
  lighterStreamUrlFor,
  type LighterLiquidationFeedOptions,
  type VenueMarkPrices,
} from './lighter/runtime';
import type { LighterSocketFactory } from './lighter/ws';

// Config fields the registry reads. Lighter also needs the symbols (market mapping) and venues (network,
// credentials); without them the adapter sees no symbols and no credentials.
type RegistryConfig = Pick<Config, 'global'> & Partial<Pick<Config, 'api' | 'venues' | 'symbols'>>;

export function getConfiguredVenue(config: Pick<Config, 'global'>): VenueId {
  return config.global.exchange ?? DEFAULT_VENUE;
}

export function getConfiguredLiquidationSource(config: Pick<Config, 'global'>): LiquidationSourceId {
  return config.global.liquidationSource ?? DEFAULT_LIQUIDATION_SOURCE;
}

// Only implemented (available or beta) liquidation sources can run; refuse anything else
export function resolveLiquidationSource(config: Pick<Config, 'global'>): LiquidationSourceId {
  const source = getConfiguredLiquidationSource(config);
  const entry = getLiquidationSourceEntry(source);
  if (!isSelectableStatus(entry.status)) {
    throw new Error(`Liquidation source "${entry.name}" is not supported yet. Choose an available source in the configuration.`);
  }
  return source;
}

export interface ExchangeAdapterOptions {
  // Read the latest config on every use (the bot passes its live config so reloads apply). Lighter reads its
  // credentials, network and symbols through it. Defaults to the config passed in.
  getConfig?: () => Config;
  // Allow loading the Lighter native signer. Only the bot process sets this; adapters built in Next.js API
  // routes are read-only (positions, balances, market data) and refuse to sign.
  allowSigning?: boolean;
}

// Build the adapter for the configured trading venue. Venues listed as coming soon are refused
// so the bot never starts against an exchange it cannot actually trade on.
// Pass getCredentials to read Aster credentials at request time (picks up config reloads).
export function createExchangeAdapter(
  config: RegistryConfig,
  getCredentials?: () => ApiCredentials,
  options: ExchangeAdapterOptions = {}
): ExchangeAdapter {
  const venue = getConfiguredVenue(config);
  const entry = getVenueEntry(venue);

  if (!isSelectableStatus(entry.status)) {
    throw new Error(`Trading venue "${entry.name}" is not supported yet. Choose an available venue in the configuration.`);
  }

  switch (venue) {
    case 'aster':
      return new AsterAdapter(getCredentials ?? config.api ?? { apiKey: '', secretKey: '' });
    case 'lighter':
      // One-way: the plain adapter. Hedge mode (two sub-accounts) when the config turns it on.
      return createLighterVenueAdapter(
        { symbols: config.symbols ?? {}, venues: config.venues, global: config.global },
        { getConfig: options.getConfig, allowSigning: options.allowSigning }
      );
    default:
      throw new Error(`No adapter registered for trading venue "${venue}"`);
  }
}

// Adapter without credentials for public market data (prices, klines, symbols). Uses the
// configured venue when a config is at hand, else the default venue.
export function createPublicExchangeAdapter(config?: RegistryConfig | null): ExchangeAdapter {
  if (config && getConfiguredVenue(config) === 'lighter') {
    const entry = getVenueEntry('lighter');
    if (!isSelectableStatus(entry.status)) {
      throw new Error(`Trading venue "${entry.name}" is not supported yet. Choose an available venue in the configuration.`);
    }
    // Lists every Lighter market (symbol picker); never signs
    return createLighterAdapter({ symbols: config.symbols ?? {}, venues: config.venues, global: config.global }, { catalog: true });
  }
  return createExchangeAdapter({
    global: { ...config?.global, exchange: config ? getConfiguredVenue(config) : DEFAULT_VENUE } as Config['global'],
    api: { apiKey: '', secretKey: '' },
  });
}

// WebSocket URL of a liquidation feed. Aster is a Binance-style forceOrder stream; Lighter's is the network's
// public stream (per-market trade channels, see LighterLiquidationSource).
export function getLiquidationStreamUrl(source: LiquidationSourceId, config?: Partial<Pick<Config, 'venues'>> | null): string {
  switch (source) {
    case 'aster':
      return ASTER_FORCE_ORDER_STREAM_URL;
    case 'lighter':
      return lighterStreamUrlFor(config);
    default:
      throw new Error(`Liquidation source "${getLiquidationSourceEntry(source).name}" is not supported yet`);
  }
}

// Mark prices of a venue's public market data, keyed by bot symbol (mark-ratio guard)
function venueMarkPrices(venue: VenueId, config: RegistryConfig): VenueMarkPrices {
  return async () => {
    const adapter = createPublicExchangeAdapter({ ...config, global: { ...config.global, exchange: venue } });
    const marks = await adapter.getMarkPrice();
    const result = new Map<string, number>();
    for (const mark of Array.isArray(marks) ? marks : [marks]) {
      const price = Number(mark?.markPrice);
      if (mark?.symbol && Number.isFinite(price) && price > 0) result.set(mark.symbol, price);
    }
    return result;
  };
}

// Options for tests and the bot on top of LiquidationSourceDeps
export interface LiquidationSourceWiring {
  // Mark prices of the non-Lighter venue (default: its public REST market data)
  venueMarkPrices?: VenueMarkPrices;
  createSocket?: LighterSocketFactory;   // Lighter feed WebSocket (tests)
  guardWarmupMs?: number;
  guardIntervalMs?: number;
  lighterSourceOptions?: LighterLiquidationFeedOptions['sourceOptions'];
}

// Build the liquidation feed for the configured source. Sources that aren't implemented yet are refused.
// When the source and the trading venue differ and one of them is Lighter, the feed runs behind the 2%
// mark-ratio guard (lighter spec §3.4).
export function createLiquidationSource(
  config: RegistryConfig,
  deps: LiquidationSourceDeps & LiquidationSourceWiring = {}
): LiquidationSource {
  const source = getConfiguredLiquidationSource(config);
  const venue = getConfiguredVenue(config);
  const getConfig = deps.getConfig;
  switch (source) {
    case 'aster': {
      const aster = new AsterForceOrderSource();
      if (venue !== 'lighter') return aster;
      const guard = createLighterVenueGuard(config as Config, {
        getConfig,
        otherVenue: getVenueEntry('aster').name,
        getOtherMarks: deps.venueMarkPrices ?? venueMarkPrices('aster', config),
        warmupMs: deps.guardWarmupMs,
        intervalMs: deps.guardIntervalMs,
      });
      return new MarkGuardedLiquidationSource(aster, guard, () => (getConfig ? getConfig() : (config as Config)));
    }
    case 'lighter': {
      const entry = getLiquidationSourceEntry('lighter');
      if (!isSelectableStatus(entry.status)) {
        throw new Error(`Liquidation source "${entry.name}" is not supported yet`);
      }
      return new LighterLiquidationFeed(
        { symbols: config.symbols ?? {}, venues: config.venues, global: config.global },
        {
          getConfig,
          venue,
          venueLabel: getVenueEntry(venue).name,
          getVenueMarks: venue === 'lighter' ? undefined : (deps.venueMarkPrices ?? venueMarkPrices(venue, config)),
          createSocket: deps.createSocket,
          guardWarmupMs: deps.guardWarmupMs,
          guardIntervalMs: deps.guardIntervalMs,
          sourceOptions: deps.lighterSourceOptions,
        }
      );
    }
    default:
      throw new Error(`Liquidation source "${getLiquidationSourceEntry(source).name}" is not supported yet`);
  }
}
