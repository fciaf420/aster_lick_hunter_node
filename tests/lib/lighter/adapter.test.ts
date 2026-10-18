/**
 * @jest-environment node
 */
// LighterAdapter against an offline fake exchange (mocked HTTP). Uses the real native signer when the pinned
// binary is installed (npm run lighter:signer), else FakeLighterSigner with the same tx_info shapes.
import * as fs from 'fs';
import {
  LighterAdapter,
  LighterAccountStream,
  lighterOrderStatus,
  parseLighterCredentials,
  toLighterVenueOrder,
  type CreateLighterUserStream,
  type LighterAdapterOptions,
  type LighterPlacedOrder,
} from '../../../src/lib/exchange/lighter/LighterAdapter';
import { lighterOrderId } from '../../../src/lib/exchange/lighter/accountStream';
import { LIGHTER_CAPABILITIES } from '../../../src/lib/exchange/lighter/capabilities';
import { LighterMarketCache } from '../../../src/lib/exchange/lighter/markets';
import { LighterNonceManager, LighterTxFailedError, LighterTxUnknownError } from '../../../src/lib/exchange/lighter/nonce';
import { isDefinitelyNotPlaced, orderMayExist, orderMayExistUntil } from '../../../src/lib/exchange/orderErrors';
import { defaultLighterSignerPath, loadLighterSigner, resolveLighterSignerBinary, type LighterSigner } from '../../../src/lib/exchange/lighter/signer';
import type { UserDataEvent } from '../../../src/lib/exchange/types';
import { normalizeOrderId } from '../../../src/lib/exchange/orderId';
import { fakeSocketFactory } from './fakeLighterSocket';
import {
  FakeLighterExchange,
  FakeLighterSigner,
  TEST_ACCOUNT,
  TEST_KEY_INDEX,
  TEST_PUBLIC_KEY,
  THROWAWAY_PRIVATE_KEY,
  recordingSigner,
} from './fakeLighterExchange';

const DAY = 24 * 60 * 60 * 1000;
const BTC = 1;
const ETH = 0;
const QNT = 190;

const realSigner: LighterSigner | null = (() => {
  try {
    const libraryPath = defaultLighterSignerPath(resolveLighterSignerBinary());
    if (!fs.existsSync(libraryPath)) return null;
    // Key index 7: the signer tests use 3 and 4 on the same chain and account
    return loadLighterSigner({ chainId: 300, accountIndex: TEST_ACCOUNT, apiKeyIndex: TEST_KEY_INDEX, apiKeyPrivateKey: THROWAWAY_PRIVATE_KEY, libraryPath });
  } catch {
    return null;
  }
})();

const CREDENTIALS = {
  profile: 'testnet',
  accountIndex: TEST_ACCOUNT,
  apiKeyIndex: TEST_KEY_INDEX,
  apiKeyPrivateKey: THROWAWAY_PRIVATE_KEY,
  apiKeyPublicKey: TEST_PUBLIC_KEY,
};

interface Harness {
  adapter: LighterAdapter;
  exchange: FakeLighterExchange;
  signer: ReturnType<typeof recordingSigner>;
  clock: { now: number };
  markets: LighterMarketCache;
}

function setup(overrides: Partial<LighterAdapterOptions> = {}, credentials: Record<string, unknown> = CREDENTIALS): Harness {
  const clock = { now: Date.now() };
  const now = () => clock.now;
  const sleep = async (ms: number) => {
    clock.now += ms;
  };
  const exchange = new FakeLighterExchange(now);
  const markets = new LighterMarketCache({
    profile: 'testnet',
    symbols: {
      allowlist: ['BTCUSDT', 'ETHUSDT', 'DOGEUSDT'],
      overrides: { QNTUSDT: 'QNT', NOTUSDT: { market: '1000NOT', multiplier: 1000 } },
    },
    httpGet: async url => (await exchange.transport({ method: 'GET', url, timeoutMs: 1000 })).data,
    now,
  });
  const signer = recordingSigner(realSigner ?? new FakeLighterSigner(TEST_ACCOUNT, TEST_KEY_INDEX, now), exchange);
  const adapter = new LighterAdapter({
    profile: 'testnet',
    credentials,
    markets,
    transport: exchange.transport,
    signer,
    journal: 'memory',
    now,
    sleep,
    ...overrides,
  });
  return { adapter, exchange, signer, clock, markets };
}

function sentTxs(exchange: FakeLighterExchange, txType?: number) {
  return exchange.received.filter(tx => txType === undefined || tx.txType === txType);
}

function sendTxCount(exchange: FakeLighterExchange): number {
  return exchange.requests.filter(r => r.method === 'POST').length;
}

