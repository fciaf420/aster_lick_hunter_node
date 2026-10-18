#!/usr/bin/env tsx

// Lighter hedge mode (two sub-accounts) end to end, fully offline. Hunter and PositionManager run in hedge mode on
// the composite adapter (longs on the main account, shorts on the short account); this file's stub-adapter cases
// pin the PositionManager and Hunter changes that hedge mode relies on.

import { PositionManager } from '../../src/lib/bot/positionManager';
import { Hunter } from '../../src/lib/bot/hunter';
import { LIGHTER_HEDGE_COI_SPAN } from '../../src/lib/exchange/lighter/nonce';
import type { ExchangeAdapter, OrderId, UserDataEvent } from '../../src/lib/exchange/types';
import type { LiquidationSource } from '../../src/lib/liquidation/types';
import type { Config } from '../../src/lib/types';
import {
  HEDGE_LONG_ACCOUNT,
  HEDGE_SHORT_ACCOUNT,
  HEDGE_SHORT_KEY,
  HEDGE_SHORT_PUBLIC_KEY,
  lighterHedgeHarness,
  type LighterHedgeHarness,
} from '../lib/lighter/fakeLighterHedge';
import { TEST_KEY_INDEX, TEST_PUBLIC_KEY, THROWAWAY_PRIVATE_KEY } from '../lib/lighter/fakeLighterExchange';
import {
  TestSummary,
  logSection,
  assert,
  assertEqual,
  finishTests,
  wait,
} from '../utils/test-helpers';

// ===== Stub adapter: canned positions and open orders, records what the PositionManager does =====

interface StubPosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  positionSide: string;
}

interface StubOrder {
  orderId: OrderId;
  side: 'BUY' | 'SELL';
  type: string;
  origQty: string;
  positionSide: string;
  reduceOnly?: boolean;
  symbol?: string;
}

function stubConfig(positionMode: 'HEDGE' | 'ONE_WAY' = 'HEDGE'): Config {
  return {
    api: { apiKey: '', secretKey: '' },
    symbols: {
      ETHUSDT: {
        longVolumeThresholdUSDT: 1000, shortVolumeThresholdUSDT: 1000, tradeSize: 405, leverage: 5,
        tpPercent: 3, slPercent: 2, orderType: 'MARKET', vwapProtection: false,
      },
    },
    global: { paperMode: false, riskPercent: 5, maxOpenPositions: 5, exchange: 'lighter', liquidationSource: 'lighter', positionMode },
    venues: { lighter: { profile: 'testnet' } },
  } as unknown as Config;
}

function exchangePosition(p: StubPosition) {
  return {
    symbol: p.symbol, positionAmt: p.positionAmt, entryPrice: p.entryPrice, markPrice: p.entryPrice, unRealizedProfit: '0',
    liquidationPrice: '0', leverage: '5', marginType: 'cross', isolatedMargin: '0', isAutoAddMargin: 'false',
    positionSide: p.positionSide, updateTime: Date.now(),
  };
}

function exchangeOrder(o: StubOrder) {
  return {
    symbol: o.symbol ?? 'ETHUSDT', orderId: o.orderId, clientOrderId: String(o.orderId), price: '0', origQty: o.origQty,
    executedQty: '0', status: 'NEW', type: o.type, side: o.side, stopPrice: '4000', time: Date.now() - 60_000,
    updateTime: Date.now() - 60_000, workingType: 'MARK_PRICE', origType: o.type, positionSide: o.positionSide,
    reduceOnly: o.reduceOnly ?? true,
  };
}

function stubAdapter(positions: StubPosition[], orders: StubOrder[]) {
  const cancelled: OrderId[] = [];
  const protective: Array<Record<string, unknown>> = [];
  const placed: Array<Record<string, unknown>> = [];
  const adapter = {
    id: 'lighter',
    capabilities: { marginAsset: 'USDC', hedgeMode: true },
    hasCredentials: () => true,
    getExchangeInfo: async () => ({ symbols: [] }),
    getPositions: async () => positions.map(exchangePosition),
    getOpenOrders: async () => orders.map(exchangeOrder),
    cancelOrder: async (_symbol: string, orderId: OrderId) => {
      cancelled.push(orderId);
      return { orderId, status: 'CANCELED' };
    },
    placeProtectiveOrders: async (request: Record<string, unknown>) => {
      protective.push(request);
      return { stopLoss: { orderId: 9001 }, takeProfit: { orderId: 9002 }, errors: [] };
    },
    placeOrder: async (request: Record<string, unknown>) => {
      placed.push(request);
      return { orderId: 9100 };
    },
    getTickerPrice: async () => ({ symbol: 'ETHUSDT', price: '4050' }),
    getMarkPrice: async () => ({ symbol: 'ETHUSDT', markPrice: '4050' }),
  };
  return { adapter: adapter as unknown as ExchangeAdapter, cancelled, protective, placed };
}

function tracked(pm: PositionManager): Map<string, { slOrderId?: OrderId; tpOrderId?: OrderId }> {
  return (pm as any).positionOrders;
}

function track(pm: PositionManager, positions: StubPosition[], orders: Record<string, { slOrderId?: OrderId; tpOrderId?: OrderId }>): void {
  const current: Map<string, unknown> = (pm as any).currentPositions;
  for (const position of positions) {
    const key = (pm as any).getPositionKey(position.symbol, position.positionSide, parseFloat(position.positionAmt));
    current.set(key, exchangePosition(position));
  }
  for (const [key, value] of Object.entries(orders)) tracked(pm).set(key, { ...value });
}

