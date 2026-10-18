/**
 * @jest-environment node
 */
import type { Config, LiquidationEvent } from '../../../src/lib/types';
import type { LighterLiquidationDetection } from '../../../src/lib/liquidation/lighterLiquidationSource';
import type { LiquidationSource } from '../../../src/lib/liquidation/types';
import type { LighterHttpTransport } from '../../../src/lib/exchange/lighter/http';
import { LighterAdapter } from '../../../src/lib/exchange/lighter/LighterAdapter';
import {
  LighterLiquidationFeed,
  LighterReadOnlyError,
  MarkGuardedLiquidationSource,
  applyLighterConfig,
  configureLighterRuntime,
  createLighterVenueGuard,
  isLighterReadOnlyError,
  lighterCredentialsFrom,
  readLighterSettings,
  resetLighterRuntime,
  setLighterAlertSink,
  stopLighterRuntime,
  type LighterRuntimeAlert,
} from '../../../src/lib/exchange/lighter/runtime';
import { createExchangeAdapter, createLiquidationSource, createPublicExchangeAdapter } from '../../../src/lib/exchange/registry';
import {
  FakeLighterExchange,
  TEST_ACCOUNT,
  TEST_KEY_INDEX,
  TEST_PUBLIC_KEY,
  THROWAWAY_PRIVATE_KEY,
} from './fakeLighterExchange';
import { fakeSocketFactory, type FakeLighterSocket } from './fakeLighterSocket';

// Wiring of the Lighter modules into the bot (registry + runtime), fully offline: a fake REST transport
// (FakeLighterExchange, with the orderBookDetails fixture: BTC market 1 mark 97312.4, ETH market 0 mark 4050)
// and a fake WebSocket. Nothing here loads the native signer.

const START = Date.UTC(2026, 9, 18, 12, 0, 0);
const LLP_ACCOUNT = 4444;

function lighterConfig(overrides: { global?: Partial<Config['global']>; lighter?: Record<string, unknown>; symbols?: string[] } = {}): Config {
  const symbol = { longVolumeThresholdUSDT: 1000, shortVolumeThresholdUSDT: 1000, tradeSize: 0.01, leverage: 5, tpPercent: 2, slPercent: 1 };
  return {
    api: { apiKey: '', secretKey: '' },
    symbols: Object.fromEntries((overrides.symbols ?? ['BTCUSDT', 'ETHUSDT']).map(s => [s, { ...symbol }])),
    global: { riskPercent: 5, paperMode: false, exchange: 'lighter', liquidationSource: 'lighter', ...overrides.global },
    venues: {
      lighter: {
        profile: 'testnet',
        accountIndex: TEST_ACCOUNT,
        apiKeyIndex: TEST_KEY_INDEX,
        apiKeyPrivateKey: THROWAWAY_PRIVATE_KEY,
        apiKeyPublicKey: TEST_PUBLIC_KEY,
        ...overrides.lighter,
      },
    },
  } as Config;
}

let exchange: FakeLighterExchange;
let systemConfigRequests = 0;
let systemConfigFailures = 0;   // Upcoming systemConfig requests answered 503

// The fake exchange plus GET /api/v1/systemConfig (liquidity pool account)
function transportWithSystemConfig(fake: FakeLighterExchange): LighterHttpTransport {
  return async (request) => {
    if (new URL(request.url).pathname === '/api/v1/systemConfig') {
      systemConfigRequests++;
      if (systemConfigFailures > 0) {
        systemConfigFailures--;
        return { status: 503, data: { code: 29500, message: 'service unavailable' } };
      }
      return { status: 200, data: { code: 200, liquidity_pool_index: LLP_ACCOUNT, staking_pool_index: 5 } };
    }
    return fake.transport(request);
  };
}

async function flush(ms = 0): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  jest.useFakeTimers({ now: START });
  exchange = new FakeLighterExchange(() => Date.now());
  systemConfigRequests = 0;
  systemConfigFailures = 0;
  resetLighterRuntime();
  configureLighterRuntime({ transport: transportWithSystemConfig(exchange) });
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  resetLighterRuntime();
  jest.useRealTimers();
  jest.restoreAllMocks();
  delete process.env.LIGHTER_SIGNER_PATH;
});

