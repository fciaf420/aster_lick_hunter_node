/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';
import {
  LIGHTER_MARKET_MAX_STALE_MS,
  LIGHTER_MARKET_REFRESH_MS,
  LighterMarketCache,
  LighterMarketError,
  isOpenInterestCapped,
  leverageToImf,
  parseMarket,
  parseOrderBookDetails,
  type LighterMarket,
  type LighterMarketCacheOptions,
} from '../../../src/lib/exchange/lighter/markets';
import { PROFILES } from '../../../src/lib/exchange/lighter/profiles';
import type { LighterSymbolMapOptions } from '../../../src/lib/exchange/lighter/symbols';

// Subset of lighter-ts src/fallbacks/orderBookMetas.json (see the fixture's _source)
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'orderBookDetails.perp.json'), 'utf8'));

type RawMarket = Record<string, any>;
const fixture = (): { code: number; order_book_details: RawMarket[]; spot_order_book_details: unknown[] } =>
  JSON.parse(JSON.stringify(FIXTURE));
const raw = (symbol: string): RawMarket => {
  const market = fixture().order_book_details.find(item => item.symbol === symbol);
  if (!market) throw new Error(`fixture has no ${symbol}`);
  return market;
};
const response = (...markets: RawMarket[]) => ({ code: 200, order_book_details: markets, spot_order_book_details: [] });

const ALLOWLIST = ['BTCUSDT', 'ETHUSDT', 'DOGEUSDT', '1000PEPEUSDT', 'XRPUSDT', 'BNBUSDT'];
const START = Date.UTC(2026, 9, 18, 12, 0, 0);

function setup(options: Partial<LighterMarketCacheOptions> & { bodies?: unknown[] } = {}) {
  let now = START;
  const bodies = options.bodies ?? [fixture()];
  let call = 0;
  const httpGet = jest.fn(async (_url: string) => {
    const body = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    if (body instanceof Error) throw body;
    return body;
  });
  const cache = new LighterMarketCache({
    profile: 'testnet',
    symbols: { allowlist: ALLOWLIST },
    httpGet,
    now: () => now,
    ...options,
  });
  return { cache, httpGet, advance: (ms: number) => { now += ms; } };
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof LighterMarketError ? error.code : `not a LighterMarketError: ${String(error)}`;
  }
  return undefined;
}

function parsed(market: RawMarket): LighterMarket {
  const result = parseMarket(market);
  if (!('market' in result)) throw new Error(`rejected: ${result.rejection.reasons.join('; ')}`);
  return result.market;
}

function rejectionReasons(market: unknown): string[] {
  const result = parseMarket(market);
  return 'rejection' in result ? result.rejection.reasons : [];
}

