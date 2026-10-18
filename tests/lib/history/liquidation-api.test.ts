/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import type { LiquidationStorage } from '@/lib/services/liquidationStorage';
import { HISTORY_TEST_TIMEOUT_MS, removeTmpDir } from './tmp';

// GET /api/liquidations and /api/liquidations/stats on a real database file: the dashboard must not list Lighter
// detections that were never traded as liquidations.

jest.setTimeout(HISTORY_TEST_TIMEOUT_MS);

const NOW = Date.now();
let tmpDir: string;
let previousPath: string | undefined;
let listRoute: (request: NextRequest) => Promise<Response>;
let statsRoute: (request: NextRequest) => Promise<Response>;
let database: { close(): Promise<void> };

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liquidation-api-'));
  previousPath = process.env.LIQUIDATIONS_DB_PATH;
  process.env.LIQUIDATIONS_DB_PATH = path.join(tmpDir, 'liquidations.db');   // The singleton reads it when first imported
  let storage!: LiquidationStorage;
  jest.isolateModules(() => {   // One registry: the routes, the storage and the seeding below share one database object
    listRoute = require('@/app/api/liquidations/route').GET;
    statsRoute = require('@/app/api/liquidations/stats/route').GET;
    database = require('@/lib/db/database').db;
    storage = require('@/lib/services/liquidationStorage').liquidationStorage;
  });
  const record = (externalId: string, skipReason: string | null, overrides: Record<string, unknown> = {}) => ({
    venue: 'lighter', source: 'live' as const, externalId, symbol: 'BTCUSDT', side: 'SELL' as const, quantity: 1, price: 100, volumeUsdt: 100,
    eventTime: NOW - 60_000, skipReason, mode: 'live' as const, ...overrides,
  });
  await storage.saveBackfilledLiquidations([
    record('traded', null),
    record('shadow', 'shadow mode', { mode: 'shadow' }),
    record('dropped', 'stale: 20000 ms old (limit 10000 ms)'),
    record('backfill-gated', 'side unverified: tx has fills on both sides', { source: 'backfill', mode: null }),
    record('backfill-ok', null, { source: 'backfill', mode: null }),
  ]);
  await storage.saveLiquidation({
    symbol: 'ETHUSDT', side: 'BUY', orderType: 'LIMIT', quantity: 1, price: 50, averagePrice: 50, orderStatus: 'FILLED',
    orderLastFilledQuantity: 1, orderFilledAccumulatedQuantity: 1, orderTradeTime: NOW - 30_000, eventTime: NOW - 30_000, qty: 1, time: NOW - 30_000,
  }, 50);
});

afterAll(async () => {
  await database.close();
  if (previousPath === undefined) delete process.env.LIQUIDATIONS_DB_PATH;
  else process.env.LIQUIDATIONS_DB_PATH = previousPath;
  removeTmpDir(tmpDir);
});

const request = (route: string, query = '') => new NextRequest(`http://localhost/api/liquidations${route}${query}`);
const externalIds = (body: any) => body.data.map((row: any) => row.external_id ?? 'aster').sort();

describe('GET /api/liquidations', () => {
  it('lists the liquidations that were traded, held back by shadow mode or loaded clean, not the dropped detections', async () => {
    const response = await listRoute(request(''));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(externalIds(body)).toEqual(['aster', 'backfill-ok', 'shadow', 'traded']);
    expect(body.pagination.total).toBe(4);
    // Rows say which venue they are from and why they were held back
    const shadow = body.data.find((row: any) => row.external_id === 'shadow');
    expect(shadow).toMatchObject({ venue: 'lighter', skip_reason: 'shadow mode', source: 'live' });
    expect(body.data.find((row: any) => row.external_id === null)).toMatchObject({ venue: 'aster', skip_reason: null });
  });

  it('?includeSkipped=true adds every detection, with the reason it was not traded', async () => {
    const body = await (await listRoute(request('', '?includeSkipped=true'))).json();
    expect(externalIds(body)).toEqual(['aster', 'backfill-gated', 'backfill-ok', 'dropped', 'shadow', 'traded']);
    expect(body.data.find((row: any) => row.external_id === 'dropped').skip_reason).toMatch(/^stale/);
  });

  it('?venue= narrows to one venue', async () => {
    expect(externalIds(await (await listRoute(request('', '?venue=lighter'))).json())).toEqual(['backfill-ok', 'shadow', 'traded']);
    expect(externalIds(await (await listRoute(request('', '?venue=aster'))).json())).toEqual(['aster']);
    const all = await (await listRoute(request('', '?venue=lighter&includeSkipped=true'))).json();
    expect(all.pagination.total).toBe(5);
    expect((await (await listRoute(request('', '?venue=lighter&symbol=ETHUSDT'))).json()).data).toEqual([]);
  });

  it('rejects an unknown venue', async () => {
    const response = await listRoute(request('', "?venue=x'%20OR%201=1"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: expect.stringMatching(/venue must be one of/) });
  });
});

describe('GET /api/liquidations/stats', () => {
  it('counts the same rows the list shows', async () => {
    const response = await statsRoute(request('/stats', '?timeWindow=1h'));
    const { data } = await response.json();
    expect(response.status).toBe(200);
    expect(data.total_count).toBe(4);
    expect(data.total_volume_usdt).toBe(100 * 3 + 50);
    expect(data.symbols).toEqual([
      expect.objectContaining({ symbol: 'BTCUSDT', count: 3 }),
      expect.objectContaining({ symbol: 'ETHUSDT', count: 1 }),
    ]);
  });

  it('takes ?venue= and ?includeSkipped= too', async () => {
    const count = async (query: string) => (await (await statsRoute(request('/stats', `?timeWindow=1h${query}`))).json()).data.total_count;
    expect(await count('&includeSkipped=true')).toBe(6);
    expect(await count('&venue=lighter')).toBe(3);
    expect(await count('&venue=lighter&includeSkipped=true')).toBe(5);
    expect(await count('&venue=aster')).toBe(1);
  });

  it('rejects an unknown venue', async () => {
    expect((await statsRoute(request('/stats', '?venue=nope'))).status).toBe(400);
  });
});
