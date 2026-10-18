/**
 * @jest-environment node
 */
import { inspect } from 'util';
import { AxiosError, AxiosHeaders } from 'axios';
import {
  LIGHTER_AUTH_TOKEN_LIFETIME_SEC,
  LighterApiError,
  LighterAuthTokenManager,
  LighterHttpClient,
  isLighterAuthFailure,
  type LighterHttpRequest,
  type LighterHttpResponse,
} from '../../../src/lib/exchange/lighter/http';
import { PROFILES } from '../../../src/lib/exchange/lighter/profiles';

const TOKEN = (n: number) => `${n}:5:3:${String(n % 10).repeat(160)}`;

describe('LighterAuthTokenManager (spec §1.2)', () => {
  it('signs with an explicit now + 6 h deadline, reuses the token, renews 30 min before the deadline', async () => {
    const clock = { now: 1_800_000_000_000 };
    const deadlines: number[] = [];
    const refreshed: number[] = [];
    const manager = new LighterAuthTokenManager({
      createToken: deadline => {
        deadlines.push(deadline);
        return `${TOKEN(deadline)}#${deadlines.length}`;
      },
      now: () => clock.now,
    });
    manager.onRefresh(deadline => refreshed.push(deadline));
    const first = await manager.getAuthToken();
    expect(deadlines).toEqual([clock.now / 1000 + LIGHTER_AUTH_TOKEN_LIFETIME_SEC]);
    clock.now += 5 * 3600 * 1000;   // 1 h left
    expect(await manager.getAuthToken()).toBe(first);
    clock.now += 31 * 60 * 1000;    // 29 min left
    const second = await manager.getAuthToken();
    expect(second).not.toBe(first);
    expect(await manager.getAuthToken({ forceRefresh: true })).not.toBe(second);
    expect(refreshed).toHaveLength(3);
    expect(manager.deadlineSec).toBe(deadlines[2]);
  });

  it('signs once for concurrent callers', async () => {
    let signs = 0;
    const manager = new LighterAuthTokenManager({ createToken: async deadline => { signs++; return TOKEN(deadline); } });
    await Promise.all([manager.getAuthToken(), manager.getAuthToken(), manager.getAuthToken()]);
    expect(signs).toBe(1);
    expect(() => new LighterAuthTokenManager({ createToken: () => 'x', lifetimeSec: 60, refreshBeforeSec: 60 })).toThrow(RangeError);
  });
});

function client(handler: (request: LighterHttpRequest) => LighterHttpResponse | Promise<LighterHttpResponse>, auth?: LighterAuthTokenManager) {
  const requests: LighterHttpRequest[] = [];
  const http = new LighterHttpClient({
    profile: PROFILES.testnet,
    auth,
    transport: async request => {
      requests.push(request);
      return handler(request);
    },
  });
  return { http, requests };
}

