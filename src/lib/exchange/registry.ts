import type { ApiCredentials, Config } from '../types';
import type { ExchangeAdapter, LiquidationSourceId, VenueId } from './types';
import { AsterAdapter } from './aster/AsterAdapter';
import { ASTER_STREAM_BASE_URL } from './aster/constants';
import { DEFAULT_LIQUIDATION_SOURCE, DEFAULT_VENUE, getLiquidationSourceEntry, getVenueEntry } from './catalog';

export function getConfiguredVenue(config: Pick<Config, 'global'>): VenueId {
  return config.global.exchange ?? DEFAULT_VENUE;
}

export function getConfiguredLiquidationSource(config: Pick<Config, 'global'>): LiquidationSourceId {
  return config.global.liquidationSource ?? DEFAULT_LIQUIDATION_SOURCE;
}

// Only the Aster liquidation stream is implemented; refuse anything else
export function resolveLiquidationSource(config: Pick<Config, 'global'>): LiquidationSourceId {
  const source = getConfiguredLiquidationSource(config);
  const entry = getLiquidationSourceEntry(source);
  if (entry.status !== 'available') {
    throw new Error(`Liquidation source "${entry.name}" is not supported yet. Choose an available source in the configuration.`);
  }
  return source;
}

// Build the adapter for the configured trading venue. Venues listed as coming soon are refused
// so the bot never starts against an exchange it cannot actually trade on.
// Pass getCredentials to read credentials at request time (picks up config reloads).
export function createExchangeAdapter(
  config: Pick<Config, 'global' | 'api'>,
  getCredentials?: () => ApiCredentials
): ExchangeAdapter {
  const venue = getConfiguredVenue(config);
  const entry = getVenueEntry(venue);

  if (entry.status !== 'available') {
    throw new Error(`Trading venue "${entry.name}" is not supported yet. Choose an available venue in the configuration.`);
  }

  switch (venue) {
    case 'aster':
      return new AsterAdapter(getCredentials ?? config.api);
    default:
      throw new Error(`No adapter registered for trading venue "${venue}"`);
  }
}

// Adapter without credentials for public market data (prices, klines, symbols). Uses the
// configured venue when a config is at hand, else the default venue.
export function createPublicExchangeAdapter(config?: Pick<Config, 'global'> | null): ExchangeAdapter {
  return createExchangeAdapter({
    global: { ...config?.global, exchange: config ? getConfiguredVenue(config) : DEFAULT_VENUE } as Config['global'],
    api: { apiKey: '', secretKey: '' },
  });
}

// WebSocket URL of the liquidation feed for a source (all sources use Binance-style forceOrder events)
export function getLiquidationStreamUrl(source: LiquidationSourceId): string {
  switch (source) {
    case 'aster':
      return `${ASTER_STREAM_BASE_URL}/ws/!forceOrder@arr`;
    default:
      throw new Error(`Liquidation source "${getLiquidationSourceEntry(source).name}" is not supported yet`);
  }
}
