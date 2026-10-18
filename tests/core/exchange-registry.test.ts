#!/usr/bin/env tsx

import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'net';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  TestSummary,
  logSection,
  log,
  colors,
  createMockConfig,
  assert,
  assertEqual,
  mockExchangeHttp,
  finishTests,
  wait
} from '../utils/test-helpers';
import {
  createExchangeAdapter,
  createLiquidationSource,
  getConfiguredVenue,
  getLiquidationStreamUrl,
  resolveLiquidationSource
} from '../../src/lib/exchange/registry';
import {
  VENUE_CATALOG,
  LIQUIDATION_SOURCE_CATALOG,
  getLiquidationSourceEntry,
  getVenueEntry,
  isSelectableStatus,
} from '../../src/lib/exchange/catalog';
import { VENUE_IDS, LIQUIDATION_SOURCE_IDS } from '../../src/lib/exchange/types';
import type { ExchangeAdapter, UserDataEvent, UserDataHandlers } from '../../src/lib/exchange/types';
import { AsterAdapter } from '../../src/lib/exchange/aster/AsterAdapter';
import { ListenKeyUserDataSubscription } from '../../src/lib/exchange/aster/userDataSubscription';
import { AsterForceOrderSource } from '../../src/lib/liquidation/asterForceOrderSource';
import { LighterLiquidationFeed, MarkGuardedLiquidationSource } from '../../src/lib/exchange/lighter/runtime';
import type { LiquidationSource } from '../../src/lib/liquidation/types';
import type { LiquidationEvent } from '../../src/lib/types';
import { Hunter } from '../../src/lib/bot/hunter';
import { PositionManager } from '../../src/lib/bot/positionManager';
import pnlService from '../../src/lib/services/pnlService';
import { configSchema, lighterCredentialProblems, venueCredentialsSchema } from '../../src/lib/config/types';
import { withoutSecrets } from '../../src/lib/config/redact';
import { migrateConfig } from '../../src/lib/config/migrator';
import { DEFAULT_CONFIG, DEFAULT_CONFIG_VERSION } from '../../src/lib/config/defaults';
import { ConfigLoader } from '../../src/lib/config/configLoader';

async function testVenueSelection() {
  logSection('Testing Venue Selection');
  const summary = new TestSummary();

  await summary.run('Defaults to Aster when no venue is configured', async () => {
    const config = createMockConfig();
    delete (config.global as any).exchange;
    assertEqual(getConfiguredVenue(config), 'aster', 'Default venue should be aster');
    const adapter = createExchangeAdapter(config);
    assertEqual(adapter.id, 'aster', 'Adapter should be the Aster adapter');
    assert(adapter.hasCredentials(), 'Mock config has Aster credentials');
  });

  await summary.run('Reports missing credentials', async () => {
    const config = createMockConfig();
    config.api.apiKey = '';
    config.api.secretKey = '';
    assert(!createExchangeAdapter(config).hasCredentials(), 'Empty keys should report no credentials');
  });

  await summary.run('Refuses venues that are not implemented yet', async () => {
    const comingSoon = VENUE_CATALOG.filter(v => v.status === 'coming_soon');
    assert(comingSoon.length > 0 && !comingSoon.some(v => v.id === 'lighter'), 'Lighter is beta, not coming soon');
    for (const entry of comingSoon) {
      const config = createMockConfig();
      (config.global as any).exchange = entry.id;
      let threw = false;
      try {
        createExchangeAdapter(config);
      } catch (error) {
        threw = error instanceof Error && error.message.includes('not supported yet');
      }
      assert(threw, `${entry.name} should be refused`);
    }
  });

  await summary.run('Refuses liquidation sources that are not implemented yet', async () => {
    const config = createMockConfig();
    assertEqual(resolveLiquidationSource(config), 'aster', 'Default source should be aster');
    for (const entry of LIQUIDATION_SOURCE_CATALOG.filter(s => s.status === 'coming_soon')) {
      (config.global as any).liquidationSource = entry.id;
      let threw = false;
      try {
        resolveLiquidationSource(config);
      } catch {
        threw = true;
      }
      assert(threw, `${entry.name} should be refused`);
    }
  });

  await summary.run('Beta venues and sources are selectable', async () => {
    assertEqual(getVenueEntry('lighter').status, 'beta', 'Lighter venue is beta');
    assertEqual(getLiquidationSourceEntry('lighter').status, 'beta', 'Lighter liquidations are beta');
    assert(isSelectableStatus('available') && isSelectableStatus('beta'), 'available and beta are selectable');
    assert(!isSelectableStatus('coming_soon'), 'coming soon is not selectable');

    const config = createMockConfig();
    (config.global as any).liquidationSource = 'lighter';
    assertEqual(resolveLiquidationSource(config), 'lighter', 'A beta source resolves');
    (config.global as any).exchange = 'lighter';
    assertEqual(createExchangeAdapter(config).id, 'lighter', 'A beta venue builds its adapter');
  });

  await summary.run('Catalog lists every known venue and source', async () => {
    assertEqual(VENUE_CATALOG.map(v => v.id).sort().join(','), [...VENUE_IDS].sort().join(','), 'Venue catalog should match VENUE_IDS');
    assertEqual(
      LIQUIDATION_SOURCE_CATALOG.map(s => s.id).sort().join(','),
      [...LIQUIDATION_SOURCE_IDS].sort().join(','),
      'Source catalog should match LIQUIDATION_SOURCE_IDS'
    );
  });

  summary.print();
}

