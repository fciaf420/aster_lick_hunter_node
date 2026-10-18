/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LighterHttpClient, type LighterHttpRequest, type LighterHttpResponse } from '../../../src/lib/exchange/lighter/http';
import { getProfile } from '../../../src/lib/exchange/lighter/profiles';
import { Database } from '../../../src/lib/db/database';
import { LiquidationStorage, type CandleRecord, type LiquidationRecord } from '../../../src/lib/services/liquidationStorage';
import {
  LIGHTER_BACKFILL_BOOK_NOTE,
  LIGHTER_BACKFILL_MAX_EMPTY_PAGES,
  LighterBackfillAuthError,
  backfillMarketsFor,
  parseLighterCandle,
  runLighterBackfill,
  type LighterBackfillDeps,
  type LighterBackfillMarket,
  type LighterBackfillOptions,
} from '../../../src/lib/lighterHistory/backfill';
import { LIGHTER_EXPORT_NOT_SUPPORTED, lighterBackfillRetentionProblem, parseLighterBackfillArgs } from '../../../src/lib/lighterHistory/args';
import { lighterBackfillAuthSource } from '../../../src/lib/lighterHistory/auth';
import {
  LighterLiquidationSource,
  type LighterLiquidationDetection,
} from '../../../src/lib/liquidation/lighterLiquidationSource';
import { fakeSocketFactory } from '../lighter/fakeLighterSocket';
import { HISTORY_TEST_TIMEOUT_MS, removeTmpDir } from './tmp';

jest.setTimeout(HISTORY_TEST_TIMEOUT_MS);

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const LLP = 281474976710000;
const FUND = 4242;
const ASK_ORDER = '281474976712345';
const BID_ORDER = '281474976798765';

const BTC: LighterBackfillMarket = { botSymbol: 'BTCUSDT', marketId: 1, lighterSymbol: 'BTC', multiplier: 1, insuranceFundAccountIndex: FUND };
const NOT: LighterBackfillMarket = { botSymbol: 'NOTUSDT', marketId: 77, lighterSymbol: '1000NOT', multiplier: 1000, insuranceFundAccountIndex: null };

let nextTradeId = 700_000_000;

// A Trade row of type liquidation as GET /api/v1/trades returns it (openapi.json Trade)
function trade(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const tradeId = (overrides.trade_id as number | undefined) ?? nextTradeId++;
  return {
    trade_id: tradeId,
    trade_id_str: String(tradeId),
    tx_hash: `tx-${tradeId}`,
    type: 'liquidation',
    market_id: 1,
    size: '0.25',
    price: '97250.0',
    usd_amount: '24312.5',
    ask_id: Number(ASK_ORDER),
    bid_id: Number(BID_ORDER),
    ask_id_str: ASK_ORDER,
    bid_id_str: BID_ORDER,
    ask_account_id: 555,
    bid_account_id: 777,
    is_maker_ask: false,
    timestamp: NOW - MINUTE,
    taker_position_size_before: '100',
    taker_position_sign_changed: false,
    ...overrides,
  };
}

type Handler = (url: URL, request: LighterHttpRequest) => LighterHttpResponse | Promise<LighterHttpResponse>;

function fakeClient(handler: Handler) {
  const requests: Array<{ url: URL; headers?: Record<string, string> }> = [];
  const client = new LighterHttpClient({
    profile: getProfile('mainnet'),
    transport: async (request) => {
      const url = new URL(request.url);
      requests.push({ url, headers: request.headers });
      return handler(url, request);
    },
  });
  return { client, requests };
}

const ok = (data: Record<string, unknown>): LighterHttpResponse => ({ status: 200, data: { code: 200, ...data } });

// Trade pages keyed by cursor ('' = first page)
function tradePages(pages: Record<string, { trades: unknown[]; next?: string }>): Handler {
  return (url) => {
    if (url.pathname !== '/api/v1/trades') throw new Error(`unexpected ${url.pathname}`);
    const page = pages[url.searchParams.get('cursor') ?? ''];
    if (!page) throw new Error(`no page for cursor ${url.searchParams.get('cursor')}`);
    return ok({ trades: page.trades, ...(page.next ? { next_cursor: page.next } : {}) });
  };
}

function memoryStorage() {
  const liquidations: LiquidationRecord[] = [];
  const candles: CandleRecord[] = [];
  const storage: LighterBackfillDeps['storage'] = {
    saveBackfilledLiquidations: jest.fn(async (records: LiquidationRecord[]) => {
      liquidations.push(...records);
      return records.length;
    }),
    saveCandles: jest.fn(async (rows: CandleRecord[]) => {
      candles.push(...rows);
      return rows.length;
    }),
  };
  return { storage, liquidations, candles };
}

