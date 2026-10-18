/**
 * @jest-environment node
 */
// LighterHedgeAdapter (hedge mode emulated with two sub-accounts) against two offline fake accounts on one fake
// exchange: routing and guards, client order index ranges, cancel routing, merged reads, per-side margin, the merged
// user stream and the startup checks. Nothing touches the network.
import {
  LighterAdapter,
  LighterOrderError,
  sumLighterDecimals,
  type LighterAdapterOptions,
} from '../../../src/lib/exchange/lighter/LighterAdapter';
import {
  LIGHTER_HEDGE_CAPABILITIES,
  LIGHTER_HEDGE_ONE_WAY_MESSAGE,
  LIGHTER_HEDGE_POSITION_SIDE_MESSAGE,
  LighterHedgeAdapter,
  LighterHedgeError,
  isLighterHedgeAdapter,
} from '../../../src/lib/exchange/lighter/LighterHedgeAdapter';
import { LIGHTER_CAPABILITIES } from '../../../src/lib/exchange/lighter/capabilities';
import { LighterMarketCache } from '../../../src/lib/exchange/lighter/markets';
import {
  LIGHTER_HEDGE_COI_RANGES,
  LIGHTER_HEDGE_COI_SPAN,
  LighterTxFailedError,
  clientOrderIndexRole,
  lighterHedgeSideOfClientOrderIndex,
} from '../../../src/lib/exchange/lighter/nonce';
import type { AccountUpdate } from '../../../src/lib/api/userDataStream';
import { orderMayExist, orderRefusalRepeats } from '../../../src/lib/exchange/orderErrors';
import type {
  AccountUpdateEvent,
  OrderTradeUpdateEvent,
  UserDataBalance,
  UserDataEvent,
  UserDataHandlers,
  UserDataPosition,
  UserDataSubscription,
  VenuePosition,
} from '../../../src/lib/exchange/types';
import { FakeLighterSigner, TEST_PUBLIC_KEY } from './fakeLighterExchange';
import {
  HEDGE_CREDENTIALS,
  HEDGE_L1_ADDRESS,
  HEDGE_LONG_ACCOUNT,
  HEDGE_LONG_KEY,
  HEDGE_SHORT_ACCOUNT,
  HEDGE_SHORT_KEY,
  lighterHedgeHarness,
  type LighterHedgeHarness,
  type LighterHedgeHarnessOptions,
} from './fakeLighterHedge';

const ETH = 0;   // size decimals 4, price decimals 2, mark 4050
const BTC = 1;   // size decimals 5, price decimals 1, mark 97312.4

const openSubscriptions: UserDataSubscription[] = [];

afterEach(async () => {
  while (openSubscriptions.length > 0) await openSubscriptions.pop()?.close();
  jest.restoreAllMocks();
});

