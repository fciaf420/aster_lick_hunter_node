import { z } from 'zod';
import { LIQUIDATION_SOURCE_IDS, VENUE_IDS, type VenueId } from '../exchange/types';
import { LIGHTER_PROFILE_NAMES } from '../exchange/lighter/profiles';

export const symbolConfigObjectSchema = z.object({
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
});

// Either the legacy threshold or both the long and short ones (also checked by the config form, per field)
export function hasVolumeThresholds(data: Pick<z.infer<typeof symbolConfigObjectSchema>, 'volumeThresholdUSDT' | 'longVolumeThresholdUSDT' | 'shortVolumeThresholdUSDT'>): boolean {
  return data.volumeThresholdUSDT !== undefined ||
         (data.longVolumeThresholdUSDT !== undefined && data.shortVolumeThresholdUSDT !== undefined);
}

export const symbolConfigSchema = symbolConfigObjectSchema.refine(hasVolumeThresholds, {
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

export const LIGHTER_MIN_ACCOUNT_INDEX = 1;
export const LIGHTER_MAX_ACCOUNT_INDEX = 2 ** 48 - 2;
export const LIGHTER_MIN_API_KEY_INDEX = 0;
export const LIGHTER_MAX_API_KEY_INDEX = 254;
export const LIGHTER_MAX_SLTP_SLIPPAGE_PCT = 10;   // Lighter frontend maximum for the SL/TP worst-price slippage
export const LIGHTER_MIN_SEND_TX_PER_MIN = 1;
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
export const LIGHTER_HEX_KEY_MESSAGE = 'must be 40 bytes of hex (80 characters, optional 0x prefix)';
const lighterHexKeySchema = z.preprocess(
  optionalText,
  z.string().regex(/^(0x)?[0-9a-fA-F]{80}$/, LIGHTER_HEX_KEY_MESSAGE).optional()
);

const lighterSymbolOverrideSchema = z.union([
  z.string().min(1),
  z.object({ market: z.string().min(1), multiplier: z.number().positive().optional() }),
]);

const lighterAccountIndexSchema = z.preprocess(optionalInteger, z.number().int().min(LIGHTER_MIN_ACCOUNT_INDEX).max(LIGHTER_MAX_ACCOUNT_INDEX).optional());
const lighterApiKeyIndexSchema = z.preprocess(optionalInteger, z.number().int().min(LIGHTER_MIN_API_KEY_INDEX).max(LIGHTER_MAX_API_KEY_INDEX).optional());

// Hedge mode emulation: longs on the main account, shorts on this second sub-account of the same master
// (Lighter nets one position per market per account). Same network as the main account; its own API key.
export const lighterHedgeAccountSchema = z.object({
  accountIndex: lighterAccountIndexSchema,
  apiKeyIndex: lighterApiKeyIndexSchema,
  apiKeyPrivateKey: lighterHexKeySchema,
  apiKeyPublicKey: lighterHexKeySchema,
});

// Off unless enabled is true: positionMode defaults to HEDGE, so filling in the short account alone must never
// switch a running one-way setup to two accounts
export const lighterHedgeConfigSchema = z.object({
  enabled: z.boolean().optional(),
  shortAccount: lighterHedgeAccountSchema.optional(),
});

export const LIGHTER_HEDGE_SAME_ACCOUNT_MESSAGE = 'must differ from the main (long) account index';

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
    accountIndex: lighterAccountIndexSchema,
    apiKeyIndex: lighterApiKeyIndexSchema,
    apiKeyPrivateKey: lighterHexKeySchema,
    apiKeyPublicKey: lighterHexKeySchema,
    // false = shadow mode: Lighter liquidations are logged, never traded (spec §8 risk 1)
    liquidationsLive: z.boolean().optional(),
    // Worst-price slippage of stop-loss / take-profit orders after they trigger, in percent
    sltpSlippagePct: z.number().min(0.01).max(LIGHTER_MAX_SLTP_SLIPPAGE_PCT).optional(),
    // Client-side sendTx limit per minute
    sendTxPerMin: z.number().int().min(LIGHTER_MIN_SEND_TX_PER_MIN).max(LIGHTER_MAX_SEND_TX_PER_MIN).optional(),
    // Bot symbol -> Lighter backend symbol (e.g. "QNTUSDT": "QNT", or { "market": "1000NOT", "multiplier": 1000 })
    symbolOverrides: z.record(lighterSymbolOverrideSchema).optional(),
    // Hedge mode via two sub-accounts (the account above holds the longs)
    hedge: lighterHedgeConfigSchema.optional(),
  }).superRefine((settings, ctx) => {
    const shortIndex = settings.hedge?.shortAccount?.accountIndex;
    if (settings.accountIndex !== undefined && shortIndex !== undefined && shortIndex === settings.accountIndex) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hedge', 'shortAccount', 'accountIndex'],
        message: LIGHTER_HEDGE_SAME_ACCOUNT_MESSAGE,
      });
    }
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