describe('parseMarket', () => {
  it('normalizes a perp from the official metadata', () => {
    const btc = parsed(raw('BTC'));
    expect(btc).toMatchObject({
      marketId: 1,
      symbol: 'BTC',
      status: 'active',
      sizeDecimals: 5,
      priceDecimals: 1,
      minBaseAmount: '0.00010',
      minBaseAmountUnits: 10,
      minQuoteMicro: 10_000_000,
      orderQuoteLimitMicro: 281474976710655,
      minInitialMarginFraction: 200,
      defaultInitialMarginFraction: 500,
      maintenanceMarginFraction: 120,
      maxLeverage: 50,
      insuranceFundAccountIndex: null,     // 281474976710655 is the nil account
      markPrice: 97312.4,
      tradable: true,
      untradableReasons: [],
    });
    expect(Object.isFrozen(btc)).toBe(true);
  });

  it('derives the maximum leverage from min_initial_margin_fraction', () => {
    expect(parsed(raw('1000PEPE')).maxLeverage).toBe(10);
    expect(parsed(raw('DOGE')).maxLeverage).toBe(15);    // floor(10000 / 666)
    expect(parsed(raw('ETH')).maxLeverage).toBe(50);
  });

  it('keeps a real insurance fund account and leaves missing prices empty', () => {
    const notcoin = parsed(raw('1000NOT'));
    expect(notcoin.insuranceFundAccountIndex).toBe(281474976710654);
    expect(notcoin.markPrice).toBeNull();
    expect(notcoin.lastTradePrice).toBeNull();
  });

  it('applies the tradability filter to the official snapshot', () => {
    const tradable = ['BTC', 'ETH', 'SOL', 'DOGE', '1000PEPE', 'XRP', 'BNB', '1000BONK', '1000NOT', 'BB', 'EURUSD', '0G'];
    for (const symbol of tradable) expect(parsed(raw(symbol)).tradable).toBe(true);

    const reasons = (symbol: string) => parsed(raw(symbol)).untradableReasons.join(' | ');
    expect(reasons('QNT')).toMatch(/force reduce-only/);
    expect(reasons('USDHKD')).toMatch(/force reduce-only/);
    expect(reasons('FOLKS')).toMatch(/isolated margin only/);
    expect(reasons('FOLKS')).toMatch(/liquidation mode 1/);
    expect(reasons('ANTHROPIC')).toMatch(/isolated margin only/);
    expect(reasons('MKR')).toMatch(/status inactive/);
    expect(reasons('MKR')).toMatch(/order_quote_limit 0.000000 allows no orders/);
    expect(reasons('MKR')).toMatch(/margin fractions not set/);   // delisted: all margin fractions are 0
    expect(parsed(raw('MKR')).maxLeverage).toBe(0);
  });

  it.each<[string, (market: RawMarket) => void, RegExp]>([
    ['inactive', m => { m.status = 'inactive'; }, /status inactive/],
    ['unknown status', m => { m.status = 'paused'; }, /status paused/],
    ['force reduce-only', m => { m.market_config.force_reduce_only = true; }, /force reduce-only/],
    ['hidden', m => { m.market_config.hidden = true; }, /hidden/],
    ['hidden flag missing', m => { delete m.market_config.hidden; }, /hidden/],
    ['isolated only', m => { m.market_config.market_margin_mode = 1; }, /isolated margin only/],
    ['trading hours', m => { m.market_config.trading_hours = '13:30-20:00'; }, /trading hours/],
    ['liquidation mode', m => { m.market_config.liquidation_mode = 1; }, /liquidation mode/],
    ['isolated-only market flags', m => { m.market_flags = 1; }, /market_flags 1/],
    ['market flags missing', m => { delete m.market_flags; }, /market_flags undefined/],
    ['market_config missing', m => { delete m.market_config; }, /market_config missing/],
    ['unreadable insurance fund', m => { m.market_config.insurance_fund_account_index = 'x'; }, /insurance_fund_account_index/],
    ['order limit below the minimum', m => { m.order_quote_limit = '5.000000'; }, /below min_quote_amount/],
    ['order limit 0', m => { m.order_quote_limit = '0.000000'; }, /allows no orders/],
    ['a margin fraction is 0', m => { m.min_initial_margin_fraction = 0; }, /margin fractions not set/],
  ])('marks a market untradable when %s', (_name, mutate, reason) => {
    const market = raw('BTC');
    mutate(market);
    const result = parsed(market);
    expect(result.tradable).toBe(false);
    expect(result.untradableReasons.join(' | ')).toMatch(reason);
  });

  it.each<[string, (market: RawMarket) => void, RegExp]>([
    ['the multiplier is not 1', m => { m.multiplier = '1000.000000000000000000'; }, /multiplier/],
    ['the quote multiplier is not 1', m => { m.quote_multiplier = 10000; }, /quote_multiplier/],
    ['supported size decimals differ', m => { m.supported_size_decimals = 4; }, /supported_size_decimals/],
    ['supported price decimals differ', m => { m.supported_price_decimals = 2; }, /supported_price_decimals/],
    ['size + price decimals is not 6', m => { m.size_decimals = 6; m.supported_size_decimals = 6; }, /expected 6/],
    ['decimals are not integers', m => { m.price_decimals = '1'; }, /price_decimals/],
    ['it is a spot market', m => { m.market_type = 'spot'; }, /market_type spot/],
    ['min_base_amount is a number', m => { m.min_base_amount = 0.0001; }, /min_base_amount/],
    ['min_quote_amount is malformed', m => { m.min_quote_amount = '1e1'; }, /min_quote_amount/],
    ['order_quote_limit is missing', m => { delete m.order_quote_limit; }, /order_quote_limit/],
    ['a margin fraction is above 10000', m => { m.min_initial_margin_fraction = 10001; }, /min_initial_margin_fraction 10001/],
    ['a margin fraction is not an integer', m => { m.maintenance_margin_fraction = '120'; }, /maintenance_margin_fraction 120/],
    ['the symbol is empty', m => { m.symbol = ''; }, /symbol missing/],
    ['the market id is negative', m => { m.market_id = -1; }, /market_id/],
  ])('rejects a market outright when %s', (_name, mutate, reason) => {
    const market = raw('BTC');
    mutate(market);
    expect(rejectionReasons(market).join(' | ')).toMatch(reason);
  });

  it('rejects non-objects', () => {
    expect(rejectionReasons(null)).toEqual(['not an object']);
    expect(rejectionReasons([])).toEqual(['not an object']);
  });
});

