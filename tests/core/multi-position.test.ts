#!/usr/bin/env tsx

import { InternalAxiosRequestConfig } from 'axios';
import { PositionManager } from '../../src/lib/bot/positionManager';
import { symbolPrecision } from '../../src/lib/utils/symbolPrecision';
import {
  TestSummary,
  logSection,
  createMockConfig,
  mockExchangeHttp,
  finishTests,
  assert,
  assertEqual,
  assertClose
} from '../utils/test-helpers';

// ===== Mock exchange (HTTP layer) =====

interface MockPosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
}

interface MockOrder {
  orderId: number;
  symbol: string;
  side: string;
  type: string;
  origQty: string;
  stopPrice: string;
  reduceOnly: boolean;
  positionSide: string;
  status: string;
  [key: string]: unknown;
}

const exchange = {
  positions: [] as MockPosition[],
  openOrders: [] as MockOrder[],
  markPrices: {} as Record<string, number>,
  nextOrderId: 1000,
  batchRequests: 0,
  placedOrders: [] as Record<string, string>[], // Single orders (POST /fapi/v1/order)
  cancelledOrderIds: [] as number[],
};

function resetExchange() {
  exchange.positions = [];
  exchange.openOrders = [];
  exchange.markPrices = { BTCUSDT: 50100, ETHUSDT: 2990 };
  exchange.nextOrderId = 1000;
  exchange.batchRequests = 0;
  exchange.placedOrders = [];
  exchange.cancelledOrderIds = [];
}

function createOrder(params: Record<string, string>): MockOrder {
  const now = Date.now();
  return {
    orderId: exchange.nextOrderId++,
    clientOrderId: params.newClientOrderId || `mock_${now}`,
    symbol: params.symbol,
    side: params.side,
    type: params.type,
    origType: params.type,
    origQty: params.quantity,
    executedQty: '0',
    price: params.price || '0',
    stopPrice: params.stopPrice || '0',
    reduceOnly: params.reduceOnly === 'true',
    positionSide: params.positionSide || 'BOTH',
    workingType: params.workingType || 'CONTRACT_PRICE',
    status: 'NEW',
    time: now,
    updateTime: now,
  };
}

function exchangeError(code: number, msg: string): Error {
  const error: any = new Error('Request failed with status code 400');
  error.response = { status: 400, data: { code, msg } };
  return error;
}

function handleRequest(config: InternalAxiosRequestConfig): unknown {
  const url = new URL(config.url || '', config.baseURL || 'https://fapi.asterdex.com');
  const method = (config.method || 'get').toUpperCase();
  const form = () => Object.fromEntries(new URLSearchParams(String(config.data)));

  if (method === 'GET' && url.pathname === '/fapi/v2/positionRisk') {
    return exchange.positions.map(p => ({
      ...p,
      markPrice: String(exchange.markPrices[p.symbol] ?? 0),
      unRealizedProfit: '0',
      liquidationPrice: '0',
      leverage: '10',
      marginType: 'cross',
      isolatedMargin: '0',
      isAutoAddMargin: 'false',
      updateTime: Date.now(),
    }));
  }
  if (method === 'GET' && url.pathname === '/fapi/v1/openOrders') {
    return exchange.openOrders.map(o => ({ ...o }));
  }
  if (method === 'GET' && url.pathname === '/fapi/v1/ticker/price') {
    const symbol = url.searchParams.get('symbol')!;
    return { symbol, price: String(exchange.markPrices[symbol]) };
  }
  if (method === 'GET' && url.pathname === '/fapi/v1/premiumIndex') {
    const symbol = url.searchParams.get('symbol')!;
    return { symbol, markPrice: String(exchange.markPrices[symbol]) };
  }
  if (method === 'POST' && url.pathname === '/fapi/v1/batchOrders') {
    exchange.batchRequests++;
    const orders: Record<string, string>[] = JSON.parse(form().batchOrders);
    return orders.map(params => {
      const order = createOrder(params);
      exchange.openOrders.push(order);
      return order;
    });
  }
  if (method === 'POST' && url.pathname === '/fapi/v1/order') {
    const params = form();
    exchange.placedOrders.push(params);
    const order = createOrder(params);
    if (params.type === 'MARKET') {
      // Market orders fill immediately; a reduce-only fill closes the position
      if (params.reduceOnly === 'true') {
        const position = exchange.positions.find(p => p.symbol === params.symbol);
        if (position) position.positionAmt = '0';
      }
      return { ...order, status: 'FILLED', executedQty: params.quantity };
    }
    exchange.openOrders.push(order);
    return order;
  }
  if (method === 'DELETE' && url.pathname === '/fapi/v1/order') {
    const orderId = Number(url.searchParams.get('orderId'));
    const index = exchange.openOrders.findIndex(o => o.orderId === orderId);
    if (index < 0) throw exchangeError(-2011, 'Unknown order sent.');
    const [order] = exchange.openOrders.splice(index, 1);
    exchange.cancelledOrderIds.push(orderId);
    return { ...order, status: 'CANCELED' };
  }

  throw new Error(`Unmocked exchange request: ${method} ${url.pathname}`);
}

