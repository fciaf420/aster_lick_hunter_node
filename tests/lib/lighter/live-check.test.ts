/**
 * @jest-environment node
 */
import {
  LIVE_CHECK_IDS,
  analyzeCandles,
  analyzeFundingRates,
  analyzeLiquidationRows,
  analyzeOrderIndexes,
  analyzeTradeCapture,
  checkLiquidationsAgainstBbo,
  checkMarketInvariants,
  diffMarketIds,
  formatReport,
  inferTimestampUnit,
  main,
  parseArgs,
  runLiveChecks,
  type CapturedFrame,
  type LiveCheckDeps,
  type LiveCheckOptions,
  type LiveSocket,
} from '../../../scripts/lighter-live-check';
import { PROFILES } from '../../../src/lib/exchange/lighter/profiles';
import { FIXTURE_DETAILS } from './fakeLighterExchange';

// The read-only live-check tool (spec §9), run against a scripted fake Lighter: no network.

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const BIG_ORDER_INDEX = '576460752303423611';   // > 2^53: JSON.parse would round it
const TOKEN = '1792289401:12345:7:' + 'f'.repeat(160);

const frame = (message: unknown, at = NOW): CapturedFrame => ({ at, raw: JSON.stringify(message), message });

const liquidationRow = (overrides: Record<string, unknown> = {}) => ({
  trade_id: 1, trade_id_str: '1', type: 'liquidation', market_id: 1, size: '0.1', price: '97000.0',
  ask_account_id: 555, bid_account_id: 777, is_maker_ask: false, taker_position_size_before: '0.1',
  taker_position_sign_changed: false, timestamp: NOW - 500, ...overrides,
});