function options(overrides: Partial<LighterBackfillOptions> = {}): LighterBackfillOptions {
  return {
    markets: [BTC],
    fromMs: NOW - 120 * MINUTE,
    toMs: NOW,
    liquidityPoolIndex: LLP,
    candles: false,
    delayMs: 0,
    ...overrides,
  };
}

const deps = (client: LighterHttpClient, storage: LighterBackfillDeps['storage'], extra: Partial<LighterBackfillDeps> = {}): LighterBackfillDeps => ({
  client,
  storage,
  sleep: async () => undefined,
  now: () => NOW,
  ...extra,
});

describe('liquidation backfill paging', () => {
  it('pages back with the cursor, groups fills across a page break and stops at the window start', async () => {
    const split = 'tx-split';
    const pages = {
      '': {
        trades: [
          trade({ timestamp: NOW - 1 * MINUTE }),
          trade({ timestamp: NOW - 30 * MINUTE, tx_hash: split, size: '0.1', price: '97000' }),
        ],
        next: 'c1',
      },
      c1: {
        trades: [
          trade({ timestamp: NOW - 30 * MINUTE, tx_hash: split, size: '0.3', price: '96000' }),   // Same liquidation
          trade({ timestamp: NOW - 110 * MINUTE }),
        ],
        next: 'c2',
      },
      c2: {
        trades: [
          trade({ timestamp: NOW - 120 * MINUTE - 30_000 }),   // Before the window, inside the settle margin
          trade({ timestamp: NOW - 125 * MINUTE }),            // Past the window: last page
        ],
        next: 'c3',
      },
    };
    const { client, requests } = fakeClient(tradePages(pages));
    const { storage, liquidations } = memoryStorage();
    const lines: string[] = [];
    const report = await runLighterBackfill(deps(client, storage, { log: (line) => lines.push(line) }), options());

    expect(requests.map((r) => r.url.searchParams.get('cursor'))).toEqual([null, 'c1', 'c2']);
    const query = Object.fromEntries(requests[0].url.searchParams);
    expect(query).toEqual({ type: 'liquidation', market_id: '1', sort_by: 'timestamp', sort_dir: 'desc', limit: '100' });

    expect(liquidations.map((record) => record.eventTime).sort()).toEqual([NOW - 110 * MINUTE, NOW - 30 * MINUTE, NOW - MINUTE]);
    const grouped = liquidations.find((record) => record.metadata?.txHash === split)!;
    expect(grouped).toMatchObject({ venue: 'lighter', source: 'backfill', symbol: 'BTCUSDT', side: 'SELL', quantity: 0.4, price: 96250, skipReason: null, mode: null });
    expect(grouped.externalId).toBe(`1:${split}:${ASK_ORDER}`);
    expect(grouped.metadata?.notes).toContain(LIGHTER_BACKFILL_BOOK_NOTE);
    expect(report.symbols[0]).toMatchObject({ tradePages: 3, fills: 6, liquidations: 3, gatePassed: 3, inserted: 3, reachedWindowStart: true });
    expect(lines.some((line) => line.includes('page 3'))).toBe(true);
  });

  it('stops when the history runs out before the window start', async () => {
    const { client, requests } = fakeClient(tradePages({ '': { trades: [trade()] } }));
    const { storage } = memoryStorage();
    const lines: string[] = [];
    const report = await runLighterBackfill(deps(client, storage, { log: (line) => lines.push(line) }), options());
    expect(requests).toHaveLength(1);
    expect(report.symbols[0]).toMatchObject({ reachedWindowStart: false, inserted: 1 });
    expect(lines.some((line) => line.includes('ends before the window start'))).toBe(true);
  });

  it('stops on an empty page or a cursor that does not move', async () => {
    const empty = fakeClient(tradePages({ '': { trades: [], next: 'c1' } }));
    await runLighterBackfill(deps(empty.client, memoryStorage().storage), options());
    expect(empty.requests).toHaveLength(1);

    const stuck = fakeClient(tradePages({ '': { trades: [trade()], next: 'c1' }, c1: { trades: [trade()], next: 'c1' } }));
    await runLighterBackfill(deps(stuck.client, memoryStorage().storage), options());
    expect(stuck.requests).toHaveLength(2);
  });

  it('resumes safely: a second run stores nothing new', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lighter-backfill-'));
    const db = new Database(path.join(tmp, 'liquidations.db'));
    try {
      const storage = new LiquidationStorage(db);
      const rows = [trade({ timestamp: NOW - 2 * MINUTE }), trade({ timestamp: NOW - 3 * MINUTE }), trade({ timestamp: NOW - 200 * MINUTE })];
      const handler = tradePages({ '': { trades: rows, next: 'c1' } });

      const first = await runLighterBackfill(deps(fakeClient(handler).client, storage), options());
      const second = await runLighterBackfill(deps(fakeClient(handler).client, storage), options());
      expect(first.symbols[0].inserted).toBe(2);
      expect(second.symbols[0]).toMatchObject({ liquidations: 2, inserted: 0 });
      const stored = await storage.getLiquidations({ venue: 'lighter' });
      expect(stored.total).toBe(2);
      expect(stored.liquidations.every((row) => row.source === 'backfill')).toBe(true);
    } finally {
      await db.close();
      removeTmpDir(tmp);
    }
  });

  it('stores nothing in a dry run', async () => {
    const { client } = fakeClient(tradePages({ '': { trades: [trade()] } }));
    const { storage } = memoryStorage();
    const report = await runLighterBackfill(deps(client, storage), options({ dryRun: true }));
    expect(storage.saveBackfilledLiquidations).not.toHaveBeenCalled();
    expect(report.symbols[0]).toMatchObject({ liquidations: 1, inserted: 0 });
  });

  it('drops rows it cannot use and dedupes trade ids across pages', async () => {
    const row = trade();
    const { client } = fakeClient(tradePages({
      '': { trades: [row, trade({ is_maker_ask: 'yes' }), trade({ timestamp: undefined, transaction_time: undefined }), trade({ type: 'trade' })], next: 'c1' },
      c1: { trades: [{ ...row }] },
    }));
    const { storage, liquidations } = memoryStorage();
    const report = await runLighterBackfill(deps(client, storage), options());
    expect(report.symbols[0]).toMatchObject({ fills: 1, droppedFills: 2 });
    expect(liquidations).toHaveLength(1);
  });

  it('converts to bot units with the symbol multiplier', async () => {
    const { client } = fakeClient(tradePages({ '': { trades: [trade({ market_id: 77, size: '2', price: '2.5', usd_amount: '5' })] } }));
    const { storage, liquidations } = memoryStorage();
    await runLighterBackfill(deps(client, storage), options({ markets: [NOT] }));
    expect(liquidations[0]).toMatchObject({ symbol: 'NOTUSDT', quantity: 2000, price: 0.0025, volumeUsdt: 5 });
  });
});

