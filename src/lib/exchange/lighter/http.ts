import axios from 'axios';
import { logWarnWithTimestamp } from '../../utils/timestamp';
import { lighterRestUrl, type LighterProfile } from './profiles';

// REST client for the Lighter endpoints the adapter uses (lighter spec §1.2, §3.1, §3.5, §4.1, §5.1-5.3).
//
// - Public reads need no auth. Private reads send the auth token in the `authorization` header; on the
//   documented auth failure (HTTP 400, code 29500, "invalid signature") the token is refreshed once and the
//   request retried (spec §0 #10, §8 risk 18). Tokens are credentials: they never appear in errors or logs.
// - sendTx / sendTxBatch return the raw HTTP outcome. Whether a tx was accepted, rejected or has an unknown
//   outcome is decided by txSender.ts / nonce.ts, never here.
// - Request bodies send tx_info verbatim: it is the signer's JSON string, whose int64 values (a cancel Index
//   above 2^53) would not survive a JSON.parse / JSON.stringify round trip.

export const LIGHTER_HTTP_TIMEOUT_MS = 10_000;
export const LIGHTER_AUTH_FAILURE_CODE = 29500;
export const LIGHTER_ALL_MARKETS_ID = 255;
export const LIGHTER_MAX_ORDERS_BY_CLIENT_INDEX = 20;   // accountOrders accepts at most 20 client order indexes
export const LIGHTER_MAX_PAGE_LIMIT = 100;              // trades, accountInactiveOrders, ...
export const LIGHTER_MAX_ORDER_BOOK_ORDERS = 250;
export const LIGHTER_MAX_CANDLES = 500;

// ===== Transport =====

export interface LighterHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface LighterHttpResponse {
  status: number;
  data: unknown;        // Parsed JSON, or the raw text when the body is not JSON
}

// Resolves for every HTTP response (any status). Rejects only when no response arrived: network error, timeout.
export type LighterHttpTransport = (request: LighterHttpRequest) => Promise<LighterHttpResponse>;