describe('settings', () => {
  it('defaults to testnet, shadow mode, 1% SL/TP slippage and 60 tx/min', () => {
    expect(readLighterSettings(undefined)).toEqual({
      profile: 'testnet', liquidationsLive: false, sltpSlippagePct: 1, sendTxPerMin: 60, symbolOverrides: undefined,
    });
    expect(readLighterSettings({ venues: { lighter: { profile: 'mainnet', liquidationsLive: true, sltpSlippagePct: 2.5, sendTxPerMin: 30 } } }))
      .toMatchObject({ profile: 'mainnet', liquidationsLive: true, sltpSlippagePct: 2.5, sendTxPerMin: 30 });
  });

  it('binds the credentials to the configured network', () => {
    expect(lighterCredentialsFrom(lighterConfig())).toEqual({
      profile: 'testnet',
      accountIndex: TEST_ACCOUNT,
      apiKeyIndex: TEST_KEY_INDEX,
      apiKeyPrivateKey: THROWAWAY_PRIVATE_KEY,
      apiKeyPublicKey: TEST_PUBLIC_KEY,
    });
    expect(lighterCredentialsFrom({ venues: {} })).toBeNull();
  });
});

describe('adapters from the registry', () => {
  it('builds a read-only Lighter adapter by default: public reads work, nothing can be signed', async () => {
    exchange.setPosition(1, '0.01000', { avg_entry_price: '97000.0' });
    const adapter = createExchangeAdapter(lighterConfig());
    expect(adapter).toBeInstanceOf(LighterAdapter);
    expect(adapter.id).toBe('lighter');
    expect(adapter.capabilities.marginAsset).toBe('USDC');
    expect(adapter.hasCredentials()).toBe(true);

    const positions = await adapter.getPositions();
    expect(positions.map(p => [p.symbol, p.positionAmt])).toEqual([['BTCUSDT', '0.01000']]);
    const [balance] = await adapter.getBalance();
    expect(balance.asset).toBe('USDC');

    for (const attempt of [
      () => adapter.getOpenOrders(),
      () => adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.01 }),
      () => adapter.cancelAllOrders('BTCUSDT'),
      () => adapter.subscribeUserData({ onEvent: () => undefined }),
      () => (adapter as LighterAdapter).verifyStartup(),
    ]) {
      const error = await attempt().then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(LighterReadOnlyError);
      expect(isLighterReadOnlyError(error)).toBe(true);
    }
    expect((await adapter.getOpenOrders().catch((e: Error) => e.message))).toContain('bot process');
    expect(exchange.received).toHaveLength(0);
    expect(exchange.requests.some(r => r.headers?.authorization)).toBe(false);
  });

  it('only the bot (allowSigning) tries to load the native signer', async () => {
    process.env.LIGHTER_SIGNER_PATH = '/nonexistent/lighter-signer.so';
    const adapter = createExchangeAdapter(lighterConfig(), undefined, { allowSigning: true });
    const error = await adapter.getOpenOrders().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(isLighterReadOnlyError(error)).toBe(false);
    expect(exchange.received).toHaveLength(0);
  });

  it('bot shutdown closes the signing adapters (stops background tx settling), not the read-only ones', () => {
    const close = jest.spyOn(LighterAdapter.prototype, 'close');
    try {
      const signing = createExchangeAdapter(lighterConfig(), undefined, { allowSigning: true });
      createExchangeAdapter(lighterConfig());
      stopLighterRuntime();
      expect(close.mock.instances).toEqual([signing]);
      stopLighterRuntime();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });

  it('reads credentials and symbols through getConfig, and shares one market cache per network', async () => {
    let config = lighterConfig({ lighter: { apiKeyPublicKey: undefined } });
    const adapter = createExchangeAdapter(config, undefined, { getConfig: () => config }) as LighterAdapter;
    expect(adapter.hasCredentials()).toBe(false);
    config = lighterConfig({ symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] });
    expect(adapter.hasCredentials()).toBe(true);

    const other = createExchangeAdapter(lighterConfig()) as LighterAdapter;
    expect(other.markets).toBe(adapter.markets);
    await adapter.markets.ensureLoaded();
    applyLighterConfig();
    expect(adapter.markets.entries().map(e => e.botSymbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  });

  it('refuses gated networks', () => {
    expect(() => createExchangeAdapter(lighterConfig({ lighter: { profile: 'robinhood' } }))).toThrow(/disabled/);
    expect(() => createExchangeAdapter(lighterConfig({ lighter: { profile: 'robinhood_testnet' } }))).toThrow(/disabled/);
  });

  it('lists every automatically mapped Lighter market for the symbol picker', async () => {
    const adapter = createPublicExchangeAdapter(lighterConfig({ symbols: [] }));
    expect(adapter.hasCredentials()).toBe(false);
    const info = await adapter.getExchangeInfo();
    const symbols = info.symbols.map((s: { symbol: string }) => s.symbol);
    expect(symbols).toEqual(expect.arrayContaining(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', '1000PEPEUSDT']));
    // Stocks, FX and ambiguous tickers need an explicit override
    expect(symbols).not.toEqual(expect.arrayContaining(['QNTUSDT']));
    expect(symbols).not.toContain('BBUSDT');
    expect(symbols).not.toContain('EURUSDUSDT');
  });
});

// ===== Liquidation feed =====

let nextTradeId = 500_000_000;

function liquidation(marketId: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = nextTradeId++;
  return {
    trade_id: id,
    trade_id_str: String(id),
    tx_hash: `${String(id).padStart(10, '0')}${'c'.repeat(70)}`,
    type: 'liquidation',
    market_id: marketId,
    size: '0.20000',
    price: marketId === 1 ? '97250.0' : '4049.00',
    usd_amount: '19450.0',
    ask_id: 281474976712345,
    bid_id: 281474976798765 + id,
    ask_id_str: '281474976712345',
    bid_id_str: String(281474976798765 + id),
    ask_account_id: 555,
    bid_account_id: 777,
    is_maker_ask: false,
    timestamp: Date.now() - 200,
    taker_position_size_before: '0.20000',
    taker_position_sign_changed: false,
    ...overrides,
  };
}

// Best bid / ask in the market_stats snapshot (stamped before liquidation()'s fills): each mid equals the market's
// fill price in liquidation(), so the side gates' book check passes for a forced SELL there
const BOOKS: Record<string, Record<string, unknown>> = {
  1: { market_id: 1, best_bid_price: '97249', best_ask_price: '97251' },
  0: { market_id: 0, best_bid_price: '4048', best_ask_price: '4050' },
};

function update(marketId: number, trades: unknown[]) {
  return { type: 'update/trade', channel: `trade:${marketId}`, trades };
}

async function startFeed(source: LiquidationSource, fake: ReturnType<typeof fakeSocketFactory>) {
  const events: LiquidationEvent[] = [];
  source.start(event => events.push(event));
  await flush();                       // Market data and systemConfig load
  const socket: FakeLighterSocket = fake.last();
  socket.open();
  socket.serverSend({ type: 'connected', session_id: 'session-1' });
  for (const channel of socket.subscribes()) {
    const [name, id] = channel.split('/');
    socket.serverSend(name === 'market_stats'
      ? { type: 'subscribed/market_stats', channel: 'market_stats:all', timestamp: Date.now() - 1000, market_stats: BOOKS }
      : { type: `subscribed/${name}`, channel: `${name}:${id}`, trades: [] });
  }
  return { events, socket };
}

describe('Lighter liquidation feed', () => {
  it('subscribes the configured markets, stays in shadow mode and goes live on a config reload', async () => {
    let config = lighterConfig();
    const fake = fakeSocketFactory();
    const detections: LighterLiquidationDetection[] = [];
    const source = createLiquidationSource(config, {
      getConfig: () => config,
      createSocket: fake.factory,
      lighterSourceOptions: { groupDebounceMs: 0, onDetection: d => detections.push(d) },
    });
    expect(source).toBeInstanceOf(LighterLiquidationFeed);
    const feed = source as LighterLiquidationFeed;
    expect(feed.guard).toBeNull();     // Trading on Lighter itself: no cross-venue guard

    const { events, socket } = await startFeed(feed, fake);
    expect(socket.url).toBe('wss://testnet.zklighter.elliot.ai/stream?readonly=true&encoding=json');
    expect(socket.subscribes().sort()).toEqual(['market_stats/all', 'trade/0', 'trade/1']);
    expect(systemConfigRequests).toBe(1);

    // Shadow mode: detected and logged, never handed to the hunter
    socket.serverSend(update(1, [liquidation(1)]));
    await flush();
    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({ botSymbol: 'BTCUSDT', side: 'SELL', live: false, emitted: false });
    expect(events).toHaveLength(0);

    config = lighterConfig({ lighter: { liquidationsLive: true } });
    applyLighterConfig();
    expect(feed.live).toBe(true);
    socket.serverSend(update(1, [liquidation(1)]));
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ symbol: 'BTCUSDT', side: 'SELL', quantity: 0.2, price: 97250 });

    // Fills against the liquidity pool (systemConfig.liquidity_pool_index) are never traded
    socket.serverSend(update(1, [liquidation(1, { bid_account_id: LLP_ACCOUNT })]));
    await flush();
    expect(events).toHaveLength(1);
    expect(detections[detections.length - 1].excludedTradeIds).toHaveLength(1);

    feed.stop();
  });

  it('trades nothing until the liquidity pool account is known, retrying systemConfig on a short backoff', async () => {
    const config = lighterConfig({ lighter: { liquidationsLive: true } });
    systemConfigFailures = 1_000;   // Down until further notice
    const fake = fakeSocketFactory();
    const detections: LighterLiquidationDetection[] = [];
    const feed = createLiquidationSource(config, {
      getConfig: () => config,
      createSocket: fake.factory,
      lighterSourceOptions: { groupDebounceMs: 0, onDetection: d => detections.push(d) },
    }) as LighterLiquidationFeed;
    const { events, socket } = await startFeed(feed, fake);
    const atStart = systemConfigRequests;
    expect(atStart).toBeGreaterThanOrEqual(1);

    // LIVE, but an LLP takeover can't be told apart yet: dropped for trading
    socket.serverSend(update(1, [liquidation(1, { bid_account_id: LLP_ACCOUNT })]));
    await flush();
    expect(events).toHaveLength(0);
    expect(detections[0].dropReasons.join(' ')).toContain('liquidity pool account not known yet');

    await flush(2_000);    // Retried after 2 s (still failing), then after 5 s
    expect(systemConfigRequests).toBe(atStart + 1);
    systemConfigFailures = 0;
    await flush(5_000);
    expect(systemConfigRequests).toBe(atStart + 2);

    socket.serverSend(update(1, [liquidation(1, { bid_account_id: LLP_ACCOUNT })]));
    socket.serverSend(update(1, [liquidation(1)]));
    await flush();
    expect(detections[1].excludedTradeIds).toHaveLength(1);
    expect(detections[1].emitted).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ symbol: 'BTCUSDT' });

    await flush(120_000);  // Loaded: no more retries until the 5-minute market refresh
    expect(systemConfigRequests).toBe(atStart + 2);
    feed.stop();
  });

  it('keeps a market at its open interest cap out of trading (spec §8 risk 16)', async () => {
    const config = lighterConfig({ lighter: { liquidationsLive: true } });
    const fake = fakeSocketFactory();
    const detections: LighterLiquidationDetection[] = [];
    const feed = createLiquidationSource(config, {
      getConfig: () => config,
      createSocket: fake.factory,
      lighterSourceOptions: { groupDebounceMs: 0, onDetection: d => detections.push(d) },
    }) as LighterLiquidationFeed;
    const { events, socket } = await startFeed(feed, fake);
    // BTC: open interest 2.5M against a 5M limit (5e12 in millionths) -> capped. ETH: well below its limit.
    socket.serverSend({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: {
      1: { market_id: 1, mark_price: '97300', open_interest: '2500000', open_interest_limit: '5000000000000' },
      0: { market_id: 0, mark_price: '4050', open_interest: '100', open_interest_limit: '5000000000000' },
    } });
    socket.serverSend(update(1, [liquidation(1)]));
    socket.serverSend(update(0, [liquidation(0)]));
    await flush();
    expect(events.map(e => e.symbol)).toEqual(['ETHUSDT']);
    expect(detections.find(d => d.botSymbol === 'BTCUSDT')?.dropReasons.join(' ')).toContain('open interest cap');
    expect(feed.getMarketStats(1)).toMatchObject({ openInterest: 2_500_000, openInterestLimit: 5_000_000_000_000 });
    feed.stop();
  });

  it('follows symbol changes on a config reload', async () => {
    let config = lighterConfig({ symbols: ['BTCUSDT'] });
    const fake = fakeSocketFactory();
    const feed = createLiquidationSource(config, { getConfig: () => config, createSocket: fake.factory }) as LighterLiquidationFeed;
    const { socket } = await startFeed(feed, fake);
    expect(socket.subscribes().sort()).toEqual(['market_stats/all', 'trade/1']);

    config = lighterConfig({ symbols: ['ETHUSDT'] });
    applyLighterConfig();
    expect(socket.subscribes()).toContain('trade/0');
    expect(socket.unsubscribes()).toContain('trade/1');
    feed.stop();
  });

  it('across venues, keeps a symbol out of trading until the 2% mark-ratio guard passes', async () => {
    const config = lighterConfig({ global: { exchange: 'aster', liquidationSource: 'lighter' }, lighter: { liquidationsLive: true } });
    const alerts: LighterRuntimeAlert[] = [];
    setLighterAlertSink(alert => alerts.push(alert));
    const fake = fakeSocketFactory();
    const detections: LighterLiquidationDetection[] = [];
    // ETH on the other venue is quoted x1000 off: the classic wrong-instrument mapping
    const venueMarks = jest.fn(async () => new Map([['BTCUSDT', 97000], ['ETHUSDT', 4.05]]));
    const feed = createLiquidationSource(config, {
      createSocket: fake.factory,
      venueMarkPrices: venueMarks,
      guardWarmupMs: 0,
      lighterSourceOptions: { groupDebounceMs: 0, onDetection: d => detections.push(d) },
    }) as LighterLiquidationFeed;
    expect(feed.guard).not.toBeNull();
    expect(feed.guard!.status('BTCUSDT')).toMatchObject({ ok: false });   // Fails closed before the first check

    const { events, socket } = await startFeed(feed, fake);
    await feed.guard!.run();
    expect(venueMarks).toHaveBeenCalled();
    expect(feed.guard!.status('BTCUSDT')).toEqual({ ok: true });
    expect(feed.guard!.status('ETHUSDT').ok).toBe(false);
    expect(feed.guard!.status('ETHUSDT').reason).toContain('mark ratio');

    socket.serverSend(update(1, [liquidation(1)]));
    socket.serverSend(update(0, [liquidation(0)]));
    await flush();
    expect(events.map(e => e.symbol)).toEqual(['BTCUSDT']);
    const eth = detections.find(d => d.botSymbol === 'ETHUSDT');
    expect(eth?.emitted).toBe(false);
    expect(eth?.dropReasons.join(' ')).toContain('mark-ratio guard');

    // One alert when ETH became blocked, not one per run
    await feed.guard!.run();
    expect(alerts.filter(a => a.source === 'mark-guard').map(a => (a as { symbol: string }).symbol)).toEqual(['ETHUSDT']);
    feed.stop();
  });

  it('keeps the previous guard results when the other venue cannot be read', async () => {
    const config = lighterConfig({ global: { exchange: 'aster', liquidationSource: 'lighter' } });
    let fail = false;
    const feed = createLiquidationSource(config, {
      createSocket: fakeSocketFactory().factory,
      venueMarkPrices: async () => {
        if (fail) throw new Error('premiumIndex 503');
        return new Map([['BTCUSDT', 97300], ['ETHUSDT', 4051]]);
      },
      guardWarmupMs: 0,
    }) as LighterLiquidationFeed;
    await feed.guard!.run();
    expect(feed.guard!.status('ETHUSDT')).toEqual({ ok: true });
    fail = true;
    await feed.guard!.run();
    expect(feed.guard!.status('ETHUSDT')).toEqual({ ok: true });
    expect(feed.guard!.status('SOLUSDT')).toMatchObject({ ok: false });   // Not configured / not mapped
  });
});