describe('backfill HTTP', () => {
  it('signs an auth token when the server refuses the anonymous request, and keeps using it', async () => {
    const { client, requests } = fakeClient((url, request) => {
      if (!request.headers?.authorization) return { status: 401, data: { code: 20001, message: 'auth required' } };
      return ok({ trades: url.searchParams.get('cursor') ? [] : [trade()], next_cursor: 'c1' });
    });
    const getAuthToken = jest.fn(async () => 'signed-token');
    const report = await runLighterBackfill(deps(client, memoryStorage().storage, { getAuthToken }), options());
    expect(getAuthToken).toHaveBeenCalledTimes(1);
    expect(requests.map((r) => r.headers?.authorization ?? null)).toEqual([null, 'signed-token', 'signed-token']);
    expect(report.authUsed).toBe(true);
  });

  it('fails with a clear message when auth is needed and no key is configured', async () => {
    const { client } = fakeClient(() => ({ status: 401, data: { code: 20001, message: 'auth required' } }));
    const run = runLighterBackfill(deps(client, memoryStorage().storage), options());
    await expect(run).rejects.toBeInstanceOf(LighterBackfillAuthError);
    await expect(runLighterBackfill(deps(client, memoryStorage().storage), options())).rejects.toThrow(/config.venues.lighter|LIGHTER_AUTH_TOKEN/);
  });

  it('reports other refusals as they are, without asking for a token', async () => {
    const { client } = fakeClient(() => ({ status: 403, data: { code: 403, message: 'restricted region' } }));
    const getAuthToken = jest.fn(async () => 'token');
    await expect(runLighterBackfill(deps(client, memoryStorage().storage, { getAuthToken }), options()))
      .rejects.toThrow(/restricted region.*HTTP 403/);
    expect(getAuthToken).not.toHaveBeenCalled();
  });

  it('backs off on 429 and server errors, then continues', async () => {
    let calls = 0;
    const { client } = fakeClient(() => {
      calls++;
      if (calls === 1) return { status: 429, data: 'Too Many Requests' };
      if (calls === 2) return { status: 503, data: 'unavailable' };
      return ok({ trades: [trade()] });
    });
    const sleep = jest.fn(async () => undefined);
    const report = await runLighterBackfill(deps(client, memoryStorage().storage, { sleep }), options());
    expect(sleep.mock.calls.map((call) => (call as unknown[])[0])).toEqual([2000, 4000]);
    expect(report.symbols[0].inserted).toBe(1);
  });

  it('keeps a polite gap between requests', async () => {
    let clock = NOW;
    const sleep = jest.fn(async (ms: number) => {
      clock += ms;
    });
    const { client } = fakeClient(tradePages({ '': { trades: [trade()], next: 'c1' }, c1: { trades: [trade()] } }));
    await runLighterBackfill(deps(client, memoryStorage().storage, { sleep, now: () => clock }), options({ delayMs: 1100 }));
    expect(sleep).toHaveBeenCalledWith(1100);
  });
});