async function testConfig() {
  logSection('Testing Venue Config');
  const summary = new TestSummary();

  await summary.run('Schema keeps venue fields and rejects unknown venues', async () => {
    const config: any = structuredClone(DEFAULT_CONFIG);
    config.global.exchange = 'aster';
    config.global.liquidationSource = 'aster';
    config.venues = { hyperliquid: { accountAddress: '0xabc' } };
    const parsed = configSchema.parse(config);
    assertEqual(parsed.global.exchange, 'aster', 'exchange should be kept');
    assertEqual(parsed.global.liquidationSource, 'aster', 'liquidationSource should be kept');
    assertEqual(parsed.venues?.hyperliquid?.accountAddress, '0xabc', 'venue credentials should be kept');

    config.global.exchange = 'not-a-venue';
    assert(!configSchema.safeParse(config).success, 'Unknown venue should fail validation');
  });

  await summary.run('Migrates 1.1.0 configs to Aster defaults', async () => {
    const config: any = createMockConfig();
    config.version = '1.1.0';
    delete config.global.exchange;
    delete config.global.liquidationSource;
    const migrated = migrateConfig(config);
    assertEqual(migrated.version, DEFAULT_CONFIG_VERSION, 'Should reach the current version');
    assertEqual(migrated.global.exchange, 'aster', 'Existing configs keep trading on Aster');
    assertEqual(migrated.global.liquidationSource, 'aster', 'Existing configs keep Aster liquidations');
    assertEqual(migrated.venues.lighter.profile, 'testnet', 'Lighter defaults to testnet');
    assertEqual(migrated.venues.lighter.liquidationsLive, false, 'Lighter liquidations start in shadow mode');
    assert(venueCredentialsSchema.safeParse(migrated.venues).success, 'Migrated venues should validate');

    // Older Lighter key names are carried over; set values are never replaced by defaults
    const legacy: any = createMockConfig();
    legacy.version = '1.2.0';
    legacy.venues = { lighter: { apiPrivateKey: 'f'.repeat(80), profile: 'mainnet' } };
    const upgraded = migrateConfig(legacy);
    assertEqual(upgraded.venues.lighter.apiKeyPrivateKey, 'f'.repeat(80), 'apiPrivateKey becomes apiKeyPrivateKey');
    assert(!('apiPrivateKey' in upgraded.venues.lighter), 'The old key name is removed');
    assertEqual(upgraded.venues.lighter.profile, 'mainnet', 'A chosen network is kept');
  });

  await summary.run('Validates venues.lighter field by field', async () => {
    const config: any = structuredClone(DEFAULT_CONFIG);
    config.venues = {
      lighter: {
        profile: 'mainnet', accountIndex: '123', apiKeyIndex: 4, apiKeyPrivateKey: `0x${'a'.repeat(80)}`,
        apiKeyPublicKey: 'b'.repeat(80), liquidationsLive: false, sltpSlippagePct: 1, sendTxPerMin: 60,
      },
    };
    const parsed = configSchema.parse(config);
    assertEqual(parsed.venues?.lighter?.accountIndex, 123, 'Digit strings become numbers');
    assertEqual(parsed.venues?.lighter?.profile, 'mainnet', 'Profile is kept');

    for (const [field, value] of [
      ['profile', 'devnet'], ['accountIndex', 0], ['apiKeyIndex', 255], ['apiKeyPrivateKey', 'xyz'],
      ['apiKeyPublicKey', 'ab'], ['sltpSlippagePct', 50], ['sendTxPerMin', 0],
    ] as const) {
      const bad: any = structuredClone(config);
      bad.venues.lighter[field] = value;
      assert(!configSchema.safeParse(bad).success, `venues.lighter.${field}=${String(value)} should be rejected`);
    }
    const unknownVenue: any = structuredClone(config);
    unknownVenue.venues.dydx = { key: 'x' };
    assert(!configSchema.safeParse(unknownVenue).success, 'Unknown venue keys are rejected');
  });

  await summary.run('Live mode needs complete Lighter credentials when trading on Lighter', async () => {
    const config: any = structuredClone(DEFAULT_CONFIG);
    config.venues = { lighter: { accountIndex: 5, apiKeyIndex: 3 } };
    assertEqual(lighterCredentialProblems(config.venues.lighter).join('; '),
      'API private key is missing; API public key is missing', 'Missing fields are listed, nothing else');
    config.venues.lighter.apiKeyPrivateKey = 'c'.repeat(80);
    config.venues.lighter.apiKeyPublicKey = 'd'.repeat(80);
    assertEqual(lighterCredentialProblems(config.venues.lighter).length, 0, 'Complete credentials pass');
  });

  await summary.run('Config broadcasts never carry credentials', async () => {
    const config: any = createMockConfig();
    config.venues = { lighter: { apiKeyPrivateKey: 'e'.repeat(80) } };
    const view = withoutSecrets(config);
    const text = JSON.stringify(view);
    assert(!text.includes('e'.repeat(80)) && !text.includes(config.api.secretKey), 'Secrets must not appear');
    assert(!('api' in view) && !('venues' in view), 'api and venues are dropped whole');
    assert('symbols' in view && 'global' in view, 'The rest of the config is kept');
  });

  summary.print();
}

