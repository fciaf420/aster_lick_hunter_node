#!/usr/bin/env tsx

/**
 * Golden exchange-request test.
 *
 * Drives the real Hunter, PositionManager and close-position route code paths against a
 * fake exchange and records every HTTP request they send (instance, method, host, path,
 * query, body, API key header). The recording is compared with tests/fixtures/exchange-golden.json,
 * so refactors of the exchange layer can prove the bot still sends exactly the same requests.
 *
 * Regenerate the fixture (only when a request change is intended):
 *   GOLDEN_UPDATE=1 npx tsx tests/core/exchange-golden.test.ts
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { InternalAxiosRequestConfig } from 'axios';
import { Hunter } from '../../src/lib/bot/hunter';
import { PositionManager, PositionTracker } from '../../src/lib/bot/positionManager';
import { symbolPrecision } from '../../src/lib/utils/symbolPrecision';
import { ConfigLoader } from '../../src/lib/config/configLoader';
import {
  TestSummary,
  logSection,
  log,
  colors,
  createMockConfig,
  mockExchangeHttp,
  finishTests,
  assert
} from '../utils/test-helpers';

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'exchange-golden.json');
const UPDATE = process.env.GOLDEN_UPDATE === '1';

// ===== Request recording =====

interface RecordedRequest {
  instance: 'plain' | 'rateLimited';
  method: string;
  host: string;
  path: string;
  query: Record<string, unknown>;
  body: Record<string, unknown> | string | null;
  apiKeyHeader: string | null;
}

type Recording = Record<string, RecordedRequest[]>;

// Values that change on every run are replaced with placeholders
const VOLATILE_KEYS: Record<string, string> = {
  timestamp: '<timestamp>',
  signature: '<signature>',
  recvWindow: '<recvWindow>',
  nonce: '<nonce>',
  newClientOrderId: '<clientOrderId>',
  clientOrderId: '<clientOrderId>',
  origClientOrderId: '<clientOrderId>',
  listenKey: '<listenKey>',
};

function normalizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (key in VOLATILE_KEYS) {
      result[key] = VOLATILE_KEYS[key];
    } else if (key === 'batchOrders' && typeof value === 'string') {
      // Batch orders are a JSON array of order params
      result[key] = (JSON.parse(value) as Record<string, unknown>[]).map(normalizeParams);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function parseBody(data: unknown): Record<string, unknown> | string | null {
  if (data === undefined || data === null || data === '') return null;
  if (data instanceof URLSearchParams) return normalizeParams(Object.fromEntries(data));
  if (typeof data === 'string') {
    try {
      return normalizeParams(JSON.parse(data));
    } catch {
      return normalizeParams(Object.fromEntries(new URLSearchParams(data)));
    }
  }
  if (typeof data === 'object') return normalizeParams(data as Record<string, unknown>);
  return String(data);
}

function recordRequest(config: InternalAxiosRequestConfig): RecordedRequest {
  const url = new URL(config.url || '', config.baseURL || 'https://fapi.asterdex.com');
  const query: Record<string, unknown> = Object.fromEntries(url.searchParams);
  Object.assign(query, config.params || {});

  const headers = (config.headers || {}) as Record<string, unknown>;
  const apiKey = headers['X-MBX-APIKEY'];

  return {
    // The rate-limited instance is created with a baseURL; plain axios has none
    instance: config.baseURL ? 'rateLimited' : 'plain',
    method: (config.method || 'get').toUpperCase(),
    host: url.host,
    path: url.pathname,
    query: normalizeParams(query),
    body: parseBody(config.data),
    apiKeyHeader: apiKey === undefined ? null : apiKey === TEST_API_KEY ? '<apiKey>' : '<other>',
  };
}

let activeRecording: RecordedRequest[] | null = null;
const recording: Recording = {};

// ===== Fake exchange =====

const TEST_API_KEY = 'a'.repeat(64);
const TEST_SECRET_KEY = 'b'.repeat(64);

interface FakePosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
}

interface FakeOrder {
  orderId: number;
  symbol: string;
  side: string;
  type: string;
  origQty: string;
  price: string;
  stopPrice: string;
  reduceOnly: boolean;
  positionSide: string;
  status: string;
  [key: string]: unknown;
}

const EXCHANGE_INFO = {
  symbols: [
    {
      symbol: 'BTCUSDT',
      status: 'TRADING',
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.1', minPrice: '0.1', maxPrice: '1000000' },
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
        { filterType: 'MIN_NOTIONAL', notional: '5' }
      ]
    },
    {
      symbol: 'ETHUSDT',
      status: 'TRADING',
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.01', minPrice: '0.01', maxPrice: '100000' },
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '10000' },
        { filterType: 'MIN_NOTIONAL', notional: '5' }
      ]
    }
  ]
};

const exchange = {
  positions: [] as FakePosition[],
  openOrders: [] as FakeOrder[],
  markPrices: {} as Record<string, number>,
  dualSidePosition: false,
  rejectNextOrderWith4061: false,
  nextOrderId: 1000,
};

function resetExchange() {
  exchange.positions = [];
  exchange.openOrders = [];
  exchange.markPrices = { BTCUSDT: 50000, ETHUSDT: 3000 };
  exchange.dualSidePosition = false;
  exchange.rejectNextOrderWith4061 = false;
  exchange.nextOrderId = 1000;
}

function exchangeError(code: number, msg: string): Error {
  const error: any = new Error('Request failed with status code 400');
  error.response = { status: 400, data: { code, msg } };
  return error;
}

function createOrder(params: Record<string, string>): FakeOrder {
  return {
    orderId: exchange.nextOrderId++,
    clientOrderId: params.newClientOrderId || `fake_${exchange.nextOrderId}`,
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
    time: 1700000000000,
    updateTime: 1700000000000,
  };
}

function bookFor(symbol: string) {
  const mark = exchange.markPrices[symbol];
  const step = symbol === 'BTCUSDT' ? 10 : 1;
  return { bid: mark - step, ask: mark + step };
}

function fakeExchange(config: InternalAxiosRequestConfig): unknown {
  const url = new URL(config.url || '', config.baseURL || 'https://fapi.asterdex.com');
  const method = (config.method || 'get').toUpperCase();
  const query = (key: string) => url.searchParams.get(key) ?? config.params?.[key];
  const form = (): Record<string, string> => Object.fromEntries(new URLSearchParams(String(config.data)));

  switch (`${method} ${url.pathname}`) {
    case 'GET /fapi/v1/exchangeInfo':
      return EXCHANGE_INFO;
    case 'GET /fapi/v1/premiumIndex': {
      const symbol = query('symbol');
      return { symbol, markPrice: String(exchange.markPrices[symbol]) };
    }
    case 'GET /fapi/v1/ticker/price': {
      const symbol = query('symbol');
      return { symbol, price: String(exchange.markPrices[symbol]) };
    }
    case 'GET /fapi/v1/ticker/bookTicker': {
      const symbol = query('symbol');
      const { bid, ask } = bookFor(symbol);
      return { symbol, bidPrice: String(bid), bidQty: '5', askPrice: String(ask), askQty: '5' };
    }
    case 'GET /fapi/v1/depth': {
      const { bid, ask } = bookFor(query('symbol'));
      return {
        lastUpdateId: 1,
        bids: [[String(bid), '5'], [String(bid - 10), '10']],
        asks: [[String(ask), '5'], [String(ask + 10), '10']],
      };
    }
    case 'GET /fapi/v4/account':
      return { totalWalletBalance: '1000', availableBalance: '900', assets: [], positions: [] };
    case 'POST /fapi/v1/leverage': {
      const params = form();
      return { symbol: params.symbol, leverage: Number(params.leverage), maxNotionalValue: '1000000' };
    }
    case 'GET /fapi/v1/positionSide/dual':
      return { dualSidePosition: exchange.dualSidePosition };
    case 'GET /fapi/v2/positionRisk':
      return exchange.positions.map(p => ({
        ...p,
        markPrice: String(exchange.markPrices[p.symbol] ?? 0),
        unRealizedProfit: '0',
        liquidationPrice: '0',
        leverage: '10',
        marginType: 'cross',
        isolatedMargin: '0',
        isAutoAddMargin: 'false',
        updateTime: 1700000000000,
      }));
    case 'GET /fapi/v1/openOrders':
      return exchange.openOrders.map(o => ({ ...o }));
    case 'POST /fapi/v1/batchOrders': {
      const orders: Record<string, string>[] = JSON.parse(form().batchOrders);
      return orders.map(params => {
        const order = createOrder(params);
        exchange.openOrders.push(order);
        return order;
      });
    }
    case 'POST /fapi/v1/order': {
      const params = form();
      if (exchange.rejectNextOrderWith4061) {
        exchange.rejectNextOrderWith4061 = false;
        throw exchangeError(-4061, "Order's position side does not match user's setting.");
      }
      const order = createOrder(params);
      if (params.type === 'MARKET') {
        // Market orders fill immediately; a closing fill flattens the position
        const closing = params.reduceOnly === 'true' ||
          (params.positionSide === 'LONG' && params.side === 'SELL') ||
          (params.positionSide === 'SHORT' && params.side === 'BUY');
        if (closing) {
          const position = exchange.positions.find(p => p.symbol === params.symbol);
          if (position) position.positionAmt = '0';
        }
        return { ...order, status: 'FILLED', executedQty: params.quantity };
      }
      exchange.openOrders.push(order);
      return order;
    }
    case 'DELETE /fapi/v1/order': {
      const orderId = Number(query('orderId'));
      const index = exchange.openOrders.findIndex(o => o.orderId === orderId);
      if (index < 0) throw exchangeError(-2011, 'Unknown order sent.');
      const [order] = exchange.openOrders.splice(index, 1);
      return { ...order, status: 'CANCELED' };
    }
  }

  throw new Error(`Unmocked exchange request: ${method} ${url.pathname}`);
}

function handleRequest(config: InternalAxiosRequestConfig): unknown {
  if (!activeRecording) {
    throw new Error(`Exchange request outside a recorded flow: ${config.method?.toUpperCase()} ${config.url}`);
  }
  activeRecording.push(recordRequest(config));
  return fakeExchange(config);
}

// ===== Flow helpers =====

async function record(name: string, flow: () => Promise<void>): Promise<RecordedRequest[]> {
  const requests: RecordedRequest[] = [];
  activeRecording = requests;
  try {
    await flow();
  } finally {
    activeRecording = null;
  }
  recording[name] = requests;
  return requests;
}

function liveConfig() {
  const config = createMockConfig();
  config.api.apiKey = TEST_API_KEY;
  config.api.secretKey = TEST_SECRET_KEY;
  config.global.paperMode = false;
  config.symbols.BTCUSDT.tradeSize = 20;
  config.symbols.BTCUSDT.leverage = 5;
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
  return config;
}

// Position tracker with no open positions, so Hunter runs its live pre-trade checks
const emptyTracker: PositionTracker = {
  getMarginUsage: () => 0,
  getTotalPositionCount: () => 0,
  getUniquePositionCount: () => 0,
  getPositionsMap: () => new Map(),
};

function createHunter(orderType: 'MARKET' | 'LIMIT', isHedgeMode = false): Hunter {
  const config = liveConfig();
  config.symbols.BTCUSDT.orderType = orderType;
  config.symbols.BTCUSDT.priceOffsetBps = 2;
  config.symbols.BTCUSDT.maxSlippageBps = 50;
  const hunter = new Hunter(config, isHedgeMode);
  hunter.setPositionTracker(emptyTracker);
  // Skip the pre-trade position mode sync; the -4061 flow covers the mode query
  (hunter as any).lastModeSync = Date.now();
  return hunter;
}

async function placeEntry(hunter: Hunter, side: 'BUY' | 'SELL', entryPrice: number) {
  const hunterAny = hunter as any;
  await hunterAny.placeTrade('BTCUSDT', side, hunterAny.config.symbols.BTCUSDT, entryPrice);
}

function createManager(): PositionManager {
  return new PositionManager(liveConfig(), false);
}

async function sync(manager: PositionManager) {
  await (manager as any).syncWithExchange();
}

// ===== Flows =====

async function runFlows(summary: TestSummary) {
  await summary.run('Hunter: MARKET entry (one-way)', async () => {
    resetExchange();
    const hunter = createHunter('MARKET');
    const requests = await record('hunter: MARKET entry (one-way)', () => placeEntry(hunter, 'BUY', 50000));
    assert(requests.some(r => r.method === 'POST' && r.path === '/fapi/v1/order'), 'Should place an order');
  });

  await summary.run('Hunter: LIMIT entry (one-way)', async () => {
    resetExchange();
    const hunter = createHunter('LIMIT');
    const requests = await record('hunter: LIMIT entry (one-way)', () => placeEntry(hunter, 'SELL', 50000));
    const order = requests.find(r => r.method === 'POST' && r.path === '/fapi/v1/order');
    assert(order !== undefined, 'Should place an order');
    assert((order!.body as Record<string, unknown>).type === 'LIMIT', 'Entry should be a LIMIT order');
  });

  await summary.run('Hunter: -4061 position-mode retry', async () => {
    resetExchange();
    exchange.dualSidePosition = true; // Exchange is HEDGE, bot thinks ONE-WAY
    exchange.rejectNextOrderWith4061 = true;
    const hunter = createHunter('MARKET');
    const requests = await record('hunter: -4061 position-mode retry', () => placeEntry(hunter, 'BUY', 50000));
    const orders = requests.filter(r => r.method === 'POST' && r.path === '/fapi/v1/order');
    assert(orders.length === 2, 'Should retry the order once');
  });

  resetExchange();
  const manager = createManager();

  await summary.run('PositionManager: sync places SL+TP for a new position', async () => {
    exchange.positions.push({ symbol: 'BTCUSDT', positionAmt: '0.005', entryPrice: '50000', positionSide: 'BOTH' });
    const requests = await record('positionManager: sync places SL+TP for a new position', () => sync(manager));
    assert(requests.some(r => r.path === '/fapi/v1/batchOrders'), 'Should place an SL/TP batch');
  });

  await summary.run('PositionManager: size change re-sizes SL/TP', async () => {
    exchange.positions[0].positionAmt = '0.008';
    const requests = await record('positionManager: size change re-sizes SL/TP', () => sync(manager));
    assert(requests.some(r => r.method === 'DELETE'), 'Should cancel the old SL/TP');
  });

  await summary.run('PositionManager: closePosition cancels SL/TP and closes at market', async () => {
    const requests = await record('positionManager: closePosition cancels SL/TP and closes at market',
      () => manager.closePosition('BTCUSDT', 'LONG'));
    assert(requests.filter(r => r.method === 'DELETE').length === 2, 'Should cancel SL and TP');
  });

  await summary.run('PositionManager: cancel of an order that is already gone (-2011)', async () => {
    const requests = await record('positionManager: cancel of an order that is already gone (-2011)',
      () => (manager as any).cancelOrderWithRetry('BTCUSDT', 999999, 'SL'));
    assert(requests.length === 1, 'Should not retry when the order no longer exists');
  });

  await summary.run('PositionManager: past-TP position is closed at market', async () => {
    resetExchange();
    exchange.markPrices.BTCUSDT = 51200; // Above the 2% TP at 51000
    exchange.positions.push({ symbol: 'BTCUSDT', positionAmt: '0.005', entryPrice: '50000', positionSide: 'BOTH' });
    const pastTpManager = createManager();
    await record('positionManager: past-TP position is closed at market', () => sync(pastTpManager));
    assert(exchange.positions[0].positionAmt === '0', 'Position should be closed');
  });

  await summary.run('PositionManager: periodic check protects an untracked position', async () => {
    resetExchange();
    const periodicManager = createManager();
    exchange.positions.push({ symbol: 'ETHUSDT', positionAmt: '-0.5', entryPrice: '3000', positionSide: 'BOTH' });
    const requests = await record('positionManager: periodic check protects an untracked position',
      () => (periodicManager as any).checkAndAdjustOrders());
    assert(requests.some(r => r.path === '/fapi/v1/batchOrders'), 'Should place an SL/TP batch');
  });

  await summary.run('Close route: user closes a LONG position (one-way)', async () => {
    resetExchange();
    exchange.positions.push({ symbol: 'BTCUSDT', positionAmt: '0.005', entryPrice: '50000', positionSide: 'BOTH' });

    // Point the config loader at a temp config with test keys so the real config.user.json is never read
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exchange-golden-'));
    const loader = ConfigLoader.getInstance() as any;
    const originalPaths = {
      userConfigPath: loader.userConfigPath,
      legacyConfigPath: loader.legacyConfigPath,
      defaultConfigPath: loader.defaultConfigPath,
    };
    const userConfigPath = path.join(tmpDir, 'config.user.json');
    loader.userConfigPath = userConfigPath;
    loader.legacyConfigPath = path.join(tmpDir, 'config.json');
    loader.defaultConfigPath = path.join(tmpDir, 'config.default.json');
    assert(loader.userConfigPath === userConfigPath, 'Config loader must use the temp config');

    const config = liveConfig();
    await fs.writeFile(userConfigPath, JSON.stringify({ ...config, global: { riskPercent: 1, paperMode: false } }));

    try {
      const { NextRequest } = await import('next/server');
      const { POST } = await import('../../src/app/api/positions/[symbol]/[side]/close/route');
      let status = 0;
      await record('close route: user closes a LONG position (one-way)', async () => {
        const request = new NextRequest('http://localhost/api/positions/BTCUSDT/LONG/close', { method: 'POST' });
        const response = await POST(request, { params: Promise.resolve({ symbol: 'BTCUSDT', side: 'LONG' }) });
        status = response.status;
      });
      assert(status === 200, `Close route should succeed (status ${status})`);
    } finally {
      Object.assign(loader, originalPaths);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
}

// ===== Comparison =====

function describeRequest(request: RecordedRequest | undefined): string {
  return request ? JSON.stringify(request, null, 2) : '(none)';
}

function firstDifference(expected: Recording, actual: Recording): string | null {
  const flows = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const flow of flows) {
    if (!(flow in expected)) return `Flow "${flow}" is new (not in the fixture)`;
    if (!(flow in actual)) return `Flow "${flow}" is in the fixture but was not recorded`;

    const want = expected[flow];
    const got = actual[flow];
    const length = Math.max(want.length, got.length);
    for (let i = 0; i < length; i++) {
      if (JSON.stringify(want[i]) !== JSON.stringify(got[i])) {
        return [
          `Flow "${flow}" differs at request #${i + 1} (expected ${want.length} requests, got ${got.length})`,
          `Expected:\n${describeRequest(want[i])}`,
          `Actual:\n${describeRequest(got[i])}`,
        ].join('\n');
      }
    }
  }
  return null;
}

async function main() {
  logSection('🧪 EXCHANGE GOLDEN REQUEST TEST');

  // Route all exchange HTTP calls to the fake exchange before anything is constructed
  mockExchangeHttp(handleRequest);
  symbolPrecision.parseExchangeInfo(EXCHANGE_INFO);

  const flowSummary = new TestSummary();
  try {
    await runFlows(flowSummary);
  } catch (error) {
    flowSummary.add('Run recorded flows', false, error instanceof Error ? error.message : String(error));
  }
  flowSummary.print();

  logSection(UPDATE ? 'Writing Golden Fixture' : 'Comparing With Golden Fixture');
  const summary = new TestSummary();

  await summary.run('Recorded requests match the golden fixture', async () => {
    let fixture: Recording | null = null;
    try {
      fixture = JSON.parse(await fs.readFile(FIXTURE_PATH, 'utf8'));
    } catch {
      fixture = null;
    }

    if (UPDATE || !fixture) {
      await fs.mkdir(path.dirname(FIXTURE_PATH), { recursive: true });
      await fs.writeFile(FIXTURE_PATH, JSON.stringify(recording, null, 2) + '\n');
      log(`  Wrote ${path.relative(process.cwd(), FIXTURE_PATH)}`, colors.yellow);
    } else {
      const difference = firstDifference(fixture, recording);
      if (difference) {
        throw new Error(`${difference}\nIf this change is intended, regenerate with GOLDEN_UPDATE=1`);
      }
    }

    for (const [flow, requests] of Object.entries(recording)) {
      log(`  ${flow}: ${requests.length} requests`, colors.gray);
    }
  });

  summary.print();
  finishTests();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
