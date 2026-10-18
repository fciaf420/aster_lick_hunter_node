/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';
import {
  LIGHTER_ORDER_STATUSES,
  createLighterUserStream,
  lighterOrderId,
  mapLighterOrderStatus,
  mapLighterOrderType,
  mapLighterTimeInForce,
  parseLighterAuthToken,
  parseLighterOrder,
  type LighterAccountStreamAlert,
  type LighterAuthTokenRequest,
  type LighterUserStreamDeps,
} from '../../../src/lib/exchange/lighter/accountStream';
import { LighterMarketCache } from '../../../src/lib/exchange/lighter/markets';
import type {
  AccountConfigUpdateEvent,
  AccountUpdateEvent,
  OrderTradeUpdateEvent,
  UserDataEvent,
  UserDataSubscription,
} from '../../../src/lib/exchange/types';
import { fakeSocketFactory, type FakeLighterSocket } from './fakeLighterSocket';

// Frames follow lighter-ts src/lighter-ws/types/WsMessage.ts (WsOrder, WsPosition, WsTrade; account_all_* messages,
// channels echoed with ':') and the lighter-python openapi.json models (Order, Trade, AccountPosition,
// DetailedAccounts). Amounts are decimal strings in human units, as the REST API and the WS wire format send them.

const START = Date.UTC(2026, 9, 18, 12, 0, 0);
const ACCOUNT = 12345;
const API_KEY = 3;
const HOUR = 60 * 60_000;
const BTC = 1;     // size_decimals 5, price_decimals 1
const ETH = 0;     // size_decimals 4, price_decimals 2
const SOL = 2;     // not on the allowlist: unmapped
const NOT = 172;   // 1000NOT mapped from NOTUSDT x1000: liquidation feed only
const QNT = 190;   // force reduce-only (untradable) but mapped through an override
const BIG_ORDER_ID = '576460752303423611'; // above 2^53: exact only as a string

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'orderBookDetails.perp.json'), 'utf8'));

// ===== Fixture builders =====

let nextOrderIndex = 281474976710700; // order_index values are >= 2^48
let nextTradeId = 500_000_000;

function signature(n: number): string {
  return n.toString(16).padStart(4, '0') + '5e'.repeat(78); // 160 hex characters
}

function tokenAt(deadlineMs: number, n: number): string {
  return `${Math.floor(deadlineMs / 1000)}:${ACCOUNT}:${API_KEY}:${signature(n)}`;
}

function wsOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_id: String(nextOrderIndex++),
    client_order_index: 1001,
    market_index: BTC,
    owner_account_index: ACCOUNT,
    initial_base_amount: '0.01000',
    remaining_base_amount: '0.01000',
    filled_base_amount: '0.00000',
    filled_quote_amount: '0.000000',
    price: '97000.0',
    trigger_price: '0.0',
    is_ask: false,
    reduce_only: false,
    nonce: 7,
    order_expiry: START + 28 * 24 * HOUR,
    parent_order_id: '0',
    trigger_status: 'na',
    status: 'open',
    type: 'limit',
    time_in_force: 'good-till-time',
    created_at: START,
    updated_at: START,
    ...overrides,
  };
}

// REST Order: the WS fields plus order_index (an int64 that JSON.parse may round), client_order_id, order_version
function restOrder(order: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_index: Number(order.order_id),
    client_order_id: String(order.client_order_index),
    base_size: 0,
    base_price: 0,
    side: order.is_ask ? 'sell' : 'buy',
    order_version: 1,
    ...order,
    ...overrides,
  };
}

function wsPosition(marketId: number, size: string, entry: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const negative = size.startsWith('-');
  const magnitude = negative ? size.slice(1) : size;
  return {
    market_id: marketId,
    initial_margin_fraction: '20.00',
    sign: Number(magnitude) === 0 ? 0 : negative ? -1 : 1,
    position: magnitude,
    avg_entry_price: entry,
    margin_mode: 0,
    allocated_margin: '0.000000',
    total_funding_paid_out: '0',
    total_discount: '0',
    margin_set_flag: 0,
    ...overrides,
  };
}

// The WS form of a REST AccountPosition (same market, size, entry and margin fraction)
function toWsPosition(position: Record<string, unknown>): Record<string, unknown> {
  const size = `${position.sign === -1 ? '-' : ''}${String(position.position)}`;
  return wsPosition(position.market_id as number, size, String(position.avg_entry_price), { initial_margin_fraction: position.initial_margin_fraction });
}

function restPosition(marketId: number, symbol: string, size: string, entry: string, overrides: Record<string, unknown> = {}) {
  return {
    ...wsPosition(marketId, size, entry),
    symbol,
    open_order_count: 0,
    pending_order_count: 0,
    position_tied_order_count: 0,
    position_value: '0',
    unrealized_pnl: '0.000000',
    realized_pnl: '0.000000',
    liquidation_price: '0',
    ...overrides,
  };
}

// One of our fills. By default we are the taker (the maker is on the other side of the book).
function ownTrade(order: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = nextTradeId++;
  const isAsk = order.is_ask === true;
  const counterOrder = '281474976799999';
  return {
    trade_id: id,
    trade_id_str: String(id),
    tx_hash: 'ab'.repeat(40),
    type: 'trade',
    market_id: order.market_index,
    size: '0.01000',
    price: '97000.0',
    usd_amount: '970.000000',
    ask_id: Number(isAsk ? order.order_id : counterOrder),
    bid_id: Number(isAsk ? counterOrder : order.order_id),
    ask_id_str: isAsk ? order.order_id : counterOrder,
    bid_id_str: isAsk ? counterOrder : order.order_id,
    ask_client_id: isAsk ? order.client_order_index : 0,
    bid_client_id: isAsk ? 0 : order.client_order_index,
    ask_account_id: isAsk ? ACCOUNT : 777,
    bid_account_id: isAsk ? 777 : ACCOUNT,
    is_maker_ask: !isAsk,
    block_height: 1234567,
    timestamp: Date.now(),
    taker_fee: 200,
    maker_fee: 0,
    ask_account_pnl: '0',
    bid_account_pnl: '0',
    ...overrides,
  };
}

function byMarket(items: Record<string, unknown>[], field: string): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {};
  for (const item of items) {
    const key = String(item[field]);
    (result[key] ??= []).push(item);
  }
  return result;
}

const channel = (name: string) => `${name}:${ACCOUNT}`;

const ordersFrame = (kind: 'subscribed' | 'update', orders: Record<string, unknown>[]) => ({
  type: `${kind}/account_all_orders`,
  channel: channel('account_all_orders'),
  orders: byMarket(orders, 'market_index'),
});

const positionsFrame = (kind: 'subscribed' | 'update', positions: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  type: `${kind}/account_all_positions_fe`,
  channel: channel('account_all_positions_fe'),
  positions: Object.fromEntries(positions.map(position => [String(position.market_id), position])),
  shares: [],
  ...extra,
});

const tradesFrame = (trades: Record<string, unknown>[]) => ({
  type: 'update/account_all_trades',
  channel: channel('account_all_trades'),
  trades: byMarket(trades, 'market_id'),
});

// ===== Harness =====

interface RestState {
  positions: Record<string, unknown>[];
  collateral: string;
  activeOrders: Record<string, unknown>[];
  accountOrders: Record<string, unknown>[];
  inactiveOrders: Record<string, unknown>[];
  trades: Record<string, unknown>[];
  accountGate: Promise<void> | null;   // Holds /account replies (body captured when the request arrives)
  rejectToken: string | null;          // Private calls with this token fail like an expired token
}