async function testPositionManagerHedgeSides() {
  logSection('PositionManager: SL/TP matching per hedge side');
  const summary = new TestSummary();

  await summary.run("An untracked BUY reduce-only SL/TP of a short is not an orphan when the symbol also has a long", async () => {
    const positions: StubPosition[] = [
      { symbol: 'ETHUSDT', positionAmt: '0.5', entryPrice: '4050', positionSide: 'LONG' },
      { symbol: 'ETHUSDT', positionAmt: '-0.3', entryPrice: '4050', positionSide: 'SHORT' },
    ];
    const stub = stubAdapter(positions, [
      { orderId: 101, side: 'SELL', type: 'STOP_MARKET', origQty: '0.5', positionSide: 'LONG' },
      { orderId: 102, side: 'SELL', type: 'TAKE_PROFIT_MARKET', origQty: '0.5', positionSide: 'LONG' },
      { orderId: 201, side: 'BUY', type: 'STOP_MARKET', origQty: '0.3', positionSide: 'SHORT' },
      { orderId: 202, side: 'BUY', type: 'TAKE_PROFIT_MARKET', origQty: '0.3', positionSide: 'SHORT' },
      { orderId: 299, side: 'BUY', type: 'STOP_MARKET', origQty: '0.7', positionSide: 'SHORT' },   // matches nothing
    ]);
    const pm = new PositionManager(stubConfig(), true, stub.adapter);
    // Only the long's orders are tracked (e.g. the short's SL/TP were placed before a restart)
    track(pm, positions, { ETHUSDT_LONG_HEDGE: { slOrderId: 101, tpOrderId: 102 } });
    await (pm as any).cleanupOrphanedOrders();
    assert(!stub.cancelled.includes(201) && !stub.cancelled.includes(202),
      `The short's own SL/TP (qty 0.3 against position -0.3) must survive, cancelled: ${stub.cancelled.join(', ')}`);
    assert(!stub.cancelled.includes(101) && !stub.cancelled.includes(102), "The long's SL/TP are untouched");
    assert(stub.cancelled.includes(299), 'An untracked reduce-only order matching no position is still cancelled');
  });

  await summary.run("Orders of the other hedge side are not counted as a position's duplicates", async () => {
    // A wrong-direction (short) position on the long account next to the short account's short: both are closed by
    // BUY reduce-only orders, each on its own account
    const positions: StubPosition[] = [
      { symbol: 'ETHUSDT', positionAmt: '-0.2', entryPrice: '4050', positionSide: 'LONG' },
      { symbol: 'ETHUSDT', positionAmt: '-0.3', entryPrice: '4050', positionSide: 'SHORT' },
    ];
    const stub = stubAdapter(positions, [
      { orderId: 111, side: 'BUY', type: 'STOP_MARKET', origQty: '0.2', positionSide: 'LONG' },
      { orderId: 112, side: 'BUY', type: 'TAKE_PROFIT_MARKET', origQty: '0.2', positionSide: 'LONG' },
      { orderId: 211, side: 'BUY', type: 'STOP_MARKET', origQty: '0.3', positionSide: 'SHORT' },
      { orderId: 212, side: 'BUY', type: 'TAKE_PROFIT_MARKET', origQty: '0.3', positionSide: 'SHORT' },
    ]);
    const pm = new PositionManager(stubConfig(), true, stub.adapter);
    track(pm, positions, {
      ETHUSDT_LONG_HEDGE: { slOrderId: 111, tpOrderId: 112 },
      ETHUSDT_SHORT_HEDGE: { slOrderId: 211, tpOrderId: 212 },
    });
    await (pm as any).cleanupOrphanedOrders();
    assertEqual(stub.cancelled.join(', '), '', 'Nothing is cancelled as a duplicate or orphan');
  });

  await summary.run('Sync assigns SL/TP to the position of their own hedge side, not the first quantity match', async () => {
    const positions: StubPosition[] = [
      { symbol: 'ETHUSDT', positionAmt: '-0.3', entryPrice: '4050', positionSide: 'LONG' },
      { symbol: 'ETHUSDT', positionAmt: '-0.3', entryPrice: '4050', positionSide: 'SHORT' },
    ];
    // The short account's orders come first in the list
    const stub = stubAdapter(positions, [
      { orderId: 211, side: 'BUY', type: 'STOP_MARKET', origQty: '0.3', positionSide: 'SHORT' },
      { orderId: 212, side: 'BUY', type: 'TAKE_PROFIT_MARKET', origQty: '0.3', positionSide: 'SHORT' },
      { orderId: 111, side: 'BUY', type: 'STOP_MARKET', origQty: '0.3', positionSide: 'LONG' },
      { orderId: 112, side: 'BUY', type: 'TAKE_PROFIT_MARKET', origQty: '0.3', positionSide: 'LONG' },
    ]);
    const pm = new PositionManager(stubConfig(), true, stub.adapter);
    await (pm as any).syncWithExchange();
    assertEqual(JSON.stringify(tracked(pm).get('ETHUSDT_LONG_HEDGE')), JSON.stringify({ slOrderId: 111, tpOrderId: 112 }), 'Long account position');
    assertEqual(JSON.stringify(tracked(pm).get('ETHUSDT_SHORT_HEDGE')), JSON.stringify({ slOrderId: 211, tpOrderId: 212 }), 'Short account position');
    assertEqual(stub.protective.length + stub.cancelled.length, 0, 'Both protected: nothing placed or cancelled');
  });

  await summary.run("A side's missing SL/TP are placed even when the other account has matching BUY orders", async () => {
    const positions: StubPosition[] = [
      { symbol: 'ETHUSDT', positionAmt: '-0.3', entryPrice: '4050', positionSide: 'LONG' },
      { symbol: 'ETHUSDT', positionAmt: '-0.3', entryPrice: '4050', positionSide: 'SHORT' },
    ];
    const stub = stubAdapter(positions, [
      { orderId: 111, side: 'BUY', type: 'STOP_MARKET', origQty: '0.3', positionSide: 'LONG' },
      { orderId: 112, side: 'BUY', type: 'TAKE_PROFIT_MARKET', origQty: '0.3', positionSide: 'LONG' },
    ]);
    const pm = new PositionManager(stubConfig(), true, stub.adapter);
    await (pm as any).syncWithExchange();
    assertEqual(stub.protective.length, 1, 'One SL/TP placement');
    assertEqual(stub.protective[0].positionSide, 'SHORT', 'For the short account position');
    assertEqual(stub.protective[0].side, 'BUY', 'Closing side of a short');
    assertEqual(JSON.stringify(tracked(pm).get('ETHUSDT_LONG_HEDGE')), JSON.stringify({ slOrderId: 111, tpOrderId: 112 }), 'The long account keeps its own');
    assertEqual(JSON.stringify(tracked(pm).get('ETHUSDT_SHORT_HEDGE')), JSON.stringify({ slOrderId: 9001, tpOrderId: 9002 }), 'The short account gets new ones');
  });

  await summary.run('A NEW SL event is tracked on the position of its hedge side (o.ps), whatever the quantity', async () => {
    const positions: StubPosition[] = [
      { symbol: 'ETHUSDT', positionAmt: '-0.2', entryPrice: '4050', positionSide: 'LONG' },
      { symbol: 'ETHUSDT', positionAmt: '-0.3', entryPrice: '4050', positionSide: 'SHORT' },
    ];
    const stub = stubAdapter(positions, []);
    const pm = new PositionManager(stubConfig(), true, stub.adapter);
    track(pm, positions, {});
    (pm as any).handleEvent({
      e: 'ORDER_TRADE_UPDATE', E: Date.now(), T: Date.now(),
      o: { s: 'ETHUSDT', c: 'al_sl_ETHUSDT_1', S: 'BUY', o: 'STOP_MARKET', q: '0.2', p: '0', sp: '4100', x: 'NEW', X: 'NEW', i: 777, ps: 'SHORT', R: true },
    });
    assertEqual(tracked(pm).get('ETHUSDT_SHORT_HEDGE')?.slOrderId, 777, 'Tracked on the short account position');
    assertEqual(tracked(pm).get('ETHUSDT_LONG_HEDGE')?.slOrderId, undefined, 'Not on the long account position with the equal quantity');
  });

  await summary.run('The long and the short of one symbol closing back to back each get their own SL/TP cancelled', async () => {
    const positions: StubPosition[] = [
      { symbol: 'ETHUSDT', positionAmt: '0.5', entryPrice: '4050', positionSide: 'LONG' },
      { symbol: 'ETHUSDT', positionAmt: '-0.3', entryPrice: '4050', positionSide: 'SHORT' },
    ];
    const stub = stubAdapter(positions, []);
    const cancel = stub.adapter.cancelOrder.bind(stub.adapter);
    stub.adapter.cancelOrder = async (symbol: string, orderId: OrderId) => {
      const result = await cancel(symbol, orderId);
      await wait(50);   // The first side's cancels are still in flight when the second side closes
      return result;
    };
    const pm = new PositionManager(stubConfig(), true, stub.adapter);
    track(pm, positions, {
      ETHUSDT_LONG_HEDGE: { slOrderId: 101, tpOrderId: 102 },
      ETHUSDT_SHORT_HEDGE: { slOrderId: 201, tpOrderId: 202 },
    });
    const row = (pa: string, ps: string) => ({ s: 'ETHUSDT', pa, ep: '4050', up: '0', mt: 'cross', iw: '0', ps });
    // Each update lists the symbol through the side that is still open; the side left out is closed
    (pm as any).handleEvent({ e: 'ACCOUNT_UPDATE', E: Date.now(), a: { m: 'ORDER', B: [], P: [row('-0.3', 'SHORT')] } });
    (pm as any).handleEvent({ e: 'ACCOUNT_UPDATE', E: Date.now(), a: { m: 'ORDER', B: [], P: [row('0.5', 'LONG')] } });
    await wait(400);
    assertEqual(stub.cancelled.map(String).sort().join(', '), '101, 102, 201, 202', 'Both positions\' SL and TP are cancelled');
  });

  await summary.run('One-way mode is unchanged: BOTH orders match by side and quantity', async () => {
    const positions: StubPosition[] = [{ symbol: 'ETHUSDT', positionAmt: '0.5', entryPrice: '4050', positionSide: 'BOTH' }];
    const stub = stubAdapter(positions, [
      { orderId: 301, side: 'SELL', type: 'STOP_MARKET', origQty: '0.5', positionSide: 'BOTH' },
      { orderId: 302, side: 'SELL', type: 'TAKE_PROFIT_MARKET', origQty: '0.5', positionSide: 'BOTH' },
    ]);
    const pm = new PositionManager(stubConfig('ONE_WAY'), false, stub.adapter);
    await (pm as any).syncWithExchange();
    assertEqual(JSON.stringify(tracked(pm).get('ETHUSDT_LONG_BOTH')), JSON.stringify({ slOrderId: 301, tpOrderId: 302 }), 'Matched');
    (pm as any).handleEvent({
      e: 'ORDER_TRADE_UPDATE', E: Date.now(), T: Date.now(),
      o: { s: 'ETHUSDT', c: 'x', S: 'SELL', o: 'STOP_MARKET', q: '0.5', p: '0', sp: '3900', x: 'NEW', X: 'NEW', i: 303, ps: 'BOTH', R: true },
    });
    assertEqual(tracked(pm).get('ETHUSDT_LONG_BOTH')?.slOrderId, 303, 'A NEW BOTH SL is tracked as before');
    await (pm as any).cleanupOrphanedOrders();
    assertEqual(stub.cancelled.join(', '), '', 'Nothing cancelled');
  });

  summary.print();
}