async function testAsterAdapterRequests() {
  logSection('Testing Aster Adapter Requests');
  const summary = new TestSummary();

  const requests: string[] = [];
  mockExchangeHttp((config) => {
    const url = new URL(config.url!, 'https://fapi.asterdex.com');
    requests.push(`${config.method?.toUpperCase()} ${url.pathname}`);
    if (url.pathname === '/fapi/v1/positionSide/dual') return { dualSidePosition: true };
    if (url.pathname === '/fapi/v1/premiumIndex') return { symbol: 'BTCUSDT', markPrice: '50000' };
    if (url.pathname === '/fapi/v1/order') return { orderId: 1, symbol: 'BTCUSDT', status: 'NEW' };
    return [];
  });

  await summary.run('Delegates to the existing Aster endpoints', async () => {
    const adapter = createExchangeAdapter(createMockConfig());
    assertEqual(await adapter.getHedgeMode(), true, 'Hedge mode should come from positionSide/dual');
    await adapter.getPositions();
    await adapter.getOpenOrders('BTCUSDT');
    await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.01 });
    await adapter.cancelOrder('BTCUSDT', 1);

    const expected = [
      'GET /fapi/v1/positionSide/dual',
      'GET /fapi/v2/positionRisk',
      'GET /fapi/v1/openOrders',
      'GET /fapi/v1/premiumIndex',
      'POST /fapi/v1/order',
      'DELETE /fapi/v1/order'
    ];
    assertEqual(requests.join('\n'), expected.join('\n'), `Unexpected requests:\n${requests.join('\n')}`);
    log(`  ${requests.length} requests matched`, colors.gray);
  });

  summary.print();
}

// ===== Liquidation sources =====

function expectNotSupported(fn: () => unknown, label: string) {
  let message = '';
  try {
    fn();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes('not supported yet'), `${label} should be refused as not supported yet (got "${message}")`);
}

// Records how the hunter drives a source and lets the test push liquidations into it
class FakeLiquidationSource implements LiquidationSource {
  readonly id = 'aster' as const;
  starts = 0;
  stops = 0;
  emit: ((event: LiquidationEvent) => void) | null = null;

  start(onLiquidation: (event: LiquidationEvent) => void): void {
    this.starts++;
    this.emit = onLiquidation;
  }

