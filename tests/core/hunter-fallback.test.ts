#!/usr/bin/env tsx

// Hunter's MARKET fallback after a failed LIMIT entry: it may only run when the first order was definitely not
// placed. An error that says the order may exist (a venue's unknown tx outcome) must never get a second entry.

import { InternalAxiosRequestConfig } from 'axios';
import { Hunter } from '../../src/lib/bot/hunter';
import { createExchangeAdapter } from '../../src/lib/exchange/registry';
import { LighterTxUnknownError, LighterTxRejectedError } from '../../src/lib/exchange/lighter/nonce';
import { lighterHedgeHarness } from '../lib/lighter/fakeLighterHedge';
import {
  TestSummary,
  logSection,
  createMockConfig,
  mockExchangeHttp,
  finishTests,
  assert,
  assertEqual
} from '../utils/test-helpers';

const exchange = {
  orderRequests: [] as Record<string, string>[],
  rejectFirstOrder: false,
};

const exchangeInfo = {
  symbols: [{
    symbol: 'BTCUSDT',
    status: 'TRADING',
    filters: [
      { filterType: 'PRICE_FILTER', tickSize: '0.10', minPrice: '0.10', maxPrice: '1000000' },
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
      { filterType: 'MIN_NOTIONAL', notional: '5' }
    ]
  }]
};

function handleRequest(config: InternalAxiosRequestConfig): unknown {
  const url = new URL(config.url || '', config.baseURL || 'https://fapi.asterdex.com');
  const method = (config.method || 'get').toUpperCase();

  if (method === 'GET' && url.pathname === '/fapi/v1/exchangeInfo') return exchangeInfo;
  if (method === 'GET' && url.pathname === '/fapi/v1/premiumIndex') return { symbol: 'BTCUSDT', markPrice: '50000' };
  if (method === 'GET' && url.pathname === '/fapi/v1/ticker/bookTicker') {
    return { symbol: 'BTCUSDT', bidPrice: '49999.9', bidQty: '5', askPrice: '50000.1', askQty: '5' };
  }
  if (method === 'GET' && url.pathname === '/fapi/v1/depth') {
    return { lastUpdateId: 1, bids: [['49999.9', '5']], asks: [['50000.1', '5']] };
  }
  if (method === 'POST' && url.pathname === '/fapi/v1/leverage') return { symbol: 'BTCUSDT', leverage: 5 };
  if (method === 'GET' && url.pathname === '/fapi/v4/account') return { totalWalletBalance: '1000', availableBalance: '1000' };
  if (method === 'POST' && url.pathname === '/fapi/v1/order') {
    const params = Object.fromEntries(new URLSearchParams(String(config.data)));
    exchange.orderRequests.push(params);
    if (exchange.rejectFirstOrder && exchange.orderRequests.length === 1) {
      const error: any = new Error('Request failed with status code 400');
      error.response = { status: 400, data: { code: -2010, msg: 'Order would immediately match and take.' } };
      throw error;
    }
    return { orderId: 7000 + exchange.orderRequests.length, symbol: params.symbol, side: params.side, type: params.type, status: 'NEW' };
  }
  throw new Error(`Unmocked exchange request: ${method} ${url.pathname}`);
}

function limitConfig() {
  const config = createMockConfig();
  config.global.paperMode = false;
  config.symbols.BTCUSDT.orderType = 'LIMIT';
  config.symbols.BTCUSDT.vwapProtection = false;
  config.symbols.BTCUSDT.tradeSize = 20;
  return config;
}

// The live bot gives the hunter the position manager; only then does a pending order block the symbol
const noPositions = {
  getMarginUsage: () => 0,
  getTotalPositionCount: () => 0,
  getUniquePositionCount: () => 0,
  getPositionsMap: () => new Map(),
};

function pendingFor(hunter: Hunter, symbol: string): Array<{ symbol: string; blockUntil?: number }> {
  return ([...(hunter as any).pendingOrders.entries()] as Array<[string, { symbol: string; blockUntil?: number }]>)
    .filter(([, p]) => p.symbol === symbol)
    .map(([, p]) => p);
}

