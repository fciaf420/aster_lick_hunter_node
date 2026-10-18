#!/usr/bin/env tsx

// PositionManager and Hunter driving the Lighter adapter end to end, fully offline: FakeLighterExchange (mocked
// REST that executes signed txs), FakeLighterSigner and an injected user stream that delivers the Binance-format
// events the real account stream would. Plus the Aster request sequence of a paper-mode toggle.

import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import { PositionManager } from '../../src/lib/bot/positionManager';
import { Hunter } from '../../src/lib/bot/hunter';
import { AsterAdapter } from '../../src/lib/exchange/aster/AsterAdapter';
import { LighterAdapter } from '../../src/lib/exchange/lighter/LighterAdapter';
import { LighterMarketCache } from '../../src/lib/exchange/lighter/markets';
import type { UserDataEvent, UserDataHandlers } from '../../src/lib/exchange/types';
import type { LiquidationSource } from '../../src/lib/liquidation/types';
import type { Config } from '../../src/lib/types';
import {
  FakeLighterExchange,
  FakeLighterSigner,
  TEST_ACCOUNT,
  TEST_KEY_INDEX,
  TEST_PUBLIC_KEY,
  THROWAWAY_PRIVATE_KEY,
  recordingSigner,
} from '../lib/lighter/fakeLighterExchange';
import {
  TestSummary,
  logSection,
  assert,
  assertEqual,
  createMockConfig,
  mockExchangeHttp,
  finishTests,
  wait,
} from '../utils/test-helpers';

const ETH = 0;   // Fixture market: ETH, size decimals 4, price decimals 2, mark 4050

const CREDENTIALS = {
  profile: 'testnet',
  accountIndex: TEST_ACCOUNT,
  apiKeyIndex: TEST_KEY_INDEX,
  apiKeyPrivateKey: THROWAWAY_PRIVATE_KEY,
  apiKeyPublicKey: TEST_PUBLIC_KEY,
};

function lighterConfig(paperMode: boolean): Config {
  return {
    api: { apiKey: '', secretKey: '' },
    symbols: {
      ETHUSDT: {
        longVolumeThresholdUSDT: 1000, shortVolumeThresholdUSDT: 1000, tradeSize: 0.5, leverage: 5,
        tpPercent: 3, slPercent: 2, priceOffsetBps: 2, maxSlippageBps: 50, orderType: 'LIMIT',
      },
    },
    global: { paperMode, riskPercent: 5, maxOpenPositions: 5, exchange: 'lighter', liquidationSource: 'lighter', positionMode: 'ONE_WAY' },
    venues: { lighter: { profile: 'testnet' } },
  } as unknown as Config;
}

class FakeSource implements LiquidationSource {
  readonly id = 'lighter' as const;
  starts = 0;
  stops = 0;
  start(): void {
    this.starts++;
  }
  stop(): void {
    this.stops++;
  }
}

function lighterHarness(options: { credentials?: boolean } = {}) {
  const exchange = new FakeLighterExchange();
  let credentials: Record<string, unknown> | null = options.credentials ? CREDENTIALS : null;
  const symbols = Object.keys(lighterConfig(true).symbols);
  const markets = new LighterMarketCache({
    profile: 'testnet',
    symbols: () => ({ allowlist: symbols }),
    httpGet: async url => (await exchange.transport({ method: 'GET', url, timeoutMs: 1000 })).data,
  });
  const signer = recordingSigner(new FakeLighterSigner(), exchange);
  const stream = { subscribes: 0, closes: 0, handlers: null as UserDataHandlers | null };
  const adapter = new LighterAdapter({
    profile: 'testnet',
    credentials: () => credentials,
    markets,
    transport: exchange.transport,
    signer,
    journal: 'memory',
    sleep: ms => wait(Math.min(ms, 10)),
    // Stands in for the account stream: hands the bot's handlers to the test
    createUserStream: async (_deps, handlers) => {
      stream.subscribes++;
      stream.handlers = handlers;
      setTimeout(() => handlers.onConnected?.(), 0);
      return { close: async () => { stream.closes++; } };
    },
  });
  const emit = (event: UserDataEvent) => {
    assert(stream.handlers !== null, 'the user stream should be open');
    stream.handlers!.onEvent(event);
  };
  return {
    exchange,
    adapter,
    stream,
    emit,
    setCredentials: (value: Record<string, unknown> | null) => { credentials = value; },
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await wait(20);
  }
}