describe('analysis helpers', () => {
  it('infers timestamp units by magnitude', () => {
    expect(inferTimestampUnit(1792289401)).toEqual({ unit: 's', ms: 1792289401000 });
    expect(inferTimestampUnit(NOW)).toEqual({ unit: 'ms', ms: NOW });
    expect(inferTimestampUnit(NOW * 1000 + 7)).toEqual({ unit: 'us', ms: NOW });
    expect(inferTimestampUnit(String(NOW * 1e6))).toEqual({ unit: 'ns', ms: NOW });
    expect(inferTimestampUnit(0)).toBeNull();
    expect(inferTimestampUnit('x')).toBeNull();
  });

  it('checks the market invariants the integer scaling relies on', () => {
    const fixture = checkMarketInvariants(FIXTURE_DETAILS.order_book_details);
    expect(fixture.checked).toBe(FIXTURE_DETAILS.order_book_details.length);
    expect(fixture.violations).toEqual([]);

    const broken = checkMarketInvariants([
      { symbol: 'X', market_id: 9, market_type: 'perp', size_decimals: 3, price_decimals: 4, multiplier: '1000', quote_multiplier: 1, supported_size_decimals: 2 },
      { symbol: 'SPOT', market_type: 'spot', size_decimals: 9, price_decimals: 9 },
    ]);
    expect(broken.checked).toBe(1);
    expect(broken.violations[0].problems).toEqual([
      'size_decimals + price_decimals = 7', 'multiplier 1000', 'supported_size_decimals 2 != 3',
    ]);
  });

  it('diffs market ids between networks', () => {
    const diff = diffMarketIds(
      [{ symbol: 'BTC', market_id: 1 }, { symbol: 'ETH', market_id: 0 }, { symbol: 'SOL', market_id: 2 }],
      [{ symbol: 'BTC', market_id: 1 }, { symbol: 'ETH', market_id: 5 }, { symbol: 'XRP', market_id: 7 }]
    );
    expect(diff).toEqual({ onlyA: ['SOL'], onlyB: ['XRP'], differentIds: ['ETH 0/5'] });
  });

  it('summarizes a trade-channel capture', () => {
    const report = analyzeTradeCapture([
      { at: NOW, raw: 'null', message: null },
      frame({ type: 'connected', session_id: 's' }),
      frame({ type: 'ping' }, NOW + 1000),
      frame({ type: 'subscribed/trade', channel: 'trade:1', trades: [liquidationRow({ trade_id_str: '9' }), { type: 'trade', trade_id: 8 }] }),
      frame({ type: 'update/trade', channel: 'trade:1', trades: [liquidationRow({ trade_id_str: '10' })], liquidation_trades: [liquidationRow({ trade_id_str: '10' })] }),
      frame({ type: 'ping' }, NOW + 31_000),
      frame({ error: { code: 30003, message: 'invalid channel' } }),
    ]);
    expect(report.nullFrames).toBe(1);
    expect(report.ackTypes).toEqual(['subscribed/trade']);
    expect(report.channelSeparators).toEqual([':']);
    expect(report.snapshotRows['trade:1']).toEqual({ trades: 2, liquidationTrades: 0 });
    expect(report.liquidationRows).toBe(2);           // Both arrays, before dedupe
    expect(report.duplicatedAcrossArrays).toBe(1);
    expect(report.tradeTypes).toEqual({ liquidation: 3, trade: 1 });
    expect(report.serverPingIntervalsMs).toEqual([30_000]);
    expect(report.errors).toHaveLength(1);
    expect(report.topLevelKeys['update/trade']).toEqual(['channel', 'liquidation_trades', 'trades', 'type']);
  });

  it('reads the taker rule inputs and system-account fills from /trades rows', () => {
    const report = analyzeLiquidationRows([
      liquidationRow(),
      liquidationRow({ is_maker_ask: true, bid_account_id: 4444, taker_position_size_before: '-0.5' }),
      liquidationRow({ ask_account_id: 1, taker_position_sign_changed: true }),
      { type: 'trade' },
    ], [1, 4444]);
    expect(report.rows).toBe(3);
    expect(report.isMakerAsk).toEqual({ true: 1, false: 2 });
    expect(report.signChanged).toBe(1);
    expect(report.signedSizeBefore).toBe(true);
    expect(report.takerIsSystemAccount).toBe(2);       // Taker 4444 (LLP) and taker 1
    expect(report.sampleTakerSide[1]).toMatchObject({ isMakerAsk: true, inferredForcedSide: 'BUY' });
  });

  it('cross-checks liquidation prices against the previous best bid / ask', () => {
    const stats = (bid: string, ask: string) => frame({
      type: 'update/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, best_bid_price: bid, best_ask_price: ask } },
    });
    const result = checkLiquidationsAgainstBbo([
      frame({ type: 'update/trade', channel: 'trade:1', trades: [liquidationRow({ trade_id_str: 'a' })] }),   // No BBO yet
      stats('97100', '97110'),
      frame({ type: 'update/trade', channel: 'trade:1', trades: [liquidationRow({ trade_id_str: 'b', price: '97000' })] }),  // SELL <= bid
      frame({ type: 'update/trade', channel: 'trade:1', trades: [liquidationRow({ trade_id_str: 'c', price: '97105' })] }),  // SELL above bid
      frame({ type: 'update/trade', channel: 'trade:1', liquidation_trades: [liquidationRow({ trade_id_str: 'd', is_maker_ask: true, price: '97200' })] }),
    ]);
    expect(result).toEqual({ consistent: 2, inconsistent: 1, noBbo: 1 });
  });

  it('reads candles, order indexes and funding-rate pairs', () => {
    expect(analyzeCandles({ c: [{ t: NOW - 600_000, v: 1 }, { t: NOW - 300_000 }] })).toEqual({
      count: 2, ascending: true, unit: 'ms', missingVolume: 1, firstOpenTime: NOW - 600_000,
    });
    expect(analyzeCandles({ code: 200 }).count).toBe(0);

    const raw = `{"asks":[{"order_index":${BIG_ORDER_INDEX},"order_id":"${BIG_ORDER_INDEX}","price":"1"},` +
      '{"order_index":281474976712345,"order_id":"281474976712345"}],"bids":[{"order_index":281474976712346}]}';
    expect(analyzeOrderIndexes(raw)).toEqual({ orders: 3, maxDigits: 18, aboveTwoPow53: 1, orderIdMatches: 2, orderIdMissing: 1 });

    const funding = analyzeFundingRates({
      funding_rates: [
        { market_id: 172, exchange: 'lighter', symbol: '1000NOT', rate: 0.0001 },
        { market_id: 172, exchange: 'binance', symbol: 'NOTUSDT', rate: 0.0002 },
      ],
    }, ['1000NOT', 'QNT']);
    expect(funding.exchanges).toEqual({ lighter: 1, binance: 1 });
    expect(funding.pairs['1000NOT']).toEqual(['lighter:1000NOT', 'binance:NOTUSDT']);
    expect(funding.pairs.QNT).toEqual([]);
  });

  it('parses arguments', () => {
    const parsed = parseArgs([]);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.options.profile).toBe('mainnet');
    expect([...parsed.options.checks]).toEqual([...LIVE_CHECK_IDS]);

    const custom = parseArgs(['--profile', 'testnet', '--checks', 'q6,Q17', '--duration', '30', '--account', '12', '--compare-profiles', '--json', 'out.json']);
    if ('error' in custom) throw new Error(custom.error);
    expect(custom.options).toMatchObject({ profile: 'testnet', durationMs: 30_000, accountIndex: 12, compareProfiles: true });
    expect([...custom.options.checks]).toEqual(['Q6', 'Q17']);
    expect(custom.jsonPath).toBe('out.json');

    expect(parseArgs(['--profile', 'devnet'])).toEqual({ error: expect.stringContaining('unknown profile') });
    expect(parseArgs(['--checks', 'Q4'])).toEqual({ error: expect.stringContaining('unknown check') });
    expect(parseArgs(['--duration'])).toEqual({ error: '--duration needs a value' });
  });
});

