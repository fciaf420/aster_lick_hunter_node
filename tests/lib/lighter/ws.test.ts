/**
 * @jest-environment node
 */
import {
  LighterWsClient,
  normalizeLighterChannel,
  withLighterStreamParams,
  type LighterWsClientOptions,
  type LighterWsDisconnectInfo,
  type LighterWsFrame,
} from '../../../src/lib/exchange/lighter/ws';
import { lighterStreamUrl, PROFILES } from '../../../src/lib/exchange/lighter/profiles';
import { fakeSocketFactory } from './fakeLighterSocket';

const START = Date.UTC(2026, 9, 18, 12, 0, 0);
const URL_BASE = 'wss://testnet.zklighter.elliot.ai/stream';

function setup(options: Partial<LighterWsClientOptions> = {}) {
  const fake = fakeSocketFactory();
  const frames: LighterWsFrame[] = [];
  const disconnects: LighterWsDisconnectInfo[] = [];
  const acked: string[] = [];
  const failed: Array<[string, number]> = [];
  const sessions: Array<string | null> = [];
  const serverErrors: unknown[] = [];
  const frameErrors: string[] = [];
  const client = new LighterWsClient(
    { url: URL_BASE, createSocket: fake.factory, ...options },
    {
      onMessage: (frame) => frames.push(frame),
      onSessionReady: (sessionId) => sessions.push(sessionId),
      onDisconnected: (info) => disconnects.push(info),
      onChannelAcked: (channel) => acked.push(channel),
      onChannelFailed: (channel, attempts) => failed.push([channel, attempts]),
      onServerError: (error) => serverErrors.push(error),
      onFrameError: (_error, raw) => frameErrors.push(raw),
    }
  );
  const ready = () => {
    const socket = fake.last();
    socket.open();
    socket.serverSend({ type: 'connected', session_id: 'sess' });
    return socket;
  };
  return { client, fake, frames, disconnects, acked, failed, sessions, serverErrors, frameErrors, ready };
}

let active: LighterWsClient | null = null;
const track = <T extends { client: LighterWsClient }>(ctx: T): T => {
  active = ctx.client;
  return ctx;
};

beforeEach(() => {
  jest.useFakeTimers({ now: START });
});

afterEach(() => {
  active?.stop();
  active = null;
  jest.useRealTimers();
});

describe('URL and channel helpers', () => {
  it('adds readonly=true&encoding=json when missing and keeps them when present', () => {
    expect(withLighterStreamParams(URL_BASE)).toBe(`${URL_BASE}?readonly=true&encoding=json`);
    const profileUrl = lighterStreamUrl(PROFILES.mainnet);
    expect(withLighterStreamParams(profileUrl)).toBe(profileUrl);
    expect(() => withLighterStreamParams(`${URL_BASE}?encoding=msgpack`)).toThrow(/encoding=json/);
  });

  it('normalizes the ack channel separator', () => {
    expect(normalizeLighterChannel('trade:1')).toBe('trade/1');
    expect(normalizeLighterChannel('market_stats:all')).toBe('market_stats/all');
    expect(normalizeLighterChannel('trade/1')).toBe('trade/1');
  });
});