function accountUpdate(positionAmt: string, entryPrice: string): UserDataEvent {
  const now = Date.now();
  return {
    e: 'ACCOUNT_UPDATE',
    E: now,
    T: now,
    a: {
      m: 'ORDER',
      B: [{ a: 'USDC', wb: '1000', cw: '1000', bc: '0' }],
      P: [{ s: 'ETHUSDT', pa: positionAmt, ep: entryPrice, up: '0', mt: 'cross', iw: '0', ps: 'BOTH' }],
    },
  };
}

async function testPaperToLiveOnLighter() {
  logSection('Lighter: paper -> live switch');
  const summary = new TestSummary();

  await summary.run('PositionManager opens the user stream and Hunter starts the live feed', async () => {
    const h = lighterHarness();
    const paper = lighterConfig(true);
    const pm = new PositionManager(paper, false, h.adapter);
    const source = new FakeSource();
    const hunter = new Hunter(paper, false, h.adapter, source);
    hunter.setPositionTracker(pm);
    try {
      await pm.start();
      await hunter.start();
      assertEqual(h.stream.subscribes, 0, 'Paper mode without credentials: no user stream');
      assertEqual(source.starts, 0, 'Paper mode without credentials: simulated liquidations, no live feed');

      // The config page / onboarding saves the Lighter keys together with paperMode=false; the bot hot-reloads
      h.setCredentials(CREDENTIALS);
      const live = lighterConfig(false);
      hunter.updateConfig(live);
      pm.updateConfig(live);
      assertEqual(source.starts, 1, 'Hunter goes live at once');
      await waitFor(() => h.stream.subscribes === 1, 5000, 'PositionManager to subscribe the user stream');
      await waitFor(() => (pm as any).orderCheckInterval !== undefined, 2000, 'the 30 s protection check to start');
      assert((pm as any).riskCheckInterval !== undefined && (pm as any).cleanupInterval !== undefined, 'risk and cleanup loops run');
    } finally {
      hunter.stop();
      await pm.stop();
    }
    assertEqual(h.stream.closes, 1, 'stop() closes the user stream');
  });

  await summary.run('Aster rule unchanged: no restart without an API key and secret', async () => {
    const pm = new PositionManager(createMockConfig(), false, {
      id: 'aster',
      hasCredentials: () => false,
    } as any);
    let restarts = 0;
    (pm as any).restartConnection = async () => { restarts++; };
    (pm as any).isRunning = true;
    const noSecret = createMockConfig();
    noSecret.global.paperMode = false;
    noSecret.api.secretKey = '';
    pm.updateConfig(noSecret);
    assertEqual(restarts, 0, 'Aster with a key but no secret does not restart');
    const withKeys = createMockConfig();
    pm.updateConfig(withKeys);
    assertEqual(restarts, 1, 'Aster with key and secret restarts on a paper-mode change');
  });

  summary.print();
}