describe('other liquidation sources while trading on Lighter', () => {
  class FakeSource implements LiquidationSource {
    readonly id = 'aster' as const;
    emit: ((event: LiquidationEvent) => void) | null = null;
    stopped = 0;
    start(onLiquidation: (event: LiquidationEvent) => void): void {
      this.emit = onLiquidation;
    }
    stop(): void {
      this.stopped++;
    }
  }

  const event = (symbol: string, price: number): LiquidationEvent => ({
    symbol, side: 'SELL', orderType: 'LIMIT', quantity: 1, price, averagePrice: price, orderStatus: 'FILLED',
    orderLastFilledQuantity: 1, orderFilledAccumulatedQuantity: 1, orderTradeTime: 1, eventTime: 1, qty: 1, time: 1,
  });

  it('passes configured symbols only while their marks agree; unconfigured symbols pass through', async () => {
    const config = lighterConfig({ global: { exchange: 'lighter', liquidationSource: 'aster' } });
    const inner = new FakeSource();
    const guard = createLighterVenueGuard(config, {
      otherVenue: 'Aster',
      getOtherMarks: async () => new Map([['BTCUSDT', 97100], ['ETHUSDT', 4.05]]),
      warmupMs: 0,
    });
    const source = new MarkGuardedLiquidationSource(inner, guard, () => config);
    const events: LiquidationEvent[] = [];
    source.start(e => events.push(e));

    inner.emit!(event('BTCUSDT', 97000));   // Before the first check: blocked
    await guard.run();
    inner.emit!(event('BTCUSDT', 97000));
    inner.emit!(event('ETHUSDT', 4.05));    // x1000 apart: blocked
    inner.emit!(event('XYZUSDT', 1));       // Not configured: shown, never traded by the hunter
    expect(events.map(e => e.symbol)).toEqual(['BTCUSDT', 'XYZUSDT']);

    source.stop();
    expect(inner.stopped).toBe(1);
  });
});