describe('candle backfill', () => {
  it('fetches 1m candles in windows of 500 and stores them in bot units', async () => {
    const fromMs = NOW - 1000 * MINUTE;
    const { client, requests } = fakeClient((url) => {
      expect(url.pathname).toBe('/api/v1/candles');
      const start = Number(url.searchParams.get('start_timestamp'));
      return ok({
        r: '1m',
        c: [
          { t: start - MINUTE, o: 9, h: 9, l: 9, c: 9, v: 1, V: 9, i: 1 },          // Before the window: ignored
          { t: start, o: 2.5, h: 3, l: 2, c: 2.75, V: 0, i: 2 },                     // v omitted (zero)
          { t: start + MINUTE, h: 3, l: 2, c: 2.75, v: 4, i: 3 },                    // No open: unusable
        ],
      });
    });
    const { storage, candles } = memoryStorage();
    const report = await runLighterBackfill(deps(client, storage), options({ markets: [NOT], fromMs, liquidations: false, candles: true }));

    const windows = requests.map((r) => [Number(r.url.searchParams.get('start_timestamp')), Number(r.url.searchParams.get('end_timestamp'))]);
    expect(windows).toEqual([
      [fromMs, fromMs + 500 * MINUTE - 1],
      [fromMs + 500 * MINUTE, fromMs + 1000 * MINUTE - 1],
      [NOW, NOW],
    ]);
    expect(requests.every((r) => r.url.searchParams.get('count_back') === '500' && r.url.searchParams.get('resolution') === '1m'
      && r.url.searchParams.get('market_id') === '77')).toBe(true);
    expect(candles).toHaveLength(3);
    expect(candles[0]).toEqual({
      venue: 'lighter', symbol: 'NOTUSDT', interval: '1m', openTime: fromMs, open: 0.0025, high: 0.003, low: 0.002, close: 0.00275, volume: 0,
    });
    expect(report.symbols[0]).toMatchObject({ candlePages: 3, candles: 3, candlesWritten: 3, tradePages: 0 });
  });

  it('parses candles defensively', () => {
    expect(parseLighterCandle({ t: NOW, o: '1', h: '2', l: '0.5', c: '1.5', v: '10' }, BTC)).toMatchObject({ open: 1, high: 2, volume: 10 });
    expect(parseLighterCandle({ t: 0, o: 1, h: 1, l: 1, c: 1 }, BTC)).toBeNull();
    expect(parseLighterCandle('x', BTC)).toBeNull();
  });
});

