import { logWarnWithTimestamp } from '../../utils/timestamp';
import type { LighterHttpClient, LighterHttpResponse, LighterOrder, LighterRequestOptions, LighterTx } from './http';
import { LIGHTER_INVALID_NONCE_CODE, type LighterSendOutcome } from './nonce';
import type { LighterSignedTx } from './signer';

// Submitting signed txs (lighter spec §5.2) and confirming them (§5.3).
//
// A 200 from sendTx only means the exchange accepted the tx into its queue. Nothing is reported as placed,
// cancelled or changed until the tx has executed (GET /api/v1/tx, or the account_tx stream) and, for orders,
// the order itself has been read back by client order index.

export const LIGHTER_CONFIRM_TIMEOUT_MS = 15_000;       // FE TX_TIMEOUT (TS src/constants/order.ts)
export const LIGHTER_CONFIRM_POLL_MS = 500;
export const LIGHTER_MAX_TXS_PER_BATCH = 50;             // error 21514 above
export const LIGHTER_SEND_TX_PER_MINUTE = 60;            // Conservative default until the standard-tier limit is known
export const LIGHTER_SEND_TX_BURST = 10;

export const LIGHTER_TX_STATUS = Object.freeze({
  FAILED: 0,
  PENDING: 1,
  EXECUTED: 2,
  PACKED: 3,
  COMMITTED: 4,
  VERIFIED: 5,
} as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(data: unknown, fallback: string): string {
  if (isRecord(data) && typeof data.message === 'string' && data.message !== '') return data.message;
  if (typeof data === 'string' && data !== '') return data.length > 200 ? `${data.slice(0, 200)}...` : data;
  return fallback;
}

// sendTx / sendTxBatch response -> outcome (spec §5.1):
//   HTTP 200 + code 200                -> accepted
//   code 21104 (HTTP 200 or 400)       -> invalid nonce: not executed
//   HTTP 400 or other 4xx, code != 200 -> rejected: not executed, nonce not consumed
//   timeout, 408, 429, 5xx, bad body   -> unknown
export function classifySendResponse(response: LighterHttpResponse): LighterSendOutcome {
  const { status, data } = response;
  const code = isRecord(data) && typeof data.code === 'number' ? data.code : null;
  if (status === 408 || status === 429 || status >= 500) {
    return { kind: 'unknown', status, reason: `HTTP ${status}: ${messageOf(data, 'no message')}` };
  }
  if (code === LIGHTER_INVALID_NONCE_CODE) {
    return { kind: 'invalid-nonce', status, code, message: messageOf(data, 'invalid nonce') };
  }
  if (status === 200) {
    if (code === 200 && isRecord(data)) {
      const hashes = Array.isArray(data.tx_hash)
        ? data.tx_hash.filter((h): h is string => typeof h === 'string')
        : typeof data.tx_hash === 'string' ? [data.tx_hash] : [];
      return {
        kind: 'accepted',
        txHashes: hashes,
        predictedExecutionTimeMs: typeof data.predicted_execution_time_ms === 'number' ? data.predicted_execution_time_ms : undefined,
        volumeQuotaRemaining: typeof data.volume_quota_remaining === 'number' ? data.volume_quota_remaining : undefined,
      };
    }
    if (code === null) {
      return { kind: 'unknown', status, reason: 'HTTP 200 without a result code' };
    }
    return { kind: 'rejected', status, code, message: messageOf(data, `code ${code}`) };
  }
  if (status >= 400) {
    return { kind: 'rejected', status, code, message: messageOf(data, `HTTP ${status}`) };
  }
  return { kind: 'unknown', status, reason: `unexpected HTTP ${status}` };
}

// One token bucket per API key for sendTx and sendTxBatch (spec §1.3). A batch takes one token per call.
export class LighterSendRateLimiter {
  private tokens: number;
  private updatedAt: number;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly ratePerMs: number;

  constructor(
    private readonly options: {
      perMinute?: number;
      burst?: number;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    } = {}
  ) {
    const perMinute = options.perMinute ?? LIGHTER_SEND_TX_PER_MINUTE;
    const burst = options.burst ?? LIGHTER_SEND_TX_BURST;
    if (!(perMinute > 0) || !(burst >= 1)) throw new RangeError('Lighter send limiter: perMinute must be > 0 and burst >= 1');
    this.ratePerMs = perMinute / 60_000;
    this.tokens = burst;
    this.updatedAt = this.now();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private get burst(): number {
    return this.options.burst ?? LIGHTER_SEND_TX_BURST;
  }

  private refill(): void {
    const now = this.now();
    this.tokens = Math.min(this.burst, this.tokens + (now - this.updatedAt) * this.ratePerMs);
    this.updatedAt = now;
  }

  // Resolves once a token is available (callers queue in order)
  take(): Promise<void> {
    const run = this.tail.then(async () => {
      this.refill();
      while (this.tokens < 1) {
        const waitMs = Math.ceil((1 - this.tokens) / this.ratePerMs);
        await (this.options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))))(waitMs);
        this.refill();
      }
      this.tokens -= 1;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}

export type LighterTxConfirmation =
  | { status: 'executed'; tx: LighterTx }
  | { status: 'failed'; tx: LighterTx; code: number | null; message: string }
  | { status: 'timeout'; lastSeen: LighterTx | null };

// Optional faster path: resolves with the tx once the account_tx stream reports it (or never)
export type LighterTxWatcher = (txHash: string, timeoutMs: number) => Promise<LighterTx | null>;

export interface LighterTxSenderOptions {
  http: LighterHttpClient;
  limiter?: LighterSendRateLimiter;
  txWatcher?: LighterTxWatcher;
  confirmTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// event_info of a failed tx: { ae?: app error, code?, message? }
export function parseTxEventInfo(tx: LighterTx): { appError: string | null; code: number | null; message: string | null } {
  if (typeof tx.event_info !== 'string' || tx.event_info === '') return { appError: null, code: null, message: null };
  try {
    const info = JSON.parse(tx.event_info);
    if (!isRecord(info)) return { appError: null, code: null, message: null };
    return {
      appError: typeof info.ae === 'string' && info.ae !== '' ? info.ae : null,
      code: typeof info.code === 'number' ? info.code : null,
      message: typeof info.message === 'string' && info.message !== '' ? info.message : null,
    };
  } catch {
    return { appError: null, code: null, message: null };
  }
}

// Executed, failed or still pending (FE checkTxStatus: status 0 or an app error is a failure)
export function txExecutionState(tx: LighterTx): 'executed' | 'failed' | 'pending' {
  const { appError } = parseTxEventInfo(tx);
  if (tx.status === LIGHTER_TX_STATUS.FAILED || appError) return 'failed';
  if (typeof tx.status === 'number' && tx.status >= LIGHTER_TX_STATUS.EXECUTED) return 'executed';
  return 'pending';
}

export class LighterTxSender {
  private readonly http: LighterHttpClient;
  private readonly limiter: LighterSendRateLimiter;
  private readonly confirmTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: LighterTxSenderOptions) {
    this.http = options.http;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    this.limiter = options.limiter ?? new LighterSendRateLimiter({ now: this.now, sleep: this.sleep });
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? LIGHTER_CONFIRM_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? LIGHTER_CONFIRM_POLL_MS;
  }

  // POST sendTx. Never throws for an HTTP answer; a transport failure is an 'unknown' outcome.
  async send(tx: LighterSignedTx, options: LighterRequestOptions = {}): Promise<LighterSendOutcome> {
    await this.limiter.take();
    try {
      return classifySendResponse(await this.http.sendTx(tx.txType, tx.txInfo, options));
    } catch (error) {
      return { kind: 'unknown', status: null, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async sendBatch(txs: LighterSignedTx[], options: LighterRequestOptions = {}): Promise<LighterSendOutcome> {
    if (txs.length === 0 || txs.length > LIGHTER_MAX_TXS_PER_BATCH) {
      throw new RangeError(`sendTxBatch takes 1..${LIGHTER_MAX_TXS_PER_BATCH} txs, got ${txs.length}`);
    }
    await this.limiter.take();
    try {
      return classifySendResponse(await this.http.sendTxBatch(txs.map(tx => tx.txType), txs.map(tx => tx.txInfo), options));
    } catch (error) {
      return { kind: 'unknown', status: null, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  lookupTx(txHash: string, options: LighterRequestOptions = {}): Promise<LighterTx | null> {
    return this.http.getTx(txHash, options);
  }

  // Wait until the tx has executed or failed (spec §5.3 step 1), polling GET /tx (and the stream watcher when
  // one is configured) for up to timeoutMs (15 s by default).
  async confirmTx(txHash: string, options: { timeoutMs?: number } = {}): Promise<LighterTxConfirmation> {
    const timeoutMs = options.timeoutMs ?? this.confirmTimeoutMs;
    const deadline = this.now() + timeoutMs;
    let lastSeen: LighterTx | null = null;
    let watched: LighterTx | null = null;
    if (this.options.txWatcher) {
      this.options.txWatcher(txHash, timeoutMs)
        .then(tx => {
          watched = tx;
        })
        .catch(() => undefined);
    }
    for (;;) {
      const candidates: LighterTx[] = [];
      if (watched) candidates.push(watched);
      try {
        const polled = await this.http.getTx(txHash);
        if (polled) candidates.push(polled);
      } catch (error) {
        logWarnWithTimestamp(`Lighter: tx status lookup failed (will retry): ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const tx of candidates) {
        lastSeen = tx;
        const state = txExecutionState(tx);
        if (state === 'executed') return { status: 'executed', tx };
        if (state === 'failed') {
          const info = parseTxEventInfo(tx);
          return {
            status: 'failed',
            tx,
            code: info.code,
            message: info.message ?? info.appError ?? 'transaction failed',
          };
        }
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) return { status: 'timeout', lastSeen };
      await this.sleep(Math.min(this.pollIntervalMs, remaining));
    }
  }

  // Read our orders back by client order index (spec §5.3 step 2). Polls until `done(found)` holds or the
  // timeout passes; returns what was found, keyed by client order index.
  async findOrders(
    accountIndex: number,
    clientOrderIndexes: readonly number[],
    options: { timeoutMs?: number; done?: (found: Map<number, LighterOrder>) => boolean } = {}
  ): Promise<Map<number, LighterOrder>> {
    const done = options.done ?? (found => clientOrderIndexes.every(coi => found.has(coi)));
    const deadline = this.now() + (options.timeoutMs ?? this.confirmTimeoutMs);
    const found = new Map<number, LighterOrder>();
    for (;;) {
      try {
        const orders = await this.http.getOrdersByClientOrderIndex(accountIndex, clientOrderIndexes);
        for (const order of orders) {
          const coi = order.client_order_index;
          if (typeof coi === 'number' && clientOrderIndexes.includes(coi)) found.set(coi, order);
        }
      } catch (error) {
        logWarnWithTimestamp(`Lighter: order lookup failed (will retry): ${error instanceof Error ? error.message : String(error)}`);
      }
      if (done(found)) return found;
      const remaining = deadline - this.now();
      if (remaining <= 0) return found;
      await this.sleep(Math.min(this.pollIntervalMs, remaining));
    }
  }
}
