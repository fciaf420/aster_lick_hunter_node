import * as fs from 'fs';
import * as nodeModule from 'module';
import * as path from 'path';
import { logErrorWithTimestamp, logWarnWithTimestamp, logWithTimestamp } from '../../utils/timestamp';
import type { LighterSignedTx } from './signer';
import type { LighterTx } from './http';

// Nonce flow for Lighter transactions (lighter spec §5.1), one manager per (account, API key):
//
//   1. sign(nonce = n). The tx hash is known before sending; the signed tx is persisted first.
//   2. POST sendTx, then:
//      - accepted (HTTP 200, code 200)        -> n = n + 1
//      - invalid nonce (code 21104)           -> not executed: fetch nextNonce, sign again, resend (at most 3 times)
//      - any other rejection                  -> not executed, nonce not consumed: keep n, surface the error
//      - unknown (timeout, 5xx, 429, network) -> never sign a new tx for it (a duplicate order). Instead:
//          a. GET /tx by hash: found means accepted
//          b. GET nextNonce: above n means accepted
//          c. otherwise resend the identical tx_info until its ExpiredAt
//        A rejected resend proves nothing on its own: the original may be queued and nextNonce may lag it (resend
//        idempotency is unverified, spec §9 Q9). Resending stops and a and b keep polling. nextNonce staying at or
//        below n for 3 reads over at least 10 s after the refusal counts as "presumed not executed"; only a
//        rejection of the first send is final.
//      The lock is held for at most 45 s of this. After that (or once presumed not executed) the key is released,
//      nextNonce is re-read for the next tx, and the tx is watched in the background until its ExpiredAt without
//      ever being resent or re-signed. If it executes after all, that is logged and reported (onLateOutcome) and
//      the position it opened is protected by the position manager's periodic sync, like any untracked position.
//      Once a later tx of ours is accepted with the same nonce, the abandoned one can no longer execute.
//
// One async mutex per (account, key) is held across sign and send, so nonces are used strictly in order.
// Every dependent flow (entry, SL/TP, cancels, leverage) must go through the same key: ordering is only
// guaranteed within a key. Never pass nonce -1 or skip_nonce (the signer refuses both anyway).

export const LIGHTER_INVALID_NONCE_CODE = 21104;
export const LIGHTER_MAX_NONCE_RETRIES = 3;
export const LIGHTER_RESEND_DELAYS_MS: ReadonlyArray<number> = [1000, 2000, 4000, 5000];
// nextNonce can lag an accepted tx briefly, so an expired tx is only written off this long after ExpiredAt
export const LIGHTER_EXPIRY_GRACE_MS = 5000;
// Longest time the per-key lock is held resolving an unknown outcome. SL/TP, cancels and closes on the key wait
// behind it, so the rest of the resolution happens in the background.
export const LIGHTER_MAX_LOCKED_RESOLVE_MS = 45_000;
// After a refused resend: nextNonce at or below the tx's nonce on this many reads in a row, spanning at least this
// long, means the tx is presumed not executed
export const LIGHTER_REFUSAL_SETTLE_READS = 3;
export const LIGHTER_REFUSAL_SETTLE_MS = 10_000;
// Poll interval while a released tx is settled in the background
export const LIGHTER_BACKGROUND_POLL_MS = 5000;
// Shortest per-request timeout while the lock bound runs out
export const LIGHTER_MIN_CALL_TIMEOUT_MS = 1000;

// ===== Send outcomes (classified by txSender.ts) =====

export type LighterSendOutcome =
  | { kind: 'accepted'; txHashes: string[]; predictedExecutionTimeMs?: number; volumeQuotaRemaining?: number }
  | { kind: 'invalid-nonce'; status: number; code: number; message: string }
  | { kind: 'rejected'; status: number; code: number | null; message: string }
  | { kind: 'unknown'; status: number | null; reason: string };

// ===== Errors =====

interface BinanceStyleErrorData {
  code: number | null;
  msg: string;
  message: string;
}

interface LighterTxErrorOptions {
  code?: number | null;
  status?: number | null;
  txHash?: string | null;
  detail?: string;
  orderMayExist?: boolean;
  expiredAt?: number | null;   // ms; the signed tx's ExpiredAt, when known
}

// orderMayExist (see exchange/orderErrors.ts): true unless the error proves nothing was placed. The base class is
// used for unconfirmed outcomes, so it defaults to true.
export class LighterTxError extends Error {
  readonly code: number | null;
  readonly txHash: string | null;
  readonly orderMayExist: boolean;
  readonly expiredAt: number | null;
  readonly response: { status: number | null; data: BinanceStyleErrorData };

  constructor(message: string, options: LighterTxErrorOptions = {}) {
    super(message);
    this.name = 'LighterTxError';
    this.code = options.code ?? null;
    this.txHash = options.txHash ?? null;
    this.orderMayExist = options.orderMayExist ?? true;
    this.expiredAt = typeof options.expiredAt === 'number' && options.expiredAt > 0 ? options.expiredAt : null;
    const detail = options.detail ?? message;
    this.response = { status: options.status ?? null, data: { code: this.code, msg: detail, message: detail } };
  }

  // Until when the tx (and any order it places) may still execute: ExpiredAt plus the grace nextNonce may lag by
  get mayExistUntil(): number | null {
    return this.orderMayExist && this.expiredAt !== null ? this.expiredAt + LIGHTER_EXPIRY_GRACE_MS : null;
  }
}

// The exchange refused the tx. It was not executed and its nonce was not consumed. orderMayExist is only set for
// the inferred case (a refused resend while nextNonce stood still), where the original could still land.
export class LighterTxRejectedError extends LighterTxError {
  constructor(message: string, options: LighterTxErrorOptions = {}) {
    super(message, { ...options, orderMayExist: options.orderMayExist ?? false });
    this.name = 'LighterTxRejectedError';
  }
}

// The exchange accepted the tx and then reported its execution as failed (tx status 0 or an app error)
export class LighterTxFailedError extends LighterTxError {
  constructor(message: string, options: Omit<LighterTxErrorOptions, 'orderMayExist' | 'status'> = {}) {
    super(message, { ...options, orderMayExist: false });
    this.name = 'LighterTxFailedError';
  }
}

