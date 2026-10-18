import { lighterCredentialProblems } from '../config/types';
import { LighterAuthTokenManager } from '../exchange/lighter/http';
import type { LighterProfile } from '../exchange/lighter/profiles';
import type { LighterSigner, LoadLighterSignerOptions } from '../exchange/lighter/signer';
import type { Config } from '../types';

export interface BackfillAuthDeps {
  env?: NodeJS.ProcessEnv;
  // Only createAuthToken is ever called on what it returns
  loadSigner?: (options: LoadLighterSignerOptions) => Pick<LighterSigner, 'createAuthToken'>;
}

// Where the backfill gets an auth token if the trades API asks for one: LIGHTER_AUTH_TOKEN, else a token signed with
// the configured Lighter API key (only when the key belongs to the profile being read). undefined: no source.
//
// Read-only by construction: the native signer is loaded on the first request for a token, and only its
// createAuthToken is wired up. No adapter, nonce manager or transaction sender exists in the backfill process, so it
// has no way to sign a transaction.
export function lighterBackfillAuthSource(
  config: Config,
  profile: LighterProfile,
  deps: BackfillAuthDeps = {}
): (() => Promise<string>) | undefined {
  const envToken = (deps.env ?? process.env).LIGHTER_AUTH_TOKEN?.trim();
  if (envToken) return async () => envToken;
  const settings = config.venues?.lighter;
  if ((settings?.profile ?? 'testnet') !== profile.name) return undefined;   // The key belongs to the configured network
  if (lighterCredentialProblems(settings).length > 0) return undefined;

  let tokens: LighterAuthTokenManager | null = null;
  return async () => {
    if (!tokens) {
      const [{ parseLighterCredentials }, { lighterCredentialsFrom }] = await Promise.all([
        import('../exchange/lighter/LighterAdapter'),
        import('../exchange/lighter/runtime'),
      ]);
      const { credentials, problems } = parseLighterCredentials(lighterCredentialsFrom(config));
      if (!credentials) throw new Error(`Lighter credentials are incomplete: ${problems.join('; ')}`);
      const loadSigner = deps.loadSigner ?? (await import('../exchange/lighter/signer')).loadLighterSigner;
      const signer = loadSigner({
        chainId: profile.chainId,
        accountIndex: credentials.accountIndex,
        apiKeyIndex: credentials.apiKeyIndex,
        apiKeyPrivateKey: credentials.apiKeyPrivateKey,
      });
      tokens = new LighterAuthTokenManager({ createToken: deadlineSec => signer.createAuthToken(deadlineSec) });
    }
    return tokens.getAuthToken({ forceRefresh: true });
  };
}