interface HttpCall {
  path: string;
  query: URLSearchParams;
  headers?: Record<string, string>;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function createHttp(rest: RestState) {
  const calls: HttpCall[] = [];
  const authError = () => Object.assign(new Error('Request failed with status code 400'), {
    response: { status: 400, data: { code: 29500, message: 'internal server error: invalid signature' } },
  });
  const get = jest.fn(async (url: string, options?: { headers?: Record<string, string> }) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, query: parsed.searchParams, headers: options?.headers });
    const auth = options?.headers?.authorization;
    if (auth !== undefined && auth === rest.rejectToken) throw authError();
    switch (parsed.pathname) {
      case '/api/v1/account': {
        const body = {
          code: 200,
          total: 1,
          accounts: [{
            code: 200,
            index: ACCOUNT,
            account_index: ACCOUNT,
            collateral: rest.collateral,
            available_balance: rest.collateral,
            positions: rest.positions.map(position => ({ ...position })),
            assets: [],
          }],
          next_cursor: '',
        };
        if (rest.accountGate) await rest.accountGate;
        return body;
      }
      case '/api/v1/accountActiveOrders':
        return { code: 200, orders: rest.activeOrders };
      case '/api/v1/accountOrders': {
        const wanted = new Set((parsed.searchParams.get('client_order_indexes') ?? '').split(','));
        return { code: 200, orders: rest.accountOrders.filter(order => wanted.has(String(order.client_order_index))) };
      }
      case '/api/v1/accountInactiveOrders':
        return { code: 200, orders: rest.inactiveOrders.filter(order => String(order.market_index) === parsed.searchParams.get('market_id')) };
      case '/api/v1/trades': {
        const orderId = parsed.searchParams.get('order_index_str');
        return { code: 200, trades: rest.trades.filter(trade => trade.ask_id_str === orderId || trade.bid_id_str === orderId) };
      }
      default:
        throw new Error(`unexpected request ${parsed.pathname}`);
    }
  });
  return {
    get,
    calls,
    count: (pathname: string) => calls.filter(call => call.path === pathname).length,
    last: (pathname: string) => [...calls].reverse().find(call => call.path === pathname),
  };
}

async function loadMarkets(profile: 'testnet' | 'mainnet' = 'testnet'): Promise<LighterMarketCache> {
  const cache = new LighterMarketCache({
    profile,
    symbols: {
      allowlist: ['BTCUSDT', 'ETHUSDT'],
      overrides: { QNTUSDT: 'QNT', NOTUSDT: { market: '1000NOT', multiplier: 1000 } },
    },
    httpGet: async () => FIXTURE,
  });
  await cache.load();
  return cache;
}

interface SetupOptions {
  rest?: Partial<RestState>;
  deps?: Partial<LighterUserStreamDeps>;
  tokenLifetimesMs?: number[];         // Lifetime of each issued token (the last one repeats)
  beforeReconnect?: () => Promise<void>;
}

let active: UserDataSubscription | null = null;

async function setup(options: SetupOptions = {}) {
  const markets = await loadMarkets();
  const fake = fakeSocketFactory();
  const rest: RestState = {
    positions: [],
    collateral: '1000.000000',
    activeOrders: [],
    accountOrders: [],
    inactiveOrders: [],
    trades: [],
    accountGate: null,
    rejectToken: null,
    ...options.rest,
  };
  const http = createHttp(rest);
  const lifetimes = options.tokenLifetimesMs ?? [6 * HOUR];
  const tokens: string[] = [];
  const getAuthToken = jest.fn(async (_request?: LighterAuthTokenRequest) => {
    const lifetime = lifetimes[Math.min(tokens.length, lifetimes.length - 1)];
    const token = tokenAt(Date.now() + lifetime, tokens.length);
    tokens.push(token);
    return token;
  });
  const events: UserDataEvent[] = [];
  const alerts: LighterAccountStreamAlert[] = [];
  const hooks = { connected: 0, disconnected: [] as Array<Error | undefined>, errors: [] as Error[] };

  const subscription = await createLighterUserStream(
    {
      profile: 'testnet',
      accountIndex: ACCOUNT,
      apiKeyIndex: API_KEY,
      getAuthToken,
      markets,
      http: http.get,
      wsFactory: fake.factory,
      onAlert: (alert) => alerts.push(alert),
      fillJoinWaitMs: 0,
      ...options.deps,
    },
    {
      onEvent: (event) => events.push(event),
      onConnected: () => hooks.connected++,
      onDisconnected: (error) => hooks.disconnected.push(error),
      onError: (error) => hooks.errors.push(error),
      beforeReconnect: options.beforeReconnect,
    }
  );
  active = subscription;
  return { subscription, fake, rest, http, getAuthToken, tokens, events, alerts, hooks, markets };
}

// Let pending promise chains (REST replies, session setup) run
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await jest.advanceTimersByTimeAsync(0);
}

// Open the socket and send the server's 'connected' frame (the stream subscribes right after it)
function connect(socket: FakeLighterSocket): FakeLighterSocket {
  socket.open();
  socket.serverSend({ type: 'connected', session_id: 'session-1' });
  return socket;
}

// Ack the four private channels with snapshots
function ack(socket: FakeLighterSocket, snapshot: { orders?: Record<string, unknown>[]; positions?: Record<string, unknown>[] } = {}) {
  socket.serverSend(ordersFrame('subscribed', snapshot.orders ?? []));
  socket.serverSend(positionsFrame('subscribed', snapshot.positions ?? []));
  socket.serverSend({ type: 'subscribed/account_all_trades', channel: channel('account_all_trades'), total_volume: 0, monthly_volume: 0, weekly_volume: 0, daily_volume: 0 });
  socket.serverSend({ type: 'subscribed/account_all_assets', channel: channel('account_all_assets'), assets: {} });
}

// The last `count` subscribe / unsubscribe frames (pings filtered out)
const subscriptionFrames = (socket: FakeLighterSocket, count: number) =>
  socket.sent.filter(message => message.type === 'subscribe' || message.type === 'unsubscribe').slice(-count);
const lastSubscribes = (socket: FakeLighterSocket, count: number) =>
  socket.sent.filter(message => message.type === 'subscribe').slice(-count);

const orderEvents = (events: UserDataEvent[]) => events.filter((e): e is OrderTradeUpdateEvent => e.e === 'ORDER_TRADE_UPDATE');
const accountUpdates = (events: UserDataEvent[]) => events.filter((e): e is AccountUpdateEvent => e.e === 'ACCOUNT_UPDATE');
const configUpdates = (events: UserDataEvent[]) => events.filter((e): e is AccountConfigUpdateEvent => e.e === 'ACCOUNT_CONFIG_UPDATE');
const positionsOf = (event: AccountUpdateEvent) => Object.fromEntries((event.a.P ?? []).map(p => [p.s, p.pa]));
const summary = (event: OrderTradeUpdateEvent) => `${event.o.x}/${event.o.X} l=${event.o.l} z=${event.o.z}`;

function allLogText(): string {
  const calls = [console.log, console.warn, console.error, console.debug]
    .flatMap(fn => (fn as jest.Mock).mock.calls);
  return calls.map(args => args.map((arg: unknown) => (typeof arg === 'string' ? arg : String(arg))).join(' ')).join('\n');
}

beforeEach(() => {
  jest.useFakeTimers({ now: START });
});

afterEach(async () => {
  const subscription = active;
  active = null;
  if (subscription) await subscription.close();
  jest.useRealTimers();
});

// ===== Pure mapping =====

