import {
  DASHBOARD_PASSWORD_MESSAGE,
  configFormSchema,
  createConfigResolver,
  inlineMessage,
  lighterSettingsFormSchema,
  lighterSettingsValid,
  withoutClearedFields,
} from '@/lib/config/form';
import { liveModeProblem } from '@/lib/config/liveMode';
import { DEFAULT_CONFIG } from '@/lib/config/defaults';
import {
  LIGHTER_HEDGE_SAME_ACCOUNT_MESSAGE,
  LIGHTER_MAX_ACCOUNT_INDEX,
  LIGHTER_MAX_API_KEY_INDEX,
  configSchema,
} from '@/lib/config/types';

// The config form's schema is the server's schema (configSchema) with a few derived differences: these tests pin
// that it accepts and refuses what the server does, and what the differences are.

const PRIVATE_KEY = 'a1'.repeat(40);
const PUBLIC_KEY = 'b2'.repeat(40);

function config(change: (draft: any) => void = () => {}): any {
  const draft = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  change(draft);
  return draft;
}

const paths = (result: { success: boolean; error?: { issues: { path: (string | number)[] }[] } }) =>
  result.success ? [] : result.error!.issues.map((issue) => issue.path.join('.'));

describe('configFormSchema', () => {
  it('accepts the default config, like the server', () => {
    expect(configSchema.safeParse(config()).success).toBe(true);
    expect(configFormSchema.safeParse(config()).success).toBe(true);
  });

  it.each([
    ['a leverage above 125', (c: any) => { c.symbols.BTCUSDT.leverage = 126; }],
    ['a leverage of 0', (c: any) => { c.symbols.BTCUSDT.leverage = 0; }],
    ['a negative take profit', (c: any) => { c.symbols.BTCUSDT.tpPercent = -1; }],
    ['a stop loss below 0.1', (c: any) => { c.symbols.BTCUSDT.slPercent = 0.05; }],
    ['a trade size of 0', (c: any) => { c.symbols.BTCUSDT.tradeSize = 0; }],
    ['a VWAP lookback of 9', (c: any) => { c.symbols.BTCUSDT.vwapLookback = 9; }],
    ['a risk percentage above 100', (c: any) => { c.global.riskPercent = 101; }],
    ['an unknown order type', (c: any) => { c.symbols.BTCUSDT.orderType = 'STOP'; }],
    ['a missing take profit', (c: any) => { delete c.symbols.BTCUSDT.tpPercent; }],
    ['a Lighter account index of 0', (c: any) => { c.venues.lighter.accountIndex = 0; }],
    ['a Lighter API key index of 255', (c: any) => { c.venues.lighter.apiKeyIndex = 255; }],
    ['a Lighter key that is not hex', (c: any) => { c.venues.lighter.apiKeyPrivateKey = 'nothex'; }],
    ['a short account on the main account index', (c: any) => {
      c.venues.lighter.accountIndex = 7;
      c.venues.lighter.hedge = { enabled: true, shortAccount: { accountIndex: 7 } };
    }],
  ])('refuses %s, at the same field as the server', (_name, change) => {
    const input = config(change);
    const server = configSchema.safeParse(input);
    const form = configFormSchema.safeParse(input);
    expect(server.success).toBe(false);
    expect(form.success).toBe(false);
    expect(paths(form)).toEqual(paths(server));
  });

  it.each([
    ['a Lighter config with nothing filled in', (c: any) => { c.venues.lighter = {}; }],
    ['empty Lighter strings, as hand-edited files have them', (c: any) => {
      c.venues.lighter = { accountIndex: '', apiKeyIndex: ' ', apiKeyPrivateKey: '', apiKeyPublicKey: '  ' };
    }],
    ['Lighter indexes written as digit strings', (c: any) => { c.venues.lighter = { accountIndex: '12345', apiKeyIndex: '3' }; }],
    ['an incomplete short account', (c: any) => {
      c.venues.lighter = { accountIndex: 12345, hedge: { enabled: true, shortAccount: { accountIndex: 23456 } } };
    }],
    ['hedge enabled without a short account', (c: any) => { c.venues.lighter = { hedge: { enabled: true } }; }],
    ['the legacy volume threshold alone', (c: any) => {
      delete c.symbols.BTCUSDT.longVolumeThresholdUSDT;
      delete c.symbols.BTCUSDT.shortVolumeThresholdUSDT;
      c.symbols.BTCUSDT.volumeThresholdUSDT = 5000;
    }],
    ['optional symbol settings left out', (c: any) => {
      for (const key of ['maxPositionMarginUSDT', 'priceOffsetBps', 'maxSlippageBps', 'orderType', 'vwapProtection', 'vwapTimeframe', 'vwapLookback']) {
        delete c.symbols.BTCUSDT[key];
      }
    }],
    ['optional global settings left out', (c: any) => {
      delete c.global.maxOpenPositions;
      delete c.global.liquidationRetentionDays;
      delete c.global.server.dashboardPort;
      delete c.global.server.websocketPort;
    }],
    ['no symbols', (c: any) => { c.symbols = {}; }],
    ['ports the old form never accepted', (c: any) => { c.global.server.dashboardPort = 80; c.global.server.websocketPort = 70000; }],
  ])('accepts %s, like the server', (_name, change) => {
    const input = config(change);
    expect(configSchema.safeParse(input).success).toBe(true);
    expect(configFormSchema.safeParse(input).success).toBe(true);
  });

  it('only differs from the server on the dashboard password and where a missing volume threshold is reported', () => {
    const short = config((c) => { c.global.server.dashboardPassword = 'abc'; });
    expect(configSchema.safeParse(short).success).toBe(true);
    const form = configFormSchema.safeParse(short);
    expect(paths(form)).toEqual(['global.server.dashboardPassword']);
    expect(form.success ? '' : form.error.issues[0].message).toBe(DASHBOARD_PASSWORD_MESSAGE);

    for (const password of ['', 'abcd', 'a longer password']) {
      expect(configFormSchema.safeParse(config((c) => { c.global.server.dashboardPassword = password; })).success).toBe(true);
    }

    // The server reports one error on the symbol; the form puts it on the field that is missing
    const noThresholds = config((c) => {
      delete c.symbols.BTCUSDT.longVolumeThresholdUSDT;
      delete c.symbols.BTCUSDT.shortVolumeThresholdUSDT;
    });
    expect(paths(configSchema.safeParse(noThresholds))).toEqual(['symbols.BTCUSDT']);
    expect(paths(configFormSchema.safeParse(noThresholds))).toEqual([
      'symbols.BTCUSDT.longVolumeThresholdUSDT',
      'symbols.BTCUSDT.shortVolumeThresholdUSDT',
    ]);
  });

  it('keeps the server schema as it was: the same symbol rules, with the refinement', () => {
    const noThresholds = config((c) => {
      delete c.symbols.BTCUSDT.longVolumeThresholdUSDT;
      delete c.symbols.BTCUSDT.shortVolumeThresholdUSDT;
    });
    const result = configSchema.safeParse(noThresholds);
    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues[0].message).toBe(
      'Either volumeThresholdUSDT or both longVolumeThresholdUSDT and shortVolumeThresholdUSDT must be provided'
    );
  });
});