describe('parseOrderBookDetails', () => {
  it('parses every market of the fixture', () => {
    const { markets, rejected } = parseOrderBookDetails(fixture());
    expect(markets).toHaveLength(17);
    expect(rejected).toEqual([]);
  });

  it('drops both copies of a duplicated symbol or market id', () => {
    const otherBtc = { ...raw('BTC'), market_id: 1001 };
    const otherEthId = { ...raw('SOL'), market_id: 0 };
    const { markets, rejected } = parseOrderBookDetails(response(raw('BTC'), otherBtc, raw('ETH'), otherEthId, raw('DOGE')));
    expect(markets.map(m => m.symbol)).toEqual(['DOGE']);
    expect(rejected.map(r => r.reasons.join(';'))).toEqual([
      'duplicate symbol BTC',
      'duplicate symbol BTC',
      'duplicate market_id 0',
      'duplicate market_id 0',
    ]);
  });

  it('throws for an unusable envelope', () => {
    expect(() => parseOrderBookDetails(null)).toThrow(LighterMarketError);
    expect(() => parseOrderBookDetails({ code: 29500, message: 'internal error' })).toThrow(/code 29500: internal error/);
    expect(() => parseOrderBookDetails({ code: 200 })).toThrow(/order_book_details/);
    expect(() => parseOrderBookDetails({ code: 200, order_book_details: {} })).toThrow(/order_book_details/);
  });
});