  stop(): void {
    this.stops++;
  }
}

async function testLiquidationSources() {
  logSection('Testing Liquidation Sources');
  const summary = new TestSummary();

  await summary.run('Builds the Aster forceOrder source for the configured source', async () => {
    const config = createMockConfig();
    delete (config.global as any).liquidationSource;
    const source = createLiquidationSource(config);
    assert(source instanceof AsterForceOrderSource, 'Default source should be the Aster forceOrder stream');
    assertEqual(source.id, 'aster', 'Source id');

    (config.global as any).liquidationSource = 'aster';
    assertEqual(createLiquidationSource(config, { getConfig: () => config }).id, 'aster', 'Explicit aster source');
    assertEqual(getLiquidationStreamUrl('aster'), 'wss://fstream.asterdex.com/ws/!forceOrder@arr', 'Aster stream URL');
  });

  await summary.run('Lists Lighter as a liquidation source (beta)', async () => {
    assert((LIQUIDATION_SOURCE_IDS as readonly string[]).includes('lighter'), 'lighter should be a liquidation source id');
    const entry = getLiquidationSourceEntry('lighter');
    assertEqual(entry.id, 'lighter', 'Catalog entry id');
    assertEqual(entry.status, 'beta', 'Lighter liquidations are wired as beta');
  });

  await summary.run('createLiquidationSource refuses sources that are not implemented yet', async () => {
    const pending = LIQUIDATION_SOURCE_CATALOG.filter(s => s.status === 'coming_soon');
    assert(!pending.some(s => s.id === 'lighter'), 'lighter is no longer pending');
    assert(pending.some(s => s.id === 'binance'), 'binance is still pending');
    for (const entry of pending) {
      const config = createMockConfig();
      (config.global as any).liquidationSource = entry.id;
      expectNotSupported(() => createLiquidationSource(config), entry.name);
    }
  });

  await summary.run('Hunter feeds liquidations from an injected source and stops it', async () => {
    const config = createMockConfig();
    const source = new FakeLiquidationSource();
    const hunter = new Hunter(config, false, createExchangeAdapter(config), source);

    const detected: any[] = [];
    hunter.on('liquidationDetected', (event) => detected.push(event));

    (hunter as any).connectWebSocket();
    assertEqual(source.starts, 1, 'Source should be started once');

    // A symbol that is not configured: the hunter reports it but never trades
    source.emit!({
      symbol: 'XYZUSDT', side: 'SELL', orderType: 'LIMIT', quantity: 2, price: 10, averagePrice: 10,
      orderStatus: 'FILLED', orderLastFilledQuantity: 2, orderFilledAccumulatedQuantity: 2,
      orderTradeTime: 1, eventTime: 1, qty: 2, time: 1,
    });
    await wait(10);
    assertEqual(detected.length, 1, 'Liquidation should reach the hunter');
    assertEqual(detected[0].symbol, 'XYZUSDT', 'Symbol should pass through');
    assertEqual(detected[0].side, 'SELL', 'Side should pass through');

    hunter.stop();
    assertEqual(source.stops, 1, 'Stopping the hunter should stop the source');
  });

  await summary.run('Hunter builds an unsupported source only when the stream connects', async () => {
    const config = createMockConfig();
    (config.global as any).liquidationSource = 'binance';
    const hunter = new Hunter(config, false, createExchangeAdapter(createMockConfig()));
    expectNotSupported(() => (hunter as any).connectWebSocket(), 'Binance liquidations');
    hunter.stop();
  });

  await summary.run('Builds the Lighter feed (shadow mode by default) for the lighter source', async () => {
    const config: any = createMockConfig();
    config.global.liquidationSource = 'lighter';
    const feed = createLiquidationSource(config);
    assert(feed instanceof LighterLiquidationFeed, 'lighter source should be the Lighter feed');
    assertEqual((feed as LighterLiquidationFeed).live, false, 'Shadow mode unless liquidationsLive is set');
    assertEqual((feed as LighterLiquidationFeed).profile.name, 'testnet', 'Testnet by default');
    assert((feed as LighterLiquidationFeed).guard !== null, 'Trading on Aster: the feed runs behind the mark-ratio guard');
    assertEqual(getLiquidationStreamUrl('lighter', config), 'wss://testnet.zklighter.elliot.ai/stream?readonly=true&encoding=json',
      'Lighter stream URL comes from the profile table');

    config.global.exchange = 'lighter';
    config.venues = { lighter: { profile: 'mainnet', liquidationsLive: true } };
    const sameVenue = createLiquidationSource(config) as LighterLiquidationFeed;
    assertEqual(sameVenue.live, true, 'liquidationsLive switches the feed live');
    assertEqual(sameVenue.profile.name, 'mainnet', 'Profile comes from venues.lighter.profile');
    assertEqual(sameVenue.guard, null, 'No mark-ratio guard when source and venue are both Lighter');
  });

  await summary.run('Aster liquidations feeding a Lighter venue run behind the mark-ratio guard', async () => {
    const config: any = createMockConfig();
    config.global.exchange = 'lighter';
    const source = createLiquidationSource(config);
    assert(source instanceof MarkGuardedLiquidationSource, 'Aster source is wrapped when trading on Lighter');
    assertEqual(source.id, 'aster', 'The wrapper keeps the inner source id');

    config.global.exchange = 'aster';
    assert(createLiquidationSource(config) instanceof AsterForceOrderSource, 'Aster on Aster stays unwrapped');
  });

  await summary.run('Gated Lighter networks are refused', async () => {
    const config: any = createMockConfig();
    config.global.exchange = 'lighter';
    config.venues = { lighter: { profile: 'robinhood' } };
    let message = '';
    try {
      createExchangeAdapter(config);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes('disabled'), `Robinhood should be refused (got "${message}")`);
    config.global.exchange = 'aster';
    config.global.liquidationSource = 'lighter';
    message = '';
    try {
      createLiquidationSource(config);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes('disabled'), `Robinhood liquidations should be refused (got "${message}")`);
  });

  summary.print();
}