// ===== Hunter: the margin of the account the entry goes to =====

async function testHunterEntryMargin() {
  logSection('Hunter: available margin per hedge account');
  const summary = new TestSummary();
  const noPositions = {
    getMarginUsage: () => 0,
    getTotalPositionCount: () => 0,
    getUniquePositionCount: () => 0,
    getPositionsMap: () => new Map(),
  };

  await summary.run('Entries read getEntryMargin of their side; getAccountInfo is not used', async () => {
    const calls: string[] = [];
    const placed: string[] = [];
    const adapter = {
      id: 'lighter',
      capabilities: { marginAsset: 'USDC', hedgeMode: true },
      hasCredentials: () => true,
      getHedgeMode: async () => true,
      getEntryMargin: async (side: 'LONG' | 'SHORT') => {
        calls.push(side);
        return side === 'LONG'
          ? { totalWalletBalance: '1000', availableBalance: '20' }
          : { totalWalletBalance: '1000', availableBalance: '30' };
      },
      getAccountInfo: async () => {
        calls.push('getAccountInfo');
        return { totalWalletBalance: '5000', availableBalance: '5000' };
      },
      placeOrder: async (request: { side: string }) => {
        placed.push(request.side);
        return { orderId: 1 };
      },
    } as unknown as ExchangeAdapter;
    const config = stubConfig();
    const hunter = new Hunter(config, true, adapter);
    hunter.setPositionTracker(noPositions as any);
    const errors: Array<{ title: string; details: any }> = [];
    hunter.setStatusBroadcaster({
      broadcastTradingError: (title: string, _message: string, context: any) => errors.push({ title, details: context?.details }),
    });
    (hunter as any).lastModeSync = Date.now();
    await (hunter as any).placeTrade('ETHUSDT', 'SELL', config.symbols.ETHUSDT, 4050);
    await (hunter as any).placeTrade('ETHUSDT', 'BUY', config.symbols.ETHUSDT, 4050);
    assertEqual(calls.join(', '), 'SHORT, LONG', 'SELL reads the short account, BUY the long account');
    assertEqual(placed.length, 0, 'Both skipped: 30 and 20 USDC available, 405 required');
    assertEqual(errors.map(e => e.details?.availableBalance).join(', '), '30.00, 20.00', 'The reported margin is the side account\'s');
  });

  await summary.run('Adapters without getEntryMargin keep reading getAccountInfo (Aster, one-way Lighter)', async () => {
    const calls: string[] = [];
    const adapter = {
      id: 'lighter',
      capabilities: { marginAsset: 'USDC', hedgeMode: false },
      hasCredentials: () => true,
      getHedgeMode: async () => false,
      getAccountInfo: async () => {
        calls.push('getAccountInfo');
        return { totalWalletBalance: '100', availableBalance: '10' };
      },
      placeOrder: async () => {
        throw new Error('no order expected');
      },
    } as unknown as ExchangeAdapter;
    const config = stubConfig('ONE_WAY');
    const hunter = new Hunter(config, false, adapter);
    hunter.setPositionTracker(noPositions as any);
    (hunter as any).lastModeSync = Date.now();
    await (hunter as any).placeTrade('ETHUSDT', 'SELL', config.symbols.ETHUSDT, 4050);
    assertEqual(calls.join(', '), 'getAccountInfo', 'Read once, as before');
  });

  summary.print();
}

// ===== Hunter + PositionManager over two fake Lighter sub-accounts =====

const ETH = 0;   // Fixture market: ETH, size decimals 4, price decimals 2, mark 4050
const TX_CREATE = 14;
const TX_CANCEL = 15;
const TX_CANCEL_ALL = 16;
const TX_GROUPED = 28;

// Bot config as saved by the config page for hedge mode: venue Lighter, position mode HEDGE, hedge enabled with a
// complete short account. Entries are MARKET so each signal is one create-order tx.
function hedgeFlowConfig(): Config {
  return {
    api: { apiKey: '', secretKey: '' },
    symbols: {
      ETHUSDT: {
        longVolumeThresholdUSDT: 1000, shortVolumeThresholdUSDT: 1000, tradeSize: 405, leverage: 5,
        tpPercent: 3, slPercent: 2, orderType: 'MARKET', vwapProtection: false,
      },
    },
    global: { paperMode: false, riskPercent: 5, maxOpenPositions: 5, exchange: 'lighter', liquidationSource: 'lighter', positionMode: 'HEDGE' },
    venues: {
      lighter: {
        profile: 'testnet',
        accountIndex: HEDGE_LONG_ACCOUNT,
        apiKeyIndex: TEST_KEY_INDEX,
        apiKeyPrivateKey: THROWAWAY_PRIVATE_KEY,
        apiKeyPublicKey: TEST_PUBLIC_KEY,
        hedge: {
          enabled: true,
          shortAccount: {
            accountIndex: HEDGE_SHORT_ACCOUNT,
            apiKeyIndex: HEDGE_SHORT_KEY,
            apiKeyPrivateKey: THROWAWAY_PRIVATE_KEY,
            apiKeyPublicKey: HEDGE_SHORT_PUBLIC_KEY,
          },
        },
      },
    },
  } as unknown as Config;
}

