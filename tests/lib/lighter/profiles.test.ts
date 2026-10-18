/**
 * @jest-environment node
 */
import {
  DEFAULT_LIGHTER_PROFILE,
  LIGHTER_PROFILE_NAMES,
  PROFILES,
  getProfile,
  isLighterProfileName,
  lighterRestUrl,
  lighterStreamUrl,
} from '../../../src/lib/exchange/lighter/profiles';

describe('Lighter profiles (spec §1.1)', () => {
  it('match lighter-python lighter/endpoint_profiles.py', () => {
    expect(PROFILES.mainnet).toMatchObject({ apiUrl: 'https://mainnet.zklighter.elliot.ai', wsUrl: 'wss://mainnet.zklighter.elliot.ai/stream', chainId: 304, testnet: false, gated: false });
    expect(PROFILES.testnet).toMatchObject({ apiUrl: 'https://testnet.zklighter.elliot.ai', wsUrl: 'wss://testnet.zklighter.elliot.ai/stream', chainId: 300, testnet: true, gated: false });
    expect(PROFILES.robinhood).toMatchObject({ apiUrl: 'https://api.rh.lighter.xyz', wsUrl: 'wss://api.rh.lighter.xyz/stream', chainId: 466324, testnet: false, gated: true });
    expect(PROFILES.robinhood_testnet).toMatchObject({ apiUrl: 'https://api.rh-testnet.lighter.xyz', wsUrl: 'wss://api.rh-testnet.lighter.xyz/stream', chainId: 300, testnet: true, gated: true });
    expect(Object.keys(PROFILES).sort()).toEqual([...LIGHTER_PROFILE_NAMES].sort());
    for (const name of LIGHTER_PROFILE_NAMES) expect(PROFILES[name].name).toBe(name);
  });

  it('cannot be modified at runtime', () => {
    expect(Object.isFrozen(PROFILES)).toBe(true);
    expect(Object.isFrozen(PROFILES.mainnet)).toBe(true);
    expect(() => { (PROFILES.mainnet as { chainId: number }).chainId = 300; }).toThrow(TypeError);
  });

  it('defaults to testnet', () => {
    expect(DEFAULT_LIGHTER_PROFILE).toBe('testnet');
  });

  it('looks profiles up by name only', () => {
    expect(getProfile('mainnet')).toBe(PROFILES.mainnet);
    expect(getProfile('testnet')).toBe(PROFILES.testnet);
    expect(() => getProfile('https://mainnet.zklighter.elliot.ai')).toThrow(/Unknown Lighter profile/);
    expect(() => getProfile('Mainnet')).toThrow(/Unknown Lighter profile/);
    expect(() => getProfile('constructor')).toThrow(/Unknown Lighter profile/);
    expect(isLighterProfileName('robinhood')).toBe(true);
    expect(isLighterProfileName('toString')).toBe(false);
    expect(isLighterProfileName(304)).toBe(false);
  });

  it('refuses the gated Robinhood profiles unless explicitly allowed', () => {
    expect(() => getProfile('robinhood')).toThrow(/disabled/);
    expect(() => getProfile('robinhood_testnet')).toThrow(/disabled/);
    expect(getProfile('robinhood', { allowGated: true })).toBe(PROFILES.robinhood);
  });

  it('builds stream and REST URLs on the profile host', () => {
    expect(lighterStreamUrl(PROFILES.mainnet)).toBe('wss://mainnet.zklighter.elliot.ai/stream?readonly=true&encoding=json');
    expect(lighterRestUrl(PROFILES.testnet, '/api/v1/orderBookDetails', { filter: 'perp' }))
      .toBe('https://testnet.zklighter.elliot.ai/api/v1/orderBookDetails?filter=perp');
    expect(lighterRestUrl(PROFILES.testnet, 'api/v1/nextNonce', { account_index: 12345, api_key_index: 3, skip: undefined }))
      .toBe('https://testnet.zklighter.elliot.ai/api/v1/nextNonce?account_index=12345&api_key_index=3');
    expect(lighterRestUrl(PROFILES.mainnet, '/api/v1/accountOrders', { client_order_indexes: '1,2' }))
      .toBe('https://mainnet.zklighter.elliot.ai/api/v1/accountOrders?client_order_indexes=1%2C2');
    expect(lighterRestUrl(PROFILES.mainnet, '/')).toBe('https://mainnet.zklighter.elliot.ai/');
  });
});