describe(`LighterAdapter (${realSigner ? 'real' : 'fake'} signer)`, () => {
  describe('capabilities and credentials', () => {
    it('reports the Lighter capabilities (USDC, no hedge mode, native SL/TP on mark)', () => {
      const { adapter } = setup();
      expect(adapter.id).toBe('lighter');
      expect(adapter.capabilities).toBe(LIGHTER_CAPABILITIES);
      expect(LIGHTER_CAPABILITIES).toMatchObject({
        hedgeMode: false, setPositionMode: false, reduceOnly: true, postOnly: true, maxBatchOrders: 20,
        stopMarket: true, takeProfitMarket: true, triggerPrice: 'MARK', perSymbolLeverage: true, marginAsset: 'USDC',
      });
    });

    it('validates stored credentials without echoing secrets', () => {
      expect(parseLighterCredentials(CREDENTIALS).credentials).not.toBeNull();
      expect(parseLighterCredentials({ ...CREDENTIALS, accountIndex: '12345', apiKeyIndex: '7' }).credentials?.accountIndex).toBe(12345);
      expect(parseLighterCredentials({ ...CREDENTIALS, apiKeyPrivateKey: undefined, apiPrivateKey: THROWAWAY_PRIVATE_KEY }).credentials).not.toBeNull();
      const bad = parseLighterCredentials({ ...CREDENTIALS, profile: '', apiKeyPrivateKey: 'abc', apiKeyIndex: 255 });
      expect(bad.credentials).toBeNull();
      expect(bad.problems.join(' ')).toMatch(/profile/);
      expect(bad.problems.join(' ')).toMatch(/apiKeyIndex/);
      expect(bad.problems.join(' ')).not.toContain(THROWAWAY_PRIVATE_KEY.slice(2, 20));
      expect(setup().adapter.hasCredentials()).toBe(true);
      expect(setup({}, { ...CREDENTIALS, apiKeyPublicKey: '' }).adapter.hasCredentials()).toBe(false);
    });

    it('refuses a market cache or HTTP client from another profile', () => {
      const { exchange } = setup();
      const mainnetMarkets = new LighterMarketCache({ profile: 'mainnet', symbols: { allowlist: [] }, httpGet: async () => ({}) });
      expect(() => new LighterAdapter({ profile: 'testnet', credentials: CREDENTIALS, markets: mainnetMarkets, transport: exchange.transport }))
        .toThrow(/market data for mainnet/);
    });
  });

  describe('startup checks', () => {
    it('passes and reports the account tier', async () => {
      const { adapter } = setup();
      const report = await adapter.verifyStartup();
      expect(report).toMatchObject({ profile: 'testnet', accountIndex: TEST_ACCOUNT, apiKeyIndex: TEST_KEY_INDEX, networkId: 300, userTier: 'standard', takerFeeTick: 200 });
    });

    it('refuses credentials bound to another profile before any request', async () => {
      const { adapter, exchange } = setup({}, { ...CREDENTIALS, profile: 'mainnet' });
      await expect(adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 97000 }))
        .rejects.toThrow(/belong to profile "mainnet"/);
      expect(exchange.requests).toHaveLength(0);
    });

    it('refuses a public key that does not match the registered key', async () => {
      const { adapter, exchange } = setup();
      exchange.publicKey = 'cd'.repeat(40);
      await expect(adapter.verifyStartup()).rejects.toThrow(/public key does not match/);
      await expect(adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 97000 })).rejects.toThrow(/public key/);
      expect(sendTxCount(exchange)).toBe(0);
    });

    it('refuses a maker-only API key (every taker entry would be rejected)', async () => {
      const { adapter, exchange } = setup();
      exchange.makerOnlyKeys = [TEST_KEY_INDEX];
      await expect(adapter.verifyStartup()).rejects.toThrow(/maker-only/);
      expect(sendTxCount(exchange)).toBe(0);
    });

    it('refreshes a rejected auth token once, and fails when the exchange rejects it again', async () => {
      const ok = setup();
      ok.exchange.authFailures = 1;
      await expect(ok.adapter.verifyStartup()).resolves.toBeDefined();
      expect(ok.signer.calls.filter(c => c === 'createAuthToken')).toHaveLength(2);

      const failing = setup();
      failing.exchange.authFailures = 2;
      const error = await failing.adapter.verifyStartup().catch(e => e);
      expect(String(error.message)).toMatch(/auth token rejected twice/);
      // The token never appears in the error
      expect(String(error.message)).not.toMatch(/[0-9a-f]{160}/);
    });

    it('refuses a signer set up for another chain', async () => {
      const exchange = new FakeLighterExchange();
      const markets = new LighterMarketCache({ profile: 'mainnet', symbols: { allowlist: ['BTCUSDT'] }, httpGet: async () => ({}) });
      const adapter = new LighterAdapter({
        profile: 'mainnet', credentials: { ...CREDENTIALS, profile: 'mainnet' }, markets, transport: exchange.transport,
        signer: new FakeLighterSigner(), journal: 'memory',
      });
      await expect(adapter.verifyStartup()).rejects.toThrow(/chain 300/);
    });
  });

  describe('market data', () => {
    it('synthesizes exchangeInfo from the market cache (multiplier mappings left out)', async () => {
      const { adapter } = setup();
      const info = await adapter.getExchangeInfo();
      expect(info.symbols.map((s: any) => s.symbol)).toEqual(['BTCUSDT', 'DOGEUSDT', 'ETHUSDT', 'QNTUSDT']);
      const btc = info.symbols.find((s: any) => s.symbol === 'BTCUSDT');
      expect(btc.filters).toEqual(expect.arrayContaining([
        expect.objectContaining({ filterType: 'PRICE_FILTER', tickSize: '0.1' }),
        expect.objectContaining({ filterType: 'LOT_SIZE', stepSize: '0.00001', minQty: '0.00010' }),
      ]));
      expect(info.symbols.find((s: any) => s.symbol === 'QNTUSDT').status).toBe('BREAK');
    });

    it('reads mark, index and last prices; refuses unmapped and x1000 symbols', async () => {
      const { adapter } = setup();
      await expect(adapter.getMarkPrice('BTCUSDT')).resolves.toEqual({ symbol: 'BTCUSDT', markPrice: '97312.4', indexPrice: expect.any(String) });
      await expect(adapter.getTickerPrice('ETHUSDT')).resolves.toEqual({ symbol: 'ETHUSDT', price: '4050.00' });   // mark
      const all = await adapter.getMarkPrice() as any[];
      expect(all.map(p => p.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);   // markets with a REST mark
      await expect(adapter.getMarkPrice('XRPUSDT')).rejects.toThrow(/no Lighter market/);
      await expect(adapter.getMarkPrice('NOTUSDT')).rejects.toThrow(/liquidation feed only/);
    });

    it('getTickerPrice returns the mark (what triggers are checked against), not the last trade', async () => {
      const { adapter, exchange } = setup();
      const eth = exchange.details.find(d => d.market_id === ETH)!;
      eth.last_trade_price = 4100;
      eth.mark_price = '4031.25';
      await expect(adapter.getTickerPrice('ETHUSDT')).resolves.toEqual({ symbol: 'ETHUSDT', price: '4031.25' });
      expect((await adapter.getAllTickerPrices()).find(p => p.symbol === 'ETHUSDT')).toEqual({ symbol: 'ETHUSDT', price: '4031.25' });
      delete eth.mark_price;   // No mark at all: the last trade is the only price
      await expect(adapter.getTickerPrice('ETHUSDT')).resolves.toEqual({ symbol: 'ETHUSDT', price: '4100' });
      const withStats = setup({ marketStats: id => (id === ETH ? { bestBid: 1, bestAsk: 2, markPrice: 4020.5, ageMs: 500 } : null) });
      await expect(withStats.adapter.getTickerPrice('ETHUSDT')).resolves.toEqual({ symbol: 'ETHUSDT', price: '4020.5' });
    });

    it('prefers a fresh market_stats mark over REST', async () => {
      const { adapter } = setup({ marketStats: id => (id === BTC ? { bestBid: 1, bestAsk: 2, markPrice: 97000.5, ageMs: 500 } : null) });
      await expect(adapter.getMarkPrice('BTCUSDT')).resolves.toMatchObject({ markPrice: '97000.5' });
    });

    it('maps candles to klines (missing volume -> "0") and refuses intervals Lighter lacks', async () => {
      const { adapter, exchange } = setup();
      exchange.candles = [
        { t: 1792289400000, o: 4050.1, h: 4060, l: 4040, c: 4055.5, v: 12.5 },
        { t: 1792289100000, o: 4040, h: 4051, l: 4039, c: 4050.1 },
      ];
      const klines = await adapter.getKlines('ETHUSDT', '5m', 2);
      expect(klines).toEqual([
        { openTime: 1792289100000, open: '4040', high: '4051', low: '4039', close: '4050.1', volume: '0' },
        { openTime: 1792289400000, open: '4050.1', high: '4060', low: '4040', close: '4055.5', volume: '12.5' },
      ]);
      const request = exchange.requests.find(r => r.url.includes('/api/v1/candles'))!;
      expect(request.url).toMatch(/market_id=0&resolution=5m&start_timestamp=\d+&end_timestamp=\d+&count_back=2/);
      await expect(adapter.getKlines('ETHUSDT', '3m', 10)).rejects.toThrow(/no 3m candles/);
    });

    it('groups individual resting orders into price levels', async () => {
      const { adapter, exchange } = setup();
      exchange.setBook(ETH, [['4049.90', '1.0000'], ['4049.90', '0.5000'], ['4049.50', '2.0000']], [['4050.20', '0.3000'], ['4050.10', '1.0000']]);
      const book = await adapter.getOrderBook('ETHUSDT', 5);
      expect(book.bids).toEqual([['4049.9', '1.5'], ['4049.5', '2']]);
      expect(book.asks).toEqual([['4050.1', '1'], ['4050.2', '0.3']]);
      await expect(adapter.getBookTicker('ETHUSDT')).resolves.toMatchObject({ bidPrice: '4049.9', bidQty: '1.5', askPrice: '4050.1', askQty: '1' });
    });
  });

  describe('account mapping', () => {
    it('maps positions to VenuePosition (signed size, leverage from IMF percent, cross/isolated)', async () => {
      const { adapter, exchange } = setup();
      exchange.setPosition(ETH, '-0.5000', { avg_entry_price: '4000.00', unrealized_pnl: '-25.000000', liquidation_price: '4800.00', position_value: '2025.000000' });
      exchange.setPosition(BTC, '0.01000', { initial_margin_fraction: '10.00', margin_mode: 1, allocated_margin: '100.000000', position_value: '973.124000' });
      exchange.setPosition(211, '3.00');   // BB: not mapped, left alone
      const positions = await adapter.getPositions();
      expect(positions).toHaveLength(2);
      expect(positions.find(p => p.symbol === 'ETHUSDT')).toMatchObject({
        positionAmt: '-0.5000', entryPrice: '4000.00', unRealizedProfit: '-25.000000', liquidationPrice: '4800.00',
        leverage: '5', marginType: 'cross', isolatedMargin: '0', positionSide: 'BOTH', markPrice: '4050',
      });
      expect(positions.find(p => p.symbol === 'BTCUSDT')).toMatchObject({ positionAmt: '0.01000', leverage: '10', marginType: 'isolated', isolatedMargin: '100.000000' });
      expect(await adapter.getPositions('BTCUSDT')).toHaveLength(1);
    });

    it('maps balances in USDC (never USDT) and the Binance account totals', async () => {
      const { adapter, exchange } = setup();
      exchange.setPosition(ETH, '0.5000', { unrealized_pnl: '12.500000', position_value: '2025.000000' });
      const [balance] = await adapter.getBalance();
      expect(balance).toMatchObject({ asset: 'USDC', balance: '1000', availableBalance: '800', crossWalletBalance: '1000', crossUnPnl: '12.5' });
      const info = await adapter.getAccountInfo();
      expect(info).toMatchObject({
        totalWalletBalance: '1000', availableBalance: '800', totalUnrealizedProfit: '12.5', totalPositionInitialMargin: '200',
        totalMarginBalance: '1012.5', totalMaintMargin: '120',
      });
      expect(info.assets[0].asset).toBe('USDC');
      expect(info.positions[0]).toMatchObject({ symbol: 'ETHUSDT', positionAmt: '0.5000', leverage: '5', positionSide: 'BOTH' });
    });

    it('is always one-way: getHedgeMode false, setHedgeMode(true) throws', async () => {
      const { adapter } = setup();
      await expect(adapter.getHedgeMode()).resolves.toBe(false);
      await expect(adapter.setHedgeMode(false)).resolves.toBeUndefined();
      await expect(adapter.setHedgeMode(true)).rejects.toThrow(/no hedge mode/);
    });
  });

  describe('placeOrder', () => {
    it('LIMIT GTC: tx 14, GTT with an explicit 28-day expiry, BUY price rounded down, confirmed before returning', async () => {
      const { adapter, exchange, clock } = setup();
      exchange.txPendingPolls = 2;   // status 1 twice before executed
      const before = clock.now;
      const order = await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.012345, price: 97312.47, timeInForce: 'GTC' }) as LighterPlacedOrder;
      const [tx] = sentTxs(exchange, 14);
      expect(tx.info).toMatchObject({ MarketIndex: BTC, BaseAmount: 1234, Price: 973124, IsAsk: 0, Type: 0, TimeInForce: 1, ReduceOnly: 0, TriggerPrice: 0, Nonce: 100 });
      expect(tx.info.OrderExpiry).toBeGreaterThanOrEqual(before + 28 * DAY);
      expect(tx.info.OrderExpiry).toBeLessThan(before + 28 * DAY + 60_000);
      const coi = tx.info.ClientOrderIndex;
      expect(Math.floor(coi / 10) % 10).toBe(1);   // role digit: entry
      expect(order).toMatchObject({ symbol: 'BTCUSDT', orderId: coi, side: 'BUY', type: 'LIMIT', status: 'NEW', quantity: 0.01234, price: 97312.4, lighterStatus: 'open' });
      expect(typeof order.orderId).toBe('number');   // Same type as getOpenOrders and o.i (OrderId rule)
      // Same id as getOpenOrders and the user stream (normalizeOrderId)
      const open = await adapter.getOpenOrders('BTCUSDT');
      expect(open.map(o => o.orderId)).toEqual([coi]);
      expect(normalizeOrderId(order.orderId)).toBe(coi);
    });

    it('LIMIT SELL rounds the price up; GTX is post-only, IOC has no expiry', async () => {
      const { adapter, exchange } = setup();
      await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', quantity: 0.012345, price: 97312.47, timeInForce: 'GTX' });
      await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.001, price: 97000, timeInForce: 'IOC' });
      const [gtx, ioc] = sentTxs(exchange, 14);
      expect(gtx.info).toMatchObject({ Price: 973125, IsAsk: 1, TimeInForce: 2 });
      expect(gtx.info.OrderExpiry).toBeGreaterThan(0);
      expect(ioc.info).toMatchObject({ TimeInForce: 0, OrderExpiry: 0, Nonce: 101 });
    });

    it('MARKET: explicit worst price from the REST book +- maxSlippageBps (BUY ceil, SELL floor)', async () => {
      const { adapter, exchange } = setup({ symbolSettings: symbol => (symbol === 'DOGEUSDT' ? { maxSlippageBps: 20 } : undefined) });
      exchange.setBook(ETH, [['4049.90', '2.0000']], [['4050.10', '1.0000']]);
      await adapter.placeOrder({ symbol: 'ETHUSDT', side: 'BUY', type: 'MARKET', quantity: 0.1 });
      await adapter.placeOrder({ symbol: 'ETHUSDT', side: 'SELL', type: 'MARKET', quantity: 0.1 });
      const [buy, sell] = sentTxs(exchange, 14);
      // 4050.10 x 1.005 = 4070.3505 -> 407036; 4049.90 x 0.995 = 4029.6505 -> 402965
      expect(buy.info).toMatchObject({ Type: 1, TimeInForce: 0, OrderExpiry: 0, TriggerPrice: 0, Price: 407036, BaseAmount: 1000 });
      expect(sell.info).toMatchObject({ Type: 1, Price: 402965, IsAsk: 1 });
    });

    it('MARKET prefers a fresh market_stats BBO and falls back to REST when it is stale', async () => {
      let age = 100;
      const { adapter, exchange } = setup({ marketStats: id => (id === ETH ? { bestBid: 3999.5, bestAsk: 4000, markPrice: 4000, ageMs: age } : null) });
      exchange.setBook(ETH, [['4049.90', '2.0000']], [['4050.10', '1.0000']]);
      await adapter.placeOrder({ symbol: 'ETHUSDT', side: 'BUY', type: 'MARKET', quantity: 0.1 });
      age = 5000;
      await adapter.placeOrder({ symbol: 'ETHUSDT', side: 'BUY', type: 'MARKET', quantity: 0.1 });
      const [fresh, stale] = sentTxs(exchange, 14);
      expect(fresh.info.Price).toBe(402000);   // 4000 x 1.005
      expect(stale.info.Price).toBe(407036);
    });

    it('reports an order the exchange cancelled at once (no fill) as a failure, never as placed', async () => {
      const { adapter, exchange } = setup();
      exchange.setBook(ETH, [['4049.90', '2.0000']], [['4050.10', '1.0000']]);
      exchange.orderOutcome = order => (order.type === 'market'
        ? { status: 'canceled-too-much-slippage', filled_base_amount: '0.0000', filled_quote_amount: '0.000000', remaining_base_amount: '0.1000' }
        : undefined);
      await expect(adapter.placeOrder({ symbol: 'ETHUSDT', side: 'BUY', type: 'MARKET', quantity: 0.1 })).rejects.toThrow(/canceled-too-much-slippage/);
    });

    it('never treats an accepted tx as done: a failed execution throws', async () => {
      const { adapter, exchange } = setup();
      exchange.txFailure = { code: 21701, message: 'not enough margin' };
      const error = await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 97000 }).catch(e => e);
      expect(error).toBeInstanceOf(LighterTxFailedError);
      expect(error.response.data).toMatchObject({ code: 21701, msg: 'not enough margin' });
    });

    it('confirmation timeout: an accepted tx that never shows up is not reported as placed', async () => {
      const { adapter, exchange } = setup();
      // Accepted (200) but never executed
      exchange.sendResponders.push(() => ({ status: 200, data: { code: 200, tx_hash: 'x', predicted_execution_time_ms: 1, volume_quota_remaining: 1 } }));
      const error = await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 97000 }).catch(e => e);
      expect(error).toBeInstanceOf(LighterTxUnknownError);
      expect(error.message).toMatch(/not confirmed within the timeout/);
      // It may still execute: callers must not place a replacement, until the tx's ExpiredAt has passed
      expect(orderMayExist(error)).toBe(true);
      const sent = sentTxs(exchange, 14)[0];
      expect(error.expiredAt).toBe(sent.info.ExpiredAt);
      expect(orderMayExistUntil(error)).toBe(sent.info.ExpiredAt + 5000);
      expect(exchange.orders).toHaveLength(0);
    });

    it('definite failures are classified as not placed', async () => {
      const { adapter, exchange } = setup();
      exchange.txFailure = { code: 21701, message: 'not enough margin' };
      const failed = await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 97000 }).catch(e => e);
      expect(isDefinitelyNotPlaced(failed)).toBe(true);
      const invalid = await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 97000, timeInForce: 'FOK' }).catch(e => e);
      expect(isDefinitelyNotPlaced(invalid)).toBe(true);
    });

    it('rejects what Lighter cannot do: FOK, hedge position sides, closePosition, unknown and x1000 symbols', async () => {
      const { adapter, exchange } = setup();
      await expect(adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 97000, timeInForce: 'FOK' })).rejects.toThrow(/fill-or-kill/);
      const hedge = await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 97000, positionSide: 'LONG' }).catch(e => e);
      expect(hedge.response.data.code).toBe(-4061);
      await expect(adapter.placeOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', quantity: 0.01, stopPrice: 90000, closePosition: true } as any)).rejects.toThrow(/closePosition/);
      await expect(adapter.placeOrder({ symbol: 'XRPUSDT', side: 'BUY', type: 'LIMIT', quantity: 10, price: 2 })).rejects.toThrow(/no Lighter market/);
      await expect(adapter.placeOrder({ symbol: 'NOTUSDT', side: 'BUY', type: 'LIMIT', quantity: 10, price: 2 })).rejects.toThrow(/liquidation feed only/);
      expect(sendTxCount(exchange)).toBe(0);
    });

    it('enforces market minimums before signing', async () => {
      const { adapter, exchange } = setup();
      // 0.00005 BTC is below min_base_amount 0.00010
      await expect(adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.00005, price: 97000 })).rejects.toThrow(/below the minimum/);
      expect(sendTxCount(exchange)).toBe(0);
    });

    it('untradable markets refuse new positions but still accept reduce-only orders', async () => {
      const { adapter, exchange } = setup();
      await expect(adapter.placeOrder({ symbol: 'QNTUSDT', side: 'BUY', type: 'LIMIT', quantity: 1, price: 100 })).rejects.toThrow(/does not accept new positions/);
      exchange.setPosition(QNT, '2.000');
      await adapter.placeOrder({ symbol: 'QNTUSDT', side: 'SELL', type: 'LIMIT', quantity: 1, price: 100, reduceOnly: true });
      expect(sentTxs(exchange, 14)[0].info).toMatchObject({ MarketIndex: QNT, ReduceOnly: 1, BaseAmount: 1000, IsAsk: 1 });
    });

    it('reduce-only orders are sized from the confirmed position and refused without one', async () => {
      const { adapter, exchange } = setup();
      exchange.setBook(ETH, [['4049.90', '2.0000']], [['4050.10', '1.0000']]);
      exchange.setPosition(ETH, '0.5000');
      await adapter.placeOrder({ symbol: 'ETHUSDT', side: 'SELL', type: 'MARKET', quantity: 0.8, reduceOnly: true });
      expect(sentTxs(exchange, 14)[0].info).toMatchObject({ BaseAmount: 5000, ReduceOnly: 1 });
      const wrongSide = await adapter.placeOrder({ symbol: 'ETHUSDT', side: 'BUY', type: 'MARKET', quantity: 0.1, reduceOnly: true }).catch(e => e);
      expect(wrongSide.response.data.code).toBe(-2022);
      expect(wrongSide.message).toMatch(/needs a short position/);
    });

    it('refuses new positions in a market at its open interest cap (fresh market_stats), before any tx', async () => {
      let stats: Record<string, number | null> = { openInterest: 2_500_000, openInterestLimit: 5_000_000_000_000, openInterestAgeMs: 2000 };
      const { adapter, exchange } = setup({ marketStats: id => (id === ETH ? { bestBid: null, bestAsk: null, markPrice: 4050, ageMs: 500, ...stats } : null) });
      exchange.setBook(ETH, [['4049.90', '2.0000']], [['4050.10', '1.0000']]);
      await expect(adapter.placeOrder({ symbol: 'ETHUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.1, price: 4000 })).rejects.toThrow(/open interest cap/);
      await expect(adapter.placeOrder({ symbol: 'ETHUSDT', side: 'BUY', type: 'MARKET', quantity: 0.1 })).rejects.toThrow(/open interest cap/);
      expect(sendTxCount(exchange)).toBe(0);
      // Reduce-only orders are what the exchange still accepts there
      exchange.setPosition(ETH, '0.5000');
      await adapter.placeOrder({ symbol: 'ETHUSDT', side: 'SELL', type: 'MARKET', quantity: 0.5, reduceOnly: true });
      expect(sentTxs(exchange, 14)).toHaveLength(1);
      // Below the cap, stale or unreadable open interest: the entry goes out (the exchange's own refusal is handled)
      for (const next of [
        { openInterest: 2_499_999, openInterestLimit: 5_000_000_000_000, openInterestAgeMs: 2000 },
        { openInterest: 2_500_000, openInterestLimit: 5_000_000_000_000, openInterestAgeMs: 120_000 },
        { openInterest: null, openInterestLimit: null, openInterestAgeMs: null },
      ]) {
        stats = next;
        await adapter.placeOrder({ symbol: 'ETHUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.1, price: 4000 });
      }
      expect(sentTxs(exchange, 14)).toHaveLength(4);
    });

    it('STOP_MARKET / TAKE_PROFIT_MARKET: reduce-only forced, trigger vs mark, worst price 1% beyond the trigger', async () => {
      const { adapter, exchange } = setup();
      exchange.setPosition(ETH, '0.5000');
      const sl = await adapter.placeOrder({ symbol: 'ETHUSDT', side: 'SELL', type: 'STOP_MARKET', quantity: 0.5, stopPrice: 3900, reduceOnly: false, newClientOrderId: 'al_sl_ETHUSDT_1' } as any);
      await adapter.placeOrder({ symbol: 'ETHUSDT', side: 'SELL', type: 'TAKE_PROFIT_MARKET', quantity: 0.5, stopPrice: 4200 });
      const [slTx, tpTx] = sentTxs(exchange, 14);
      expect(slTx.info).toMatchObject({ Type: 2, TimeInForce: 0, ReduceOnly: 1, TriggerPrice: 390000, Price: 386100, BaseAmount: 5000, IsAsk: 1 });
      expect(slTx.info.OrderExpiry).toBeGreaterThan(0);
      expect(tpTx.info).toMatchObject({ Type: 4, ReduceOnly: 1, TriggerPrice: 420000, Price: 415800 });
      expect(Math.floor(slTx.info.ClientOrderIndex / 10) % 10).toBe(2);
      expect(Math.floor(tpTx.info.ClientOrderIndex / 10) % 10).toBe(3);
      expect(sl).toMatchObject({ type: 'STOP_MARKET', status: 'NEW', clientOrderId: 'al_sl_ETHUSDT_1', lighterStatus: 'pending' });
      // Open orders carry the bot's client order id from the journal
      const open = await adapter.getOpenOrders('ETHUSDT');
      expect(open.find(o => o.type === 'STOP_MARKET')).toMatchObject({ clientOrderId: 'al_sl_ETHUSDT_1', reduceOnly: true, stopPrice: '3900', price: '0', status: 'NEW' });
      // A stop already crossed (above mark for a long) would fire at once
      await expect(adapter.placeOrder({ symbol: 'ETHUSDT', side: 'SELL', type: 'STOP_MARKET', quantity: 0.5, stopPrice: 4100 }))
        .rejects.toThrow(/must be below the mark price/);
      expect(sentTxs(exchange, 14)).toHaveLength(2);
    });
  });

  describe('placeProtectiveOrders (native OCO)', () => {
    it('sends one grouped tx: SL type 2 + TP type 4, reduce-only, equal size from the position, one explicit expiry', async () => {
      const { adapter, exchange, clock } = setup();
      exchange.setPosition(ETH, '0.5000');
      const before = clock.now;
      const result = await adapter.placeProtectiveOrders({ symbol: 'ETHUSDT', side: 'SELL', quantity: 0.6, stopLossPrice: 3900, takeProfitPrice: 4200, positionSide: 'BOTH', reduceOnly: false });
      // Cut to the position (0.5 of the requested 0.6): placed, and reported so the position manager re-checks
      expect(result.errors).toEqual([expect.stringMatching(/SL\/TP SELL ETHUSDT sized 0\.5\d*, below the requested 0\.6/)]);
      const [tx] = sentTxs(exchange, 28);
      expect(tx.info.GroupingType).toBe(2);
      const [sl, tp] = tx.info.Orders;
      expect(sl).toMatchObject({ Type: 2, TimeInForce: 0, ReduceOnly: 1, IsAsk: 1, BaseAmount: 5000, TriggerPrice: 390000, Price: 386100 });
      expect(tp).toMatchObject({ Type: 4, TimeInForce: 0, ReduceOnly: 1, IsAsk: 1, BaseAmount: 5000, TriggerPrice: 420000, Price: 415800 });
      expect(sl.OrderExpiry).toBe(tp.OrderExpiry);
      expect(sl.OrderExpiry).toBeGreaterThanOrEqual(before + 28 * DAY);
      expect(sentTxs(exchange, 14)).toHaveLength(0);
      expect(result.stopLoss).toMatchObject({ orderId: sl.ClientOrderIndex, type: 'STOP_MARKET', status: 'NEW' });
      expect(result.takeProfit).toMatchObject({ orderId: tp.ClientOrderIndex, type: 'TAKE_PROFIT_MARKET', status: 'NEW' });
      expect(result.stopLoss?.clientOrderId).toMatch(/^al_sl_ETHUSDT_/);
      expect(result.takeProfit?.clientOrderId).toMatch(/^al_tp_ETHUSDT_/);
    });

    it('protects a short with BUY legs (SL above mark, TP below)', async () => {
      const { adapter, exchange } = setup();
      exchange.setPosition(ETH, '-0.2000');
      const result = await adapter.placeProtectiveOrders({ symbol: 'ETHUSDT', side: 'BUY', quantity: 0.2, stopLossPrice: 4200, takeProfitPrice: 3900 });
      expect(result.errors).toEqual([]);
      const [sl, tp] = sentTxs(exchange, 28)[0].info.Orders;
      expect(sl).toMatchObject({ IsAsk: 0, BaseAmount: 2000, TriggerPrice: 420000, Price: 424200 });
      expect(tp).toMatchObject({ IsAsk: 0, TriggerPrice: 390000, Price: 393900 });
    });

    it('falls back to two orders in one sendTxBatch when the exchange refuses the OCO', async () => {
      const { adapter, exchange } = setup();
      exchange.setPosition(ETH, '0.5000');
      exchange.rejectGrouped = { code: 21730, message: 'invalid grouped order' };
      const result = await adapter.placeProtectiveOrders({ symbol: 'ETHUSDT', side: 'SELL', quantity: 0.5, stopLossPrice: 3900, takeProfitPrice: 4200 });
      expect(result.errors).toEqual([]);
      expect(sentTxs(exchange, 28).every(tx => !tx.accepted)).toBe(true);
      const singles = sentTxs(exchange, 14);
      expect(singles).toHaveLength(2);
      expect(singles.map(tx => tx.info.Nonce)).toEqual([100, 101]);   // consecutive, same key
      expect(singles.map(tx => tx.info.Type)).toEqual([2, 4]);
      expect(singles.every(tx => tx.info.ReduceOnly === 1 && tx.info.BaseAmount === 5000)).toBe(true);
      expect(singles[0].info.OrderExpiry).toBe(singles[1].info.OrderExpiry);
      expect(exchange.requests.filter(r => r.url.endsWith('/api/v1/sendTxBatch'))).toHaveLength(1);
      expect(result.stopLoss && result.takeProfit).toBeTruthy();
      expect(result.mayExist).toBeFalsy();
    });

    it('does not fall back when the OCO outcome is unknown (it may exist)', async () => {
      const { adapter, exchange } = setup();
      exchange.setPosition(ETH, '0.5000');
      exchange.sendResponders.push(() => ({ status: 200, data: { code: 200, tx_hash: 'x', predicted_execution_time_ms: 1, volume_quota_remaining: 1 } }));
      const result = await adapter.placeProtectiveOrders({ symbol: 'ETHUSDT', side: 'SELL', quantity: 0.5, stopLossPrice: 3900, takeProfitPrice: 4200 });
      expect(result.stopLoss).toBeUndefined();
      expect(result.takeProfit).toBeUndefined();
      expect(result.errors).toHaveLength(2);
      expect(result.mayExist).toBe(true);
      expect(sentTxs(exchange, 14)).toHaveLength(0);
    });

    it('waits briefly for REST /account to show a position the stream already reported', async () => {
      let accountReads = 0;
      const { adapter, exchange } = setup({
        transport: async request => {
          if (new URL(request.url).pathname === '/api/v1/account' && ++accountReads === 3) exchange.setPosition(ETH, '0.5000');
          return exchange.transport(request);
        },
      });
      await adapter.verifyStartup();
      accountReads = 0;
      const result = await adapter.placeProtectiveOrders({ symbol: 'ETHUSDT', side: 'SELL', quantity: 0.5, stopLossPrice: 3900, takeProfitPrice: 4200 });
      expect(result.errors).toEqual([]);
      expect(accountReads).toBe(3);                 // Two empty replies, then the position
      expect(sentTxs(exchange, 28)[0].info.Orders.map((o: any) => o.BaseAmount)).toEqual([5000, 5000]);
    });

    it('returns per-leg errors without sending anything when there is no position or a trigger is crossed', async () => {
      const { adapter, exchange } = setup();
      const none = await adapter.placeProtectiveOrders({ symbol: 'ETHUSDT', side: 'SELL', quantity: 0.5, stopLossPrice: 3900, takeProfitPrice: 4200 });
      expect(none.errors).toEqual([expect.stringMatching(/^SL: .*long position/), expect.stringMatching(/^TP: .*long position/)]);
      exchange.setPosition(ETH, '0.5000');
      const crossed = await adapter.placeProtectiveOrders({ symbol: 'ETHUSDT', side: 'SELL', quantity: 0.5, stopLossPrice: 3900, takeProfitPrice: 4000 });
      expect(crossed.errors[0]).toMatch(/take profit trigger .* must be above the mark price/);
      expect(sendTxCount(exchange)).toBe(0);
    });
  });

  describe('cancelOrder / cancelAllOrders', () => {
    it('cancels by client order index (tx 15) and confirms the order is terminal', async () => {
      const { adapter, exchange } = setup();
      const order = await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 97000 });
      const id = normalizeOrderId(order.orderId);
      const result = await adapter.cancelOrder('BTCUSDT', id);
      const [tx] = sentTxs(exchange, 15);
      expect(tx.info).toMatchObject({ MarketIndex: BTC, Index: id });
      expect(result).toMatchObject({ orderId: id, status: 'CANCELED', alreadyTerminal: false });
    });

    it('treats an already terminal order (e.g. the OCO sibling) as cancelled without sending a tx', async () => {
      const { adapter, exchange } = setup();
      const order = await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 97000 });
      exchange.findOrder(Number(order.orderId))!.status = 'canceled-oco';
      const result = await adapter.cancelOrder('BTCUSDT', order.orderId);
      expect(result).toMatchObject({ status: 'CANCELED', alreadyTerminal: true });
      expect(sentTxs(exchange, 15)).toHaveLength(0);
    });

    it('raises Binance code -2011 for an unknown order, but never for a failed lookup', async () => {
      const { adapter, exchange } = setup();
      await adapter.verifyStartup();
      const unknown = await adapter.cancelOrder('BTCUSDT', 17922894012345).catch(e => e);
      expect(unknown.response.data.code).toBe(-2011);
      exchange.privateFailures = 1;
      const failed = await adapter.cancelOrder('BTCUSDT', 17922894012345).catch(e => e);
      expect(failed.response?.data?.code).not.toBe(-2011);
      expect(sentTxs(exchange, 15)).toHaveLength(0);
    });

    it('refuses to cancel an order of another market', async () => {
      const { adapter } = setup();
      const order = await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 97000 });
      await expect(adapter.cancelOrder('ETHUSDT', order.orderId)).rejects.toThrow(/belongs to market 1/);
    });

    it('cancels a foreign order by its exact order_index above 2^53 (string id, sent verbatim)', async () => {
      const { adapter, exchange } = setup();
      const bigId = '576460752303423611';
      exchange.orders.push({
        order_index: Number(bigId), order_id: bigId, client_order_index: 0, market_index: BTC, initial_base_amount: '0.01000',
        filled_base_amount: '0.00000', price: '95000.0', is_ask: false, type: 'limit', time_in_force: 'good-till-time',
        reduce_only: false, trigger_price: '0.0', status: 'open', created_at: 1792289401,
      });
      const [open] = await adapter.getOpenOrders();
      expect(open.orderId).toBe(bigId);
      expect(lighterOrderId({ clientOrderIndex: 0, orderId: bigId })).toBe(bigId);
      await adapter.cancelOrder('BTCUSDT', open.orderId);
      const [tx] = sentTxs(exchange, 15);
      expect(tx.txInfo).toContain(`"Index":${bigId}`);
      expect(exchange.orders[0].status).toBe('canceled');
    });

    it('cancelAllOrders sends an immediate cancel-all scoped to the market (tx 16)', async () => {
      const { adapter, exchange } = setup();
      await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 97000 });
      const result = await adapter.cancelAllOrders('BTCUSDT');
      const [tx] = sentTxs(exchange, 16);
      expect(tx.info).toMatchObject({ TimeInForce: 0, Time: 0, L2TxAttributes: { 5: BTC } });
      expect(result).toMatchObject({ code: 200 });
      expect(exchange.orders.every(o => o.status === 'canceled')).toBe(true);
    });
  });

  describe('setLeverage', () => {
    it('sends imf = ceil(10000 / leverage), skips an unchanged value, caps at the market maximum, emits ACCOUNT_CONFIG_UPDATE', async () => {
      const events: UserDataEvent[] = [];
      const createUserStream: CreateLighterUserStream = async () => ({ close: async () => undefined });
      const { adapter, exchange } = setup({ createUserStream });
      exchange.setPosition(BTC, '0', { initial_margin_fraction: '20.00' });
      await adapter.subscribeUserData({ onEvent: event => events.push(event) });

      const result = await adapter.setLeverage('BTCUSDT', 20);
      expect(sentTxs(exchange, 20)[0].info).toMatchObject({ MarketIndex: BTC, InitialMarginFraction: 500, MarginMode: 0 });
      expect(result).toMatchObject({ symbol: 'BTCUSDT', leverage: 20, initialMarginFraction: 500 });
      expect(events).toEqual([expect.objectContaining({ e: 'ACCOUNT_CONFIG_UPDATE', ac: { s: 'BTCUSDT', l: 20 } })]);

      await expect(adapter.setLeverage('BTCUSDT', 20)).resolves.toMatchObject({ unchanged: true });
      expect(sentTxs(exchange, 20)).toHaveLength(1);

      await adapter.setLeverage('BTCUSDT', 75);   // BTC max 50x (min IMF 200)
      expect(sentTxs(exchange, 20)[1].info.InitialMarginFraction).toBe(200);
    });

    it('throws when the account does not show the new leverage after execution', async () => {
      const { adapter, exchange } = setup();
      exchange.setPosition(BTC, '0', { initial_margin_fraction: '20.00' });
      exchange.ignoreLeverage = true;
      await expect(adapter.setLeverage('BTCUSDT', 10)).rejects.toThrow(/instead of 1000/);
    });
  });

  describe('nonce flow through the adapter', () => {
    it('unknown outcome (HTTP 503): resolves via tx lookup / nextNonce and resends the identical tx, never re-signing', async () => {
      const { adapter, exchange, signer } = setup();
      exchange.sendResponders.push(() => ({ status: 503, data: 'upstream unavailable' }));
      const order = await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 97000 });
      const sends = sentTxs(exchange, 14);
      expect(sends).toHaveLength(2);
      expect(sends[1].txInfo).toBe(sends[0].txInfo);   // identical bytes
      expect(sends.filter(tx => tx.accepted)).toHaveLength(1);
      expect(signer.calls.filter(c => c === 'signCreateOrder')).toHaveLength(1);
      expect(exchange.orders.filter(o => o.client_order_index === Number(order.orderId))).toHaveLength(1);
    });

    it('executed but the answer was lost: found by tx lookup, nothing resent', async () => {
      const { adapter, exchange, signer } = setup();
      exchange.sendResponders.push(() => 'drop');
      await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 97000 });
      expect(sentTxs(exchange, 14)).toHaveLength(1);
      expect(signer.calls.filter(c => c === 'signCreateOrder')).toHaveLength(1);
      // The next tx uses the next nonce
      await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 96000 });
      expect(sentTxs(exchange, 14)[1].info.Nonce).toBe(101);
    });

    it('invalid nonce (21104): fetches nextNonce and signs again', async () => {
      const { adapter, exchange, signer } = setup();
      await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 97000 });
      exchange.nextNonce = 150;   // Another client used the key meanwhile; the local counter says 101
      await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 96000 });
      const sends = sentTxs(exchange, 14);
      expect(sends.map(tx => [tx.info.Nonce, tx.accepted])).toEqual([[100, true], [101, false], [150, true]]);
      expect(signer.calls.filter(c => c === 'signCreateOrder')).toHaveLength(3);
    });

    it('requests made while an unknown outcome is resolved are cut to what is left of the lock bound', async () => {
      const { adapter, exchange } = setup({ maxLockedResolveMs: 3000 });
      await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 96000 });   // startup checks
      exchange.sendResponders.push(() => ({ status: 503, data: 'upstream unavailable' }));
      const before = exchange.requests.length;
      await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 97000 });
      const requests = exchange.requests.slice(before);
      const posts = requests.flatMap((r, i) => (r.method === 'POST' ? [i] : []));
      expect(posts.length).toBeGreaterThanOrEqual(2);
      // From after the unanswered send through the accepted resend: tx lookups, nextNonce and the resend itself
      const resolving = requests.slice(posts[0] + 1, posts[1] + 1);
      expect(resolving.map(r => r.method)).toContain('GET');
      for (const request of resolving) expect(request.timeoutMs).toBeLessThanOrEqual(3000);
    });

    it('close() stops background tx settling on every nonce manager it made', async () => {
      const { adapter } = setup();
      await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 97000 });
      const dispose = jest.spyOn(LighterNonceManager.prototype, 'dispose');
      try {
        adapter.close();
        expect(dispose).toHaveBeenCalledTimes(1);
      } finally {
        dispose.mockRestore();
      }
    });

    it('serializes concurrent txs on one key: nonces strictly in order, no interleaving', async () => {
      const { adapter, exchange } = setup();
      await Promise.all([
        adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 97000 }),
        adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 96000 }),
        adapter.placeOrder({ symbol: 'ETHUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.1, price: 4000 }),
      ]);
      expect(sentTxs(exchange, 14).map(tx => [tx.info.Nonce, tx.accepted])).toEqual([[100, true], [101, true], [102, true]]);
    });
  });

  describe('user data', () => {
    it('delegates subscribeUserData to the account stream with profile-bound deps', async () => {
      let captured: Parameters<CreateLighterUserStream>[0] | null = null;
      const close = jest.fn(async () => undefined);
      const createUserStream: CreateLighterUserStream = async deps => {
        captured = deps;
        return { close };
      };
      const { adapter, markets } = setup({ createUserStream });
      const subscription = await adapter.subscribeUserData({ onEvent: () => undefined });
      expect(captured).not.toBeNull();
      const deps = captured!;
      expect(deps.profile.name).toBe('testnet');
      expect(deps.accountIndex).toBe(TEST_ACCOUNT);
      expect(deps.apiKeyIndex).toBe(TEST_KEY_INDEX);
      expect(deps.markets).toBe(markets);
      expect(deps.http).toBe(adapter.http);
      await expect(deps.getAuthToken()).resolves.toMatch(new RegExp(`^\\d+:${TEST_ACCOUNT}:${TEST_KEY_INDEX}:[0-9a-f]{160}$`));
      await subscription.close();
      await subscription.close();
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('runs the real account stream: REST baseline through the adapter client, auth token on private subscribes', async () => {
      const sockets = fakeSocketFactory();
      const { adapter, exchange } = setup({ wsFactory: sockets.factory });
      exchange.setPosition(ETH, '0.5000');
      const subscription = await adapter.subscribeUserData({ onEvent: () => undefined });
      try {
        // The REST baseline used the adapter's HTTP client, with the stream's own authorization header
        const active = exchange.requests.find(r => r.url.includes('/api/v1/accountActiveOrders'));
        expect(active?.headers?.authorization).toMatch(new RegExp(`^\\d+:${TEST_ACCOUNT}:${TEST_KEY_INDEX}:[0-9a-f]{160}$`));
        expect(exchange.requests.some(r => r.url.includes('/api/v1/account?'))).toBe(true);
        const socket = sockets.last();
        expect(socket.url).toBe('wss://testnet.zklighter.elliot.ai/stream?readonly=true&encoding=json');
        socket.open();
        socket.serverSend({ type: 'connected', session_id: 'session-1' });
        const privateSubscribes = socket.sent.filter(m => m.type === 'subscribe' && String(m.channel).includes(String(TEST_ACCOUNT)));
        expect(privateSubscribes.length).toBeGreaterThan(0);
        for (const message of privateSubscribes) expect(message.auth).toBe(active?.headers?.authorization);
      } finally {
        await subscription.close();
      }
    });

    it('createAccountStream converts ACCOUNT_UPDATE to the balance service shape', async () => {
      let handlers: Parameters<CreateLighterUserStream>[1] | null = null;
      const { adapter } = setup({ createUserStream: async (_deps, h) => { handlers = h; return { close: async () => undefined }; } });
      const stream = adapter.createAccountStream();
      expect(stream).toBeInstanceOf(LighterAccountStream);
      const updates: any[] = [];
      await stream.start(update => updates.push(update));
      expect(stream.isHealthy()).toBe(true);
      handlers!.onEvent({ e: 'ORDER_TRADE_UPDATE', E: 1, o: { s: 'BTCUSDT', S: 'BUY', o: 'LIMIT', q: '1', X: 'NEW', i: 1 } });
      handlers!.onEvent({
        e: 'ACCOUNT_UPDATE', E: 5, a: { m: 'ORDER', B: [{ a: 'USDC', wb: '1000', cw: '900' }], P: [{ s: 'ETHUSDT', pa: '0.5', ep: '4000', up: '1', mt: 'cross' }] },
      });
      expect(updates).toEqual([{
        eventType: 'ACCOUNT_UPDATE', eventTime: 5, transactionTime: 5,
        updateData: {
          reasonType: 'ORDER',
          balances: [{ asset: 'USDC', walletBalance: '1000', crossWalletBalance: '900', balanceChange: '0' }],
          positions: [{ symbol: 'ETHUSDT', positionAmount: '0.5', entryPrice: '4000', accumulatedRealized: '0', unrealizedPnL: '1', marginType: 'cross', isolatedWallet: '0', positionSide: 'BOTH' }],
        },
      }]);
      await stream.stop();
      expect(stream.isHealthy()).toBe(false);
    });
  });
});

