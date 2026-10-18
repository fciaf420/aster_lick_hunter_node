import {
  buildInitialConfig,
  collectErrors,
  describePath,
  firstInvalid,
  getDefaultSymbolConfig,
  hedgePositionModeAvailable,
  lighterHedgeConfigured,
  tabForPath,
} from '@/components/config-form/form-state';
import type { Config } from '@/lib/types';

describe('buildInitialConfig', () => {
  it('starts from the given config without changing it', () => {
    const given = { symbols: { BTCUSDT: getDefaultSymbolConfig() } } as unknown as Config;
    const copy = JSON.parse(JSON.stringify(given));
    const initial = buildInitialConfig(given);
    expect(given).toEqual(copy);
    expect(initial.symbols).toBe(given.symbols);
    // The parts a config always has are filled in
    expect(initial.api).toEqual({ apiKey: '', secretKey: '' });
    expect(initial.global).toMatchObject({ paperMode: true, exchange: 'aster', positionMode: 'HEDGE', server: { dashboardPassword: '', dashboardPort: 3000 } });
  });

  it('keeps what the given config has', () => {
    const given: Config = {
      api: { apiKey: 'FAKE', secretKey: 'FAKE' },
      symbols: {},
      global: { riskPercent: 9, paperMode: false },
      version: '9.9.9',
    };
    expect(buildInitialConfig(given)).toEqual(given);
  });

  it('falls back to the default config, with the default dashboard password', () => {
    const initial = buildInitialConfig();
    expect(initial.symbols).toEqual({});
    expect(initial.global.server?.dashboardPassword).toBe('admin');
    expect(initial.version).toBe('1.2.0');
  });
});

describe('finding the first invalid field', () => {
  const leaf = (message: string) => ({ type: 'custom', message, ref: { name: 'not looked into', error: { type: 'x', message: 'x' } } });

  it('lists the invalid fields in the order they were reported, without looking into refs', () => {
    const errors = {
      symbols: { BTCUSDT: { leverage: leaf('Required'), tpPercent: leaf('Must be at least 0.1') } },
      global: { riskPercent: leaf('Must be at most 100') },
    };
    expect(collectErrors(errors)).toEqual([
      { path: 'symbols.BTCUSDT.leverage', message: 'Required' },
      { path: 'symbols.BTCUSDT.tpPercent', message: 'Must be at least 0.1' },
      { path: 'global.riskPercent', message: 'Must be at most 100' },
    ]);
    expect(collectErrors({})).toEqual([]);
    expect(collectErrors(undefined)).toEqual([]);
  });

  it('puts the tabs in order, then the order of the report', () => {
    const errors = {
      symbols: { ETHUSDT: { leverage: leaf('Required') } },
      global: { riskPercent: leaf('Required') },
      venues: { lighter: { accountIndex: leaf('Must be 1-5') } },
    };
    expect(firstInvalid(errors)).toMatchObject({ path: 'venues.lighter.accountIndex', tab: 'api' });
    expect(firstInvalid({ symbols: errors.symbols, global: errors.global })).toMatchObject({ path: 'global.riskPercent', tab: 'global' });
    expect(firstInvalid({ symbols: errors.symbols })).toEqual({ path: 'symbols.ETHUSDT.leverage', message: 'Required', tab: 'symbols', symbol: 'ETHUSDT' });
    expect(firstInvalid({})).toBeUndefined();
  });

  it('finds the tab of a field', () => {
    expect(tabForPath('api.apiKey')).toBe('api');
    expect(tabForPath('venues.lighter.hedge.shortAccount.accountIndex')).toBe('api');
    expect(tabForPath('global.exchange')).toBe('api');
    expect(tabForPath('global.liquidationSource')).toBe('api');
    expect(tabForPath('global.paperMode')).toBe('global');
    expect(tabForPath('global.server.dashboardPort')).toBe('global');
    expect(tabForPath('symbols.BTCUSDT.tpPercent')).toBe('symbols');
  });

  it('names a field without its value', () => {
    expect(describePath('symbols.BTCUSDT.tpPercent')).toBe('BTCUSDT tp percent');
    expect(describePath('global.riskPercent')).toBe('risk percent');
    expect(describePath('global.server.dashboardPassword')).toBe('dashboard password');
    expect(describePath('api.secretKey')).toBe('secret key');
  });
});

describe('hedge position mode availability', () => {
  const complete = { accountIndex: 1, hedge: { enabled: true, shortAccount: { accountIndex: 2, apiKeyIndex: 3, apiKeyPrivateKey: 'a', apiKeyPublicKey: 'b' } } };

  it('is native on Aster and needs a complete short account on Lighter', () => {
    expect(hedgePositionModeAvailable({ global: { exchange: 'aster' } })).toBe(true);
    expect(hedgePositionModeAvailable({})).toBe(true);
    expect(hedgePositionModeAvailable({ global: { exchange: 'lighter' } })).toBe(false);
    expect(hedgePositionModeAvailable({ global: { exchange: 'lighter' }, venues: { lighter: complete } })).toBe(true);
    expect(lighterHedgeConfigured({ global: { exchange: 'aster' }, venues: { lighter: complete } })).toBe(false);
  });

  it('treats cleared fields (null) as missing', () => {
    const cleared = { ...complete, hedge: { ...complete.hedge, shortAccount: { ...complete.hedge.shortAccount, apiKeyPublicKey: null } } };
    expect(lighterHedgeConfigured({ global: { exchange: 'lighter' }, venues: { lighter: cleared as never } })).toBe(false);
  });
});