class FakeSource implements LiquidationSource {
  readonly id = 'lighter' as const;
  start(): void {}
  stop(): void {}
}

async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await wait(20);
  }
}

// What one sub-account's real stream delivers: its own full position set, ps BOTH (the composite sets LONG / SHORT)
function accountUpdate(positionAmt: string, entryPrice: string, walletBalance = '1000'): UserDataEvent {
  const now = Date.now();
  return {
    e: 'ACCOUNT_UPDATE',
    E: now,
    T: now,
    a: {
      m: 'ORDER',
      B: [{ a: 'USDC', wb: walletBalance, cw: walletBalance, bc: '0' }],
      P: [{ s: 'ETHUSDT', pa: positionAmt, ep: entryPrice, up: '0', mt: 'cross', iw: '0', ps: 'BOTH' }],
    },
  };
}

function orderUpdate(fields: { i: number; S: 'BUY' | 'SELL'; o: string; X: string; q: string; R: boolean; rp?: string }): UserDataEvent {
  const now = Date.now();
  return {
    e: 'ORDER_TRADE_UPDATE',
    E: now,
    T: now,
    o: {
      s: 'ETHUSDT', c: String(fields.i), S: fields.S, o: fields.o, f: 'IOC', q: fields.q, p: '0', ap: '4050', sp: '0',
      x: fields.X === 'FILLED' ? 'TRADE' : fields.X, X: fields.X, i: fields.i, l: fields.q, z: fields.X === 'FILLED' ? fields.q : '0',
      L: '4050', R: fields.R, ps: 'BOTH', ...(fields.rp !== undefined ? { rp: fields.rp } : {}),
    },
  };
}

function txCounts(h: LighterHedgeHarness): string {
  const count = (side: 'LONG' | 'SHORT') => [TX_CREATE, TX_CANCEL, TX_CANCEL_ALL, TX_GROUPED]
    .map(type => h.exchange.fake(side).received.filter(tx => tx.txType === type).length).join('/');
  return `long ${count('LONG')}, short ${count('SHORT')}`;
}

function ocoLegs(h: LighterHedgeHarness, side: 'LONG' | 'SHORT', nth: number) {
  const oco = h.exchange.txs(side, TX_GROUPED)[nth];
  const [sl, tp] = oco.info.Orders as Array<Record<string, number>>;
  return { oco, sl, tp };
}