describe('order mapping', () => {
  const order = (status: string, extra: Partial<{ filledBase: string; type: string; timeInForce: string }> = {}) => ({
    status,
    filledBase: extra.filledBase ?? '0',
    type: extra.type ?? 'limit',
    timeInForce: extra.timeInForce ?? 'good-till-time',
  });

  it('knows exactly the 17 statuses of openapi.json Order.status', () => {
    expect([...LIGHTER_ORDER_STATUSES].sort()).toEqual([
      'canceled', 'canceled-child', 'canceled-expired', 'canceled-invalid-balance', 'canceled-liquidation',
      'canceled-margin-not-allowed', 'canceled-not-enough-liquidity', 'canceled-oco', 'canceled-position-not-allowed',
      'canceled-post-only', 'canceled-reduce-only', 'canceled-self-trade', 'canceled-too-much-slippage',
      'filled', 'in-progress', 'open', 'pending',
    ]);
  });

  it('maps every status explicitly (spec §4.5)', () => {
    const expected: Record<string, string> = {
      'in-progress': 'NEW',
      pending: 'NEW',
      open: 'NEW',
      filled: 'FILLED',
      'canceled-expired': 'EXPIRED',
      'canceled-post-only': 'EXPIRED',
      canceled: 'CANCELED',
      'canceled-reduce-only': 'CANCELED',
      'canceled-position-not-allowed': 'CANCELED',
      'canceled-margin-not-allowed': 'CANCELED',
      'canceled-too-much-slippage': 'CANCELED',
      'canceled-not-enough-liquidity': 'CANCELED',
      'canceled-self-trade': 'CANCELED',
      'canceled-oco': 'CANCELED',
      'canceled-child': 'CANCELED',
      'canceled-liquidation': 'CANCELED',
      'canceled-invalid-balance': 'CANCELED',
    };
    for (const status of LIGHTER_ORDER_STATUSES) {
      expect([status, mapLighterOrderStatus(order(status))]).toEqual([status, expected[status]]);
    }
  });

  it('reports a partly filled open order as PARTIALLY_FILLED', () => {
    expect(mapLighterOrderStatus(order('open', { filledBase: '0.004' }))).toBe('PARTIALLY_FILLED');
    expect(mapLighterOrderStatus(order('pending', { filledBase: '0' }))).toBe('NEW');
  });

  it('reports cancels of IOC limit and market orders as EXPIRED, but not of untriggered SL/TP orders', () => {
    expect(mapLighterOrderStatus(order('canceled-not-enough-liquidity', { timeInForce: 'immediate-or-cancel' }))).toBe('EXPIRED');
    expect(mapLighterOrderStatus(order('canceled-too-much-slippage', { type: 'market', timeInForce: 'immediate-or-cancel' }))).toBe('EXPIRED');
    expect(mapLighterOrderStatus(order('canceled', { type: 'twap-sub' }))).toBe('EXPIRED');
    expect(mapLighterOrderStatus(order('canceled-oco', { type: 'stop-loss', timeInForce: 'immediate-or-cancel' }))).toBe('CANCELED');
    expect(mapLighterOrderStatus(order('canceled-oco', { type: 'take-profit', timeInForce: 'immediate-or-cancel' }))).toBe('CANCELED');
  });

  it('returns null for a status it does not know (never "inactive")', () => {
    expect(mapLighterOrderStatus(order('canceled-by-gremlins'))).toBeNull();
    expect(mapLighterOrderStatus(order(''))).toBeNull();
  });

  it('maps types and time in force', () => {
    expect(mapLighterOrderType('limit')).toBe('LIMIT');
    expect(mapLighterOrderType('market')).toBe('MARKET');
    expect(mapLighterOrderType('stop-loss')).toBe('STOP_MARKET');
    expect(mapLighterOrderType('stop-loss-limit')).toBe('STOP');
    expect(mapLighterOrderType('take-profit')).toBe('TAKE_PROFIT_MARKET');
    expect(mapLighterOrderType('take-profit-limit')).toBe('TAKE_PROFIT');
    expect(mapLighterOrderType('twap')).toBe('TWAP');
    expect(mapLighterOrderType('twap-sub')).toBe('MARKET');
    expect(mapLighterOrderType('liquidation')).toBe('LIQUIDATION');
    expect(mapLighterOrderType('brand-new')).toBe('BRAND_NEW');
    expect(mapLighterTimeInForce('good-till-time')).toBe('GTC');
    expect(mapLighterTimeInForce('immediate-or-cancel')).toBe('IOC');
    expect(mapLighterTimeInForce('post-only')).toBe('GTX');
  });

  it('uses the client order index as the order id, else the exchange id without rounding', () => {
    expect(lighterOrderId({ clientOrderIndex: 1001, orderId: '281474976710700' })).toBe(1001);
    expect(lighterOrderId({ clientOrderIndex: 0, orderId: '281474976710700' })).toBe(281474976710700);
    expect(lighterOrderId({ clientOrderIndex: 0, orderId: BIG_ORDER_ID })).toBe(BIG_ORDER_ID);
  });

  it('parses an order from order_id, never from a rounded order_index', () => {
    const parsed = parseLighterOrder(restOrder(wsOrder({ order_id: BIG_ORDER_ID, client_order_index: 0 })));
    expect(parsed?.orderId).toBe(BIG_ORDER_ID);
    expect(parsed?.clientOrderIndex).toBe(0);
    expect(parsed?.initialBase).toBe('0.01');
    expect(parsed?.price).toBe('97000');
    expect(parseLighterOrder({ ...wsOrder(), order_id: undefined, order_index: 2 ** 60 })).toBeNull();
    expect(parseLighterOrder({ ...wsOrder(), status: undefined })).toBeNull();
  });

  it('parses auth tokens without exposing the signature', () => {
    const token = tokenAt(START + HOUR, 1);
    expect(parseLighterAuthToken(token)).toEqual({ deadlineMs: Math.floor((START + HOUR) / 1000) * 1000, accountIndex: ACCOUNT, apiKeyIndex: API_KEY });
    expect(parseLighterAuthToken('not-a-token')).toBeNull();
    expect(parseLighterAuthToken(`${Math.floor(START / 1000)}:${ACCOUNT}:${API_KEY}:zz`)).toBeNull();
    expect(parseLighterAuthToken(42)).toBeNull();
  });
});

// ===== Stream =====