// The tx may or may not have been executed. Do not retry it with a new nonce; reconcile from account state.
export class LighterTxUnknownError extends LighterTxError {
  constructor(message: string, options: Omit<LighterTxErrorOptions, 'orderMayExist' | 'code' | 'status'> = {}) {
    super(message, { ...options, orderMayExist: true });
    this.name = 'LighterTxUnknownError';
  }
}

// ===== Journal: signed txs and client order indexes, persisted before sending =====

export type LighterTxState = 'signed' | 'accepted' | 'rejected' | 'unknown' | 'expired' | 'abandoned';

export interface LighterTxRecord {
  txHash: string;
  txType: number;
  txInfo: string;
  nonce: number;
  expiredAt: number;
  accountIndex: number;
  apiKeyIndex: number;
  createdAt: number;
  state: LighterTxState;
  detail?: string;
  clientOrderIndexes?: number[];
}

// 1 entry, 2 stop loss, 3 take profit, 4 close or other (spec §5.6)
export type LighterOrderRole = 1 | 2 | 3 | 4;
export const LIGHTER_ORDER_ROLE = Object.freeze({ ENTRY: 1, STOP_LOSS: 2, TAKE_PROFIT: 3, OTHER: 4 } as const);

export interface LighterClientOrderRecord {
  clientOrderIndex: number;
  botClientOrderId: string;   // e.g. al_sl_BTCUSDT_123; '' when the bot gave none
  symbol: string;
  marketId: number;
  role: LighterOrderRole;
  createdAt: number;
}

export interface LighterTxJournal {
  // Synchronous on purpose: the record must exist before the tx leaves the process
  recordSigned(record: Omit<LighterTxRecord, 'state' | 'detail'>): void;
  markState(txHash: string, state: LighterTxState, detail?: string): void;
  get(txHash: string): LighterTxRecord | undefined;
  // Records still 'signed' or 'unknown' (crashed or unresolved sends)
  unresolved(accountIndex: number, apiKeyIndex: number): LighterTxRecord[];
  saveClientOrder(record: LighterClientOrderRecord): void;
  getClientOrder(clientOrderIndex: number): LighterClientOrderRecord | undefined;
  close?(): void;
}

const UNRESOLVED_STATES: ReadonlySet<LighterTxState> = new Set(['signed', 'unknown']);
const JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// In-process journal (tests, and a fallback when SQLite is unavailable). Lost on restart.
export class MemoryLighterTxJournal implements LighterTxJournal {
  private readonly txs = new Map<string, LighterTxRecord>();
  private readonly orders = new Map<number, LighterClientOrderRecord>();

  constructor(private readonly maxEntries = 10_000) {}

  recordSigned(record: Omit<LighterTxRecord, 'state' | 'detail'>): void {
    this.txs.set(record.txHash, { ...record, state: 'signed' });
    this.trim(this.txs);
  }

  markState(txHash: string, state: LighterTxState, detail?: string): void {
    const record = this.txs.get(txHash);
    if (record) this.txs.set(txHash, { ...record, state, detail });
  }

  get(txHash: string): LighterTxRecord | undefined {
    return this.txs.get(txHash);
  }

  unresolved(accountIndex: number, apiKeyIndex: number): LighterTxRecord[] {
    return [...this.txs.values()].filter(record =>
      record.accountIndex === accountIndex && record.apiKeyIndex === apiKeyIndex && UNRESOLVED_STATES.has(record.state));
  }

  saveClientOrder(record: LighterClientOrderRecord): void {
    this.orders.set(record.clientOrderIndex, { ...record });
    this.trim(this.orders);
  }

  getClientOrder(clientOrderIndex: number): LighterClientOrderRecord | undefined {
    return this.orders.get(clientOrderIndex);
  }

  private trim<K, V>(map: Map<K, V>): void {
    while (map.size > this.maxEntries) {
      const oldest = map.keys().next().value as K;
      map.delete(oldest);
    }
  }
}

export const LIGHTER_JOURNAL_DEFAULT_PATH = path.join('data', 'lighter.db');

// SQLite journal (better-sqlite3, synchronous). Default file data/lighter.db (git-ignored by data/*.db).
// better-sqlite3 is resolved at construction through createRequire, so importing this module never pulls a
// native module into a Next.js bundle.
export class SqliteLighterTxJournal implements LighterTxJournal {
  private readonly db: any;
  private readonly statements: Record<string, any>;
  private readonly profile: string;

