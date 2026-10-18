/**
 * @jest-environment node
 */
import {
  LIGHTER_LIQUIDATION_MAX_AGE_MS,
  LighterLiquidationSource,
  TradeIdLru,
  lighterForcedSide,
  lighterTimestampToMs,
  type LighterLiquidationAlert,
  type LighterLiquidationDetection,
  type LighterLiquidationMarket,
  type LighterLiquidationSourceOptions,
} from '../../../src/lib/liquidation/lighterLiquidationSource';
import type { LiquidationSourceError } from '../../../src/lib/liquidation/types';
import type { LiquidationEvent } from '../../../src/lib/types';
import { fakeSocketFactory, type FakeLighterSocket } from './fakeLighterSocket';

// Frames follow lighter-ts src/lighter-ws/types/WsMessage.ts (WsTrade, trade_fe messages) and spec §2.3:
// size / price / usd_amount are decimal strings in human units, ids come as numbers plus *_str strings,
// and the server echoes channels with ':' ("trade:1").

const START = Date.UTC(2026, 9, 18, 12, 0, 0);
const TX_A = 'a1'.repeat(40);
const TX_B = 'b2'.repeat(40);
const ASK_ORDER = '281474976712345';
const BID_ORDER = '281474976798765';

// market_id -> bot symbol (BTC 1, ETH 0 as in lighter-ts orderBookMetas.json; 1000NOT with a x1000 override)
const MARKETS: Record<number, string | LighterLiquidationMarket> = {
  0: 'ETHUSDT',
  1: 'BTCUSDT',
  77: { botSymbol: 'NOTUSDT', multiplier: 1000 },
  90: { botSymbol: 'SOLUSDT', insuranceFundAccountIndex: 4242 },
  91: { botSymbol: 'DOGEUSDT', insuranceFundAccountIndex: 281474976710655 }, // nil value: no fund account
  92: { botSymbol: 'XRPUSDT', disabledReason: 'mark ratio guard failed' },
};

let nextTradeId = 900_000_000;

function trade(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const tradeId = (overrides.trade_id as number | undefined) ?? nextTradeId++;
  const timestamp = Date.now() - 500;
  return {
    trade_id: tradeId,
    trade_id_str: String(tradeId),
    tx_hash: TX_A,
    type: 'liquidation',
    market_id: 1,
    size: '0.25000',
    price: '97250.0',
    usd_amount: '24312.5',
    ask_id: Number(ASK_ORDER),
    bid_id: Number(BID_ORDER),
    ask_id_str: ASK_ORDER,
    bid_id_str: BID_ORDER,
    ask_account_id: 555,
    bid_account_id: 777,
    is_maker_ask: false,
    block_height: 1234567,
    timestamp,
    transaction_time: timestamp * 1000 + 123,
    taker_fee: 0,
    maker_fee: 0,
    // The liquidated taker's position before the fill: large enough for every fill size used below
    taker_position_size_before: '100.00000',
    taker_position_sign_changed: false,
    ...overrides,
  };
}

const update = (marketId: number, trades: unknown[] | null, liquidationTrades?: unknown[] | null) => ({
  type: 'update/trade',
  channel: `trade:${marketId}`,
  trades,
  ...(liquidationTrades !== undefined ? { liquidation_trades: liquidationTrades } : {}),
});

const snapshot = (marketId: number, trades: unknown[] | null, liquidationTrades?: unknown[] | null) => ({
  type: 'subscribed/trade',
  channel: `trade:${marketId}`,
  trades,
  ...(liquidationTrades !== undefined ? { liquidation_trades: liquidationTrades } : {}),
});

// market_stats frames are stamped this long before now, so the books they carry predate trade()'s default
// timestamp (now - 500): the side gates only use a book from before the fill
const STATS_LEAD_MS = 1000;

const marketStats = (stats: Record<string, Record<string, unknown>>, type = 'update/market_stats', timestamp = Date.now() - STATS_LEAD_MS) => ({
  type,
  channel: 'market_stats:all',
  timestamp,
  market_stats: stats,
});

// Best bid / ask for one market, sent before a liquidation so the side gates' book check has a fresh mid
const book = (marketId: number, bid: string, ask: string, timestamp?: number) =>
  marketStats({ [marketId]: { market_id: marketId, best_bid_price: bid, best_ask_price: ask } }, 'update/market_stats', timestamp);

// Books in the market_stats snapshot from connect(): the mid of each equals the market's usual fill price in
// these tests (97250, NOT 2.5), so a forced SELL or BUY at that price passes the book check
const DEFAULT_BOOKS: Record<string, Record<string, unknown>> = Object.fromEntries(
  [0, 1, 90, 91, 92].map((id) => [id, { market_id: id, best_bid_price: '97249', best_ask_price: '97251' }])
);
DEFAULT_BOOKS[77] = { market_id: 77, best_bid_price: '2', best_ask_price: '3' };

function setup(options: Partial<LighterLiquidationSourceOptions> = {}) {
  const fake = fakeSocketFactory();
  const events: LiquidationEvent[] = [];
  const detections: LighterLiquidationDetection[] = [];
  const alerts: LighterLiquidationAlert[] = [];
  const hookLog = {
    connected: 0,
    disconnected: [] as Array<{ reconnectDelayMs: number | null }>,
    errors: [] as Array<{ error: unknown; info: LiquidationSourceError }>,
  };

  const source = new LighterLiquidationSource({
    profile: 'mainnet',
    resolveSymbol: (marketId) => MARKETS[marketId],
    marketIds: [0, 1],
    live: true,
    groupDebounceMs: 0,
    createSocket: fake.factory,
    onDetection: (detection) => detections.push(detection),
    onAlert: (alert) => alerts.push(alert),
    ...options,
  });

  source.start((event) => events.push(event), {
    onConnected: () => hookLog.connected++,
    onDisconnected: (info) => hookLog.disconnected.push(info),
    onError: (error, info) => hookLog.errors.push({ error, info }),
  });

  // Open the latest socket, send 'connected' and ack everything it subscribed to. The market_stats snapshot
  // carries DEFAULT_BOOKS unless withBooks is false.
  const connect = (socket: FakeLighterSocket = fake.last(), ack = true, withBooks = true) => {
    socket.open();
    socket.serverSend({ type: 'connected', session_id: `session-${fake.sockets.length}` });
    if (ack) {
      for (const channel of socket.subscribes()) {
        const [name, id] = channel.split('/');
        const type = name === 'market_stats' ? 'subscribed/market_stats' : `subscribed/${name}`;
        socket.serverSend(
          name === 'market_stats'
            ? { type, channel: channel.replace('/', ':'), timestamp: Date.now() - STATS_LEAD_MS, market_stats: withBooks ? DEFAULT_BOOKS : {} }
            : { type, channel: `${name}:${id}`, trades: [] }
        );
      }
    }
    return socket;
  };

  return { source, fake, events, detections, alerts, hookLog, connect };
}

