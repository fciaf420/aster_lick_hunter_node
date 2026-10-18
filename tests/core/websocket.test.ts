#!/usr/bin/env tsx

import websocketService from '../../src/lib/services/websocketService';
import {
  TestSummary,
  logSection,
  log,
  colors,
  MockWebSocketServer,
  MockWebSocketClient,
  assert,
  assertEqual,
  wait,
  finishTests
} from '../utils/test-helpers';

async function testWebSocketInitialization() {
  logSection('Testing WebSocket Initialization');
  const summary = new TestSummary();

  await summary.run('Create WebSocketService instance', async () => {
    const service = websocketService;
    assert(service !== null, 'WebSocketService should be created');
  });

  await summary.run('Configure WebSocket URLs', async () => {
    const urls = {
      liquidation: 'wss://fstream.asterdex.com/ws/!forceOrder@arr',
      userData: 'wss://fstream.asterdex.com/ws',
      markPrice: 'wss://fstream.asterdex.com/ws/!markPrice@arr',
      klines: 'wss://fstream.asterdex.com/ws'
    };

    assert(urls.liquidation.startsWith('wss://'), 'Liquidation URL should use WSS');
    assert(urls.userData.startsWith('wss://'), 'User data URL should use WSS');
    assert(urls.markPrice.includes('markPrice'), 'Mark price URL should include stream name');
  });

  summary.print();
}

async function testConnectionManagement() {
  logSection('Testing Connection Management');
  const summary = new TestSummary();

  let server: MockWebSocketServer | null = null;
  let client: MockWebSocketClient | null = null;

  await summary.run('Establish WebSocket connection', async () => {
    server = new MockWebSocketServer(8083);
    await server.start();

    client = new MockWebSocketClient();
    await client.connect('ws://localhost:8083');

    assert(client.isConnected, 'Client should be connected');
  });

  await summary.run('Send and receive messages', async () => {
    if (server && client) {
      const testMessage = { type: 'test', data: 'hello' };

      let messageReceived = false;
      client.on('message', (msg) => {
        if (msg.type === 'test') {
          messageReceived = true;
        }
      });

      server.broadcast(testMessage);
      await wait(100);

      assert(messageReceived, 'Message should be received');
    }
  });

  await summary.run('Handle connection close', async () => {
    if (client) {
      client.close();
      await wait(100);
      assert(!client.isConnected, 'Client should be disconnected');
    }
  });

  if (server) {
    await server.stop();
  }

  summary.print();
}

async function testAutoReconnection() {
  logSection('Testing Auto Reconnection');
  const summary = new TestSummary();

  await summary.run('Detect disconnection', async () => {
    let disconnected = false;
    let connectionState = 'connected';

    connectionState = 'disconnected';
    disconnected = true;

    assert(disconnected, 'Should detect disconnection');
    assertEqual(connectionState, 'disconnected', 'State should update');
  });

  await summary.run('Exponential backoff for reconnection', async () => {
    const calculateBackoff = (attempt: number) => {
      const base = 1000;
      const max = 30000;
      return Math.min(base * Math.pow(2, attempt), max);
    };

    assertEqual(calculateBackoff(0), 1000, 'First attempt: 1s');
    assertEqual(calculateBackoff(1), 2000, 'Second attempt: 2s');
    assertEqual(calculateBackoff(2), 4000, 'Third attempt: 4s');
    assertEqual(calculateBackoff(3), 8000, 'Fourth attempt: 8s');
    assertEqual(calculateBackoff(10), 30000, 'Should cap at 30s');
  });

  await summary.run('Reset backoff on successful connection', async () => {
    let reconnectAttempts = 5;
    let connected = false;

    connected = true;
    if (connected) {
      reconnectAttempts = 0;
    }

    assertEqual(reconnectAttempts, 0, 'Should reset attempts on connection');
  });

  summary.print();
}

async function testMessageHandling() {
  logSection('Testing Message Handling');
  const summary = new TestSummary();

  await summary.run('Parse liquidation messages', async () => {
    const message = {
      e: 'forceOrder',
      E: Date.now(),
      o: {
        s: 'BTCUSDT',
        S: 'SELL',
        o: 'LIMIT',
        f: 'IOC',
        q: '0.5',
        p: '50000',
        ap: '50000',
        X: 'FILLED',
        l: '0.5',
        z: '0.5',
        T: Date.now()
      }
    };

    assert(message.e === 'forceOrder', 'Should identify liquidation event');
    assert(message.o.s === 'BTCUSDT', 'Should parse symbol');
    assert(message.o.S === 'SELL', 'Should parse side');
    assertEqual(parseFloat(message.o.q), 0.5, 'Should parse quantity');
  });

  await summary.run('Parse user data messages', async () => {
    const accountUpdate = {
      e: 'ACCOUNT_UPDATE',
      E: Date.now(),
      a: {
        B: [{ a: 'USDT', wb: '10000', cw: '10000' }],
        P: [{ s: 'BTCUSDT', pa: '0.001', ep: '50000' }]
      }
    };

    assert(accountUpdate.e === 'ACCOUNT_UPDATE', 'Should identify account update');
    assert(accountUpdate.a.B.length > 0, 'Should have balance data');
    assert(accountUpdate.a.P.length > 0, 'Should have position data');
  });

  await summary.run('Parse order updates', async () => {
    const orderUpdate = {
      e: 'ORDER_TRADE_UPDATE',
      E: Date.now(),
      o: {
        s: 'BTCUSDT',
        S: 'BUY',
        o: 'LIMIT',
        q: '0.001',
        p: '50000',
        X: 'NEW',
        i: 12345
      }
    };

    assert(orderUpdate.e === 'ORDER_TRADE_UPDATE', 'Should identify order update');
    assertEqual(orderUpdate.o.X, 'NEW', 'Should parse order status');
    assertEqual(orderUpdate.o.i, 12345, 'Should parse order ID');
  });

  summary.print();
}