function setup(options: LighterHedgeHarnessOptions = {}): LighterHedgeHarness {
  return lighterHedgeHarness({ credentials: true, ...options });
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await wait(2);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function requestsTo(h: LighterHedgeHarness, side: 'LONG' | 'SHORT', pathname?: string) {
  return h.exchange.routed.filter(r => r.side === side && (pathname === undefined || new URL(r.request.url).pathname === pathname));
}

const limitEntry = (positionSide: 'LONG' | 'SHORT', overrides: Record<string, unknown> = {}) => ({
  symbol: 'ETHUSDT',
  side: (positionSide === 'LONG' ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
  type: 'LIMIT' as const,
  quantity: 0.5,
  price: positionSide === 'LONG' ? 4000 : 4100,
  timeInForce: 'GTC' as const,
  positionSide,
  ...overrides,
});

// ===== User data builders =====

function pos(s: string, pa: string, ep = '4000', extra: Partial<UserDataPosition> = {}): UserDataPosition {
  return { s, pa, ep, up: '0', mt: 'cross', iw: '0', ps: 'BOTH', ...extra };
}

function usdc(wb: string, bc = '0', cw?: string): UserDataBalance {
  return { a: 'USDC', wb, cw: cw ?? wb, bc };
}

function update(P: UserDataPosition[], B: UserDataBalance[] = [], m = 'ORDER', E = 1_000): AccountUpdateEvent {
  return { e: 'ACCOUNT_UPDATE', E, T: E, a: { m, B, P } };
}

function baselineOf(P: UserDataPosition[], wb?: string): AccountUpdateEvent {
  return { e: 'ACCOUNT_UPDATE', E: 500, T: 500, a: { m: 'BASELINE', B: wb ? [usdc(wb)] : [], P } };
}

const accountUpdates = (events: UserDataEvent[]) => events.filter((e): e is AccountUpdateEvent => e.e === 'ACCOUNT_UPDATE');
const orderUpdates = (events: UserDataEvent[]) => events.filter((e): e is OrderTradeUpdateEvent => e.e === 'ORDER_TRADE_UPDATE');

async function subscribe(h: LighterHedgeHarness, extra: Partial<UserDataHandlers> = {}) {
  const events: UserDataEvent[] = [];
  const hooks = { connected: 0, disconnected: [] as Array<Error | undefined>, errors: [] as Error[] };
  const subscription = await h.adapter.subscribeUserData({
    onEvent: event => events.push(event),
    onConnected: () => hooks.connected++,
    onDisconnected: error => hooks.disconnected.push(error),
    onError: error => hooks.errors.push(error),
    ...extra,
  });
  openSubscriptions.push(subscription);
  return { subscription, events, hooks };
}

// ===== Tests =====

describe('LighterHedgeAdapter: capabilities and construction', () => {
  it('reports hedge mode (emulated) with the Lighter capabilities otherwise unchanged', async () => {
    const h = setup();
    const { adapter } = h;
    expect(adapter.id).toBe('lighter');
    expect(adapter.capabilities).toBe(LIGHTER_HEDGE_CAPABILITIES);
    expect(LIGHTER_HEDGE_CAPABILITIES).toEqual({ ...LIGHTER_CAPABILITIES, hedgeMode: true });
    expect(LIGHTER_HEDGE_CAPABILITIES.setPositionMode).toBe(false);
    expect(Object.isFrozen(LIGHTER_HEDGE_CAPABILITIES)).toBe(true);
    expect(LIGHTER_CAPABILITIES.hedgeMode).toBe(false);   // The one-way adapter is unchanged
    expect(h.long.capabilities).toBe(LIGHTER_CAPABILITIES);
    await expect(adapter.getHedgeMode()).resolves.toBe(true);
    await expect(adapter.setHedgeMode(true)).resolves.toBeUndefined();
    await expect(adapter.setHedgeMode(false)).rejects.toThrow(LIGHTER_HEDGE_ONE_WAY_MESSAGE);
    expect(LIGHTER_HEDGE_ONE_WAY_MESSAGE).toMatch(/restart the bot/);
    expect(isLighterHedgeAdapter(adapter)).toBe(true);
    expect(isLighterHedgeAdapter(h.long)).toBe(false);
    expect(isLighterHedgeAdapter(null)).toBe(false);
    expect(isLighterHedgeAdapter({ id: 'lighter' })).toBe(false);
    expect(adapter.profile).toBe(h.long.profile);
    expect(adapter.markets).toBe(h.long.markets);
    expect(adapter.history).toBe(h.long.history);
    expect(adapter.long).toBe(h.long);
    expect(adapter.short).toBe(h.short);
    expect(h.exchange.routed).toHaveLength(0);   // Construction reads nothing
  });

  it('enforces its invariants: two adapters, one network, one market cache, the hedge ranges, different accounts', () => {
    const h = setup();
    const inner = (side: 'LONG' | 'SHORT', overrides: Partial<LighterAdapterOptions> = {}) => new LighterAdapter({
      profile: 'testnet',
      credentials: HEDGE_CREDENTIALS[side],
      markets: h.markets,
      transport: h.exchange.transport,
      signer: new FakeLighterSigner(HEDGE_CREDENTIALS[side].accountIndex as number, HEDGE_CREDENTIALS[side].apiKeyIndex as number),
      journal: 'memory',
      clientOrderIndexRange: LIGHTER_HEDGE_COI_RANGES[side],
      ...overrides,
    });
    expect(() => new LighterHedgeAdapter({ long: h.long, short: h.long })).toThrow(/two different adapters/);

    const mainnetMarkets = new LighterMarketCache({ profile: 'mainnet', symbols: { allowlist: [] }, httpGet: async () => ({}) });
    const mainnet = new LighterAdapter({
      profile: 'mainnet', credentials: { ...HEDGE_CREDENTIALS.SHORT, profile: 'mainnet' }, markets: mainnetMarkets,
      transport: h.exchange.transport, journal: 'memory', clientOrderIndexRange: LIGHTER_HEDGE_COI_RANGES.SHORT,
    });
    expect(() => new LighterHedgeAdapter({ long: inner('LONG'), short: mainnet })).toThrow(/one network/);

    const otherMarkets = new LighterMarketCache({ profile: 'testnet', symbols: { allowlist: ['ETHUSDT'] }, httpGet: async () => ({}) });
    expect(() => new LighterHedgeAdapter({ long: inner('LONG'), short: inner('SHORT', { markets: otherMarkets }) })).toThrow(/share one market cache/);

    expect(() => new LighterHedgeAdapter({ long: inner('LONG'), short: inner('SHORT', { clientOrderIndexRange: undefined }) }))
      .toThrow(/client order index range/);
    expect(() => new LighterHedgeAdapter({
      long: inner('LONG', { clientOrderIndexRange: LIGHTER_HEDGE_COI_RANGES.SHORT }),
      short: inner('SHORT', { clientOrderIndexRange: LIGHTER_HEDGE_COI_RANGES.LONG }),
    })).toThrow(/client order index range/);

    expect(() => new LighterHedgeAdapter({
      long: inner('LONG'),
      short: inner('SHORT', { credentials: { ...HEDGE_CREDENTIALS.SHORT, accountIndex: HEDGE_LONG_ACCOUNT } }),
    })).toThrow(/short account index 12345 must differ from the main \(long\) account index/);

    // Unset credentials (paper mode) are fine
    expect(() => new LighterHedgeAdapter({ long: inner('LONG', { credentials: null }), short: inner('SHORT', { credentials: null }) })).not.toThrow();
    expect(new LighterHedgeAdapter({ long: inner('LONG'), short: inner('SHORT') })).toBeInstanceOf(LighterHedgeAdapter);
  });

  it('has credentials only when both accounts do', () => {
    const h = setup();
    expect(h.adapter.hasCredentials()).toBe(true);
    h.setCredentials('SHORT', null);
    expect(h.adapter.hasCredentials()).toBe(false);
    h.setCredentials('SHORT', h.credentials.SHORT);
    h.setCredentials('LONG', { ...h.credentials.LONG, apiKeyPublicKey: '' });
    expect(h.adapter.hasCredentials()).toBe(false);
    expect(lighterHedgeHarness().adapter.hasCredentials()).toBe(false);
  });

  it('takes market data from the long account adapter', async () => {
    const h = setup();
    const methods = ['getExchangeInfo', 'getMarkPrice', 'getTickerPrice', 'getAllTickerPrices', 'getKlines', 'getOrderBook', 'getBookTicker'] as const;
    const shortSpies = methods.map(method => jest.spyOn(h.short, method));
    for (const method of methods) {
      const sentinel = { from: `long ${method}` };
      const spy = jest.spyOn(h.long, method).mockResolvedValue(sentinel as never);
      const args: unknown[] = method === 'getKlines' ? ['ETHUSDT', '5m', 10] : method === 'getOrderBook' ? ['ETHUSDT', 5] : method === 'getExchangeInfo' || method === 'getAllTickerPrices' ? [{ bypassRateLimit: true }] : ['ETHUSDT'];
      await expect((h.adapter[method] as (...a: unknown[]) => Promise<unknown>)(...args)).resolves.toBe(sentinel);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0].slice(0, args.length)).toEqual(args);
    }
    jest.spyOn(h.long, 'getMarkPriceStreamUrl').mockReturnValue('wss://mark');
    jest.spyOn(h.long, 'getKlineStreamUrl').mockReturnValue('wss://kline');
    expect(h.adapter.getMarkPriceStreamUrl()).toBe('wss://mark');
    expect(h.adapter.getKlineStreamUrl([{ symbol: 'ETHUSDT', interval: '5m' }])).toBe('wss://kline');
    for (const spy of shortSpies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('LighterHedgeAdapter: order routing', () => {
  it('BUY + LONG opens on the long account only (fresh sign check first)', async () => {
    const h = setup();
    const order = await h.adapter.placeOrder(limitEntry('LONG'));
    const [tx] = h.exchange.txs('LONG', 14);
    expect(tx.info).toMatchObject({
      AccountIndex: HEDGE_LONG_ACCOUNT, ApiKeyIndex: HEDGE_LONG_KEY, MarketIndex: ETH, IsAsk: 0, ReduceOnly: 0, BaseAmount: 5000, Price: 400000,
    });
    expect(h.exchange.short.received).toHaveLength(0);
    expect(requestsTo(h, 'SHORT')).toHaveLength(0);
    expect(order.orderId).toBe(tx.info.ClientOrderIndex);
    expect(lighterHedgeSideOfClientOrderIndex(tx.info.ClientOrderIndex)).toBe('LONG');
    // The sign check read the long account before the tx
    const accountReads = requestsTo(h, 'LONG', '/api/v1/account');
    expect(accountReads.length).toBeGreaterThan(0);
    expect(h.exchange.routed.indexOf(accountReads[0])).toBeLessThan(h.exchange.routed.findIndex(r => r.request.method === 'POST'));
  });

  it('SELL + SHORT opens on the short account only, with its own key and index range', async () => {
    const h = setup();
    const order = await h.adapter.placeOrder(limitEntry('SHORT'));
    const [tx] = h.exchange.txs('SHORT', 14);
    expect(tx.info).toMatchObject({
      AccountIndex: HEDGE_SHORT_ACCOUNT, ApiKeyIndex: HEDGE_SHORT_KEY, MarketIndex: ETH, IsAsk: 1, ReduceOnly: 0, BaseAmount: 5000, Price: 410000,
    });
    expect(h.exchange.long.received).toHaveLength(0);
    expect(requestsTo(h, 'SHORT', '/api/v1/apikeys')[0].request.url).toContain(`account_index=${HEDGE_SHORT_ACCOUNT}`);
    expect(order.orderId).toBe(tx.info.ClientOrderIndex);
    expect(tx.info.ClientOrderIndex).toBeGreaterThanOrEqual(LIGHTER_HEDGE_COI_SPAN);
    expect(lighterHedgeSideOfClientOrderIndex(tx.info.ClientOrderIndex)).toBe('SHORT');
    expect(clientOrderIndexRole(tx.info.ClientOrderIndex)).toBe(1);   // entry
  });

  it('closes go out reduce-only on the side\'s account (SELL + LONG, BUY + SHORT), whatever the request says', async () => {
    const h = setup();
    h.exchange.long.setBook(ETH, [['4049.90', '5.0000']], [['4050.10', '5.0000']]);
    h.exchange.long.setPosition(ETH, '0.5000');
    h.exchange.short.setPosition(ETH, '-0.3000');
    // As PositionManager closes in hedge mode: no reduceOnly flag
    await h.adapter.placeOrder({ symbol: 'ETHUSDT', side: 'SELL', type: 'MARKET', quantity: 0.5, positionSide: 'LONG' });
    await h.adapter.placeOrder({ symbol: 'ETHUSDT', side: 'BUY', type: 'MARKET', quantity: 0.3, positionSide: 'SHORT', reduceOnly: false });
    const [longClose] = h.exchange.txs('LONG', 14);
    const [shortClose] = h.exchange.txs('SHORT', 14);
    expect(longClose.info).toMatchObject({ AccountIndex: HEDGE_LONG_ACCOUNT, IsAsk: 1, ReduceOnly: 1, BaseAmount: 5000, Type: 1 });
    expect(shortClose.info).toMatchObject({ AccountIndex: HEDGE_SHORT_ACCOUNT, IsAsk: 0, ReduceOnly: 1, BaseAmount: 3000, Type: 1 });
    expect(h.exchange.txs('LONG')).toHaveLength(1);
    expect(h.exchange.txs('SHORT')).toHaveLength(1);
  });

  it('a close with nothing to reduce on that account is refused by the exchange rules (-2022), nothing sent', async () => {
    const h = setup();
    h.exchange.short.setPosition(ETH, '-0.3000');   // The short account is short; the long account is flat
    const error = await h.adapter.placeOrder({ symbol: 'ETHUSDT', side: 'SELL', type: 'LIMIT', quantity: 0.3, price: 4100, positionSide: 'LONG' }).catch(e => e);
    expect(error).toBeInstanceOf(LighterOrderError);
    expect(error.response.data.code).toBe(-2022);
    expect(error.message).toMatch(/needs a long position to reduce/);
    expect(h.exchange.long.received).toHaveLength(0);
    expect(h.exchange.short.received).toHaveLength(0);
  });

  it('protective types, reduceOnly and closePosition count as reducing and skip the entry check', async () => {
    const h = setup();
    h.exchange.long.setPosition(ETH, '-0.5000');   // Wrong direction on the long account: entries are refused
    await h.adapter.placeOrder({ symbol: 'ETHUSDT', side: 'BUY', type: 'STOP_MARKET', quantity: 0.5, stopPrice: 4200, positionSide: 'LONG' });
    await h.adapter.placeOrder({ symbol: 'ETHUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.2, price: 3900, positionSide: 'LONG', reduceOnly: true });
    const [stop, limit] = h.exchange.txs('LONG', 14);
    expect(stop.info).toMatchObject({ AccountIndex: HEDGE_LONG_ACCOUNT, Type: 2, IsAsk: 0, ReduceOnly: 1, TriggerPrice: 420000 });
    expect(limit.info).toMatchObject({ AccountIndex: HEDGE_LONG_ACCOUNT, Type: 0, IsAsk: 0, ReduceOnly: 1, BaseAmount: 2000 });
    // closePosition takes the reducing path: the inner adapter's own refusal, not the wrong-direction one
    const closeAll = { symbol: 'ETHUSDT', side: 'BUY', type: 'MARKET', quantity: 0.5, positionSide: 'LONG', closePosition: 'true' };
    await expect(h.adapter.placeOrder(closeAll as never)).rejects.toThrow(/closePosition orders are not supported/);
    expect(h.exchange.txs('LONG', 14)).toHaveLength(2);
    expect(h.exchange.short.received).toHaveLength(0);
  });

  it('a take profit protecting a short goes to the short account, reduce-only', async () => {
    const h = setup();
    h.exchange.short.setPosition(ETH, '-0.3000');
    const order = await h.adapter.placeOrder({ symbol: 'ETHUSDT', side: 'BUY', type: 'TAKE_PROFIT_MARKET', quantity: 0.3, stopPrice: 3900, positionSide: 'SHORT' });
    const [tp] = h.exchange.txs('SHORT', 14);
    expect(tp.info).toMatchObject({ AccountIndex: HEDGE_SHORT_ACCOUNT, Type: 4, IsAsk: 0, ReduceOnly: 1, TriggerPrice: 390000, BaseAmount: 3000 });
    expect(clientOrderIndexRole(Number(order.orderId))).toBe(3);
    expect(lighterHedgeSideOfClientOrderIndex(Number(order.orderId))).toBe('SHORT');
    expect(h.exchange.long.received).toHaveLength(0);
  });

  it('positionSide BOTH, missing or unknown: -4061 (Hunter re-syncs its mode), nothing read or sent', async () => {
    const h = setup();
    for (const positionSide of ['BOTH', undefined, 'HEDGE']) {
      const error = await h.adapter.placeOrder({ ...limitEntry('LONG'), positionSide } as never).catch(e => e);
      expect(error).toBeInstanceOf(LighterOrderError);
      expect(error.message).toBe(LIGHTER_HEDGE_POSITION_SIDE_MESSAGE);
      expect(error.code).toBe(-4061);
      expect(error.response.data.code).toBe(-4061);
    }
    await expect(h.adapter.placeOrder({ ...limitEntry('LONG'), side: 'HOLD' } as never)).rejects.toThrow(/invalid side HOLD/);
    expect(h.exchange.routed).toHaveLength(0);
  });

  it('places SL/TP reduce-only on the account of the position side', async () => {
    const h = setup();
    h.exchange.long.setPosition(ETH, '0.5000');
    h.exchange.short.setPosition(ETH, '-0.3000');
    const long = await h.adapter.placeProtectiveOrders({ symbol: 'ETHUSDT', side: 'SELL', quantity: 0.5, stopLossPrice: 3900, takeProfitPrice: 4200, positionSide: 'LONG' });
    const short = await h.adapter.placeProtectiveOrders({ symbol: 'ETHUSDT', side: 'BUY', quantity: 0.3, stopLossPrice: 4200, takeProfitPrice: 3900, positionSide: 'SHORT', reduceOnly: false });
    expect(long.errors).toEqual([]);
    expect(short.errors).toEqual([]);
    const [longOco] = h.exchange.txs('LONG', 28);
    const [shortOco] = h.exchange.txs('SHORT', 28);
    expect(longOco.info.AccountIndex).toBe(HEDGE_LONG_ACCOUNT);
    expect(longOco.info.Orders.map((o: any) => [o.Type, o.IsAsk, o.ReduceOnly, o.BaseAmount])).toEqual([[2, 1, 1, 5000], [4, 1, 1, 5000]]);
    expect(shortOco.info.AccountIndex).toBe(HEDGE_SHORT_ACCOUNT);
    expect(shortOco.info.Orders.map((o: any) => [o.Type, o.IsAsk, o.ReduceOnly, o.BaseAmount])).toEqual([[2, 0, 1, 3000], [4, 0, 1, 3000]]);
    expect(lighterHedgeSideOfClientOrderIndex(Number(long.stopLoss?.orderId))).toBe('LONG');
    expect(lighterHedgeSideOfClientOrderIndex(Number(long.takeProfit?.orderId))).toBe('LONG');
    expect(lighterHedgeSideOfClientOrderIndex(Number(short.stopLoss?.orderId))).toBe('SHORT');
    expect(clientOrderIndexRole(Number(short.stopLoss?.orderId))).toBe(2);
    expect(clientOrderIndexRole(Number(short.takeProfit?.orderId))).toBe(3);
  });

  it('SL/TP without LONG or SHORT: per-leg errors, never throws, nothing sent', async () => {
    const h = setup();
    for (const positionSide of ['BOTH', undefined] as const) {
      const result = await h.adapter.placeProtectiveOrders({ symbol: 'ETHUSDT', side: 'SELL', quantity: 0.5, stopLossPrice: 3900, takeProfitPrice: 4200, positionSide });
      expect(result).toEqual({ errors: [`SL: ${LIGHTER_HEDGE_POSITION_SIDE_MESSAGE}`, `TP: ${LIGHTER_HEDGE_POSITION_SIDE_MESSAGE}`] });
    }
    expect(h.exchange.routed).toHaveLength(0);
  });

  it('passes inner errors through unchanged (orderMayExist, mayExistUntil, code)', async () => {
    const h = setup();
    const failure = Object.assign(new Error('Lighter LIMIT BUY ETHUSDT was accepted but not confirmed'), { orderMayExist: true, mayExistUntil: 123, code: null });
    jest.spyOn(h.long, 'placeOrder').mockRejectedValueOnce(failure);
    await expect(h.adapter.placeOrder(limitEntry('LONG'))).rejects.toBe(failure);
    const refused = new LighterOrderError('refused', -2022);
    jest.spyOn(h.short, 'placeOrder').mockRejectedValueOnce(refused);
    await expect(h.adapter.placeOrder({ symbol: 'ETHUSDT', side: 'BUY', type: 'MARKET', quantity: 0.1, positionSide: 'SHORT' })).rejects.toBe(refused);
  });
});

describe('LighterHedgeAdapter: wrong-direction positions (manual trades)', () => {
  it('refuses entries on an account holding the wrong direction, alerts once, and recovers when it is flat', async () => {
    const h = setup();
    h.exchange.short.setPosition(ETH, '0.2000');   // A long on the short account
    const btcShort = { symbol: 'BTCUSDT', side: 'SELL' as const, type: 'LIMIT' as const, quantity: 0.001, price: 98000, positionSide: 'SHORT' as const };
    const error = await h.adapter.placeOrder(btcShort).catch(e => e);
    expect(error).toBeInstanceOf(LighterOrderError);
    expect(error.code).toBeNull();
    expect(error.message).toBe(
      'Lighter hedge: the short account (23456) holds a long ETHUSDT position (0.2000), the wrong direction for this account ' +
      '(manual trade?). New short entries are refused until it is closed.'
    );
    await expect(h.adapter.placeOrder(btcShort)).rejects.toThrow(/holds a long ETHUSDT position/);
    expect(h.exchange.short.received).toHaveLength(0);
    expect(h.alerts).toEqual([{ kind: 'wrong-sign', side: 'SHORT', symbol: 'ETHUSDT', message: error.message }]);

    // The long account is unaffected
    await h.adapter.placeOrder(limitEntry('LONG'));
    expect(h.exchange.txs('LONG', 14)).toHaveLength(1);

    // Flat again: entries pass and the alert re-arms
    h.exchange.short.setPosition(ETH, '0');
    await h.adapter.placeOrder(btcShort);
    expect(h.exchange.txs('SHORT', 14)).toHaveLength(1);
    h.exchange.short.setPosition(ETH, '0.1000');
    await expect(h.adapter.placeOrder(btcShort)).rejects.toThrow(/holds a long ETHUSDT position \(0\.1000\)/);
    expect(h.alerts.map(alert => alert.kind)).toEqual(['wrong-sign', 'wrong-sign']);
  });

  it('keeps a wrong-direction position protected; a bot market close of it counts as an entry and is refused', async () => {
    const h = setup();
    h.exchange.long.setBook(ETH, [['4049.90', '5.0000']], [['4050.10', '5.0000']]);
    h.exchange.long.setPosition(ETH, '-0.5000');   // A short on the long account
    const positions = await h.adapter.getPositions('ETHUSDT');
    expect(positions.find(p => p.positionSide === 'LONG')).toMatchObject({ symbol: 'ETHUSDT', positionAmt: '-0.5000' });
    expect(h.alerts).toEqual([expect.objectContaining({ kind: 'wrong-sign', side: 'LONG', symbol: 'ETHUSDT' })]);

    // PositionManager protects it with BUY legs on the long account
    const result = await h.adapter.placeProtectiveOrders({ symbol: 'ETHUSDT', side: 'BUY', quantity: 0.5, stopLossPrice: 4200, takeProfitPrice: 3900, positionSide: 'LONG' });
    expect(result.errors).toEqual([]);
    const [oco] = h.exchange.txs('LONG', 28);
    expect(oco.info.Orders.map((o: any) => [o.IsAsk, o.ReduceOnly])).toEqual([[0, 1], [0, 1]]);

    // Its market close as PositionManager sends it in hedge mode (BUY + LONG, no reduceOnly) is an entry
    await expect(h.adapter.placeOrder({ symbol: 'ETHUSDT', side: 'BUY', type: 'MARKET', quantity: 0.5, positionSide: 'LONG' }))
      .rejects.toThrow('Lighter hedge: the long account (12345) holds a short ETHUSDT position (-0.5000)');
    expect(h.exchange.txs('LONG', 14)).toHaveLength(0);
    expect(h.alerts).toHaveLength(1);
  });

  it('a wrong-direction refusal is marked as repeating (no fallback order); other refusals are not', async () => {
    const h = setup();
    h.exchange.short.setPosition(ETH, '0.2000');
    const refusal = await h.adapter.placeOrder(limitEntry('SHORT')).catch(e => e);
    expect(refusal).toBeInstanceOf(LighterOrderError);
    expect(refusal.name).toBe('LighterOrderError');
    expect(orderRefusalRepeats(refusal)).toBe(true);
    expect(orderMayExist(refusal)).toBe(false);

    const sideError = await h.adapter.placeOrder(limitEntry('SHORT', { positionSide: 'BOTH' })).catch(e => e);
    expect(sideError.code).toBe(-4061);
    expect(orderRefusalRepeats(sideError)).toBe(false);
    h.exchange.long.setPosition(ETH, '0');
    const closeError = await h.adapter.placeOrder({ symbol: 'ETHUSDT', side: 'SELL', type: 'MARKET', quantity: 0.5, positionSide: 'LONG' }).catch(e => e);
    expect(closeError).toBeInstanceOf(Error);
    expect(orderRefusalRepeats(closeError)).toBe(false);
    expect(orderRefusalRepeats({ refusalRepeats: true, orderMayExist: true })).toBe(false);   // An order that may exist is never "refused"
  });

  it('refreshes the flags from getAccountInfo and clears them from a filtered read of that symbol', async () => {
    const h = setup();
    h.exchange.short.setPosition(BTC, '0.01000');
    await h.adapter.getAccountInfo();
    expect(h.alerts).toEqual([expect.objectContaining({ side: 'SHORT', symbol: 'BTCUSDT' })]);
    h.exchange.short.setPosition(BTC, '0');
    await h.adapter.getPositions('ETHUSDT');   // Another symbol: the BTC flag stays
    h.exchange.short.setPosition(BTC, '0.02000');
    await h.adapter.getPositions();
    expect(h.alerts).toHaveLength(1);
    h.exchange.short.setPosition(BTC, '0');
    await h.adapter.getPositions('BTCUSDT');   // Cleared: the next wrong position alerts again
    h.exchange.short.setPosition(BTC, '0.03000');
    await h.adapter.getPositions();
    expect(h.alerts).toHaveLength(2);
  });
});

describe('LighterHedgeAdapter: client order indexes and cancels', () => {
  it('each account uses its own range; the role digit stays readable', async () => {
    const h = setup();
    expect(h.long.clientOrderIndexRange).toEqual({ offset: 0, span: LIGHTER_HEDGE_COI_SPAN });
    expect(h.short.clientOrderIndexRange).toEqual({ offset: LIGHTER_HEDGE_COI_SPAN, span: LIGHTER_HEDGE_COI_SPAN });
    const long = await h.adapter.placeOrder(limitEntry('LONG'));
    const short = await h.adapter.placeOrder(limitEntry('SHORT'));
    const longId = Number(long.orderId);
    const shortId = Number(short.orderId);
    expect(longId).toBeGreaterThan(1e13);
    expect(longId).toBeLessThan(LIGHTER_HEDGE_COI_SPAN);
    expect(shortId).toBeGreaterThanOrEqual(LIGHTER_HEDGE_COI_SPAN);
    expect(shortId).toBeLessThan(2 * LIGHTER_HEDGE_COI_SPAN);
    expect(shortId).toBeLessThan(2 ** 48 - 1);
    expect(clientOrderIndexRole(longId)).toBe(1);
    expect(clientOrderIndexRole(shortId)).toBe(1);
  });

  it('cancels a bot order on the account its client order index names, with no lookup on the other', async () => {
    const h = setup();
    const long = await h.adapter.placeOrder(limitEntry('LONG'));
    const short = await h.adapter.placeOrder(limitEntry('SHORT'));
    const longLookups = requestsTo(h, 'LONG', '/api/v1/accountOrders').length;
    await h.adapter.cancelOrder('ETHUSDT', short.orderId);
    expect(h.exchange.txs('SHORT', 15)).toHaveLength(1);
    expect(h.exchange.txs('SHORT', 15)[0].info).toMatchObject({ AccountIndex: HEDGE_SHORT_ACCOUNT, Index: short.orderId });
    expect(requestsTo(h, 'LONG', '/api/v1/accountOrders')).toHaveLength(longLookups);
    expect(h.exchange.txs('LONG', 15)).toHaveLength(0);
    await h.adapter.cancelOrder('ETHUSDT', String(long.orderId));
    expect(h.exchange.txs('LONG', 15)[0].info).toMatchObject({ AccountIndex: HEDGE_LONG_ACCOUNT, Index: long.orderId });
    expect(h.exchange.txs('SHORT', 15)).toHaveLength(1);
  });

  it('falls back to the other account only on -2011: a long-range index on the short account, foreign order indexes', async () => {
    const h = setup();
    await h.adapter.verifyStartup();
    const openOrder = (overrides: Record<string, unknown>) => ({
      market_index: ETH, initial_base_amount: '0.1000', remaining_base_amount: '0.1000', filled_base_amount: '0.0000',
      price: '4100.00', is_ask: true, type: 'limit', time_in_force: 'good-till-time', reduce_only: false, trigger_price: '0.00',
      status: 'open', created_at: 1792289401, ...overrides,
    });
    // Placed on the short sub-account while it ran one-way: its index is in the LONG range
    const oneWayIndex = 17922894012310;
    h.exchange.short.orders.push(openOrder({ order_index: 281474977611000, order_id: '281474977611000', client_order_index: oneWayIndex }));
    const result = await h.adapter.cancelOrder('ETHUSDT', oneWayIndex);
    expect(result).toMatchObject({ orderId: oneWayIndex, status: 'CANCELED' });
    expect(h.exchange.long.received).toHaveLength(0);   // The long account signed nothing for an order it does not have
    expect(h.exchange.txs('SHORT', 15)[0].info).toMatchObject({ AccountIndex: HEDGE_SHORT_ACCOUNT, Index: oneWayIndex });

    // Orders placed outside the bot: exchange order_index (a number below 2^53, or an exact string above)
    h.exchange.short.orders.push(openOrder({ order_index: 281474977611001, order_id: '281474977611001', client_order_index: 0 }));
    const bigId = '576460752303423611';
    h.exchange.short.orders.push(openOrder({ order_index: Number(bigId), order_id: bigId, client_order_index: 0 }));
    await h.adapter.cancelOrder('ETHUSDT', '281474977611001');
    await h.adapter.cancelOrder('ETHUSDT', bigId);
    const cancels = h.exchange.txs('SHORT', 15);
    expect(cancels).toHaveLength(3);
    expect(cancels[1].txInfo).toContain('"Index":281474977611001');
    expect(cancels[2].txInfo).toContain(`"Index":${bigId}`);
    expect(h.exchange.long.received).toHaveLength(0);
    expect(requestsTo(h, 'LONG', '/api/v1/accountActiveOrders').length).toBeGreaterThanOrEqual(2);   // Asked first
  });

  it('an order neither account knows: the primary account\'s -2011, nothing signed', async () => {
    const h = setup();
    const longCancel = jest.spyOn(h.long, 'cancelOrder');
    const shortCancel = jest.spyOn(h.short, 'cancelOrder');
    const error = await h.adapter.cancelOrder('ETHUSDT', 17922894012310).catch(e => e);
    expect(error.response.data.code).toBe(-2011);
    expect(error).toBe(await (longCancel.mock.results[0].value as Promise<unknown>).catch(e => e));
    expect(shortCancel).toHaveBeenCalledTimes(1);

    const shortRange = LIGHTER_HEDGE_COI_SPAN + 17922894012310;
    const shortFirst = await h.adapter.cancelOrder('ETHUSDT', shortRange).catch(e => e);
    expect(shortFirst.response.data.code).toBe(-2011);
    expect(shortCancel.mock.calls[1]).toEqual(['ETHUSDT', shortRange]);   // The short account was asked first
    expect(shortFirst).toBe(await (shortCancel.mock.results[1].value as Promise<unknown>).catch(e => e));
    expect(longCancel).toHaveBeenCalledTimes(2);
    expect(h.exchange.long.received).toHaveLength(0);
    expect(h.exchange.short.received).toHaveLength(0);
  });

  it('any other cancel error is rethrown as is, without trying the other account', async () => {
    const h = setup();
    await h.long.verifyStartup();
    h.exchange.long.privateFailures = 1;   // The order lookup fails: never read as "unknown"
    const shortCancel = jest.spyOn(h.short, 'cancelOrder');
    const error = await h.adapter.cancelOrder('ETHUSDT', 17922894012310).catch(e => e);
    expect(error.response?.data?.code).not.toBe(-2011);
    expect(shortCancel).not.toHaveBeenCalled();
    const invalid = await h.adapter.cancelOrder('ETHUSDT', 'not-an-id').catch(e => e);
    expect(invalid.message).toMatch(/invalid order id/);
    expect(shortCancel).not.toHaveBeenCalled();
  });

  it('cancelAllOrders: one account with a positionSide, both without; a failure names the account after both ran', async () => {
    const h = setup();
    await h.adapter.cancelAllOrders('ETHUSDT', 'SHORT');
    expect(h.exchange.txs('SHORT', 16)).toHaveLength(1);
    expect(h.exchange.txs('LONG', 16)).toHaveLength(0);
    await h.adapter.cancelAllOrders('ETHUSDT', 'LONG');
    expect(h.exchange.txs('LONG', 16)).toHaveLength(1);

    const both = await h.adapter.cancelAllOrders('ETHUSDT');
    expect(both).toMatchObject({ code: 200, symbol: 'ETHUSDT', accounts: { LONG: { code: 200 }, SHORT: { code: 200 } } });
    expect(h.exchange.txs('LONG', 16)).toHaveLength(2);
    expect(h.exchange.txs('SHORT', 16)).toHaveLength(2);

    h.exchange.short.txFailure = { code: 21700, message: 'cancel-all refused' };
    const error = await h.adapter.cancelAllOrders('ETHUSDT').catch(e => e);
    expect(error).toBeInstanceOf(LighterHedgeError);
    expect(error.message).toMatch(/^Lighter hedge: cancel-all on ETHUSDT failed for the short account: .*cancel-all refused/);
    expect(error.cause).toBeInstanceOf(LighterTxFailedError);
    expect(error.failures.SHORT).toBe(error.cause);
    expect(error.failures.LONG).toBeUndefined();
    expect(h.exchange.txs('LONG', 16)).toHaveLength(3);   // The long account still ran
  });
});

describe('LighterHedgeAdapter: merged reads', () => {
  function withPositions(h: LighterHedgeHarness) {
    h.exchange.long.setPosition(ETH, '0.5000', { avg_entry_price: '4000.00', unrealized_pnl: '12.500000', position_value: '2025.000000' });
    h.exchange.short.setPosition(ETH, '-0.3000', { avg_entry_price: '4100.00', unrealized_pnl: '-3.250000', position_value: '1215.000000' });
    h.exchange.short.setPosition(BTC, '0');   // A flat market with a leverage setting
    Object.assign(h.exchange.short.account, {
      collateral: '250.123456',
      available_balance: '200.500000',
      total_asset_value: '246.873456',
      cross_asset_value: '246.873456',
      cross_initial_margin_requirement: '60.000000',
      cross_maintenance_margin_requirement: '36.000000',
    });
  }

  it('getPositions: both accounts in the hedge shape, zero rows kept, symbol filter', async () => {
    const h = setup();
    withPositions(h);
    const positions = await h.adapter.getPositions();
    expect(positions.map(p => [p.symbol, p.positionSide, p.positionAmt, p.entryPrice])).toEqual([
      ['ETHUSDT', 'LONG', '0.5000', '4000.00'],
      ['ETHUSDT', 'SHORT', '-0.3000', '4100.00'],
      ['BTCUSDT', 'SHORT', '0', '100.00'],
    ]);
    expect((await h.adapter.getPositions('BTCUSDT')).map(p => [p.positionSide, p.positionAmt])).toEqual([['SHORT', '0']]);
    expect(h.alerts).toEqual([]);
  });

  it('getPositions never returns a partial set', async () => {
    const h = setup();
    withPositions(h);
    const failure = new Error('ECONNRESET');
    jest.spyOn(h.short, 'getPositions').mockRejectedValueOnce(failure);
    await expect(h.adapter.getPositions()).rejects.toBe(failure);
    const longFailure = new Error('timeout');
    jest.spyOn(h.long, 'getPositions').mockRejectedValueOnce(longFailure);
    await expect(h.adapter.getPositions()).rejects.toBe(longFailure);
  });

  it('getOpenOrders: both accounts tagged by side; any failure rejects', async () => {
    const h = setup();
    const long = await h.adapter.placeOrder(limitEntry('LONG'));
    const short = await h.adapter.placeOrder(limitEntry('SHORT'));
    const orders = await h.adapter.getOpenOrders('ETHUSDT');
    expect(orders.map(o => [o.orderId, o.side, o.positionSide])).toEqual([[long.orderId, 'BUY', 'LONG'], [short.orderId, 'SELL', 'SHORT']]);
    h.exchange.short.privateFailures = 1;
    await expect(h.adapter.getOpenOrders()).rejects.toThrow(/internal server error/);
  });

  it('read-only inner adapters (dashboard): positions work, open orders pass the read-only error through unchanged', async () => {
    const readOnly = Object.assign(new Error('Lighter signing only runs in the bot process.'), { code: 'LIGHTER_READ_ONLY' });
    const h = setup({ adapterOptions: { signer: undefined, loadSigner: () => { throw readOnly; } } });
    withPositions(h);
    expect((await h.adapter.getPositions()).map(p => p.positionSide)).toEqual(['LONG', 'SHORT', 'SHORT']);
    const error = await h.adapter.getOpenOrders().catch(e => e);
    expect(error).toBe(readOnly);
    expect(error.code).toBe('LIGHTER_READ_ONLY');
  });

  it('getBalance: one USDC entry with exact sums, the per-account entries kept', async () => {
    const h = setup();
    withPositions(h);
    const [balance] = await h.adapter.getBalance();
    expect(balance).toMatchObject({
      accountAlias: 'lighter-testnet-hedge',
      asset: 'USDC',
      balance: '1250.123456',
      crossWalletBalance: '1250.123456',
      crossUnPnl: '9.25',
      availableBalance: '1000.5',
      maxWithdrawAmount: '1000.5',
      marginAvailable: true,
    });
    expect(balance.lighterHedge.LONG).toMatchObject({ accountAlias: 'lighter-testnet', balance: '1000', availableBalance: '800', crossUnPnl: '12.5' });
    expect(balance.lighterHedge.SHORT).toMatchObject({ balance: '250.123456', availableBalance: '200.5', crossUnPnl: '-3.25' });
  });

  it('getAccountInfo: summed totals and assets, both accounts\' positions, per-account summaries', async () => {
    const h = setup();
    withPositions(h);
    const info = await h.adapter.getAccountInfo();
    expect(info).toMatchObject({
      totalWalletBalance: '1250.123456',
      totalUnrealizedProfit: '9.25',
      totalMarginBalance: '1259.373456',
      totalInitialMargin: '260',
      totalPositionInitialMargin: '260',
      totalOpenOrderInitialMargin: '0',
      totalMaintMargin: '156',
      totalCrossWalletBalance: '1250.123456',
      totalCrossUnPnl: '9.25',
      availableBalance: '1000.5',
      maxWithdrawAmount: '1000.5',
      canTrade: true,
      multiAssetsMargin: false,
    });
    expect(info.assets).toHaveLength(1);
    expect(info.assets[0]).toMatchObject({
      asset: 'USDC', walletBalance: '1250.123456', unrealizedProfit: '9.25', marginBalance: '1259.373456', availableBalance: '1000.5',
      initialMargin: '260', maintMargin: '156', marginAvailable: true,
    });
    expect(info.positions.map((p: any) => [p.symbol, p.positionAmt, p.positionSide])).toEqual([
      ['ETHUSDT', '0.5000', 'LONG'], ['ETHUSDT', '-0.3000', 'SHORT'], ['BTCUSDT', '0', 'SHORT'],
    ]);
    expect(info.lighter).toMatchObject({
      profile: 'testnet', hedge: true,
      accounts: { LONG: { accountIndex: HEDGE_LONG_ACCOUNT, collateral: '1000.000000' }, SHORT: { accountIndex: HEDGE_SHORT_ACCOUNT, collateral: '250.123456' } },
    });
    expect(info.lighterHedge).toEqual({
      LONG: { accountIndex: HEDGE_LONG_ACCOUNT, totalWalletBalance: '1000', availableBalance: '800', totalUnrealizedProfit: '12.5', totalMarginBalance: '1012.5' },
      SHORT: { accountIndex: HEDGE_SHORT_ACCOUNT, totalWalletBalance: '250.123456', availableBalance: '200.5', totalUnrealizedProfit: '-3.25', totalMarginBalance: '246.873456' },
    });
    const failure = new Error('ETIMEDOUT');
    jest.spyOn(h.short, 'getAccountInfo').mockRejectedValueOnce(failure);
    await expect(h.adapter.getAccountInfo()).rejects.toBe(failure);
  });

  it('getEntryMargin reads only the account an entry on that side would use', async () => {
    const h = setup();
    withPositions(h);
    let longRequests = h.exchange.long.requests.length;
    let shortRequests = h.exchange.short.requests.length;
    await expect(h.adapter.getEntryMargin('SHORT')).resolves.toEqual({ totalWalletBalance: '250.123456', availableBalance: '200.5' });
    expect(h.exchange.long.requests.length).toBe(longRequests);
    expect(h.exchange.short.requests.length).toBe(shortRequests + 1);
    longRequests = h.exchange.long.requests.length;
    shortRequests = h.exchange.short.requests.length;
    await expect(h.adapter.getEntryMargin('LONG')).resolves.toEqual({ totalWalletBalance: '1000', availableBalance: '800' });
    expect(h.exchange.long.requests.length).toBe(longRequests + 1);
    expect(h.exchange.short.requests.length).toBe(shortRequests);
    await expect(h.adapter.getEntryMargin('BOTH' as never)).rejects.toThrow(LIGHTER_HEDGE_POSITION_SIDE_MESSAGE);
  });

  it('setLeverage on both accounts in parallel; a failure names the account and keeps the cause', async () => {
    const h = setup();
    const result = await h.adapter.setLeverage('ETHUSDT', 10);
    expect(h.exchange.txs('LONG', 20).map(tx => tx.info.InitialMarginFraction)).toEqual([1000]);
    expect(h.exchange.txs('SHORT', 20).map(tx => tx.info.InitialMarginFraction)).toEqual([1000]);
    expect(h.exchange.txs('SHORT', 20)[0].info.AccountIndex).toBe(HEDGE_SHORT_ACCOUNT);
    expect(result).toMatchObject({ symbol: 'ETHUSDT', leverage: 10, accounts: { LONG: { leverage: 10 }, SHORT: { leverage: 10 } } });

    h.exchange.short.txFailure = { code: 21120, message: 'leverage refused' };
    const error = await h.adapter.setLeverage('ETHUSDT', 4).catch(e => e);
    expect(error).toBeInstanceOf(LighterHedgeError);
    expect(error.message).toMatch(/^Lighter hedge: leverage change on ETHUSDT failed for the short account: .*leverage refused/);
    expect(error.cause).toBeInstanceOf(LighterTxFailedError);
    expect(h.exchange.txs('LONG', 20).map(tx => tx.info.InitialMarginFraction)).toEqual([1000, 2500]);
  });

  it('setLeverage for an entry side sets only that account: the other account\'s failure never blocks it', async () => {
    const h = setup();
    const shortFailure = new Error('Lighter: GET /api/v1/account failed: 429 Too Many Requests');
    jest.spyOn(h.short, 'setLeverage').mockRejectedValue(shortFailure);
    const longSent = h.exchange.long.received.length;
    await expect(h.adapter.setLeverage('ETHUSDT', 10, 'LONG')).resolves.toMatchObject({ symbol: 'ETHUSDT', leverage: 10 });
    expect(h.exchange.txs('LONG', 20).map(tx => tx.info.InitialMarginFraction)).toEqual([1000]);
    expect(h.short.setLeverage).not.toHaveBeenCalled();
    expect(h.exchange.long.received.length).toBe(longSent + 1);

    // The entry's own account failing still fails it, with the inner error unchanged
    await expect(h.adapter.setLeverage('ETHUSDT', 10, 'SHORT')).rejects.toBe(shortFailure);
    expect(h.exchange.txs('LONG', 20)).toHaveLength(1);
  });
});

describe('LighterHedgeAdapter: merged user data stream', () => {
  it('holds ACCOUNT_UPDATE until both accounts are known (stream baselines); baselines are never events', async () => {
    const h = setup();
    h.streams.LONG.baselineOnSubscribe = baselineOf([pos('ETHUSDT', '0.5')], '1000');
    const seed = jest.spyOn(h.short, 'getPositions').mockRejectedValue(new Error('ECONNRESET'));
    const { events } = await subscribe(h);
    await waitFor(() => h.alerts.length > 0, 'the seed failure alert');
    expect(h.alerts).toEqual([expect.objectContaining({ kind: 'seed-failed', side: 'SHORT', message: expect.stringContaining('short account 23456') })]);

    h.streams.LONG.emit(update([pos('ETHUSDT', '0.6', '4010')], [usdc('1000', '-0.5')]));
    h.streams.LONG.emit(update([pos('ETHUSDT', '0.7', '4020')], [usdc('999.5', '-0.5')], 'ORDER', 2_000));
    expect(events).toEqual([]);   // A long-only P would make PositionManager drop the short side

    h.streams.SHORT.handlers!.onBaseline!(baselineOf([pos('ETHUSDT', '-0.3', '4100')], '250'));
    expect(events).toEqual([{
      e: 'ACCOUNT_UPDATE', E: 2_000, T: 2_000,
      a: {
        m: 'ORDER',
        B: [{ a: 'USDC', wb: '1249.5', cw: '1249.5', bc: '-1' }],
        P: [{ ...pos('ETHUSDT', '0.7', '4020'), ps: 'LONG' }, { ...pos('ETHUSDT', '-0.3', '4100'), ps: 'SHORT' }],
      },
    }]);
    const calls = seed.mock.calls.length;
    await wait(30);
    expect(seed.mock.calls.length).toBe(calls);   // Known now: no more REST seeding
    expect(h.alerts).toHaveLength(1);              // The seed failure alerted once
    expect(events).toHaveLength(1);
  });

  it('seeds an account its stream has not reported from REST, then merges every update', async () => {
    const h = setup();
    h.exchange.short.setPosition(ETH, '-0.3000', { avg_entry_price: '4100.00' });
    h.exchange.short.account.collateral = '250.000000';
    const { events } = await subscribe(h);
    await waitFor(() => requestsTo(h, 'SHORT', '/api/v1/account').length > 0 && requestsTo(h, 'LONG', '/api/v1/account').length > 0, 'the REST seeds');
    h.streams.LONG.emit(update([pos('ETHUSDT', '0.6', '4010')], [usdc('1000')]));
    await waitFor(() => events.length === 1, 'the merged update');
    const [merged] = accountUpdates(events);
    expect(merged.a.P).toEqual([
      { ...pos('ETHUSDT', '0.6', '4010'), ps: 'LONG' },
      expect.objectContaining({ s: 'ETHUSDT', pa: '-0.3000', ep: '4100.00', mt: 'cross', ps: 'SHORT' }),
    ]);
    expect(merged.a.B).toEqual([{ a: 'USDC', wb: '1250', cw: '1250', bc: '0' }]);
    expect(h.alerts).toEqual([]);
  });

  it('a failed REST seed alerts once and retries; the held update is released when it succeeds', async () => {
    const h = setup();
    h.streams.LONG.baselineOnSubscribe = baselineOf([pos('ETHUSDT', '0.5')], '1000');
    const balance = jest.spyOn(h.short, 'getBalance');
    balance.mockRejectedValueOnce(new Error('503')).mockRejectedValueOnce(new Error('503'));
    const { events } = await subscribe(h);
    h.streams.LONG.emit(update([pos('ETHUSDT', '0.6')], [usdc('1000')]));
    await waitFor(() => events.length === 1, 'the merged update after the retry');
    expect(balance.mock.calls.length).toBe(3);
    expect(h.alerts.map(alert => [alert.kind, alert.side])).toEqual([['seed-failed', 'SHORT']]);
    expect(accountUpdates(events)[0].a.P).toEqual([{ ...pos('ETHUSDT', '0.6'), ps: 'LONG' }]);
    expect(accountUpdates(events)[0].a.B).toEqual([{ a: 'USDC', wb: '2000', cw: '2000', bc: '0' }]);
  });

  it('discards a REST seed that returns after the stream reported the account', async () => {
    const h = setup();
    h.streams.LONG.baselineOnSubscribe = baselineOf([], '1000');
    const gate = deferred<VenuePosition[]>();
    jest.spyOn(h.short, 'getPositions').mockImplementationOnce(() => gate.promise);
    const { events } = await subscribe(h);
    h.streams.SHORT.handlers!.onBaseline!(baselineOf([pos('ETHUSDT', '-0.3')], '250'));
    gate.resolve([{
      symbol: 'ETHUSDT', positionAmt: '-9.0000', entryPrice: '1', markPrice: '1', unRealizedProfit: '0', liquidationPrice: '0',
      leverage: '5', marginType: 'cross', isolatedMargin: '0', isAutoAddMargin: 'false', positionSide: 'BOTH', updateTime: 1,
    }]);
    await wait(10);
    h.streams.LONG.emit(update([pos('ETHUSDT', '0.5')], [usdc('1000')]));
    expect(accountUpdates(events).map(event => event.a.P)).toEqual([[{ ...pos('ETHUSDT', '0.5'), ps: 'LONG' }, { ...pos('ETHUSDT', '-0.3'), ps: 'SHORT' }]]);
  });

  it('zero rows close only the side they name; B sums both wallets with the event\'s balance change', async () => {
    const h = setup();
    h.streams.LONG.baselineOnSubscribe = baselineOf([pos('ETHUSDT', '0.5')], '1000');
    h.streams.SHORT.baselineOnSubscribe = baselineOf([pos('ETHUSDT', '-0.3', '4100'), pos('BTCUSDT', '-0.01', '97000')], '250');
    const { events } = await subscribe(h);
    expect(events).toEqual([]);

    // The long position closed with +12.5
    h.streams.LONG.emit(update([pos('ETHUSDT', '0', '0')], [usdc('1012.5', '12.5')]));
    // The short account's ETH grew; its wallet's cross part differs (isolated margin elsewhere)
    h.streams.SHORT.emit(update([pos('ETHUSDT', '-0.4', '4090'), pos('BTCUSDT', '-0.01', '97000')], [usdc('250', '0', '240')], 'ORDER', 3_000));
    const [closed, grown] = accountUpdates(events);
    expect(closed.a.P).toEqual([
      { ...pos('ETHUSDT', '-0.3', '4100'), ps: 'SHORT' },
      { ...pos('BTCUSDT', '-0.01', '97000'), ps: 'SHORT' },
      { ...pos('ETHUSDT', '0', '0'), ps: 'LONG' },
    ]);
    expect(closed.a.B).toEqual([{ a: 'USDC', wb: '1262.5', cw: '1262.5', bc: '12.5' }]);
    expect(grown.a.P).toEqual([
      { ...pos('ETHUSDT', '-0.4', '4090'), ps: 'SHORT' },
      { ...pos('BTCUSDT', '-0.01', '97000'), ps: 'SHORT' },
    ]);
    expect(grown.a.B).toEqual([{ a: 'USDC', wb: '1262.5', cw: '1252.5', bc: '0' }]);
    expect(grown.E).toBe(3_000);
  });

  it('a zero row held while the other account is unknown is dropped when the position opens again', async () => {
    const h = setup();
    h.streams.LONG.baselineOnSubscribe = baselineOf([pos('ETHUSDT', '0.5'), pos('BTCUSDT', '0.01', '97000')], '1000');
    jest.spyOn(h.short, 'getPositions').mockImplementation(() => new Promise(() => {}));   // The short account stays unknown
    const { events } = await subscribe(h);
    h.streams.LONG.emit(update([pos('ETHUSDT', '0', '0'), pos('BTCUSDT', '0', '0')]));
    h.streams.LONG.emit(update([pos('ETHUSDT', '0.2', '4030')]));
    expect(events).toEqual([]);
    h.streams.SHORT.handlers!.onBaseline!(baselineOf([pos('ETHUSDT', '-0.3', '4100')], '250'));
    expect(accountUpdates(events)).toHaveLength(1);
    expect(accountUpdates(events)[0].a).toEqual({
      m: 'ORDER',
      B: [{ a: 'USDC', wb: '1250', cw: '1250', bc: '0' }],
      P: [
        { ...pos('ETHUSDT', '0.2', '4030'), ps: 'LONG' },
        { ...pos('ETHUSDT', '-0.3', '4100'), ps: 'SHORT' },
        { ...pos('BTCUSDT', '0', '0'), ps: 'LONG' },
      ],
    });
  });

  it('reports no balance until both accounts\' balances are known, and carries the change over', async () => {
    const h = setup();
    h.streams.LONG.baselineOnSubscribe = baselineOf([], '1000');
    h.streams.SHORT.baselineOnSubscribe = baselineOf([]);   // Collateral not known yet
    const { events } = await subscribe(h);
    h.streams.LONG.emit(update([pos('ETHUSDT', '0.5')], [usdc('995', '-5')]));
    expect(accountUpdates(events)[0].a.B).toEqual([]);
    h.streams.SHORT.emit(update([], [usdc('250', '0')]));
    expect(accountUpdates(events)[1].a.B).toEqual([{ a: 'USDC', wb: '1245', cw: '1245', bc: '-5' }]);
    expect(accountUpdates(events)[1].a.P).toEqual([{ ...pos('ETHUSDT', '0.5'), ps: 'LONG' }]);
  });

  it('forwards ORDER_TRADE_UPDATE at once with o.ps set to the account, and ACCOUNT_CONFIG_UPDATE as is', async () => {
    const h = setup();
    jest.spyOn(h.long, 'getPositions').mockImplementation(() => new Promise(() => {}));
    jest.spyOn(h.short, 'getPositions').mockImplementation(() => new Promise(() => {}));
    const { events } = await subscribe(h);
    const order: OrderTradeUpdateEvent = {
      e: 'ORDER_TRADE_UPDATE', E: 10, T: 10,
      o: { s: 'ETHUSDT', S: 'SELL', o: 'LIMIT', q: '0.3', p: '4100', X: 'NEW', x: 'NEW', i: LIGHTER_HEDGE_COI_SPAN + 17922894012310, ps: 'BOTH', R: false },
    };
    h.streams.SHORT.emit(order);
    h.streams.LONG.emit({ ...order, o: { ...order.o, S: 'BUY', i: 17922894012310 } });
    const config = { e: 'ACCOUNT_CONFIG_UPDATE' as const, E: 11, ac: { s: 'ETHUSDT', l: 5 } };
    h.streams.LONG.emit(config);
    expect(orderUpdates(events).map(event => [event.o.i, event.o.S, event.o.ps])).toEqual([
      [LIGHTER_HEDGE_COI_SPAN + 17922894012310, 'SELL', 'SHORT'],
      [17922894012310, 'BUY', 'LONG'],
    ]);
    expect(orderUpdates(events)[0]).toEqual({ ...order, o: { ...order.o, ps: 'SHORT' } });
    expect(order.o.ps).toBe('BOTH');   // The inner event object is not modified
    expect(events[2]).toBe(config);
  });

  it('flags wrong-direction positions from the stream, alerting once, and still forwards them with the account side', async () => {
    const h = setup();
    h.streams.LONG.baselineOnSubscribe = baselineOf([], '1000');
    h.streams.SHORT.baselineOnSubscribe = baselineOf([], '250');
    const { events } = await subscribe(h);
    h.streams.SHORT.emit(update([pos('ETHUSDT', '0.2')]));
    h.streams.SHORT.emit(update([pos('ETHUSDT', '0.25')]));
    expect(h.alerts).toEqual([expect.objectContaining({ kind: 'wrong-sign', side: 'SHORT', symbol: 'ETHUSDT', message: expect.stringContaining('(0.2)') })]);
    expect(accountUpdates(events).map(event => event.a.P)).toEqual([
      [{ ...pos('ETHUSDT', '0.2'), ps: 'SHORT' }],
      [{ ...pos('ETHUSDT', '0.25'), ps: 'SHORT' }],
    ]);
    h.streams.SHORT.emit(update([pos('ETHUSDT', '0')]));
    h.streams.SHORT.emit(update([pos('ETHUSDT', '0.1')]));
    expect(h.alerts).toHaveLength(2);
  });

  it('reports connected only when both accounts are, and one disconnect per drop', async () => {
    const h = setup();
    h.streams.LONG.autoConnect = false;
    h.streams.SHORT.autoConnect = false;
    const { hooks } = await subscribe(h);
    const long = h.streams.LONG.handlers!;
    const short = h.streams.SHORT.handlers!;
    long.onConnected!();
    expect(hooks.connected).toBe(0);
    short.onConnected!();
    expect(hooks.connected).toBe(1);
    short.onConnected!();   // Already reported
    expect(hooks.connected).toBe(1);

    const dropped = new Error('socket closed');
    short.onError!(new Error('socket hang up'));
    short.onDisconnected!(dropped);
    long.onDisconnected!(new Error('also closed'));
    expect(hooks.disconnected).toEqual([dropped]);
    expect(hooks.errors.map(error => error.message)).toEqual(['Lighter short account stream: socket hang up']);
    long.onError!(new Error('ECONNRESET'));
    expect(hooks.errors.map(error => error.message)).toEqual(['Lighter short account stream: socket hang up', 'Lighter long account stream: ECONNRESET']);

    long.onConnected!();
    expect(hooks.connected).toBe(1);
    short.onConnected!();
    expect(hooks.connected).toBe(2);
    expect(hooks.disconnected).toHaveLength(1);
  });

  it('runs one beforeReconnect for both accounts while it is in flight', async () => {
    const h = setup();
    const gate = deferred<void>();
    let calls = 0;
    await subscribe(h, { beforeReconnect: async () => { calls++; await gate.promise; } });
    const first = h.streams.LONG.handlers!.beforeReconnect!();
    const second = h.streams.SHORT.handlers!.beforeReconnect!();
    expect(calls).toBe(1);
    gate.resolve();
    await Promise.all([first, second]);
    await h.streams.SHORT.handlers!.beforeReconnect!();
    expect(calls).toBe(2);

    const plain = setup();
    await subscribe(plain);
    expect(plain.streams.LONG.handlers!.beforeReconnect).toBeUndefined();
  });

  it('close() closes both streams once and nothing is emitted afterwards', async () => {
    const h = setup({ seedRetryMs: [20] });
    const seed = jest.spyOn(h.short, 'getPositions').mockRejectedValue(new Error('ECONNRESET'));
    h.streams.LONG.baselineOnSubscribe = baselineOf([pos('ETHUSDT', '0.5')], '1000');
    const { subscription, events, hooks } = await subscribe(h);
    await waitFor(() => seed.mock.calls.length > 0, 'the first seed attempt');
    await subscription.close();
    await subscription.close();
    expect(h.streams.LONG.closes).toBe(1);
    expect(h.streams.SHORT.closes).toBe(1);
    const attempts = seed.mock.calls.length;
    h.streams.SHORT.handlers!.onBaseline!(baselineOf([], '250'));
    h.streams.LONG.emit(update([pos('ETHUSDT', '0.6')], [usdc('1000')]));
    h.streams.SHORT.emit({ e: 'ORDER_TRADE_UPDATE', E: 1, o: { s: 'ETHUSDT', S: 'BUY', o: 'LIMIT', q: '1', X: 'NEW', i: 1 } });
    h.streams.LONG.handlers!.onConnected!();
    h.streams.SHORT.handlers!.onConnected!();
    await wait(60);
    expect(events).toEqual([]);
    expect(hooks.connected).toBe(0);
    expect(seed.mock.calls.length).toBe(attempts);   // The retry timer was cleared
  });

  it('a failed subscribe closes the other account\'s stream and rejects with the inner error', async () => {
    const h = setup();
    const failure = new Error('Lighter user stream: auth token rejected');
    h.streams.SHORT.failNext = failure;
    await expect(h.adapter.subscribeUserData({ onEvent: () => {} })).rejects.toBe(failure);
    expect(h.streams.LONG.subscribes).toBe(1);
    expect(h.streams.LONG.closes).toBe(1);
  });

  it('createAccountStream feeds the balance service the merged updates', async () => {
    const h = setup();
    h.streams.LONG.baselineOnSubscribe = baselineOf([pos('ETHUSDT', '0.5')], '1000');
    h.streams.SHORT.baselineOnSubscribe = baselineOf([], '250');
    const stream = h.adapter.createAccountStream();
    const updates: AccountUpdate[] = [];
    await stream.start(data => updates.push(data));
    expect(stream.isHealthy()).toBe(true);
    h.streams.SHORT.emit(update([pos('ETHUSDT', '-0.3')], [usdc('249', '-1')]));
    expect(updates).toHaveLength(1);
    expect(updates[0].updateData.balances).toEqual([{ asset: 'USDC', walletBalance: '1249', crossWalletBalance: '1249', balanceChange: '-1' }]);
    expect(updates[0].updateData.positions.map(p => [p.symbol, p.positionAmount, p.positionSide])).toEqual([['ETHUSDT', '0.5', 'LONG'], ['ETHUSDT', '-0.3', 'SHORT']]);
    await stream.stop();
    expect(h.streams.LONG.closes).toBe(1);
    expect(h.streams.SHORT.closes).toBe(1);
  });

  it('a merged REST read refreshes the cache: an update of one account never drops a position just read on the other', async () => {
    const h = setup();
    h.streams.LONG.baselineOnSubscribe = baselineOf([pos('ETHUSDT', '0.5')], '1000');
    h.streams.SHORT.baselineOnSubscribe = baselineOf([], '250');
    const { events } = await subscribe(h);
    // The short account's stream drops; a short fill is not reported, but PositionManager reads it over REST
    h.exchange.long.setPosition(ETH, '0.5000', { avg_entry_price: '4000.00' });
    h.streams.SHORT.handlers!.onDisconnected!(new Error('socket closed'));
    h.exchange.short.setPosition(ETH, '-0.3000', { avg_entry_price: '4100.00' });
    const rest = await h.adapter.getPositions(undefined, { bypassRateLimit: true });
    expect(rest.map(row => [row.positionSide, row.positionAmt])).toEqual([['LONG', '0.5000'], ['SHORT', '-0.3000']]);

    h.streams.LONG.emit(update([pos('ETHUSDT', '0.5')], [usdc('999.5', '-0.5')]));
    expect(accountUpdates(events).map(event => event.a.P)).toEqual([[
      { ...pos('ETHUSDT', '0.5'), ps: 'LONG' },
      expect.objectContaining({ s: 'ETHUSDT', pa: '-0.3000', ep: '4100.00', ps: 'SHORT' }),
    ]]);

    // The short stream's own later update that has not seen the fill yet keeps it too; its report then takes over
    h.streams.SHORT.emit(update([], [usdc('250')]));
    expect(accountUpdates(events)[1].a.P).toEqual([
      { ...pos('ETHUSDT', '0.5'), ps: 'LONG' },
      expect.objectContaining({ s: 'ETHUSDT', pa: '-0.3000', ps: 'SHORT' }),
    ]);
    h.streams.SHORT.emit(update([pos('ETHUSDT', '-0.3', '4100')], [usdc('250')]));
    h.streams.SHORT.emit(update([pos('ETHUSDT', '0', '0')], [usdc('251', '1')]));
    expect(accountUpdates(events)[3].a.P).toEqual([{ ...pos('ETHUSDT', '0.5'), ps: 'LONG' }, { ...pos('ETHUSDT', '0', '0'), ps: 'SHORT' }]);
  });

  it('a merged REST read drops a position closed while its stream lagged; a stream report during the read wins', async () => {
    const h = setup();
    h.streams.LONG.baselineOnSubscribe = baselineOf([pos('ETHUSDT', '0.5')], '1000');
    h.streams.SHORT.baselineOnSubscribe = baselineOf([pos('ETHUSDT', '-0.3', '4100'), pos('BTCUSDT', '-0.01', '97000')], '250');
    const { events } = await subscribe(h);
    h.exchange.long.setPosition(ETH, '0.5000', { avg_entry_price: '4000.00' });
    h.exchange.short.setPosition(BTC, '-0.01000', { avg_entry_price: '97000.0' });   // ETH closed on the short account
    await h.adapter.getPositions(undefined, { bypassRateLimit: true });
    h.streams.LONG.emit(update([pos('ETHUSDT', '0.6', '4010')]));
    expect(accountUpdates(events)[0].a.P).toEqual([
      { ...pos('ETHUSDT', '0.6', '4010'), ps: 'LONG' },
      expect.objectContaining({ s: 'BTCUSDT', pa: '-0.01000', ps: 'SHORT' }),
    ]);

    // The short account's stream reports ETH while a read is out: its report is newer than the read
    const gate = deferred<VenuePosition[]>();
    jest.spyOn(h.short, 'getPositions').mockImplementationOnce(() => gate.promise);
    h.exchange.short.setPosition(ETH, '-0.2000', { avg_entry_price: '4100.00' });
    const read = h.adapter.getPositions(undefined, { bypassRateLimit: true });
    h.streams.SHORT.emit(update([pos('ETHUSDT', '-0.4', '4090'), pos('BTCUSDT', '-0.01', '97000')]));
    gate.resolve(await h.short.getPositions());
    await read;
    h.streams.LONG.emit(update([pos('ETHUSDT', '0.6', '4010')]));
    expect(accountUpdates(events)[2].a.P.filter(p => p.ps === 'SHORT').map(p => [p.s, p.pa])).toEqual([['ETHUSDT', '-0.4'], ['BTCUSDT', '-0.01']]);

    // A read filtered to one symbol only touches that symbol
    h.exchange.short.setPosition(BTC, '0');
    await h.adapter.getPositions('ETHUSDT');
    h.streams.LONG.emit(update([pos('ETHUSDT', '0.6', '4010')]));
    expect(accountUpdates(events)[3].a.P.filter(p => p.ps === 'SHORT').map(p => [p.s, p.pa])).toEqual([['ETHUSDT', '-0.2000'], ['BTCUSDT', '-0.01']]);
  });

  it('the leverage events of both setLeverage calls reach the merged stream', async () => {
    const h = setup();
    h.streams.LONG.baselineOnSubscribe = baselineOf([], '1000');
    h.streams.SHORT.baselineOnSubscribe = baselineOf([], '250');
    const { events } = await subscribe(h);
    await h.adapter.setLeverage('ETHUSDT', 10);
    expect(events.filter(event => event.e === 'ACCOUNT_CONFIG_UPDATE').map(event => (event as any).ac)).toEqual([
      { s: 'ETHUSDT', l: 10 }, { s: 'ETHUSDT', l: 10 },
    ]);
  });
});

describe('LighterHedgeAdapter: startup checks', () => {
  it('passes for both accounts with the same master and reports them', async () => {
    const h = setup();
    const report = await h.adapter.verifyStartup();
    expect(report).toMatchObject({
      profile: 'testnet',
      long: { profile: 'testnet', accountIndex: HEDGE_LONG_ACCOUNT, apiKeyIndex: HEDGE_LONG_KEY },
      short: { profile: 'testnet', accountIndex: HEDGE_SHORT_ACCOUNT, apiKeyIndex: HEDGE_SHORT_KEY },
      sameMaster: true,
      wrongSign: [],
    });
    expect(requestsTo(h, 'SHORT', '/api/v1/apikeys')[0].request.url).toContain(`api_key_index=${HEDGE_SHORT_KEY}`);
    expect(h.alerts).toEqual([]);
  });

  it('refuses the same account for both sides before any request', async () => {
    const h = setup();
    h.setCredentials('SHORT', { ...h.credentials.SHORT, accountIndex: HEDGE_LONG_ACCOUNT });
    await expect(h.adapter.verifyStartup()).rejects.toThrow(/must differ from the main \(long\) account index/);
    expect(h.exchange.routed).toHaveLength(0);
  });

  it('names the failing account: unregistered, mismatched or maker-only short key', async () => {
    const unregistered = setup();
    unregistered.exchange.short.publicKey = '';
    const error = await unregistered.adapter.verifyStartup().catch(e => e);
    expect(error).toBeInstanceOf(LighterHedgeError);
    expect(error.message).toBe(
      'Lighter hedge mode startup checks failed: short account 23456 key 4: API key 4 is not registered for account 23456 on Lighter testnet'
    );
    expect(error.failures.SHORT).toBe(error.cause);

    const mismatched = setup();
    mismatched.exchange.short.publicKey = 'ef'.repeat(40);
    await expect(mismatched.adapter.verifyStartup()).rejects.toThrow(/short account 23456 key 4: the configured public key does not match/);

    const makerOnly = setup();
    makerOnly.exchange.short.makerOnlyKeys = [HEDGE_SHORT_KEY];
    makerOnly.exchange.long.makerOnlyKeys = [HEDGE_LONG_KEY];
    const both = await makerOnly.adapter.verifyStartup().catch(e => e);
    expect(both.message).toMatch(/long account 12345 key 7: API key 7 of account 12345 is maker-only.*; short account 23456 key 4: API key 4 of account 23456 is maker-only/);
    expect(Object.keys(both.failures)).toEqual(['LONG', 'SHORT']);
  });

  it('warns (never blocks) when the accounts belong to different masters, or when that cannot be told', async () => {
    const other = setup({ exchange: { shortL1Address: '0x' + '99'.repeat(20) } });
    const report = await other.adapter.verifyStartup();
    expect(report.sameMaster).toBe(false);
    expect(other.alerts).toEqual([expect.objectContaining({ kind: 'different-master', message: expect.stringContaining('different L1 addresses') })]);

    const unknown = setup({ exchange: { shortL1Address: null } });
    expect((await unknown.adapter.verifyStartup()).sameMaster).toBeNull();
    expect(unknown.alerts).toEqual([]);

    const sameDifferentCase = setup({ exchange: { shortL1Address: HEDGE_L1_ADDRESS.toLowerCase() } });
    expect((await sameDifferentCase.adapter.verifyStartup()).sameMaster).toBe(true);
  });

  it('reports wrong-direction positions on either account', async () => {
    const h = setup();
    h.exchange.short.setPosition(ETH, '0.2000');
    h.exchange.long.setPosition(BTC, '-0.01000');
    const report = await h.adapter.verifyStartup();
    expect(report.wrongSign).toEqual([
      { side: 'LONG', symbol: 'BTCUSDT', positionAmt: '-0.01000' },
      { side: 'SHORT', symbol: 'ETHUSDT', positionAmt: '0.2000' },
    ]);
    expect(h.alerts.map(alert => [alert.kind, alert.side, alert.symbol])).toEqual([['wrong-sign', 'LONG', 'BTCUSDT'], ['wrong-sign', 'SHORT', 'ETHUSDT']]);
  });
});

describe('LighterAdapter additions used by hedge mode', () => {
  it('configuredAccountIndex / configuredApiKeyIndex read the credentials without network and never throw', () => {
    const h = setup();
    expect(h.long.configuredAccountIndex()).toBe(HEDGE_LONG_ACCOUNT);
    expect(h.short.configuredAccountIndex()).toBe(HEDGE_SHORT_ACCOUNT);
    expect(h.short.configuredApiKeyIndex()).toBe(HEDGE_SHORT_KEY);
    h.setCredentials('SHORT', { accountIndex: '23456' });   // Incomplete, but the index is set
    expect(h.short.configuredAccountIndex()).toBe(HEDGE_SHORT_ACCOUNT);
    expect(h.short.hasCredentials()).toBe(false);
    h.setCredentials('SHORT', null);
    expect(h.short.configuredAccountIndex()).toBeNull();
    expect(h.short.configuredApiKeyIndex()).toBeNull();
    const throwing = new LighterAdapter({
      profile: 'testnet', credentials: () => { throw new Error('config unreadable'); }, markets: h.markets, transport: h.exchange.transport,
    });
    expect(throwing.configuredAccountIndex()).toBeNull();
    expect(throwing.clientOrderIndexRange).toBeNull();   // Plain one-way adapter: no range
    expect(h.exchange.routed).toHaveLength(0);
  });

  it('getAccountIdentity reads the L1 address from the public account endpoint', async () => {
    const h = setup({ exchange: { shortL1Address: null } });
    await expect(h.long.getAccountIdentity()).resolves.toEqual({ accountIndex: HEDGE_LONG_ACCOUNT, l1Address: HEDGE_L1_ADDRESS });
    await expect(h.short.getAccountIdentity()).resolves.toEqual({ accountIndex: HEDGE_SHORT_ACCOUNT, l1Address: null });
    const reads = h.exchange.routed.map(r => new URL(r.request.url));
    expect(reads.map(url => url.pathname)).toEqual(['/api/v1/account', '/api/v1/account']);
    expect(h.exchange.routed.every(r => r.request.headers?.authorization === undefined)).toBe(true);
  });

  it('sumLighterDecimals adds exactly at 6 decimals', () => {
    expect(sumLighterDecimals(['0.1', '0.2'])).toBe('0.3');
    expect(sumLighterDecimals(['1000', '-0.000001'])).toBe('999.999999');
    expect(sumLighterDecimals(['-1.5', '1.5'])).toBe('0');
    expect(sumLighterDecimals([undefined, null, '', 'abc'])).toBe('0');
    expect(sumLighterDecimals(['1.2345678'])).toBe('1.234567');
    expect(sumLighterDecimals(['9007199254740.993', '0.007'])).toBe('9007199254741');
    expect(sumLighterDecimals([])).toBe('0');
  });

  it('the fake keeps one-way defaults (account, key, public key, no l1_address)', async () => {
    const h = lighterHedgeHarness();
    expect(h.exchange.long.accountIndex).toBe(HEDGE_LONG_ACCOUNT);
    expect(h.exchange.long.publicKey).toBe(TEST_PUBLIC_KEY);
    expect(h.exchange.short.details).toBe(h.exchange.long.details);
    expect(h.exchange.short.books).toBe(h.exchange.long.books);
  });
});
