/**
 * @jest-environment node
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'net';
import {
  ASTER_FORCE_ORDER_STREAM_URL,
  AsterForceOrderSource,
  parseForceOrderEvent,
} from '../../src/lib/liquidation/asterForceOrderSource';
import type { LiquidationSourceError } from '../../src/lib/liquidation/types';
import type { LiquidationEvent } from '../../src/lib/types';

// A forceOrder frame as Aster (Binance futures format) sends it on !forceOrder@arr
const FORCE_ORDER_FRAME = {
  e: 'forceOrder',
  E: 1760000000123,
  o: {
    s: 'BTCUSDT',
    S: 'SELL',
    o: 'LIMIT',
    f: 'IOC',
    q: '0.014',
    p: '9910',
    ap: '9910.5',
    X: 'FILLED',
    l: '0.014',
    z: '0.014',
    T: 1760000000100,
  },
};

const EXPECTED_EVENT: LiquidationEvent = {
  symbol: 'BTCUSDT',
  side: 'SELL',
  orderType: 'LIMIT',
  quantity: 0.014,
  price: 9910,
  averagePrice: 9910.5,
  orderStatus: 'FILLED',
  orderLastFilledQuantity: 0.014,
  orderFilledAccumulatedQuantity: 0.014,
  orderTradeTime: 1760000000100,
  eventTime: 1760000000123,
  qty: 0.014,
  time: 1760000000123,
};

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// Like waitFor, but polls with setImmediate so it still works while setTimeout is faked
async function waitForIo(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setImmediate(resolve));
  }
}

describe('parseForceOrderEvent', () => {
  it('maps a forceOrder frame to a LiquidationEvent', () => {
    expect(parseForceOrderEvent(FORCE_ORDER_FRAME)).toEqual(EXPECTED_EVENT);
  });

  it('keeps the forced side (BUY = a short was liquidated)', () => {
    const frame = { ...FORCE_ORDER_FRAME, o: { ...FORCE_ORDER_FRAME.o, S: 'BUY' } };
    expect(parseForceOrderEvent(frame)?.side).toBe('BUY');
  });

  it('ignores frames that are not liquidations', () => {
    expect(parseForceOrderEvent({ e: 'markPriceUpdate', s: 'BTCUSDT', p: '50000' })).toBeNull();
    expect(parseForceOrderEvent({ o: { s: 'BTCUSDT', S: 'SELL' } })).toBeNull(); // no event type
    expect(parseForceOrderEvent(null)).toBeNull();
  });

  it('uses the public Aster stream by default', () => {
    expect(ASTER_FORCE_ORDER_STREAM_URL).toBe('wss://fstream.asterdex.com/ws/!forceOrder@arr');
    expect(new AsterForceOrderSource().id).toBe('aster');
  });
});

describe('AsterForceOrderSource', () => {
  let server: WebSocketServer;
  let url: string;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    clients.length = 0;
    server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    server.on('connection', (socket) => clients.push(socket));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws/!forceOrder@arr`;
  });

  afterEach(async () => {
    server.clients.forEach(client => client.terminate());
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('emits parsed liquidations and reports bad frames without dropping the stream', async () => {
    const source = new AsterForceOrderSource({ url, reconnectDelayMs: 20 });
    const liquidations: LiquidationEvent[] = [];
    const errors: LiquidationSourceError[] = [];
    let connected = 0;

    source.start(event => liquidations.push(event), {
      onConnected: () => connected++,
      onError: (_error, info) => errors.push(info),
    });
    await waitFor(() => connected === 1 && clients.length === 1);

    clients[0].send(JSON.stringify({ e: 'markPriceUpdate', s: 'BTCUSDT', p: '50000' }));
    clients[0].send('not json');
    clients[0].send(JSON.stringify(FORCE_ORDER_FRAME));
    await waitFor(() => liquidations.length === 1);

    expect(liquidations[0]).toEqual(EXPECTED_EVENT);
    expect(errors).toEqual([{ kind: 'message', rawMessage: 'not json' }]);

    source.stop();
  });

  it('reconnects after the server drops the stream, and stays down after stop()', async () => {
    const source = new AsterForceOrderSource({ url, reconnectDelayMs: 20 });
    const disconnects: (number | null)[] = [];
    let connected = 0;

    source.start(() => undefined, {
      onConnected: () => connected++,
      onDisconnected: ({ reconnectDelayMs }) => disconnects.push(reconnectDelayMs),
    });
    await waitFor(() => connected === 1);

    clients[0].close();
    await waitFor(() => connected === 2 && clients.length === 2);
    expect(disconnects).toEqual([20]);

    source.stop();
    await waitFor(() => disconnects.length === 2);
    expect(disconnects[1]).toBeNull();

    await new Promise(resolve => setTimeout(resolve, 100));
    expect(clients).toHaveLength(2);
    expect(connected).toBe(2);
  });

  // Deliberate Aster fix: the old source also reconnected from 'error' (which 'close' always follows) and from an
  // old socket's 'close' after stop() + start(), which could leave two or three live streams
  it('stop() then start() leaves exactly one stream', async () => {
    const source = new AsterForceOrderSource({ url, reconnectDelayMs: 20 });
    let connected = 0;
    source.start(() => undefined, { onConnected: () => connected++ });
    await waitFor(() => connected === 1);

    source.stop();
    source.start(() => undefined, { onConnected: () => connected++ });
    await waitFor(() => connected === 2 && clients.length === 2);

    await new Promise(resolve => setTimeout(resolve, 150));
    expect(clients).toHaveLength(2);
    expect(server.clients.size).toBe(1);   // the first socket is closed, the second is the only live one
    source.stop();
  });

  // The old version of this test slept 300 ms, stopped the source and compared counters after a second sleep. When
  // stop() landed while a retry was still connecting, that socket's close reported one more (final, reconnectDelayMs
  // null) disconnect after the counters were read, so it failed now and then on a loaded machine. Here only the
  // reconnect timer is faked and stepped by hand while the refused connections complete for real, so every attempt
  // is counted exactly and nothing depends on how fast the machine is.
  it('an unreachable stream retries once per failure, not twice', async () => {
    const closedUrl = await new Promise<string>((resolve) => {
      const probe = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      probe.once('listening', () => {
        const port = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(`ws://127.0.0.1:${port}/ws/!forceOrder@arr`));
      });
    });
    jest.useFakeTimers({
      doNotFake: [
        'Date', 'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame',
        'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate',
        'clearImmediate', 'setInterval', 'clearInterval',
      ],
    });
    try {
      const source = new AsterForceOrderSource({ url: closedUrl, reconnectDelayMs: 20 });
      let errors = 0;
      const disconnects: (number | null)[] = [];
      source.start(() => undefined, {
        onError: () => errors++,
        onDisconnected: ({ reconnectDelayMs }) => disconnects.push(reconnectDelayMs),
      });

      for (let failures = 1; failures <= 5; failures++) {
        await waitForIo(() => disconnects.length === failures);
        expect(errors).toBe(failures);                              // one error per failed attempt
        expect(disconnects).toEqual(Array(failures).fill(20));      // and one scheduled retry per failure
        expect(jest.getTimerCount()).toBe(1);                       // a single reconnect timer, not two
        jest.advanceTimersByTime(20);                               // the retry fires: the next attempt starts
      }

      // The sixth attempt is still connecting. stop() abandons it: its close reports the final disconnect (no retry
      // is scheduled) and its error is dropped
      source.stop();
      expect(jest.getTimerCount()).toBe(0);
      await waitForIo(() => disconnects.length === 6);
      expect(disconnects[5]).toBeNull();

      // Nothing more happens after stop(), however far the clock moves
      jest.advanceTimersByTime(60_000);
      for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
      expect(errors).toBe(5);
      expect(disconnects).toEqual([20, 20, 20, 20, 20, null]);
    } finally {
      jest.useRealTimers();
    }
  });
});