// ===== Helpers =====

function createManager(): PositionManager {
  const config = createMockConfig();
  config.global.paperMode = false;
  config.symbols.BTCUSDT.slPercent = 1;
  config.symbols.BTCUSDT.tpPercent = 2;
  config.symbols.ETHUSDT = {
    volumeThresholdUSDT: 10000,
    tradeSize: 20,
    leverage: 10,
    tpPercent: 3,
    slPercent: 2,
    orderType: 'LIMIT'
  };
  return new PositionManager(config, false);
}

async function sync(manager: PositionManager) {
  await (manager as any).syncWithExchange();
}

function tracked(manager: PositionManager, key: string): { slOrderId?: number; tpOrderId?: number } | undefined {
  return (manager as any).positionOrders.get(key);
}

function trackedPositions(manager: PositionManager): Map<string, any> {
  return (manager as any).currentPositions;
}

function openOrder(orderId: number | undefined): MockOrder | undefined {
  return exchange.openOrders.find(o => o.orderId === orderId);
}

// Assert a position has exactly one live SL and TP that match its size, side and prices
function assertProtected(
  manager: PositionManager,
  key: string,
  expected: { qty: number; side: 'BUY' | 'SELL'; sl: number; tp: number }
) {
  const orders = tracked(manager, key);
  assert(orders?.slOrderId !== undefined, `${key} should track an SL order`);
  assert(orders?.tpOrderId !== undefined, `${key} should track a TP order`);

  const sl = openOrder(orders!.slOrderId);
  const tp = openOrder(orders!.tpOrderId);
  assert(sl !== undefined, `${key} SL order ${orders!.slOrderId} should be open on the exchange`);
  assert(tp !== undefined, `${key} TP order ${orders!.tpOrderId} should be open on the exchange`);

  assertEqual(sl!.type, 'STOP_MARKET', `${key} SL type`);
  assertEqual(tp!.type, 'TAKE_PROFIT_MARKET', `${key} TP type`);
  assertEqual(sl!.side, expected.side, `${key} SL side`);
  assertEqual(tp!.side, expected.side, `${key} TP side`);
  assert(sl!.reduceOnly && tp!.reduceOnly, `${key} SL/TP should be reduce-only in one-way mode`);
  assertClose(parseFloat(sl!.origQty), expected.qty, 1e-9, `${key} SL quantity should match the position`);
  assertClose(parseFloat(tp!.origQty), expected.qty, 1e-9, `${key} TP quantity should match the position`);
  assertClose(parseFloat(sl!.stopPrice), expected.sl, 1e-6, `${key} SL price`);
  assertClose(parseFloat(tp!.stopPrice), expected.tp, 1e-6, `${key} TP price`);
}