describe('side derivation parity with the live feed', () => {
  const START = NOW;
  const TS = START - 500;

  // Each liquidation case the live gates decide on (book check passing: SELL fills at or below the 97250 mid,
  // BUY fills at or above it)
  function parityRows(): Record<string, unknown>[] {
    const row = (overrides: Record<string, unknown>) => trade({ timestamp: TS, transaction_time: TS * 1000 + 7, ...overrides });
    return [
      // Forced BUY of a short taker (signed size: the API reports signed sizes from here on)
      row({ tx_hash: 'tx-buy', is_maker_ask: true, price: '97260', taker_position_size_before: '-5', bid_id_str: '9001' }),
      // Forced SELL sweeping two levels
      row({ tx_hash: 'tx-sell', size: '0.2', price: '97250' }),
      row({ tx_hash: 'tx-sell', size: '0.3', price: '97240' }),
      // LLP takeover: every fill against the liquidity pool
      row({ tx_hash: 'tx-llp', bid_account_id: LLP }),
      // One fill against the insurance fund, one against a user
      row({ tx_hash: 'tx-fund', bid_account_id: FUND, size: '1' }),
      row({ tx_hash: 'tx-fund', size: '0.5', price: '97200' }),
      // Taker flipped: not a liquidation
      row({ tx_hash: 'tx-flip', taker_position_sign_changed: true }),
      // Position fields missing
      row({ tx_hash: 'tx-missing', taker_position_size_before: undefined, taker_position_sign_changed: undefined }),
      // Fill larger than the taker's position
      row({ tx_hash: 'tx-large', size: '5', taker_position_size_before: '1' }),
      // One tx with fills on both sides
      row({ tx_hash: 'tx-both', ask_id_str: '7001' }),
      row({ tx_hash: 'tx-both', is_maker_ask: true, price: '97300', bid_id_str: '7002', taker_position_size_before: '-50' }),
    ];
  }

  async function liveDetections(rows: Record<string, unknown>[]): Promise<LighterLiquidationDetection[]> {
    jest.useFakeTimers({ now: START });
    const fake = fakeSocketFactory();
    const detections: LighterLiquidationDetection[] = [];
    const source = new LighterLiquidationSource({
      profile: 'mainnet',
      resolveSymbol: (marketId) => (marketId === 1 ? { botSymbol: 'BTCUSDT', insuranceFundAccountIndex: FUND } : undefined),
      marketIds: [1],
      live: true,
      groupDebounceMs: 0,
      excludedAccountIndexes: [LLP],
      createSocket: fake.factory,
      onDetection: (detection) => detections.push(detection),
    });
    try {
      source.start(() => undefined, {});
      const socket = fake.last();
      socket.open();
      socket.serverSend({ type: 'connected', session_id: 's1' });
      for (const channel of socket.subscribes()) {
        const [name, id] = channel.split('/');
        socket.serverSend(name === 'market_stats'
          ? { type: 'subscribed/market_stats', channel: 'market_stats:all', timestamp: START - 1000,
            market_stats: { 1: { market_id: 1, best_bid_price: '97249', best_ask_price: '97251' } } }
          : { type: `subscribed/${name}`, channel: `${name}:${id}`, trades: [] });
      }
      socket.serverSend({ type: 'update/trade', channel: 'trade:1', trades: rows });
      return detections;
    } finally {
      source.stop();
      jest.useRealTimers();
    }
  }

  it('reads every liquidation like the live source: side, size, price, LLP / fund exclusion and gates', async () => {
    const rows = parityRows();
    const detections = await liveDetections(rows);
    const { client } = fakeClient(tradePages({ '': { trades: [...rows].reverse() } }));
    const { storage, liquidations } = memoryStorage();
    await runLighterBackfill(deps(client, storage, { now: () => START }), options({ fromMs: START - 60 * MINUTE }));

    expect(detections).toHaveLength(9);
    expect(liquidations).toHaveLength(detections.length);
    const byKey = new Map(liquidations.map((record) => [record.externalId, record]));
    for (const detection of detections) {
      const record = byKey.get(detection.key);
      expect(record).toBeDefined();
      expect(detection.dropReasons.some((reason) => /mid|best bid/.test(reason))).toBe(false);   // Book gate passed live
      expect({
        side: record!.side,
        quantity: record!.quantity,
        price: record!.price,
        eventTime: record!.eventTime,
        skipReason: record!.skipReason,
        excludedTradeIds: [...(record!.metadata?.excludedTradeIds as string[])].sort(),
        tradeIds: [...(record!.metadata?.tradeIds as string[])].sort(),   // The API pages newest first
      }).toEqual({
        side: detection.side,
        quantity: detection.quantity,
        price: detection.averagePrice,
        eventTime: detection.eventTime,
        skipReason: detection.dropReasons.length > 0 ? detection.dropReasons.join('; ') : null,
        excludedTradeIds: [...detection.excludedTradeIds].sort(),
        tradeIds: [...detection.tradeIds].sort(),
      });
    }

    // The cases decided as expected
    const reason = (tx: string) => liquidations.filter((record) => record.metadata?.txHash === tx).map((record) => record.skipReason);
    expect(reason('tx-sell')).toEqual([null]);
    expect(reason('tx-buy')).toEqual([null]);
    expect(reason('tx-fund')).toEqual([null]);
    expect(reason('tx-llp')[0]).toMatch(/LLP/);
    expect(reason('tx-flip')[0]).toMatch(/sign_changed=true/);
    expect(reason('tx-missing')[0]).toMatch(/missing/);
    expect(reason('tx-large')[0]).toMatch(/larger than the taker position/);
    expect(reason('tx-both')).toEqual([expect.stringMatching(/both sides/), expect.stringMatching(/both sides/)]);
    const fund = liquidations.find((record) => record.metadata?.txHash === 'tx-fund')!;
    expect(fund.quantity).toBe(0.5);
  });
});


