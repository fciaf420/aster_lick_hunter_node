/**
 * @jest-environment node
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigLoader } from '@/lib/config/configLoader';
import { liveModeProblem } from '@/lib/config/liveMode';
import { DEFAULT_CONFIG, DEFAULT_CONFIG_VERSION } from '@/lib/config/defaults';
import { configSchema } from '@/lib/config/types';

// What the bot needs before it may trade with real money. configLoader (on load) and POST /api/config (on save)
// share liveModeProblem, so these cases are run through both: the loader must keep refusing and accepting what it
// did, with the very messages it threw before the check was shared (written out below, not derived).

const LOAD_ERROR = 'Failed to load config: ';

const API_KEY = 'k'.repeat(64);
const SECRET_KEY = 's'.repeat(64);
const MAIN_PRIVATE_KEY = 'a1'.repeat(40);
const MAIN_PUBLIC_KEY = 'b2'.repeat(40);
const SHORT_PRIVATE_KEY = 'c3'.repeat(40);
const SHORT_PUBLIC_KEY = 'd4'.repeat(40);

const SECRETS = [API_KEY, SECRET_KEY, MAIN_PRIVATE_KEY, MAIN_PUBLIC_KEY, SHORT_PRIVATE_KEY, SHORT_PUBLIC_KEY];

const MAIN_ACCOUNT = { accountIndex: 12345, apiKeyIndex: 3, apiKeyPrivateKey: MAIN_PRIVATE_KEY, apiKeyPublicKey: MAIN_PUBLIC_KEY };
const SHORT_ACCOUNT = { accountIndex: 23456, apiKeyIndex: 4, apiKeyPrivateKey: SHORT_PRIVATE_KEY, apiKeyPublicKey: SHORT_PUBLIC_KEY };

function config(change: (draft: any) => void = () => {}): any {
  const draft = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  draft.version = DEFAULT_CONFIG_VERSION;
  change(draft);
  return draft;
}

const live = (draft: any) => { draft.global.paperMode = false; };
const lighter = (draft: any) => { live(draft); draft.global.exchange = 'lighter'; };
const withKeys = (draft: any) => { draft.api = { apiKey: API_KEY, secretKey: SECRET_KEY }; };
const withMainAccount = (draft: any) => { draft.venues.lighter = { ...draft.venues.lighter, ...MAIN_ACCOUNT }; };
const withHedge = (hedge: unknown, positionMode = 'HEDGE') => (draft: any) => {
  draft.global.positionMode = positionMode;
  draft.venues.lighter.hedge = hedge;
};

const ALL_CREDENTIALS_MISSING =
  'Lighter credentials are required when not in paper mode: account index is missing; API key index is missing; ' +
  'API private key is missing; API public key is missing';
const HEDGE_INCOMPLETE =
  'Lighter hedge mode needs a complete short account when not in paper mode: short account API key index is missing; ' +
  'short account API private key is missing; short account API public key is missing. Fill it in or turn hedge mode off.';

// [name, how the config differs from the default, the message (undefined: nothing is wrong)]
const CASES: [string, (draft: any) => void, string | undefined][] = [
  ['paper mode needs nothing', () => {}, undefined],
  ['paper mode on Lighter needs nothing', (d) => { d.global.exchange = 'lighter'; }, undefined],
  ['paper mode ignores half a short account', (d) => { d.global.exchange = 'lighter'; withMainAccount(d); withHedge({ enabled: true, shortAccount: { accountIndex: 23456 } })(d); }, undefined],

  ['live Aster without keys', live, 'API keys are required when not in paper mode'],
  ['live Aster with only the API key', (d) => { live(d); d.api = { apiKey: API_KEY, secretKey: '' }; }, 'API keys are required when not in paper mode'],
  ['live Aster with only the secret key', (d) => { live(d); d.api = { apiKey: '', secretKey: SECRET_KEY }; }, 'API keys are required when not in paper mode'],
  ['live Aster with a short API key', (d) => { live(d); d.api = { apiKey: 'k'.repeat(63), secretKey: SECRET_KEY }; }, 'API keys must be 64 characters when not in paper mode'],
  ['live Aster with a long secret key', (d) => { live(d); d.api = { apiKey: API_KEY, secretKey: 's'.repeat(65) }; }, 'API keys must be 64 characters when not in paper mode'],
  ['live Aster with both keys', (d) => { live(d); withKeys(d); }, undefined],
  ['live Aster without the venue set (it is Aster)', (d) => { live(d); delete d.global.exchange; }, 'API keys are required when not in paper mode'],

  ['live Lighter without credentials', lighter, ALL_CREDENTIALS_MISSING],
  ['live Lighter without the public key', (d) => { lighter(d); withMainAccount(d); delete d.venues.lighter.apiKeyPublicKey; }, 'Lighter credentials are required when not in paper mode: API public key is missing'],
  ['live Lighter ignores the Aster keys', (d) => { lighter(d); withKeys(d); }, ALL_CREDENTIALS_MISSING],
  ['live Lighter with credentials, one-way', (d) => { lighter(d); withMainAccount(d); d.global.positionMode = 'ONE_WAY'; }, undefined],

  ['live Lighter hedge with half a short account', (d) => { lighter(d); withMainAccount(d); withHedge({ enabled: true, shortAccount: { accountIndex: 23456 } })(d); }, HEDGE_INCOMPLETE],
  ['live Lighter hedge without a short account', (d) => { lighter(d); withMainAccount(d); withHedge({ enabled: true })(d); },
    'Lighter hedge mode needs a complete short account when not in paper mode: short account index is missing; short account API key index is missing; ' +
    'short account API private key is missing; short account API public key is missing. Fill it in or turn hedge mode off.'],
  ['live Lighter hedge with a complete short account', (d) => { lighter(d); withMainAccount(d); withHedge({ enabled: true, shortAccount: SHORT_ACCOUNT })(d); }, undefined],
  ['live Lighter hedge off with half a short account', (d) => { lighter(d); withMainAccount(d); withHedge({ enabled: false, shortAccount: { accountIndex: 23456 } })(d); }, undefined],
  ['live Lighter hedge flag unset with half a short account', (d) => { lighter(d); withMainAccount(d); withHedge({ shortAccount: { accountIndex: 23456 } })(d); }, undefined],
  ['live Lighter hedge on in one-way position mode', (d) => { lighter(d); withMainAccount(d); withHedge({ enabled: true }, 'ONE_WAY')(d); }, undefined],
  ['the main credentials come before the short account', (d) => { lighter(d); withHedge({ enabled: true })(d); }, ALL_CREDENTIALS_MISSING],
];

describe('liveModeProblem', () => {
  it.each(CASES)('%s', (_name, change, expected) => {
    expect(liveModeProblem(configSchema.parse(config(change)))).toBe(expected);
  });

  it('never puts a credential in the message', () => {
    for (const [, change] of CASES) {
      const message = liveModeProblem(configSchema.parse(config(change))) ?? '';
      for (const secret of SECRETS) expect(message).not.toContain(secret);
    }
  });
});

describe('configLoader with the shared check', () => {
  let tmpDir: string;
  let loader: any;
  let originalState: Record<string, unknown>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-mode-config-'));
    loader = ConfigLoader.getInstance() as any;
    originalState = {
      userConfigPath: loader.userConfigPath,
      legacyConfigPath: loader.legacyConfigPath,
      defaultConfigPath: loader.defaultConfigPath,
      config: loader.config,
    };
    // Temp files only: the real config.user.json is never read or written
    loader.userConfigPath = path.join(tmpDir, 'config.user.json');
    loader.legacyConfigPath = path.join(tmpDir, 'config.json');
    loader.defaultConfigPath = path.join(tmpDir, 'config.default.json');
  });

  afterEach(async () => {
    Object.assign(loader, originalState);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function load(draft: any) {
    await fs.writeFile(loader.userConfigPath, JSON.stringify(draft));
    return loader.loadConfig();
  }

  it.each(CASES)('%s', async (_name, change, expected) => {
    const draft = config(change);
    if (expected === undefined) {
      await expect(load(draft)).resolves.toMatchObject({ global: { paperMode: draft.global.paperMode } });
    } else {
      // The exact error the loader has always thrown: the message of the check, behind the loader's own prefix
      await expect(load(draft)).rejects.toThrow(new Error(LOAD_ERROR + expected));
    }
  });

  it('refuses and accepts exactly what liveModeProblem does', async () => {
    for (const [name, change] of CASES) {
      const draft = config(change);
      const problem = liveModeProblem(configSchema.parse(JSON.parse(JSON.stringify(draft))));
      const outcome = await load(draft).then(() => undefined, (error: Error) => error.message);
      expect([name, outcome]).toEqual([name, problem === undefined ? undefined : LOAD_ERROR + problem]);
    }
  });
});
