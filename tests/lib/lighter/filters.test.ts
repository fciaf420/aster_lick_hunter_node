/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';
import { buildExchangeInfo, buildExchangeSymbol, buildSymbolFilters } from '../../../src/lib/exchange/lighter/filters';
import { LighterMarketCache, parseMarket, type LighterMarket } from '../../../src/lib/exchange/lighter/markets';
import { SymbolPrecisionManager } from '../../../src/lib/utils/symbolPrecision';
import { getSymbolFilters, roundToStepSize, roundToTickSize, validateOrderParams } from '../../../src/lib/api/pricing';

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'orderBookDetails.perp.json'), 'utf8'));

function market(symbol: string): LighterMarket {
  const raw = FIXTURE.order_book_details.find((item: { symbol: string }) => item.symbol === symbol);
  const result = parseMarket(JSON.parse(JSON.stringify(raw)));
  if (!('market' in result)) throw new Error(`fixture ${symbol} rejected`);
  return result.market;
}

const filterOf = (filters: ReturnType<typeof buildSymbolFilters>, type: string): Record<string, string> => {
  const found = filters.find(filter => filter.filterType === type);
  if (!found) throw new Error(`no ${type}`);
  return found as unknown as Record<string, string>;
};

async function loadedCache(): Promise<LighterMarketCache> {
  const cache = new LighterMarketCache({
    profile: 'mainnet',
    symbols: {
      allowlist: ['BTCUSDT', 'ETHUSDT', '1000PEPEUSDT', 'DOGEUSDT'],
      overrides: { QNTUSDT: 'QNT', NOTUSDT: { market: '1000NOT', multiplier: 1000 } },
    },
    httpGet: async () => JSON.parse(JSON.stringify(FIXTURE)),
    now: () => 1_792_289_401_234,
  });
  await cache.load();
  return cache;
}

describe('buildSymbolFilters (spec §3.3)', () => {
  it('BTC: size 5, price 1 decimals', () => {
    const filters = buildSymbolFilters(market('BTC'));
    expect(filters.map(f => f.filterType)).toEqual(['PRICE_FILTER', 'LOT_SIZE', 'MIN_NOTIONAL']);
    expect(filterOf(filters, 'PRICE_FILTER')).toEqual({ filterType: 'PRICE_FILTER', tickSize: '0.1', minPrice: '0.1', maxPrice: '429496729.5' });
    expect(filterOf(filters, 'LOT_SIZE')).toEqual({ filterType: 'LOT_SIZE', stepSize: '0.00001', minQty: '0.00010', maxQty: '2814749767.10655' });
    expect(filterOf(filters, 'MIN_NOTIONAL')).toEqual({ filterType: 'MIN_NOTIONAL', notional: '10.000000' });
  });

  it('ETH: size 4, price 2 decimals', () => {
    const filters = buildSymbolFilters(market('ETH'));
    expect(filterOf(filters, 'PRICE_FILTER')).toMatchObject({ tickSize: '0.01', minPrice: '0.01', maxPrice: '42949672.95' });
    expect(filterOf(filters, 'LOT_SIZE')).toMatchObject({ stepSize: '0.0001', minQty: '0.0050', maxQty: '28147497671.0655' });
  });

  it('1000PEPE: size 0, price 6 decimals', () => {
    const filters = buildSymbolFilters(market('1000PEPE'));
    expect(filterOf(filters, 'PRICE_FILTER')).toMatchObject({ tickSize: '0.000001', minPrice: '0.000001', maxPrice: '4294.967295' });
    expect(filterOf(filters, 'LOT_SIZE')).toMatchObject({ stepSize: '1', minQty: '3000', maxQty: '281474976710655' });
  });

  it('writes every value as a plain decimal', () => {
    for (const symbol of ['BTC', 'ETH', 'SOL', 'DOGE', '1000PEPE', 'XRP', 'BNB', '1000BONK', '1000NOT']) {
      for (const filter of buildSymbolFilters(market(symbol))) {
        for (const [key, value] of Object.entries(filter)) {
          if (key !== 'filterType') expect(value).toMatch(/^\d+(\.\d+)?$/);
        }
      }
    }
  });
});