async function testHedgeFlowOnTwoAccounts() {
  logSection('Lighter hedge mode: Hunter + PositionManager on two sub-accounts');
  const summary = new TestSummary();
  const h = lighterHedgeHarness({ credentials: true, symbols: ['ETHUSDT'] });
  h.exchange.long.setBook(ETH, [['4049.90', '5.0000']], [['4050.10', '5.0000']]);   // Shared by both accounts
  const config = hedgeFlowConfig();
  const pm = new PositionManager(config, true, h.adapter);
  const hunter = new Hunter(config, true, h.adapter, new FakeSource());
  hunter.setPositionTracker(pm);
  const tradingErrors: Array<{ title: string; details: any }> = [];
  // Records trading errors; every other broadcast is a no-op
  hunter.setStatusBroadcaster(new Proxy({}, {
    get: (_target, name) => name === 'broadcastTradingError'
      ? (title: string, _message: string, context: any) => tradingErrors.push({ title, details: context?.details })
      : () => undefined,
  }));
  const cancels: Array<{ orderId: OrderId; result?: any; error?: any }> = [];
  const cancelOrder = h.adapter.cancelOrder.bind(h.adapter);
  h.adapter.cancelOrder = async (symbol, orderId) => {
    try {
      const result = await cancelOrder(symbol, orderId);
      cancels.push({ orderId, result });
      return result;
    } catch (error) {
      cancels.push({ orderId, error });
      throw error;
    }
  };
  const positionOrders = () => (pm as any).positionOrders as Map<string, { slOrderId?: OrderId; tpOrderId?: OrderId }>;
  const currentPositions = () => (pm as any).currentPositions as Map<string, { positionAmt: string; positionSide: string }>;
  const entry = async (side: 'BUY' | 'SELL') => {
    (hunter as any).lastModeSync = Date.now();
    await (hunter as any).placeTrade('ETHUSDT', side, config.symbols.ETHUSDT, 4050);
  };
  let longSl = 0;
  let longTp = 0;
  let shortSl = 0;
  let shortTp = 0;

  try {
    await pm.start();
    await waitFor(() => h.streams.LONG.handlers !== null && h.streams.SHORT.handlers !== null, 3000, 'both account streams');
    await waitFor(() => (pm as any).orderCheckInterval !== undefined, 3000, 'onConnected (both accounts connected)');

    await summary.run('1. Long entry goes to the long account only; its fill gets an OCO on the long account', async () => {
      await entry('BUY');
      const longEntries = h.exchange.txs('LONG', TX_CREATE);
      assertEqual(longEntries.length, 1, `One create-order tx on the long account (${txCounts(h)})`);
      assertEqual(h.exchange.txs('SHORT', TX_CREATE).length, 0, 'Nothing created on the short account');
      const order = longEntries[0].info;
      assertEqual(order.AccountIndex, HEDGE_LONG_ACCOUNT, 'Signed for the long account');
      assertEqual(order.IsAsk, 0, 'BUY');
      assertEqual(order.ReduceOnly, 0, 'An opening order');
      assertEqual(order.BaseAmount, 5000, '405 USDC x5 at 4050 = 0.5 ETH');
      assert(order.ClientOrderIndex < LIGHTER_HEDGE_COI_SPAN, `Long range client order index (${order.ClientOrderIndex})`);

      h.exchange.long.setPosition(ETH, '0.5000', { avg_entry_price: '4050.00' });
      h.streams.LONG.emit(orderUpdate({ i: order.ClientOrderIndex, S: 'BUY', o: 'MARKET', X: 'FILLED', q: '0.5000', R: false }));
      h.streams.LONG.emit(accountUpdate('0.5000', '4050.00'));
      await waitFor(() => h.exchange.txs('LONG', TX_GROUPED).length === 1, 5000, 'the long OCO');
      const { oco, sl, tp } = ocoLegs(h, 'LONG', 0);
      assertEqual(oco.info.AccountIndex, HEDGE_LONG_ACCOUNT, 'OCO on the long account');
      assert(sl.IsAsk === 1 && tp.IsAsk === 1, 'SELL legs');
      assert(sl.ReduceOnly === 1 && tp.ReduceOnly === 1, 'Reduce-only legs');
      assert(sl.BaseAmount === 5000 && tp.BaseAmount === 5000, 'Sized from the long position');
      assertEqual(h.exchange.txs('SHORT', TX_GROUPED).length, 0, 'No OCO on the short account');
      await waitFor(() => positionOrders().get('ETHUSDT_LONG_HEDGE')?.tpOrderId !== undefined, 2000, 'long order tracking');
      longSl = sl.ClientOrderIndex;
      longTp = tp.ClientOrderIndex;
      assertEqual(JSON.stringify(positionOrders().get('ETHUSDT_LONG_HEDGE')), JSON.stringify({ slOrderId: longSl, tpOrderId: longTp }), 'Tracked under the long hedge key');
      assertEqual((hunter as any).pendingOrders.size, 0, 'The fill cleared the hunter\'s pending entry');
    });

    await summary.run('2. A SELL signal while long opens a short on the short account (no netting); its OCO goes there too', async () => {
      await entry('SELL');
      const shortEntries = h.exchange.txs('SHORT', TX_CREATE);
      assertEqual(shortEntries.length, 1, `One create-order tx on the short account (${txCounts(h)})`);
      assertEqual(h.exchange.txs('LONG', TX_CREATE).length, 1, 'Nothing new on the long account: the long is not reduced');
      const order = shortEntries[0].info;
      assertEqual(order.AccountIndex, HEDGE_SHORT_ACCOUNT, 'Signed for the short account');
      assertEqual(order.IsAsk, 1, 'SELL');
      assertEqual(order.ReduceOnly, 0, 'An opening order');
      assert(order.ClientOrderIndex >= LIGHTER_HEDGE_COI_SPAN, `Short range client order index (${order.ClientOrderIndex})`);

      h.exchange.short.setPosition(ETH, '-0.5000', { avg_entry_price: '4050.00' });
      h.streams.SHORT.emit(orderUpdate({ i: order.ClientOrderIndex, S: 'SELL', o: 'MARKET', X: 'FILLED', q: '0.5000', R: false }));
      h.streams.SHORT.emit(accountUpdate('-0.5000', '4050.00'));
      await waitFor(() => h.exchange.txs('SHORT', TX_GROUPED).length === 1, 5000, 'the short OCO');
      const { oco, sl, tp } = ocoLegs(h, 'SHORT', 0);
      assertEqual(oco.info.AccountIndex, HEDGE_SHORT_ACCOUNT, 'OCO on the short account');
      assert(sl.IsAsk === 0 && tp.IsAsk === 0, 'BUY legs');
      assert(sl.ReduceOnly === 1 && tp.ReduceOnly === 1, 'Reduce-only legs');
      assert(sl.BaseAmount === 5000 && tp.BaseAmount === 5000, 'Sized from the short position');
      assertEqual(h.exchange.txs('LONG', TX_GROUPED).length, 1, 'No new OCO on the long account');
      await waitFor(() => positionOrders().get('ETHUSDT_SHORT_HEDGE')?.tpOrderId !== undefined, 2000, 'short order tracking');
      shortSl = sl.ClientOrderIndex;
      shortTp = tp.ClientOrderIndex;
      assertEqual(JSON.stringify(positionOrders().get('ETHUSDT_LONG_HEDGE')), JSON.stringify({ slOrderId: longSl, tpOrderId: longTp }), 'Long keeps its SL/TP');
      assertEqual(JSON.stringify(positionOrders().get('ETHUSDT_SHORT_HEDGE')), JSON.stringify({ slOrderId: shortSl, tpOrderId: shortTp }), 'Short has its own');
      assertEqual(new Set([longSl, longTp, shortSl, shortTp]).size, 4, 'Four distinct order ids');
      assertEqual(currentPositions().get('ETHUSDT_LONG_HEDGE')?.positionAmt, '0.5000', 'PositionManager still holds the long');
      assertEqual(currentPositions().get('ETHUSDT_SHORT_HEDGE')?.positionAmt, '-0.5000', 'and the short');
      const longPosition = h.exchange.long.account.positions.find(p => p.market_id === ETH);
      assertEqual(`${longPosition?.sign === -1 ? '-' : ''}${longPosition?.position}`, '0.5000', 'The long account still holds +0.5');
    });

    await summary.run('4. The periodic check and orphan cleanup make no cross-account cancels or replacements', async () => {
      const before = txCounts(h);
      await (pm as any).checkAndAdjustOrders();
      await (pm as any).cleanupOrphanedOrders();
      assertEqual(txCounts(h), before, 'No tx on either account');
      assertEqual(cancels.length, 0, 'Nothing cancelled');

      // The short's SL/TP untracked (e.g. after a restart): same quantity as the long, other side and account
      positionOrders().delete('ETHUSDT_SHORT_HEDGE');
      await (pm as any).cleanupOrphanedOrders();
      assertEqual(txCounts(h), before, 'The untracked BUY reduce-only orders of the short are not orphans');
      await (pm as any).checkAndAdjustOrders();
      assertEqual(txCounts(h), before, 'Re-matched, not replaced');
      assertEqual(JSON.stringify(positionOrders().get('ETHUSDT_SHORT_HEDGE')), JSON.stringify({ slOrderId: shortSl, tpOrderId: shortTp }), 'Short tracking restored from its own account');
      assertEqual(JSON.stringify(positionOrders().get('ETHUSDT_LONG_HEDGE')), JSON.stringify({ slOrderId: longSl, tpOrderId: longTp }), 'Long tracking unchanged');
    });

    await summary.run('3. The short\'s TP fills and the short account goes flat: only the short is cleaned up', async () => {
      const tpOrder = h.exchange.short.findOrder(shortTp)!;
      const slOrder = h.exchange.short.findOrder(shortSl)!;
      tpOrder.status = 'filled';
      tpOrder.filled_base_amount = '0.5000';
      tpOrder.remaining_base_amount = '0.0000';
      slOrder.status = 'canceled-oco';
      h.exchange.short.setPosition(ETH, '0');
      h.streams.SHORT.emit(orderUpdate({ i: shortTp, S: 'BUY', o: 'TAKE_PROFIT_MARKET', X: 'FILLED', q: '0.5000', R: true, rp: '121.5' }));
      await waitFor(() => cancels.length === 1, 3000, 'the short SL cancel');
      assertEqual(cancels[0].orderId, shortSl, 'Only the short\'s SL sibling is cancelled');
      assertEqual(cancels[0].result?.alreadyTerminal, true, 'Already gone with the OCO (no tx)');
      h.streams.SHORT.emit(accountUpdate('0', '0'));
      await wait(300);
      assertEqual(h.exchange.long.received.filter(tx => tx.txType === TX_CANCEL || tx.txType === TX_CANCEL_ALL).length, 0, 'No cancel tx on the long account');
      assertEqual(h.exchange.short.received.filter(tx => tx.txType === TX_CANCEL || tx.txType === TX_CANCEL_ALL).length, 0, 'None on the short account either');
      assertEqual(positionOrders().has('ETHUSDT_SHORT_HEDGE'), false, 'Short tracking removed');
      assertEqual(currentPositions().has('ETHUSDT_SHORT_HEDGE'), false, 'Short position removed');
      assertEqual(JSON.stringify(positionOrders().get('ETHUSDT_LONG_HEDGE')), JSON.stringify({ slOrderId: longSl, tpOrderId: longTp }), 'Long SL/TP still tracked');
      assertEqual(currentPositions().get('ETHUSDT_LONG_HEDGE')?.positionAmt, '0.5000', 'Long position still held');
      assertEqual(`${h.exchange.long.findOrder(longSl)?.status}/${h.exchange.long.findOrder(longTp)?.status}`, 'pending/pending', 'Long SL/TP still open on the exchange');
    });

    await summary.run('6. The SELL margin check reads the short account: low short margin skips it while the long account is rich', async () => {
      const before = txCounts(h);
      h.exchange.short.account.available_balance = '50.000000';
      try {
        tradingErrors.length = 0;
        await entry('SELL');
        assertEqual(txCounts(h), before, 'No order on either account');
        assertEqual(tradingErrors.length, 1, 'One insufficient-margin report');
        assertEqual(tradingErrors[0].details?.availableBalance, '50.00', 'The short account\'s available margin');
        const longMargin = await h.adapter.getEntryMargin!('LONG');
        assertEqual(longMargin.availableBalance, '800', 'The long account has 800 available');
      } finally {
        h.exchange.short.account.available_balance = '800.000000';
      }
    });

    await summary.run('5. A manual long on the short account alerts once, stays protected, and refuses the next SELL entry', async () => {
      h.exchange.short.setPosition(ETH, '0.2000', { avg_entry_price: '4050.00' });
      h.streams.SHORT.emit(accountUpdate('0.2000', '4050.00'));
      await waitFor(() => h.alerts.some(a => a.kind === 'wrong-sign'), 2000, 'the wrong-direction alert');
      const wrongSign = h.alerts.filter(a => a.kind === 'wrong-sign');
      assertEqual(wrongSign.length, 1, 'One alert');
      assertEqual(`${wrongSign[0].side} ${wrongSign[0].symbol}`, 'SHORT ETHUSDT', 'Names the account and symbol');

      // Still protected: SELL reduce-only legs on the short account
      await waitFor(() => h.exchange.txs('SHORT', TX_GROUPED).length === 2, 5000, 'the OCO for the wrong-direction position');
      const { oco, sl, tp } = ocoLegs(h, 'SHORT', 1);
      assertEqual(oco.info.AccountIndex, HEDGE_SHORT_ACCOUNT, 'On the short account');
      assert(sl.IsAsk === 1 && tp.IsAsk === 1 && sl.ReduceOnly === 1 && tp.ReduceOnly === 1, 'SELL reduce-only legs');
      assert(sl.BaseAmount === 2000 && tp.BaseAmount === 2000, 'Sized from the 0.2 position');

      const createsBefore = h.exchange.txs('SHORT', TX_CREATE).length;
      await entry('SELL');
      assertEqual(h.exchange.txs('SHORT', TX_CREATE).length, createsBefore, 'The SELL entry is refused: no tx');
      assertEqual(h.exchange.fake('SHORT').received.filter(tx => tx.txType === TX_CREATE).length, createsBefore, 'Nothing was even sent');
      assertEqual(h.alerts.filter(a => a.kind === 'wrong-sign').length, 1, 'No second alert for the same position');
      assertEqual((hunter as any).pendingOrders.size, 0, 'The refused entry leaves no pending order');

      // Closed by hand: entries work again
      h.exchange.short.setPosition(ETH, '0');
      h.streams.SHORT.emit(accountUpdate('0', '0'));
      await wait(300);
      await entry('SELL');
      assertEqual(h.exchange.txs('SHORT', TX_CREATE).length, createsBefore + 1, 'The next SELL entry goes out once the account is flat');
      assertEqual(h.exchange.txs('LONG', TX_CREATE).length, 1, 'Still nothing new on the long account');
    });

    await summary.run('7. Cancels go to the account holding the order: re-sizing the long touches only the long account; a hand-placed short-account order is found on the short account', async () => {
      // Both sides open again: case 5's SELL entry fills on the short account and gets its OCO there
      const shortCreates = h.exchange.txs('SHORT', TX_CREATE);
      const shortEntry = shortCreates[shortCreates.length - 1].info;
      h.exchange.short.setPosition(ETH, '-0.5000', { avg_entry_price: '4050.00' });
      h.streams.SHORT.emit(orderUpdate({ i: shortEntry.ClientOrderIndex, S: 'SELL', o: 'MARKET', X: 'FILLED', q: '0.5000', R: false }));
      h.streams.SHORT.emit(accountUpdate('-0.5000', '4050.00'));
      await waitFor(() => h.exchange.txs('SHORT', TX_GROUPED).length === 3, 5000, 'the new short OCO');
      const short = ocoLegs(h, 'SHORT', 2);
      await waitFor(() => positionOrders().get('ETHUSDT_SHORT_HEDGE')?.tpOrderId === short.tp.ClientOrderIndex, 2000, 'short order tracking');
      const shortTracking = JSON.stringify(positionOrders().get('ETHUSDT_SHORT_HEDGE'));
      const shortSentBefore = h.exchange.short.received.length;
      const longCancelsBefore = h.exchange.txs('LONG', TX_CANCEL).length;

      // The long is partly closed by hand (0.5 -> 0.3): PositionManager replaces its SL/TP with 0.3-sized ones
      h.exchange.long.setPosition(ETH, '0.3000', { avg_entry_price: '4050.00' });
      h.streams.LONG.emit(accountUpdate('0.3000', '4050.00'));
      await waitFor(() => h.exchange.txs('LONG', TX_GROUPED).length === 2, 5000, 'the re-sized long OCO');
      const longCancels = h.exchange.txs('LONG', TX_CANCEL).slice(longCancelsBefore);
      assertEqual(longCancels.map(tx => String(tx.info.Index)).sort().join(', '), [String(longSl), String(longTp)].sort().join(', '),
        'Both old long legs are cancelled, by their client order index');
      assert(longCancels.every(tx => tx.info.AccountIndex === HEDGE_LONG_ACCOUNT), 'Signed for the long account');
      assertEqual(`${h.exchange.long.findOrder(longSl)?.status}/${h.exchange.long.findOrder(longTp)?.status}`, 'canceled/canceled', 'Old long legs gone');
      const resized = ocoLegs(h, 'LONG', 1);
      assertEqual(resized.oco.info.AccountIndex, HEDGE_LONG_ACCOUNT, 'New OCO on the long account');
      assert(resized.sl.IsAsk === 1 && resized.tp.IsAsk === 1 && resized.sl.ReduceOnly === 1 && resized.tp.ReduceOnly === 1, 'SELL reduce-only legs');
      assert(resized.sl.BaseAmount === 3000 && resized.tp.BaseAmount === 3000, 'Sized from the 0.3 long');
      await waitFor(() => positionOrders().get('ETHUSDT_LONG_HEDGE')?.tpOrderId === resized.tp.ClientOrderIndex, 2000, 'long re-tracking');
      assertEqual(h.exchange.short.received.length, shortSentBefore, 'Nothing sent to the short account');
      assertEqual(JSON.stringify(positionOrders().get('ETHUSDT_SHORT_HEDGE')), shortTracking, 'Short SL/TP tracking untouched');
      assertEqual(`${h.exchange.short.findOrder(short.sl.ClientOrderIndex)?.status}/${h.exchange.short.findOrder(short.tp.ClientOrderIndex)?.status}`,
        'pending/pending', 'Short SL/TP still open on the exchange');
      assertEqual(currentPositions().get('ETHUSDT_SHORT_HEDGE')?.positionAmt, '-0.5000', 'Short position still held');

      // The orphan cleanup cancels two kinds of leftover orders on the short account, nothing on the long account:
      // - the SL/TP of case 5's hand-closed wrong-direction position (a close seen in ACCOUNT_UPDATE only drops their
      //   tracking; the cleanup removes them): bot orders, routed by their short-range client order index;
      // - a reduce-only stop placed by hand on the short account (no client order index) that fits no position: its
      //   exchange order_index names no account, so the long account is asked first (unknown there, nothing signed),
      //   then the short account cancels it.
      const stale = ocoLegs(h, 'SHORT', 1);
      assertEqual(`${h.exchange.short.findOrder(stale.sl.ClientOrderIndex)?.status}/${h.exchange.short.findOrder(stale.tp.ClientOrderIndex)?.status}`,
        'pending/pending', 'The closed position\'s SL/TP are still open before the cleanup');
      const foreignIndex = 2 ** 48 + 990_000;
      const nowSec = Math.floor(Date.now() / 1000);
      h.exchange.short.orders.push({
        order_index: foreignIndex, order_id: String(foreignIndex), client_order_index: 0, client_order_id: '0',
        market_index: ETH, owner_account_index: HEDGE_SHORT_ACCOUNT, initial_base_amount: '0.7000', remaining_base_amount: '0.7000',
        filled_base_amount: '0.0000', filled_quote_amount: '0.000000', price: '4300.00', is_ask: false, type: 'stop-loss',
        time_in_force: 'immediate-or-cancel', reduce_only: true, trigger_price: '4250.00', order_expiry: (nowSec + 86_400) * 1000,
        status: 'pending', trigger_status: 'mark-price', created_at: nowSec, updated_at: nowSec, order_version: 1,
      });
      const longSentBefore = h.exchange.long.received.length;
      const shortCancelsBefore = h.exchange.txs('SHORT', TX_CANCEL).length;
      cancels.length = 0;
      await (pm as any).cleanupOrphanedOrders();
      assertEqual(h.exchange.short.orders.find(o => o.order_index === foreignIndex)?.status, 'canceled', 'The hand-placed order is cancelled');
      assertEqual(`${h.exchange.short.findOrder(stale.sl.ClientOrderIndex)?.status}/${h.exchange.short.findOrder(stale.tp.ClientOrderIndex)?.status}`,
        'canceled/canceled', 'The closed position\'s SL/TP are cancelled');
      const expected = [stale.sl.ClientOrderIndex, stale.tp.ClientOrderIndex, foreignIndex].map(String).sort().join(', ');
      const shortCancels = h.exchange.txs('SHORT', TX_CANCEL).slice(shortCancelsBefore);
      assertEqual(shortCancels.map(tx => String(tx.info.Index)).sort().join(', '), expected,
        'One cancel tx each on the short account: the stale legs by client order index, the hand-placed order by order_index');
      assert(shortCancels.every(tx => tx.info.AccountIndex === HEDGE_SHORT_ACCOUNT), 'Signed for the short account');
      assertEqual(h.exchange.long.received.length, longSentBefore, 'Nothing sent to the long account');
      const cancelled = [...new Set(cancels.map(c => String(c.orderId)))].sort().join(', ');
      assertEqual(cancelled, expected, 'The cleanup touched only those three orders (no tracked bot order)');
      assertEqual(`${h.exchange.long.findOrder(resized.sl.ClientOrderIndex)?.status}/${h.exchange.long.findOrder(resized.tp.ClientOrderIndex)?.status}`,
        'pending/pending', 'Long SL/TP still open');
      assertEqual(`${h.exchange.short.findOrder(short.sl.ClientOrderIndex)?.status}/${h.exchange.short.findOrder(short.tp.ClientOrderIndex)?.status}`,
        'pending/pending', 'Short SL/TP still open');
    });
  } finally {
    await pm.stop();
    hunter.stop();
  }
  await summary.run('stop() closes both account streams', async () => {
    assertEqual(`${h.streams.LONG.closes}/${h.streams.SHORT.closes}`, '1/1', 'One close per account');
  });

  summary.print();
}