// ===== User data stream =====

async function startStreamServer(): Promise<{ server: WebSocketServer; port: number; clients: WebSocket[]; paths: string[] }> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const clients: WebSocket[] = [];
  const paths: string[] = [];
  server.on('connection', (socket, request) => {
    clients.push(socket);
    paths.push(request.url || '');
  });
  return { server, port: (server.address() as AddressInfo).port, clients, paths };
}

async function stopStreamServer(server: WebSocketServer) {
  server.clients.forEach(client => client.terminate());
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 2000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await wait(5);
  }
}

const ACCOUNT_UPDATE_FRAME = {
  e: 'ACCOUNT_UPDATE', E: 1700000000000, T: 1700000000000,
  a: { m: 'ORDER', B: [{ a: 'USDT', wb: '1000', cw: '1000', bc: '0' }], P: [] },
};
const ORDER_TRADE_UPDATE_FRAME = {
  e: 'ORDER_TRADE_UPDATE', E: 1700000000001, T: 1700000000001,
  o: { s: 'BTCUSDT', S: 'SELL', o: 'STOP_MARKET', q: '0.005', X: 'NEW', i: 1001, R: true },
};
const ACCOUNT_CONFIG_UPDATE_FRAME = { e: 'ACCOUNT_CONFIG_UPDATE', E: 1700000000002, ac: { s: 'BTCUSDT', l: 5 } };

