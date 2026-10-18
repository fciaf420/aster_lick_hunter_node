/**
 * @jest-environment node
 */
import {
  MARK_RATIO_TOLERANCE,
  OVERRIDE_REQUIRED_LIGHTER_SYMBOLS,
  buildSymbolMap,
  candidateLighterSymbol,
  checkMarkRatio,
  defaultBotSymbol,
  evaluateMarkRatios,
  requiresOverride,
  toBotPrice,
  toBotQuantity,
  type LighterSymbolEntry,
} from '../../../src/lib/exchange/lighter/symbols';

// Market ids as in lighter-ts src/fallbacks/orderBookMetas.json (they differ between networks)
const MARKETS = [
  { symbol: 'ETH', marketId: 0 },
  { symbol: 'BTC', marketId: 1 },
  { symbol: 'SOL', marketId: 2 },
  { symbol: '1000PEPE', marketId: 4 },
  { symbol: '1000NOT', marketId: 172 },
  { symbol: 'QNT', marketId: 190 },
  { symbol: 'BB', marketId: 211 },
  { symbol: 'EURUSD', marketId: 96 },
  { symbol: 'USDHKD', marketId: 230 },
  { symbol: '0G', marketId: 84 },
];

const reasonFor = (map: ReturnType<typeof buildSymbolMap>, botSymbol: string) =>
  map.rejected.find(item => item.botSymbol === botSymbol)?.reason;

describe('candidateLighterSymbol', () => {
  it('strips the USDT suffix', () => {
    expect(candidateLighterSymbol('BTCUSDT')).toBe('BTC');
    expect(candidateLighterSymbol('1000PEPEUSDT')).toBe('1000PEPE');
    expect(candidateLighterSymbol('0GUSDT')).toBe('0G');
    expect(defaultBotSymbol('1000PEPE')).toBe('1000PEPEUSDT');
  });

  it('returns null for anything that is not an upper-case USDT symbol', () => {
    expect(candidateLighterSymbol('BTCUSDC')).toBeNull();
    expect(candidateLighterSymbol('USDT')).toBeNull();
    expect(candidateLighterSymbol('btcusdt')).toBeNull();
    expect(candidateLighterSymbol('BTC-USDT')).toBeNull();
    expect(candidateLighterSymbol('')).toBeNull();
  });
});

describe('requiresOverride', () => {
  it('flags stock, FX and commodity tickers that collide with crypto names', () => {
    for (const symbol of ['BB', 'COIN', 'META', 'ARM', 'NOW', 'BOT', 'QNT', 'WEN', 'XAU', 'EURUSD', 'USDJPY', '0G', '2Z']) {
      expect(requiresOverride(symbol)).toBe(true);
    }
  });

  it('catches FX pairs missing from the snapshot', () => {
    expect(OVERRIDE_REQUIRED_LIGHTER_SYMBOLS.has('USDHKD')).toBe(false);
    expect(requiresOverride('USDHKD')).toBe(true);
    expect(requiresOverride('USDSGD')).toBe(true);
  });

  it('leaves crypto names alone', () => {
    for (const symbol of ['BTC', 'ETH', 'SOL', '1000PEPE', '1000NOT', 'DOGE', 'HYPE', 'ASTER']) {
      expect(requiresOverride(symbol)).toBe(false);
    }
  });
});