// ===== PositionManager alone on two fresh fake sub-accounts =====

const TYPE_STOP_LOSS = 2;
const TYPE_TAKE_PROFIT = 4;

async function startHedgePositionManager(h: LighterHedgeHarness): Promise<PositionManager> {
  h.exchange.long.setBook(ETH, [['4049.90', '5.0000']], [['4050.10', '5.0000']]);
  const pm = new PositionManager(hedgeFlowConfig(), true, h.adapter);
  await pm.start();
  await waitFor(() => h.streams.LONG.handlers !== null && h.streams.SHORT.handlers !== null, 3000, 'both account streams');
  await waitFor(() => (pm as any).orderCheckInterval !== undefined, 3000, 'onConnected (both accounts connected)');
  return pm;
}

async function testWrongDirectionPastTakeProfit() {
  logSection('Lighter hedge mode: a wrong-direction position already past its TP level');
  const summary = new TestSummary();
  const h = lighterHedgeHarness({ credentials: true, symbols: ['ETHUSDT'] });
  const pm = await startHedgePositionManager(h);
  const positionOrders = () => (pm as any).positionOrders as Map<string, { slOrderId?: OrderId; tpOrderId?: OrderId }>;
  try {
    await summary.run('A manual short on the long account past its TP: the bot close is refused, the SL is still placed there', async () => {
      // Short 0.2 at 4200 on the long account: mark 4050 is below its TP level (4200 x 0.97 = 4074), above its SL (4284)
      h.exchange.long.setPosition(ETH, '-0.2000', { avg_entry_price: '4200.00' });
      h.streams.LONG.emit(accountUpdate('-0.2000', '4200.00'));
      await waitFor(() => h.alerts.some(a => a.kind === 'wrong-sign'), 3000, 'the wrong-direction alert');
      await waitFor(() => positionOrders().get('ETHUSDT_LONG_HEDGE')?.slOrderId !== undefined, 5000, 'the stop loss tracking');
      const creates = h.exchange.txs('LONG', TX_CREATE).map(tx => tx.info);
      assertEqual(creates.length, 1, `One order on the long account (${txCounts(h)})`);
      const [sl] = creates;
      assertEqual(sl.Type, TYPE_STOP_LOSS, 'A stop loss');
      assertEqual(sl.AccountIndex, HEDGE_LONG_ACCOUNT, 'On the long account');
      assert(sl.IsAsk === 0 && sl.ReduceOnly === 1, 'BUY reduce-only (closes the short)');
      assertEqual(sl.BaseAmount, 2000, 'Sized from the 0.2 position');
      assertEqual(sl.TriggerPrice, 428400, 'At entry + 2% (4284.00)');
      assertEqual(sl.ClientOrderIndex, positionOrders().get('ETHUSDT_LONG_HEDGE')?.slOrderId, 'Tracked as the position\'s SL');
      assertEqual(positionOrders().get('ETHUSDT_LONG_HEDGE')?.tpOrderId, undefined, 'No TP: it would trigger at once');
      assertEqual(h.exchange.txs('LONG').filter(tx => tx.txType === TX_GROUPED || tx.info.Type === TYPE_TAKE_PROFIT).length, 0, 'No TP or OCO accepted');
      assertEqual(h.exchange.short.received.length, 0, 'Nothing sent to the short account');

      // The periodic check keeps that SL: it only retries the TP, whose market close is refused again
      const slId = positionOrders().get('ETHUSDT_LONG_HEDGE')?.slOrderId;
      await (pm as any).checkAndAdjustOrders();
      assertEqual(h.exchange.txs('LONG', TX_CREATE).length, 1, 'No new order on the long account');
      assertEqual(h.exchange.long.received.filter(tx => tx.txType === TX_CANCEL || tx.txType === TX_CANCEL_ALL).length, 0, 'The SL is not cancelled');
      assertEqual(h.exchange.long.findOrder(slId)?.status, 'pending', 'The SL is still open');
      assertEqual(positionOrders().get('ETHUSDT_LONG_HEDGE')?.slOrderId, slId, 'And still tracked');
    });
  } finally {
    await pm.stop();
  }
  summary.print();
}

