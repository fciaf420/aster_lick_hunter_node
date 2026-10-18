/**
 * @jest-environment node
 */
import { LighterHttpClient, type LighterHttpRequest, type LighterHttpResponse } from '../../../src/lib/exchange/lighter/http';
import { PROFILES } from '../../../src/lib/exchange/lighter/profiles';
import {
  LighterSendRateLimiter,
  LighterTxSender,
  classifySendResponse,
  parseTxEventInfo,
  txExecutionState,
} from '../../../src/lib/exchange/lighter/txSender';
import type { LighterSignedTx } from '../../../src/lib/exchange/lighter/signer';

const TX: LighterSignedTx = { txType: 14, txInfo: '{"Nonce":1}', txHash: 'a'.repeat(80), nonce: 1, expiredAt: 0 };

describe('classifySendResponse (spec §5.1)', () => {
  it.each([
    [{ status: 200, data: { code: 200, tx_hash: 'h', predicted_execution_time_ms: 300, volume_quota_remaining: 9 } }, 'accepted'],
    [{ status: 200, data: { code: 200, tx_hash: ['h1', 'h2'] } }, 'accepted'],
    [{ status: 400, data: { code: 21104, message: 'invalid nonce' } }, 'invalid-nonce'],
    [{ status: 200, data: { code: 21104, message: 'invalid nonce' } }, 'invalid-nonce'],
    [{ status: 400, data: { code: 21120, message: 'invalid order' } }, 'rejected'],
    [{ status: 200, data: { code: 21514, message: 'too many txs' } }, 'rejected'],
    [{ status: 403, data: 'Forbidden' }, 'rejected'],
    [{ status: 429, data: { code: 23000, message: 'too many requests' } }, 'unknown'],
    [{ status: 408, data: '' }, 'unknown'],
    [{ status: 502, data: '<html>Bad gateway</html>' }, 'unknown'],
    [{ status: 200, data: 'not json' }, 'unknown'],
  ] as Array<[LighterHttpResponse, string]>)('%j -> %s', (response, kind) => {
    expect(classifySendResponse(response).kind).toBe(kind);
  });

  it('keeps the accepted hashes and quota', () => {
    expect(classifySendResponse({ status: 200, data: { code: 200, tx_hash: ['h1', 'h2'], volume_quota_remaining: 5 } }))
      .toEqual({ kind: 'accepted', txHashes: ['h1', 'h2'], predictedExecutionTimeMs: undefined, volumeQuotaRemaining: 5 });
  });
});

describe('LighterSendRateLimiter', () => {
  it('allows the burst, then spaces sends at the per-minute rate', async () => {
    const clock = { now: 0 };
    const waits: number[] = [];
    const limiter = new LighterSendRateLimiter({
      perMinute: 60, burst: 2, now: () => clock.now,
      sleep: async ms => {
        waits.push(ms);
        clock.now += ms;
      },
    });
    await limiter.take();
    await limiter.take();
    expect(waits).toEqual([]);
    await limiter.take();
    expect(waits).toEqual([1000]);
    clock.now += 5000;   // refills up to the burst only
    await limiter.take();
    await limiter.take();
    await limiter.take();
    expect(waits).toEqual([1000, 1000]);
    expect(() => new LighterSendRateLimiter({ perMinute: 0 })).toThrow(RangeError);
  });
});

function makeSender(handler: (request: LighterHttpRequest) => LighterHttpResponse | Promise<LighterHttpResponse>, extra: Partial<ConstructorParameters<typeof LighterTxSender>[0]> = {}) {
  const clock = { now: 0 };
  const requests: LighterHttpRequest[] = [];
  const http = new LighterHttpClient({
    profile: PROFILES.testnet,
    transport: async request => {
      requests.push(request);
      return handler(request);
    },
    auth: { getAuthToken: async () => `1:2:3:${'0'.repeat(160)}` },
  });
  const sender = new LighterTxSender({
    http,
    now: () => clock.now,
    sleep: async ms => {
      clock.now += ms;
    },
    ...extra,
  });
  return { sender, requests, clock };
}