function logged(mock: unknown, text: string): boolean {
  return (mock as jest.Mock).mock.calls.some((args: unknown[]) =>
    args.some((arg) => typeof arg === 'string' && arg.includes(text))
  );
}

let active: LighterLiquidationSource | null = null;

beforeEach(() => {
  jest.useFakeTimers({ now: START });
});

afterEach(() => {
  active?.stop();
  active = null;
  jest.useRealTimers();
});

function track<T extends { source: LighterLiquidationSource }>(ctx: T): T {
  active = ctx.source;
  return ctx;
}

describe('helpers', () => {
  it('normalizes trade timestamps by magnitude (unit is unverified, spec §9 Q3)', () => {
    const ms = 1792289401234;
    expect(lighterTimestampToMs(1792289401)).toBe(1792289401000);       // seconds
    expect(lighterTimestampToMs(ms)).toBe(ms);                          // ms
    expect(lighterTimestampToMs(ms * 1000 + 567)).toBe(ms);             // µs (transaction_time)
    expect(lighterTimestampToMs(String(ms))).toBe(ms);                  // decimal string
    expect(lighterTimestampToMs(1771943742851429)).toBe(1771943742851); // spec example
    expect(lighterTimestampToMs(ms * 1e6 + 400_000)).toBe(ms);         // ns
    expect(lighterTimestampToMs(0)).toBeNull();
    expect(lighterTimestampToMs(-5)).toBeNull();
    expect(lighterTimestampToMs('abc')).toBeNull();
    expect(lighterTimestampToMs('')).toBeNull();
    expect(lighterTimestampToMs(null)).toBeNull();
    expect(lighterTimestampToMs(undefined)).toBeNull();
  });

  it('derives the forced side from the taker (is_maker_ask=false: taker sold = forced SELL)', () => {
    expect(lighterForcedSide(false)).toBe('SELL');
    expect(lighterForcedSide(true)).toBe('BUY');
  });

  it('evicts the oldest trade id beyond capacity and refreshes ids on re-add', () => {
    const lru = new TradeIdLru(3);
    lru.add('a');
    lru.add('b');
    lru.add('c');
    lru.add('a'); // refresh: 'b' is now the oldest
    lru.add('d');
    expect(lru.has('a')).toBe(true);
    expect(lru.has('b')).toBe(false);
    expect(lru.has('c')).toBe(true);
    expect(lru.has('d')).toBe(true);
    expect(lru.size).toBe(3);
    expect(() => new TradeIdLru(0)).toThrow();
  });
});

describe('LighterLiquidationSource construction', () => {
  it('connects to the profile stream with readonly=true&encoding=json', () => {
    const ctx = track(setup());
    expect(ctx.fake.sockets).toHaveLength(1);
    expect(ctx.fake.last().url).toBe('wss://mainnet.zklighter.elliot.ai/stream?readonly=true&encoding=json');
    expect(ctx.source.id).toBe('lighter');
  });

  it('needs a profile or url, and refuses gated profiles', () => {
    expect(() => new LighterLiquidationSource({ resolveSymbol: () => undefined, marketIds: [] })).toThrow(/profile/);
    expect(() => new LighterLiquidationSource({ profile: 'robinhood', resolveSymbol: () => undefined, marketIds: [] }))
      .toThrow(/disabled/);
  });

  it('defaults to shadow mode', () => {
    const source = new LighterLiquidationSource({ profile: 'testnet', resolveSymbol: () => undefined, marketIds: [] });
    expect(source.live).toBe(false);
  });
});