async function testUserDataStream() {
  logSection('Testing User Data Stream');
  const summary = new TestSummary();

  await summary.run('Aster adapter runs the listenKey stream (POST, events, DELETE)', async () => {
    const { server, port, clients, paths } = await startStreamServer();
    const requests: string[] = [];
    mockExchangeHttp((config) => {
      const url = new URL(config.url!, 'https://fapi.asterdex.com');
      const headers = (config.headers || {}) as Record<string, unknown>;
      requests.push(`${config.method?.toUpperCase()} ${url.host}${url.pathname} key=${headers['X-MBX-APIKEY']}`);
      if (url.pathname === '/fapi/v1/listenKey' && config.method === 'post') return { listenKey: 'test-listen-key' };
      return {};
    });

    // Real adapter and requests; only the stream host is swapped for a local server
    class LocalStreamAsterAdapter extends AsterAdapter {
      getUserDataStreamUrl(listenKey: string): string {
        return `ws://127.0.0.1:${port}/ws/${listenKey}`;
      }
    }

    try {
      const adapter = new LocalStreamAsterAdapter(createMockConfig().api);
      const events: UserDataEvent[] = [];
      let connected = 0;
      let disconnected = 0;
      const subscription = await adapter.subscribeUserData({
        onEvent: (event) => events.push(event),
        onConnected: () => connected++,
        onDisconnected: () => disconnected++,
      });

      await waitFor(() => connected === 1 && clients.length === 1, 'the stream to connect');
      assertEqual(paths[0], '/ws/test-listen-key', 'Stream should use the listenKey from the POST');

      for (const frame of [ACCOUNT_UPDATE_FRAME, ORDER_TRADE_UPDATE_FRAME, { e: 'listenKeyExpired', E: 1 }, ACCOUNT_CONFIG_UPDATE_FRAME]) {
        clients[0].send(JSON.stringify(frame));
      }
      clients[0].send('not json');
      await waitFor(() => events.length === 3, 'three user data events');
      await wait(20);
      assertEqual(events.map(e => e.e).join(','), 'ACCOUNT_UPDATE,ORDER_TRADE_UPDATE,ACCOUNT_CONFIG_UPDATE',
        'Only the three Binance user data events reach the bot, in order');
      assertEqual(JSON.stringify(events[1]), JSON.stringify(ORDER_TRADE_UPDATE_FRAME), 'Events pass through unchanged');

      await subscription.close();
      await waitFor(() => disconnected === 1, 'the stream to close');
      await wait(50);
      assertEqual(clients.length, 1, 'A closed subscription must not reconnect');
      assertEqual(requests.join('\n'), [
        'POST fapi.asterdex.com/fapi/v1/listenKey key=test-api-key',
        'DELETE fapi.asterdex.com/fapi/v1/listenKey key=test-api-key',
      ].join('\n'), `Unexpected requests:\n${requests.join('\n')}`);
    } finally {
      await stopStreamServer(server);
    }
  });

  await summary.run('listenKey subscription keeps alive, re-syncs and reconnects after a drop', async () => {
    const { server, port, clients, paths } = await startStreamServer();
    const calls: string[] = [];
    let keys = 0;
    let connected = 0;
    let disconnected = 0;

    const handlers: UserDataHandlers = {
      onEvent: () => undefined,
      onConnected: () => connected++,
      onDisconnected: () => disconnected++,
      beforeReconnect: async () => {
        calls.push('resync');
      },
    };
    const subscription = new ListenKeyUserDataSubscription({
      createUserDataStream: async () => {
        calls.push('create');
        return `key${keys++}`;
      },
      keepAliveUserDataStream: async () => {
        calls.push('keepalive');
      },
      closeUserDataStream: async () => {
        calls.push('close');
      },
      getUserDataStreamUrl: (listenKey) => `ws://127.0.0.1:${port}/ws/${listenKey}`,
    }, handlers, { keepaliveIntervalMs: 20, reconnectDelayMs: 30 });

    try {
      await subscription.open();
      await waitFor(() => connected === 1, 'the first connection');
      await waitFor(() => calls.includes('keepalive'), 'a keepalive');

      clients[0].close(); // Server drops the stream
      await waitFor(() => connected === 2 && clients.length === 2, 'the reconnect');
      assertEqual(disconnected, 1, 'Drop should be reported once');
      assertEqual(paths.join(','), '/ws/key0,/ws/key1', 'Reconnect should use a fresh listenKey');
      const resync = calls.indexOf('resync');
      const secondCreate = calls.indexOf('create', 1);
      assert(resync > calls.indexOf('keepalive') && resync < secondCreate,
        `Re-sync must run after the drop and before the new listenKey (calls: ${calls.join(',')})`);

      await subscription.close();
      const callsAtClose = calls.length;
      await wait(100);
      assertEqual(calls[callsAtClose - 1], 'close', 'close() should DELETE the listenKey');
      assertEqual(calls.length, callsAtClose, 'No keepalive or reconnect after close()');
      assertEqual(clients.length, 2, 'No reconnect after close()');
    } finally {
      await subscription.close();
      await stopStreamServer(server);
    }
  });

  await summary.run('PositionManager runs its user stream through subscribeUserData', async () => {
    let handlers: UserDataHandlers | null = null;
    let closed = 0;
    let positionFetches = 0;
    const fakeExchange = {
      id: 'lighter',
      capabilities: { marginAsset: 'USDC' },
      hasCredentials: () => true,
      getExchangeInfo: async () => ({ symbols: [] }),
      getPositions: async () => {
        positionFetches++;
        return [];
      },
      getOpenOrders: async () => [],
      subscribeUserData: async (h: UserDataHandlers) => {
        handlers = h;
        return { close: async () => { closed++; } };
      },
    } as unknown as ExchangeAdapter;

    const config = createMockConfig();
    config.global.paperMode = false;
    const manager = new PositionManager(config, false, fakeExchange);
    await manager.start();
    assert(handlers !== null, 'start() should subscribe to the user data stream');
    assertEqual(positionFetches, 1, 'start() syncs once before subscribing');

    // Margin balance is read from the venue's margin asset (USDC here), not a hard-coded USDT
    handlers!.onEvent({
      e: 'ACCOUNT_UPDATE', E: 1700000000000,
      a: {
        m: 'ORDER',
        B: [{ a: 'USDT', wb: '5', bc: '0' }, { a: 'USDC', wb: '1234.5', bc: '0' }],
        P: [{ s: 'XYZUSDT', pa: '2', ep: '10', up: '0.5', mt: 'cross', ps: 'BOTH' }],
      },
    });
    assertEqual(pnlService.getSessionPnL().currentBalance, 1234.5, 'PnL balance should come from the USDC entry');
    assertEqual((manager as any).currentPositions.size, 1, 'ACCOUNT_UPDATE should update positions');

    await handlers!.beforeReconnect!();
    assertEqual(positionFetches, 2, 'beforeReconnect should re-sync with the exchange');

    await manager.stop();
    assertEqual(closed, 1, 'stop() should close the subscription');
  });

  summary.print();
}

