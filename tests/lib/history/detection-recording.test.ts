/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Database } from '../../../src/lib/db/database';
import { LiquidationStorage, SHADOW_MODE_SKIP_REASON } from '../../../src/lib/services/liquidationStorage';
import { LighterLiquidationSource, type LighterLiquidationDetection } from '../../../src/lib/liquidation/lighterLiquidationSource';
import { getLiquidationOrigin } from '../../../src/lib/liquidation/origin';
import type { LiquidationEvent } from '../../../src/lib/types';
import { fakeSocketFactory } from '../lighter/fakeLighterSocket';
import { HISTORY_TEST_TIMEOUT_MS, removeTmpDir } from './tmp';

// The bot wires the Lighter feed's onDetection to liquidationStorage.saveLighterDetection (src/bot/index.ts) and
// the hunter stores the events it receives (hunter.ts): one row per liquidation either way.

jest.setTimeout(HISTORY_TEST_TIMEOUT_MS);

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
let tradeId = 800_000_000;

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = tradeId++;
  return {
    trade_id: id, trade_id_str: String(id), tx_hash: `tx-${id}`, type: 'liquidation', market_id: 1,
    size: '0.25', price: '97240', usd_amount: '24310', ask_id_str: '11', bid_id_str: '22',
    ask_account_id: 555, bid_account_id: 777, is_maker_ask: false, timestamp: NOW - 500,
    taker_position_size_before: '10', taker_position_sign_changed: false,
    ...overrides,
  };
}

async function runFeed(live: boolean, rows: Record<string, unknown>[], storage: LiquidationStorage) {
  const fake = fakeSocketFactory();
  const writes: Promise<unknown>[] = [];
  const events: LiquidationEvent[] = [];
  const detections: LighterLiquidationDetection[] = [];
  const source = new LighterLiquidationSource({
    profile: 'mainnet',
    resolveSymbol: (marketId) => (marketId === 1 ? 'BTCUSDT' : undefined),
    marketIds: [1],
    live,
    groupDebounceMs: 0,
    excludedAccountIndexes: [9999],
    createSocket: fake.factory,
    onDetection: (detection) => {
      detections.push(detection);
      writes.push(storage.saveLighterDetection(detection));
    },
  });
  jest.useFakeTimers({ now: NOW });
  try {
    // The hunter's copy (hunter.ts handleLiquidation -> saveLiquidation)
    source.start((event) => {
      events.push(event);
      writes.push(storage.saveLiquidation(event, event.qty * event.price));
    }, {});
    const socket = fake.last();
    socket.open();
    socket.serverSend({ type: 'connected', session_id: 's' });
    socket.serverSend({ type: 'subscribed/market_stats', channel: 'market_stats:all', timestamp: NOW - 1000,
      market_stats: { 1: { market_id: 1, best_bid_price: '97249', best_ask_price: '97251' } } });
    socket.serverSend({ type: 'subscribed/trade', channel: 'trade:1', trades: [] });
    socket.serverSend({ type: 'update/trade', channel: 'trade:1', trades: rows });
  } finally {
    source.stop();
    jest.useRealTimers();
  }
  await Promise.all(writes);
  return { events, detections };
}

let tmpDir: string;
let db: Database;
let storage: LiquidationStorage;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lighter-detections-'));
  db = new Database(path.join(tmpDir, 'liquidations.db'));
  storage = new LiquidationStorage(db);
});

afterEach(async () => {
  await db.close();
  removeTmpDir(tmpDir);
});

it('records every shadow-mode detection with venue lighter, mode shadow and skip reason "shadow mode"', async () => {
  const { events, detections } = await runFeed(false, [row(), row({ bid_account_id: 9999 })], storage);
  expect(events).toHaveLength(0);
  expect(detections).toHaveLength(2);
  const rows = (await storage.getLiquidations({ venue: 'lighter', includeSkipped: true })).liquidations;
  const byKey = Object.fromEntries(rows.map((item) => [item.external_id, item]));
  expect(byKey[detections[0].key]).toMatchObject({ symbol: 'BTCUSDT', side: 'SELL', source: 'live', mode: 'shadow', skip_reason: SHADOW_MODE_SKIP_REASON });
  expect(byKey[detections[1].key]).toMatchObject({ mode: 'shadow', skip_reason: expect.stringMatching(/LLP/) });
});

it('stores a traded liquidation once although both the hunter and the recorder save it', async () => {
  const { events, detections } = await runFeed(true, [row()], storage);
  expect(events).toHaveLength(1);
  expect(getLiquidationOrigin(events[0])).toEqual({ venue: 'lighter', externalId: detections[0].key, mode: 'live' });
  const { liquidations, total } = await storage.getLiquidations();
  expect(total).toBe(1);
  expect(liquidations[0]).toMatchObject({ venue: 'lighter', external_id: detections[0].key, skip_reason: null, mode: 'live', volume_usdt: 0.25 * 97240 });
});