describe('LighterWsClient', () => {
  it('waits for the connected frame before subscribing, and sends each subscription once', () => {
    const ctx = track(setup());
    ctx.client.subscribe('trade/1');
    ctx.client.start();
    const socket = ctx.fake.last();
    expect(socket.url).toBe(`${URL_BASE}?readonly=true&encoding=json`);
    socket.open();
    expect(socket.subscribes()).toEqual([]);

    socket.serverSend({ type: 'connected', session_id: 'abc' });
    expect(ctx.sessions).toEqual(['abc']);
    expect(ctx.client.currentSessionId).toBe('abc');
    expect(socket.subscribes()).toEqual(['trade/1']);

    ctx.client.subscribe('trade/1'); // already wanted: no second frame
    ctx.client.subscribe('order_book/1', { auth: 'token' });
    expect(socket.sent.filter((m) => m.type === 'subscribe')).toEqual([
      { type: 'subscribe', channel: 'trade/1' },
      { type: 'subscribe', channel: 'order_book/1', auth: 'token' },
    ]);
  });

  it('subscribes anyway when the connected frame never comes', () => {
    const ctx = track(setup());
    ctx.client.subscribe('trade/1');
    ctx.client.start();
    ctx.fake.last().open();
    jest.advanceTimersByTime(9_999);
    expect(ctx.fake.last().subscribes()).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(ctx.sessions).toEqual([null]);
    expect(ctx.fake.last().subscribes()).toEqual(['trade/1']);
  });

  it('tracks acks and retries 3 s, 6 s, 10 s, then every 15 s, up to 10 attempts', () => {
    const ctx = track(setup({ frameTimeoutMs: 0 }));
    ctx.client.subscribe('trade/1');
    ctx.client.subscribe('trade/2');
    ctx.client.start();
    const socket = ctx.ready();
    socket.serverSend({ type: 'subscribed/trade', channel: 'trade:2', trades: [] });
    expect(ctx.acked).toEqual(['trade/2']);
    expect(ctx.client.isAcked('trade/2')).toBe(true);
    expect(ctx.frames.map((f) => f.type)).toEqual(['subscribed/trade']);

    const sendsOf1 = () => socket.subscribes().filter((c) => c === 'trade/1').length;
    expect(sendsOf1()).toBe(1);
    jest.advanceTimersByTime(3_000);
    expect(sendsOf1()).toBe(2);
    jest.advanceTimersByTime(6_000);
    expect(sendsOf1()).toBe(3);
    jest.advanceTimersByTime(10_000);
    expect(sendsOf1()).toBe(4);
    jest.advanceTimersByTime(15_000 * 6);
    expect(sendsOf1()).toBe(10);
    expect(ctx.failed).toEqual([]);
    jest.advanceTimersByTime(15_000);
    expect(ctx.failed).toEqual([['trade/1', 10]]);
    expect(ctx.client.isFailed('trade/1')).toBe(true);
    jest.advanceTimersByTime(300_000);
    expect(sendsOf1()).toBe(10);
    expect(socket.subscribes().filter((c) => c === 'trade/2')).toHaveLength(1);
  });

  it('unsubscribes acked channels, and answers a late ack of a dropped channel with an unsubscribe', () => {
    const ctx = track(setup());
    ctx.client.subscribe('trade/1');
    ctx.client.subscribe('trade/2');
    ctx.client.start();
    const socket = ctx.ready();
    socket.serverSend({ type: 'subscribed/trade', channel: 'trade:1', trades: [] });

    ctx.client.unsubscribe('trade/1');
    ctx.client.unsubscribe('trade/2'); // still pending
    expect(socket.unsubscribes()).toEqual(['trade/1']);

    socket.serverSend({ type: 'subscribed/trade', channel: 'trade:2', trades: [] });
    expect(socket.unsubscribes()).toEqual(['trade/1', 'trade/2']);
    expect(ctx.acked).toEqual(['trade/1']);
    expect(ctx.frames).toHaveLength(1);
    jest.advanceTimersByTime(60_000);
    expect(socket.subscribes()).toEqual(['trade/1', 'trade/2']);
  });

  it('subscribes again when the server drops a wanted channel', () => {
    const ctx = track(setup());
    ctx.client.subscribe('trade/1');
    ctx.client.start();
    const socket = ctx.ready();
    socket.serverSend({ type: 'subscribed/trade', channel: 'trade:1', trades: [] });
    socket.serverSend({ type: 'unsubscribed', channel: 'trade:1' });
    expect(socket.subscribes()).toEqual(['trade/1', 'trade/1']);
    expect(ctx.client.isAcked('trade/1')).toBe(false);
  });

  it('answers server pings and passes on data frames only', () => {
    const ctx = track(setup());
    ctx.client.start();
    const socket = ctx.ready();
    socket.serverSend({ type: 'ping' });
    expect(socket.sent).toContainEqual({ type: 'pong' });
    socket.serverSend('null');
    socket.serverSend({ type: 'pong' });
    socket.serverSend({ type: 'update/trade', channel: 'trade:1', trades: [] });
    expect(ctx.frames.map((f) => f.type)).toEqual(['update/trade']);
  });

  it('reports error frames and unparseable frames without dropping the socket', () => {
    const ctx = track(setup());
    ctx.client.start();
    const socket = ctx.ready();
    socket.serverSend({ error: { code: 30003, message: 'Invalid Channel' } });
    socket.serverSend('{oops');
    expect(ctx.serverErrors).toEqual([{ code: 30003, message: 'Invalid Channel' }]);
    expect(ctx.frameErrors).toEqual(['{oops']);
    expect(ctx.disconnects).toEqual([]);
  });

  it('keeps going when a handler throws', () => {
    const fake = fakeSocketFactory();
    const client = track({
      client: new LighterWsClient(
        { url: URL_BASE, createSocket: fake.factory },
        {
          onMessage: () => {
            throw new Error('boom');
          },
        }
      ),
    }).client;
    client.start();
    const socket = fake.last();
    socket.open();
    socket.serverSend({ type: 'connected', session_id: 's' });
    expect(() => socket.serverSend({ type: 'update/trade', channel: 'trade:1' })).not.toThrow();
    expect(client.isSessionReady).toBe(true);
  });

  it('pings every 15 s and reconnects when no pong comes back within 15 s', () => {
    const ctx = track(setup());
    ctx.client.start();
    const socket = ctx.ready();
    jest.advanceTimersByTime(15_000);
    expect(socket.count('ping')).toBe(1);
    jest.advanceTimersByTime(30_000);
    expect(socket.count('ping')).toBe(3); // auto-pong keeps it alive
    expect(ctx.disconnects).toEqual([]);

    socket.autoPong = false;
    jest.advanceTimersByTime(15_000); // ping at 60 s, unanswered
    expect(ctx.disconnects).toEqual([]);
    jest.advanceTimersByTime(15_000);
    expect(ctx.disconnects).toHaveLength(1);
    expect(ctx.disconnects[0]).toMatchObject({ reason: 'pong-timeout', reconnectDelayMs: 1000 });
    expect(socket.terminated).toBe(true);
    jest.advanceTimersByTime(1000);
    expect(ctx.fake.sockets).toHaveLength(2);
  });

  it('reconnects when no frame arrives for 60 s, including a handshake that never completes', () => {
    const ctx = track(setup({ pingIntervalMs: 0 }));
    ctx.client.start();
    jest.advanceTimersByTime(59_999);
    expect(ctx.disconnects).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(ctx.disconnects[0]).toMatchObject({ reason: 'frame-timeout', reconnectDelayMs: 1000 });

    jest.advanceTimersByTime(1000);
    const socket = ctx.ready();
    jest.advanceTimersByTime(50_000);
    socket.serverSend({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: {} });
    jest.advanceTimersByTime(59_000);
    expect(ctx.disconnects).toHaveLength(1);
    jest.advanceTimersByTime(1_000);
    expect(ctx.disconnects).toHaveLength(2);
    expect(ctx.disconnects[1].reason).toBe('frame-timeout');
  });

  it('reconnects at once on a shutdown notice and resubscribes in the new session', () => {
    const ctx = track(setup());
    ctx.client.subscribe('trade/1');
    ctx.client.start();
    const socket = ctx.ready();
    socket.serverSend({ type: 'subscribed/trade', channel: 'trade:1', trades: [] });
    socket.serverSend({ type: 'shutdown', close_in_ms: 5000 });
    expect(ctx.disconnects).toEqual([{ reason: 'shutdown', error: undefined, reconnectDelayMs: 0 }]);
    expect(ctx.client.isAcked('trade/1')).toBe(false);

    jest.advanceTimersByTime(0);
    expect(ctx.fake.sockets).toHaveLength(2);
    const next = ctx.ready();
    expect(next.subscribes()).toEqual(['trade/1']);
    // Frames from the old socket are ignored
    socket.serverSend({ type: 'update/trade', channel: 'trade:1', trades: [] });
    expect(ctx.frames.filter((f) => f.type === 'update/trade')).toEqual([]);
  });

  it('backs off exponentially up to 30 s and resets after a stable connection', () => {
    const ctx = track(setup({ frameTimeoutMs: 0, pingIntervalMs: 0 }));
    ctx.client.start();
    const delays: Array<number | null> = [];
    for (let i = 0; i < 7; i++) {
      const socket = ctx.fake.last();
      socket.fail(new Error('ECONNREFUSED'));
      socket.serverClose(); // the close that follows must not add a second reconnect
      const delay = ctx.disconnects[ctx.disconnects.length - 1].reconnectDelayMs;
      delays.push(delay);
      jest.advanceTimersByTime(delay ?? 0);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(ctx.fake.sockets).toHaveLength(8);
    expect(ctx.disconnects.every((d) => d.reason === 'error' && d.error?.message === 'ECONNREFUSED')).toBe(true);

    const socket = ctx.ready();
    jest.advanceTimersByTime(60_000);
    socket.serverClose();
    expect(ctx.disconnects[ctx.disconnects.length - 1]).toMatchObject({ reason: 'close', reconnectDelayMs: 1000 });
  });

  it('stops without reconnecting and ignores the old socket afterwards', () => {
    const ctx = track(setup());
    ctx.client.subscribe('trade/1');
    ctx.client.start();
    const socket = ctx.ready();
    ctx.client.stop();
    expect(ctx.disconnects).toEqual([{ reason: 'stopped', error: undefined, reconnectDelayMs: null }]);
    expect(ctx.client.isRunning).toBe(false);
    socket.serverClose();
    socket.serverSend({ type: 'update/trade', channel: 'trade:1', trades: [] });
    jest.advanceTimersByTime(600_000);
    expect(ctx.fake.sockets).toHaveLength(1);
    expect(ctx.disconnects).toHaveLength(1);
    expect(ctx.frames).toEqual([]);

    // A restart keeps the wanted channels
    ctx.client.start();
    const next = ctx.ready();
    expect(next.subscribes()).toEqual(['trade/1']);
  });

  it('retries when the socket cannot even be created', () => {
    let calls = 0;
    const fake = fakeSocketFactory();
    const disconnects: LighterWsDisconnectInfo[] = [];
    const client = track({
      client: new LighterWsClient(
        {
          url: URL_BASE,
          createSocket: (url) => {
            calls++;
            if (calls === 1) throw new Error('bad url');
            return fake.factory(url);
          },
        },
        { onMessage: () => {}, onDisconnected: (info) => disconnects.push(info) }
      ),
    }).client;
    client.start();
    expect(disconnects[0]).toMatchObject({ reason: 'error', reconnectDelayMs: 1000 });
    jest.advanceTimersByTime(1000);
    expect(fake.sockets).toHaveLength(1);
  });
});
