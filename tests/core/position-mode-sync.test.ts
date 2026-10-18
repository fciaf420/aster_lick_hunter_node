#!/usr/bin/env tsx

import { InternalAxiosRequestConfig } from 'axios';
import { Hunter } from '../../src/lib/bot/hunter';
import {
  TestSummary,
  logSection,
  createMockConfig,
  mockExchangeHttp,
  finishTests,
  assert,
  assertEqual
} from '../utils/test-helpers';

// ===== Mock exchange (HTTP layer) =====

const exchange = {
  dualSidePosition: true,     // Exchange position mode (true = HEDGE)
  failModeQuery: false,       // Make GET /positionSide/dual fail
  rejectFirstOrderWith4061: false,
  orderRequests: [] as Record<string, string>[],
  modeQueries: 0,
};

function resetExchange() {
  exchange.dualSidePosition = true;
  exchange.failModeQuery = false;
  exchange.rejectFirstOrderWith4061 = false;
  exchange.orderRequests = [];
  exchange.modeQueries = 0;
}

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

  if (method === 'GET' && url.pathname === '/fapi/v1/positionSide/dual') {
    exchange.modeQueries++;
    if (exchange.failModeQuery) throw new Error('API Error');
    return { dualSidePosition: exchange.dualSidePosition };
  }
  if (method === 'GET' && url.pathname === '/fapi/v1/exchangeInfo') {
    return exchangeInfo;
  }
  if (method === 'GET' && url.pathname === '/fapi/v1/premiumIndex') {
    return { symbol: url.searchParams.get('symbol'), markPrice: '50000' };
  }
  if (method === 'POST' && url.pathname === '/fapi/v1/leverage') {
    const params = Object.fromEntries(new URLSearchParams(String(config.data)));
    return { symbol: params.symbol, leverage: Number(params.leverage) };
  }
  if (method === 'POST' && url.pathname === '/fapi/v1/order') {
    const params = Object.fromEntries(new URLSearchParams(String(config.data)));
    exchange.orderRequests.push(params);
    if (exchange.rejectFirstOrderWith4061 && exchange.orderRequests.length === 1) {
      const error: any = new Error('Request failed with status code 400');
      error.response = { status: 400, data: { code: -4061, msg: "Order's position side does not match user's setting." } };
      throw error;
    }
    return {
      orderId: 9000 + exchange.orderRequests.length,
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      origQty: params.quantity,
      positionSide: params.positionSide,
      status: 'NEW'
    };
  }

  throw new Error(`Unmocked exchange request: ${method} ${url.pathname}`);
}

// Live-mode config that places MARKET entries (skips order book analysis)
function createLiveConfig() {
  const config = createMockConfig();
  config.global.paperMode = false;
  config.symbols.BTCUSDT.orderType = 'MARKET';
  config.symbols.BTCUSDT.tradeSize = 20;
  return config;
}

// Place an entry through Hunter's real order path, skipping the pre-trade mode sync
async function placeEntry(hunter: Hunter, side: 'BUY' | 'SELL') {
  const hunterAny = hunter as any;
  hunterAny.lastModeSync = Date.now();
  const config = hunterAny.config;
  await hunterAny.placeTrade('BTCUSDT', side, config.symbols.BTCUSDT, 50000);
}

// ===== Tests =====

async function testPositionModeSync() {
  logSection('Position Mode Sync');
  const summary = new TestSummary();

  await summary.run('Syncs local ONE-WAY mode to exchange HEDGE mode', async () => {
    resetExchange();
    exchange.dualSidePosition = true;

    const hunter = new Hunter(createLiveConfig(), false);
    await hunter.syncPositionMode();

    assertEqual(exchange.modeQueries, 1, 'Should query the exchange position mode once');
    assertEqual((hunter as any).isHedgeMode, true, 'Local mode should switch to HEDGE');
  });

  await summary.run('Syncs local HEDGE mode to exchange ONE-WAY mode', async () => {
    resetExchange();
    exchange.dualSidePosition = false;

    const hunter = new Hunter(createLiveConfig(), true);
    await hunter.syncPositionMode();

    assertEqual((hunter as any).isHedgeMode, false, 'Local mode should switch to ONE-WAY');
  });

  await summary.run('Keeps current mode when the exchange query fails', async () => {
    resetExchange();
    exchange.failModeQuery = true;

    const hunter = new Hunter(createLiveConfig(), true);
    await hunter.syncPositionMode();

    assertEqual(exchange.modeQueries, 1, 'Should attempt the mode query');
    assertEqual((hunter as any).isHedgeMode, true, 'Mode should stay HEDGE on error');
  });

  await summary.run('Skips sync without API keys', async () => {
    resetExchange();
    const config = createLiveConfig();
    config.api.apiKey = '';
    config.api.secretKey = '';

    const hunter = new Hunter(config, false);
    await hunter.syncPositionMode();

    assertEqual(exchange.modeQueries, 0, 'Should not query the exchange without keys');
    assertEqual((hunter as any).isHedgeMode, false, 'Mode should be unchanged');
  });

  summary.print();
}