async function testProtectionFlow() {
  logSection('Lighter: entry fill -> native OCO -> TP fill');
  const summary = new TestSummary();
  const h = lighterHarness({ credentials: true });
  const pm = new PositionManager(lighterConfig(false), false, h.adapter);
  const cancelResults: any[] = [];
  const cancelOrder = h.adapter.cancelOrder.bind(h.adapter);
  h.adapter.cancelOrder = async (symbol, orderId) => {
    const result = await cancelOrder(symbol, orderId);
    cancelResults.push(result);
    return result;
  };
  let slCoi = 0;
  let tpCoi = 0;

  try {
    await pm.start();
    await waitFor(() => h.stream.handlers !== null, 2000, 'the user stream');

    await summary.run('Underwater long (mark < SL < last): SL buffered from mark, OCO legs reduce-only and sized from the position', async () => {
      const eth = h.exchange.details.find(d => d.market_id === ETH) as Record<string, unknown>;
      eth.mark_price = '4010.00';      // Mark has already fallen through the 2% stop (4018)...
      eth.last_trade_price = 4030;     // ...the last trade has not
      h.exchange.setPosition(ETH, '0.5000', { avg_entry_price: '4100.00' });
      h.emit(accountUpdate('0.5000', '4100.00'));

      await waitFor(() => h.exchange.accepted().some(tx => tx.txType === 28), 5000, 'the OCO tx');
      const oco = h.exchange.accepted().find(tx => tx.txType === 28)!;
      const [sl, tp] = oco.info.Orders as Array<Record<string, number>>;
      assertEqual(oco.info.GroupingType, 2, 'One native OCO');
      assert(sl.Type === 2 && tp.Type === 4, 'SL type 2, TP type 4');
      assert(sl.ReduceOnly === 1 && tp.ReduceOnly === 1, 'Both legs reduce-only');
      assert(sl.BaseAmount === 5000 && tp.BaseAmount === 5000, `Both legs sized from the position (got ${sl.BaseAmount}, ${tp.BaseAmount})`);
      assert(sl.TriggerPrice < 401000, `SL trigger ${sl.TriggerPrice / 100} must sit below mark 4010`);
      assertEqual(sl.TriggerPrice, 400599, 'SL = mark x 0.999 (the underwater buffer), not last x 0.999');
      assertEqual(tp.TriggerPrice, 422300, 'TP = entry x 1.03');
      assertEqual(h.exchange.received.filter(tx => tx.txType === 14).length, 0, 'No individual retries were needed');

      await waitFor(() => ((pm as any).positionOrders as Map<string, any>).size === 1, 2000, 'order tracking');
      const tracked = [...((pm as any).positionOrders as Map<string, any>).values()][0];
      slCoi = sl.ClientOrderIndex;
      tpCoi = tp.ClientOrderIndex;
      assertEqual(tracked.slOrderId, slCoi, 'SL tracked under its client order index (a number)');
      assertEqual(tracked.tpOrderId, tpCoi, 'TP tracked under its client order index (a number)');
    });

    await summary.run('TP fill: the exchange already cancelled the SL sibling, and that cancel counts as done (no tx)', async () => {
      const tpOrder = h.exchange.findOrder(tpCoi)!;
      const slOrder = h.exchange.findOrder(slCoi)!;
      tpOrder.status = 'filled';
      tpOrder.filled_base_amount = '0.5000';
      tpOrder.remaining_base_amount = '0.0000';
      slOrder.status = 'canceled-oco';
      h.exchange.setPosition(ETH, '0');
      h.emit({
        e: 'ORDER_TRADE_UPDATE',
        E: Date.now(),
        T: Date.now(),
        o: {
          s: 'ETHUSDT', c: `al_tp_ETHUSDT_${tpCoi}`, S: 'SELL', o: 'TAKE_PROFIT_MARKET', f: 'IOC', q: '0.5000', p: '0', ap: '4223',
          sp: '4223', x: 'TRADE', X: 'FILLED', i: tpCoi, l: '0.5000', z: '0.5000', L: '4223', R: true, ps: 'BOTH', rp: '61.5',
        },
      });
      await waitFor(() => cancelResults.length === 1, 3000, 'the SL cancel');
      assertEqual(cancelResults[0].status, 'CANCELED', 'Reported as cancelled');
      assertEqual(cancelResults[0].alreadyTerminal, true, 'Recognised as already terminal (canceled-oco)');
      assertEqual(h.exchange.received.filter(tx => tx.txType === 15).length, 0, 'No cancel tx was signed or sent');
      assertEqual(((pm as any).positionOrders as Map<string, any>).size, 0, 'Order tracking cleared');
      h.emit(accountUpdate('0', '0'));
      assertEqual(((pm as any).currentPositions as Map<string, any>).size, 0, 'Position removed');
    });

    // The race the nonce manager's 45 s lock bound leaves open: an entry whose outcome was unknown executes after
    // the bot stopped waiting, so no fill event announces it. The periodic check finds and protects it.
    await summary.run('A position the bot never saw opening (a late-executed entry) is protected by the periodic check', async () => {
      const ocoBefore = h.exchange.accepted().filter(tx => tx.txType === 28).length;
      h.exchange.setPosition(ETH, '0.3000', { avg_entry_price: '4050.00' });   // no account update event
      await (pm as any).checkAndAdjustOrders();
      await waitFor(() => h.exchange.accepted().filter(tx => tx.txType === 28).length === ocoBefore + 1, 5000, 'the OCO for the untracked position');
      const oco = h.exchange.accepted().filter(tx => tx.txType === 28)[ocoBefore];
      const [sl, tp] = oco.info.Orders as Array<Record<string, number>>;
      assert(sl.ReduceOnly === 1 && tp.ReduceOnly === 1, 'Both legs reduce-only');
      assert(sl.BaseAmount === 3000 && tp.BaseAmount === 3000, `Sized from the position (got ${sl.BaseAmount}, ${tp.BaseAmount})`);
      // Close it again so the following cases start flat
      h.exchange.setPosition(ETH, '0');
      h.emit(accountUpdate('0', '0'));
    });

    // An OCO whose outcome is unknown may still land: placing SL and TP individually as well would double the
    // protection, so the position manager leaves it to the periodic check
    await summary.run('Unknown SL/TP outcome (mayExist): no individual re-placement', async () => {
      const placeProtectiveOrders = h.adapter.placeProtectiveOrders.bind(h.adapter);
      const placeOrder = h.adapter.placeOrder.bind(h.adapter);
      let protectiveCalls = 0;
      let individualCalls = 0;
      h.adapter.placeProtectiveOrders = async () => {
        protectiveCalls++;
        return { errors: ['SL: outcome unknown', 'TP: outcome unknown'], mayExist: true };
      };
      h.adapter.placeOrder = async (request) => {
        individualCalls++;
        return placeOrder(request);
      };
      try {
        h.exchange.setPosition(ETH, '0.2000', { avg_entry_price: '4100.00' });
        await (pm as any).checkAndAdjustOrders();
        await waitFor(() => protectiveCalls >= 1, 3000, 'the SL/TP placement');
        await new Promise(resolve => setTimeout(resolve, 300));
        assertEqual(individualCalls, 0, 'No individual SL/TP orders while the OCO may exist');
      } finally {
        h.adapter.placeProtectiveOrders = placeProtectiveOrders;
        h.adapter.placeOrder = placeOrder;
        h.exchange.setPosition(ETH, '0');
        h.emit(accountUpdate('0', '0'));
      }
    });

    await summary.run('Reconnects replace the periodic loops instead of stacking them; stop() clears all of them', async () => {
      const created: unknown[] = [];
      const cleared = new Set<unknown>();
      const originalSet = global.setInterval;
      const originalClear = global.clearInterval;
      let recording = false;
      global.setInterval = ((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => {
        const handle = originalSet(fn, ms, ...args);
        if (recording) created.push(handle);
        return handle;
      }) as typeof setInterval;
      global.clearInterval = ((handle: any) => {
        cleared.add(handle);
        return originalClear(handle);
      }) as typeof clearInterval;
      try {
        recording = true;
        for (let i = 0; i < 3; i++) h.stream.handlers!.onConnected?.();
        recording = false;
        const active = () => created.filter(handle => !cleared.has(handle)).length;
        assertEqual(created.length, 9, 'Each reconnect starts the risk, order-check and cleanup loops');
        assertEqual(active(), 3, 'Only the latest set stays active');
        await pm.stop();
        assertEqual(active(), 0, 'stop() clears every loop, the orphan cleanup included');
      } finally {
        global.setInterval = originalSet;
        global.clearInterval = originalClear;
      }
    });
  } finally {
    await pm.stop();
  }

  summary.print();
}

async function testAsterPaperToggleSequence() {
  logSection('Aster: paper-mode toggle request sequence');
  const summary = new TestSummary();

  await summary.run('Restart closes the old stream (DELETE listenKey) before opening a new one (POST listenKey)', async () => {
    // Deliberate change: before the exchange layer, the toggle closed the socket without a DELETE, and the old
    // socket's close handler reconnected as well, leaving two streams
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const requests: string[] = [];
    let keys = 0;
    mockExchangeHttp(config => {
      const url = new URL(config.url ?? '', 'https://fapi.asterdex.com');
      const method = (config.method ?? 'get').toUpperCase();
      if (url.pathname === '/fapi/v1/listenKey') {
        requests.push(`${method} ${url.pathname}`);
        return method === 'POST' ? { listenKey: `key${++keys}` } : {};
      }
      if (url.pathname === '/fapi/v1/exchangeInfo') return { symbols: [] };
      return [];
    });
    class LocalAster extends AsterAdapter {
      getUserDataStreamUrl(listenKey: string): string {
        return `ws://127.0.0.1:${port}/ws/${listenKey}`;
      }
    }
    const config = createMockConfig();
    config.global.paperMode = false;
    const pm = new PositionManager(config, false, new LocalAster(config.api));
    try {
      await pm.start();
      assertEqual(requests.join(', '), 'POST /fapi/v1/listenKey', 'Start opens one stream');
      await waitFor(() => server.clients.size === 1, 3000, 'the user stream socket');
      const paper = createMockConfig();
      paper.global.paperMode = true;
      pm.updateConfig(paper);
      await waitFor(() => requests.length >= 3, 5000, 'the restart');
      await wait(300);
      assertEqual(requests.join(', '), 'POST /fapi/v1/listenKey, DELETE /fapi/v1/listenKey, POST /fapi/v1/listenKey',
        'Toggle: DELETE the old listenKey, then POST a new one, nothing else');
    } finally {
      await pm.stop();
      server.close();
    }
  });

  summary.print();
}

async function main() {
  await testPaperToLiveOnLighter();
  await testProtectionFlow();
  await testAsterPaperToggleSequence();
  finishTests();
}

main().catch(error => {
  console.error('Lighter bot flow tests crashed:', error);
  process.exit(1);
});