// ===== Web UI routes with a Lighter venue =====

async function testLighterRoutes() {
  logSection('Testing Lighter in the Web UI Routes');
  const summary = new TestSummary();

  await summary.run('Close route refuses live Lighter closes (409) without contacting the exchange', async () => {
    const requests: string[] = [];
    mockExchangeHttp((config) => {
      requests.push(`${config.method?.toUpperCase()} ${config.url}`);
      throw new Error('no exchange request expected');
    });

    // Temp config so the real config.user.json is never read
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-lighter-'));
    const loader = ConfigLoader.getInstance() as any;
    const originalPaths = {
      userConfigPath: loader.userConfigPath,
      legacyConfigPath: loader.legacyConfigPath,
      defaultConfigPath: loader.defaultConfigPath,
      config: loader.config,
    };
    loader.userConfigPath = path.join(tmpDir, 'config.user.json');
    loader.legacyConfigPath = path.join(tmpDir, 'config.json');
    loader.defaultConfigPath = path.join(tmpDir, 'config.default.json');

    const config: any = structuredClone(DEFAULT_CONFIG);
    config.global.paperMode = false;
    config.global.exchange = 'lighter';
    config.venues = {
      lighter: { profile: 'testnet', accountIndex: 12345, apiKeyIndex: 7, apiKeyPrivateKey: 'a'.repeat(80), apiKeyPublicKey: 'b'.repeat(80) },
    };
    await fs.writeFile(loader.userConfigPath, JSON.stringify(config));

    try {
      const { NextRequest } = await import('next/server');
      const { POST } = await import('../../src/app/api/positions/[symbol]/[side]/close/route');
      const request = new NextRequest('http://localhost/api/positions/BTCUSDT/LONG/close', { method: 'POST' });
      const response = await POST(request, { params: Promise.resolve({ symbol: 'BTCUSDT', side: 'LONG' }) });
      const body = await response.json();
      assertEqual(response.status, 409, 'Live Lighter close should be refused with 409');
      assertEqual(body.success, false, 'success flag');
      assert(String(body.error).includes('bot') && String(body.error).includes('Lighter'),
        `The error should tell the user where to close it (got "${body.error}")`);
      assertEqual(requests.length, 0, `No exchange request expected, got:\n${requests.join('\n')}`);
    } finally {
      Object.assign(loader, originalPaths);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  summary.print();
}

async function main() {
  log('🧪 EXCHANGE REGISTRY TEST SUITE', colors.cyan + colors.bold);
  log('='.repeat(60), colors.cyan);

  await testVenueSelection();
  await testConfig();
  await testAsterAdapterRequests();
  await testLiquidationSources();
  await testUserDataStream();
  await testLighterRoutes();

  logSection('✨ All Exchange Registry Tests Complete');
  finishTests();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