describe('subscriptions', () => {
  it('subscribes only after the connected frame, to the configured markets plus market_stats/all', () => {
    const ctx = track(setup({ marketIds: () => [1, 0] }));
    const socket = ctx.fake.last();
    socket.open();
    expect(socket.subscribes()).toEqual([]);

    socket.serverSend({ type: 'connected', session_id: 'abc' });
    expect(socket.subscribes()).toEqual(['trade/1', 'trade/0', 'market_stats/all']);
    expect(ctx.hookLog.connected).toBe(1);
  });

  it('retries an un-acked subscribe after 3 s and 6 s, then falls back to trade_fe after 10 s', () => {
    const ctx = track(setup({ marketIds: [1] }));
    const socket = ctx.fake.last();
    socket.open();
    socket.serverSend({ type: 'connected', session_id: 'abc' });
    socket.serverSend({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: {} });
    expect(socket.subscribes()).toEqual(['trade/1', 'market_stats/all']);

    jest.advanceTimersByTime(3000);
    expect(socket.subscribes()).toEqual(['trade/1', 'market_stats/all', 'trade/1']);
    jest.advanceTimersByTime(6000);
    expect(socket.subscribes().filter((c) => c === 'trade/1')).toHaveLength(3);
    expect(socket.subscribes()).not.toContain('trade_fe/1');

    jest.advanceTimersByTime(1000); // 10 s after the first subscribe
    expect(socket.subscribes()).toContain('trade_fe/1');

    // trade_fe acks first: it becomes the market's channel and the pending trade/1 is dropped
    socket.serverSend({ type: 'subscribed/trade_fe', channel: 'trade_fe:1', trades: [] });
    jest.advanceTimersByTime(30_000);
    expect(socket.subscribes().filter((c) => c === 'trade/1')).toHaveLength(3);

    // A late ack for trade/1 gets an unsubscribe, and its data is not processed
    socket.serverSend({ type: 'subscribed/trade', channel: 'trade:1', trades: [] });
    expect(socket.unsubscribes()).toEqual(['trade/1']);

    // Liquidations arrive on trade_fe
    socket.serverSend(marketStats(DEFAULT_BOOKS));
    socket.serverSend({ type: 'update/trade_fe', channel: 'trade_fe:1', trades: [trade()] });
    expect(ctx.events).toHaveLength(1);
    expect(ctx.events[0].symbol).toBe('BTCUSDT');
  });

  it('remembers a working trade_fe channel and uses it first after a reconnect', () => {
    const ctx = track(setup({ marketIds: [1] }));
    const socket = ctx.fake.last();
    socket.open();
    socket.serverSend({ type: 'connected', session_id: 'abc' });
    jest.advanceTimersByTime(10_000);
    socket.serverSend({ type: 'subscribed/trade_fe', channel: 'trade_fe:1', trades: [] });

    socket.serverClose();
    jest.advanceTimersByTime(1000);
    const next = ctx.fake.last();
    expect(next).not.toBe(socket);
    next.open();
    next.serverSend({ type: 'connected', session_id: 'def' });
    expect(next.subscribes().sort()).toEqual(['market_stats/all', 'trade_fe/1']);
  });

  it('raises a coverage-gap alert when neither trade channel is ever acked', () => {
    const ctx = track(setup({ marketIds: [1], ws: { frameTimeoutMs: 0, pingIntervalMs: 0 } }));
    const socket = ctx.fake.last();
    socket.open();
    socket.serverSend({ type: 'connected', session_id: 'abc' });

    jest.advanceTimersByTime(120_000);
    expect(ctx.alerts).toEqual([]);
    jest.advanceTimersByTime(30_000);

    expect(ctx.alerts).toHaveLength(1);
    expect(ctx.alerts[0]).toMatchObject({
      kind: 'coverage-gap',
      marketId: 1,
      botSymbol: 'BTCUSDT',
      channels: ['trade/1', 'trade_fe/1'],
    });
    // 10 attempts per channel, then no more
    expect(socket.subscribes().filter((c) => c === 'trade/1')).toHaveLength(10);
    expect(socket.subscribes().filter((c) => c === 'trade_fe/1')).toHaveLength(10);
    expect(logged(console.error, 'COVERAGE GAP')).toBe(true);
    jest.advanceTimersByTime(600_000);
    expect(ctx.alerts).toHaveLength(1);
  });

  it('follows changes to the market list', () => {
    let ids = [1];
    const ctx = track(setup({ marketIds: () => ids, marketResyncIntervalMs: 60_000 }));
    const socket = ctx.connect();
    expect(socket.subscribes()).toEqual(['trade/1', 'market_stats/all']);

    ids = [0];
    jest.advanceTimersByTime(60_000);
    expect(socket.unsubscribes()).toEqual(['trade/1']);
    expect(socket.subscribes()).toEqual(['trade/1', 'market_stats/all', 'trade/0']);

    ids = [0, 1];
    ctx.source.syncMarkets();
    expect(socket.subscribes()).toEqual(['trade/1', 'market_stats/all', 'trade/0', 'trade/1']);
  });

  it('reports server error frames (no type) as alerts', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    socket.serverSend({ error: { code: 30003, message: 'Invalid Channel' } });
    expect(ctx.alerts).toEqual([{ kind: 'server-error', code: 30003, message: 'Invalid Channel' }]);
    expect(ctx.hookLog.errors).toEqual([]);
  });
});