describe('configFormSchema: live Lighter hedge mode', () => {
  const shortPath = (field: string) => `venues.lighter.hedge.shortAccount.${field}`;

  // Lighter, live, hedge position mode and hedge mode on, with the short account as given
  const hedge = (shortAccount: unknown, change: (c: any) => void = () => {}) => config((c) => {
    c.global = { ...c.global, paperMode: false, exchange: 'lighter', positionMode: 'HEDGE' };
    c.venues.lighter = { ...c.venues.lighter, accountIndex: 12345, apiKeyIndex: 3, apiKeyPrivateKey: PRIVATE_KEY, apiKeyPublicKey: PUBLIC_KEY, hedge: { enabled: true, shortAccount } };
    change(c);
  });

  it('marks every missing short account field with Required, in the order of the fields', () => {
    const result = configFormSchema.safeParse(hedge({ accountIndex: 23456 }));
    expect(paths(result)).toEqual([shortPath('apiKeyIndex'), shortPath('apiKeyPrivateKey'), shortPath('apiKeyPublicKey')]);
    expect(!result.success && result.error.issues.map((issue) => issue.message)).toEqual(['Required', 'Required', 'Required']);

    expect(paths(configFormSchema.safeParse(hedge(undefined)))).toEqual([
      shortPath('accountIndex'), shortPath('apiKeyIndex'), shortPath('apiKeyPrivateKey'), shortPath('apiKeyPublicKey'),
    ]);
    // Empty text is a missing value, as it is for the server
    expect(paths(configFormSchema.safeParse(hedge({ accountIndex: 23456, apiKeyIndex: 4, apiKeyPrivateKey: '', apiKeyPublicKey: '  ' }))))
      .toEqual([shortPath('apiKeyPrivateKey'), shortPath('apiKeyPublicKey')]);
  });

  it('is what the server refuses on load and on save, field by field', () => {
    const complete = { accountIndex: 23456, apiKeyIndex: 4, apiKeyPrivateKey: 'c3'.repeat(40), apiKeyPublicKey: 'd4'.repeat(40) };
    const cases: [string, any][] = [
      ['a complete short account', hedge(complete)],
      ['half a short account', hedge({ accountIndex: 23456 })],
      ['no short account', hedge(undefined)],
      ['half a short account in paper mode', hedge({ accountIndex: 23456 }, (c) => { c.global.paperMode = true; })],
      ['half a short account in one-way mode', hedge({ accountIndex: 23456 }, (c) => { c.global.positionMode = 'ONE_WAY'; })],
      ['half a short account with hedge mode off', hedge({ accountIndex: 23456 }, (c) => { c.venues.lighter.hedge.enabled = false; })],
      ['half a short account on Aster', hedge({ accountIndex: 23456 }, (c) => { c.global.exchange = 'aster'; c.api = { apiKey: 'k'.repeat(64), secretKey: 's'.repeat(64) }; })],
    ];
    for (const [name, input] of cases) {
      // The schema of the server takes all of them (what it refuses is liveModeProblem's); the form must refuse
      // exactly the ones that liveModeProblem does
      expect([name, configSchema.safeParse(input).success]).toEqual([name, true]);
      const problem = liveModeProblem(configSchema.parse(input));
      expect([name, configFormSchema.safeParse(input).success]).toEqual([name, problem === undefined]);
    }
  });

  it('leaves missing main credentials to the server', () => {
    // liveModeProblem refuses a live config without them; the form shows its notice and the server answers on Save
    const noMain = hedge({ accountIndex: 23456, apiKeyIndex: 4, apiKeyPrivateKey: 'c3'.repeat(40), apiKeyPublicKey: 'd4'.repeat(40) }, (c) => {
      delete c.venues.lighter.apiKeyPublicKey;
    });
    expect(liveModeProblem(configSchema.parse(noMain))).toContain('API public key is missing');
    expect(configFormSchema.safeParse(noMain).success).toBe(true);
  });

  it('reports the same index once, and keeps the schema message for it', () => {
    const result = configFormSchema.safeParse(hedge({ accountIndex: 12345 }));
    expect(paths(result)).toEqual([shortPath('accountIndex'), shortPath('apiKeyIndex'), shortPath('apiKeyPrivateKey'), shortPath('apiKeyPublicKey')]);
    expect(!result.success && result.error.issues[0].message).toBe(LIGHTER_HEDGE_SAME_ACCOUNT_MESSAGE);
  });

  it('is checked after the fields that failed to parse', () => {
    // zod does not refine a value that failed to parse: the marks follow once the leverage is back
    const input = hedge({ accountIndex: 23456 }, (c) => { delete c.symbols.BTCUSDT.leverage; });
    expect(paths(configFormSchema.safeParse(input))).toEqual(['symbols.BTCUSDT.leverage']);
    expect(paths(configFormSchema.safeParse({ ...input, symbols: config().symbols }))).toContain(shortPath('apiKeyIndex'));
  });

  it('never repeats a key in an issue', () => {
    const result = configFormSchema.safeParse(hedge({ accountIndex: 23456, apiKeyPrivateKey: 'c3'.repeat(40) }));
    expect(JSON.stringify(!result.success && result.error.issues)).not.toContain('c3c3');
  });
});

