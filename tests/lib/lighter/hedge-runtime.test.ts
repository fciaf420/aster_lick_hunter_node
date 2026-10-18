/**
 * @jest-environment node
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Config } from '../../../src/lib/types';
import {
  configSchema,
  lighterHedgeState,
  lighterShortAccountProblems,
  type LighterHedgeState,
} from '../../../src/lib/config/types';
import { ConfigLoader } from '../../../src/lib/config/configLoader';
import { DEFAULT_CONFIG, DEFAULT_CONFIG_VERSION, DEFAULT_LIGHTER_VENUE_SETTINGS } from '../../../src/lib/config/defaults';
import { withoutSecrets } from '../../../src/lib/config/redact';
import { LighterAdapter } from '../../../src/lib/exchange/lighter/LighterAdapter';
import { LighterHedgeAdapter } from '../../../src/lib/exchange/lighter/LighterHedgeAdapter';
import { LIGHTER_HEDGE_COI_RANGES } from '../../../src/lib/exchange/lighter/nonce';
import {
  configureLighterRuntime,
  createLighterAdapter,
  createLighterVenueAdapter,
  isLighterReadOnlyError,
  isLighterVenueAdapter,
  lighterCredentialsFrom,
  lighterShortCredentialsFrom,
  lighterUnmanagedShortAccountWarning,
  resetLighterRuntime,
  setLighterAlertSink,
  stopLighterRuntime,
  type LighterRuntimeAlert,
} from '../../../src/lib/exchange/lighter/runtime';
import { AsterAdapter } from '../../../src/lib/exchange/aster/AsterAdapter';
import { createExchangeAdapter, createPublicExchangeAdapter } from '../../../src/lib/exchange/registry';
import * as registry from '../../../src/lib/exchange/registry';
import { loadConfig } from '../../../src/lib/bot/config';
import { resetRateLimitManager } from '../../../src/lib/api/rateLimitManager';
import { TEST_ACCOUNT, TEST_KEY_INDEX, TEST_PUBLIC_KEY, THROWAWAY_PRIVATE_KEY } from './fakeLighterExchange';
import { FakeLighterHedgeExchange, HEDGE_SHORT_ACCOUNT, HEDGE_SHORT_KEY, HEDGE_SHORT_PUBLIC_KEY } from './fakeLighterHedge';

// Dashboard routes: a signed-in session, and the config they load is the test's
jest.mock('next-auth/jwt', () => ({ getToken: jest.fn(async () => ({ id: '1', email: 'test@example.com', name: 'test' })) }));
jest.mock('../../../src/lib/bot/config', () => ({ loadConfig: jest.fn() }));

// Lighter hedge mode (two sub-accounts) in the config and the runtime: schema, the enablement rule, live-mode
// validation, redaction, and the registry / runtime wiring of the composite adapter. Fully offline.

const SHORT_ACCOUNT = HEDGE_SHORT_ACCOUNT;
const SHORT_KEY_INDEX = HEDGE_SHORT_KEY;
const SHORT_PRIVATE_KEY = '0x' + '5e'.repeat(40);
const SHORT_PUBLIC_KEY = HEDGE_SHORT_PUBLIC_KEY;
const ETH = 0;   // Fixture market (ETHUSDT)

type HedgeOverrides = {
  global?: Partial<Config['global']>;
  lighter?: Record<string, unknown>;
  hedge?: Record<string, unknown> | undefined;
  shortAccount?: Record<string, unknown>;
};

function hedgeConfig(overrides: HedgeOverrides = {}): Config {
  const symbol = { longVolumeThresholdUSDT: 1000, shortVolumeThresholdUSDT: 1000, tradeSize: 0.01, leverage: 5, tpPercent: 2, slPercent: 1 };
  const hedge = 'hedge' in overrides
    ? overrides.hedge
    : {
      enabled: true,
      shortAccount: {
        accountIndex: SHORT_ACCOUNT,
        apiKeyIndex: SHORT_KEY_INDEX,
        apiKeyPrivateKey: SHORT_PRIVATE_KEY,
        apiKeyPublicKey: SHORT_PUBLIC_KEY,
        ...overrides.shortAccount,
      },
    };
  return {
    api: { apiKey: '', secretKey: '' },
    symbols: { BTCUSDT: { ...symbol }, ETHUSDT: { ...symbol } },
    global: { riskPercent: 5, paperMode: false, exchange: 'lighter', liquidationSource: 'lighter', positionMode: 'HEDGE', ...overrides.global },
    venues: {
      lighter: {
        profile: 'testnet',
        accountIndex: TEST_ACCOUNT,
        apiKeyIndex: TEST_KEY_INDEX,
        apiKeyPrivateKey: THROWAWAY_PRIVATE_KEY,
        apiKeyPublicKey: TEST_PUBLIC_KEY,
        ...(hedge === undefined ? {} : { hedge }),
        ...overrides.lighter,
      },
    },
  } as Config;
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('config schema', () => {
  it('accepts a hedge block and normalizes it like the main credentials', () => {
    const raw: any = hedgeConfig({
      shortAccount: { accountIndex: ` ${SHORT_ACCOUNT} `, apiKeyIndex: String(SHORT_KEY_INDEX), apiKeyPublicKey: ` ${SHORT_PUBLIC_KEY} ` },
    });
    const parsed = configSchema.parse(raw);
    expect(parsed.venues?.lighter?.hedge).toEqual({
      enabled: true,
      shortAccount: {
        accountIndex: SHORT_ACCOUNT,
        apiKeyIndex: SHORT_KEY_INDEX,
        apiKeyPrivateKey: SHORT_PRIVATE_KEY,
        apiKeyPublicKey: SHORT_PUBLIC_KEY,
      },
    });
  });

  it('reads empty short-account inputs as not set, so a partial setup can be saved', () => {
    const raw: any = hedgeConfig({ shortAccount: { accountIndex: '', apiKeyIndex: null, apiKeyPrivateKey: '  ', apiKeyPublicKey: undefined } });
    const parsed = configSchema.parse(raw);
    expect(parsed.venues?.lighter?.hedge).toEqual({ enabled: true, shortAccount: {} });
    expect(configSchema.parse(hedgeConfig({ hedge: { enabled: false } })).venues?.lighter?.hedge).toEqual({ enabled: false });
    expect(configSchema.parse(hedgeConfig({ hedge: {} })).venues?.lighter?.hedge).toEqual({});
  });

  it('refuses a short account with the main account index, at the short account index path', () => {
    const result = configSchema.safeParse(hedgeConfig({ shortAccount: { accountIndex: TEST_ACCOUNT } }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual([
      expect.objectContaining({
        path: ['venues', 'lighter', 'hedge', 'shortAccount', 'accountIndex'],
        message: 'must differ from the main (long) account index',
      }),
    ]);
    // Also when the short index is written as a digit string
    expect(configSchema.safeParse(hedgeConfig({ shortAccount: { accountIndex: String(TEST_ACCOUNT) } })).success).toBe(false);
    // A missing main index is no conflict
    expect(configSchema.safeParse(hedgeConfig({ lighter: { accountIndex: undefined } })).success).toBe(true);
  });

  it.each([
    ['accountIndex', 0],
    ['accountIndex', 2 ** 48],
    ['accountIndex', -3],
    ['accountIndex', 1.5],
    ['accountIndex', 'abc'],
    ['apiKeyIndex', 255],
    ['apiKeyIndex', -1],
    ['apiKeyPrivateKey', 'xyz'],
    ['apiKeyPrivateKey', 'ab'.repeat(39)],
    ['apiKeyPublicKey', 'zz'.repeat(40)],
  ])('rejects shortAccount.%s = %p', (field, value) => {
    const result = configSchema.safeParse(hedgeConfig({ shortAccount: { [field]: value } }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0].path).toEqual(['venues', 'lighter', 'hedge', 'shortAccount', field]);
  });

  it('rejects a non-boolean enabled flag', () => {
    expect(configSchema.safeParse(hedgeConfig({ hedge: { enabled: 'yes' } })).success).toBe(false);
  });

  it('round-trips a Lighter config without a hedge block unchanged (no hedge key appears)', () => {
    const raw = hedgeConfig({ hedge: undefined });
    const parsed = configSchema.parse(raw);
    expect('hedge' in (parsed.venues?.lighter ?? {})).toBe(false);
    expect(parsed.venues?.lighter).toEqual(raw.venues?.lighter);
    expect(configSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('adds no hedge defaults: DEFAULT_LIGHTER_VENUE_SETTINGS and config.default.json stay as they were', async () => {
    expect('hedge' in DEFAULT_LIGHTER_VENUE_SETTINGS).toBe(false);
    expect(DEFAULT_LIGHTER_VENUE_SETTINGS).toEqual({ profile: 'testnet', liquidationsLive: false, sltpSlippagePct: 1, sendTxPerMin: 60 });
    const defaultFile = JSON.parse(await fs.readFile(path.join(__dirname, '..', '..', '..', 'config.default.json'), 'utf8'));
    expect(JSON.stringify(defaultFile)).not.toContain('"hedge"');
    expect(JSON.stringify(DEFAULT_CONFIG)).not.toContain('"hedge"');
  });
});

describe('lighterShortAccountProblems', () => {
  it('lists every missing field', () => {
    expect(lighterShortAccountProblems(undefined)).toEqual([
      'short account index is missing',
      'short account API key index is missing',
      'short account API private key is missing',
      'short account API public key is missing',
    ]);
    expect(lighterShortAccountProblems({ accountIndex: TEST_ACCOUNT, hedge: { enabled: true, shortAccount: { accountIndex: SHORT_ACCOUNT, apiKeyIndex: 0 } } }))
      .toEqual(['short account API private key is missing', 'short account API public key is missing']);
  });

  it('accepts key index 0 and names the same-index problem', () => {
    const complete = hedgeConfig({ shortAccount: { apiKeyIndex: 0 } }).venues!.lighter!;
    expect(lighterShortAccountProblems(complete)).toEqual([]);
    const same = hedgeConfig({ shortAccount: { accountIndex: TEST_ACCOUNT } }).venues!.lighter!;
    expect(lighterShortAccountProblems(same)).toEqual(['short account index must differ from the main (long) account index']);
  });

  it('never echoes secrets', () => {
    const settings = hedgeConfig({ shortAccount: { accountIndex: TEST_ACCOUNT, apiKeyPublicKey: '' } }).venues!.lighter!;
    const text = lighterShortAccountProblems(settings).join(' ');
    expect(text).not.toContain(SHORT_PRIVATE_KEY.slice(2, 20));
    expect(text).not.toContain(THROWAWAY_PRIVATE_KEY.slice(2, 20));
    expect(text).not.toContain(String(TEST_ACCOUNT));
  });
});

describe('lighterHedgeState (enablement rule)', () => {
  const cases: Array<[string, Parameters<typeof lighterHedgeState>[0], LighterHedgeState]> = [
    ['no config', undefined, { mode: 'off', reason: 'not-lighter' }],
    ['null config', null, { mode: 'off', reason: 'not-lighter' }],
    ['Aster venue with a complete hedge block', hedgeConfig({ global: { exchange: 'aster' } }), { mode: 'off', reason: 'not-lighter' }],
    ['default venue (no exchange set)', hedgeConfig({ global: { exchange: undefined } }), { mode: 'off', reason: 'not-lighter' }],
    ['Lighter, one-way', hedgeConfig({ global: { positionMode: 'ONE_WAY' } }), { mode: 'off', reason: 'one-way' }],
    ['Lighter, no position mode', hedgeConfig({ global: { positionMode: undefined } }), { mode: 'off', reason: 'one-way' }],
    ['Lighter, HEDGE, no hedge block', hedgeConfig({ hedge: undefined }), { mode: 'off', reason: 'disabled' }],
    ['Lighter, HEDGE, keys filled in but not enabled', hedgeConfig({ hedge: { shortAccount: hedgeConfig().venues!.lighter!.hedge!.shortAccount } }),
      { mode: 'off', reason: 'disabled' }],
    ['Lighter, HEDGE, enabled false', hedgeConfig({ hedge: { enabled: false } }), { mode: 'off', reason: 'disabled' }],
    ['Lighter, HEDGE, enabled, no short account', hedgeConfig({ hedge: { enabled: true } }), {
      mode: 'incomplete',
      problems: [
        'short account index is missing',
        'short account API key index is missing',
        'short account API private key is missing',
        'short account API public key is missing',
      ],
    }],
    ['Lighter, HEDGE, enabled, short key missing', hedgeConfig({ shortAccount: { apiKeyPrivateKey: undefined } }),
      { mode: 'incomplete', problems: ['short account API private key is missing'] }],
    ['Lighter, HEDGE, enabled, same index', hedgeConfig({ shortAccount: { accountIndex: TEST_ACCOUNT } }),
      { mode: 'incomplete', problems: ['short account index must differ from the main (long) account index'] }],
    ['Lighter, HEDGE, enabled, complete', hedgeConfig(), { mode: 'on' }],
  ];

  it.each(cases)('%s', (_name, config, expected) => {
    expect(lighterHedgeState(config)).toEqual(expected);
  });

  it('checks the venue first, then the position mode, then the flag', () => {
    // Everything wrong at once: the venue wins
    expect(lighterHedgeState(hedgeConfig({ global: { exchange: 'aster', positionMode: 'ONE_WAY' }, hedge: { enabled: false } })))
      .toEqual({ mode: 'off', reason: 'not-lighter' });
    expect(lighterHedgeState(hedgeConfig({ global: { positionMode: 'ONE_WAY' }, hedge: { enabled: true } })))
      .toEqual({ mode: 'off', reason: 'one-way' });
    expect(lighterHedgeState(hedgeConfig({ hedge: { enabled: false, shortAccount: {} } })))
      .toEqual({ mode: 'off', reason: 'disabled' });
  });
});

describe('configLoader: live-mode validation', () => {
  let tmpDir: string;
  let loader: any;
  let originalState: Record<string, unknown>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lighter-hedge-config-'));
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

  async function load(config: Config): Promise<Config> {
    await fs.writeFile(loader.userConfigPath, JSON.stringify({ ...config, version: DEFAULT_CONFIG_VERSION }));
    return loader.loadConfig();
  }

  it('refuses live hedge mode with an incomplete short account, naming what is missing', async () => {
    await expect(load(hedgeConfig({ shortAccount: { apiKeyPrivateKey: undefined, apiKeyPublicKey: '' } }))).rejects.toThrow(
      'Lighter hedge mode needs a complete short account when not in paper mode: short account API private key is missing; ' +
      'short account API public key is missing. Fill it in or turn hedge mode off.'
    );
    await expect(load(hedgeConfig({ hedge: { enabled: true } }))).rejects.toThrow('short account index is missing');
  });

  it('loads live configs where hedge mode is off, whatever the short account holds', async () => {
    for (const config of [
      hedgeConfig({ hedge: { enabled: false, shortAccount: { accountIndex: SHORT_ACCOUNT } } }),
      hedgeConfig({ hedge: { shortAccount: { apiKeyIndex: 2 } } }),
      hedgeConfig({ global: { positionMode: 'ONE_WAY' }, hedge: { enabled: true } }),
      hedgeConfig({ hedge: undefined }),
    ]) {
      const loaded = await load(config);
      expect(lighterHedgeState(loaded).mode).toBe('off');
    }
  });

  it('loads a complete live hedge config, and an incomplete one in paper mode', async () => {
    const complete = await load(hedgeConfig());
    expect(lighterHedgeState(complete)).toEqual({ mode: 'on' });
    expect(complete.venues?.lighter?.hedge?.shortAccount?.accountIndex).toBe(SHORT_ACCOUNT);

    const paper = await load(hedgeConfig({ global: { paperMode: true }, hedge: { enabled: true } }));
    expect(lighterHedgeState(paper).mode).toBe('incomplete');
  });

  it('still checks the main Lighter credentials first', async () => {
    await expect(load(hedgeConfig({ lighter: { apiKeyPublicKey: undefined }, hedge: { enabled: true } })))
      .rejects.toThrow('Lighter credentials are required when not in paper mode: API public key is missing');
  });

  it('keeps refusing the same index through the schema', async () => {
    await expect(load(hedgeConfig({ shortAccount: { accountIndex: TEST_ACCOUNT } })))
      .rejects.toThrow('venues.lighter.hedge.shortAccount.accountIndex: must differ from the main (long) account index');
  });

  it('does not write a hedge block into a user file that had none', async () => {
    await load(hedgeConfig({ hedge: undefined }));
    const saved = await fs.readFile(loader.userConfigPath, 'utf8');
    expect(saved).not.toContain('"hedge"');
  });
});

describe('redaction', () => {
  it('withoutSecrets leaves neither the main nor the short private key in the broadcast config', () => {
    const config = hedgeConfig();
    const text = JSON.stringify(withoutSecrets(config));
    expect(text).not.toContain(SHORT_PRIVATE_KEY.slice(2));
    expect(text).not.toContain(SHORT_PUBLIC_KEY);
    expect(text).not.toContain(THROWAWAY_PRIVATE_KEY.slice(2));
    expect(text).not.toContain('shortAccount');
    expect(JSON.parse(text)).toEqual({ symbols: config.symbols, global: config.global });
  });
});

describe('runtime and registry wiring', () => {
  let fake: FakeLighterHedgeExchange;

  beforeEach(() => {
    resetLighterRuntime();
    fake = new FakeLighterHedgeExchange(() => Date.now());
    configureLighterRuntime({ transport: fake.transport });
  });

  afterEach(() => {
    resetLighterRuntime();
  });

  function postRequests(): number {
    return fake.routed.filter(entry => entry.request.method === 'POST').length;
  }

  it('reads the short account credentials, bound to the main account\'s network', () => {
    expect(lighterShortCredentialsFrom(hedgeConfig({ lighter: { profile: 'mainnet' } }))).toEqual({
      profile: 'mainnet',
      accountIndex: SHORT_ACCOUNT,
      apiKeyIndex: SHORT_KEY_INDEX,
      apiKeyPrivateKey: SHORT_PRIVATE_KEY,
      apiKeyPublicKey: SHORT_PUBLIC_KEY,
    });
    expect(lighterShortCredentialsFrom(hedgeConfig({ hedge: { enabled: true } }))).toBeNull();
    expect(lighterShortCredentialsFrom({ venues: {} })).toBeNull();
    expect(lighterShortCredentialsFrom(null)).toBeNull();
    // The main credentials are unchanged by a hedge block
    expect(lighterCredentialsFrom(hedgeConfig())).toEqual({
      profile: 'testnet', accountIndex: TEST_ACCOUNT, apiKeyIndex: TEST_KEY_INDEX,
      apiKeyPrivateKey: THROWAWAY_PRIVATE_KEY, apiKeyPublicKey: TEST_PUBLIC_KEY,
    });
  });

  it('hedge mode on: the registry builds the composite over the main (long) and the short account', () => {
    const adapter = createExchangeAdapter(hedgeConfig());
    expect(adapter).toBeInstanceOf(LighterHedgeAdapter);
    const hedge = adapter as LighterHedgeAdapter;
    expect(hedge.id).toBe('lighter');
    expect(hedge.capabilities.hedgeMode).toBe(true);
    expect(hedge.capabilities.marginAsset).toBe('USDC');
    expect(hedge.hasCredentials()).toBe(true);
    expect(hedge.long).toBeInstanceOf(LighterAdapter);
    expect(hedge.short).toBeInstanceOf(LighterAdapter);
    expect(hedge.long.configuredAccountIndex()).toBe(TEST_ACCOUNT);
    expect(hedge.long.configuredApiKeyIndex()).toBe(TEST_KEY_INDEX);
    expect(hedge.short.configuredAccountIndex()).toBe(SHORT_ACCOUNT);
    expect(hedge.short.configuredApiKeyIndex()).toBe(SHORT_KEY_INDEX);
    expect(hedge.long.clientOrderIndexRange).toEqual(LIGHTER_HEDGE_COI_RANGES.LONG);
    expect(hedge.short.clientOrderIndexRange).toEqual(LIGHTER_HEDGE_COI_RANGES.SHORT);
    expect(hedge.long.markets).toBe(hedge.short.markets);
    expect(hedge.profile.name).toBe('testnet');
    expect(isLighterVenueAdapter(hedge)).toBe(true);
  });

  it.each<[string, HedgeOverrides]>([
    ['one-way position mode', { global: { positionMode: 'ONE_WAY' } }],
    ['hedge block disabled', { hedge: { enabled: false, shortAccount: { accountIndex: SHORT_ACCOUNT } } }],
    ['no hedge block', { hedge: undefined }],
    ['short account incomplete (paper mode)', { global: { paperMode: true }, shortAccount: { apiKeyPublicKey: undefined } }],
  ])('%s: the plain one-way adapter, exactly as before', (_name, overrides) => {
    const adapter = createExchangeAdapter(hedgeConfig(overrides));
    expect(adapter).toBeInstanceOf(LighterAdapter);
    expect(adapter).not.toBeInstanceOf(LighterHedgeAdapter);
    const lighter = adapter as LighterAdapter;
    expect(lighter.capabilities.hedgeMode).toBe(false);
    expect(lighter.clientOrderIndexRange).toBeNull();
    expect(lighter.configuredAccountIndex()).toBe(TEST_ACCOUNT);
    expect(isLighterVenueAdapter(lighter)).toBe(true);
  });

  it('the public (symbol picker) adapter is unchanged by hedge mode', () => {
    const adapter = createPublicExchangeAdapter(hedgeConfig());
    expect(adapter).toBeInstanceOf(LighterAdapter);
    expect(adapter).not.toBeInstanceOf(LighterHedgeAdapter);
    expect(adapter.hasCredentials()).toBe(false);
    expect(createLighterVenueAdapter(hedgeConfig(), { catalog: true })).not.toBeInstanceOf(LighterHedgeAdapter);
  });

  it('hedgeSide picks the account, its client order index range and nothing else', () => {
    const short = createLighterAdapter(hedgeConfig(), { hedgeSide: 'SHORT' });
    expect(short.configuredAccountIndex()).toBe(SHORT_ACCOUNT);
    expect(short.clientOrderIndexRange).toEqual(LIGHTER_HEDGE_COI_RANGES.SHORT);
    const long = createLighterAdapter(hedgeConfig(), { hedgeSide: 'LONG' });
    expect(long.configuredAccountIndex()).toBe(TEST_ACCOUNT);
    expect(long.clientOrderIndexRange).toEqual(LIGHTER_HEDGE_COI_RANGES.LONG);
    // createLighterVenueAdapter passes an explicit side straight through
    expect(createLighterVenueAdapter(hedgeConfig(), { hedgeSide: 'SHORT' })).toBeInstanceOf(LighterAdapter);
  });

  it('the hedge state is read once, when the adapter is built (switching needs a restart)', () => {
    let config = hedgeConfig();
    const adapter = createExchangeAdapter(config, undefined, { getConfig: () => config });
    expect(adapter).toBeInstanceOf(LighterHedgeAdapter);
    config = hedgeConfig({ hedge: { enabled: false } });
    expect(adapter).toBeInstanceOf(LighterHedgeAdapter);
    // The inner adapters keep reading the live config (as the one-way adapter does)
    expect((adapter as LighterHedgeAdapter).short.hasCredentials()).toBe(false);
    expect(adapter.hasCredentials()).toBe(false);
  });

  it('read-only composite (dashboard): positions and balances of both accounts, never a signature', async () => {
    fake.long.setPosition(ETH, '0.5000', { avg_entry_price: '4050.00' });
    fake.short.setPosition(ETH, '-0.3000', { avg_entry_price: '4100.00' });
    fake.short.account.available_balance = '500.000000';
    const adapter = createExchangeAdapter(hedgeConfig());
    expect(adapter).toBeInstanceOf(LighterHedgeAdapter);

    const positions = await adapter.getPositions();
    const open = positions.filter(p => Number(p.positionAmt) !== 0).map(p => [p.symbol, p.positionSide, p.positionAmt]);
    expect(open).toEqual([['ETHUSDT', 'LONG', '0.5000'], ['ETHUSDT', 'SHORT', '-0.3000']]);
    const accountReads = fake.routed.filter(entry => new URL(entry.request.url).pathname === '/api/v1/account');
    expect(new Set(accountReads.map(entry => `${entry.side}:${new URL(entry.request.url).searchParams.get('value')}`)))
      .toEqual(new Set([`LONG:${TEST_ACCOUNT}`, `SHORT:${SHORT_ACCOUNT}`]));

    // /api/balance REST fallback: combined totals plus each account
    const info = await adapter.getAccountInfo();
    expect(info.availableBalance).toBe('1300');
    expect(info.lighterHedge.LONG).toMatchObject({ accountIndex: TEST_ACCOUNT, availableBalance: '800' });
    expect(info.lighterHedge.SHORT).toMatchObject({ accountIndex: SHORT_ACCOUNT, availableBalance: '500' });

    // Private reads and every order stay with the bot
    const openOrders = await adapter.getOpenOrders().catch(error => error);
    expect(isLighterReadOnlyError(openOrders)).toBe(true);
    const order = await adapter.placeOrder({ symbol: 'ETHUSDT', side: 'BUY', type: 'MARKET', quantity: 0.1, positionSide: 'LONG' }).catch(error => error);
    expect(isLighterReadOnlyError(order)).toBe(true);
    const protective = await adapter.placeProtectiveOrders({
      symbol: 'ETHUSDT', side: 'BUY', quantity: 0.3, stopLossPrice: 4200, takeProfitPrice: 3900, positionSide: 'SHORT',
    }).catch(error => error);
    expect(protective instanceof Error ? isLighterReadOnlyError(protective) : protective.errors.length > 0).toBe(true);
    expect(postRequests()).toBe(0);
  });

  it('hedge alerts reach the bot\'s alert sink', async () => {
    const events: LighterRuntimeAlert[] = [];
    setLighterAlertSink(event => events.push(event));
    fake.short.setPosition(ETH, '0.2000', { avg_entry_price: '4050.00' });   // A long on the short account
    const adapter = createExchangeAdapter(hedgeConfig());
    await adapter.getPositions();
    expect(events).toEqual([
      { source: 'hedge', alert: expect.objectContaining({ kind: 'wrong-sign', side: 'SHORT', symbol: 'ETHUSDT' }) },
    ]);
    expect(events[0].source === 'hedge' && events[0].alert.message).toContain('short account (23456) holds a long ETHUSDT position');
    // Once per flagged position
    await adapter.getPositions();
    expect(events).toHaveLength(1);
  });

  it('the default sink logs hedge alerts', async () => {
    const errors = jest.spyOn(console, 'error');
    fake.short.setPosition(ETH, '0.2000', { avg_entry_price: '4050.00' });
    await createExchangeAdapter(hedgeConfig()).getPositions();
    expect(errors.mock.calls.flat().join(' ')).toMatch(/Lighter hedge alert: .*short account \(23456\) holds a long ETHUSDT/);
  });

  it('labels each inner adapter\'s stream and late-tx alerts with its account', () => {
    const events: LighterRuntimeAlert[] = [];
    setLighterAlertSink(event => events.push(event));
    const optionsOf = (adapter: LighterAdapter) => (adapter as any).options as {
      onUserStreamAlert: (alert: { kind: string; message: string }) => void;
      onLateTxOutcome: (outcome: { txHash: string; nonce: number; outcome: string; detail: string }) => void;
    };
    const hedge = createExchangeAdapter(hedgeConfig()) as LighterHedgeAdapter;
    optionsOf(hedge.short).onUserStreamAlert({ kind: 'reconcile-failed', message: 'orders could not be read' });
    optionsOf(hedge.long).onLateTxOutcome({ txHash: 'ab', nonce: 7, outcome: 'executed', detail: 'status 2' });
    optionsOf(hedge.long).onLateTxOutcome({ txHash: 'cd', nonce: 8, outcome: 'not-executed', detail: 'status 0' });
    const plain = createExchangeAdapter(hedgeConfig({ hedge: undefined })) as LighterAdapter;
    optionsOf(plain).onUserStreamAlert({ kind: 'reconcile-failed', message: 'orders could not be read' });

    expect(events).toEqual([
      { source: 'account', alert: { kind: 'reconcile-failed', message: '[short account] orders could not be read' } },
      { source: 'late-tx', message: expect.stringMatching(/^\[long account\] A Lighter tx \(nonce 7\) the bot had stopped waiting for executed after all/) },
      { source: 'account', alert: { kind: 'reconcile-failed', message: 'orders could not be read' } },
    ]);
  });

  it('the bot\'s signing composite closes both accounts on shutdown', () => {
    const close = jest.spyOn(LighterAdapter.prototype, 'close');
    const adapter = createExchangeAdapter(hedgeConfig(), undefined, { allowSigning: true }) as LighterHedgeAdapter;
    stopLighterRuntime();
    expect(close.mock.instances).toEqual(expect.arrayContaining([adapter.long, adapter.short]));
  });

  it('one-way startup warning: the short account\'s SL/TP expire after 28 days, and the positions left there are named', async () => {
    fake.short.setPosition(ETH, '-0.3000', { avg_entry_price: '4100.00' });
    const oneWay = hedgeConfig({ global: { positionMode: 'ONE_WAY' } });
    const message = await lighterUnmanagedShortAccountWarning(oneWay);
    expect(message).toBe(
      `Lighter: short account ${SHORT_ACCOUNT} is not managed in one-way mode. Positions there keep their exchange SL/TP only ` +
      'until those expire (28 days after they were placed; the bot neither renews nor resizes them). Positions left there: ETHUSDT -0.3000.'
    );
    const reads = fake.routed.filter(entry => new URL(entry.request.url).pathname === '/api/v1/account');
    expect(reads.map(entry => `${entry.side}:${new URL(entry.request.url).searchParams.get('value')}`)).toEqual([`SHORT:${SHORT_ACCOUNT}`]);

    fake.short.setPosition(ETH, '0');
    expect(await lighterUnmanagedShortAccountWarning(oneWay)).toMatch(/expire \(28 days .*\)\. It holds no open positions\.$/);
    // An incomplete short account cannot be read: the warning still explains the expiry
    const incomplete = hedgeConfig({ global: { paperMode: true }, shortAccount: { apiKeyPrivateKey: undefined, apiKeyPublicKey: undefined } });
    expect(await lighterUnmanagedShortAccountWarning(incomplete)).toMatch(/neither renews nor resizes them\)\. Its positions could not be read \(.+\)\.$/);
    expect(await lighterUnmanagedShortAccountWarning(hedgeConfig({ hedge: undefined }))).toBeNull();
    expect(postRequests()).toBe(0);
  });

  it('isLighterVenueAdapter: either Lighter trading adapter, nothing else', () => {
    expect(isLighterVenueAdapter(createExchangeAdapter(hedgeConfig()))).toBe(true);
    expect(isLighterVenueAdapter(createExchangeAdapter(hedgeConfig({ hedge: undefined })))).toBe(true);
    expect(isLighterVenueAdapter(new AsterAdapter({ apiKey: '', secretKey: '' }))).toBe(false);
    expect(isLighterVenueAdapter({ id: 'lighter' })).toBe(false);
    expect(isLighterVenueAdapter(null)).toBe(false);
  });
});

describe('dashboard routes', () => {
  let fake: FakeLighterHedgeExchange;
  const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;
  // The balance route's rate limit manager starts intervals it never clears; stop them so jest can exit
  const intervals: Array<ReturnType<typeof setInterval>> = [];
  const realSetInterval = global.setInterval;

  beforeEach(() => {
    jest.spyOn(global, 'setInterval').mockImplementation(((...args: Parameters<typeof setInterval>) => {
      const handle = realSetInterval(...args);
      intervals.push(handle);
      return handle;
    }) as typeof setInterval);
    resetLighterRuntime();
    fake = new FakeLighterHedgeExchange(() => Date.now());
    configureLighterRuntime({ transport: fake.transport });
    fake.long.setPosition(ETH, '0.5000', { avg_entry_price: '4050.00' });
    fake.short.setPosition(ETH, '-0.3000', { avg_entry_price: '4100.00' });
    fake.short.account.available_balance = '500.000000';
  });

  afterEach(() => {
    resetLighterRuntime();
    resetRateLimitManager();
    intervals.splice(0).forEach(handle => clearInterval(handle));
  });

  async function getJson(route: { GET: (request: any) => Promise<Response> }, url: string): Promise<{ status: number; body: any }> {
    const { NextRequest } = await import('next/server');
    const response = await route.GET(new NextRequest(url));
    return { status: response.status, body: await response.json() };
  }

  it('/api/positions lists both hedge accounts with their positionSide', async () => {
    mockLoadConfig.mockResolvedValue(hedgeConfig() as any);
    const route = await import('../../../src/app/api/positions/route');
    const { status, body } = await getJson(route, 'http://localhost/api/positions?force=true');
    expect(status).toBe(200);
    expect(body.map((row: any) => [row.symbol, row.side, row.quantity, row.positionSide])).toEqual([
      ['ETHUSDT', 'LONG', 0.5, 'LONG'],
      ['ETHUSDT', 'SHORT', 0.3, 'SHORT'],
    ]);
    expect(postCount(fake)).toBe(0);
  });

  it('/api/positions rows of Aster keep exactly their old fields', async () => {
    const aster = {
      id: 'aster',
      capabilities: { marginAsset: 'USDT' },
      hasCredentials: () => true,
      getPositions: async () => [{
        symbol: 'BTCUSDT', positionAmt: '0.01', entryPrice: '50000', markPrice: '51000', unRealizedProfit: '10',
        leverage: '5', liquidationPrice: '40000', positionSide: 'BOTH',
      }],
      getOpenOrders: async () => [],
    };
    const spy = jest.spyOn(registry, 'createExchangeAdapter').mockReturnValue(aster as any);
    mockLoadConfig.mockResolvedValue(hedgeConfig({ global: { exchange: 'aster' } }) as any);
    const route = await import('../../../src/app/api/positions/route');
    const { body } = await getJson(route, 'http://localhost/api/positions?force=true');
    expect(spy).toHaveBeenCalled();
    expect(Object.keys(body[0])).toEqual([
      'symbol', 'side', 'quantity', 'entryPrice', 'markPrice', 'pnl', 'pnlPercent', 'margin', 'leverage',
      'liquidationPrice', 'hasStopLoss', 'hasTakeProfit',
    ]);
  });

  it('/api/balance (REST) adds each hedge account to the combined totals', async () => {
    mockLoadConfig.mockResolvedValue(hedgeConfig() as any);
    const route = await import('../../../src/app/api/balance/route');
    const { status, body } = await getJson(route, 'http://localhost/api/balance?force=true');
    expect(status).toBe(200);
    expect(body.source).toBe('rest-account');
    expect(body.availableBalance).toBe(1300);
    expect(body.accounts).toEqual({
      long: { accountIndex: TEST_ACCOUNT, totalBalance: expect.any(Number), availableBalance: 800, totalPnL: expect.any(Number) },
      short: { accountIndex: SHORT_ACCOUNT, totalBalance: expect.any(Number), availableBalance: 500, totalPnL: expect.any(Number) },
    });
  });

  it('/api/balance (REST) for one-way Lighter has no per-account entries', async () => {
    mockLoadConfig.mockResolvedValue(hedgeConfig({ hedge: undefined }) as any);
    const route = await import('../../../src/app/api/balance/route');
    const { body } = await getJson(route, 'http://localhost/api/balance?force=true');
    expect(body.source).toBe('rest-account');
    expect(body.availableBalance).toBe(800);
    expect('accounts' in body).toBe(false);
  });
});

function postCount(fake: FakeLighterHedgeExchange): number {
  return fake.routed.filter(entry => entry.request.method === 'POST').length;
}