describe('liquidation pipeline', () => {
  it('maps a liquidation in `trades` to a LiquidationEvent (spec §2.3 example)', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    const row = trade();
    socket.serverSend(update(1, [row]));

    expect(ctx.events).toEqual([
      {
        symbol: 'BTCUSDT',
        side: 'SELL',
        orderType: 'LIMIT',
        quantity: 0.25,
        price: 97250,
        averagePrice: 97250,
        orderStatus: 'FILLED',
        orderLastFilledQuantity: 0.25,
        orderFilledAccumulatedQuantity: 0.25,
        orderTradeTime: row.timestamp,
        eventTime: row.timestamp,
        qty: 0.25,
        time: row.timestamp,
      },
    ]);
    expect(ctx.detections[0]).toMatchObject({ emitted: true, dropReasons: [], notionalUsd: 24312.5, txHash: TX_A });
  });

  it('reads liquidations that only appear in `liquidation_trades`', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    socket.serverSend(update(1, [], [trade({ size: '1.5', price: '97000' })]));
    expect(ctx.events).toHaveLength(1);
    expect(ctx.events[0]).toMatchObject({ symbol: 'BTCUSDT', quantity: 1.5, price: 97000 });

    // trades may be null on the wire
    socket.serverSend(update(1, null, [trade({ size: '0.5', tx_hash: TX_B })]));
    expect(ctx.events).toHaveLength(2);
  });

  it('counts a trade listed in both arrays once', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    const row = trade({ size: '2' });
    socket.serverSend(update(1, [row], [{ ...row }]));
    expect(ctx.events).toHaveLength(1);
    expect(ctx.events[0].quantity).toBe(2);
    expect(ctx.detections[0].tradeIds).toEqual([row.trade_id_str]);
  });

  it('ignores ordinary trades, deleverages and market settlements', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    socket.serverSend(update(1, [
      trade({ type: 'trade' }),
      trade({ type: 'deleverage', tx_hash: TX_B }),
      trade({ type: 'market-settlement', tx_hash: 'c3'.repeat(40) }),
    ]));
    expect(ctx.events).toEqual([]);
    expect(ctx.detections).toEqual([]);
  });

  it('never emits from subscribed/* snapshots, and remembers their ids', () => {
    const ctx = track(setup());
    const socket = ctx.fake.last();
    socket.open();
    socket.serverSend({ type: 'connected', session_id: 'abc' });
    const old = trade();
    const oldInLiquidations = trade({ tx_hash: TX_B });
    socket.serverSend(snapshot(1, [old], [oldInLiquidations]));
    socket.serverSend({ ...snapshot(0, [trade({ market_id: 0 })]), type: 'subscribed/trade_fe', channel: 'trade_fe:0' });
    expect(ctx.events).toEqual([]);
    expect(ctx.detections).toEqual([]);

    // The same trades replayed in an update are duplicates
    socket.serverSend(update(1, [old], [oldInLiquidations]));
    expect(ctx.events).toEqual([]);

    const fresh = trade({ tx_hash: 'd4'.repeat(40) });
    socket.serverSend(marketStats(DEFAULT_BOOKS));
    socket.serverSend(update(1, [old, fresh]));
    expect(ctx.events).toHaveLength(1);
    expect(ctx.detections.map((d) => d.tradeIds)).toEqual([[fresh.trade_id_str]]);
  });

  it('dedupes across reconnects', () => {
    const ctx = track(setup());
    const first = ctx.connect();
    const seen = trade();
    first.serverSend(update(1, [seen]));
    expect(ctx.events).toHaveLength(1);

    first.serverClose();
    jest.advanceTimersByTime(1000);
    const second = ctx.fake.last();
    expect(second).not.toBe(first);
    ctx.connect(second);
    // The new session's snapshot and a replayed update both repeat the old trade
    second.serverSend(snapshot(1, [seen]));
    second.serverSend(update(1, [seen]));
    expect(ctx.events).toHaveLength(1);

    second.serverSend(update(1, [trade({ tx_hash: TX_B })]));
    expect(ctx.events).toHaveLength(2);
  });

  it('dedupes on trade_id when trade_id_str is missing, and drops rows with no id', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    const row = trade();
    delete row.trade_id_str;
    socket.serverSend(update(1, [row]));
    socket.serverSend(update(1, [{ ...row, trade_id_str: String(row.trade_id) }]));
    expect(ctx.events).toHaveLength(1);

    const noId = trade({ tx_hash: TX_B });
    delete noId.trade_id;
    delete noId.trade_id_str;
    socket.serverSend(update(1, [noId]));
    expect(ctx.events).toHaveLength(1);
    expect(logged(console.warn, 'without trade_id')).toBe(true);
  });

  it('drops stale liquidations (10 s age guard) but logs them', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    const now = Date.now();

    socket.serverSend(update(1, [trade({ timestamp: now - LIGHTER_LIQUIDATION_MAX_AGE_MS - 1 })]));
    expect(ctx.events).toEqual([]);
    expect(ctx.detections[0].emitted).toBe(false);
    expect(ctx.detections[0].dropReasons.join()).toMatch(/stale: 10001 ms old/);

    socket.serverSend(book(1, '97249', '97251', now - 9_500));   // a book from before the next fill
    socket.serverSend(update(1, [trade({ tx_hash: TX_B, timestamp: now - 9_000 })]));
    expect(ctx.events).toHaveLength(1);
  });

  it('reads the timestamp in seconds or µs, and falls back to transaction_time and then receive time', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    const now = Date.now();
    socket.serverSend(book(1, '97249', '97251', now - 3000));

    socket.serverSend(update(1, [trade({ timestamp: Math.floor((now - 2000) / 1000) })]));
    expect(ctx.events[0].eventTime).toBe(Math.floor((now - 2000) / 1000) * 1000);

    socket.serverSend(update(1, [trade({ tx_hash: TX_B, timestamp: null, transaction_time: (now - 1500) * 1000 })]));
    expect(ctx.events[1].eventTime).toBe(now - 1500);

    // Receive time can't be ordered against the book, so such a fill is logged but never traded
    socket.serverSend(update(1, [trade({ tx_hash: 'e5'.repeat(40), timestamp: 42, transaction_time: undefined })]));
    expect(ctx.events).toHaveLength(2);
    expect(ctx.detections[2].event?.eventTime).toBe(now);
    expect(ctx.detections[2].notes.join()).toMatch(/no usable trade timestamp/);
    expect(ctx.detections[2].dropReasons).toEqual(['side unverified: no trade timestamp to find the best bid/ask from before the fill']);
  });

  it('clamps a trade timestamp ahead of the local clock to now (it must not outlive the threshold window)', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    const now = Date.now();
    socket.serverSend(update(1, [trade({ timestamp: now + 5_000 })]));
    expect(ctx.events[0].eventTime).toBe(now);
    expect(ctx.detections[0].notes.join()).toMatch(/5000 ms ahead of the local clock/);
  });

  describe('forced side (spec §2.4)', () => {
    it('is_maker_ask=false -> forced SELL (long liquidated); is_maker_ask=true -> forced BUY (short liquidated)', () => {
      const ctx = track(setup());
      const socket = ctx.connect();
      socket.serverSend(update(1, [trade({ is_maker_ask: false })]));
      socket.serverSend(update(1, [trade({ is_maker_ask: true, tx_hash: TX_B, taker_position_size_before: '-0.25' })]));
      expect(ctx.events.map((e) => e.side)).toEqual(['SELL', 'BUY']);
    });

    it('groups fills by taker order: the taker is the bid when the maker is the ask', () => {
      const ctx = track(setup());
      const socket = ctx.connect();
      // Same tx, forced BUY (maker asks): fills share bid_id (the liquidated taker) but hit different asks
      socket.serverSend(book(1, '99', '100'));
      socket.serverSend(update(1, [
        trade({ is_maker_ask: true, ask_id_str: '281474976700001', size: '1', price: '100' }),
        trade({ is_maker_ask: true, ask_id_str: '281474976700002', size: '3', price: '104' }),
      ]));
      expect(ctx.events).toHaveLength(1);
      expect(ctx.events[0]).toMatchObject({ side: 'BUY', quantity: 4, price: 103, averagePrice: 103 });
    });

    it('drops rows whose is_maker_ask is not a boolean', () => {
      const ctx = track(setup());
      const socket = ctx.connect();
      socket.serverSend(update(1, [trade({ is_maker_ask: undefined }), trade({ is_maker_ask: 'false', tx_hash: TX_B })]));
      expect(ctx.events).toEqual([]);
      expect(logged(console.warn, 'is_maker_ask')).toBe(true);
    });

    it('gates on taker cross-check mismatches and still notes them', () => {
      const ctx = track(setup());
      const socket = ctx.connect();
      socket.serverSend(update(1, [trade({ taker_position_sign_changed: true, taker_position_size_before: '-1.5' })]));
      expect(ctx.events).toEqual([]);
      expect(ctx.detections[0].emitted).toBe(false);
      const reasons = ctx.detections[0].dropReasons.join(' | ');
      expect(reasons).toMatch(/side unverified: taker_position_sign_changed=true/);
      expect(reasons).toMatch(/side unverified: forced SELL but the taker was short/);
      const notes = ctx.detections[0].notes.join(' | ');
      expect(notes).toMatch(/taker_position_sign_changed=true/);
      expect(notes).toMatch(/forced SELL but taker_position_size_before is negative/);
      expect(logged(console.warn, 'CHECK')).toBe(true);
    });
  });

  it('aggregates the fills of one liquidation: quantity sum, size-weighted price, latest time', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    const now = Date.now();
    socket.serverSend(book(1, '97300', '97310'));
    socket.serverSend(update(1, [
      trade({ size: '0.1', price: '97300', timestamp: now - 900, bid_id_str: '281474976700011' }),
      trade({ size: '0.2', price: '97250', timestamp: now - 700, bid_id_str: '281474976700012' }),
      trade({ size: '0.3', price: '97200', timestamp: now - 800, bid_id_str: '281474976700013' }),
      // Another liquidation in the same frame (different tx)
      trade({ tx_hash: TX_B, size: '5', price: '97100' }),
    ]));

    expect(ctx.events).toHaveLength(2);
    const [swept, other] = ctx.events;
    expect(swept.quantity).toBe(0.6);
    expect(swept.price).toBeCloseTo((0.1 * 97300 + 0.2 * 97250 + 0.3 * 97200) / 0.6, 6);
    expect(swept.averagePrice).toBe(swept.price);
    expect(swept.eventTime).toBe(now - 700);
    expect(other).toMatchObject({ quantity: 5, price: 97100 });
    expect(ctx.detections[0].tradeIds).toHaveLength(3);
  });

  it('merges fills of one liquidation that arrive in consecutive frames within the debounce', () => {
    const ctx = track(setup({ groupDebounceMs: 300 }));
    const socket = ctx.connect();
    socket.serverSend(book(1, '100', '101'));
    socket.serverSend(update(1, [trade({ size: '1', price: '100', bid_id_str: '281474976700021' })]));
    jest.advanceTimersByTime(200);
    socket.serverSend(update(1, [trade({ size: '1', price: '98', bid_id_str: '281474976700022' })]));
    expect(ctx.events).toEqual([]);

    jest.advanceTimersByTime(299);
    expect(ctx.events).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(ctx.events).toHaveLength(1);
    expect(ctx.events[0]).toMatchObject({ quantity: 2, price: 99 });
  });

  it('flushes a group that keeps growing after groupMaxWaitMs', () => {
    const ctx = track(setup({ groupDebounceMs: 300, groupMaxWaitMs: 1000 }));
    const socket = ctx.connect();
    for (let i = 0; i < 5; i++) {
      socket.serverSend(update(1, [trade({ size: '1', bid_id_str: `28147497670010${i}` })]));
      jest.advanceTimersByTime(250);
    }
    // First fill at 0 ms: flushed at 1000 ms with the four fills seen by then
    expect(ctx.events).toHaveLength(1);
    expect(ctx.events[0].quantity).toBe(4);
    jest.advanceTimersByTime(300);
    expect(ctx.events).toHaveLength(2);
    expect(ctx.events[1].quantity).toBe(1);
  });

  describe('LLP / insurance fund takeovers', () => {
    it('drops fills against the insurance fund operator (account 1)', () => {
      const ctx = track(setup());
      const socket = ctx.connect();
      socket.serverSend(update(1, [trade({ ask_account_id: 1 })]));
      socket.serverSend(update(1, [trade({ bid_account_id: 1, tx_hash: TX_B })]));
      expect(ctx.events).toEqual([]);
      expect(ctx.detections).toHaveLength(2);
      expect(ctx.detections[0].dropReasons.join()).toMatch(/LLP \/ insurance fund/);
      expect(ctx.detections[0].excludedTradeIds).toHaveLength(1);
    });

    it('drops fills against the liquidity pool and the market insurance fund, never the nil account', () => {
      const ctx = track(setup({ marketIds: [1, 90, 91], excludedAccountIndexes: () => [281474976710000] }));
      const socket = ctx.connect();
      socket.serverSend(update(1, [trade({ bid_account_id: 281474976710000 })]));
      socket.serverSend(update(90, [trade({ market_id: 90, ask_account_id: 4242, tx_hash: TX_B })]));
      socket.serverSend(update(91, [trade({ market_id: 91, ask_account_id: 281474976710655, tx_hash: 'f6'.repeat(40) })]));
      expect(ctx.events.map((e) => e.symbol)).toEqual(['DOGEUSDT']);
    });

    it('keeps the book fills of a liquidation that partly hit the LLP', () => {
      const ctx = track(setup({ excludedAccountIndexes: [281474976710000] }));
      const socket = ctx.connect();
      socket.serverSend(book(1, '100', '101'));
      socket.serverSend(update(1, [
        trade({ size: '1', price: '100', ask_account_id: 1001, bid_account_id: 2002, bid_id_str: '281474976700031' }),
        trade({ size: '9', price: '90', ask_account_id: 1001, bid_account_id: 281474976710000, bid_id_str: '281474976700032' }),
      ]));
      expect(ctx.events).toHaveLength(1);
      expect(ctx.events[0]).toMatchObject({ quantity: 1, price: 100 });
      expect(ctx.detections[0].notes.join()).toMatch(/1 fill\(s\) against the LLP/);
    });
  });

  it('ignores unknown markets and disabled markets for trading, but logs them', () => {
    const ctx = track(setup({ marketIds: [1, 92] }));
    const socket = ctx.connect();
    socket.serverSend({ ...update(5, [trade({ market_id: 5 })]) });
    socket.serverSend(update(92, [trade({ market_id: 92, tx_hash: TX_B })]));
    expect(ctx.events).toEqual([]);
    expect(ctx.detections[0]).toMatchObject({ marketId: 5, botSymbol: null, event: null, emitted: false });
    expect(ctx.detections[0].dropReasons.join()).toMatch(/not mapped/);
    expect(ctx.detections[1]).toMatchObject({ botSymbol: 'XRPUSDT', emitted: false });
    expect(ctx.detections[1].dropReasons.join()).toMatch(/mark ratio guard failed/);
  });

  it('converts Lighter units to bot units with the symbol multiplier', () => {
    const ctx = track(setup({ marketIds: [77] }));
    const socket = ctx.connect();
    socket.serverSend(update(77, [trade({ market_id: 77, size: '12', price: '2.5', usd_amount: '30' })]));
    expect(ctx.events[0]).toMatchObject({ symbol: 'NOTUSDT', quantity: 12000, price: 0.0025, qty: 12000 });
    // Volume (qty x price) is unchanged by the conversion
    expect(ctx.events[0].qty * ctx.events[0].price).toBeCloseTo(30, 9);
  });

  it('uses the row market_id over the channel and notes a mismatch', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    socket.serverSend(update(1, [trade({ market_id: 0 })]));
    expect(ctx.events[0].symbol).toBe('ETHUSDT');
    expect(ctx.detections[0].notes.join()).toMatch(/differs from channel market 1/);
  });

  it('drops rows with unusable size or price', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    socket.serverSend(update(1, [trade({ size: '0' }), trade({ price: 'NaN', tx_hash: TX_B }), trade({ size: '', tx_hash: 'g7'.repeat(40) })]));
    expect(ctx.events).toEqual([]);
  });
});