describe('lighterSettingsValid', () => {
  it('says whether Lighter settings held outside a form can be saved', () => {
    expect(lighterSettingsValid({})).toBe(true);
    expect(lighterSettingsValid({ accountIndex: 12345, apiKeyIndex: 3, apiKeyPrivateKey: PRIVATE_KEY, apiKeyPublicKey: PUBLIC_KEY })).toBe(true);
    expect(lighterSettingsValid({ accountIndex: '12.5' as unknown as number })).toBe(false);
    expect(lighterSettingsValid({ sltpSlippagePct: 0 })).toBe(false);
    expect(lighterSettingsValid({ sendTxPerMin: 4001 })).toBe(false);
    expect(lighterSettingsValid({ apiKeyPrivateKey: 'nothex' })).toBe(false);
  });
});

describe('lighterSettingsFormSchema', () => {
  it('holds the venues.lighter rules only', () => {
    expect(lighterSettingsFormSchema.safeParse({ venues: { lighter: { accountIndex: 5 } } }).success).toBe(true);
    expect(paths(lighterSettingsFormSchema.safeParse({ venues: { lighter: { accountIndex: 0 } } }))).toEqual(['venues.lighter.accountIndex']);
    expect(lighterSettingsFormSchema.safeParse({}).success).toBe(true);
  });
});

