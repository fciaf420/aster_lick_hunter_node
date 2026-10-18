import type { LiquidationSourceId, VenueId } from './types';
import { ASTER_SIGNUP_URL } from './aster/constants';

// Client-safe description of each venue and liquidation source (no secrets, no Node-only imports)

export type CatalogStatus = 'available' | 'coming_soon';

export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
}

export interface VenueCatalogEntry {
  id: VenueId;
  name: string;
  chain: string;
  status: CatalogStatus;
  description: string;
  signupUrl: string;
  credentialFields: CredentialField[];
  supportsHedgeMode: boolean;
}

export interface LiquidationSourceCatalogEntry {
  id: LiquidationSourceId;
  name: string;
  status: CatalogStatus;
  description: string;
  requiresApiKey: boolean;
}

export const VENUE_CATALOG: VenueCatalogEntry[] = [
  {
    id: 'aster',
    name: 'Aster',
    chain: 'Aster L1 / BNB Chain',
    status: 'available',
    description: 'Binance-style perpetual futures. Uses V1 API keys (API key + secret).',
    signupUrl: ASTER_SIGNUP_URL,
    credentialFields: [
      { key: 'apiKey', label: 'API Key', secret: false },
      { key: 'secretKey', label: 'Secret Key', secret: true },
    ],
    supportsHedgeMode: true,
  },
  {
    id: 'hyperliquid',
    name: 'Hyperliquid',
    chain: 'Hyperliquid L1',
    status: 'coming_soon',
    description: 'On-chain order book perps. Trades through an API (agent) wallet.',
    signupUrl: 'https://app.hyperliquid.xyz',
    credentialFields: [
      { key: 'accountAddress', label: 'Account Address', secret: false },
      { key: 'agentPrivateKey', label: 'API Wallet Private Key', secret: true },
    ],
    supportsHedgeMode: false,
  },
  {
    id: 'lighter',
    name: 'Lighter',
    chain: 'Ethereum (zk rollup)',
    status: 'coming_soon',
    description: 'Zero-knowledge order book perps with low fees.',
    signupUrl: 'https://lighter.xyz',
    credentialFields: [
      { key: 'accountIndex', label: 'Account Index', secret: false },
      { key: 'apiKeyIndex', label: 'API Key Index', secret: false },
      { key: 'apiPrivateKey', label: 'API Private Key', secret: true },
    ],
    supportsHedgeMode: false,
  },
  {
    id: 'phoenix',
    name: 'Phoenix',
    chain: 'Solana',
    status: 'coming_soon',
    description: 'Solana order book perps by Ellipsis Labs (USDC collateral).',
    signupUrl: 'https://phoenix.trade',
    credentialFields: [
      { key: 'walletAddress', label: 'Wallet Address', secret: false },
      { key: 'privateKey', label: 'Wallet Private Key', secret: true },
    ],
    supportsHedgeMode: false,
  },
  {
    id: 'bulk',
    name: 'Bulk',
    chain: 'Solana',
    status: 'coming_soon',
    description: 'Solana perps with matching built into the validator. No public liquidation feed, so it needs another liquidation source.',
    signupUrl: 'https://bulk.trade',
    credentialFields: [
      { key: 'walletAddress', label: 'Wallet Address', secret: false },
      { key: 'privateKey', label: 'Signing Key (Ed25519)', secret: true },
    ],
    supportsHedgeMode: false,
  },
];

export const LIQUIDATION_SOURCE_CATALOG: LiquidationSourceCatalogEntry[] = [
  {
    id: 'aster',
    name: 'Aster liquidations',
    status: 'available',
    description: 'Aster public forceOrder stream (all symbols, real time).',
    requiresApiKey: false,
  },
  {
    id: 'hyperliquid',
    name: 'Hyperliquid liquidations',
    status: 'coming_soon',
    description: 'Hyperliquid has no public all-liquidations stream; needs a data provider such as 0xArchive.',
    requiresApiKey: true,
  },
  {
    id: 'binance',
    name: 'Binance liquidations',
    status: 'coming_soon',
    description: 'Binance public forceOrder stream (at most one liquidation per symbol per second).',
    requiresApiKey: false,
  },
];

export const DEFAULT_VENUE: VenueId = 'aster';
export const DEFAULT_LIQUIDATION_SOURCE: LiquidationSourceId = 'aster';

export function getVenueEntry(id: VenueId | undefined): VenueCatalogEntry {
  return VENUE_CATALOG.find(v => v.id === (id ?? DEFAULT_VENUE)) ?? VENUE_CATALOG[0];
}

export function getLiquidationSourceEntry(id: LiquidationSourceId | undefined): LiquidationSourceCatalogEntry {
  return LIQUIDATION_SOURCE_CATALOG.find(s => s.id === (id ?? DEFAULT_LIQUIDATION_SOURCE)) ?? LIQUIDATION_SOURCE_CATALOG[0];
}