// Run the hunter's 30 s stale sweep as if the clock read `at`
function sweepAt(hunter: Hunter, at: number) {
  const realNow = Date.now;
  Date.now = () => at;
  try {
    (hunter as any).cleanStalePendingOrders();
  } finally {
    Date.now = realNow;
  }
}

async function placeEntry(hunter: Hunter) {
  const hunterAny = hunter as any;
  hunterAny.lastModeSync = Date.now();
  await hunterAny.placeTrade('BTCUSDT', 'BUY', hunterAny.config.symbols.BTCUSDT, 50000);
}

async function testFallback() {
  logSection('Hunter MARKET fallback');
  const summary = new TestSummary();

  await summary.run('Aster: a rejected LIMIT entry falls back to one MARKET order (unchanged)', async () => {
    exchange.orderRequests = [];
    exchange.rejectFirstOrder = true;
    const hunter = new Hunter(limitConfig(), false);
    await placeEntry(hunter);
    assertEqual(exchange.orderRequests.length, 2, 'LIMIT then the MARKET fallback');
    assertEqual(exchange.orderRequests[0].type, 'LIMIT', 'First attempt is the LIMIT entry');
    assertEqual(exchange.orderRequests[1].type, 'MARKET', 'Fallback is a MARKET order');
  });

  await summary.run('An entry that may already exist gets no fallback, and the symbol stays blocked', async () => {
    exchange.orderRequests = [];
    exchange.rejectFirstOrder = false;
    const config = limitConfig();
    const adapter = createExchangeAdapter(config);
    const placed: string[] = [];
    adapter.placeOrder = async (request) => {
      placed.push(request.type);
      throw new LighterTxUnknownError('Lighter LIMIT entry was accepted but not confirmed within the timeout');
    };
    const hunter = new Hunter(config, false, adapter);
    await placeEntry(hunter);
    assertEqual(placed.join(','), 'LIMIT', 'Only the first order was sent: no MARKET fallback');
    const pending = [...(hunter as any).pendingOrders.values()] as Array<{ symbol: string }>;
    assert(pending.some((p) => p.symbol === 'BTCUSDT'), 'The symbol stays blocked while the order may exist');
  });

  await summary.run('A definite venue rejection still falls back', async () => {
    const config = limitConfig();
    const adapter = createExchangeAdapter(config);
    const placed: string[] = [];
    adapter.placeOrder = async (request) => {
      placed.push(request.type);
      if (placed.length === 1) throw new LighterTxRejectedError('Lighter rejected the tx: post-only would cross');
      return { orderId: 1, symbol: request.symbol, side: request.side, type: request.type, status: 'NEW' } as any;
    };
    const hunter = new Hunter(config, false, adapter);
    await placeEntry(hunter);
    assertEqual(placed.join(','), 'LIMIT,MARKET', 'Rejected LIMIT, then the MARKET fallback');
  });

  await summary.run('A refusal the venue repeats (Lighter hedge mode, wrong-direction position) gets no fallback', async () => {
    // The real refusal: the long account holds a short, so the composite refuses every long entry until it is closed
    const hedge = lighterHedgeHarness({ credentials: true, symbols: ['BTCUSDT'] });
    hedge.exchange.long.setPosition(1, '-0.01000');
    const refusal = await hedge.adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.001, price: 49000, timeInForce: 'GTC', positionSide: 'LONG' })
      .catch((error: unknown) => error);
    assert(refusal instanceof Error && /holds a short BTCUSDT position/.test(refusal.message), 'The composite refused the entry');
    hedge.adapter.close();

    const config = limitConfig();
    const adapter = createExchangeAdapter(config);
    const placed: string[] = [];
    adapter.placeOrder = async (request) => {
      placed.push(request.type);
      throw refusal;
    };
    const hunter = new Hunter(config, false, adapter);
    hunter.setPositionTracker(noPositions);
    await placeEntry(hunter);
    assertEqual(placed.join(','), 'LIMIT', 'No MARKET fallback: it would be refused the same way');
    assertEqual(pendingFor(hunter, 'BTCUSDT').length, 0, 'Nothing was placed: the symbol is not blocked');
  });

  await summary.run('A presumed (not proven) rejection gets no fallback', async () => {
    const config = limitConfig();
    const adapter = createExchangeAdapter(config);
    const placed: string[] = [];
    adapter.placeOrder = async (request) => {
      placed.push(request.type);
      throw new LighterTxRejectedError('Lighter tx presumed not executed', { orderMayExist: true });
    };
    const hunter = new Hunter(config, false, adapter);
    await placeEntry(hunter);
    assertEqual(placed.join(','), 'LIMIT', 'No MARKET fallback');
  });

  await summary.run('A MARKET fallback that may exist keeps the symbol blocked, and the next liquidation places nothing', async () => {
    const config = limitConfig();
    const adapter = createExchangeAdapter(config);
    const placed: string[] = [];
    const expiredAt = Date.now() + 10 * 60 * 1000;
    adapter.placeOrder = async (request) => {
      placed.push(request.type);
      if (placed.length === 1) throw new LighterTxRejectedError('Lighter rejected the tx: post-only would cross');
      throw new LighterTxUnknownError('Lighter MARKET fallback was accepted but not confirmed within the timeout', { expiredAt });
    };
    const hunter = new Hunter(config, false, adapter);
    hunter.setPositionTracker(noPositions);
    await placeEntry(hunter);
    assertEqual(placed.join(','), 'LIMIT,MARKET', 'Rejected LIMIT, then the MARKET fallback');
    const pending = pendingFor(hunter, 'BTCUSDT');
    assertEqual(pending.length, 1, 'One entry keeps the symbol blocked');
    assertEqual(pending[0].blockUntil, expiredAt + 5000, 'Blocked until the fallback tx can no longer execute');

    await placeEntry(hunter);
    assertEqual(placed.join(','), 'LIMIT,MARKET', 'The next liquidation places no order');
  });

  await summary.run('An entry that may exist blocks the symbol until its tx expires, not the usual 5 minutes', async () => {
    const config = limitConfig();
    const adapter = createExchangeAdapter(config);
    const expiredAt = Date.now() + 10 * 60 * 1000;
    adapter.placeOrder = async () => {
      throw new LighterTxUnknownError('Lighter LIMIT entry was accepted but not confirmed within the timeout', { expiredAt });
    };
    const hunter = new Hunter(config, false, adapter);
    hunter.setPositionTracker(noPositions);
    await placeEntry(hunter);
    (hunter as any).addPendingOrder('7001', 'ETHUSDT', 'BUY');   // an ordinary pending order

    sweepAt(hunter, Date.now() + 6 * 60 * 1000);
    assertEqual(pendingFor(hunter, 'BTCUSDT').length, 1, 'Still blocked after 6 minutes');
    assertEqual(pendingFor(hunter, 'ETHUSDT').length, 0, 'Ordinary pending orders still go stale after 5 minutes');
    sweepAt(hunter, expiredAt + 5001);
    assertEqual(pendingFor(hunter, 'BTCUSDT').length, 0, 'Released once the tx can no longer execute');
  });

  await summary.run('Without a known expiry the symbol is blocked for 11 minutes', async () => {
    const config = limitConfig();
    const adapter = createExchangeAdapter(config);
    adapter.placeOrder = async () => {
      throw new LighterTxUnknownError('Lighter LIMIT entry executed but order 1 is not visible on the account');
    };
    const hunter = new Hunter(config, false, adapter);
    hunter.setPositionTracker(noPositions);
    const before = Date.now();
    await placeEntry(hunter);
    const [entry] = pendingFor(hunter, 'BTCUSDT');
    assert(entry?.blockUntil !== undefined && entry.blockUntil >= before + Hunter.UNCONFIRMED_BLOCK_MS, 'Blocked for UNCONFIRMED_BLOCK_MS');
    assertEqual(Hunter.UNCONFIRMED_BLOCK_MS, 11 * 60 * 1000, '11 minutes');
  });

  summary.print();
}

async function main() {
  logSection('🧪 HUNTER FALLBACK TEST SUITE');
  mockExchangeHttp(handleRequest);
  try {
    await testFallback();
    logSection('✨ All Hunter Fallback Tests Complete');
    finishTests();
  } catch (error) {
    logSection('❌ Test Suite Failed');
    console.error(error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