describe('LighterTxSender', () => {
  it('posts the signed tx verbatim and classifies the answer; a transport error is "unknown"', async () => {
    let fail = false;
    const { sender, requests } = makeSender(() => {
      if (fail) throw new Error('ECONNRESET');
      return { status: 200, data: { code: 200, tx_hash: TX.txHash } };
    });
    await expect(sender.send(TX)).resolves.toMatchObject({ kind: 'accepted' });
    expect(new URLSearchParams(requests[0].body).get('tx_info')).toBe(TX.txInfo);
    fail = true;
    await expect(sender.send(TX)).resolves.toEqual({ kind: 'unknown', status: null, reason: 'Lighter /api/v1/sendTx: no response (ECONNRESET)' });   // transport errors arrive sanitized
  });

  it('refuses batches above 50 txs', async () => {
    const { sender } = makeSender(() => ({ status: 200, data: { code: 200 } }));
    await expect(sender.sendBatch([])).rejects.toThrow(RangeError);
    await expect(sender.sendBatch(Array.from({ length: 51 }, () => TX))).rejects.toThrow(/1\.\.50/);
  });

  it('confirmTx waits through pending and lookup errors until executed', async () => {
    const answers: LighterHttpResponse[] = [
      { status: 400, data: { code: 21500, message: 'not found' } },
      { status: 503, data: 'unavailable' },
      { status: 200, data: { code: 200, hash: TX.txHash, status: 1, event_info: '{}' } },
      { status: 200, data: { code: 200, hash: TX.txHash, status: 3, event_info: '{}' } },
    ];
    const { sender } = makeSender(() => answers.shift()!);
    const result = await sender.confirmTx(TX.txHash);
    expect(result).toMatchObject({ status: 'executed', tx: { status: 3 } });
  });

  it('confirmTx reports a failed execution with its code and message', async () => {
    const { sender } = makeSender(() => ({
      status: 200,
      data: { code: 200, hash: TX.txHash, status: 0, event_info: JSON.stringify({ ae: 'margin', code: 21701, message: 'not enough margin' }) },
    }));
    await expect(sender.confirmTx(TX.txHash)).resolves.toMatchObject({ status: 'failed', code: 21701, message: 'not enough margin' });
  });

  it('an app error in event_info is a failure even with an executed status', () => {
    expect(txExecutionState({ status: 2, event_info: '{"ae":"order not found"}' })).toBe('failed');
    expect(txExecutionState({ status: 2, event_info: '{}' })).toBe('executed');
    expect(txExecutionState({ status: 1 })).toBe('pending');
    expect(parseTxEventInfo({ event_info: 'garbage' })).toEqual({ appError: null, code: null, message: null });
  });

  it('confirmTx times out after 15 s without a result (never reports success)', async () => {
    const { sender, clock } = makeSender(() => ({ status: 400, data: { code: 21500, message: 'not found' } }));
    const result = await sender.confirmTx(TX.txHash);
    expect(result).toEqual({ status: 'timeout', lastSeen: null });
    expect(clock.now).toBeGreaterThanOrEqual(15_000);
  });

  it('uses the account_tx watcher when it answers first', async () => {
    const { sender } = makeSender(() => ({ status: 400, data: { code: 21500, message: 'not found' } }), {
      txWatcher: async hash => ({ hash, status: 2, event_info: '{}' }),
    });
    await expect(sender.confirmTx(TX.txHash)).resolves.toMatchObject({ status: 'executed' });
  });

  it('findOrders polls accountOrders by client order index until every order is visible', async () => {
    let calls = 0;
    const { sender, requests } = makeSender(() => {
      calls++;
      const orders = calls < 3 ? [{ client_order_index: 11, status: 'open' }] : [{ client_order_index: 11, status: 'open' }, { client_order_index: 12, status: 'pending' }];
      return { status: 200, data: { code: 200, orders } };
    });
    const found = await sender.findOrders(5, [11, 12]);
    expect([...found.keys()].sort()).toEqual([11, 12]);
    expect(requests[0].url).toContain('client_order_indexes=11%2C12');
    expect(requests[0].headers?.authorization).toMatch(/^1:2:3:/);
  });
});