describe('side verification gates', () => {
  const reasons = (ctx: { detections: LighterLiquidationDetection[] }, index = 0) =>
    ctx.detections[index].dropReasons.join(' | ');

  it('trades a liquidation only when every gate passes', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    socket.serverSend(update(1, [trade()]));
    expect(ctx.events).toHaveLength(1);
    expect(ctx.detections[0]).toMatchObject({ emitted: true, dropReasons: [] });
  });

  it('drops a forced SELL that filled above the mid', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    socket.serverSend(book(1, '97000', '97010'));
    socket.serverSend(update(1, [trade({ price: '97250' })]));
    expect(ctx.events).toEqual([]);
    expect(reasons(ctx)).toBe('side unverified: forced SELL filled above the mid 97005');
  });

  it('drops a forced BUY that filled below the mid', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    socket.serverSend(update(1, [trade({ is_maker_ask: true, price: '97000', taker_position_size_before: '-0.25' })]));
    expect(ctx.events).toEqual([]);
    expect(reasons(ctx)).toBe('side unverified: forced BUY filled below the mid 97250');
  });

  it('drops a liquidation when no market_stats has arrived', () => {
    const ctx = track(setup());
    const socket = ctx.connect(undefined, true, false);
    socket.serverSend(update(1, [trade()]));
    expect(ctx.events).toEqual([]);
    expect(reasons(ctx)).toBe('side unverified: no fresh best bid/ask from before the fill to check the prices against');
  });

  it('drops a liquidation when the book is older than the age limit', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    jest.advanceTimersByTime(LIGHTER_LIQUIDATION_MAX_AGE_MS + 1);
    socket.serverSend(update(1, [trade()]));
    expect(ctx.events).toEqual([]);
    expect(ctx.detections[0].bbo).toMatchObject({ ageMs: LIGHTER_LIQUIDATION_MAX_AGE_MS + 1 });
    expect(reasons(ctx)).toBe('side unverified: no fresh best bid/ask from before the fill to check the prices against');
  });

  it('drops a liquidation when the book has a bid but no ask (or an ask but no bid)', () => {
    const ctx = track(setup());
    const socket = ctx.connect(undefined, true, false);
    socket.serverSend(marketStats({ 1: { market_id: 1, best_bid_price: '97249' } }));
    socket.serverSend(marketStats({ 0: { market_id: 0, best_ask_price: '97251' } }));
    socket.serverSend(update(1, [trade()]));
    socket.serverSend(update(0, [trade({ market_id: 0, tx_hash: TX_B })]));
    expect(ctx.events).toEqual([]);
    expect(reasons(ctx, 0)).toBe('side unverified: no fresh best bid/ask from before the fill to check the prices against');
    expect(reasons(ctx, 1)).toBe('side unverified: no fresh best bid/ask from before the fill to check the prices against');
  });

  it('drops a liquidation that flipped the taker position', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    socket.serverSend(update(1, [trade({ taker_position_sign_changed: true })]));
    expect(ctx.events).toEqual([]);
    expect(reasons(ctx)).toBe('side unverified: taker_position_sign_changed=true (a liquidation never flips the taker)');
  });

  it('drops a liquidation whose taker had no position before the fill', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    socket.serverSend(update(1, [trade({ taker_position_size_before: '0' })]));
    expect(ctx.events).toEqual([]);
    expect(reasons(ctx)).toBe('side unverified: fill larger than the taker position before it');
  });

  it('drops a fill larger than the taker position before it', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    socket.serverSend(update(1, [trade({ size: '0.25', taker_position_size_before: '0.1' })]));
    expect(ctx.events).toEqual([]);
    expect(reasons(ctx)).toBe('side unverified: fill larger than the taker position before it');
  });

  it('fails closed in live mode when the taker position fields are missing', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    socket.serverSend(update(1, [trade({ taker_position_size_before: null })]));
    socket.serverSend(update(1, [trade({ tx_hash: TX_B, taker_position_sign_changed: undefined })]));
    expect(ctx.events).toEqual([]);
    expect(reasons(ctx, 0)).toBe('side unverified: taker_position_size_before / taker_position_sign_changed missing');
    expect(reasons(ctx, 1)).toBe('side unverified: taker_position_size_before / taker_position_sign_changed missing');
  });

  it('still logs a detection with missing taker fields in shadow mode, with the reason', () => {
    const ctx = track(setup({ live: false }));
    const socket = ctx.connect();
    socket.serverSend(update(1, [trade({ taker_position_size_before: null })]));
    expect(ctx.events).toEqual([]);
    expect(ctx.detections[0]).toMatchObject({ live: false, emitted: false });
    const text = 'not traded: side unverified: taker_position_size_before / taker_position_sign_changed missing';
    // The default fill sits at the mid, above the best bid, so the line carries a BBO note and is a warning
    expect(logged(console.log, text) || logged(console.warn, text)).toBe(true);
  });

  it('checks a multi-level sweep against the book from before its first fill, not the book it left behind', () => {
    const ctx = track(setup({ groupDebounceMs: 300 }));
    const socket = ctx.connect();
    socket.serverSend(book(1, '97249', '97251'));      // mid 97250 before the liquidation
    socket.serverSend(update(1, [
      trade({ size: '0.1', price: '97240', taker_position_size_before: '0.3', bid_id_str: '281474976700061' }),
      trade({ size: '0.1', price: '97230', taker_position_size_before: '0.2', bid_id_str: '281474976700062' }),
      trade({ size: '0.1', price: '97200', taker_position_size_before: '0.1', bid_id_str: '281474976700063' }),
    ]));
    // The sweep took out the bids: the next market_stats (stamped after the fills) has a mid (97175) below the
    // first two fills
    socket.serverSend(book(1, '97150', '97200', Date.now()));
    jest.advanceTimersByTime(300);
    expect(ctx.events).toHaveLength(1);
    expect(ctx.events[0]).toMatchObject({ side: 'SELL', quantity: 0.3 });
    expect(ctx.detections[0].bbo).toMatchObject({ bestBid: 97249, bestAsk: 97251 });
  });

  it('uses the book stamped before the fill even when a later book arrived first (separate channels)', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    const now = Date.now();
    socket.serverSend(book(1, '97249', '97251', now - 800));   // before the fill at now - 500
    // The book the liquidation left behind reaches us before its trade frame
    socket.serverSend(book(1, '97150', '97200', now - 400));
    socket.serverSend(update(1, [trade({ price: '97240' })]));
    expect(ctx.events).toHaveLength(1);
    expect(ctx.detections[0].bbo).toMatchObject({ bestBid: 97249, bestAsk: 97251, bookTime: now - 800 });
  });

  it('picks the newest book by exchange time even when books arrive out of order', () => {
    const ctx = track(setup());
    const socket = ctx.connect(undefined, true, false);
    const now = Date.now();
    socket.serverSend(book(1, '97249', '97251', now - 700));   // newest before the fill at now - 500
    socket.serverSend(book(1, '97300', '97302', now - 900));   // older book delivered later
    socket.serverSend(update(1, [trade({ price: '97240' })]));
    expect(ctx.events).toHaveLength(1);
    expect(ctx.detections[0].bbo).toMatchObject({ bestBid: 97249, bestAsk: 97251, bookTime: now - 700 });
  });

  it('fails closed when every book it has is stamped at or after the fill', () => {
    const ctx = track(setup());
    const socket = ctx.connect(undefined, true, false);
    socket.serverSend(book(1, '97249', '97251', Date.now() - 500));   // same ms as the fill
    socket.serverSend(update(1, [trade()]));
    expect(ctx.events).toEqual([]);
    expect(reasons(ctx)).toBe('side unverified: no fresh best bid/ask from before the fill to check the prices against');
  });

  it('fails closed when market_stats frames carry no timestamp', () => {
    const ctx = track(setup());
    const socket = ctx.connect(undefined, true, false);
    socket.serverSend({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, best_bid_price: '97249', best_ask_price: '97251' } } });
    socket.serverSend(update(1, [trade()]));
    expect(ctx.events).toEqual([]);
    expect(reasons(ctx)).toBe('side unverified: no fresh best bid/ask from before the fill to check the prices against');
  });

  it('drops a forced SELL whose taker was short', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    socket.serverSend(update(1, [trade({ taker_position_size_before: '-0.5' })]));
    expect(ctx.events).toEqual([]);
    expect(reasons(ctx)).toBe('side unverified: forced SELL but the taker was short');
  });

  it('drops a forced BUY whose taker was long, once Lighter has shown signed sizes', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    // Unsigned so far: a positive size on a forced BUY can't be judged
    socket.serverSend(update(1, [trade({ is_maker_ask: true, taker_position_size_before: '0.25' })]));
    expect(ctx.events).toHaveLength(1);
    // A negative size proves sizes are signed; after that a forced BUY needs a short taker
    socket.serverSend(update(1, [trade({ is_maker_ask: true, tx_hash: TX_B, taker_position_size_before: '-0.25' })]));
    expect(ctx.events).toHaveLength(2);
    socket.serverSend(update(1, [trade({ is_maker_ask: true, tx_hash: 'h8'.repeat(40), taker_position_size_before: '0.25' })]));
    expect(ctx.events).toHaveLength(2);
    expect(reasons(ctx, 2)).toBe('side unverified: forced BUY but the taker was long');
  });

  it('drops every fill of a tx that has fills on both sides', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    // One tx: a fill where the taker sold and one where a (different) taker bought
    socket.serverSend(update(1, [
      trade({ is_maker_ask: false, ask_id_str: '281474976700041', bid_id_str: '281474976700051' }),
      trade({ is_maker_ask: true, ask_id_str: '281474976700052', bid_id_str: '281474976700042' }),
    ]));
    expect(ctx.events).toEqual([]);
    expect(ctx.detections).toHaveLength(2);
    expect(reasons(ctx, 0)).toBe('side unverified: tx has fills on both sides');
    expect(reasons(ctx, 1)).toBe('side unverified: tx has fills on both sides');
  });

  it('drops both sides of a tx whose fills arrive in consecutive frames within the debounce', () => {
    const ctx = track(setup({ groupDebounceMs: 300 }));
    const socket = ctx.connect();
    socket.serverSend(update(1, [trade({ is_maker_ask: false, ask_id_str: '281474976700043' })]));
    jest.advanceTimersByTime(100);
    socket.serverSend(update(1, [trade({ is_maker_ask: true, bid_id_str: '281474976700044' })]));
    jest.advanceTimersByTime(300);
    expect(ctx.events).toEqual([]);
    expect(ctx.detections.map((d) => d.dropReasons.join())).toEqual([
      'side unverified: tx has fills on both sides',
      'side unverified: tx has fills on both sides',
    ]);
  });

  it('never emits in shadow mode, even when every gate passes', () => {
    const ctx = track(setup({ live: false }));
    const socket = ctx.connect();
    socket.serverSend(book(1, '97250', '97260'));
    socket.serverSend(update(1, [trade()]));
    expect(ctx.events).toEqual([]);
    expect(ctx.detections[0]).toMatchObject({ live: false, emitted: false, dropReasons: [] });
    expect(logged(console.log, 'not traded: shadow mode')).toBe(true);
  });

  it('logs a skipped live signal with the gate that failed', () => {
    const ctx = track(setup());
    const socket = ctx.connect(undefined, true, false);
    socket.serverSend(update(1, [trade()]));
    expect(logged(console.log, 'not traded: side unverified: no fresh best bid/ask')).toBe(true);
  });
});

