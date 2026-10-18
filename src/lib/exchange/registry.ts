import type { Config } from '../types';
import type { ExchangeAdapter, LiquidationSourceId, VenueId } from './types';
import { AsterAdapter } from './aster/AsterAdapter';
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
export function createExchangeAdapter(config: Pick<Config, 'global' | 'api'>): ExchangeAdapter {
  const venue = getConfiguredVenue(config);
  const entry = getVenueEntry(venue);

  if (entry.status !== 'available') {
    throw new Error(`Trading venue "${entry.name}" is not supported yet. Choose an available venue in the configuration.`);
  }

  switch (venue) {
    case 'aster':
      return new AsterAdapter(config.api);
    default:
      throw new Error(`No adapter registered for trading venue "${venue}"`);
  }
}