const BTC_LONG = 'BTCUSDT_LONG_BOTH';
const ETH_SHORT = 'ETHUSDT_SHORT_BOTH';

// ===== Tests =====

async function testMultiplePositions() {
  logSection('Testing Multiple Position Management');
  const summary = new TestSummary();

  resetExchange();
  const manager = createManager();
  let btcOrders: { slOrderId?: number; tpOrderId?: number } = {};

  await summary.run('Detects a new position and protects it with one SL/TP batch', async () => {
    exchange.positions.push({ symbol: 'BTCUSDT', positionAmt: '0.005', entryPrice: '50000', positionSide: 'BOTH' });

    await sync(manager);

    assertEqual(trackedPositions(manager).size, 1, 'Should track 1 position');
    assertEqual(exchange.batchRequests, 1, 'Should place SL and TP in a single batch request');
    assertProtected(manager, BTC_LONG, { qty: 0.005, side: 'SELL', sl: 49500, tp: 51000 });
    btcOrders = { ...tracked(manager, BTC_LONG) };
  });

  await summary.run('Second symbol (short) is protected without touching the first position', async () => {
    exchange.positions.push({ symbol: 'ETHUSDT', positionAmt: '-0.5', entryPrice: '3000', positionSide: 'BOTH' });

    await sync(manager);

    assertEqual(trackedPositions(manager).size, 2, 'Should track 2 positions');
    assertEqual(exchange.batchRequests, 2, 'Only the new position should get a batch');
    assertEqual(tracked(manager, BTC_LONG)?.slOrderId, btcOrders.slOrderId, 'BTC should keep its SL order');
    assertEqual(tracked(manager, BTC_LONG)?.tpOrderId, btcOrders.tpOrderId, 'BTC should keep its TP order');
    assertProtected(manager, ETH_SHORT, { qty: 0.5, side: 'BUY', sl: 3060, tp: 2910 });

    const ids = new Set([btcOrders.slOrderId, btcOrders.tpOrderId, tracked(manager, ETH_SHORT)?.slOrderId, tracked(manager, ETH_SHORT)?.tpOrderId]);
    assertEqual(ids.size, 4, 'Every SL/TP order ID should be unique');
  });

  await summary.run('Resync without changes places and cancels nothing', async () => {
    const before = { batches: exchange.batchRequests, orders: exchange.placedOrders.length, cancels: exchange.cancelledOrderIds.length };
    const ethBefore = { ...tracked(manager, ETH_SHORT) };

    await sync(manager);

    assertEqual(exchange.batchRequests, before.batches, 'No new batch orders');
    assertEqual(exchange.placedOrders.length, before.orders, 'No new single orders');
    assertEqual(exchange.cancelledOrderIds.length, before.cancels, 'No cancellations');
    assertEqual(tracked(manager, BTC_LONG)?.slOrderId, btcOrders.slOrderId, 'BTC SL preserved');
    assertEqual(tracked(manager, BTC_LONG)?.tpOrderId, btcOrders.tpOrderId, 'BTC TP preserved');
    assertEqual(tracked(manager, ETH_SHORT)?.slOrderId, ethBefore.slOrderId, 'ETH SL preserved');
    assertEqual(tracked(manager, ETH_SHORT)?.tpOrderId, ethBefore.tpOrderId, 'ETH TP preserved');
  });

  await summary.run('Position size increase replaces SL/TP with the new quantity', async () => {
    exchange.positions[0].positionAmt = '0.008';
    const ethBefore = { ...tracked(manager, ETH_SHORT) };

    await sync(manager);

    assert(exchange.cancelledOrderIds.includes(btcOrders.slOrderId!), 'Old BTC SL should be cancelled');
    assert(exchange.cancelledOrderIds.includes(btcOrders.tpOrderId!), 'Old BTC TP should be cancelled');
    assert(tracked(manager, BTC_LONG)?.slOrderId !== btcOrders.slOrderId, 'BTC should track a new SL order');
    assert(tracked(manager, BTC_LONG)?.tpOrderId !== btcOrders.tpOrderId, 'BTC should track a new TP order');
    assertProtected(manager, BTC_LONG, { qty: 0.008, side: 'SELL', sl: 49500, tp: 51000 });
    assertEqual(tracked(manager, ETH_SHORT)?.slOrderId, ethBefore.slOrderId, 'ETH SL untouched');
    assertEqual(tracked(manager, ETH_SHORT)?.tpOrderId, ethBefore.tpOrderId, 'ETH TP untouched');
    btcOrders = { ...tracked(manager, BTC_LONG) };
  });

  await summary.run('Closing one position drops its tracking and keeps the other', async () => {
    exchange.positions[1].positionAmt = '0';
    const before = { batches: exchange.batchRequests, orders: exchange.placedOrders.length };

    await sync(manager);

    assertEqual(trackedPositions(manager).size, 1, 'Should track 1 position after ETH closed');
    assert(!trackedPositions(manager).has(ETH_SHORT), 'ETH position should no longer be tracked');
    assert(tracked(manager, ETH_SHORT) === undefined, 'ETH order tracking should be removed');
    assertEqual(tracked(manager, BTC_LONG)?.slOrderId, btcOrders.slOrderId, 'BTC SL preserved');
    assertEqual(tracked(manager, BTC_LONG)?.tpOrderId, btcOrders.tpOrderId, 'BTC TP preserved');
    assertEqual(exchange.batchRequests, before.batches, 'No new batch orders');
    assertEqual(exchange.placedOrders.length, before.orders, 'No new single orders');
  });

  summary.print();
}