describe('buildSymbolMap', () => {
  it('maps only allowlisted symbols, by exact backend symbol', () => {
    const map = buildSymbolMap(MARKETS, { allowlist: ['BTCUSDT', 'ETHUSDT', '1000PEPEUSDT'] });
    expect([...map.bySymbol.keys()].sort()).toEqual(['1000PEPEUSDT', 'BTCUSDT', 'ETHUSDT']);
    expect(map.bySymbol.get('BTCUSDT')).toEqual({ botSymbol: 'BTCUSDT', lighterSymbol: 'BTC', marketId: 1, multiplier: 1, explicit: false });
    expect(map.byMarketId.get(4)?.botSymbol).toBe('1000PEPEUSDT');
    expect(map.bySymbol.has('SOLUSDT')).toBe(false);                 // listed on Lighter but not allowlisted
    expect(map.byMarketId.has(2)).toBe(false);
    expect(map.rejected).toEqual([]);
  });

  it('never matches display names (kPEPE is 1000PEPE on the API)', () => {
    const map = buildSymbolMap(MARKETS, { allowlist: ['KPEPEUSDT', 'PEPEUSDT'] });
    expect(map.bySymbol.size).toBe(0);
    expect(reasonFor(map, 'KPEPEUSDT')).toMatch(/no usable Lighter perp named KPEPE/);
    expect(reasonFor(map, 'PEPEUSDT')).toMatch(/no usable Lighter perp named PEPE/);
  });

  it('needs an explicit override for colliding tickers', () => {
    const auto = buildSymbolMap(MARKETS, { allowlist: ['BBUSDT', 'QNTUSDT', 'EURUSDUSDT', '0GUSDT'] });
    expect(auto.bySymbol.size).toBe(0);
    for (const botSymbol of ['BBUSDT', 'QNTUSDT', 'EURUSDUSDT', '0GUSDT']) {
      expect(reasonFor(auto, botSymbol)).toMatch(/explicit override/);
    }

    const explicit = buildSymbolMap(MARKETS, { allowlist: ['BBUSDT'], overrides: { BBUSDT: 'BB', '0GUSDT': '0G' } });
    expect(explicit.bySymbol.get('BBUSDT')).toMatchObject({ lighterSymbol: 'BB', marketId: 211, explicit: true });
    expect(explicit.bySymbol.get('0GUSDT')?.marketId).toBe(84);     // an override also allowlists its symbol
  });

  it('maps a x1000 contract with an override multiplier', () => {
    const auto = buildSymbolMap(MARKETS, { allowlist: ['NOTUSDT'] });
    expect(reasonFor(auto, 'NOTUSDT')).toMatch(/no usable Lighter perp named NOT/);

    const map = buildSymbolMap(MARKETS, { allowlist: ['NOTUSDT'], overrides: { NOTUSDT: { market: '1000NOT', multiplier: 1000 } } });
    expect(map.bySymbol.get('NOTUSDT')).toEqual({ botSymbol: 'NOTUSDT', lighterSymbol: '1000NOT', marketId: 172, multiplier: 1000, explicit: true });
    expect(map.byMarketId.get(172)?.botSymbol).toBe('NOTUSDT');
  });

  it('gives a market claimed twice to the explicit override', () => {
    const map = buildSymbolMap(MARKETS, {
      allowlist: ['1000NOTUSDT', 'NOTUSDT'],
      overrides: { NOTUSDT: { market: '1000NOT', multiplier: 1000 } },
    });
    expect(map.byMarketId.get(172)?.botSymbol).toBe('NOTUSDT');
    expect(map.bySymbol.has('1000NOTUSDT')).toBe(false);
    expect(reasonFor(map, '1000NOTUSDT')).toMatch(/also mapped from NOTUSDT/);
  });

  it('maps neither symbol when two overrides claim one market', () => {
    const map = buildSymbolMap(MARKETS, { allowlist: [], overrides: { BTCUSDT: 'BTC', XBTUSDT: 'BTC' } });
    expect(map.byMarketId.has(1)).toBe(false);
    expect(map.bySymbol.size).toBe(0);
    expect(reasonFor(map, 'BTCUSDT')).toMatch(/also mapped from XBTUSDT/);
    expect(reasonFor(map, 'XBTUSDT')).toMatch(/also mapped from BTCUSDT/);
  });

  it('rejects malformed overrides', () => {
    const map = buildSymbolMap(MARKETS, {
      allowlist: [],
      overrides: {
        AUSDT: { market: '', multiplier: 1 },
        BUSDT: { market: 'BTC', multiplier: 0 },
        CUSDT: { market: 'ETH', multiplier: -1000 },
        DUSDT: { market: 'SOL', multiplier: NaN },
        EUSDT: 'DOES_NOT_EXIST',
      },
    });
    expect(map.bySymbol.size).toBe(0);
    expect(reasonFor(map, 'AUSDT')).toMatch(/no Lighter market symbol/);
    expect(reasonFor(map, 'BUSDT')).toMatch(/multiplier 0/);
    expect(reasonFor(map, 'CUSDT')).toMatch(/multiplier -1000/);
    expect(reasonFor(map, 'DUSDT')).toMatch(/multiplier NaN/);
    expect(reasonFor(map, 'EUSDT')).toMatch(/no usable Lighter perp named DOES_NOT_EXIST/);
  });

  it('rejects symbols without a USDT suffix and ignores inherited object keys', () => {
    const map = buildSymbolMap(MARKETS, { allowlist: ['BTCUSDC', 'constructor', 'toString'] });
    expect(map.bySymbol.size).toBe(0);
    expect(reasonFor(map, 'BTCUSDC')).toMatch(/not a USDT symbol/);
    expect(reasonFor(map, 'constructor')).toMatch(/not a USDT symbol/);
  });

  it('lists each allowlisted symbol once', () => {
    const map = buildSymbolMap(MARKETS, { allowlist: ['BTCUSDT', 'BTCUSDT', 'FOOUSDT', 'FOOUSDT'] });
    expect(map.bySymbol.size).toBe(1);
    expect(map.rejected).toHaveLength(1);
  });

  it("'all' maps every market that maps automatically, for listings", () => {
    const map = buildSymbolMap(MARKETS, { allowlist: 'all' });
    expect([...map.bySymbol.keys()].sort()).toEqual(['1000NOTUSDT', '1000PEPEUSDT', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(map.rejected).toEqual([]);
  });

  it('accepts any iterable allowlist', () => {
    const map = buildSymbolMap(MARKETS, { allowlist: new Set(['ETHUSDT']) });
    expect(map.bySymbol.get('ETHUSDT')?.marketId).toBe(0);
  });
});

describe('checkMarkRatio', () => {
  it('passes marks within 2%', () => {
    expect(MARK_RATIO_TOLERANCE).toBe(0.02);
    expect(checkMarkRatio(97312.4, 97300)).toMatchObject({ ok: true });
    expect(checkMarkRatio(101.9, 100).ok).toBe(true);
    expect(checkMarkRatio(98.1, 100).ok).toBe(true);
    expect(checkMarkRatio('4050.00', '4049.5').ok).toBe(true);
  });

  it('fails marks more than 2% apart', () => {
    const high = checkMarkRatio(102.1, 100);
    expect(high.ok).toBe(false);
    expect(high.ratio).toBeCloseTo(1.021, 10);
    expect(high.reason).toMatch(/more than 2.00% away/);
    expect(checkMarkRatio(97.9, 100).ok).toBe(false);
  });

  it('catches a x1000 contract mismatch, and passes it with the right multiplier', () => {
    // Lighter 1000PEPE vs a venue's PEPEUSDT: the hunter's price-ratio check would SELL every BUY liquidation
    expect(checkMarkRatio(0.0123, 0.0000123).ok).toBe(false);
    expect(checkMarkRatio(0.0123, 0.0000123, 1000).ok).toBe(true);
    expect(checkMarkRatio(0.0123, 0.0123, 1000).ok).toBe(false);
  });

  it('fails closed on missing or unreadable marks', () => {
    for (const bad of [null, undefined, 0, -1, NaN, Infinity, '', ' ', 'abc']) {
      const asLighter = checkMarkRatio(bad as never, 100);
      expect(asLighter).toMatchObject({ ok: false, ratio: null });
      expect(asLighter.reason).toMatch(/Lighter mark/);
      const asVenue = checkMarkRatio(100, bad as never);
      expect(asVenue).toMatchObject({ ok: false, ratio: null });
      expect(asVenue.reason).toMatch(/venue mark/);
    }
    expect(checkMarkRatio(100, 100, 0).ok).toBe(false);
    expect(checkMarkRatio(100, 100, NaN).ok).toBe(false);
  });

  it('takes a custom tolerance', () => {
    expect(checkMarkRatio(100.6, 100, 1, 0.005).ok).toBe(false);
    expect(checkMarkRatio(100.4, 100, 1, 0.005).ok).toBe(true);
  });
});

describe('evaluateMarkRatios', () => {
  const entry = (botSymbol: string, multiplier = 1): LighterSymbolEntry =>
    ({ botSymbol, lighterSymbol: botSymbol.replace(/USDT$/, ''), marketId: 0, multiplier, explicit: false });

  it('splits mapped symbols into passed and failed', () => {
    const lighterMarks: Record<string, number> = { BTCUSDT: 97312.4, ETHUSDT: 4050, NOTUSDT: 2.1 };
    const venueMarks: Record<string, number | undefined> = { BTCUSDT: 97300, ETHUSDT: 3900, NOTUSDT: 0.0021 };
    const { passed, failed } = evaluateMarkRatios(
      [entry('BTCUSDT'), entry('ETHUSDT'), entry('NOTUSDT', 1000), entry('SOLUSDT')],
      e => lighterMarks[e.botSymbol],
      symbol => venueMarks[symbol]
    );
    expect(passed.map(e => e.botSymbol)).toEqual(['BTCUSDT', 'NOTUSDT']);
    expect(failed.map(f => f.entry.botSymbol)).toEqual(['ETHUSDT', 'SOLUSDT']);
    expect(failed[1].result.reason).toMatch(/Lighter mark/);
  });
});

describe('toBotPrice / toBotQuantity', () => {
  it('converts x1000 contracts and leaves multiplier 1 untouched', () => {
    expect(toBotPrice(2.1, { multiplier: 1000 })).toBeCloseTo(0.0021, 12);
    expect(toBotQuantity(25, { multiplier: 1000 })).toBe(25000);
    expect(toBotPrice(97312.4, { multiplier: 1 })).toBe(97312.4);
    expect(toBotQuantity(0.25, { multiplier: 1 })).toBe(0.25);
  });
});