async function testPositionModeRetry() {
  logSection('Position Mode Retry on -4061');
  const summary = new TestSummary();

  await summary.run('Places entry with positionSide BOTH in ONE-WAY mode', async () => {
    resetExchange();
    exchange.dualSidePosition = false;

    const hunter = new Hunter(createLiveConfig(), false);
    await placeEntry(hunter, 'BUY');

    assertEqual(exchange.orderRequests.length, 1, 'Should place exactly one order');
    assertEqual(exchange.orderRequests[0].positionSide, 'BOTH', 'ONE-WAY entry uses positionSide BOTH');
    assertEqual(exchange.orderRequests[0].type, 'MARKET', 'Entry should be a MARKET order');
  });

  await summary.run('Mode mismatch: adopts exchange mode and retries with corrected positionSide', async () => {
    resetExchange();
    exchange.dualSidePosition = true; // Exchange is HEDGE, bot thinks ONE-WAY
    exchange.rejectFirstOrderWith4061 = true;

    const hunter = new Hunter(createLiveConfig(), false);
    await placeEntry(hunter, 'BUY');

    assertEqual(exchange.modeQueries, 1, 'Should query the exchange mode after -4061');
    assertEqual(exchange.orderRequests.length, 2, 'Should retry the order once');
    assertEqual(exchange.orderRequests[0].positionSide, 'BOTH', 'First attempt used ONE-WAY positionSide');
    assertEqual(exchange.orderRequests[1].positionSide, 'LONG', 'Retry should use HEDGE positionSide LONG for a BUY');
    assertEqual((hunter as any).isHedgeMode, true, 'Local mode should now match the exchange (HEDGE)');
    assertEqual((hunter as any).pendingOrders.size, 1, 'Only the placed order should be pending');
    assert((hunter as any).pendingOrders.has('9002'), 'Pending order should be the retried order ID');
  });

  await summary.run('Modes already match: no retry and mode is not mutated', async () => {
    resetExchange();
    exchange.dualSidePosition = true; // Exchange HEDGE, bot HEDGE
    exchange.rejectFirstOrderWith4061 = true;

    const hunter = new Hunter(createLiveConfig(), true);
    await placeEntry(hunter, 'SELL');

    assertEqual(exchange.modeQueries, 1, 'Should query the exchange mode after -4061');
    assertEqual(exchange.orderRequests.length, 1, 'Should not retry when modes match');
    assertEqual(exchange.orderRequests[0].positionSide, 'SHORT', 'HEDGE SELL uses positionSide SHORT');
    assertEqual((hunter as any).isHedgeMode, true, 'Mode should stay HEDGE');
    assertEqual((hunter as any).pendingOrders.size, 0, 'No pending orders should remain');
  });

  await summary.run('Mode query fails after -4061: no retry and mode is not mutated', async () => {
    resetExchange();
    exchange.rejectFirstOrderWith4061 = true;
    exchange.failModeQuery = true;

    const hunter = new Hunter(createLiveConfig(), false);
    await placeEntry(hunter, 'BUY');

    assertEqual(exchange.orderRequests.length, 1, 'Should not retry when the mode cannot be verified');
    assertEqual((hunter as any).isHedgeMode, false, 'Mode should stay ONE-WAY');
    assertEqual((hunter as any).pendingOrders.size, 0, 'No pending orders should remain');
  });

  summary.print();
}

async function main() {
  logSection('🧪 POSITION MODE SYNC TEST SUITE');

  // Route all exchange HTTP calls to the mock before anything is constructed
  mockExchangeHttp(handleRequest);

  try {
    await testPositionModeSync();
    await testPositionModeRetry();

    logSection('✨ All Position Mode Sync Tests Complete');
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