describe('judging order', () => {
  // A forced BUY of a taker with a positive size_before: the "taker was long" gate only applies once the API has
  // shown signed (negative) sizes, which the live feed learns from the liquidations it has already met
  const unsignedBuy = (timestamp: number) => trade({
    tx_hash: `tx-unsigned-${timestamp}`, is_maker_ask: true, price: '97260', taker_position_size_before: '5', bid_id_str: `u${timestamp}`, timestamp,
  });
  const signedBuy = (timestamp: number) => trade({
    tx_hash: `tx-signed-${timestamp}`, is_maker_ask: true, price: '97260', taker_position_size_before: '-5', bid_id_str: `s${timestamp}`, timestamp,
  });
  const reasonOf = (records: LiquidationRecord[], tx: string) => records.find((record) => record.metadata?.txHash === tx)?.skipReason;

  it('an older liquidation is judged before the signed sizes of a newer one are known', async () => {
    const older = unsignedBuy(NOW - 40 * MINUTE);
    const newer = signedBuy(NOW - 10 * MINUTE);
    // Newest first, as the API pages: the newer liquidation is on page 1
    const { client } = fakeClient(tradePages({ '': { trades: [newer], next: 'c1' }, c1: { trades: [older] } }));
    const { storage, liquidations } = memoryStorage();
    await runLighterBackfill(deps(client, storage), options());
    expect(reasonOf(liquidations, `tx-unsigned-${NOW - 40 * MINUTE}`)).toBeNull();
    expect(reasonOf(liquidations, `tx-signed-${NOW - 10 * MINUTE}`)).toBeNull();
  });

  it('a newer liquidation is held to the signed sizes an older one showed', async () => {
    const older = signedBuy(NOW - 40 * MINUTE);
    const newer = unsignedBuy(NOW - 10 * MINUTE);
    const { client } = fakeClient(tradePages({ '': { trades: [newer, older] } }));
    const { storage, liquidations } = memoryStorage();
    await runLighterBackfill(deps(client, storage), options());
    expect(reasonOf(liquidations, `tx-unsigned-${NOW - 10 * MINUTE}`)).toMatch(/forced BUY but the taker was long/);
    expect(reasonOf(liquidations, `tx-signed-${NOW - 40 * MINUTE}`)).toBeNull();
  });

  it('gives the same verdicts as the live feed processing the same liquidations oldest first', async () => {
    const rows = [unsignedBuy(NOW - 40 * MINUTE), signedBuy(NOW - 30 * MINUTE), unsignedBuy(NOW - 20 * MINUTE)];
    jest.useFakeTimers({ now: NOW });
    const fake = fakeSocketFactory();
    const detections: LighterLiquidationDetection[] = [];
    const source = new LighterLiquidationSource({
      profile: 'mainnet',
      resolveSymbol: (marketId) => (marketId === 1 ? { botSymbol: 'BTCUSDT', insuranceFundAccountIndex: FUND } : undefined),
      marketIds: [1],
      live: true,
      groupDebounceMs: 0,
      excludedAccountIndexes: [LLP],
      maxEventAgeMs: 24 * 60 * MINUTE,
      createSocket: fake.factory,
      onDetection: (detection) => detections.push(detection),
    });
    try {
      source.start(() => undefined, {});
      const socket = fake.last();
      socket.open();
      socket.serverSend({ type: 'connected', session_id: 's1' });
      for (const channel of socket.subscribes()) {
        const [name, id] = channel.split('/');
        socket.serverSend(name === 'market_stats'
          ? { type: 'subscribed/market_stats', channel: 'market_stats:all', timestamp: NOW - 1000,
            market_stats: { 1: { market_id: 1, best_bid_price: '97249', best_ask_price: '97251' } } }
          : { type: `subscribed/${name}`, channel: `${name}:${id}`, trades: [] });
      }
      for (const row of rows) socket.serverSend({ type: 'update/trade', channel: 'trade:1', trades: [row] });
    } finally {
      source.stop();
      jest.useRealTimers();
    }

    const { client } = fakeClient(tradePages({ '': { trades: [...rows].reverse() } }));
    const { storage, liquidations } = memoryStorage();
    await runLighterBackfill(deps(client, storage), options());
    const live = new Map(detections.map((detection) => [detection.key, detection.dropReasons.filter((reason) => !/mid|best bid/.test(reason))]));
    expect(live.size).toBe(3);
    for (const record of liquidations) {
      expect(record.skipReason ?? '').toBe((live.get(record.externalId) ?? ['missing']).join('; '));
    }
  });
});