  constructor(options: { filePath?: string; profile: string; now?: () => number }) {
    this.profile = options.profile;
    const filePath = path.resolve(options.filePath ?? LIGHTER_JOURNAL_DEFAULT_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const anchor = typeof __filename === 'string' && path.isAbsolute(__filename) ? __filename : path.join(process.cwd(), 'package.json');
    const BetterSqlite3 = nodeModule.createRequire(anchor)('better-sqlite3');
    this.db = new BetterSqlite3(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lighter_txs (
        tx_hash TEXT PRIMARY KEY,
        profile TEXT NOT NULL,
        account_index INTEGER NOT NULL,
        api_key_index INTEGER NOT NULL,
        tx_type INTEGER NOT NULL,
        tx_info TEXT NOT NULL,
        nonce INTEGER NOT NULL,
        expired_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        state TEXT NOT NULL,
        detail TEXT,
        client_order_indexes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_lighter_txs_state ON lighter_txs(profile, account_index, api_key_index, state);
      CREATE TABLE IF NOT EXISTS lighter_client_orders (
        profile TEXT NOT NULL,
        client_order_index INTEGER NOT NULL,
        bot_client_order_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        market_id INTEGER NOT NULL,
        role INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (profile, client_order_index)
      );
    `);
    this.statements = {
      insertTx: this.db.prepare(`INSERT OR REPLACE INTO lighter_txs
        (tx_hash, profile, account_index, api_key_index, tx_type, tx_info, nonce, expired_at, created_at, state, detail, client_order_indexes)
        VALUES (@txHash, @profile, @accountIndex, @apiKeyIndex, @txType, @txInfo, @nonce, @expiredAt, @createdAt, 'signed', NULL, @clientOrderIndexes)`),
      markState: this.db.prepare('UPDATE lighter_txs SET state = ?, detail = ? WHERE tx_hash = ?'),
      getTx: this.db.prepare('SELECT * FROM lighter_txs WHERE tx_hash = ?'),
      unresolved: this.db.prepare(`SELECT * FROM lighter_txs WHERE profile = ? AND account_index = ? AND api_key_index = ?
        AND state IN ('signed', 'unknown') ORDER BY nonce`),
      saveOrder: this.db.prepare(`INSERT OR REPLACE INTO lighter_client_orders
        (profile, client_order_index, bot_client_order_id, symbol, market_id, role, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`),
      getOrder: this.db.prepare('SELECT * FROM lighter_client_orders WHERE profile = ? AND client_order_index = ?'),
    };
    const cutoff = (options.now ?? Date.now)() - JOURNAL_RETENTION_MS;
    this.db.prepare(`DELETE FROM lighter_txs WHERE created_at < ? AND state NOT IN ('signed', 'unknown')`).run(cutoff);
    this.db.prepare('DELETE FROM lighter_client_orders WHERE created_at < ?').run(cutoff);
  }

  recordSigned(record: Omit<LighterTxRecord, 'state' | 'detail'>): void {
    this.statements.insertTx.run({
      txHash: record.txHash,
      profile: this.profile,
      accountIndex: record.accountIndex,
      apiKeyIndex: record.apiKeyIndex,
      txType: record.txType,
      txInfo: record.txInfo,
      nonce: record.nonce,
      expiredAt: record.expiredAt,
      createdAt: record.createdAt,
      clientOrderIndexes: record.clientOrderIndexes ? JSON.stringify(record.clientOrderIndexes) : null,
    });
  }

  markState(txHash: string, state: LighterTxState, detail?: string): void {
    this.statements.markState.run(state, detail ?? null, txHash);
  }

  get(txHash: string): LighterTxRecord | undefined {
    const row = this.statements.getTx.get(txHash);
    return row ? rowToTxRecord(row) : undefined;
  }

  unresolved(accountIndex: number, apiKeyIndex: number): LighterTxRecord[] {
    return this.statements.unresolved.all(this.profile, accountIndex, apiKeyIndex).map(rowToTxRecord);
  }

  saveClientOrder(record: LighterClientOrderRecord): void {
    this.statements.saveOrder.run(this.profile, record.clientOrderIndex, record.botClientOrderId, record.symbol,
      record.marketId, record.role, record.createdAt);
  }

  getClientOrder(clientOrderIndex: number): LighterClientOrderRecord | undefined {
    const row = this.statements.getOrder.get(this.profile, clientOrderIndex);
    if (!row) return undefined;
    return {
      clientOrderIndex: Number(row.client_order_index),
      botClientOrderId: String(row.bot_client_order_id),
      symbol: String(row.symbol),
      marketId: Number(row.market_id),
      role: Number(row.role) as LighterOrderRole,
      createdAt: Number(row.created_at),
    };
  }

  close(): void {
    this.db.close();
  }
}

function rowToTxRecord(row: any): LighterTxRecord {
  return {
    txHash: String(row.tx_hash),
    txType: Number(row.tx_type),
    txInfo: String(row.tx_info),
    nonce: Number(row.nonce),
    expiredAt: Number(row.expired_at),
    accountIndex: Number(row.account_index),
    apiKeyIndex: Number(row.api_key_index),
    createdAt: Number(row.created_at),
    state: String(row.state) as LighterTxState,
    detail: row.detail === null || row.detail === undefined ? undefined : String(row.detail),
    clientOrderIndexes: row.client_order_indexes ? JSON.parse(String(row.client_order_indexes)) : undefined,
  };
}

// ===== Client order indexes (spec §5.6) =====

export const LIGHTER_MAX_CLIENT_ORDER_INDEX = 2 ** 48 - 1;

// coi = (floor(now / 10) * 10 + role) * 10 + seq: the 10 ms bucket with its last digit replaced by the role,
// then a sequence digit. About 1.8e13 today, far below 2^48 - 1. seq runs 0..9 per (bucket, role); an 11th
// index in the same 10 ms borrows the next bucket, so indexes never repeat within a process.
export class LighterClientOrderIndexGenerator {
  private readonly last = new Map<LighterOrderRole, { bucket: number; seq: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  next(role: LighterOrderRole): number {
    if (role !== 1 && role !== 2 && role !== 3 && role !== 4) {
      throw new RangeError(`Invalid client order index role ${String(role)}`);
    }
    let bucket = Math.floor(this.now() / 10);
    let seq = 0;
    const previous = this.last.get(role);
    if (previous && bucket <= previous.bucket) {
      bucket = previous.bucket;
      seq = previous.seq + 1;
      if (seq > 9) {
        bucket += 1;
        seq = 0;
      }
    }
    this.last.set(role, { bucket, seq });
    const coi = (bucket * 10 + role) * 10 + seq;
    if (!Number.isSafeInteger(coi) || coi < 1 || coi > LIGHTER_MAX_CLIENT_ORDER_INDEX) {
      throw new RangeError(`Client order index ${coi} is outside 1..${LIGHTER_MAX_CLIENT_ORDER_INDEX}`);
    }
    return coi;
  }
}

// Role digit of a client order index made by LighterClientOrderIndexGenerator (undefined for other values)
export function clientOrderIndexRole(coi: number): LighterOrderRole | undefined {
  if (!Number.isSafeInteger(coi) || coi < 100) return undefined;
  const role = Math.floor(coi / 10) % 10;
  return role >= 1 && role <= 4 ? (role as LighterOrderRole) : undefined;
}

// ===== Nonce manager =====

// Per-call timeout, derived from what is left of the lock bound while an unknown outcome is resolved
export interface LighterCallOptions {
  timeoutMs?: number;
}

export interface LighterNonceManagerOptions {
  accountIndex: number;
  apiKeyIndex: number;
  fetchNextNonce: (options?: LighterCallOptions) => Promise<number>;
  send: (tx: LighterSignedTx, options?: LighterCallOptions) => Promise<LighterSendOutcome>;
  sendBatch?: (txs: LighterSignedTx[], options?: LighterCallOptions) => Promise<LighterSendOutcome>;
  lookupTx: (txHash: string, options?: LighterCallOptions) => Promise<LighterTx | null>;   // throws when the lookup itself failed
  journal: LighterTxJournal;
  maxNonceRetries?: number;
  resendDelaysMs?: ReadonlyArray<number>;
  expiryGraceMs?: number;
  maxLockedResolveMs?: number;
  backgroundPollMs?: number;
  // Outcome of a tx the bot stopped waiting for (see the unknown-outcome notes above)
  onLateOutcome?: (outcome: LighterLateOutcome) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface LighterLateOutcome {
  txHash: string;
  nonce: number;
  clientOrderIndexes?: number[];
  outcome: 'executed' | 'not-executed' | 'unknown';
  detail: string;
}

export type LighterResolution = 'response' | 'tx-lookup' | 'next-nonce' | 'resend';

export interface LighterTxSubmission {
  tx: LighterSignedTx;
  resolvedBy: LighterResolution;
  nonceRetries: number;
  resends: number;
}

export interface LighterBatchSubmission {
  txs: LighterSignedTx[];
  resolvedBy: LighterResolution;
  nonceRetries: number;
  resends: number;
}

export type LighterTxBuilder = (nonce: number) => LighterSignedTx;

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
// Background settling must not keep the process alive
const unrefSleep = (ms: number) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

const latestExpiry = (txs: LighterSignedTx[]) => Math.max(...txs.map(tx => tx.expiredAt));

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ResolveResult =
  | { kind: 'accepted'; by: LighterResolution; resends: number; acceptedThrough: number }
  | { kind: 'expired'; resends: number; resendRefusal: string | null }
  | { kind: 'presumed-not-executed'; resends: number; resendRefusal: string }
  | { kind: 'released'; reason: string; resends: number; acceptedThrough: number }   // lock bound reached; settled in the background
  | { kind: 'unknown'; reason: string; resends: number };

interface NonceEvent {
  nonce: number;
  txHash: string;
  kind: 'signed' | 'accepted' | 'invalid-nonce';
  at: number;
}

const MAX_NONCE_EVENTS = 500;

export class LighterNonceManager {
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  private nextNonce: number | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly maxNonceRetries: number;
  private readonly resendDelaysMs: ReadonlyArray<number>;
  private readonly expiryGraceMs: number;
  private readonly maxLockedResolveMs: number;
  private readonly backgroundPollMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  // Recent nonce use by this manager, the evidence for settling released txs in the background
  private readonly nonceEvents: NonceEvent[] = [];
  private readonly backgroundSettles = new Set<Promise<void>>();
  private readonly backgroundSleep: (ms: number) => Promise<void>;
  // Bumped on every signature, so a background nextNonce read that overlapped a new tx can be discarded
  private signGeneration = 0;
  private disposed = false;

  constructor(private readonly options: LighterNonceManagerOptions) {
    this.accountIndex = options.accountIndex;
    this.apiKeyIndex = options.apiKeyIndex;
    this.maxNonceRetries = options.maxNonceRetries ?? LIGHTER_MAX_NONCE_RETRIES;
    this.resendDelaysMs = options.resendDelaysMs ?? LIGHTER_RESEND_DELAYS_MS;
    this.expiryGraceMs = options.expiryGraceMs ?? LIGHTER_EXPIRY_GRACE_MS;
    this.maxLockedResolveMs = options.maxLockedResolveMs ?? LIGHTER_MAX_LOCKED_RESOLVE_MS;
    this.backgroundPollMs = options.backgroundPollMs ?? LIGHTER_BACKGROUND_POLL_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.backgroundSleep = options.sleep ?? unrefSleep;
  }

  // Stop settling released txs in the background (adapter or bot shutdown). Unresolved ones stay 'unknown' in
  // the journal for the next start's reconcile.
  dispose(): void {
    this.disposed = true;
  }

  // Resolves once every tx released to the background has been settled (tests, shutdown)
  whenSettled(): Promise<void> {
    return Promise.all([...this.backgroundSettles]).then(() => undefined);
  }

  // Number of released txs still being settled in the background
  get settlingCount(): number {
    return this.backgroundSettles.size;
  }

  // The nonce the next tx will use, or null until it has been fetched (or after a desync)
  get currentNonce(): number | null {
    return this.nextNonce;
  }

  // Forget the local counter; the next tx fetches nextNonce first
  invalidate(): void {
    this.nextNonce = null;
  }

  // Run fn with the (account, key) lock held. Calls queue in order; a failure does not block the queue.
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  // Sign, persist and send one tx under the lock (spec §5.1). Resolves once the exchange accepted it;
  // execution still has to be confirmed (txSender.confirmTx). Throws LighterTxRejectedError when it was not
  // executed and LighterTxUnknownError when that cannot be decided. Signer errors propagate unchanged.
  submit(build: LighterTxBuilder, meta: { clientOrderIndexes?: number[] } = {}): Promise<LighterTxSubmission> {
    return this.runExclusive(async () => {
      let nonceRetries = 0;
      for (;;) {
        const nonce = await this.ensureNonce();
        const tx = this.signAndRecord(build, nonce, meta.clientOrderIndexes);
        const outcome = await this.safeSend(() => this.options.send(tx));
        try {
        switch (outcome.kind) {
          case 'accepted':
            this.nextNonce = nonce + 1;
            this.recordNonceEvent(tx, 'accepted');
            this.journalMark(tx.txHash, 'accepted');
            return { tx, resolvedBy: 'response', nonceRetries, resends: 0 };
          case 'invalid-nonce':
            this.journalMark(tx.txHash, 'rejected', `invalid nonce: ${outcome.message}`);
            this.recordNonceEvent(tx, 'invalid-nonce');
            if (nonceRetries >= this.maxNonceRetries) {
              this.nextNonce = null;
              throw new LighterTxRejectedError(
                `Lighter rejected nonce ${nonce} ${nonceRetries + 1} times (account ${this.accountIndex}, key ${this.apiKeyIndex}): ${outcome.message}`,
                { code: outcome.code, status: outcome.status, txHash: tx.txHash, detail: outcome.message }
              );
            }
            nonceRetries++;
            logWarnWithTimestamp(`Lighter: nonce ${nonce} rejected as invalid (code ${outcome.code}); fetching nextNonce and signing again (retry ${nonceRetries}/${this.maxNonceRetries})`);
            this.nextNonce = await this.refetchAfterInvalidNonce(outcome, tx.txHash);
            continue;
          case 'rejected':
            this.journalMark(tx.txHash, 'rejected', outcome.message);
            throw new LighterTxRejectedError(`Lighter rejected the tx: ${outcome.message}`, {
              code: outcome.code, status: outcome.status, txHash: tx.txHash, detail: outcome.message,
            });
          case 'unknown': {
            logWarnWithTimestamp(`Lighter: outcome of tx ${tx.txHash.slice(0, 16)}... (nonce ${nonce}) is unknown (${outcome.reason}); resolving without signing a new tx`);
            const resolved = await this.resolveUnknown([tx]);
            return this.finishResolution(resolved, [tx], nonceRetries).single;
          }
        }
        } catch (error) {
          throw this.afterSendFailure(error, [tx]);
        }
      }
    });
  }

  // Several txs with consecutive nonces n..n+k-1 in one sendTxBatch (spec §5.1, batch)
  submitBatch(builders: LighterTxBuilder[], meta: { clientOrderIndexes?: number[] } = {}): Promise<LighterBatchSubmission> {
    const sendBatch = this.options.sendBatch;
    if (!sendBatch) return Promise.reject(new Error('Lighter nonce manager: no batch sender configured'));
    if (builders.length === 0) return Promise.reject(new RangeError('Lighter nonce manager: empty batch'));
    return this.runExclusive(async () => {
      let nonceRetries = 0;
      for (;;) {
        const first = await this.ensureNonce();
        const txs = builders.map((build, i) => this.signAndRecord(build, first + i, meta.clientOrderIndexes));
        const outcome = await this.safeSend(() => sendBatch(txs));
        try {
        switch (outcome.kind) {
          case 'accepted':
            this.nextNonce = first + txs.length;
            for (const tx of txs) {
              this.recordNonceEvent(tx, 'accepted');
              this.journalMark(tx.txHash, 'accepted');
            }
            return { txs, resolvedBy: 'response', nonceRetries, resends: 0 };
          case 'invalid-nonce':
            for (const tx of txs) this.journalMark(tx.txHash, 'rejected', `invalid nonce: ${outcome.message}`);
            // Which nonce of the batch was refused is not reported: only the first is known to be taken
            this.recordNonceEvent(txs[0], 'invalid-nonce');
            if (nonceRetries >= this.maxNonceRetries) {
              this.nextNonce = null;
              throw new LighterTxRejectedError(`Lighter rejected the batch nonces ${nonceRetries + 1} times: ${outcome.message}`, {
                code: outcome.code, status: outcome.status, detail: outcome.message,
              });
            }
            nonceRetries++;
            this.nextNonce = await this.refetchAfterInvalidNonce(outcome, txs[0].txHash);
            continue;
          case 'rejected':
            for (const tx of txs) this.journalMark(tx.txHash, 'rejected', outcome.message);
            // Whether a batch is all-or-nothing is not documented: re-read the nonce before the next tx
            this.nextNonce = null;
            throw new LighterTxRejectedError(`Lighter rejected the batch: ${outcome.message}`, {
              code: outcome.code, status: outcome.status, detail: outcome.message,
            });
          case 'unknown': {
            logWarnWithTimestamp(`Lighter: outcome of a ${txs.length}-tx batch (nonces ${first}..${first + txs.length - 1}) is unknown (${outcome.reason}); resolving`);
            const resolved = await this.resolveUnknown(txs);
            return this.finishResolution(resolved, txs, nonceRetries).batch;
          }
        }
        } catch (error) {
          throw this.afterSendFailure(error, txs);
        }
      }
    });
  }

  // After a restart: settle txs that were persisted but never resolved. Nothing is resent (the bot's intent may
  // be stale); each record ends 'accepted', 'expired' or stays 'unknown' (logged).
  async reconcileJournal(): Promise<{ accepted: number; expired: number; unknown: number }> {
    return this.runExclusive(async () => {
      const records = this.options.journal.unresolved(this.accountIndex, this.apiKeyIndex);
      const counts = { accepted: 0, expired: 0, unknown: 0 };
      if (records.length === 0) return counts;
      let serverNext: number | null = null;
      try {
        serverNext = await this.options.fetchNextNonce();
      } catch (error) {
        logWarnWithTimestamp('Lighter: could not fetch nextNonce while reconciling the tx journal:', errorText(error));
      }
      for (const record of records) {
        let found: LighterTx | null = null;
        let lookupFailed = false;
        try {
          found = await this.options.lookupTx(record.txHash);
        } catch {
          lookupFailed = true;
        }
        if (found || (serverNext !== null && serverNext > record.nonce)) {
          this.journalMark(record.txHash, 'accepted', 'reconciled after restart');
          counts.accepted++;
        } else if (!lookupFailed && serverNext !== null && this.now() > record.expiredAt + this.expiryGraceMs) {
          this.journalMark(record.txHash, 'expired', 'never executed; expired before restart');
          counts.expired++;
        } else {
          counts.unknown++;
          logWarnWithTimestamp(`Lighter: tx ${record.txHash.slice(0, 16)}... (nonce ${record.nonce}) from before the restart is still unresolved`);
        }
      }
      this.nextNonce = serverNext;
      if (counts.accepted + counts.expired + counts.unknown > 0) {
        logWithTimestamp(`Lighter: tx journal reconciled: ${counts.accepted} accepted, ${counts.expired} expired, ${counts.unknown} unresolved`);
      }
      return counts;
    });
  }

  // ----- internals -----

  private async ensureNonce(): Promise<number> {
    if (this.nextNonce === null) {
      this.nextNonce = await this.options.fetchNextNonce();
    }
    return this.nextNonce;
  }

  private signAndRecord(build: LighterTxBuilder, nonce: number, clientOrderIndexes?: number[]): LighterSignedTx {
    const tx = build(nonce);
    if (!tx || tx.nonce !== nonce || typeof tx.txHash !== 'string' || typeof tx.txInfo !== 'string') {
      throw new Error(`Lighter nonce manager: the signed tx does not carry nonce ${nonce}`);
    }
    this.options.journal.recordSigned({
      txHash: tx.txHash,
      txType: tx.txType,
      txInfo: tx.txInfo,
      nonce: tx.nonce,
      expiredAt: tx.expiredAt,
      accountIndex: this.accountIndex,
      apiKeyIndex: this.apiKeyIndex,
      createdAt: this.now(),
      clientOrderIndexes,
    });
    this.signGeneration++;
    this.recordNonceEvent(tx, 'signed');
    return tx;
  }

  // The journal is advisory once a tx has left the process: a failed write (disk full, locked database) is logged
  // and the in-memory state (nonce, outcome) proceeds as if it had succeeded
  private journalMark(txHash: string, state: LighterTxState, detail?: string): void {
    try {
      this.options.journal.markState(txHash, state, detail);
    } catch (error) {
      logErrorWithTimestamp(`Lighter: tx journal write failed for ${txHash.slice(0, 16)}... (${state}): ${errorText(error)}`);
    }
  }

  // Anything unexpected thrown after a tx was sent: it may have executed, so callers must treat it as unknown
  private afterSendFailure(error: unknown, txs: LighterSignedTx[]): LighterTxError {
    if (error instanceof LighterTxError) return error;
    this.nextNonce = null;
    logErrorWithTimestamp(`Lighter: unexpected error after sending tx ${txs[0].txHash.slice(0, 16)}... (nonce ${txs[0].nonce}): ${errorText(error)}`);
    return new LighterTxUnknownError(`Lighter: unexpected error after the tx was sent (${errorText(error)}); it may have executed`, {
      txHash: txs[0].txHash, detail: errorText(error), expiredAt: latestExpiry(txs),
    });
  }

  // After an "invalid nonce" answer nothing was executed, so a failed nextNonce read is still a definite rejection
  private async refetchAfterInvalidNonce(outcome: { code: number; status: number; message: string }, txHash: string): Promise<number> {
    try {
      return await this.options.fetchNextNonce();
    } catch (error) {
      this.nextNonce = null;
      throw new LighterTxRejectedError(
        `Lighter rejected the nonce as invalid (${outcome.message}) and nextNonce could not be read: ${errorText(error)}`,
        { code: outcome.code, status: outcome.status, txHash, detail: outcome.message }
      );
    }
  }

  private recordNonceEvent(tx: LighterSignedTx, kind: NonceEvent['kind']): void {
    this.nonceEvents.push({ nonce: tx.nonce, txHash: tx.txHash, kind, at: this.now() });
    if (this.nonceEvents.length > MAX_NONCE_EVENTS) this.nonceEvents.splice(0, this.nonceEvents.length - MAX_NONCE_EVENTS);
  }

  private async safeSend(send: () => Promise<LighterSendOutcome>): Promise<LighterSendOutcome> {
    try {
      return await send();
    } catch (error) {
      return { kind: 'unknown', status: null, reason: errorText(error) };
    }
  }

  // Steps a-c of the unknown-outcome path for one tx or one batch (all txs consecutive, ascending nonces). The lock
  // bound is checked before every request, and each request's timeout is cut to what is left of it.
  private async resolveUnknown(txs: LighterSignedTx[]): Promise<ResolveResult> {
    for (const tx of txs) this.journalMark(tx.txHash, 'unknown');
    const last = txs[txs.length - 1];
    const expiry = Math.max(...txs.map(tx => tx.expiredAt)) + this.expiryGraceMs;
    const lockDeadline = this.now() + this.maxLockedResolveMs;
    const pastDeadline = () => this.now() >= lockDeadline;
    const callOptions = (): LighterCallOptions => ({ timeoutMs: Math.max(LIGHTER_MIN_CALL_TIMEOUT_MS, lockDeadline - this.now()) });
    let resends = 0;
    let lastReason = 'no answer';

    // through: highest nonce of this group known to be consumed. nonceAnswered: nextNonce replied, which after
    // ExpiredAt settles the question (before it, nextNonce may lag an accepted tx, hence the resends).
    const check = async (): Promise<{ through: number; by: LighterResolution; nonceAnswered: boolean }> => {
      // a. tx lookup, newest first: a known tx means its nonce and every earlier one were consumed
      for (let i = txs.length - 1; i >= 0 && !pastDeadline(); i--) {
        try {
          if (await this.options.lookupTx(txs[i].txHash, callOptions())) {
            if (i === txs.length - 1) return { through: last.nonce, by: 'tx-lookup', nonceAnswered: true };
            acceptedThrough = Math.max(acceptedThrough, txs[i].nonce);
            break;
          }
        } catch (error) {
          lastReason = `tx lookup failed: ${errorText(error)}`;
        }
      }
      if (pastDeadline()) return { through: acceptedThrough, by: 'next-nonce', nonceAnswered: false };
      // b. nextNonce above a tx's nonce means it was consumed
      try {
        const serverNext = await this.options.fetchNextNonce(callOptions());
        return { through: Math.min(serverNext - 1, last.nonce), by: 'next-nonce', nonceAnswered: true };
      } catch (error) {
        lastReason = `nextNonce failed: ${errorText(error)}`;
        return { through: acceptedThrough, by: 'next-nonce', nonceAnswered: false };
      }
    };

    let acceptedThrough = txs[0].nonce - 1;
    // Set once a resend is refused. The refusal is not proof that the original never ran (it may be queued, e.g.
    // "already exists", while nextNonce lags), so resending stops and the checks go on.
    let resendRefusal: string | null = null;
    // After a refusal: consecutive reads with nextNonce at or below the first nonce, and when the first came
    let unchangedReads = 0;
    let firstUnchangedAt: number | null = null;
    const released = (): ResolveResult => ({ kind: 'released', reason: lastReason, resends, acceptedThrough });
    for (let attempt = 0; ; attempt++) {
      const state = await check();
      acceptedThrough = Math.max(acceptedThrough, state.through);
      if (acceptedThrough >= last.nonce) {
        return { kind: 'accepted', by: state.by, resends, acceptedThrough };
      }
      if (this.now() >= expiry) {
        // Past ExpiredAt nothing can execute any more. Only a fully unexecuted group counts as expired;
        // a partly executed batch stays ambiguous for the caller to reconcile.
        if (state.nonceAnswered && acceptedThrough < txs[0].nonce) return { kind: 'expired', resends, resendRefusal };
        return {
          kind: 'unknown',
          reason: state.nonceAnswered ? `only nonces up to ${acceptedThrough} of the batch executed` : lastReason,
          resends,
        };
      }
      if (resendRefusal !== null) {
        if (state.nonceAnswered && acceptedThrough < txs[0].nonce) {
          unchangedReads++;
          firstUnchangedAt ??= this.now();
          if (unchangedReads >= LIGHTER_REFUSAL_SETTLE_READS && this.now() - firstUnchangedAt >= LIGHTER_REFUSAL_SETTLE_MS) {
            return { kind: 'presumed-not-executed', resends, resendRefusal };
          }
        } else {
          unchangedReads = 0;
          firstUnchangedAt = null;
        }
      }
      if (pastDeadline()) return released();
      const delay = this.resendDelaysMs[Math.min(attempt, this.resendDelaysMs.length - 1)] ?? 1000;
      await this.sleep(Math.min(delay, Math.max(0, lockDeadline - this.now())));
      if (pastDeadline()) return released();
      if (resendRefusal !== null) continue;   // Only a and b from here on
      // c. resend the identical, still-unaccepted txs
      const pending = txs.filter(tx => tx.nonce > acceptedThrough);
      const outcome = await this.safeSend(() => pending.length === 1 || !this.options.sendBatch
        ? this.options.send(pending[0], callOptions())
        : this.options.sendBatch(pending, callOptions()));
      resends++;
      if (outcome.kind === 'accepted') {
        return { kind: 'accepted', by: 'resend', resends, acceptedThrough: last.nonce };
      }
      if (outcome.kind === 'rejected') {
        resendRefusal = outcome.message;
        lastReason = `resend refused: ${outcome.message}`;
        logWarnWithTimestamp(
          `Lighter: resend of tx ${last.txHash.slice(0, 16)}... refused (${outcome.message}); the original may still be queued, ` +
          `so it is only presumed not executed once nextNonce stays at or below ${txs[0].nonce} for ${LIGHTER_REFUSAL_SETTLE_MS / 1000} s`
        );
        continue;
      }
      // invalid-nonce: the nonce is taken (possibly by our original): check again. unknown: try again.
      lastReason = outcome.kind === 'unknown' ? outcome.reason : `resend answered invalid nonce: ${outcome.message}`;
    }
  }

  private finishResolution(
    resolved: ResolveResult,
    txs: LighterSignedTx[],
    nonceRetries: number
  ): { single: LighterTxSubmission; batch: LighterBatchSubmission } {
    const first = txs[0];
    switch (resolved.kind) {
      case 'accepted':
        for (const tx of txs) this.journalMark(tx.txHash, 'accepted', `resolved by ${resolved.by}`);
        this.nextNonce = txs[txs.length - 1].nonce + 1;
        logWithTimestamp(`Lighter: tx ${first.txHash.slice(0, 16)}... confirmed accepted by ${resolved.by} after an unknown send outcome`);
        return {
          single: { tx: first, resolvedBy: resolved.by, nonceRetries, resends: resolved.resends },
          batch: { txs, resolvedBy: resolved.by, nonceRetries, resends: resolved.resends },
        };
      case 'expired': {
        const refusal = resolved.resendRefusal !== null ? `; a resend was refused: ${resolved.resendRefusal}` : '';
        for (const tx of txs) this.journalMark(tx.txHash, 'expired', `not executed before ExpiredAt${refusal}`);
        this.nextNonce = null;
        throw new LighterTxRejectedError(`Lighter tx expired without being executed (the exchange never accepted it${refusal})`, {
          txHash: first.txHash, detail: `tx expired unexecuted${refusal}`,
        });
      }
      case 'presumed-not-executed': {
        const detail = `a resend was refused (${resolved.resendRefusal}) and nextNonce did not move past ${first.nonce}`;
        for (const tx of txs) this.journalMark(tx.txHash, 'unknown', `presumed not executed: ${detail}; watched until ExpiredAt`);
        this.nextNonce = null;
        this.settleInBackground(txs);
        logWarnWithTimestamp(`Lighter: tx ${first.txHash.slice(0, 16)}... (nonce ${first.nonce}) presumed not executed (${detail}); releasing the key and watching it until it expires`);
        // Not proof: the original could still land, so callers must not place a replacement order
        throw new LighterTxRejectedError(`Lighter tx presumed not executed: ${detail}`, {
          txHash: first.txHash, detail, orderMayExist: true, expiredAt: latestExpiry(txs),
        });
      }
      case 'released': {
        const seconds = Math.round(this.maxLockedResolveMs / 1000);
        // Part of a batch may already be known executed; only the rest is watched
        const unresolved = txs.filter(tx => tx.nonce > resolved.acceptedThrough);
        for (const tx of txs) {
          if (tx.nonce <= resolved.acceptedThrough) this.journalMark(tx.txHash, 'accepted', 'resolved by next-nonce');
          else this.journalMark(tx.txHash, 'unknown', `unresolved after ${seconds} s (${resolved.reason}); settling in the background`);
        }
        this.nextNonce = null;
        this.settleInBackground(unresolved);
        logErrorWithTimestamp(`Lighter: outcome of tx ${first.txHash.slice(0, 16)}... (nonce ${first.nonce}) still unknown after ${seconds} s (${resolved.reason}); releasing the key and settling it in the background`);
        throw new LighterTxUnknownError(
          `Lighter tx outcome still unknown after ${seconds} s (${resolved.reason}); it may yet execute. Reconcile from account state before retrying.`,
          { txHash: first.txHash, detail: resolved.reason, expiredAt: latestExpiry(txs) }
        );
      }
      case 'unknown':
        this.nextNonce = null;
        logErrorWithTimestamp(`Lighter: outcome of tx ${first.txHash.slice(0, 16)}... (nonce ${first.nonce}) is still unknown after ExpiredAt: ${resolved.reason}`);
        throw new LighterTxUnknownError(
          `Lighter tx outcome unknown (${resolved.reason}); it may have executed. Reconcile from account state before retrying.`,
          { txHash: first.txHash, detail: resolved.reason, expiredAt: latestExpiry(txs) }
        );
    }
  }

  // ----- Background settle of released txs (no lock, never resent or re-signed) -----

  private settleInBackground(txs: LighterSignedTx[]): void {
    const releasedAt = this.now();
    const run = this.watchReleased(txs, releasedAt).catch(error => {
      logErrorWithTimestamp(`Lighter: background settle of tx ${txs[0].txHash.slice(0, 16)}... failed:`, errorText(error));
    });
    this.backgroundSettles.add(run);
    void run.finally(() => this.backgroundSettles.delete(run));
  }

  // Evidence per tx, polled until ExpiredAt + grace:
  //  - found by hash                                        -> executed
  //  - a later tx of ours got "invalid nonce" for its nonce -> the nonce was used, by this tx (one key per flow)
  //  - a later tx of ours was accepted with its nonce       -> this tx can no longer execute
  //  - nextNonce above its nonce                            -> executed, but only while no later tx of ours has
  //                                                            been signed at or below that nonce
  //  - past ExpiredAt + grace with lookups answering and no sign of execution -> not executed
  private async watchReleased(txs: LighterSignedTx[], releasedAt: number): Promise<void> {
    const own = new Set(txs.map(tx => tx.txHash));
    const pending = new Map(txs.map(tx => [tx.txHash, tx] as const));
    const expiry = Math.max(...txs.map(tx => tx.expiredAt)) + this.expiryGraceMs;

    for (;;) {
      if (this.disposed) return this.abandonSettle(pending);
      let lookupFailed = false;
      for (const tx of [...pending.values()]) {
        let found = false;
        try {
          found = Boolean(await this.options.lookupTx(tx.txHash));
        } catch {
          lookupFailed = true;
        }
        const later = this.laterNonceUse(tx, own, releasedAt);
        if (found || later === 'invalid-nonce') {
          pending.delete(tx.txHash);
          this.reportLate(tx, 'executed', found ? 'found by hash' : `a later tx was refused because nonce ${tx.nonce} was already used`);
        } else if (later === 'accepted') {
          pending.delete(tx.txHash);
          this.reportLate(tx, 'not-executed', `nonce ${tx.nonce} was used by a later tx, so this one can no longer execute`);
        }
      }
      if (pending.size === 0) return;

      const highestPending = Math.max(...[...pending.values()].map(tx => tx.nonce));
      const nextNonceUsable = !this.nonceEvents.some(e => e.kind === 'signed' && e.at >= releasedAt && !own.has(e.txHash) && e.nonce <= highestPending);
      let serverNext: number | null = null;
      if (nextNonceUsable) {
        // A tx signed while the read is in flight may be counted in it, and would pass for this one
        const generation = this.signGeneration;
        try {
          serverNext = await this.options.fetchNextNonce();
        } catch {
          serverNext = null;
        }
        if (this.signGeneration !== generation) serverNext = null;
      }
      if (serverNext !== null) {
        for (const tx of [...pending.values()]) {
          if (serverNext > tx.nonce) {
            pending.delete(tx.txHash);
            this.reportLate(tx, 'executed', `nextNonce ${serverNext} moved past nonce ${tx.nonce}`);
          }
        }
        if (pending.size === 0) return;
      }

      if (this.now() >= expiry) {
        const settled = !lookupFailed && (serverNext !== null || !nextNonceUsable);
        for (const tx of pending.values()) {
          if (settled) this.reportLate(tx, 'not-executed', 'not executed before ExpiredAt');
          else this.reportLate(tx, 'unknown', 'still unresolved after ExpiredAt (lookups failing)');
        }
        return;
      }
      await this.backgroundSleep(this.backgroundPollMs);
    }
  }

  private abandonSettle(pending: Map<string, LighterSignedTx>): void {
    for (const tx of pending.values()) {
      logWarnWithTimestamp(`Lighter: stopped settling tx ${tx.txHash.slice(0, 16)}... (nonce ${tx.nonce}) at shutdown; it stays in the journal for the next start`);
    }
  }

  // How a later tx of ours fared with the same nonce, if one was sent after the release
  private laterNonceUse(tx: LighterSignedTx, own: Set<string>, since: number): 'accepted' | 'invalid-nonce' | null {
    for (let i = this.nonceEvents.length - 1; i >= 0; i--) {
      const event = this.nonceEvents[i];
      if (event.at < since) break;
      if (event.nonce !== tx.nonce || own.has(event.txHash) || event.kind === 'signed') continue;
      return event.kind;
    }
    return null;
  }

  private reportLate(tx: LighterSignedTx, outcome: LighterLateOutcome['outcome'], detail: string): void {
    const label = `tx ${tx.txHash.slice(0, 16)}... (nonce ${tx.nonce})`;
    let record: LighterTxRecord | undefined;
    try {
      record = this.options.journal.get(tx.txHash);
    } catch {
      record = undefined;
    }
    if (outcome === 'executed') {
      this.journalMark(tx.txHash, 'accepted', `executed after the key was released: ${detail}`);
      logErrorWithTimestamp(
        `Lighter: ${label} EXECUTED after the bot stopped waiting for it (${detail}). Any order it placed is live; ` +
        'the position manager protects the resulting position on its next sync.'
      );
    } else if (outcome === 'not-executed') {
      this.journalMark(tx.txHash, 'expired', detail);
      logWithTimestamp(`Lighter: released ${label} settled as not executed (${detail})`);
    } else {
      logErrorWithTimestamp(`Lighter: released ${label} is still unresolved after ExpiredAt (${detail}); it stays in the journal for the next restart`);
    }
    try {
      this.options.onLateOutcome?.({ txHash: tx.txHash, nonce: tx.nonce, clientOrderIndexes: record?.clientOrderIndexes, outcome, detail });
    } catch (error) {
      logErrorWithTimestamp('Lighter: onLateOutcome handler failed:', errorText(error));
    }
  }
}