describe('buildExchangeSymbol / buildExchangeInfo', () => {
  const entry = { botSymbol: 'BTCUSDT', lighterSymbol: 'BTC', marketId: 1, multiplier: 1, explicit: false };

  it('describes a symbol the way Binance does, plus Lighter extras', () => {
    expect(buildExchangeSymbol(entry, market('BTC'))).toEqual({
      symbol: 'BTCUSDT',
      pair: 'BTCUSDT',
      contractType: 'PERPETUAL',
      status: 'TRADING',
      baseAsset: 'BTC',
      quoteAsset: 'USDC',
      marginAsset: 'USDC',
      pricePrecision: 1,
      quantityPrecision: 5,
      orderTypes: ['LIMIT', 'MARKET', 'STOP_MARKET', 'TAKE_PROFIT_MARKET'],
      timeInForce: ['GTC', 'IOC', 'GTX'],
      filters: buildSymbolFilters(market('BTC')),
      lighter: {
        marketId: 1,
        symbol: 'BTC',
        orderQuoteLimit: '281474976.710655',
        maxLeverage: 50,
        minInitialMarginFraction: 200,
        tradable: true,
        untradableReasons: [],
      },
    });
  });

  it('refuses multiplier mappings and mismatched markets', () => {
    expect(() => buildExchangeSymbol({ ...entry, multiplier: 1000 }, market('BTC'))).toThrow(/multiplier 1000/);
    expect(() => buildExchangeSymbol(entry, market('ETH'))).toThrow(/market 1, not 0/);
  });

  it('sorts symbols and skips multiplier mappings', () => {
    const info = buildExchangeInfo([
      { entry: { ...entry, botSymbol: 'ETHUSDT', lighterSymbol: 'ETH', marketId: 0 }, market: market('ETH') },
      { entry, market: market('BTC') },
      { entry: { botSymbol: 'NOTUSDT', lighterSymbol: '1000NOT', marketId: 172, multiplier: 1000, explicit: true }, market: market('1000NOT') },
    ], 123);
    expect(info.timezone).toBe('UTC');
    expect(info.serverTime).toBe(123);
    expect(info.venue).toBe('lighter');
    expect(info.symbols.map(s => s.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
  });
});

describe('LighterMarketCache.exchangeInfo', () => {
  it('lists mapped symbols; untradable ones are not TRADING', async () => {
    const info = (await loadedCache()).exchangeInfo();
    expect(info.serverTime).toBe(1_792_289_401_234);
    expect(info.symbols.map(s => [s.symbol, s.status])).toEqual([
      ['1000PEPEUSDT', 'TRADING'],
      ['BTCUSDT', 'TRADING'],
      ['DOGEUSDT', 'TRADING'],
      ['ETHUSDT', 'TRADING'],
      ['QNTUSDT', 'BREAK'],
    ]);
    expect(info.symbols.find(s => s.symbol === 'QNTUSDT')?.lighter.untradableReasons).toEqual(['force reduce-only']);
  });

  it('only offers tradable symbols to the symbol picker (src/app/api/symbols/route.ts filter)', async () => {
    const info = (await loadedCache()).exchangeInfo();
    const listed = info.symbols
      .filter(s => s.status === 'TRADING' && s.symbol.endsWith('USDT') && s.contractType === 'PERPETUAL')
      .map(s => s.symbol);
    expect(listed).toEqual(['1000PEPEUSDT', 'BTCUSDT', 'DOGEUSDT', 'ETHUSDT']);
  });

  it('is plain JSON (no BigInt), so it can be sent to the UI', async () => {
    const info = (await loadedCache()).exchangeInfo();
    expect(JSON.parse(JSON.stringify(info))).toEqual(info);
  });
});

describe('the bot reads the synthesized filters unchanged', () => {
  it('SymbolPrecisionManager picks up precision and limits', async () => {
    const manager = new SymbolPrecisionManager();
    manager.parseExchangeInfo((await loadedCache()).exchangeInfo());

    expect(manager.getSymbolFilter('BTCUSDT')).toEqual({
      symbol: 'BTCUSDT',
      pricePrecision: 1,
      quantityPrecision: 5,
      tickSize: '0.1',
      stepSize: '0.00001',
      maxQuantity: 2814749767.10655,
      minQuantity: 0.0001,
      minNotional: 10,
    });
    expect(manager.getSymbolFilter('1000PEPEUSDT')).toMatchObject({ pricePrecision: 6, quantityPrecision: 0, minQuantity: 3000 });
    expect(manager.getSymbolFilter('ETHUSDT')).toMatchObject({ pricePrecision: 2, quantityPrecision: 4, minQuantity: 0.005 });

    expect(manager.formatPrice('BTCUSDT', 97312.47)).toBe(97312.5);
    expect(manager.formatQuantity('ETHUSDT', 0.12345)).toBe(0.1235);
    expect(manager.formatQuantity('1000PEPEUSDT', 12345.6)).toBe(12346);
    expect(manager.formatPrice('1000PEPEUSDT', 0.01234567)).toBe(0.012346);
    expect(manager.hasSymbol('NOTUSDT')).toBe(false);
  });

  it('pricing.ts finds the symbol and validates orders against the Lighter limits', async () => {
    const info = (await loadedCache()).exchangeInfo();
    const exchange = {
      getExchangeInfo: jest.fn(async () => info),
      getBookTicker: jest.fn(),
      getOrderBook: jest.fn(),
    };

    const btc = await getSymbolFilters('BTCUSDT', exchange);
    expect(btc?.pricePrecision).toBe(1);
    expect(btc?.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional).toBe('10.000000');

    expect(roundToTickSize(97312.47, '0.1')).toBe(97312.5);
    expect(roundToStepSize(0.012345, '0.00001')).toBe(0.01235);

    const valid = await validateOrderParams('BTCUSDT', 'BUY', 97312.47, 0.012345, exchange);
    expect(valid).toEqual({ valid: true, adjustedPrice: 97312.5, adjustedQuantity: 0.01235 });

    const tooSmall = await validateOrderParams('BTCUSDT', 'BUY', 97312.4, 0.00005, exchange);
    expect(tooSmall.valid).toBe(false);
    expect(tooSmall.error).toMatch(/below minimum 0.0001/);

    const lowNotional = await validateOrderParams('BTCUSDT', 'BUY', 97312.4, 0.0001, exchange);
    expect(lowNotional).toMatchObject({ valid: false });
    expect(lowNotional.error).toMatch(/Notional value .* below minimum 10/);

    expect(exchange.getExchangeInfo).toHaveBeenCalledTimes(1);   // pricing.ts caches exchangeInfo
  });
});
