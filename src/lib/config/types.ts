import { z } from 'zod';
import { LIQUIDATION_SOURCE_IDS, VENUE_IDS, type VenueId } from '../exchange/types';
import { LIGHTER_PROFILE_NAMES } from '../exchange/lighter/profiles';

export const symbolConfigSchema = z.object({
  // Volume thresholds
  volumeThresholdUSDT: z.number().min(0).optional(),
  longVolumeThresholdUSDT: z.number().min(0).optional(),
  shortVolumeThresholdUSDT: z.number().min(0).optional(),

  // Position sizing
  tradeSize: z.number().min(0.00001),
  longTradeSize: z.number().min(0.00001).optional(),
  shortTradeSize: z.number().min(0.00001).optional(),
  maxPositionMarginUSDT: z.number().min(0).optional(),

  // Risk parameters
  leverage: z.number().min(1).max(125),
  tpPercent: z.number().min(0.1),
  slPercent: z.number().min(0.1),

  // Limit order settings (optional)
  priceOffsetBps: z.number().optional(),
  usePostOnly: z.boolean().optional(),
  maxSlippageBps: z.number().optional(),
  orderType: z.enum(['LIMIT', 'MARKET']).optional(),
  forceMarketEntry: z.boolean().optional(),

  // VWAP protection settings (optional)
  vwapProtection: z.boolean().optional(),
  vwapTimeframe: z.string().optional(),
  vwapLookback: z.number().min(10).max(500).optional(),

  // Threshold system settings
  useThreshold: z.boolean().optional(),
  thresholdTimeWindow: z.number().min(0).optional(),
  thresholdCooldown: z.number().min(0).optional(),
  hunterCooldownMs: z.number().min(0).optional(),
}).refine(data => {
  // Ensure we have either legacy or new volume thresholds
  return data.volumeThresholdUSDT !== undefined ||
         (data.longVolumeThresholdUSDT !== undefined && data.shortVolumeThresholdUSDT !== undefined);
}, {
  message: "Either volumeThresholdUSDT or both longVolumeThresholdUSDT and shortVolumeThresholdUSDT must be provided"
});

export const apiCredentialsSchema = z.object({
  apiKey: z.string(),
  secretKey: z.string(),
});

export const serverConfigSchema = z.object({
  dashboardPassword: z.string().optional(),
  dashboardPort: z.number().optional(),
  websocketPort: z.number().optional(),
  useRemoteWebSocket: z.boolean().optional(),
  websocketHost: z.string().nullable().optional(),
  envWebSocketHost: z.string().optional(), // For environment variable override
}).optional();

export const rateLimitConfigSchema = z.object({
  maxRequestWeight: z.number().optional(),
  maxOrderCount: z.number().optional(),
  reservePercent: z.number().optional(),
  enableBatching: z.boolean().optional(),
  queueTimeout: z.number().optional(),
  enableDeduplication: z.boolean().optional(),
  deduplicationWindowMs: z.number().optional(),
  parallelProcessing: z.boolean().optional(),
  maxConcurrentRequests: z.number().min(1).max(10).optional(),
}).optional();

export const globalConfigSchema = z.object({
  riskPercent: z.number().min(0).max(100),
  paperMode: z.boolean(),
  positionMode: z.enum(['ONE_WAY', 'HEDGE']).optional(),
  maxOpenPositions: z.number().min(1).optional(),
  useThresholdSystem: z.boolean().optional(),
  hunterCooldownMs: z.number().min(0).optional(),
  liquidationRetentionDays: z.number().min(0).optional(),
  exchange: z.enum(VENUE_IDS).optional(),
  liquidationSource: z.enum(LIQUIDATION_SOURCE_IDS).optional(),
  server: serverConfigSchema,
  rateLimit: rateLimitConfigSchema,
});

// ===== Lighter (config.venues.lighter) =====
// Credentials are bound to the network (profile) they were created on: keys, account indexes and nonces are
// per network (lighter spec §1.1 rule 2). Every field is optional so a partial setup can be saved; the bot
// refuses live trading until the credentials are complete and the startup checks pass.

export const LIGHTER_MAX_ACCOUNT_INDEX = 2 ** 48 - 2;
export const LIGHTER_MAX_API_KEY_INDEX = 254;
export const LIGHTER_MAX_SLTP_SLIPPAGE_PCT = 10;   // Lighter frontend maximum for the SL/TP worst-price slippage
export const LIGHTER_MAX_SEND_TX_PER_MIN = 4000;   // Premium tier; the standard tier limit is unknown (spec §9 Q16)