async function testExistingAndEdgeCases() {
  logSection('Testing Existing Orders and Price Edge Cases');
  const summary = new TestSummary();

  await summary.run('Adopts existing exchange SL/TP instead of placing duplicates', async () => {
    resetExchange();
    exchange.positions.push({ symbol: 'BTCUSDT', positionAmt: '0.004', entryPrice: '50000', positionSide: 'BOTH' });
    const sl = createOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', quantity: '0.004', stopPrice: '49500', reduceOnly: 'true' });
    const tp = createOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'TAKE_PROFIT_MARKET', quantity: '0.004', stopPrice: '51000', reduceOnly: 'true' });
    exchange.openOrders.push(sl, tp);

    const manager = createManager();
    await sync(manager);

    assertEqual(exchange.batchRequests, 0, 'Should not place a batch');
    assertEqual(exchange.placedOrders.length, 0, 'Should not place single orders');
    assertEqual(tracked(manager, BTC_LONG)?.slOrderId, sl.orderId, 'Should adopt the existing SL');
    assertEqual(tracked(manager, BTC_LONG)?.tpOrderId, tp.orderId, 'Should adopt the existing TP');
  });

  await summary.run('Underwater long gets its SL just below the current price', async () => {
    resetExchange();
    exchange.markPrices.BTCUSDT = 49400; // Below the 1% SL at 49500
    exchange.positions.push({ symbol: 'BTCUSDT', positionAmt: '0.005', entryPrice: '50000', positionSide: 'BOTH' });

    const manager = createManager();
    await sync(manager);

    // 0.1% buffer below the current price, rounded to the 0.1 tick
    assertProtected(manager, BTC_LONG, { qty: 0.005, side: 'SELL', sl: 49350.6, tp: 51000 });
  });

  await summary.run('Long already past TP is closed at market instead of placing SL/TP', async () => {
    resetExchange();
    exchange.markPrices.BTCUSDT = 51200; // Above the 2% TP at 51000
    exchange.positions.push({ symbol: 'BTCUSDT', positionAmt: '0.005', entryPrice: '50000', positionSide: 'BOTH' });

    const manager = createManager();
    await sync(manager);

    assertEqual(exchange.batchRequests, 0, 'Should not place an SL/TP batch');
    assertEqual(exchange.placedOrders.length, 1, 'Should place one market close order');
    const close = exchange.placedOrders[0];
    assertEqual(close.type, 'MARKET', 'Close should be a MARKET order');
    assertEqual(close.side, 'SELL', 'Closing a long sells');
    assertEqual(close.reduceOnly, 'true', 'Close should be reduce-only');
    assertEqual(close.positionSide, 'BOTH', 'One-way close uses positionSide BOTH');
    assertClose(parseFloat(close.quantity), 0.005, 1e-9, 'Close quantity should equal the position');
    assertEqual(exchange.positions[0].positionAmt, '0', 'Position should be closed');
  });

  await summary.run('Short already past TP is closed at market with a BUY', async () => {
    resetExchange();
    exchange.markPrices.ETHUSDT = 2900; // Below the 3% TP at 2910
    exchange.positions.push({ symbol: 'ETHUSDT', positionAmt: '-0.5', entryPrice: '3000', positionSide: 'BOTH' });

    const manager = createManager();
    await sync(manager);

    assertEqual(exchange.batchRequests, 0, 'Should not place an SL/TP batch');
    assertEqual(exchange.placedOrders.length, 1, 'Should place one market close order');
    assertEqual(exchange.placedOrders[0].side, 'BUY', 'Closing a short buys');
    assertEqual(exchange.placedOrders[0].reduceOnly, 'true', 'Close should be reduce-only');
  });

  summary.print();
}