function parseBody(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  if (raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export const defaultLighterHttpTransport: LighterHttpTransport = async (request) => {
  const response = await axios.request({
    method: request.method,
    url: request.url,
    headers: request.headers,
    data: request.body,
    timeout: request.timeoutMs,
    responseType: 'text',
    transformResponse: [(raw: unknown) => raw],
    validateStatus: () => true,
  });
  return { status: response.status, data: parseBody(response.data) };
};

// ===== Errors =====

// Errors carry a Binance-style `response.data` ({ code, msg }) because the bot reads error.response?.data?.msg
export class LighterApiError extends Error {
  readonly status: number | null;
  readonly code: number | null;
  readonly path: string;
  readonly response: { status: number | null; data: { code: number | null; msg: string; message: string } };

  constructor(path: string, status: number | null, code: number | null, message: string) {
    super(`Lighter ${path}: ${message}${code !== null ? ` (code ${code})` : ''}${status !== null && status !== 200 ? ` [HTTP ${status}]` : ''}`);
    this.name = 'LighterApiError';
    this.status = status;
    this.code = code;
    this.path = path;
    this.response = { status, data: { code, msg: message, message } };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyCode(data: unknown): number | null {
  return isRecord(data) && typeof data.code === 'number' ? data.code : null;
}

function bodyMessage(data: unknown): string {
  if (isRecord(data) && typeof data.message === 'string' && data.message !== '') return data.message;
  if (typeof data === 'string' && data !== '') return data.length > 200 ? `${data.slice(0, 200)}...` : data;
  return 'request failed';
}

// The documented expired/invalid token response (spec §0 #10). Any other 29500 is a server error.
export function isLighterAuthFailure(response: LighterHttpResponse): boolean {
  if (response.status === 401) return true;
  return bodyCode(response.data) === LIGHTER_AUTH_FAILURE_CODE && /invalid signature/i.test(bodyMessage(response.data));
}

// ===== Auth tokens (spec §1.2) =====

export const LIGHTER_AUTH_TOKEN_LIFETIME_SEC = 6 * 60 * 60;      // Explicit deadline now + 6 h (max 8 h)
export const LIGHTER_AUTH_TOKEN_REFRESH_BEFORE_SEC = 30 * 60;    // Refresh when less than 30 min remain

export interface LighterAuthTokenSource {
  getAuthToken(options?: { forceRefresh?: boolean }): Promise<string>;
}

export interface LighterAuthTokenManagerOptions {
  // Signs a token valid until deadlineSec (unix seconds). Usually signer.createAuthToken.
  createToken: (deadlineSec: number) => string | Promise<string>;
  lifetimeSec?: number;
  refreshBeforeSec?: number;
  now?: () => number;
}

// Caches one auth token and renews it before its deadline. Listeners hear about every new token, so private
// WebSocket channels can resubscribe with it (spec §1.2).
export class LighterAuthTokenManager implements LighterAuthTokenSource {
  private token: string | null = null;
  private deadline = 0;
  private inflight: Promise<string> | null = null;
  private readonly listeners = new Set<(deadlineSec: number) => void>();
  private readonly lifetimeSec: number;
  private readonly refreshBeforeSec: number;
  private readonly now: () => number;

  constructor(private readonly options: LighterAuthTokenManagerOptions) {
    this.lifetimeSec = options.lifetimeSec ?? LIGHTER_AUTH_TOKEN_LIFETIME_SEC;
    this.refreshBeforeSec = options.refreshBeforeSec ?? LIGHTER_AUTH_TOKEN_REFRESH_BEFORE_SEC;
    this.now = options.now ?? Date.now;
    if (this.refreshBeforeSec >= this.lifetimeSec) {
      throw new RangeError('Lighter auth token: refreshBeforeSec must be shorter than lifetimeSec');
    }
  }

  // Unix seconds the current token expires at; 0 without a token
  get deadlineSec(): number {
    return this.token ? this.deadline : 0;
  }

  async getAuthToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    const nowSec = Math.floor(this.now() / 1000);
    if (!options.forceRefresh && this.token && this.deadline - nowSec > this.refreshBeforeSec) {
      return this.token;
    }
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  // Drop the cached token (e.g. after a key change); the next call signs a new one
  invalidate(): void {
    this.token = null;
    this.deadline = 0;
  }

  onRefresh(listener: (deadlineSec: number) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async refresh(): Promise<string> {
    const deadline = Math.floor(this.now() / 1000) + this.lifetimeSec;
    const token = await this.options.createToken(deadline);
    if (typeof token !== 'string' || token === '') {
      throw new Error('Lighter auth token: the signer returned no token');
    }
    this.token = token;
    this.deadline = deadline;
    for (const listener of this.listeners) {
      try {
        listener(deadline);
      } catch (error) {
        logWarnWithTimestamp('Lighter auth token: refresh listener failed:', error instanceof Error ? error.message : String(error));
      }
    }
    return token;
  }
}

// ===== Response shapes (PY openapi.json; fields the bot uses, all optional because nothing is guaranteed) =====

export interface LighterStatusResponse {
  status?: number;
  network_id?: number;
  timestamp?: number;
}

export interface LighterApiKeyInfo {
  account_index?: number;
  api_key_index?: number;
  nonce?: number;
  public_key?: string;
}

export interface LighterAccountPosition {
  market_id?: number;
  symbol?: string;
  initial_margin_fraction?: string;   // Percent string: "20.00" = 5x
  open_order_count?: number;
  pending_order_count?: number;
  sign?: number;                       // -1 short, 1 long
  position?: string;                   // Unsigned size, human units
  avg_entry_price?: string;
  position_value?: string;
  unrealized_pnl?: string;
  realized_pnl?: string;
  liquidation_price?: string;
  total_funding_paid_out?: string;
  margin_mode?: number;                // 0 cross, 1 isolated
  allocated_margin?: string;
}

export interface LighterAccountAsset {
  symbol?: string;
  asset_id?: number;
  balance?: string;
  locked_balance?: string;
  margin_balance?: string;
}

export interface LighterDetailedAccount {
  index?: number;
  account_index?: number;
  l1_address?: string;
  status?: number;
  collateral?: string;
  available_balance?: string;
  total_asset_value?: string;
  cross_asset_value?: string;
  cross_initial_margin_requirement?: string;
  cross_maintenance_margin_requirement?: string;
  account_trading_mode?: number;
  positions?: LighterAccountPosition[];
  assets?: LighterAccountAsset[];
}

export interface LighterOrder {
  order_index?: number;               // Can exceed 2^53: use order_id
  order_id?: string;                  // Decimal string of order_index
  client_order_index?: number;
  client_order_id?: string;
  market_index?: number;
  owner_account_index?: number;
  initial_base_amount?: string;
  remaining_base_amount?: string;
  filled_base_amount?: string;
  filled_quote_amount?: string;
  price?: string;
  is_ask?: boolean;
  type?: string;
  time_in_force?: string;
  reduce_only?: boolean;
  trigger_price?: string;
  order_expiry?: number;
  status?: string;
  trigger_status?: string;
  timestamp?: number;
  created_at?: number;
  updated_at?: number;
  order_version?: number;
  parent_order_id?: string;
}

export interface LighterTx {
  hash?: string;
  type?: number;
  info?: string;
  event_info?: string;                // JSON string: { ae?, code?, message?, ... }
  status?: number;                    // 0 failed, 1 pending, 2 executed, 3 packed, 4 committed, 5 verified
  nonce?: number;
  account_index?: number;
  api_key_index?: number;
  expire_at?: number;
  block_height?: number;
}

export interface LighterSimpleOrder {
  order_id?: string;
  price?: string;
  remaining_base_amount?: string;
  initial_base_amount?: string;
}

export interface LighterOrderBookOrders {
  asks: LighterSimpleOrder[];
  bids: LighterSimpleOrder[];
}

export interface LighterCandle {
  t?: number;
  o?: number | string;
  h?: number | string;
  l?: number | string;
  c?: number | string;
  v?: number | string;     // Omitted on candles without trades
  V?: number | string;
}

export interface LighterTrade {
  trade_id?: number;
  trade_id_str?: string;
  tx_hash?: string;
  type?: string;
  market_id?: number;
  size?: string;
  price?: string;
  usd_amount?: string;
  ask_id_str?: string;
  bid_id_str?: string;
  ask_account_id?: number;
  bid_account_id?: number;
  is_maker_ask?: boolean;
  timestamp?: number;
  taker_fee?: number | string;
  maker_fee?: number | string;
  ask_account_pnl?: string;
  bid_account_pnl?: string;
}

export interface LighterAccountLimits {
  user_tier?: string;
  user_tier_name?: string;
  current_maker_fee_tick?: number;
  current_taker_fee_tick?: number;
}

export interface LighterSystemConfig {
  liquidity_pool_index?: number;
  staking_pool_index?: number;
}

export type LighterCandleResolution = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '12h' | '1d';
export const LIGHTER_CANDLE_RESOLUTIONS: ReadonlyArray<LighterCandleResolution> = ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d'];

// ===== Client =====

export interface LighterHttpClientOptions {
  profile: LighterProfile;
  transport?: LighterHttpTransport;
  auth?: LighterAuthTokenSource;        // Needed for private endpoints only
  timeoutMs?: number;
  // Runs every request (e.g. through a shared rate-limit queue). Default: send directly.
  schedule?: <T>(task: () => Promise<T>) => Promise<T>;
}

type Query = Record<string, string | number | boolean | undefined>;

// Per-call options. timeoutMs can only shorten the client's own timeout (the nonce manager's lock bound).
export interface LighterRequestOptions {
  timeoutMs?: number;
}

export class LighterHttpClient {
  readonly profile: LighterProfile;
  private readonly transport: LighterHttpTransport;
  private readonly auth?: LighterAuthTokenSource;
  private readonly timeoutMs: number;
  private readonly schedule: <T>(task: () => Promise<T>) => Promise<T>;

  constructor(options: LighterHttpClientOptions) {
    this.profile = options.profile;
    this.transport = options.transport ?? defaultLighterHttpTransport;
    this.auth = options.auth;
    this.timeoutMs = options.timeoutMs ?? LIGHTER_HTTP_TIMEOUT_MS;
    this.schedule = options.schedule ?? (task => task());
  }

  // ----- Plumbing -----

  url(path: string, query?: Query): string {
    return lighterRestUrl(this.profile, path, query);
  }

  // Raw request: resolves for every HTTP status, rejects only when no response arrived. That rejection is always a
  // LighterApiError (status null) built from the error code and message: the transport's own error (an AxiosError)
  // carries the request config and headers, which hold the auth token, and would leak it into logs, the error DB
  // and dashboard broadcasts.
  async request(request: Omit<LighterHttpRequest, 'timeoutMs'> & { timeoutMs?: number }): Promise<LighterHttpResponse> {
    try {
      return await this.schedule(() => this.transport({ ...request, timeoutMs: request.timeoutMs ?? this.timeoutMs }));
    } catch (error) {
      throw sanitizeTransportError(pathOf(request.url), error);
    }
  }

  // GET a full URL and return the JSON body; throws LighterApiError (body on error.response.data) unless HTTP 200
  // with code 200 (or no code). Forwards headers. Matches LighterHttpGet (LighterMarketCache) and the account
  // stream's http dependency, which sets its own authorization header.
  readonly get = async (url: string, options: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<unknown> => {
    const response = await this.request({ method: 'GET', url, headers: options.headers, timeoutMs: this.cappedTimeout(options.timeoutMs) });
    return this.expectOk(response, pathOf(url));
  };

  private cappedTimeout(timeoutMs: number | undefined): number | undefined {
    return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, this.timeoutMs)) : undefined;
  }

  private expectOk(response: LighterHttpResponse, path: string): unknown {
    const code = bodyCode(response.data);
    if (response.status === 200 && (code === null || code === 200) && response.data !== null && typeof response.data === 'object') {
      return response.data;
    }
    throw new LighterApiError(path, response.status, code, response.status === 200 && code === null ? 'unexpected response body' : bodyMessage(response.data));
  }

  private async publicGet(path: string, query?: Query, options: LighterRequestOptions = {}): Promise<Record<string, unknown>> {
    return (await this.get(this.url(path, query), { timeoutMs: options.timeoutMs })) as Record<string, unknown>;
  }

  // Private GET with the auth header; one token refresh and retry on the documented auth failure
  private async privateGet(path: string, query?: Query): Promise<Record<string, unknown>> {
    if (!this.auth) {
      throw new LighterApiError(path, null, null, 'this endpoint needs an auth token, but the client has none');
    }
    const url = this.url(path, query);
    let response = await this.request({ method: 'GET', url, headers: { authorization: await this.auth.getAuthToken() } });
    if (isLighterAuthFailure(response)) {
      logWarnWithTimestamp(`Lighter ${path}: auth token rejected, signing a new one and retrying once`);
      response = await this.request({ method: 'GET', url, headers: { authorization: await this.auth.getAuthToken({ forceRefresh: true }) } });
      if (isLighterAuthFailure(response)) {
        throw new LighterApiError(path, response.status, bodyCode(response.data),
          'auth token rejected twice: the API private key does not match the key registered for this account and key index, or the profile is wrong');
      }
    }
    return this.expectOk(response, path) as Record<string, unknown>;
  }

  // ----- Public endpoints -----

  async getStatus(): Promise<LighterStatusResponse> {
    return (await this.publicGet('/')) as LighterStatusResponse;
  }

  async getSystemConfig(): Promise<LighterSystemConfig> {
    return (await this.publicGet('/api/v1/systemConfig')) as LighterSystemConfig;
  }

  // The next nonce to use for (account, key) (spec §5.1)
  async getNextNonce(accountIndex: number, apiKeyIndex: number, options: LighterRequestOptions = {}): Promise<number> {
    const body = await this.publicGet('/api/v1/nextNonce', { account_index: accountIndex, api_key_index: apiKeyIndex }, options);
    const nonce = body.nonce;
    if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce < 0) {
      throw new LighterApiError('/api/v1/nextNonce', 200, bodyCode(body), `invalid nonce ${String(nonce)}`);
    }
    return nonce;
  }

  async getApiKeys(accountIndex: number, apiKeyIndex?: number): Promise<LighterApiKeyInfo[]> {
    const body = await this.publicGet('/api/v1/apikeys', { account_index: accountIndex, api_key_index: apiKeyIndex });
    return Array.isArray(body.api_keys) ? (body.api_keys as LighterApiKeyInfo[]) : [];
  }

  // Positions, collateral and balances. active_only=false also lists flat markets with leverage settings.
  async getAccount(accountIndex: number, options: { activeOnly?: boolean } = {}): Promise<LighterDetailedAccount> {
    const body = await this.publicGet('/api/v1/account', { by: 'index', value: accountIndex, active_only: options.activeOnly ?? false });
    const accounts = Array.isArray(body.accounts) ? (body.accounts as LighterDetailedAccount[]) : [];
    const account = accounts.find(item => item.index === accountIndex || item.account_index === accountIndex) ?? accounts[0];
    if (!account) {
      throw new LighterApiError('/api/v1/account', 200, bodyCode(body), `account ${accountIndex} not found`);
    }
    return account;
  }

  // Tx by hash; null when the exchange doesn't know it (yet). Throws when no answer arrived (unknown).
  async getTx(txHash: string, options: LighterRequestOptions = {}): Promise<LighterTx | null> {
    const path = '/api/v1/tx';
    const response = await this.request({
      method: 'GET', url: this.url(path, { by: 'hash', value: txHash }), timeoutMs: this.cappedTimeout(options.timeoutMs),
    });
    if (response.status >= 500 || response.status === 429 || response.status === 408) {
      throw new LighterApiError(path, response.status, bodyCode(response.data), bodyMessage(response.data));
    }
    if (response.status !== 200 || !isRecord(response.data)) return null;
    const code = bodyCode(response.data);
    if (code !== null && code !== 200) return null;
    const tx = response.data as LighterTx;
    return typeof tx.hash === 'string' && typeof tx.status === 'number' ? tx : null;
  }

  async getOrderBookDetails(marketId?: number): Promise<Record<string, unknown>> {
    return this.publicGet('/api/v1/orderBookDetails', marketId === undefined ? { filter: 'perp' } : { market_id: marketId });
  }

  // Individual resting orders (not price levels), best first per side
  async getOrderBookOrders(marketId: number, limit: number): Promise<LighterOrderBookOrders> {
    const capped = Math.max(1, Math.min(LIGHTER_MAX_ORDER_BOOK_ORDERS, Math.floor(limit)));
    const body = await this.publicGet('/api/v1/orderBookOrders', { market_id: marketId, limit: capped });
    return {
      asks: Array.isArray(body.asks) ? (body.asks as LighterSimpleOrder[]) : [],
      bids: Array.isArray(body.bids) ? (body.bids as LighterSimpleOrder[]) : [],
    };
  }

  async getCandles(
    marketId: number,
    resolution: LighterCandleResolution,
    startTimestampMs: number,
    endTimestampMs: number,
    countBack: number
  ): Promise<LighterCandle[]> {
    const body = await this.publicGet('/api/v1/candles', {
      market_id: marketId,
      resolution,
      start_timestamp: startTimestampMs,
      end_timestamp: endTimestampMs,
      count_back: Math.max(1, Math.min(LIGHTER_MAX_CANDLES, Math.floor(countBack))),
    });
    return Array.isArray(body.c) ? (body.c as LighterCandle[]) : [];
  }

  async getRecentTrades(marketId: number, limit: number): Promise<LighterTrade[]> {
    const body = await this.publicGet('/api/v1/recentTrades', { market_id: marketId, limit: Math.max(1, Math.min(LIGHTER_MAX_PAGE_LIMIT, limit)) });
    return Array.isArray(body.trades) ? (body.trades as LighterTrade[]) : [];
  }

  // ----- Private endpoints (auth header) -----

  async getActiveOrders(accountIndex: number, marketId: number = LIGHTER_ALL_MARKETS_ID): Promise<LighterOrder[]> {
    const body = await this.privateGet('/api/v1/accountActiveOrders', { account_index: accountIndex, market_id: marketId, market_type: 'perp' });
    return Array.isArray(body.orders) ? (body.orders as LighterOrder[]) : [];
  }

  // Our orders by client order index: the last 10K active or 1K inactive orders of the last 24 h (spec §4.1).
  // The primary post-send lookup. Splits into requests of 20 indexes.
  async getOrdersByClientOrderIndex(accountIndex: number, clientOrderIndexes: readonly number[]): Promise<LighterOrder[]> {
    const unique = [...new Set(clientOrderIndexes)];
    const result: LighterOrder[] = [];
    for (let i = 0; i < unique.length; i += LIGHTER_MAX_ORDERS_BY_CLIENT_INDEX) {
      const chunk = unique.slice(i, i + LIGHTER_MAX_ORDERS_BY_CLIENT_INDEX);
      const body = await this.privateGet('/api/v1/accountOrders', { account_index: accountIndex, client_order_indexes: chunk.join(',') });
      if (Array.isArray(body.orders)) result.push(...(body.orders as LighterOrder[]));
    }
    return result;
  }

  async getInactiveOrders(
    accountIndex: number,
    options: { marketId?: number; limit?: number; cursor?: string } = {}
  ): Promise<{ orders: LighterOrder[]; nextCursor: string | null }> {
    const body = await this.privateGet('/api/v1/accountInactiveOrders', {
      account_index: accountIndex,
      market_id: options.marketId,
      limit: Math.max(1, Math.min(LIGHTER_MAX_PAGE_LIMIT, options.limit ?? LIGHTER_MAX_PAGE_LIMIT)),
      cursor: options.cursor,
      market_type: 'perp',
    });
    return {
      orders: Array.isArray(body.orders) ? (body.orders as LighterOrder[]) : [],
      nextCursor: typeof body.next_cursor === 'string' && body.next_cursor !== '' ? body.next_cursor : null,
    };
  }

  // Own fills. order_index_str narrows to one order (exact, unlike the numeric order_index).
  async getAccountTrades(
    accountIndex: number,
    options: { marketId?: number; orderIndex?: string; limit?: number; cursor?: string } = {}
  ): Promise<{ trades: LighterTrade[]; nextCursor: string | null }> {
    const body = await this.privateGet('/api/v1/trades', {
      account_index: accountIndex,
      market_id: options.marketId,
      order_index_str: options.orderIndex,
      sort_by: 'trade_id',
      limit: Math.max(1, Math.min(LIGHTER_MAX_PAGE_LIMIT, options.limit ?? LIGHTER_MAX_PAGE_LIMIT)),
      cursor: options.cursor,
    });
    return {
      trades: Array.isArray(body.trades) ? (body.trades as LighterTrade[]) : [],
      nextCursor: typeof body.next_cursor === 'string' && body.next_cursor !== '' ? body.next_cursor : null,
    };
  }

  // API key indexes of the account that may only place maker orders (spec §8 risk 20)
  async getMakerOnlyApiKeys(accountIndex: number): Promise<number[]> {
    const body = await this.privateGet('/api/v1/getMakerOnlyApiKeys', { account_index: accountIndex });
    return Array.isArray(body.api_key_indexes) ? body.api_key_indexes.filter((v): v is number => typeof v === 'number') : [];
  }

  async getAccountLimits(accountIndex: number): Promise<LighterAccountLimits> {
    return (await this.privateGet('/api/v1/accountLimits', { account_index: accountIndex })) as LighterAccountLimits;
  }

  // ----- Transactions (raw outcome; see txSender.ts) -----

  // POST sendTx, form-encoded, tx_info verbatim. price_protection is omitted in phase 1 (spec §5.2).
  sendTx(txType: number, txInfo: string, options: LighterRequestOptions = {}): Promise<LighterHttpResponse> {
    const body = `tx_type=${encodeURIComponent(String(txType))}&tx_info=${encodeURIComponent(txInfo)}`;
    return this.request({
      method: 'POST',
      url: this.url('/api/v1/sendTx'),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      timeoutMs: this.cappedTimeout(options.timeoutMs),
    });
  }

  // tx_types and tx_infos are JSON arrays; tx_infos holds the signer's strings unchanged (spec §5.2)
  sendTxBatch(txTypes: readonly number[], txInfos: readonly string[], options: LighterRequestOptions = {}): Promise<LighterHttpResponse> {
    if (txTypes.length !== txInfos.length || txTypes.length === 0) {
      return Promise.reject(new RangeError('sendTxBatch needs one tx type per tx info and at least one tx'));
    }
    const body = `tx_types=${encodeURIComponent(JSON.stringify(txTypes))}&tx_infos=${encodeURIComponent(JSON.stringify(txInfos))}`;
    return this.request({
      method: 'POST',
      url: this.url('/api/v1/sendTxBatch'),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      timeoutMs: this.cappedTimeout(options.timeoutMs),
    });
  }
}

// A transport failure as a LighterApiError holding only text: no config, headers, request or cause
export function sanitizeTransportError(path: string, error: unknown): LighterApiError {
  if (error instanceof LighterApiError) return error;
  const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : '';
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'request failed';
  const text = `${code && !message.includes(code) ? `${code} ` : ''}${message}`.replace(/\s+/g, ' ').trim().slice(0, 300);
  return new LighterApiError(path, null, null, `no response (${redactAuth(text) || 'network error'})`);
}

// Belt and braces: an auth token ("<deadline>:<account>:<key>:<160 hex>") never survives into an error message
function redactAuth(text: string): string {
  return text.replace(/\b\d+:\d+:\d+:[0-9a-fA-F]{40,}\b/g, '<auth token>');
}

function pathOf(url: string): string {
  const withoutQuery = url.split('?')[0];
  const match = /^https?:\/\/[^/]+(\/.*)?$/.exec(withoutQuery);
  return match ? match[1] ?? '/' : withoutQuery;
}