// Empty inputs mean "not set"; digit strings (text inputs, hand-edited files) become numbers
function optionalInteger(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return undefined;
    return /^\d+$/.test(text) ? Number(text) : value;
  }
  return value;
}

function optionalText(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const text = value.trim();
    return text === '' ? undefined : text;
  }
  return value;
}

// 40 bytes of hex (80 characters), optional 0x prefix: the format lighter-go GenerateAPIKey produces
const lighterHexKeySchema = z.preprocess(
  optionalText,
  z.string().regex(/^(0x)?[0-9a-fA-F]{80}$/, 'must be 40 bytes of hex (80 characters, optional 0x prefix)').optional()
);

const lighterSymbolOverrideSchema = z.union([
  z.string().min(1),
  z.object({ market: z.string().min(1), multiplier: z.number().positive().optional() }),
]);

export const lighterVenueConfigSchema = z.preprocess(
  // Older field names (the first catalog listing used apiPrivateKey / apiPublicKey)
  (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const raw = { ...(value as Record<string, unknown>) };
    if (raw.apiKeyPrivateKey === undefined && raw.apiPrivateKey !== undefined) raw.apiKeyPrivateKey = raw.apiPrivateKey;
    if (raw.apiKeyPublicKey === undefined && raw.apiPublicKey !== undefined) raw.apiKeyPublicKey = raw.apiPublicKey;
    delete raw.apiPrivateKey;
    delete raw.apiPublicKey;
    return raw;
  },
  z.object({
    // Network. Robinhood profiles are accepted here but refused when saving or starting (gated, spec §1.1).
    profile: z.enum(LIGHTER_PROFILE_NAMES).optional(),
    accountIndex: z.preprocess(optionalInteger, z.number().int().min(1).max(LIGHTER_MAX_ACCOUNT_INDEX).optional()),
    apiKeyIndex: z.preprocess(optionalInteger, z.number().int().min(0).max(LIGHTER_MAX_API_KEY_INDEX).optional()),
    apiKeyPrivateKey: lighterHexKeySchema,
    apiKeyPublicKey: lighterHexKeySchema,
    // false = shadow mode: Lighter liquidations are logged, never traded (spec §8 risk 1)
    liquidationsLive: z.boolean().optional(),
    // Worst-price slippage of stop-loss / take-profit orders after they trigger, in percent
    sltpSlippagePct: z.number().min(0.01).max(LIGHTER_MAX_SLTP_SLIPPAGE_PCT).optional(),
    // Client-side sendTx limit per minute
    sendTxPerMin: z.number().int().min(1).max(LIGHTER_MAX_SEND_TX_PER_MIN).optional(),
    // Bot symbol -> Lighter backend symbol (e.g. "QNTUSDT": "QNT", or { "market": "1000NOT", "multiplier": 1000 })
    symbolOverrides: z.record(lighterSymbolOverrideSchema).optional(),
  })
);

// Credentials for trading venues other than Aster, keyed by venue id. Lighter has its own typed settings;
// the venues that are not implemented yet keep a plain string map.
const genericVenueCredentialsSchema = z.record(z.string()).optional();
const venueCredentialsShape = {
  aster: genericVenueCredentialsSchema,
  hyperliquid: genericVenueCredentialsSchema,
  lighter: lighterVenueConfigSchema.optional(),
  phoenix: genericVenueCredentialsSchema,
  bulk: genericVenueCredentialsSchema,
} satisfies Record<VenueId, z.ZodTypeAny>;
export const venueCredentialsSchema = z.object(venueCredentialsShape).strict().optional();

export const configSchema = z.object({
  api: apiCredentialsSchema,
  venues: venueCredentialsSchema,
  symbols: z.record(symbolConfigSchema),
  global: globalConfigSchema,
  version: z.string().optional(),
});

export type SymbolConfig = z.infer<typeof symbolConfigSchema>;
export type ApiCredentials = z.infer<typeof apiCredentialsSchema>;
export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type Config = z.infer<typeof configSchema>;
export type LighterVenueConfig = z.infer<typeof lighterVenueConfigSchema>;

// What is missing before the bot can trade on Lighter (formats are checked by the schema). Never echoes secrets.
export function lighterCredentialProblems(settings: LighterVenueConfig | undefined): string[] {
  const problems: string[] = [];
  if (settings?.accountIndex === undefined) problems.push('account index is missing');
  if (settings?.apiKeyIndex === undefined) problems.push('API key index is missing');
  if (!settings?.apiKeyPrivateKey) problems.push('API private key is missing');
  if (!settings?.apiKeyPublicKey) problems.push('API public key is missing');
  return problems;
}

export interface ConfigMigration {
  fromVersion: string;
  toVersion: string;
  migrate: (config: any) => any;
}