describe('shadow mode (spec §8 risk 1)', () => {
  it('logs detected liquidations with a BBO cross-check but never calls onLiquidation', () => {
    const ctx = track(setup({ live: undefined }));
    const socket = ctx.connect();
    socket.serverSend(marketStats({ 1: { market_id: 1, best_bid_price: '97260.0', best_ask_price: '97270.0', mark_price: '97265.1' } }));
    socket.serverSend(update(1, [trade({ price: '97250.0' })]));

    expect(ctx.events).toEqual([]);
    expect(ctx.detections).toHaveLength(1);
    expect(ctx.detections[0]).toMatchObject({ live: false, emitted: false, dropReasons: [] });
    expect(ctx.detections[0].event).toMatchObject({ symbol: 'BTCUSDT', side: 'SELL' });
    expect(ctx.detections[0].bbo).toMatchObject({ bestBid: 97260, bestAsk: 97270, markPrice: 97265.1 });
    expect(ctx.detections[0].notes.join()).toMatch(/BBO check ok: forced SELL fills <= best bid 97260/);
    expect(logged(console.log, 'Lighter liquidation [SHADOW] BTCUSDT: forced SELL 0.25 @ 97250')).toBe(true);
    expect(logged(console.log, 'not traded: shadow mode')).toBe(true);
  });

  it('flags a BBO mismatch (side possibly inverted) as a warning', () => {
    const ctx = track(setup({ live: false }));
    const socket = ctx.connect();
    socket.serverSend(marketStats({ 1: { best_bid_price: '97000', best_ask_price: '97010' } }));
    socket.serverSend(update(1, [trade({ is_maker_ask: true, price: '96990' })]));
    expect(ctx.detections[0].notes.join()).toMatch(/BBO CHECK MISMATCH: forced BUY filled at 96990 below best ask 97010/);
    expect(logged(console.warn, 'BBO CHECK MISMATCH')).toBe(true);
  });

  it('keeps the last known BBO fields when an update carries only some of them', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    socket.serverSend(marketStats({ 1: { best_bid_price: '100', best_ask_price: '101', mark_price: '100.5' } }, 'subscribed/market_stats'));
    socket.serverSend(marketStats({ 1: { best_ask_price: '102' } }));
    expect(ctx.source.getMarketStats(1)).toMatchObject({ bestBid: 100, bestAsk: 102, markPrice: 100.5 });
    expect(ctx.source.getMarketStats(3)).toBeNull();
  });

  it('ages each market_stats field separately: a partial frame never makes old values look fresh', () => {
    const clock = { now: Date.now() };
    const ctx = track(setup({ now: () => clock.now }));
    const socket = ctx.connect();
    socket.serverSend(marketStats({ 1: { best_bid_price: '100', best_ask_price: '101', mark_price: '100.5', open_interest: '10', open_interest_limit: '100000000' } }, 'subscribed/market_stats'));
    clock.now += 2000;
    expect(ctx.source.getMarketStats(1)).toMatchObject({ ageMs: 2000, openInterest: 10, openInterestLimit: 100_000_000, openInterestAgeMs: 2000 });
    // A frame with only the mark (or only funding) leaves the BBO 2 s old: the reported age is the oldest field's
    socket.serverSend(marketStats({ 1: { mark_price: '100.6', current_funding_rate: '0.0001' } }));
    expect(ctx.source.getMarketStats(1)).toMatchObject({ bestBid: 100, bestAsk: 101, markPrice: 100.6, ageMs: 2000 });
    clock.now += 3000;
    socket.serverSend(marketStats({ 1: { current_funding_rate: '0.0002' } }));
    expect(ctx.source.getMarketStats(1)).toMatchObject({ ageMs: 5000, openInterestAgeMs: 5000 });
    // A full frame refreshes everything
    socket.serverSend(marketStats({ 1: { best_bid_price: '100.1', best_ask_price: '100.9', mark_price: '100.5', open_interest: '12', open_interest_limit: '100000000' } }));
    expect(ctx.source.getMarketStats(1)).toMatchObject({ bestBid: 100.1, ageMs: 0, openInterest: 12, openInterestAgeMs: 0 });
  });

  it('notes when no market_stats has arrived yet', () => {
    const ctx = track(setup({ live: false }));
    const socket = ctx.connect(undefined, true, false);
    socket.serverSend(update(1, [trade()]));
    expect(ctx.detections[0].notes).toContain('BBO check: no market_stats yet');
  });

  it('switches to live at runtime', () => {
    const ctx = track(setup({ live: false }));
    const socket = ctx.connect();
    socket.serverSend(update(1, [trade()]));
    expect(ctx.events).toEqual([]);
    ctx.source.setLive(true);
    socket.serverSend(update(1, [trade({ tx_hash: TX_B })]));
    expect(ctx.events).toHaveLength(1);
    expect(logged(console.warn, 'LIVE mode')).toBe(true);
  });
});