async function testLaggingAccountStream() {
  logSection('Lighter hedge mode: one account\'s stream lags behind what PositionManager read over REST');
  const summary = new TestSummary();
  const h = lighterHedgeHarness({ credentials: true, symbols: ['ETHUSDT'] });
  const pm = await startHedgePositionManager(h);
  const positionOrders = () => (pm as any).positionOrders as Map<string, { slOrderId?: OrderId; tpOrderId?: OrderId }>;
  const currentPositions = () => (pm as any).currentPositions as Map<string, { positionAmt: string }>;
  const shortCancels = () => h.exchange.short.received.filter(tx => tx.txType === TX_CANCEL || tx.txType === TX_CANCEL_ALL).length;
  try {
    h.exchange.long.setPosition(ETH, '0.5000', { avg_entry_price: '4050.00' });
    h.streams.LONG.emit(accountUpdate('0.5000', '4050.00'));
    await waitFor(() => positionOrders().get('ETHUSDT_LONG_HEDGE')?.tpOrderId !== undefined, 5000, 'the long SL/TP');

    let shortSl: OrderId | undefined;
    let shortTp: OrderId | undefined;
    await summary.run('A short read over REST on reconnect keeps its SL/TP when the long account reports next', async () => {
      // The short account's stream drops; a short fill happens and its update is lost
      h.streams.SHORT.handlers!.onDisconnected!(new Error('socket closed'));
      h.exchange.short.setPosition(ETH, '-0.5000', { avg_entry_price: '4050.00' });
      // Reconnecting: PositionManager re-syncs over REST and protects the short on its account
      await h.streams.SHORT.handlers!.beforeReconnect!();
      shortSl = positionOrders().get('ETHUSDT_SHORT_HEDGE')?.slOrderId;
      shortTp = positionOrders().get('ETHUSDT_SHORT_HEDGE')?.tpOrderId;
      assert(shortSl !== undefined && shortTp !== undefined, 'The short got its SL/TP from the re-sync');
      assertEqual(h.exchange.txs('SHORT', TX_GROUPED).length, 1, 'One OCO on the short account');

      // Before the short stream's own report: the long account reports (a funding payment)
      h.streams.LONG.emit(accountUpdate('0.5000', '4050.00', '999.5'));
      await wait(400);
      assertEqual(shortCancels(), 0, 'No cancel sent to the short account');
      assertEqual(`${h.exchange.short.findOrder(shortSl)?.status}/${h.exchange.short.findOrder(shortTp)?.status}`, 'pending/pending', 'Short SL/TP still open');
      assertEqual(currentPositions().get('ETHUSDT_SHORT_HEDGE')?.positionAmt, '-0.5000', 'PositionManager still holds the short');
      assertEqual(JSON.stringify(positionOrders().get('ETHUSDT_SHORT_HEDGE')), JSON.stringify({ slOrderId: shortSl, tpOrderId: shortTp }), 'And tracks its SL/TP');

      // The short stream catches up with the same position: nothing changes
      h.streams.SHORT.handlers!.onConnected!();
      h.streams.SHORT.emit(accountUpdate('-0.5000', '4050.00', '1000'));
      await wait(300);
      assertEqual(shortCancels(), 0, 'Still no cancel on the short account');
      assertEqual(h.exchange.txs('SHORT', TX_GROUPED).length, 1, 'No second OCO');
    });

    await summary.run('A short closed while its stream lagged is not brought back by the next long update', async () => {
      // The short stream has reported the short (as at the end of the case above); then it is closed by hand and
      // the stream does not report the close
      h.exchange.short.setPosition(ETH, '-0.5000', { avg_entry_price: '4050.00' });
      h.streams.SHORT.emit(accountUpdate('-0.5000', '4050.00', '1000'));
      await waitFor(() => currentPositions().get('ETHUSDT_SHORT_HEDGE')?.positionAmt === '-0.5000', 2000, 'the short reported by its stream');
      h.exchange.short.setPosition(ETH, '0');
      await (pm as any).syncWithExchange();
      assertEqual(currentPositions().has('ETHUSDT_SHORT_HEDGE'), false, 'The periodic sync dropped the short');
      const shortSent = h.exchange.short.received.length;
      h.streams.LONG.emit(accountUpdate('0.5000', '4050.00', '999'));
      await wait(400);
      assertEqual(currentPositions().has('ETHUSDT_SHORT_HEDGE'), false, 'Not re-added from the short stream\'s older state');
      assertEqual(h.exchange.short.received.length, shortSent, 'Nothing sent to the short account');
      assertEqual(currentPositions().get('ETHUSDT_LONG_HEDGE')?.positionAmt, '0.5000', 'The long is unchanged');
    });
  } finally {
    await pm.stop();
  }
  summary.print();
}