// ===== Full run against a scripted Lighter =====

class ScriptedSocket implements LiveSocket {
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  constructor(readonly url: string) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open');
      this.serverSend({ type: 'connected', session_id: 'scripted' });
    });
  }

  on(event: string, listener: (...args: any[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  send(data: string): void {
    const message = JSON.parse(data) as Record<string, any>;
    this.sent.push(message);
    if (message.type !== 'subscribe') return;
    const [name, id] = String(message.channel).split('/');
    if (name === 'market_stats') {
      this.serverSend({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, best_bid_price: '97100', best_ask_price: '97110' } } });
      // A forced SELL printing below the best bid, once the BBO is known
      if (this.sent.some(m => m.channel === 'trade/1')) {
        this.serverSend({ type: 'update/trade', channel: 'trade:1', trades: [liquidationRow({ trade_id_str: 'live-1', price: '97050' })] });
      }
      return;
    }
    this.serverSend({ type: `subscribed/${name}`, channel: `${name}:${id}`, trades: [] });
  }

  close(): void {
    this.readyState = 3;
  }

  private serverSend(message: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function scriptedDeps() {
  const requests: Array<{ url: string; headers?: Record<string, string> }> = [];
  const sockets: ScriptedSocket[] = [];
  const logs: string[] = [];
  const respond = (url: string): unknown => {
    const parsed = new URL(url);
    const query = Object.fromEntries(parsed.searchParams.entries());
    const host = parsed.host;
    switch (parsed.pathname) {
      case '/':
        return { status: 1, network_id: host.startsWith('mainnet') ? 304 : host.includes('rh.') ? 466324 : 300, timestamp: Math.floor(NOW / 1000) };
      case '/api/v1/orderBookDetails':
        return { code: 200, order_book_details: FIXTURE_DETAILS.order_book_details };
      case '/api/v1/systemConfig':
        return { code: 200, liquidity_pool_index: 4444 };
      case '/api/v1/trades':
        return { code: 200, trades: [liquidationRow(), liquidationRow({ trade_id_str: '2', is_maker_ask: true, ask_account_id: 4444 })] };
      case '/api/v1/recentTrades':
        return { code: 200, trades: [{ ...liquidationRow({ type: 'trade' }), timestamp: NOW - 1000, transaction_time: (NOW - 1000) * 1000 }] };
      case '/api/v1/candles':
        return Number(query.start_timestamp) > 1e11
          ? { code: 200, r: '5m', c: [{ t: NOW - 600_000, o: 1, h: 1, l: 1, c: 1, v: 2 }, { t: NOW - 300_000, o: 1, h: 1, l: 1, c: 1 }] }
          : { code: 200, r: '5m', c: [] };
      case '/api/v1/orderBookOrders':
        return null;   // Raw text below
      case '/api/v1/accountActiveOrders':
        return { code: 200, orders: [{ order_index: 1, order_id: '1', created_at: NOW, updated_at: NOW }] };
      case '/api/v1/funding-rates':
        return { code: 200, funding_rates: [{ market_id: 172, exchange: 'lighter', symbol: '1000NOT', rate: 0 }] };
      case '/api/v1/assetDetails':
        return { code: 200, asset_details: [{ asset_id: 3, symbol: 'USDC' }] };
      default:
        return { code: 404 };
    }
  };
  const deps: LiveCheckDeps = {
    httpGet: async (url, headers) => {
      requests.push({ url, headers });
      if (new URL(url).pathname === '/api/v1/orderBookOrders') {
        return { status: 200, text: `{"code":200,"asks":[{"order_index":${BIG_ORDER_INDEX},"order_id":"${BIG_ORDER_INDEX}"}],"bids":[]}` };
      }
      return { status: 200, text: JSON.stringify(respond(url)) };
    },
    createSocket: (url) => {
      const socket = new ScriptedSocket(url);
      sockets.push(socket);
      return socket;
    },
    now: () => NOW,
    sleep: () => new Promise(resolve => setImmediate(resolve)),
    log: (line) => logs.push(line),
  };
  return { deps, requests, sockets, logs };
}

function options(overrides: Partial<LiveCheckOptions> = {}): LiveCheckOptions {
  return {
    profile: 'mainnet',
    checks: new Set(LIVE_CHECK_IDS),
    durationMs: 5_000,
    market: 'BTC',
    maxSockets: 2,
    compareProfiles: false,
    ...overrides,
  };
}

describe('runLiveChecks', () => {
  it('answers every check with public GETs and WebSocket reads only', async () => {
    const { deps, requests, sockets } = scriptedDeps();
    const results = await runLiveChecks(options(), deps);
    expect(results.map(r => r.id)).toEqual([...LIVE_CHECK_IDS]);
    expect(Object.fromEntries(results.map(r => [r.id, r.status]))).toEqual({
      Q1: 'info', Q2: 'info', Q3: 'ok', Q5: 'info', Q6: 'ok', Q7: 'ok', Q17: 'ok', Q18: 'info', Q19: 'ok', Q23: 'info',
    });

    // Nothing private, nothing signed: no auth header, no tx endpoints
    expect(requests.every(r => !r.headers?.authorization)).toBe(true);
    expect(requests.some(r => /sendTx|nextNonce/.test(r.url))).toBe(false);
    expect(requests.every(r => r.url.startsWith(PROFILES.mainnet.apiUrl) || r.url.startsWith(PROFILES.robinhood.apiUrl))).toBe(true);

    const q1Socket = sockets[0];
    expect(q1Socket.url).toBe('wss://mainnet.zklighter.elliot.ai/stream?readonly=true&encoding=json');
    expect(q1Socket.sent.filter(m => m.type === 'subscribe').map(m => m.channel)).toEqual(['trade/1', 'trade_fe/0', 'market_stats/all']);

    const q2 = results.find(r => r.id === 'Q2')!;
    expect(q2.findings.join('\n')).toContain('counterparty is a system account: 1');
    expect(q2.findings.join('\n')).toContain('BBO cross-check over the Q1 capture: consistent 1, inconsistent 0');

    const q19 = results.find(r => r.id === 'Q19')!;
    expect(q19.findings[0]).toContain('1 above 2^53');

    const report = formatReport(PROFILES.mainnet, results);
    for (const id of LIVE_CHECK_IDS) expect(report).toContain(`] ${id} `);
  });

  it('reads your own orders only with a token, and never prints it', async () => {
    const { deps, requests } = scriptedDeps();
    const results = await runLiveChecks(options({ checks: new Set(['Q3', 'Q19']), accountIndex: 12345, authToken: TOKEN }), deps);
    const privateRequests = requests.filter(r => r.headers?.authorization);
    expect(privateRequests.map(r => new URL(r.url).pathname)).toEqual(['/api/v1/accountActiveOrders', '/api/v1/accountActiveOrders']);
    expect(privateRequests.every(r => r.headers?.authorization === TOKEN)).toBe(true);
    const report = formatReport(PROFILES.mainnet, results);
    expect(report).toContain('Order.created_at');
    expect(report).not.toContain(TOKEN);
    expect(report).not.toContain('f'.repeat(160));
  });

  it('flags an invariant break and compares networks', async () => {
    const { deps } = scriptedDeps();
    const base = deps.httpGet;
    deps.httpGet = async (url, headers) => {
      if (url.startsWith(PROFILES.testnet.apiUrl) && new URL(url).pathname === '/api/v1/orderBookDetails') {
        const broken = FIXTURE_DETAILS.order_book_details.map(m => (m.symbol === 'BTC' ? { ...m, market_id: 9, price_decimals: 2 } : m));
        return { status: 200, text: JSON.stringify({ code: 200, order_book_details: broken }) };
      }
      return base(url, headers);
    };
    const [q6] = await runLiveChecks(options({ checks: new Set(['Q6']), compareProfiles: true }), deps);
    expect(q6.status).toBe('warn');
    const text = q6.findings.join('\n');
    expect(text).toContain('Lighter testnet: 17 perps, 1 break the invariants');
    expect(text).toContain('BTC (market 9): size_decimals + price_decimals = 7');
    expect(text).toContain('mainnet vs testnet: 1 symbols with different ids (e.g. BTC 1/9)');
  });

  it('exits 2 on bad arguments and 0 for --help', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deps } = scriptedDeps();
    expect(await main(['--bogus'], deps)).toBe(2);
    expect(await main(['--help'], deps)).toBe(0);
    errors.mockRestore();
  });
});