describe('LighterMarketCache', () => {
  it('loads orderBookDetails?filter=perp from the profile host', async () => {
    const { cache, httpGet } = setup();
    await cache.load();
    expect(httpGet).toHaveBeenCalledWith('https://testnet.zklighter.elliot.ai/api/v1/orderBookDetails?filter=perp');
    expect(cache.profile).toBe(PROFILES.testnet);
    expect(cache.isLoaded()).toBe(true);
    expect(cache.lastLoadedAt).toBe(START);
    expect(cache.markets()).toHaveLength(17);
  });

  it('refuses gated and unknown profiles', () => {
    expect(() => setup({ profile: 'robinhood' })).toThrow(/disabled/);
    expect(() => setup({ profile: 'devnet' as never })).toThrow(/Unknown Lighter profile/);
  });

  it('fails closed before the first load', () => {
    const { cache } = setup();
    expect(errorCode(() => cache.getBySymbol('BTCUSDT'))).toBe('NOT_LOADED');
    expect(errorCode(() => cache.getByMarketId(1))).toBe('NOT_LOADED');
    expect(errorCode(() => cache.toBaseAmount('BTCUSDT', 0.01))).toBe('NOT_LOADED');
    expect(errorCode(() => cache.toPrice('BTCUSDT', 97312.4))).toBe('NOT_LOADED');
    expect(errorCode(() => cache.exchangeInfo())).toBe('NOT_LOADED');
    expect(cache.findBySymbol('BTCUSDT')).toBeUndefined();
    expect(cache.isStale()).toBe(true);
  });

  it('indexes mapped markets by bot symbol and by market id', async () => {
    const { cache } = setup();
    await cache.load();

    const btc = cache.getBySymbol('BTCUSDT');
    expect(btc).toMatchObject({ botSymbol: 'BTCUSDT', lighterSymbol: 'BTC', marketId: 1, multiplier: 1, explicit: false });
    expect(btc.market.sizeDecimals).toBe(5);

    expect(cache.getByMarketId(0).botSymbol).toBe('ETHUSDT');
    expect(cache.getByMarketId(4).lighterSymbol).toBe('1000PEPE');
    expect(cache.findByMarketId(3)?.botSymbol).toBe('DOGEUSDT');
    expect(cache.entries().map(e => e.botSymbol).sort()).toEqual([...ALLOWLIST].sort());
  });

  it('refuses symbols that are unknown or not allowlisted', async () => {
    const { cache } = setup();
    await cache.load();
    expect(errorCode(() => cache.getBySymbol('FOOUSDT'))).toBe('UNKNOWN_SYMBOL');
    expect(() => cache.getBySymbol('SOLUSDT')).toThrow(/allowlist/);          // SOL is listed but not allowlisted
    expect(errorCode(() => cache.getByMarketId(2))).toBe('UNKNOWN_MARKET');
    expect(() => cache.getByMarketId(2)).toThrow(/Lighter SOL is not mapped/);
    expect(errorCode(() => cache.getByMarketId(999))).toBe('UNKNOWN_MARKET');
    expect(cache.findMarket(2)?.symbol).toBe('SOL');                         // still known for positions opened elsewhere
    expect(errorCode(() => cache.toBaseAmount('SOLUSDT', 1))).toBe('UNKNOWN_SYMBOL');
  });

  it('reports why an allowlisted symbol did not map', async () => {
    const { cache } = setup({ symbols: { allowlist: ['BTCUSDT', 'BBUSDT', 'KPEPEUSDT'] } });
    await cache.load();
    expect(() => cache.getBySymbol('BBUSDT')).toThrow(/explicit override/);
    expect(() => cache.getBySymbol('KPEPEUSDT')).toThrow(/no usable Lighter perp named KPEPE/);
    expect(cache.rejectedSymbols().map(r => r.botSymbol)).toEqual(['BBUSDT', 'KPEPEUSDT']);
  });

  it('refuses new positions on an untradable market but still serves existing ones', async () => {
    const { cache } = setup({ symbols: { allowlist: ['BTCUSDT'], overrides: { QNTUSDT: 'QNT' } } });
    await cache.load();

    expect(errorCode(() => cache.getBySymbol('QNTUSDT'))).toBe('UNTRADABLE');
    expect(() => cache.getBySymbol('QNTUSDT')).toThrow(/force reduce-only/);
    expect(errorCode(() => cache.getByMarketId(190))).toBe('UNTRADABLE');

    const qnt = cache.getBySymbol('QNTUSDT', { allowUntradable: true });
    expect(qnt.market.tradable).toBe(false);
    expect(cache.getByMarketId(190, { allowUntradable: true }).botSymbol).toBe('QNTUSDT');
    expect(cache.findBySymbol('QNTUSDT')?.lighterSymbol).toBe('QNT');

    // Closing a position still needs the precision
    expect(cache.toBaseAmount('QNTUSDT', 1.2345)).toBe(1234);
    expect(cache.exchangeInfo().symbols.find(s => s.symbol === 'QNTUSDT')?.status).toBe('BREAK');
  });

  it('converts quantities and prices for mapped symbols', async () => {
    const { cache } = setup();
    await cache.load();

    expect(cache.toBaseAmount('BTCUSDT', 0.012345)).toBe(1234);
    expect(cache.toBaseAmount('BTCUSDT', 0.012345, 'ceil')).toBe(1235);
    expect(cache.toPrice('BTCUSDT', '97312.4')).toBe(973124);
    expect(() => cache.toPrice('BTCUSDT', 97312.47)).toThrow(/more than 1 decimal/);   // 'exact' by default
    expect(cache.toPrice('BTCUSDT', 97312.47, 'floor')).toBe(973124);
    expect(cache.toPrice('BTCUSDT', 0, 'exact', { allowZero: true })).toBe(0);
    expect(cache.worstPrice('BTCUSDT', 97312.4, 'BUY', 50)).toBe(977990);
    expect(cache.worstPrice('BTCUSDT', 97312.4, 'SELL', 50)).toBe(968258);

    expect(cache.toBaseAmount('ETHUSDT', 0.1)).toBe(1000);
    expect(cache.toPrice('ETHUSDT', 4050)).toBe(405000);

    expect(cache.toBaseAmount('1000PEPEUSDT', 12345.6)).toBe(12345);
    expect(cache.toPrice('1000PEPEUSDT', 0.0123456, 'ceil')).toBe(12346);

    expect(cache.fromBaseAmount('BTCUSDT', 1234)).toBe('0.01234');
    expect(cache.fromPrice('BTCUSDT', 973124)).toBe('97312.4');
    expect(cache.fromPrice('1000PEPEUSDT', '12345')).toBe('0.012345');
    expect(() => cache.toBaseAmount('BTCUSDT', 0.000001)).toThrow(/rounds to 0/);
  });

  describe('assertOrderLimits', () => {
    it('accepts the spec BTC example', async () => {
      const { cache } = setup();
      await cache.load();
      expect(() => cache.assertOrderLimits('BTCUSDT', 1234, 973124)).not.toThrow();
    });

    it('refuses entries below the minimum size or value, but not reduce-only orders', async () => {
      const { cache } = setup();
      await cache.load();
      // 9 units = 0.00009 BTC < 0.0001
      expect(errorCode(() => cache.assertOrderLimits('BTCUSDT', 9, 973124))).toBe('ORDER_LIMIT');
      expect(() => cache.assertOrderLimits('BTCUSDT', 9, 973124)).toThrow(/size 0.00009 BTC is below the minimum 0.00010/);
      // 0.0001 BTC @ 97312.4 = $9.73124 < $10
      expect(() => cache.assertOrderLimits('BTCUSDT', 10, 973124)).toThrow(/\$9.731240 is below the minimum \$10.000000/);
      expect(() => cache.assertOrderLimits('BTCUSDT', 9, 973124, { reduceOnly: true })).not.toThrow();
      expect(() => cache.assertOrderLimits('BTCUSDT', 10, 973124, { reduceOnly: true })).not.toThrow();
      // 1000PEPE minimum 3000
      expect(() => cache.assertOrderLimits('1000PEPEUSDT', 2999, 1000000)).toThrow(/below the minimum 3000/);
    });

    it('refuses orders above order_quote_limit, reduce-only or not', async () => {
      const btc = raw('BTC');
      btc.order_quote_limit = '1000.000000';
      const { cache } = setup({ bodies: [response(btc)], symbols: { allowlist: ['BTCUSDT'] } });
      await cache.load();
      // $1,200.835016 > $1,000
      expect(() => cache.assertOrderLimits('BTCUSDT', 1234, 973124)).toThrow(/above the per-order limit \$1000.000000/);
      expect(errorCode(() => cache.assertOrderLimits('BTCUSDT', 1234, 973124, { reduceOnly: true }))).toBe('ORDER_LIMIT');
      expect(() => cache.assertOrderLimits('BTCUSDT', 1027, 973124)).not.toThrow();   // $999.398348
    });

    it('refuses integers the signer would wrap', async () => {
      const { cache } = setup();
      await cache.load();
      expect(errorCode(() => cache.assertOrderLimits('BTCUSDT', 1234.5, 973124))).toBe('ORDER_LIMIT');
      expect(errorCode(() => cache.assertOrderLimits('BTCUSDT', 1234, 2 ** 32))).toBe('ORDER_LIMIT');
      expect(errorCode(() => cache.assertOrderLimits('BTCUSDT', 2 ** 48, 1))).toBe('ORDER_LIMIT');
      expect(errorCode(() => cache.assertOrderLimits('BTCUSDT', 1234, 0))).toBe('ORDER_LIMIT');
    });
  });

  it('keeps multiplier mappings for the liquidation feed only', async () => {
    const { cache } = setup({ symbols: { allowlist: ['BTCUSDT'], overrides: { NOTUSDT: { market: '1000NOT', multiplier: 1000 } } } });
    await cache.load();

    const not = cache.getByMarketId(172);
    expect(not).toMatchObject({ botSymbol: 'NOTUSDT', lighterSymbol: '1000NOT', multiplier: 1000, explicit: true });
    expect(errorCode(() => cache.toBaseAmount('NOTUSDT', 1))).toBe('MULTIPLIER');
    expect(errorCode(() => cache.toPrice('NOTUSDT', 1))).toBe('MULTIPLIER');
    expect(errorCode(() => cache.assertOrderLimits('NOTUSDT', 100, 100))).toBe('MULTIPLIER');
    expect(cache.exchangeInfo().symbols.map(s => s.symbol)).toEqual(['BTCUSDT']);
  });

  it('shares one request between concurrent loads', async () => {
    const { cache, httpGet } = setup();
    await Promise.all([cache.load(), cache.load(), cache.ensureLoaded()]);
    expect(httpGet).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous snapshot when a refresh fails', async () => {
    const { cache, httpGet } = setup({
      bodies: [fixture(), new Error('ECONNRESET'), { code: 29500, message: 'internal error' }, response()],
    });
    await cache.load();
    await expect(cache.load()).rejects.toThrow('ECONNRESET');
    await expect(cache.load()).rejects.toThrow(/code 29500/);
    await expect(cache.load()).rejects.toThrow(/no usable perp markets/);
    expect(httpGet).toHaveBeenCalledTimes(4);
    expect(cache.getBySymbol('BTCUSDT').marketId).toBe(1);
    expect(cache.lastLoadedAt).toBe(START);
  });

  it('refuses new positions once the data is stale but keeps the precision', async () => {
    const { cache, httpGet, advance } = setup({ bodies: [fixture(), new Error('offline'), fixture()] });
    await cache.load();
    advance(LIGHTER_MARKET_MAX_STALE_MS + 1);

    expect(cache.isStale()).toBe(true);
    expect(errorCode(() => cache.getBySymbol('BTCUSDT'))).toBe('STALE');
    expect(cache.getBySymbol('BTCUSDT', { allowUntradable: true }).marketId).toBe(1);
    expect(cache.toBaseAmount('BTCUSDT', 0.01)).toBe(1000);

    await cache.ensureLoaded();             // refresh fails: still stale, no throw
    expect(errorCode(() => cache.getBySymbol('BTCUSDT'))).toBe('STALE');
    await cache.ensureLoaded();             // refresh succeeds
    expect(cache.isStale()).toBe(false);
    expect(cache.getBySymbol('BTCUSDT').marketId).toBe(1);
    expect(httpGet).toHaveBeenCalledTimes(3);
  });

  it('ensureLoaded throws when the first load fails', async () => {
    const { cache } = setup({ bodies: [new Error('offline')] });
    await expect(cache.ensureLoaded()).rejects.toThrow('offline');
    expect(cache.isLoaded()).toBe(false);
  });

  describe('auto refresh', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('re-runs the tradability filter every 5 minutes', async () => {
      const reduceOnlyBtc = fixture();
      reduceOnlyBtc.order_book_details.find(m => m.symbol === 'BTC')!.market_config.force_reduce_only = true;
      const { cache, httpGet, advance } = setup({ bodies: [fixture(), reduceOnlyBtc, new Error('timeout'), fixture()] });
      await cache.load();
      cache.startAutoRefresh();
      cache.startAutoRefresh();             // idempotent
      expect(cache.getBySymbol('BTCUSDT').market.tradable).toBe(true);

      advance(LIGHTER_MARKET_REFRESH_MS);
      await jest.advanceTimersByTimeAsync(LIGHTER_MARKET_REFRESH_MS);
      expect(httpGet).toHaveBeenCalledTimes(2);
      expect(errorCode(() => cache.getBySymbol('BTCUSDT'))).toBe('UNTRADABLE');

      advance(LIGHTER_MARKET_REFRESH_MS);
      await jest.advanceTimersByTimeAsync(LIGHTER_MARKET_REFRESH_MS);   // failed refresh: logged, data kept
      expect(httpGet).toHaveBeenCalledTimes(3);
      expect(errorCode(() => cache.getBySymbol('BTCUSDT'))).toBe('UNTRADABLE');

      advance(LIGHTER_MARKET_REFRESH_MS);
      await jest.advanceTimersByTimeAsync(LIGHTER_MARKET_REFRESH_MS);
      expect(httpGet).toHaveBeenCalledTimes(4);
      expect(cache.getBySymbol('BTCUSDT').market.tradable).toBe(true);

      cache.stop();
      await jest.advanceTimersByTimeAsync(LIGHTER_MARKET_REFRESH_MS * 3);
      expect(httpGet).toHaveBeenCalledTimes(4);
    });

    it('drops a market that disappears from the listing', async () => {
      const withoutBtc = fixture();
      withoutBtc.order_book_details = withoutBtc.order_book_details.filter(m => m.symbol !== 'BTC');
      const { cache } = setup({ bodies: [fixture(), withoutBtc] });
      await cache.load();
      cache.startAutoRefresh();
      await jest.advanceTimersByTimeAsync(LIGHTER_MARKET_REFRESH_MS);
      cache.stop();
      expect(errorCode(() => cache.getBySymbol('BTCUSDT', { allowUntradable: true }))).toBe('UNKNOWN_SYMBOL');
      expect(errorCode(() => cache.toBaseAmount('BTCUSDT', 1))).toBe('UNKNOWN_SYMBOL');
    });
  });

  it('re-reads a symbol options function on every load and on setSymbolOptions', async () => {
    let options: LighterSymbolMapOptions = { allowlist: ['BTCUSDT'] };
    const { cache } = setup({ symbols: () => options, bodies: [fixture()] });
    const updates = jest.fn();
    const unsubscribe = cache.onUpdate(updates);
    await cache.load();
    expect(updates).toHaveBeenCalledTimes(1);
    expect(cache.findBySymbol('ETHUSDT')).toBeUndefined();

    options = { allowlist: ['BTCUSDT', 'ETHUSDT'] };
    await cache.load();
    expect(cache.getBySymbol('ETHUSDT').marketId).toBe(0);
    expect(updates).toHaveBeenCalledTimes(2);

    cache.setSymbolOptions({ allowlist: ['SOLUSDT'] });
    expect(cache.getBySymbol('SOLUSDT').marketId).toBe(2);
    expect(cache.findBySymbol('BTCUSDT')).toBeUndefined();
    expect(updates).toHaveBeenCalledTimes(3);

    unsubscribe();
    await cache.load();
    expect(updates).toHaveBeenCalledTimes(3);
  });

  it('keeps going when an update listener throws', async () => {
    const { cache } = setup();
    const after = jest.fn();
    cache.onUpdate(() => { throw new Error('listener bug'); });
    cache.onUpdate(after);
    await cache.load();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('keeps the old state when the symbol options cannot be read', async () => {
    let fail = false;
    const { cache } = setup({
      symbols: () => {
        if (fail) throw new Error('config unreadable');
        return { allowlist: ['BTCUSDT'] };
      },
      bodies: [fixture()],
    });
    await cache.load();
    fail = true;
    await expect(cache.load()).rejects.toThrow('config unreadable');
    expect(cache.getBySymbol('BTCUSDT').marketId).toBe(1);
  });

  it('lists precision-checked markets it rejected', async () => {
    const broken = raw('SOL');
    broken.multiplier = '10';
    const { cache } = setup({ bodies: [response(raw('BTC'), broken)] });
    await cache.load();
    expect(cache.markets().map(m => m.symbol)).toEqual(['BTC']);
    expect(cache.findMarket(2)).toBeUndefined();
    expect(cache.rejectedMarkets()).toEqual([{ symbol: 'SOL', marketId: 2, reasons: ['multiplier 10'] }]);
  });
});

describe('leverageToImf', () => {
  const btc = parsed(raw('BTC'));            // min IMF 200: 50x
  const pepe = parsed(raw('1000PEPE'));      // min IMF 1000: 10x

  it('sends ceil(10000 / leverage)', () => {
    expect(leverageToImf(btc, 5)).toEqual({ leverage: 5, initialMarginFraction: 2000, effectiveLeverage: 5, capped: false });
    expect(leverageToImf(btc, 50)).toMatchObject({ initialMarginFraction: 200, capped: false });
    const three = leverageToImf(btc, 3);
    expect(three.initialMarginFraction).toBe(3334);   // slightly under 3x, never over
    expect(three.effectiveLeverage).toBeLessThan(3);
  });

  it('caps leverage at the market maximum', () => {
    expect(leverageToImf(btc, 100)).toEqual({ leverage: 50, initialMarginFraction: 200, effectiveLeverage: 50, capped: true });
    expect(leverageToImf(pepe, 20)).toMatchObject({ leverage: 10, initialMarginFraction: 1000, capped: true });
  });

  it('never goes below 1x', () => {
    expect(leverageToImf(btc, 0.5)).toMatchObject({ initialMarginFraction: 10000, effectiveLeverage: 1 });
  });

  it('refuses invalid leverage', () => {
    for (const value of [0, -1, NaN, Infinity]) {
      expect(() => leverageToImf(btc, value)).toThrow(RangeError);
    }
  });

  it('refuses markets without margin fractions', () => {
    expect(() => leverageToImf(parsed(raw('MKR')), 5)).toThrow(/no usable initial margin fraction/);
  });
});

describe('isOpenInterestCapped', () => {
  // lighter-ts: limit / 1e6 when 0 < limit < 2^56, then open_interest * 2 >= that
  it('matches the FE rule open_interest x 2 >= open_interest_limit / 1e6', () => {
    expect(isOpenInterestCapped(50, 100_000_000)).toBe(true);        // limit 100 after scaling
    expect(isOpenInterestCapped(49.9, 100_000_000)).toBe(false);
    expect(isOpenInterestCapped('60', '100000000')).toBe(true);
    expect(isOpenInterestCapped(2_500_000, 5_000_000_000_000)).toBe(true);
    expect(isOpenInterestCapped(2_499_999, 5_000_000_000_000)).toBe(false);
  });

  it('treats a limit of 0 or >= 2^56 as "no cap"', () => {
    expect(isOpenInterestCapped(1e12, 0)).toBe(false);
    expect(isOpenInterestCapped(1e12, 2 ** 56)).toBe(false);
    expect(isOpenInterestCapped(1e12, '72057594037927936')).toBe(false);
  });

  it('returns null when a value is missing or unreadable', () => {
    expect(isOpenInterestCapped(undefined, 100)).toBeNull();
    expect(isOpenInterestCapped(10, null)).toBeNull();
    expect(isOpenInterestCapped('abc', 100)).toBeNull();
    expect(isOpenInterestCapped('', 100)).toBeNull();
    expect(isOpenInterestCapped(10, -1)).toBeNull();
  });
});