describe('Lighter order mapping (same values as the account stream)', () => {
  const base = {
    order_id: '281474976711000', client_order_index: 17922894012121, market_index: 0, is_ask: true,
    initial_base_amount: '0.5000', filled_base_amount: '0.0000', filled_quote_amount: '0.000000', price: '4158.00',
    trigger_price: '4200.00', reduce_only: true, created_at: 1792289401, updated_at: 1792289402,
  };

  it('maps statuses like the stream: an untriggered SL/TP cancel is CANCELED, an IOC limit cancel EXPIRED, unknown is null', () => {
    const cases: Array<[Record<string, unknown>, string | null]> = [
      [{ status: 'pending', type: 'take-profit', time_in_force: 'immediate-or-cancel' }, 'NEW'],
      [{ status: 'open', type: 'limit', time_in_force: 'good-till-time', filled_base_amount: '0.1000' }, 'PARTIALLY_FILLED'],
      [{ status: 'filled', type: 'market', time_in_force: 'immediate-or-cancel' }, 'FILLED'],
      [{ status: 'canceled-oco', type: 'stop-loss', time_in_force: 'immediate-or-cancel' }, 'CANCELED'],
      [{ status: 'canceled-not-enough-liquidity', type: 'limit', time_in_force: 'immediate-or-cancel' }, 'EXPIRED'],
      [{ status: 'canceled-too-much-slippage', type: 'market', time_in_force: 'immediate-or-cancel' }, 'EXPIRED'],
      [{ status: 'canceled-post-only', type: 'limit', time_in_force: 'post-only' }, 'EXPIRED'],
      [{ status: 'canceled', type: 'limit', time_in_force: 'good-till-time' }, 'CANCELED'],
      [{ status: 'something-new', type: 'limit', time_in_force: 'good-till-time' }, null],
    ];
    for (const [fields, expected] of cases) {
      expect(lighterOrderStatus({ ...base, ...fields })).toBe(expected);
    }
  });

  it('builds VenueOrders with Binance types and ids that survive int64', () => {
    const order = toLighterVenueOrder({ ...base, type: 'take-profit', status: 'pending', time_in_force: 'immediate-or-cancel' }, 'ETHUSDT', undefined, 0);
    expect(order).toMatchObject({
      symbol: 'ETHUSDT', orderId: 17922894012121, clientOrderId: '17922894012121', type: 'TAKE_PROFIT_MARKET', origType: 'TAKE_PROFIT_MARKET',
      side: 'SELL', price: '0', stopPrice: '4200', origQty: '0.5', reduceOnly: true, status: 'NEW', time: 1792289401000,
      updateTime: 1792289402000, positionSide: 'BOTH', workingType: 'MARK_PRICE', lighterPrice: '4158', timeInForce: 'IOC',
    });
    expect(toLighterVenueOrder({ ...base, client_order_index: 0, order_id: '576460752303423611', type: 'limit', status: 'open', time_in_force: 'good-till-time' }, 'ETHUSDT', undefined).orderId)
      .toBe('576460752303423611');
    expect(() => toLighterVenueOrder({ ...base, status: undefined, type: 'limit' }, 'ETHUSDT', undefined)).toThrow(/without id, market, side, status or type/);
  });
});