// ===== Lighter hedge mode (two sub-accounts) =====
// Structural views, so both the zod Config and the hand-written one in src/lib/types.ts (UI) fit

export type LighterHedgeConfig = z.infer<typeof lighterHedgeConfigSchema>;

interface LighterHedgeAccountView {
  accountIndex?: number;
  apiKeyIndex?: number;
  apiKeyPrivateKey?: string;
  apiKeyPublicKey?: string;
}

interface LighterHedgeSettingsView {
  accountIndex?: number;
  hedge?: { enabled?: boolean; shortAccount?: LighterHedgeAccountView } | null;
}

const SHORT_ACCOUNT_FIELD_PROBLEMS = {
  accountIndex: 'short account index is missing',
  apiKeyIndex: 'short account API key index is missing',
  apiKeyPrivateKey: 'short account API private key is missing',
  apiKeyPublicKey: 'short account API public key is missing',
} as const;

export type LighterShortAccountField = keyof typeof SHORT_ACCOUNT_FIELD_PROBLEMS;

const isSet = (value: unknown) => value !== undefined && value !== null && value !== '';

// The short account fields that are not set (in the order lighterShortAccountProblems lists them)
export function lighterShortAccountMissing(settings: LighterHedgeSettingsView | null | undefined): LighterShortAccountField[] {
  const short = settings?.hedge?.shortAccount;
  return (Object.keys(SHORT_ACCOUNT_FIELD_PROBLEMS) as LighterShortAccountField[]).filter((field) => !isSet(short?.[field]));
}

// What keeps the short account from being used: missing fields and the same index as the main (long) account.
// Formats are checked by the schema. Never echoes secrets.
export function lighterShortAccountProblems(settings: LighterHedgeSettingsView | null | undefined): string[] {
  const short = settings?.hedge?.shortAccount;
  const problems: string[] = lighterShortAccountMissing(settings).map((field) => SHORT_ACCOUNT_FIELD_PROBLEMS[field]);
  if (isSet(short?.accountIndex) && Number(short?.accountIndex) === Number(settings?.accountIndex)) {
    problems.push(`short account index ${LIGHTER_HEDGE_SAME_ACCOUNT_MESSAGE}`);
  }
  return problems;
}

export type LighterHedgeState =
  | { mode: 'off'; reason: 'not-lighter' | 'one-way' | 'disabled' }
  | { mode: 'incomplete'; problems: string[] }
  | { mode: 'on' };

// Whether the bot trades Lighter in hedge mode over two sub-accounts. On only when the venue is Lighter, the
// position mode is HEDGE, hedge.enabled is true and the short account is complete (checked in that order).
export function lighterHedgeState(
  config: {
    global?: { exchange?: string; positionMode?: string } | null;
    venues?: { lighter?: LighterHedgeSettingsView | null } | null;
  } | null | undefined
): LighterHedgeState {
  if (config?.global?.exchange !== 'lighter') return { mode: 'off', reason: 'not-lighter' };
  if (config.global.positionMode !== 'HEDGE') return { mode: 'off', reason: 'one-way' };
  const lighter = config.venues?.lighter;
  if (lighter?.hedge?.enabled !== true) return { mode: 'off', reason: 'disabled' };
  const problems = lighterShortAccountProblems(lighter);
  return problems.length > 0 ? { mode: 'incomplete', problems } : { mode: 'on' };
}

export interface ConfigMigration {
  fromVersion: string;
  toVersion: string;
  migrate: (config: any) => any;
}