describe('paging limits', () => {
  // The server ignores type=liquidation: every page is full of ordinary trades
  const ordinaryTrades: Handler = (url) => {
    const page = Number(url.searchParams.get('cursor') ?? 0);
    return ok({ trades: [trade({ type: 'trade', timestamp: NOW - page * MINUTE })], next_cursor: String(page + 1) });
  };

  it('stops after 20 consecutive pages without a liquidation row and says why', async () => {
    expect(LIGHTER_BACKFILL_MAX_EMPTY_PAGES).toBe(20);
    const { client, requests } = fakeClient(ordinaryTrades);
    const { storage } = memoryStorage();
    const lines: string[] = [];
    const report = await runLighterBackfill(deps(client, storage, { log: (line) => lines.push(line) }), options());
    expect(requests).toHaveLength(20);
    expect(report.symbols[0]).toMatchObject({ tradePages: 20, fills: 0, liquidations: 0, reachedWindowStart: false, stopReason: 'no-liquidation-rows' });
    expect(lines.some((line) => /20 consecutive pages without a liquidation row.*ignoring type=liquidation/.test(line))).toBe(true);
  });

  it('a page with a liquidation row restarts the count, and what was found is stored', async () => {
    const { client, requests } = fakeClient((url, request) => {
      const page = Number(url.searchParams.get('cursor') ?? 0);
      if (page === 2) return ok({ trades: [trade({ timestamp: NOW - 5 * MINUTE })], next_cursor: '3' });
      return ordinaryTrades(url, request);
    });
    const { storage, liquidations } = memoryStorage();
    const report = await runLighterBackfill(deps(client, storage), options({ maxEmptyPages: 3 }));
    expect(requests).toHaveLength(6);   // Pages 0 and 1 empty, page 2 has the liquidation, then 3, 4 and 5 empty
    expect(liquidations).toHaveLength(1);
    expect(report.symbols[0]).toMatchObject({ stopReason: 'no-liquidation-rows', inserted: 1 });
  });

  it('stops at the page cap and leaves out the liquidation at the oldest edge, whose fills may continue', async () => {
    const { client, requests } = fakeClient((url) => {
      const page = Number(url.searchParams.get('cursor') ?? 0);
      return ok({ trades: [trade({ timestamp: NOW - (page + 1) * 10 * MINUTE })], next_cursor: String(page + 1) });
    });
    const { storage, liquidations } = memoryStorage();
    const lines: string[] = [];
    const report = await runLighterBackfill(deps(client, storage, { log: (line) => lines.push(line) }), options({ maxPages: 3 }));
    expect(requests).toHaveLength(3);
    expect(report.symbols[0]).toMatchObject({ tradePages: 3, reachedWindowStart: false, stopReason: 'page-cap', liquidations: 2 });
    expect(liquidations.map((record) => record.eventTime).sort()).toEqual([NOW - 20 * MINUTE, NOW - 10 * MINUTE]);
    expect(lines.some((line) => /limit of 3 pages.*--max-pages/.test(line))).toBe(true);
    expect(lines.some((line) => /1 liquidation\(s\) at the oldest edge left out/.test(line))).toBe(true);
  });

  it('reports the window start and the end of the history as the normal ways to stop', async () => {
    const start = fakeClient(tradePages({ '': { trades: [trade({ timestamp: NOW - 200 * MINUTE })], next: 'c1' } }));
    expect((await runLighterBackfill(deps(start.client, memoryStorage().storage), options())).symbols[0].stopReason).toBe('window-start');
    const end = fakeClient(tradePages({ '': { trades: [trade()] } }));
    expect((await runLighterBackfill(deps(end.client, memoryStorage().storage), options())).symbols[0].stopReason).toBe('history-end');
  });

  it('writes the liquidations of a market in chunks of 500 rows', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => trade({ timestamp: NOW - 10 * MINUTE - i * 1000 }));
    const { client } = fakeClient(tradePages({ '': { trades: rows } }));
    const { storage } = memoryStorage();
    await runLighterBackfill(deps(client, storage), options());
    const sizes = (storage.saveBackfilledLiquidations as jest.Mock).mock.calls.map((call) => (call[0] as unknown[]).length);
    expect(sizes).toEqual([500, 500, 200]);
  });
});

describe('auth token source', () => {
  const KEY = 'ab'.repeat(40);
  const config = (profile: string) => ({
    venues: { lighter: { profile, accountIndex: 42, apiKeyIndex: 3, apiKeyPrivateKey: KEY, apiKeyPublicKey: 'cd'.repeat(40) } },
  }) as any;

  it('takes LIGHTER_AUTH_TOKEN as is', async () => {
    const loadSigner = jest.fn();
    const source = lighterBackfillAuthSource(config('mainnet'), getProfile('mainnet'), { env: { LIGHTER_AUTH_TOKEN: ' tok ' }, loadSigner });
    expect(await source!()).toBe('tok');
    expect(loadSigner).not.toHaveBeenCalled();
  });

  it('has no source without a key for the profile being read', () => {
    expect(lighterBackfillAuthSource(config('testnet'), getProfile('mainnet'), { env: {} })).toBeUndefined();
    expect(lighterBackfillAuthSource({ venues: { lighter: { profile: 'mainnet' } } } as any, getProfile('mainnet'), { env: {} })).toBeUndefined();
    expect(lighterBackfillAuthSource({} as any, getProfile('testnet'), { env: {} })).toBeUndefined();
  });

  it('signs tokens with the configured key and wires up nothing else of the signer', async () => {
    // Anything but createAuthToken is missing on this signer: a transaction could not be signed through it
    const signer = { createAuthToken: jest.fn((deadlineSec: number) => `token-until-${deadlineSec}`) };
    const loadSigner = jest.fn(() => signer);
    const source = lighterBackfillAuthSource(config('mainnet'), getProfile('mainnet'), { env: {}, loadSigner });
    expect(loadSigner).not.toHaveBeenCalled();   // Loaded when a token is first asked for
    const token = await source!();
    expect(token).toMatch(/^token-until-\d+$/);
    expect(loadSigner).toHaveBeenCalledWith({ chainId: 304, accountIndex: 42, apiKeyIndex: 3, apiKeyPrivateKey: KEY });
    await source!();
    expect(loadSigner).toHaveBeenCalledTimes(1);
    expect(signer.createAuthToken).toHaveBeenCalledTimes(2);   // A rejected token is replaced, not reused
    expect(signer.createAuthToken.mock.calls[0][0]).toBeGreaterThan(Date.now() / 1000);
  });
});