async function testLeveragePerAccount() {
  logSection('Lighter hedge mode: leverage is set on the account of each entry');
  const summary = new TestSummary();
  const h = lighterHedgeHarness({ credentials: true, symbols: ['ETHUSDT'] });
  h.exchange.long.setBook(ETH, [['4049.90', '5.0000']], [['4050.10', '5.0000']]);
  const config = hedgeFlowConfig();
  const hunter = new Hunter(config, true, h.adapter, new FakeSource());
  hunter.setPositionTracker({
    getMarginUsage: () => 0,
    getTotalPositionCount: () => 0,
    getUniquePositionCount: () => 0,
    getPositionsMap: () => new Map(),
  } as any);
  const entry = async (side: 'BUY' | 'SELL') => {
    (hunter as any).lastModeSync = Date.now();
    await (hunter as any).placeTrade('ETHUSDT', side, config.symbols.ETHUSDT, 4050);
    (hunter as any).pendingOrders.clear();
  };
  const TX_LEVERAGE = 20;
  try {
    await summary.run('A leverage failure on the short account does not block a long entry; it still blocks short entries', async () => {
      const shortLeverage = h.short.setLeverage.bind(h.short);
      let shortCalls = 0;
      h.short.setLeverage = async () => {
        shortCalls++;
        throw new Error('Lighter: GET /api/v1/account failed: 429 Too Many Requests');
      };
      try {
        await entry('BUY');
        assertEqual(h.exchange.txs('LONG', TX_CREATE).length, 1, `The long entry went out (${txCounts(h)})`);
        assertEqual(h.exchange.txs('LONG', TX_LEVERAGE).length, 1, 'After setting the long account\'s leverage');
        assertEqual(shortCalls, 0, 'The short account\'s leverage is not touched by a long entry');

        await entry('SELL');
        assertEqual(shortCalls, 1, 'A short entry sets the short account\'s leverage');
        assertEqual(h.exchange.txs('SHORT', TX_CREATE).length, 0, 'Its failure stops that entry');
      } finally {
        h.short.setLeverage = shortLeverage;
      }
      await entry('SELL');
      assertEqual(h.exchange.txs('SHORT', TX_LEVERAGE).length, 1, 'Recovered: the short account\'s leverage is set');
      assertEqual(h.exchange.txs('SHORT', TX_CREATE).length, 1, 'And the short entry goes out');
    });
  } finally {
    hunter.stop();
    h.adapter.close();
  }
  summary.print();
}

async function main() {
  await testPositionManagerHedgeSides();
  await testHunterEntryMargin();
  await testHedgeFlowOnTwoAccounts();
  await testWrongDirectionPastTakeProfit();
  await testLaggingAccountStream();
  await testLeveragePerAccount();
  finishTests();
}

main().catch(error => {
  console.error('Lighter hedge flow tests crashed:', error);
  process.exit(1);
});