describe('connection lifecycle', () => {
  it('reports socket errors once, reconnects once, and resubscribes', () => {
    const ctx = track(setup());
    const first = ctx.connect();
    first.fail(new Error('ECONNRESET'));
    first.serverClose(); // ws emits close after error: must not schedule a second reconnect

    expect(ctx.hookLog.errors).toHaveLength(1);
    expect(ctx.hookLog.errors[0].info).toEqual({
      kind: 'connection',
      url: 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true&encoding=json',
      reconnectDelayMs: 1000,
    });
    expect(ctx.hookLog.disconnected).toEqual([{ reconnectDelayMs: 1000 }]);

    jest.advanceTimersByTime(1000);
    expect(ctx.fake.sockets).toHaveLength(2);
    const second = ctx.connect();
    expect(second.subscribes()).toEqual(['trade/0', 'trade/1', 'market_stats/all']);
    expect(ctx.hookLog.connected).toBe(2);
  });

  it('reports a non-JSON frame as a message error and ignores null frames', () => {
    const ctx = track(setup());
    const socket = ctx.connect();
    socket.serverSend('null');
    socket.serverSend('null');
    socket.serverSend('null');
    expect(ctx.hookLog.errors).toEqual([]);
    socket.serverSend('{not json');
    expect(ctx.hookLog.errors).toHaveLength(1);
    expect(ctx.hookLog.errors[0].info).toEqual({ kind: 'message', rawMessage: '{not json' });
  });

  it('stops cleanly: no reconnect, no pending emission', () => {
    const ctx = track(setup({ groupDebounceMs: 300 }));
    const socket = ctx.connect();
    socket.serverSend(update(1, [trade()]));
    ctx.source.stop();
    expect(ctx.hookLog.disconnected).toEqual([{ reconnectDelayMs: null }]);
    expect(socket.terminated).toBe(true);

    jest.advanceTimersByTime(120_000);
    expect(ctx.events).toEqual([]);
    expect(ctx.fake.sockets).toHaveLength(1);
    socket.serverSend(update(1, [trade({ tx_hash: TX_B })]));
    expect(ctx.events).toEqual([]);
  });

  it('keeps subscribing when a hunter hook throws', () => {
    const fake = fakeSocketFactory();
    const source = new LighterLiquidationSource({
      profile: 'mainnet',
      resolveSymbol: (marketId) => MARKETS[marketId],
      marketIds: [1],
      live: true,
      groupDebounceMs: 0,
      createSocket: fake.factory,
    });
    active = source;
    const events: LiquidationEvent[] = [];
    source.start((event) => events.push(event), {
      onConnected: () => {
        throw new Error('hook failed');
      },
    });
    const socket = fake.last();
    socket.open();
    socket.serverSend({ type: 'connected', session_id: 'abc' });
    expect(socket.subscribes()).toEqual(['trade/1', 'market_stats/all']);
    socket.serverSend({ type: 'subscribed/trade', channel: 'trade:1', trades: [] });
    socket.serverSend(marketStats(DEFAULT_BOOKS));
    socket.serverSend(update(1, [trade()]));
    expect(events).toHaveLength(1);
    expect(logged(console.error, 'hunter hook failed')).toBe(true);
  });

  it('can be restarted after stop', () => {
    const ctx = track(setup());
    ctx.connect();
    ctx.source.stop();
    const events: LiquidationEvent[] = [];
    ctx.source.start((event) => events.push(event));
    const socket = ctx.connect();
    socket.serverSend(update(1, [trade()]));
    expect(events).toHaveLength(1);
    expect(ctx.events).toEqual([]);
  });
});