describe('arguments and markets', () => {
  it('parses the flags with their defaults', () => {
    expect(parseLighterBackfillArgs([])).toMatchObject({ days: 7, candles: true, liquidations: true, dryRun: false, source: 'trades' });
    expect(parseLighterBackfillArgs(['--profile', 'mainnet', '--days=30', '--symbols', 'btcusdt, ETHUSDT,btcusdt', '--no-candles', '--dry-run']))
      .toMatchObject({ profile: 'mainnet', days: 30, symbols: ['BTCUSDT', 'ETHUSDT'], candles: false, dryRun: true });
    expect(parseLighterBackfillArgs(['--candles-only', '--days', '0.5'])).toMatchObject({ liquidations: false, days: 0.5 });
    expect(parseLighterBackfillArgs(['--source', 'export']).source).toBe('export');
    expect(parseLighterBackfillArgs([])).toMatchObject({ force: false });
    expect(parseLighterBackfillArgs([]).maxPages).toBeUndefined();
    expect(parseLighterBackfillArgs(['--force', '--max-pages', '50'])).toMatchObject({ force: true, maxPages: 50 });
    expect(() => parseLighterBackfillArgs(['--max-pages', '0'])).toThrow(/whole number/);
    expect(() => parseLighterBackfillArgs(['--days', '0'])).toThrow(/positive/);
    expect(() => parseLighterBackfillArgs(['--profile', 'drift'])).toThrow(/mainnet or testnet/);
    expect(() => parseLighterBackfillArgs(['--symbols'])).toThrow(/needs a value/);
    expect(() => parseLighterBackfillArgs(['--frobnicate'])).toThrow(/unknown option/);
    expect(() => parseLighterBackfillArgs(['--no-candles', '--candles-only'])).toThrow(/nothing to do/);
    expect(LIGHTER_EXPORT_NOT_SUPPORTED).toMatch(/not supported yet/);
  });

  it('refuses a window longer than the retention unless forced, naming the config field', () => {
    const run = (overrides: Record<string, unknown> = {}) => ({ ...parseLighterBackfillArgs([]), days: 30, ...overrides });
    const problem = lighterBackfillRetentionProblem(run(), 7);
    expect(problem).toMatch(/--days 30 is longer than global\.liquidationRetentionDays \(7\)/);
    expect(problem).toMatch(/at least 30.*--force/);
    expect(lighterBackfillRetentionProblem(run({ days: 7 }), 7)).toBeNull();      // Fits
    expect(lighterBackfillRetentionProblem(run({ days: 0.5 }), 7)).toBeNull();
    expect(lighterBackfillRetentionProblem(run(), 0)).toBeNull();                 // Retention off: keeps everything
    expect(lighterBackfillRetentionProblem(run({ force: true }), 7)).toBeNull();
    expect(lighterBackfillRetentionProblem(run({ dryRun: true }), 7)).toBeNull(); // Stores nothing
    expect(lighterBackfillRetentionProblem(run({ liquidations: false }), 7)).toBeNull();   // The optimizer's candles-only gap fill
  });

  it('maps bot symbols with the bot mapping and says why the others are skipped', () => {
    const entry = {
      botSymbol: 'BTCUSDT', lighterSymbol: 'BTC', marketId: 1, multiplier: 1, explicit: false,
      market: { insuranceFundAccountIndex: FUND } as any,
    };
    const result = backfillMarketsFor(['BTCUSDT', 'ASTERUSDT', 'FOOUSDT'], [entry], [{ botSymbol: 'ASTERUSDT', reason: 'no Lighter market ASTER' }]);
    expect(result.markets).toEqual([BTC]);
    expect(result.missing).toEqual([
      { symbol: 'ASTERUSDT', reason: 'no Lighter market ASTER' },
      { symbol: 'FOOUSDT', reason: 'no Lighter market with that name' },
    ]);
  });
});