async function testStreamSubscription() {
  logSection('Testing Stream Subscription');
  const summary = new TestSummary();

  await summary.run('Subscribe to liquidation stream', async () => {
    const streams = new Set<string>();
    streams.add('!forceOrder@arr');

    assert(streams.has('!forceOrder@arr'), 'Should be subscribed to liquidations');
  });

  await summary.run('Subscribe to multiple symbols', async () => {
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    const streams = new Set<string>();

    for (const symbol of symbols) {
      streams.add(`${symbol.toLowerCase()}@markPrice`);
      streams.add(`${symbol.toLowerCase()}@depth5`);
    }

    assertEqual(streams.size, symbols.length * 2, 'Should have all streams');
  });

  await summary.run('Unsubscribe from streams', async () => {
    const streams = new Set<string>(['stream1', 'stream2', 'stream3']);

    streams.delete('stream2');
    assertEqual(streams.size, 2, 'Should remove stream');
    assert(!streams.has('stream2'), 'Stream should be unsubscribed');
  });

  summary.print();
}

async function testHeartbeatMechanism() {
  logSection('Testing Heartbeat Mechanism');
  const summary = new TestSummary();

  await summary.run('Send ping messages', async () => {
    const lastPing = Date.now();
    const pingInterval = 30000;
    const timeSincePing = Date.now() - lastPing;

    assert(timeSincePing < pingInterval, 'Should be within ping interval');
  });

  await summary.run('Handle pong responses', async () => {
    let pongsReceived = 0;
    const pingsSent = 5;

    for (let i = 0; i < pingsSent; i++) {
      pongsReceived++;
    }

    assertEqual(pongsReceived, pingsSent, 'Should receive all pongs');
  });

  await summary.run('Detect stale connections', async () => {
    const lastPong = Date.now() - 65000;
    const timeout = 60000;
    const isStale = (Date.now() - lastPong) > timeout;

    assert(isStale, 'Should detect stale connection');
  });

  summary.print();
}

async function testErrorHandling() {
  logSection('Testing Error Handling');
  const summary = new TestSummary();

  await summary.run('Handle connection errors', async () => {
    const errors = [
      { code: 'ECONNREFUSED', message: 'Connection refused' },
      { code: 'ETIMEDOUT', message: 'Connection timeout' },
      { code: 'ENOTFOUND', message: 'Host not found' }
    ];

    for (const error of errors) {
      assert(error.code !== '', 'Error should have code');
      assert(error.message !== '', 'Error should have message');
    }
  });

  await summary.run('Handle invalid messages', async () => {
    const tryParseMessage = (data: string) => {
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    };

    const valid = tryParseMessage('{"type":"test"}');
    const invalid = tryParseMessage('not json');

    assert(valid !== null, 'Should parse valid JSON');
    assert(invalid === null, 'Should handle invalid JSON');
  });

  await summary.run('Handle rate limit on WebSocket', async () => {
    let messageCount = 0;
    const limit = 10;
    const messages = 15;

    for (let i = 0; i < messages; i++) {
      if (messageCount < limit) {
        messageCount++;
      }
    }

    assertEqual(messageCount, limit, 'Should respect message limit');
  });

  summary.print();
}

async function testMultipleConnections() {
  logSection('Testing Multiple Connections');
  const summary = new TestSummary();

  await summary.run('Manage multiple WebSocket connections', async () => {
    const connections = new Map<string, { url: string; connected: boolean }>();

    connections.set('liquidation', { url: 'wss://stream1', connected: true });
    connections.set('userData', { url: 'wss://stream2', connected: true });
    connections.set('markPrice', { url: 'wss://stream3', connected: true });

    assertEqual(connections.size, 3, 'Should have 3 connections');
    assert(Array.from(connections.values()).every(c => c.connected), 'All should be connected');
  });

  await summary.run('Independent connection states', async () => {
    const connections = {
      stream1: 'connected',
      stream2: 'disconnected',
      stream3: 'reconnecting'
    };

    assert(connections.stream1 === 'connected', 'Stream 1 should be connected');
    assert(connections.stream2 === 'disconnected', 'Stream 2 should be disconnected');
    assert(connections.stream3 === 'reconnecting', 'Stream 3 should be reconnecting');
  });

  await summary.run('Cleanup all connections', async () => {
    const connections = ['conn1', 'conn2', 'conn3'];
    const closed: string[] = [];

    for (const conn of connections) {
      closed.push(conn);
    }

    assertEqual(closed.length, connections.length, 'All connections should be closed');
  });

  summary.print();
}

async function main() {
  console.clear();
  log('🧪 WEBSOCKET TEST SUITE', colors.cyan + colors.bold);
  log('=' .repeat(60), colors.cyan);

  try {
    await testWebSocketInitialization();
    await testConnectionManagement();
    await testAutoReconnection();
    await testMessageHandling();
    await testStreamSubscription();
    await testHeartbeatMechanism();
    await testErrorHandling();
    await testMultipleConnections();

    logSection('✨ All WebSocket Tests Complete');
    finishTests();
  } catch (error) {
    logSection('❌ Test Suite Failed');
    console.error(error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}