async function testPeriodicCheck() {
  logSection('Testing Periodic Order Check');
  const summary = new TestSummary();

  await summary.run('Periodic check syncs and protects a position it was not tracking', async () => {
    resetExchange();
    const manager = createManager();

    // Position opened while the bot wasn't tracking it (e.g. missed by a partial ACCOUNT_UPDATE)
    exchange.positions.push({ symbol: 'ETHUSDT', positionAmt: '-0.5', entryPrice: '3000', positionSide: 'BOTH' });

    await (manager as any).checkAndAdjustOrders();

    assertEqual(trackedPositions(manager).size, 1, 'Position should now be tracked');
    assertEqual(exchange.batchRequests, 1, 'Should place exactly one SL/TP batch (no duplicates)');
    assertProtected(manager, ETH_SHORT, { qty: 0.5, side: 'BUY', sl: 3060, tp: 2910 });
  });

  await summary.run('A second periodic check leaves a protected position alone', async () => {
    const before = { batches: exchange.batchRequests, orders: exchange.placedOrders.length, cancels: exchange.cancelledOrderIds.length };
    const manager = createManager();

    await (manager as any).checkAndAdjustOrders();

    assertEqual(exchange.batchRequests, before.batches, 'No new batch orders');
    assertEqual(exchange.placedOrders.length, before.orders, 'No new single orders');
    assertEqual(exchange.cancelledOrderIds.length, before.cancels, 'No cancellations');
    assertEqual(trackedPositions(manager).size, 1, 'Position should be tracked');
  });

  summary.print();
}

async function main() {
  logSection('🧪 MULTI-POSITION TEST SUITE');

  // Route all exchange HTTP calls to the mock before anything is constructed
  mockExchangeHttp(handleRequest);

  symbolPrecision.parseExchangeInfo({
    symbols: [
      {
        symbol: 'BTCUSDT',
        filters: [
          { filterType: 'PRICE_FILTER', tickSize: '0.1' },
          { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
          { filterType: 'MIN_NOTIONAL', notional: '5' }
        ]
      },
      {
        symbol: 'ETHUSDT',
        filters: [
          { filterType: 'PRICE_FILTER', tickSize: '0.01' },
          { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '10000' },
          { filterType: 'MIN_NOTIONAL', notional: '5' }
        ]
      }
    ]
  });

  try {
    await testMultiplePositions();
    await testExistingAndEdgeCases();
    await testPeriodicCheck();

    logSection('✨ All Multi-Position Tests Complete');
    finishTests();
  } catch (error) {
    logSection('❌ Test Suite Failed');
    console.error(error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