describe('withoutClearedFields', () => {
  it('drops cleared fields (null), except where null is a value of the config', () => {
    const values = { global: { riskPercent: 5, maxOpenPositions: null, server: { websocketHost: null, dashboardPort: null } }, api: { apiKey: '' } };
    expect(withoutClearedFields(values)).toEqual({ global: { riskPercent: 5, server: { websocketHost: null } }, api: { apiKey: '' } });
  });

  it('drops the undefined entries that registering a field leaves', () => {
    const kept = withoutClearedFields({ a: 1, b: undefined });
    expect(Object.keys(kept)).toEqual(['a']);
  });

  it('drops objects that only held cleared fields, unless they were in the loaded config', () => {
    const values = {
      venues: { lighter: { profile: 'testnet', hedge: { enabled: undefined, shortAccount: { accountIndex: undefined, apiKeyIndex: null } } } },
      symbols: { BTCUSDT: { extra: { nothing: null } } },
    };
    expect(withoutClearedFields(values)).toEqual({ venues: { lighter: { profile: 'testnet' } } });

    // The loaded config had a hedge object and a (cleared) extra object: they stay, empty
    const loaded = { venues: { lighter: { hedge: { enabled: true } } }, symbols: { BTCUSDT: { extra: {} } } };
    expect(withoutClearedFields(values, loaded)).toEqual({
      venues: { lighter: { profile: 'testnet', hedge: {} } },
      symbols: { BTCUSDT: { extra: {} } },
    });
  });

  it('keeps empty strings, zero and false', () => {
    const values = { api: { apiKey: '' }, global: { paperMode: false, liquidationRetentionDays: 0 } };
    expect(withoutClearedFields(values)).toEqual(values);
  });

  it('does not change what it is given', () => {
    const values = { a: { b: null, c: 1 } };
    const copy = JSON.parse(JSON.stringify(values));
    withoutClearedFields(values);
    expect(values).toEqual(copy);
  });
});