describe('LighterHttpClient', () => {
  it('sends the auth header on private endpoints and refreshes the token once on "invalid signature"', async () => {
    let tokens = 0;
    const auth = new LighterAuthTokenManager({ createToken: deadline => TOKEN(deadline + tokens++) });
    let failures = 1;
    const { http, requests } = client(() => {
      if (failures-- > 0) return { status: 400, data: { code: 29500, message: 'internal error: invalid signature' } };
      return { status: 200, data: { code: 200, orders: [{ client_order_index: 1 }] } };
    }, auth);
    await expect(http.getActiveOrders(5)).resolves.toEqual([{ client_order_index: 1 }]);
    expect(requests).toHaveLength(2);
    expect(requests[0].headers?.authorization).not.toBe(requests[1].headers?.authorization);
    expect(requests[1].url).toBe('https://testnet.zklighter.elliot.ai/api/v1/accountActiveOrders?account_index=5&market_id=255&market_type=perp');
  });

  it('gives up after a second auth failure without putting the token in the error', async () => {
    const auth = new LighterAuthTokenManager({ createToken: deadline => TOKEN(deadline) });
    const { http } = client(() => ({ status: 400, data: { code: 29500, message: 'invalid signature' } }), auth);
    const error = await http.getMakerOnlyApiKeys(5).catch(e => e);
    expect(error).toBeInstanceOf(LighterApiError);
    expect(error.message).toMatch(/auth token rejected twice/);
    expect(error.message).not.toMatch(/[0-9]{160}/);
  });

  it('treats other 29500 errors as server errors (no token refresh)', async () => {
    let signs = 0;
    const auth = new LighterAuthTokenManager({ createToken: deadline => { signs++; return TOKEN(deadline); } });
    const { http, requests } = client(() => ({ status: 500, data: { code: 29500, message: 'internal error' } }), auth);
    await expect(http.getActiveOrders(5)).rejects.toMatchObject({ code: 29500, status: 500 });
    expect(requests).toHaveLength(1);
    expect(signs).toBe(1);
    expect(isLighterAuthFailure({ status: 400, data: { code: 29500, message: 'internal error' } })).toBe(false);
  });

  it('never lets a transport error carry the auth token (no AxiosError config or headers escape)', async () => {
    const auth = new LighterAuthTokenManager({ createToken: deadline => TOKEN(deadline) });
    const token = await auth.getAuthToken();
    const http = new LighterHttpClient({
      profile: PROFILES.testnet,
      auth,
      // What defaultLighterHttpTransport (axios) throws when no response arrives: config.headers holds the token
      transport: async request => {
        const config = { url: request.url, method: request.method.toLowerCase(), headers: new AxiosHeaders(request.headers ?? {}) };
        throw new AxiosError('connect ECONNREFUSED 127.0.0.1:1', 'ECONNREFUSED', config as any, { _header: `authorization: ${request.headers?.authorization}` });
      },
    });
    for (const call of [() => http.getMakerOnlyApiKeys(5), () => http.getActiveOrders(5), () => http.get(http.url('/api/v1/accountLimits'), { headers: { authorization: token } })]) {
      const error = await call().catch(e => e);
      expect(error).toBeInstanceOf(LighterApiError);
      expect(error.status).toBeNull();
      expect(error.message).toMatch(/no response \(ECONNREFUSED|no response \(connect ECONNREFUSED/);
      expect(error.config).toBeUndefined();
      expect(error.request).toBeUndefined();
      expect(error.cause).toBeUndefined();
      expect(inspect(error, { depth: 10 })).not.toContain(token.split(':')[3]);
      expect(JSON.stringify({ rawError: error })).not.toContain(token.split(':')[3]);
    }
    // A token in the transport's message is redacted too
    const leaky = new LighterHttpClient({ profile: PROFILES.testnet, auth, transport: async () => { throw new Error(`bad header ${token}`); } });
    const error = await leaky.getAccountLimits(5).catch(e => e);
    expect(error.message).toContain('<auth token>');
    expect(error.message).not.toContain(token.split(':')[3]);
  });

  it('refuses private endpoints without an auth source', async () => {
    const { http, requests } = client(() => ({ status: 200, data: { code: 200 } }));
    await expect(http.getActiveOrders(5)).rejects.toThrow(/needs an auth token/);
    expect(requests).toHaveLength(0);
  });

  it('form-encodes sendTx with tx_info verbatim (int64 digits intact)', async () => {
    const { http, requests } = client(() => ({ status: 200, data: { code: 200, tx_hash: 'h' } }));
    const txInfo = '{"MarketIndex":1,"Index":576460752303423611,"Sig":"a+b/c="}';
    await http.sendTx(15, txInfo);
    const [request] = requests;
    expect(request.method).toBe('POST');
    expect(request.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(request.body);
    expect(form.get('tx_type')).toBe('15');
    expect(form.get('tx_info')).toBe(txInfo);
    expect(form.has('price_protection')).toBe(false);
  });

  it('sends sendTxBatch as JSON arrays, tx_infos holding the signer strings', async () => {
    const { http, requests } = client(() => ({ status: 200, data: { code: 200, tx_hash: ['a', 'b'] } }));
    const infos = ['{"Nonce":1,"Index":576460752303423611}', '{"Nonce":2}'];
    await http.sendTxBatch([15, 14], infos);
    const form = new URLSearchParams(requests[0].body);
    expect(JSON.parse(form.get('tx_types') ?? '')).toEqual([15, 14]);
    expect(JSON.parse(form.get('tx_infos') ?? '')).toEqual(infos);
    await expect(http.sendTxBatch([14], [])).rejects.toThrow(RangeError);
  });

  it('getTx: found, not found (null) and unavailable (throws)', async () => {
    const answers: LighterHttpResponse[] = [
      { status: 200, data: { code: 200, hash: 'h', status: 2 } },
      { status: 400, data: { code: 21500, message: 'tx not found' } },
      { status: 503, data: 'unavailable' },
    ];
    const { http, requests } = client(() => answers.shift()!);
    await expect(http.getTx('h')).resolves.toMatchObject({ hash: 'h', status: 2 });
    await expect(http.getTx('h')).resolves.toBeNull();
    await expect(http.getTx('h')).rejects.toBeInstanceOf(LighterApiError);
    expect(requests[0].url).toBe('https://testnet.zklighter.elliot.ai/api/v1/tx?by=hash&value=h');
  });

  it('splits client order index lookups into requests of 20', async () => {
    const auth = new LighterAuthTokenManager({ createToken: deadline => TOKEN(deadline) });
    const { http, requests } = client(() => ({ status: 200, data: { code: 200, orders: [] } }), auth);
    await http.getOrdersByClientOrderIndex(5, Array.from({ length: 25 }, (_, i) => i + 1));
    expect(requests).toHaveLength(2);
    expect(decodeURIComponent(requests[1].url)).toContain('client_order_indexes=21,22,23,24,25');
  });

  it('turns non-200 codes into LighterApiError with a Binance-style response.data', async () => {
    const { http } = client(() => ({ status: 400, data: { code: 21100, message: 'account not found' } }));
    const error = await http.getAccount(5).catch(e => e);
    expect(error).toBeInstanceOf(LighterApiError);
    expect(error.response.data).toEqual({ code: 21100, msg: 'account not found', message: 'account not found' });
  });

  it('reads the next nonce and the account by index', async () => {
    const { http } = client(request => request.url.includes('nextNonce')
      ? { status: 200, data: { code: 200, nonce: 42 } }
      : { status: 200, data: { code: 200, accounts: [{ index: 9 }, { index: 5, collateral: '10' }] } });
    await expect(http.getNextNonce(5, 3)).resolves.toBe(42);
    await expect(http.getAccount(5)).resolves.toMatchObject({ index: 5, collateral: '10' });
    const bad = client(() => ({ status: 200, data: { code: 200, nonce: -1 } }));
    await expect(bad.http.getNextNonce(5, 3)).rejects.toThrow(/invalid nonce/);
  });

  it('a per-call timeout can shorten the client timeout (nonce lock bound) but never lengthen it', async () => {
    const { http, requests } = client(request => request.url.includes('nextNonce')
      ? { status: 200, data: { code: 200, nonce: 42 } }
      : request.url.includes('/tx?')
        ? { status: 200, data: { code: 200, hash: 'ab', status: 2 } }
        : { status: 200, data: { code: 200, tx_hash: 'ab' } });
    await http.getNextNonce(5, 3, { timeoutMs: 2500 });
    await http.getTx('ab', { timeoutMs: 1200 });
    await http.sendTx(14, '{}', { timeoutMs: 3000 });
    await http.sendTxBatch([14], ['{}'], { timeoutMs: 4000 });
    await http.getNextNonce(5, 3, { timeoutMs: 60_000 });
    await http.getNextNonce(5, 3);
    expect(requests.map(r => r.timeoutMs)).toEqual([2500, 1200, 3000, 4000, 10_000, 10_000]);
  });
});
