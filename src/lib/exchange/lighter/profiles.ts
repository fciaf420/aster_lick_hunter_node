// Lighter (zkLighter) network profiles (spec §1.1; lighter-python lighter/endpoint_profiles.py).
// The REST URL, WS URL and signer chain id come only from this table. Never sniff a URL (the Python SDK
// falls back to mainnet for hosts it doesn't recognise) and never accept a free-form host: testnet and
// Robinhood testnet share chain id 300, so the chain id alone cannot catch a mix-up.
// Kept free of imports so client-side code (the venue catalog, the config UI) can use it.

export const LIGHTER_PROFILE_NAMES = ['mainnet', 'testnet', 'robinhood', 'robinhood_testnet'] as const;
export type LighterProfileName = typeof LIGHTER_PROFILE_NAMES[number];

export interface LighterProfile {
  readonly name: LighterProfileName;
  readonly label: string;
  readonly apiUrl: string;      // REST base, no trailing slash
  readonly wsUrl: string;       // WebSocket base; connect through lighterStreamUrl()
  readonly chainId: number;     // Signer chain id. The signer keeps it process-global: one profile per process.
  readonly testnet: boolean;
  readonly gated: boolean;      // Refused by getProfile() until the spec §9 checks pass
  readonly gatedReason?: string;
}

const ROBINHOOD_GATE_REASON =
  'Robinhood is a separate exchange with its own markets and an unverified collateral asset. ' +
  'It stays disabled until the live checks in the Lighter spec (§9 Q6, Q17, Q18) pass.';

export const PROFILES: Readonly<Record<LighterProfileName, LighterProfile>> = Object.freeze({
  mainnet: Object.freeze({
    name: 'mainnet',
    label: 'Lighter mainnet',
    apiUrl: 'https://mainnet.zklighter.elliot.ai',
    wsUrl: 'wss://mainnet.zklighter.elliot.ai/stream',
    chainId: 304,
    testnet: false,
    gated: false,
  }),
  testnet: Object.freeze({
    name: 'testnet',
    label: 'Lighter testnet',
    apiUrl: 'https://testnet.zklighter.elliot.ai',
    wsUrl: 'wss://testnet.zklighter.elliot.ai/stream',
    chainId: 300,
    testnet: true,
    gated: false,
  }),
  robinhood: Object.freeze({
    name: 'robinhood',
    label: 'Lighter Robinhood',
    apiUrl: 'https://api.rh.lighter.xyz',
    wsUrl: 'wss://api.rh.lighter.xyz/stream',
    chainId: 466324,
    testnet: false,
    gated: true,
    gatedReason: ROBINHOOD_GATE_REASON,
  }),
  robinhood_testnet: Object.freeze({
    name: 'robinhood_testnet',
    label: 'Lighter Robinhood testnet',
    apiUrl: 'https://api.rh-testnet.lighter.xyz',
    wsUrl: 'wss://api.rh-testnet.lighter.xyz/stream',
    chainId: 300, // same chain id as testnet
    testnet: true,
    gated: true,
    gatedReason: ROBINHOOD_GATE_REASON,
  }),
});

// Testnet until the operator explicitly picks mainnet
export const DEFAULT_LIGHTER_PROFILE: LighterProfileName = 'testnet';

export function isLighterProfileName(value: unknown): value is LighterProfileName {
  return typeof value === 'string' && (LIGHTER_PROFILE_NAMES as readonly string[]).includes(value);
}

// Look a profile up by name. Unknown names throw, and so do gated profiles unless allowGated is set
// (tests and research tooling only; the bot must not trade there).
export function getProfile(name: string, options: { allowGated?: boolean } = {}): LighterProfile {
  if (!isLighterProfileName(name)) {
    throw new Error(`Unknown Lighter profile "${name}". Expected one of: ${LIGHTER_PROFILE_NAMES.join(', ')}`);
  }
  const profile = PROFILES[name];
  if (profile.gated && !options.allowGated) {
    throw new Error(`Lighter profile "${name}" is disabled. ${profile.gatedReason ?? ''}`.trim());
  }
  return profile;
}

// Stream URL for both the public feed and the private channels. The official frontend always connects with
// readonly=true&encoding=json; readonly=true also bypasses region restrictions for read-only data (spec §2.1).
export function lighterStreamUrl(profile: LighterProfile): string {
  return `${profile.wsUrl}?readonly=true&encoding=json`;
}

// REST URL for an API path on the profile's host, e.g. lighterRestUrl(p, '/api/v1/nextNonce', { account_index: 1 })
export function lighterRestUrl(
  profile: LighterProfile,
  path: string,
  query?: Record<string, string | number | boolean | undefined>
): string {
  const url = `${profile.apiUrl}/${path.replace(/^\/+/, '')}`;
  if (!query) return url;
  const params = Object.entries(query)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return params.length > 0 ? `${url}?${params.join('&')}` : url;
}