describe('Lighter account stream', () => {
  describe('startup', () => {
    it('seeds from REST without replaying it, then subscribes every private channel with auth', async () => {
      const sl = wsOrder({ client_order_index: 2002, type: 'stop-loss', status: 'pending', is_ask: true, reduce_only: true, time_in_force: 'immediate-or-cancel', trigger_price: '95000.0', price: '94050.0' });
      const ctx = await setup({
        rest: {
          positions: [restPosition(BTC, 'BTC', '0.01000', '97000.0'), restPosition(ETH, 'ETH', '-0.5000', '3000.00')],
          activeOrders: [restOrder(sl)],
        },
      });

      expect(ctx.events).toEqual([]);
      expect(ctx.http.last('/api/v1/account')?.headers).toBeUndefined();
      expect(ctx.http.last('/api/v1/account')?.query.get('active_only')).toBe('false');
      const active = ctx.http.last('/api/v1/accountActiveOrders');
      expect(active?.headers).toEqual({ authorization: ctx.tokens[0] });
      expect(active?.query.get('account_index')).toBe(String(ACCOUNT));
      expect(active?.query.get('market_id')).toBe('255');

      const socket = ctx.fake.last();
      expect(socket.url).toBe('wss://testnet.zklighter.elliot.ai/stream?readonly=true&encoding=json');
      socket.open();
      expect(socket.subscribes()).toEqual([]); // Nothing before the server's 'connected' frame
      socket.serverSend({ type: 'connected', session_id: 'abc' });
      expect(socket.subscribes().sort()).toEqual([
        `account_all_assets/${ACCOUNT}`,
        `account_all_orders/${ACCOUNT}`,
        `account_all_positions_fe/${ACCOUNT}`,
        `account_all_trades/${ACCOUNT}`,
      ]);
      for (const frame of socket.sent.filter(message => message.type === 'subscribe')) {
        expect(frame.auth).toBe(ctx.tokens[0]);
      }
      expect(ctx.hooks.connected).toBe(1);

      // Snapshots that match the REST baseline produce no events
      ack(socket, { orders: [sl], positions: [wsPosition(BTC, '0.01000', '97000.0'), wsPosition(ETH, '-0.5000', '3000.00')] });
      await settle();
      expect(ctx.events).toEqual([]);
      expect(ctx.alerts).toEqual([]);
    });

    it('refuses a token for another account and market data from another network', async () => {
      const markets = await loadMarkets();
      const base = {
        profile: 'testnet' as const,
        accountIndex: ACCOUNT,
        apiKeyIndex: API_KEY,
        markets,
        http: async () => ({ code: 200 }),
        wsFactory: fakeSocketFactory().factory,
      };
      const otherAccount = `${Math.floor((START + HOUR) / 1000)}:999:${API_KEY}:${signature(9)}`;
      await expect(createLighterUserStream({ ...base, getAuthToken: async () => otherAccount }, { onEvent: () => {} }))
        .rejects.toThrow('auth token is for account 999');
      await expect(createLighterUserStream({ ...base, getAuthToken: async () => tokenAt(START - 1000, 1) }, { onEvent: () => {} }))
        .rejects.toThrow('expired');
      await expect(createLighterUserStream({ ...base, getAuthToken: async () => 'garbage' }, { onEvent: () => {} }))
        .rejects.toThrow('not a Lighter auth token');

      const mainnetMarkets = await loadMarkets('mainnet');
      await expect(createLighterUserStream({ ...base, markets: mainnetMarkets, getAuthToken: async () => tokenAt(START + HOUR, 1) }, { onEvent: () => {} }))
        .rejects.toThrow('market data is for mainnet');
      expect(allLogText()).not.toContain(signature(9));
    });

    it('falls back to the first WS snapshot as the baseline when the REST seed fails', async () => {
      const order = wsOrder();
      const markets = await loadMarkets();
      const fake = fakeSocketFactory();
      const events: UserDataEvent[] = [];
      const alerts: LighterAccountStreamAlert[] = [];
      let fail = true;
      active = await createLighterUserStream(
        {
          profile: 'testnet',
          accountIndex: ACCOUNT,
          apiKeyIndex: API_KEY,
          getAuthToken: async () => tokenAt(Date.now() + 6 * HOUR, 1),
          markets,
          http: async (url: string) => {
            if (fail) throw new Error('ECONNRESET');
            return url.includes('/account?') ? { code: 200, accounts: [{ index: ACCOUNT, collateral: '5', positions: [restPosition(BTC, 'BTC', '0.01000', '97000.0')] }] } : { code: 200, orders: [order] };
          },
          wsFactory: fake.factory,
          onAlert: (alert) => alerts.push(alert),
          fillJoinWaitMs: 0,
        },
        { onEvent: (event) => events.push(event) }
      );
      expect(alerts.map(alert => alert.kind)).toEqual(['reconcile-failed']);
      fail = false;
      ack(connect(fake.last()), { orders: [order], positions: [wsPosition(BTC, '0.01000', '97000.0')] });
      await settle();
      expect(events).toEqual([]); // Snapshot = baseline
      await jest.advanceTimersByTimeAsync(30_000); // REST reconcile agrees with it
      expect(accountUpdates(events).map(event => event.a.B?.[0]?.wb)).toEqual(['5']); // Balance now known
      expect(orderEvents(events)).toEqual([]);
    });
  });

  describe('ACCOUNT_UPDATE', () => {
    async function connected(rest: Partial<RestState> = {}, deps: Partial<LighterUserStreamDeps> = {}) {
      const ctx = await setup({
        rest: {
          positions: [restPosition(BTC, 'BTC', '0.01000', '97000.0', { unrealized_pnl: '1.500000', liquidation_price: '80000.0' }), restPosition(ETH, 'ETH', '-0.5000', '3000.00')],
          ...rest,
        },
        deps,
      });
      const socket = connect(ctx.fake.last());
      ack(socket, { positions: ctx.rest.positions.map(toWsPosition) });
      await settle();
      expect(ctx.events).toEqual([]);
      return { ...ctx, socket };
    }

    it('always carries the full position set, plus a zero entry once for a market that went flat', async () => {
      const ctx = await connected();

      // Only BTC changed: ETH must still be listed (PositionManager clears its map on every ACCOUNT_UPDATE)
      ctx.socket.serverSend(positionsFrame('update', [wsPosition(BTC, '0.02000', '97100.0')]));
      let updates = accountUpdates(ctx.events);
      expect(updates).toHaveLength(1);
      expect(positionsOf(updates[0])).toEqual({ BTCUSDT: '0.02', ETHUSDT: '-0.5' });
      expect(updates[0].a.m).toBe('ORDER');
      expect(updates[0].a.B).toEqual([{ a: 'USDC', wb: '1000', cw: '1000', bc: '0' }]);
      const btc = updates[0].a.P?.find(p => p.s === 'BTCUSDT');
      expect(btc).toMatchObject({ ep: '97100', mt: 'cross', ps: 'BOTH', iw: '0' });
      expect(btc?.lp).toBeUndefined(); // The REST liquidation price was for the old size

      // ETH closed: listed once with pa "0"
      ctx.socket.serverSend(positionsFrame('update', [wsPosition(ETH, '0', '0')]));
      updates = accountUpdates(ctx.events);
      expect(updates).toHaveLength(2);
      expect(positionsOf(updates[1])).toEqual({ BTCUSDT: '0.02', ETHUSDT: '0' });

      ctx.socket.serverSend(positionsFrame('update', [wsPosition(BTC, '0.03000', '97200.0')]));
      updates = accountUpdates(ctx.events);
      expect(updates).toHaveLength(3);
      expect(positionsOf(updates[2])).toEqual({ BTCUSDT: '0.03' });
    });

    it('takes up and lp from REST when the size matches, else from the mark price', async () => {
      const ctx = await connected({}, { getMarkPrice: (marketId) => (marketId === BTC ? 98000 : null) });
      ctx.socket.serverSend(positionsFrame('update', [wsPosition(ETH, '-0.6000', '3000.00')]));
      const [update] = accountUpdates(ctx.events);
      const btc = update.a.P?.find(p => p.s === 'BTCUSDT');
      expect(btc).toMatchObject({ pa: '0.01', up: '1.5', lp: '80000', mp: '98000' }); // REST values for this size
      expect(update.a.P?.find(p => p.s === 'ETHUSDT')).toMatchObject({ pa: '-0.6', up: '0' });

      ctx.socket.serverSend(positionsFrame('update', [wsPosition(BTC, '0.02000', '97500.0')]));
      const btc2 = accountUpdates(ctx.events)[1].a.P?.find(p => p.s === 'BTCUSDT');
      expect(btc2).toMatchObject({ pa: '0.02', up: '10', mp: '98000' }); // (98000 - 97500) x 0.02
      expect(btc2?.lp).toBeUndefined();
    });

    it('does not close a position a snapshot leaves out until REST confirms it', async () => {
      const ctx = await connected();
      // A re-subscribe snapshot without ETH: REST still lists it, so nothing is emitted
      ctx.socket.serverSend(positionsFrame('subscribed', [wsPosition(BTC, '0.01000', '97000.0')]));
      await settle();
      expect(accountUpdates(ctx.events)).toEqual([]);
      const accountCalls = ctx.http.count('/api/v1/account');
      expect(accountCalls).toBeGreaterThanOrEqual(2);

      // REST stops listing it: one reply is not enough (a truncated body must not close a live position) ...
      ctx.rest.positions = [restPosition(BTC, 'BTC', '0.01000', '97000.0')];
      await jest.advanceTimersByTimeAsync(1_000);
      expect(accountUpdates(ctx.events)).toEqual([]);
      // ... the next one confirms it
      await jest.advanceTimersByTimeAsync(1_000);
      const updates = accountUpdates(ctx.events);
      expect(updates).toHaveLength(1);
      expect(positionsOf(updates[0])).toEqual({ BTCUSDT: '0.01', ETHUSDT: '0' });
      await jest.advanceTimersByTimeAsync(30_000);
      expect(accountUpdates(ctx.events)).toHaveLength(1);
    });

    it('closes a position at once when REST lists it with size 0', async () => {
      const ctx = await connected();
      ctx.rest.positions = [restPosition(BTC, 'BTC', '0.01000', '97000.0'), restPosition(ETH, 'ETH', '0', '0')];
      await jest.advanceTimersByTimeAsync(1_000);
      const updates = accountUpdates(ctx.events);
      expect(updates).toHaveLength(1);
      expect(positionsOf(updates[0])).toEqual({ BTCUSDT: '0.01', ETHUSDT: '0' });
    });

    it('keeps the WS position when a REST reply crosses a newer WS update', async () => {
      const ctx = await connected();
      const gate = deferred();
      ctx.rest.accountGate = gate.promise;
      await jest.advanceTimersByTimeAsync(30_000); // Periodic reconcile: /account is now in flight (old state)
      ctx.socket.serverSend(positionsFrame('update', [wsPosition(BTC, '0.02000', '97100.0')]));
      expect(positionsOf(accountUpdates(ctx.events)[0])).toEqual({ BTCUSDT: '0.02', ETHUSDT: '-0.5' });

      ctx.rest.accountGate = null;
      ctx.rest.positions = [restPosition(BTC, 'BTC', '0.02000', '97100.0'), restPosition(ETH, 'ETH', '-0.5000', '3000.00')];
      gate.resolve();
      await settle();
      // The stale reply (BTC 0.01) must not move BTC back
      expect(accountUpdates(ctx.events).map(positionsOf).every(p => p.BTCUSDT === '0.02')).toBe(true);
    });

    it('reports balance changes, with FUNDING_FEE after a funding round', async () => {
      const ctx = await connected();
      ctx.socket.serverSend(positionsFrame('update', [], { last_funding_round: { [BTC]: -0.12 } }));
      expect(accountUpdates(ctx.events)).toEqual([]); // Funding moved no position
      ctx.rest.collateral = '999.880000';
      await jest.advanceTimersByTimeAsync(1_000); // Debounced REST refresh
      const [update] = accountUpdates(ctx.events);
      expect(update.a.m).toBe('FUNDING_FEE');
      expect(update.a.B).toEqual([{ a: 'USDC', wb: '999.88', cw: '999.88', bc: '-0.12' }]);
      expect(positionsOf(update)).toEqual({ BTCUSDT: '0.01', ETHUSDT: '-0.5' });
    });

    it('emits ACCOUNT_CONFIG_UPDATE when the initial margin fraction changes', async () => {
      const ctx = await connected();
      ctx.socket.serverSend(positionsFrame('update', [wsPosition(BTC, '0.01000', '97000.0', { initial_margin_fraction: '10.00' })]));
      expect(configUpdates(ctx.events).map(event => event.ac)).toEqual([{ s: 'BTCUSDT', l: 10 }]);
      expect(accountUpdates(ctx.events)).toEqual([]); // Size unchanged
    });

    it('skips unmapped and multiplier markets but keeps untradable mapped ones', async () => {
      const ctx = await connected({
        positions: [
          restPosition(BTC, 'BTC', '0.01000', '97000.0'),
          restPosition(SOL, 'SOL', '1.000', '150.000'),
          restPosition(NOT, '1000NOT', '100.0', '0.00500'),
        ],
      });
      ctx.socket.serverSend(positionsFrame('update', [wsPosition(QNT, '2.000', '100.000'), wsPosition(SOL, '2.000', '151.000')]));
      const [update] = accountUpdates(ctx.events);
      expect(positionsOf(update)).toEqual({ BTCUSDT: '0.01', QNTUSDT: '2' });
    });
  });

  describe('ORDER_TRADE_UPDATE', () => {
    async function connected(deps: Partial<LighterUserStreamDeps> = {}, rest: Partial<RestState> = {}) {
      const ctx = await setup({ deps: { reconcileIntervalMs: 0, ...deps }, rest });
      const socket = connect(ctx.fake.last());
      ack(socket, { orders: rest.activeOrders ?? [] });
      await settle();
      return { ...ctx, socket };
    }

    it('reports a limit order from NEW through partial fills to FILLED with the client order index as id', async () => {
      const ctx = await connected({ resolveClientOrderId: (coi) => (coi === 1001 ? 'al_entry_1' : undefined) });
      const order = wsOrder();
      ctx.socket.serverSend(ordersFrame('update', [order]));
      ctx.socket.serverSend(ordersFrame('update', [{ ...order, filled_base_amount: '0.00400', remaining_base_amount: '0.00600', filled_quote_amount: '388.000000' }]));
      ctx.socket.serverSend(ordersFrame('update', [{ ...order, status: 'filled', filled_base_amount: '0.01000', remaining_base_amount: '0', filled_quote_amount: '970.600000' }]));

      const events = orderEvents(ctx.events);
      expect(events.map(summary)).toEqual([
        'NEW/NEW l=0 z=0',
        'TRADE/PARTIALLY_FILLED l=0.004 z=0.004',
        'TRADE/FILLED l=0.006 z=0.01',
      ]);
      expect(events[0].o).toMatchObject({
        s: 'BTCUSDT', i: 1001, c: 'al_entry_1', S: 'BUY', o: 'LIMIT', ot: 'LIMIT', f: 'GTC', q: '0.01', p: '97000',
        sp: '0', R: false, ps: 'BOTH', cp: false, N: 'USDC', wt: 'MARK_PRICE', lighterOrderId: order.order_id, lighterStatus: 'open',
      });
      expect(events[1].o).toMatchObject({ ap: '97000', L: '97000' });
      expect(events[2].o).toMatchObject({ ap: '97060', L: '97100' }); // Delta average: (970.6 - 388) / 0.006
    });

    it('treats a pending stop-loss as live and its OCO cancel as CANCELED', async () => {
      const ctx = await connected();
      const sl = wsOrder({ client_order_index: 2002, type: 'stop-loss', status: 'pending', is_ask: true, reduce_only: true, time_in_force: 'immediate-or-cancel', trigger_price: '95000.0', price: '94050.0', trigger_status: 'mark-price' });
      ctx.socket.serverSend(ordersFrame('update', [sl]));
      ctx.socket.serverSend(ordersFrame('update', [{ ...sl, status: 'canceled-oco' }]));
      const events = orderEvents(ctx.events);
      expect(events.map(summary)).toEqual(['NEW/NEW l=0 z=0', 'CANCELED/CANCELED l=0 z=0']);
      expect(events[0].o).toMatchObject({ i: 2002, S: 'SELL', o: 'STOP_MARKET', p: '0', sp: '95000', R: true, f: 'IOC', lighterPrice: '94050', triggerStatus: 'mark-price' });
    });

    it('emits the TRADE delta before the terminal event when a partial fill ends canceled', async () => {
      const ctx = await connected();
      const gtt = wsOrder();
      const ioc = wsOrder({ client_order_index: 1002, time_in_force: 'immediate-or-cancel' });
      ctx.socket.serverSend(ordersFrame('update', [gtt, ioc]));
      ctx.events.length = 0;
      ctx.socket.serverSend(ordersFrame('update', [
        { ...gtt, status: 'canceled', filled_base_amount: '0.00400', filled_quote_amount: '388.000000', remaining_base_amount: '0' },
        { ...ioc, status: 'canceled-not-enough-liquidity', filled_base_amount: '0.00300', filled_quote_amount: '291.000000', remaining_base_amount: '0' },
      ]));
      const events = orderEvents(ctx.events);
      expect(events.map(event => `${event.o.i} ${summary(event)}`)).toEqual([
        '1001 TRADE/PARTIALLY_FILLED l=0.004 z=0.004',
        '1001 CANCELED/CANCELED l=0 z=0.004',
        '1002 TRADE/PARTIALLY_FILLED l=0.003 z=0.003',
        '1002 EXPIRED/EXPIRED l=0 z=0.003',
      ]);

      // A market order first seen already canceled after a partial fill: NEW, TRADE, EXPIRED
      ctx.events.length = 0;
      const market = wsOrder({ client_order_index: 1003, type: 'market', time_in_force: 'immediate-or-cancel', status: 'canceled-too-much-slippage', filled_base_amount: '0.00200', filled_quote_amount: '194.000000' });
      ctx.socket.serverSend(ordersFrame('update', [market]));
      expect(orderEvents(ctx.events).map(summary)).toEqual(['NEW/NEW l=0 z=0', 'TRADE/PARTIALLY_FILLED l=0.002 z=0.002', 'EXPIRED/EXPIRED l=0 z=0.002']);
    });

    it('maps every terminal status of an active order', async () => {
      const ctx = await connected();
      const expected: Record<string, string> = {
        filled: 'TRADE/FILLED',
        canceled: 'CANCELED/CANCELED',
        'canceled-post-only': 'EXPIRED/EXPIRED',
        'canceled-reduce-only': 'CANCELED/CANCELED',
        'canceled-position-not-allowed': 'CANCELED/CANCELED',
        'canceled-margin-not-allowed': 'CANCELED/CANCELED',
        'canceled-too-much-slippage': 'CANCELED/CANCELED',
        'canceled-not-enough-liquidity': 'CANCELED/CANCELED',
        'canceled-self-trade': 'CANCELED/CANCELED',
        'canceled-expired': 'EXPIRED/EXPIRED',
        'canceled-oco': 'CANCELED/CANCELED',
        'canceled-child': 'CANCELED/CANCELED',
        'canceled-liquidation': 'CANCELED/CANCELED',
        'canceled-invalid-balance': 'CANCELED/CANCELED',
      };
      let coi = 3000;
      for (const [status, outcome] of Object.entries(expected)) {
        const order = wsOrder({ client_order_index: ++coi, status: 'in-progress' });
        ctx.socket.serverSend(ordersFrame('update', [order]));
        const filled = status === 'filled' ? { filled_base_amount: '0.01000', filled_quote_amount: '970.000000' } : {};
        ctx.events.length = 0;
        ctx.socket.serverSend(ordersFrame('update', [{ ...order, status, ...filled }]));
        const events = orderEvents(ctx.events);
        expect([status, events.map(event => `${event.o.x}/${event.o.X}`)]).toEqual([status, [outcome]]);
        expect(events[0].o.lighterStatus).toBe(status);
      }
      // Active-to-active changes (in-progress -> open -> pending) emit nothing
      const order = wsOrder({ client_order_index: 4000, status: 'in-progress' });
      ctx.socket.serverSend(ordersFrame('update', [order]));
      ctx.events.length = 0;
      ctx.socket.serverSend(ordersFrame('update', [{ ...order, status: 'open' }]));
      ctx.socket.serverSend(ordersFrame('update', [{ ...order, status: 'open' }])); // Duplicate
      expect(orderEvents(ctx.events)).toEqual([]);
    });

    it('never emits a terminal event from a snapshot for an order it never saw active', async () => {
      const resting = wsOrder({ client_order_index: 5001 });
      const ctx = await connected({}, { activeOrders: [restOrder(resting)] });
      const oldCanceled = wsOrder({ client_order_index: 5002, status: 'canceled', filled_base_amount: '0.00100', filled_quote_amount: '97.000000' });
      // Re-subscribe snapshot: an old canceled order plus our resting order, now filled
      ctx.socket.serverSend(ordersFrame('subscribed', [oldCanceled, { ...resting, status: 'filled', filled_base_amount: '0.01000', filled_quote_amount: '970.000000' }]));
      await settle();
      const events = orderEvents(ctx.events);
      expect(events.map(event => `${event.o.i} ${summary(event)}`)).toEqual(['5001 TRADE/FILLED l=0.01 z=0.01']);
    });

    it('alerts and re-syncs on an unknown status, keeping the order active', async () => {
      const resting = wsOrder({ client_order_index: 6001 });
      const ctx = await connected({}, { activeOrders: [restOrder(resting)] });
      const before = ctx.http.count('/api/v1/accountActiveOrders');
      ctx.socket.serverSend(ordersFrame('update', [{ ...resting, status: 'canceled-by-gremlins' }]));
      await settle();
      expect(ctx.alerts).toEqual([expect.objectContaining({ kind: 'unknown-status', orderId: resting.order_id, status: 'canceled-by-gremlins' })]);
      expect(ctx.http.count('/api/v1/accountActiveOrders')).toBe(before + 1);
      expect(orderEvents(ctx.events)).toEqual([]);

      // REST reporting the same unknown status does not loop
      ctx.rest.activeOrders = [restOrder({ ...resting, status: 'canceled-by-gremlins' })];
      ctx.socket.serverSend(ordersFrame('update', [{ ...resting, status: 'canceled-by-gremlins' }]));
      await settle();
      expect(ctx.http.count('/api/v1/accountActiveOrders')).toBeLessThanOrEqual(before + 3);
      expect(ctx.alerts).toHaveLength(1);

      // Still tracked as active: the real outcome is reported when it comes
      ctx.socket.serverSend(ordersFrame('update', [{ ...resting, status: 'filled', filled_base_amount: '0.01000', filled_quote_amount: '970.000000' }]));
      expect(orderEvents(ctx.events).map(summary)).toEqual(['TRADE/FILLED l=0.01 z=0.01']);
    });

    it('reports orders without a client order index by their exchange id, as a string above 2^53', async () => {
      const ctx = await connected();
      ctx.socket.serverSend(ordersFrame('update', [wsOrder({ order_id: BIG_ORDER_ID, client_order_index: 0 })]));
      const [event] = orderEvents(ctx.events);
      expect(event.o.i).toBe(BIG_ORDER_ID);
      expect(event.o.c).toBe(BIG_ORDER_ID);
    });

    it('does not report orders in unmapped or multiplier markets', async () => {
      const ctx = await connected();
      ctx.socket.serverSend(ordersFrame('update', [wsOrder({ market_index: SOL }), wsOrder({ market_index: NOT, client_order_index: 1002 })]));
      expect(orderEvents(ctx.events)).toEqual([]);
    });

    it('reports an amended order', async () => {
      const ctx = await connected();
      const order = wsOrder();
      ctx.socket.serverSend(ordersFrame('update', [order]));
      ctx.socket.serverSend(ordersFrame('update', [{ ...order, price: '96900.0' }]));
      const events = orderEvents(ctx.events);
      expect(events.map(summary)).toEqual(['NEW/NEW l=0 z=0', 'AMENDMENT/NEW l=0 z=0']);
      expect(events[1].o.p).toBe('96900');
    });
  });

  describe('fills', () => {
    async function connected(fillJoinWaitMs: number) {
      const ctx = await setup({ deps: { reconcileIntervalMs: 0, fillJoinWaitMs } });
      const socket = connect(ctx.fake.last());
      ack(socket);
      await settle();
      return { ...ctx, socket };
    }

    it('holds a fill event briefly for its trade and adds fee, realized PnL, last price and trade id', async () => {
      const ctx = await connected(300);
      const order = wsOrder({ is_ask: true, reduce_only: true });
      ctx.socket.serverSend(ordersFrame('update', [order]));
      ctx.socket.serverSend(ordersFrame('update', [{ ...order, status: 'filled', filled_base_amount: '0.01000', filled_quote_amount: '970.000000' }]));
      expect(orderEvents(ctx.events).map(summary)).toEqual(['NEW/NEW l=0 z=0']); // Fill held for its trade

      const trade = ownTrade(order, { ask_account_pnl: '-12.500000' });
      ctx.socket.serverSend(tradesFrame([trade]));
      const events = orderEvents(ctx.events);
      expect(events.map(summary)).toEqual(['NEW/NEW l=0 z=0', 'TRADE/FILLED l=0.01 z=0.01']);
      expect(events[1].o).toMatchObject({ n: '-0.194', rp: '-12.5', L: '97000', t: trade.trade_id, m: false, R: true });
    });

    it('uses trades that arrived first, and emits without them after the wait', async () => {
      const ctx = await connected(300);
      const first = wsOrder({ client_order_index: 1101 });
      ctx.socket.serverSend(ordersFrame('update', [first]));
      ctx.socket.serverSend(tradesFrame([ownTrade(first, { is_maker_ask: false, maker_fee: 20 })])); // We were the maker
      ctx.socket.serverSend(ordersFrame('update', [{ ...first, status: 'filled', filled_base_amount: '0.01000', filled_quote_amount: '970.000000' }]));
      let events = orderEvents(ctx.events);
      expect(events.map(summary)).toEqual(['NEW/NEW l=0 z=0', 'TRADE/FILLED l=0.01 z=0.01']);
      expect(events[1].o).toMatchObject({ n: '-0.0194', m: true });

      const second = wsOrder({ client_order_index: 1102 });
      ctx.socket.serverSend(ordersFrame('update', [second]));
      ctx.socket.serverSend(ordersFrame('update', [{ ...second, status: 'canceled', filled_base_amount: '0.00500', filled_quote_amount: '486.000000' }]));
      expect(orderEvents(ctx.events)).toHaveLength(3); // NEW only; TRADE + CANCELED held together
      await jest.advanceTimersByTimeAsync(300);
      events = orderEvents(ctx.events);
      expect(events.slice(3).map(summary)).toEqual(['TRADE/PARTIALLY_FILLED l=0.005 z=0.005', 'CANCELED/CANCELED l=0 z=0.005']);
      expect(events[3].o).toMatchObject({ n: '0', rp: '0', L: '97200' });

      // The late trade is absorbed, not credited to anything else
      ctx.socket.serverSend(tradesFrame([ownTrade(second, { size: '0.00500', usd_amount: '486.000000' })]));
      expect(orderEvents(ctx.events)).toHaveLength(5);
    });
  });

  describe('auth token', () => {
    it('refreshes 30 min before the deadline, re-subscribes with the new token and reconciles', async () => {
      const ctx = await setup({ tokenLifetimesMs: [40 * 60_000, 6 * HOUR], deps: { reconcileIntervalMs: 0, ws: { pingIntervalMs: 0, frameTimeoutMs: 0 } } });
      const socket = connect(ctx.fake.last());
      ack(socket);
      await settle();
      expect(ctx.getAuthToken).toHaveBeenCalledTimes(1);
      const restCalls = ctx.http.calls.length;

      await jest.advanceTimersByTimeAsync(10 * 60_000 - 1_000);
      expect(ctx.getAuthToken).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1_000);
      await settle();
      expect(ctx.getAuthToken).toHaveBeenCalledTimes(2);
      expect(ctx.getAuthToken.mock.calls[1][0]).toMatchObject({ forceNew: false, minValidMs: 30 * 60_000 });

      // Every private channel: unsubscribe, then subscribe again with the new token
      const resent = subscriptionFrames(socket, 8);
      expect(resent.filter(message => message.type === 'unsubscribe')).toHaveLength(4);
      const resubscribed = resent.filter(message => message.type === 'subscribe');
      expect(resubscribed).toHaveLength(4);
      for (const frame of resubscribed) expect(frame.auth).toBe(ctx.tokens[1]);
      // ... followed by a REST reconcile that uses the new token
      expect(ctx.http.calls.length).toBeGreaterThan(restCalls);
      expect(ctx.http.last('/api/v1/accountActiveOrders')?.headers).toEqual({ authorization: ctx.tokens[1] });

      // The next refresh is scheduled from the new deadline
      await jest.advanceTimersByTimeAsync(5 * HOUR);
      expect(ctx.getAuthToken).toHaveBeenCalledTimes(2);

      const logs = allLogText();
      for (const token of ctx.tokens) expect(logs).not.toContain(token.split(':')[3]);
    });

    it('retries until it gets a token that lasts longer than the margin', async () => {
      const ctx = await setup({ tokenLifetimesMs: [40 * 60_000, 20 * 60_000, 6 * HOUR], deps: { reconcileIntervalMs: 0, ws: { pingIntervalMs: 0, frameTimeoutMs: 0 } } });
      ack(connect(ctx.fake.last()));
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      // The second token is shorter-lived than the first: kept the current one, retry in a minute
      expect(ctx.getAuthToken).toHaveBeenCalledTimes(2);
      expect(ctx.fake.last().unsubscribes()).toEqual([]);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(ctx.getAuthToken).toHaveBeenCalledTimes(3);
      const resubscribed = lastSubscribes(ctx.fake.last(), 4);
      for (const frame of resubscribed) expect(frame).toMatchObject({ type: 'subscribe', auth: ctx.tokens[2] });
    });

    it('refreshes a rejected token once and retries the REST call', async () => {
      const ctx = await setup({ deps: { reconcileIntervalMs: 30_000 } });
      const socket = connect(ctx.fake.last());
      ack(socket);
      await settle();
      ctx.rest.rejectToken = ctx.tokens[0];
      await jest.advanceTimersByTimeAsync(30_000);
      await settle();
      expect(ctx.getAuthToken).toHaveBeenCalledTimes(2);
      expect(ctx.getAuthToken.mock.calls[1][0]).toMatchObject({ forceNew: true });
      const used = ctx.http.calls.filter(call => call.path === '/api/v1/accountActiveOrders').map(call => call.headers?.authorization);
      const rejected = used.lastIndexOf(ctx.tokens[0]);
      expect(rejected).toBeGreaterThan(0);
      expect(used.slice(rejected + 1).length).toBeGreaterThan(0);
      expect(used.slice(rejected + 1).every(token => token === ctx.tokens[1])).toBe(true);
      expect(lastSubscribes(socket, 4).map(frame => frame.auth)).toEqual(Array(4).fill(ctx.tokens[1]));
      expect(ctx.alerts).toEqual([]);
    });

    it('refreshes when the server rejects the token on the socket', async () => {
      const ctx = await setup({ deps: { reconcileIntervalMs: 0 } });
      const socket = connect(ctx.fake.last());
      ack(socket);
      socket.serverSend({ error: { code: 29500, message: 'invalid signature' } });
      await settle();
      expect(ctx.getAuthToken).toHaveBeenCalledTimes(2);
      expect(lastSubscribes(socket, 4).map(frame => frame.auth)).toEqual(Array(4).fill(ctx.tokens[1]));
    });
  });

  describe('reconnect and reconcile', () => {
    it('runs beforeReconnect, subscribes again and synthesizes what happened while it was down', async () => {
      const sl = wsOrder({ client_order_index: 2002, type: 'stop-loss', status: 'pending', is_ask: true, reduce_only: true, time_in_force: 'immediate-or-cancel', trigger_price: '95000.0', price: '94050.0' });
      const tp = wsOrder({ client_order_index: 2003, type: 'take-profit', status: 'pending', is_ask: true, reduce_only: true, time_in_force: 'immediate-or-cancel', trigger_price: '99000.0', price: '98010.0' });
      let gate = deferred();
      const beforeReconnect = jest.fn(() => gate.promise);
      const ctx = await setup({
        rest: { positions: [restPosition(BTC, 'BTC', '0.01000', '97000.0')], activeOrders: [restOrder(sl), restOrder(tp)] },
        beforeReconnect,
      });
      const first = connect(ctx.fake.last());
      ack(first, { orders: [sl, tp], positions: [wsPosition(BTC, '0.01000', '97000.0')] });
      await settle();
      expect(ctx.events).toEqual([]);

      // Drop; meanwhile the stop-loss fills and the take-profit is canceled by the OCO
      first.fail(new Error('ECONNRESET'));
      expect(ctx.hooks.errors.map(error => error.message)).toEqual(['ECONNRESET']);
      expect(ctx.hooks.disconnected).toHaveLength(1);
      const slFilled = { ...sl, status: 'filled', filled_base_amount: '0.01000', filled_quote_amount: '950.000000', trigger_status: 'na' };
      ctx.rest.positions = [restPosition(BTC, 'BTC', '0', '0')];
      ctx.rest.collateral = '969.310000';
      ctx.rest.activeOrders = [];
      ctx.rest.accountOrders = [restOrder(slFilled), restOrder({ ...tp, status: 'canceled-oco' })];
      ctx.rest.trades = [ownTrade(sl, { size: '0.01000', price: '95000.0', usd_amount: '950.000000', ask_account_pnl: '-20.500000' })];

      await jest.advanceTimersByTimeAsync(1_000); // Reconnect backoff
      expect(ctx.fake.sockets).toHaveLength(2);
      const second = connect(ctx.fake.last());
      await settle();
      expect(beforeReconnect).toHaveBeenCalledTimes(1);
      expect(second.subscribes()).toEqual([]); // Waits for the bot's own REST re-sync
      gate.resolve();
      await settle();
      expect(second.subscribes()).toHaveLength(4);
      for (const frame of second.sent.filter(message => message.type === 'subscribe')) expect(frame.auth).toBe(ctx.tokens[0]);
      expect(ctx.hooks.connected).toBe(2);

      // Reconcile: position closed, SL resolved through accountOrders + trades, TP canceled
      expect(ctx.http.last('/api/v1/accountOrders')?.query.get('client_order_indexes')).toBe('2002,2003');
      expect(ctx.http.last('/api/v1/trades')?.query.get('order_index_str')).toBe(sl.order_id);
      const updates = accountUpdates(ctx.events);
      expect(updates).toHaveLength(1);
      expect(positionsOf(updates[0])).toEqual({ BTCUSDT: '0' });
      expect(updates[0].a.B?.[0]).toMatchObject({ wb: '969.31', bc: '-30.69' });
      const events = orderEvents(ctx.events);
      expect(events.map(event => `${event.o.i} ${event.o.o} ${summary(event)}`)).toEqual([
        '2002 STOP_MARKET TRADE/FILLED l=0.01 z=0.01',
        '2003 TAKE_PROFIT_MARKET CANCELED/CANCELED l=0 z=0',
      ]);
      expect(events[0].o).toMatchObject({ rp: '-20.5', n: '-0.19', L: '95000', ap: '95000', R: true });

      // The late snapshot repeats nothing
      ack(second, { orders: [slFilled, { ...tp, status: 'canceled-oco' }] });
      await settle();
      expect(orderEvents(ctx.events)).toHaveLength(2);

      // A shutdown notice reconnects at once and runs the same path
      gate = deferred();
      gate.resolve();
      second.serverSend({ type: 'shutdown', close_in_ms: 5000 });
      await jest.advanceTimersByTimeAsync(0);
      expect(ctx.fake.sockets).toHaveLength(3);
      connect(ctx.fake.last());
      await settle();
      expect(beforeReconnect).toHaveBeenCalledTimes(2);
      expect(ctx.hooks.connected).toBe(3);
    });

    it('keeps a vanished order active until REST finds it, and alerts after repeated misses', async () => {
      const resting = wsOrder({ client_order_index: 7001 });
      const foreign = wsOrder({ client_order_index: 0, order_id: BIG_ORDER_ID });
      const ctx = await setup({
        rest: { activeOrders: [restOrder(resting), restOrder(foreign)] },
        deps: { unresolvedOrderAlertAttempts: 2 },
      });
      ack(connect(ctx.fake.last()), { orders: [resting, foreign] });
      await settle();
      ctx.rest.activeOrders = [];
      await jest.advanceTimersByTimeAsync(30_000);
      expect(ctx.alerts).toEqual([]);
      expect(ctx.http.last('/api/v1/accountInactiveOrders')?.query.get('market_id')).toBe(String(BTC));
      await jest.advanceTimersByTimeAsync(30_000);
      expect(ctx.alerts.map(alert => [alert.kind, alert.orderId])).toEqual([
        ['unresolved-order', resting.order_id],
        ['unresolved-order', BIG_ORDER_ID],
      ]);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(ctx.alerts).toHaveLength(2);
      expect(orderEvents(ctx.events)).toEqual([]); // Never assumed gone

      // The foreign order shows up in the inactive list: synthesized from there
      ctx.rest.inactiveOrders = [restOrder({ ...foreign, status: 'canceled' })];
      await jest.advanceTimersByTimeAsync(30_000);
      expect(orderEvents(ctx.events).map(event => `${event.o.i} ${summary(event)}`)).toEqual([`${BIG_ORDER_ID} CANCELED/CANCELED l=0 z=0`]);
    });

    it('reports an order REST lists as new, and a fill REST shows before the WS', async () => {
      const resting = wsOrder({ client_order_index: 8001 });
      const ctx = await setup({ rest: { activeOrders: [restOrder(resting)] } });
      ack(connect(ctx.fake.last()), { orders: [resting] });
      await settle();
      const placed = wsOrder({ client_order_index: 8002, is_ask: true });
      ctx.rest.activeOrders = [
        restOrder({ ...resting, filled_base_amount: '0.00200', filled_quote_amount: '194.000000' }),
        restOrder(placed),
      ];
      await jest.advanceTimersByTimeAsync(30_000);
      expect(orderEvents(ctx.events).map(event => `${event.o.i} ${summary(event)}`)).toEqual([
        '8001 TRADE/PARTIALLY_FILLED l=0.002 z=0.002',
        '8002 NEW/NEW l=0 z=0',
      ]);
      // A REST reply older than the WS state is ignored
      ctx.fake.last().serverSend(ordersFrame('update', [{ ...resting, filled_base_amount: '0.00500', filled_quote_amount: '485.000000' }]));
      ctx.rest.activeOrders = [restOrder({ ...resting, filled_base_amount: '0.00200', filled_quote_amount: '194.000000' }), restOrder(placed)];
      await jest.advanceTimersByTimeAsync(30_000);
      expect(orderEvents(ctx.events).map(summary)).toEqual([
        'TRADE/PARTIALLY_FILLED l=0.002 z=0.002',
        'NEW/NEW l=0 z=0',
        'TRADE/PARTIALLY_FILLED l=0.003 z=0.005',
      ]);
    });
  });

  describe('channel health and shutdown', () => {
    it('alerts on a channel that is never acknowledged and subscribes it again later', async () => {
      const ctx = await setup({ deps: { reconcileIntervalMs: 0, ws: { subscribeRetryDelaysMs: [100], maxSubscribeAttempts: 2, pingIntervalMs: 0, frameTimeoutMs: 0 }, channelRearmMs: 1_000 } });
      const socket = connect(ctx.fake.last());
      socket.serverSend(ordersFrame('subscribed', []));
      socket.serverSend(positionsFrame('subscribed', []));
      socket.serverSend({ type: 'subscribed/account_all_assets', channel: channel('account_all_assets'), assets: {} });
      await jest.advanceTimersByTimeAsync(250);
      expect(ctx.alerts).toEqual([expect.objectContaining({ kind: 'channel-failed', channel: `account_all_trades/${ACCOUNT}` })]);
      const before = socket.subscribes().filter(name => name.startsWith('account_all_trades')).length;
      await jest.advanceTimersByTimeAsync(1_000);
      expect(socket.subscribes().filter(name => name.startsWith('account_all_trades')).length).toBe(before + 1);
    });

    it('stops everything on close', async () => {
      const ctx = await setup();
      const socket = connect(ctx.fake.last());
      ack(socket);
      await settle();
      await ctx.subscription.close();
      active = null;
      expect(socket.terminated || socket.closed).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
      socket.serverSend(ordersFrame('update', [wsOrder()]));
      await jest.advanceTimersByTimeAsync(60_000);
      expect(ctx.events).toEqual([]);
      expect(ctx.fake.sockets).toHaveLength(1);
      expect(ctx.hooks.disconnected).toEqual([]);
      await ctx.subscription.close(); // Idempotent
    });
  });
});