describe('createConfigResolver', () => {
  const options: any = { fields: {}, shouldUseNativeValidation: false, criteriaMode: 'firstError', names: [] };
  const resolve = (values: unknown, loaded?: unknown) => createConfigResolver<any>(configFormSchema, loaded)(values as any, undefined, options);

  it('hands the values back as typed, without cleared fields', async () => {
    const values = config((c) => {
      c.global.maxOpenPositions = null;
      c.venues.lighter.accountIndex = '  12345 ';   // Would parse to a number; the form keeps what was typed
    });
    const result = await resolve(values);
    expect(result.errors).toEqual({});
    expect(result.values.global).not.toHaveProperty('maxOpenPositions');
    expect(result.values.venues.lighter.accountIndex).toBe('  12345 ');
    expect(result.values.symbols).toEqual(values.symbols);
  });

  it('treats a cleared optional field as unset and a cleared required field as missing', async () => {
    const result = await resolve(config((c) => { c.symbols.BTCUSDT.maxPositionMarginUSDT = null; c.symbols.BTCUSDT.leverage = null; }));
    expect(Object.keys(result.errors)).toEqual(['symbols']);
    expect(result.errors.symbols.BTCUSDT.leverage).toMatchObject({ type: 'invalid_type', message: 'Required' });
    expect(result.errors.symbols.BTCUSDT).not.toHaveProperty('maxPositionMarginUSDT');
  });

  it('words the errors for the page', async () => {
    const result = await resolve(config((c) => {
      c.symbols.BTCUSDT.leverage = 200;
      c.symbols.BTCUSDT.tpPercent = 0;
      c.symbols.BTCUSDT.tradeSize = 'abc';
      c.global.exchange = 'nowhere';
      c.global.server.dashboardPassword = 'abc';
    }));
    const messages = (result.errors as any);
    expect(messages.symbols.BTCUSDT.leverage.message).toBe('Must be at most 125');
    expect(messages.symbols.BTCUSDT.tpPercent.message).toBe('Must be at least 0.1');
    expect(messages.symbols.BTCUSDT.tradeSize.message).toBe('Enter a number');
    expect(messages.global.exchange.message).toBe('Choose one of: aster, hyperliquid, lighter, phoenix, bulk');
    expect(messages.global.server.dashboardPassword.message).toBe('Password must be at least 4 characters');
  });

  it('puts the missing volume thresholds on their fields', async () => {
    const result = await resolve(config((c) => { delete c.symbols.BTCUSDT.shortVolumeThresholdUSDT; }));
    expect((result.errors as any).symbols.BTCUSDT.shortVolumeThresholdUSDT.message).toBe('Required');
    expect((result.errors as any).symbols.BTCUSDT).not.toHaveProperty('longVolumeThresholdUSDT');
  });

  describe('Lighter fields', () => {
    const lighter = (settings: unknown) => resolve({ venues: { lighter: settings } });
    const errorsOf = async (settings: unknown) => ((await lighter(settings)).errors as any).venues?.lighter ?? {};

    it('returns no errors for an empty or valid short account', async () => {
      expect(await errorsOf({})).toEqual({});
      expect(await errorsOf({ accountIndex: 12345, apiKeyIndex: 3, apiKeyPrivateKey: PRIVATE_KEY, apiKeyPublicKey: PUBLIC_KEY })).toEqual({});
      expect(await errorsOf({
        accountIndex: 12345,
        hedge: { enabled: true, shortAccount: { accountIndex: 23456, apiKeyIndex: 4, apiKeyPrivateKey: `0x${PRIVATE_KEY}`, apiKeyPublicKey: PUBLIC_KEY } },
      })).toEqual({});
    });

    it('names each bad field without echoing the keys', async () => {
      const errors = await errorsOf({
        accountIndex: 7,
        hedge: { shortAccount: { accountIndex: 7, apiKeyIndex: 300, apiKeyPrivateKey: 'secret-ish', apiKeyPublicKey: '0x12' } },
      });
      const messages = Object.fromEntries(Object.entries(errors.hedge.shortAccount).map(([field, error]: [string, any]) => [field, error.message]));
      expect(messages).toEqual({
        accountIndex: 'Must differ from the main (long) account index',
        apiKeyIndex: `Must be 0-${LIGHTER_MAX_API_KEY_INDEX}`,
        apiKeyPrivateKey: 'Expected 40 bytes of hex (80 characters)',
        apiKeyPublicKey: 'Expected 40 bytes of hex (80 characters)',
      });
      expect(JSON.stringify(errors, (key, value) => (key === 'ref' ? undefined : value))).not.toContain('secret-ish');
    });

    it('checks the account index range before the main-account comparison', async () => {
      const indexError = async (accountIndex: unknown) =>
        (await errorsOf({ hedge: { shortAccount: { accountIndex } } })).hedge?.shortAccount?.accountIndex?.message;
      expect(await indexError(0)).toBe(`Must be 1-${LIGHTER_MAX_ACCOUNT_INDEX}`);
      expect(await indexError(LIGHTER_MAX_ACCOUNT_INDEX + 1)).toBe(`Must be 1-${LIGHTER_MAX_ACCOUNT_INDEX}`);
      expect(await indexError(LIGHTER_MAX_ACCOUNT_INDEX)).toBeUndefined();
      expect(await indexError('12.5')).toBe(`Must be 1-${LIGHTER_MAX_ACCOUNT_INDEX}`);
      expect((await errorsOf({ hedge: { shortAccount: { apiKeyIndex: 0 } } }))).toEqual({});
    });

    it('does not repeat a malformed key in any error', async () => {
      const result = await lighter({ apiKeyPrivateKey: 'TOP-SECRET-not-hex', apiKeyPublicKey: 12345 });
      const serialized = JSON.stringify(result.errors, (key, value) => (key === 'ref' ? undefined : value));
      expect(serialized).not.toContain('TOP-SECRET');
      expect(serialized).toContain('Expected 40 bytes of hex');
    });
  });
});

describe('inlineMessage', () => {
  it('starts schema fragments with a capital and leaves other messages alone', () => {
    expect(inlineMessage('must differ from the main (long) account index')).toBe('Must differ from the main (long) account index');
    expect(inlineMessage('Required')).toBe('Required');
  });
});
