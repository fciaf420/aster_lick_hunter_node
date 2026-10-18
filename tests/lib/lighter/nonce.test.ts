/**
 * @jest-environment node
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LIGHTER_MAX_CLIENT_ORDER_INDEX,
  LighterClientOrderIndexGenerator,
  LighterNonceManager,
  LIGHTER_MAX_LOCKED_RESOLVE_MS,
  LighterTxRejectedError,
  LighterTxUnknownError,
  MemoryLighterTxJournal,
  SqliteLighterTxJournal,
  clientOrderIndexRole,
  type LighterCallOptions,
  type LighterLateOutcome,
  type LighterNonceManagerOptions,
  type LighterSendOutcome,
  type LighterTxJournal,
} from '../../../src/lib/exchange/lighter/nonce';
import { isDefinitelyNotPlaced, orderMayExist } from '../../../src/lib/exchange/orderErrors';
import type { LighterSignedTx } from '../../../src/lib/exchange/lighter/signer';
import type { LighterTx } from '../../../src/lib/exchange/lighter/http';

const TEN_MIN = 10 * 60 * 1000;
const accepted = (): LighterSendOutcome => ({ kind: 'accepted', txHashes: [] });
const unknown = (reason = 'HTTP 503'): LighterSendOutcome => ({ kind: 'unknown', status: 503, reason });
const invalidNonce = (): LighterSendOutcome => ({ kind: 'invalid-nonce', status: 400, code: 21104, message: 'invalid nonce' });
const rejected = (code = 21120, message = 'bad tx'): LighterSendOutcome => ({ kind: 'rejected', status: 400, code, message });

function harness(options: {
  serverNonce?: number;
  journal?: LighterTxJournal;
  // Answers a send before the script (e.g. "this hash always times out")
  decide?: (txs: LighterSignedTx[]) => LighterSendOutcome | undefined;
  managerOptions?: Partial<LighterNonceManagerOptions>;
} = {}) {
  const clock = { now: 1_800_000_000_000 };
  let counter = 0;
  const state = {
    serverNonce: options.serverNonce ?? 10,
    sendScript: [] as Array<LighterSendOutcome | Error | ((txs: LighterSignedTx[]) => LighterSendOutcome)>,
    executed: new Set<string>(),   // hashes the "exchange" knows
    lookupFails: false,
    nonceFails: false,
    beforeNonceFetch: null as null | (() => void),   // Runs before each nextNonce answer (lagging-nonce scenarios)
    sent: [] as LighterSignedTx[],
    batches: [] as LighterSignedTx[][],
    signed: [] as number[],
  };
  const journal = options.journal ?? new MemoryLighterTxJournal();
  const build = (nonce: number): LighterSignedTx => {
    counter++;
    state.signed.push(nonce);
    const txInfo = `{"Nonce":${nonce},"Seq":${counter}}`;
    return { txType: 14, txInfo, txHash: counter.toString(16).padStart(80, '0'), nonce, expiredAt: clock.now + TEN_MIN - 1000 };
  };
  const respond = (txs: LighterSignedTx[]): LighterSendOutcome => {
    const decided = options.decide?.(txs);
    if (decided) return decided;
    const scripted = state.sendScript.shift();
    if (scripted instanceof Error) throw scripted;
    const next = typeof scripted === 'function' ? scripted(txs) : scripted;
    const outcome = next ?? (txs[0].nonce === state.serverNonce ? accepted() : invalidNonce());
    if (outcome.kind === 'accepted' && txs[0].nonce === state.serverNonce) {
      for (const tx of txs) state.executed.add(tx.txHash);
      state.serverNonce += txs.length;
    }
    return outcome;
  };
  const manager = new LighterNonceManager({
    accountIndex: 5,
    apiKeyIndex: 3,
    journal,
    fetchNextNonce: async () => {
      if (state.nonceFails) throw new Error('ECONNRESET');
      state.beforeNonceFetch?.();
      return state.serverNonce;
    },
    send: async tx => {
      // The signed tx is persisted before it leaves the process
      expect(journal.get(tx.txHash)).toBeDefined();
      state.sent.push(tx);
      return respond([tx]);
    },
    sendBatch: async txs => {
      state.batches.push(txs);
      return respond(txs);
    },
    lookupTx: async hash => {
      if (state.lookupFails) throw new Error('ETIMEDOUT');
      return state.executed.has(hash) ? ({ hash, status: 2 } as LighterTx) : null;
    },
    now: () => clock.now,
    sleep: async ms => {
      clock.now += ms;
    },
    ...options.managerOptions,
  });
  return { manager, state, journal, build, clock };
}

describe('LighterNonceManager (spec §5.1)', () => {
  it('accepted: fetches nextNonce once, then counts locally', async () => {
    const { manager, state, journal, build } = harness();
    const first = await manager.submit(build);
    const second = await manager.submit(build);
    expect([first.tx.nonce, second.tx.nonce]).toEqual([10, 11]);
    expect(first.resolvedBy).toBe('response');
    expect(manager.currentNonce).toBe(12);
    expect(journal.get(first.tx.txHash)?.state).toBe('accepted');
    expect(state.signed).toEqual([10, 11]);
  });

  it('invalid nonce: re-fetches nextNonce and signs again, at most 3 times', async () => {
    const { manager, state, build } = harness();
    await manager.submit(build);
    state.serverNonce = 40;   // someone else used the key
    const result = await manager.submit(build);
    expect(result.tx.nonce).toBe(40);
    expect(result.nonceRetries).toBe(1);

    state.sendScript.push(invalidNonce(), invalidNonce(), invalidNonce(), invalidNonce());
    await expect(manager.submit(build)).rejects.toBeInstanceOf(LighterTxRejectedError);
    expect(state.sent.slice(-4).map(tx => tx.nonce)).toEqual([41, 41, 41, 41]);
    expect(manager.currentNonce).toBeNull();
  });

  it('other rejection: nonce not consumed, error surfaced, next tx reuses it', async () => {
    const { manager, state, journal, build } = harness();
    state.sendScript.push(rejected(21120, 'invalid order'));
    const error = await manager.submit(build).catch(e => e);
    expect(error).toBeInstanceOf(LighterTxRejectedError);
    expect(error.response.data).toMatchObject({ code: 21120, msg: 'invalid order' });
    expect(journal.get(state.sent[0].txHash)?.state).toBe('rejected');
    const next = await manager.submit(build);
    expect(next.tx.nonce).toBe(10);
  });

  it('unknown outcome, tx executed: found by tx lookup, nothing resent or re-signed', async () => {
    const { manager, state, build } = harness();
    state.sendScript.push(new Error('socket hang up'));
    // The exchange did execute it
    const submitting = manager.submit(tx => {
      const signed = build(tx);
      state.executed.add(signed.txHash);
      state.serverNonce = tx + 1;
      return signed;
    });
    const result = await submitting;
    expect(result.resolvedBy).toBe('tx-lookup');
    expect(state.sent).toHaveLength(1);
    expect(state.signed).toEqual([10]);
    expect(manager.currentNonce).toBe(11);
  });

  it('unknown outcome, nextNonce moved past n: accepted', async () => {
    const { manager, state, build } = harness();
    state.sendScript.push(unknown());
    state.lookupFails = true;
    const result = await manager.submit(tx => {
      state.serverNonce = tx + 1;   // consumed, tx not yet indexed
      return build(tx);
    });
    expect(result.resolvedBy).toBe('next-nonce');
    expect(state.sent).toHaveLength(1);
  });

  it('unknown outcome, not executed: resends the identical tx until accepted', async () => {
    const { manager, state, build } = harness();
    state.sendScript.push(unknown(), unknown());
    const result = await manager.submit(build);
    expect(result.resolvedBy).toBe('resend');
    expect(result.resends).toBe(2);
    expect(state.sent).toHaveLength(3);
    expect(new Set(state.sent.map(tx => tx.txInfo)).size).toBe(1);   // identical bytes every time
    expect(state.signed).toEqual([10]);
    expect(manager.currentNonce).toBe(11);
  });

  it('resend answered "invalid nonce": checks again and finds it consumed', async () => {
    const { manager, state, build } = harness();
    // Executed on the first send but invisible to /tx, and nextNonce lags; by the resend the nonce is taken
    state.lookupFails = true;
    state.sendScript.push(unknown(), txs => {
      state.serverNonce = txs[0].nonce + 1;
      return invalidNonce();
    });
    const result = await manager.submit(build);
    expect(result.resolvedBy).toBe('next-nonce');
    expect(result.resends).toBe(1);
    expect(state.sent).toHaveLength(2);
    expect(state.signed).toEqual([10]);
    expect(manager.currentNonce).toBe(11);
  });

  it('resend refused while the original is still queued: keeps checking and reports it accepted', async () => {
    const { manager, state, journal, build, clock } = harness();
    // The first send times out but the exchange queued it; the resend is refused as a duplicate while
    // nextNonce still lags. A few seconds later the original executes.
    let refusedAt = 0;
    state.sendScript.push(new Error('timeout of 10000ms exceeded'), () => {
      refusedAt = clock.now;
      return rejected(21120, 'tx already exists');
    });
    state.beforeNonceFetch = () => {
      if (refusedAt > 0 && clock.now - refusedAt >= 3000) state.serverNonce = 11;   // the queued original executed
    };
    const result = await manager.submit(build);
    expect(result.resolvedBy).toBe('next-nonce');
    expect(clock.now - refusedAt).toBeGreaterThanOrEqual(3000);
    expect(state.sent).toHaveLength(2);                      // no resend after the refusal
    expect(new Set(state.sent.map(tx => tx.txInfo)).size).toBe(1);
    expect(state.signed).toEqual([10]);
    expect(manager.currentNonce).toBe(11);
    expect(journal.get(result.tx.txHash)?.state).toBe('accepted');
  });

  it('resend refused and nextNonce unchanged for 3 reads over 10 s: presumed not executed, watched until ExpiredAt', async () => {
    const late: LighterLateOutcome[] = [];
    const { manager, state, journal, build, clock } = harness({ managerOptions: { onLateOutcome: o => late.push(o) } });
    const started = clock.now;
    state.sendScript.push(unknown(), rejected(21122, 'tx expired'));
    const error = await manager.submit(build).catch(e => e);
    expect(error).toBeInstanceOf(LighterTxRejectedError);
    expect(error.message).toMatch(/presumed not executed: a resend was refused \(tx expired\) and nextNonce did not move past 10/);
    // Not proof: the original could still land, so no replacement order may be placed
    expect(orderMayExist(error)).toBe(true);
    expect(clock.now - started).toBeGreaterThanOrEqual(10_000);
    expect(clock.now - started).toBeLessThan(LIGHTER_MAX_LOCKED_RESOLVE_MS);
    expect(state.sent).toHaveLength(2);                              // the refused tx is not sent again
    expect(journal.get(state.sent[0].txHash)?.state).toBe('unknown');
    expect(manager.currentNonce).toBeNull();

    // Watched in the background (no lock, no resend) until it can no longer execute
    await manager.whenSettled();
    expect(clock.now - started).toBeGreaterThanOrEqual(TEN_MIN);
    expect(state.sent).toHaveLength(2);
    expect(state.signed).toEqual([10]);
    expect(journal.get(state.sent[0].txHash)?.state).toBe('expired');
    expect(late).toEqual([expect.objectContaining({ outcome: 'not-executed', nonce: 10, detail: 'not executed before ExpiredAt' })]);
  });

  it('first-send rejections are definite; unknown outcomes may still exist', async () => {
    const { manager, state, build } = harness();
    state.sendScript.push(rejected(21120, 'bad tx'));
    const refused = await manager.submit(build).catch(e => e);
    expect(refused).toBeInstanceOf(LighterTxRejectedError);
    expect(isDefinitelyNotPlaced(refused)).toBe(true);
    expect(isDefinitelyNotPlaced(new LighterTxUnknownError('timeout'))).toBe(false);
  });

  it('resend refused and the exchange unreachable afterwards: unknown, never "not executed"', async () => {
    const { manager, state, build } = harness();
    state.sendScript.push(unknown(), () => {
      state.lookupFails = true;
      state.nonceFails = true;
      return rejected(21120, 'tx already exists');
    });
    const error = await manager.submit(build).catch(e => e);
    expect(error).toBeInstanceOf(LighterTxUnknownError);
    expect(error).not.toBeInstanceOf(LighterTxRejectedError);
    expect(state.signed).toEqual([10]);
  });

  it('no answer for 45 s: the key is released (unknown), and the tx settles as not executed in the background', async () => {
    const late: LighterLateOutcome[] = [];
    const { manager, state, journal, build, clock } = harness({ managerOptions: { onLateOutcome: o => late.push(o) } });
    const started = clock.now;
    state.sendScript.push(...Array.from({ length: 500 }, () => unknown()));
    const error = await manager.submit(build).catch(e => e);
    expect(error).toBeInstanceOf(LighterTxUnknownError);
    expect(error.message).toMatch(/still unknown after 45 s/);
    expect(clock.now - started).toBeGreaterThanOrEqual(LIGHTER_MAX_LOCKED_RESOLVE_MS);
    expect(clock.now - started).toBeLessThan(LIGHTER_MAX_LOCKED_RESOLVE_MS + 10_000);
    expect(new Set(state.sent.map(tx => tx.txInfo)).size).toBe(1);
    expect(journal.get(state.sent[0].txHash)?.state).toBe('unknown');
    expect(manager.currentNonce).toBeNull();
    expect(manager.settlingCount).toBe(1);

    const sentBefore = state.sent.length;
    await manager.whenSettled();
    expect(state.sent).toHaveLength(sentBefore);   // never resent in the background
    expect(clock.now - started).toBeGreaterThanOrEqual(TEN_MIN);
    expect(journal.get(state.sent[0].txHash)?.state).toBe('expired');
    expect(late.map(o => o.outcome)).toEqual(['not-executed']);
  });

  it('a submit queued behind an unresolved tx runs once the key is released, and its nonce rules the old tx out', async () => {
    const late: LighterLateOutcome[] = [];
    let stuckHash = '';
    const { manager, state, journal, build, clock } = harness({
      managerOptions: { onLateOutcome: o => late.push(o) },
      decide: txs => (txs[0].txHash === stuckHash ? unknown() : undefined),
    });
    const started = clock.now;
    let releasedAfter = 0;
    const stuck = manager.submit(nonce => {
      const tx = build(nonce);
      stuckHash = tx.txHash;
      return tx;
    }).catch(e => {
      releasedAfter = clock.now - started;
      return e;
    });
    // e.g. the SL/TP for a position: queued on the same key
    const protection = manager.submit(build);
    expect(await stuck).toBeInstanceOf(LighterTxUnknownError);
    expect(releasedAfter).toBeLessThan(LIGHTER_MAX_LOCKED_RESOLVE_MS + 10_000);
    const placed = await protection;
    expect(placed.tx.nonce).toBe(10);                 // the stuck tx never consumed nonce 10
    expect(state.signed).toEqual([10, 10]);

    await manager.whenSettled();
    expect(journal.get(stuckHash)?.state).toBe('expired');
    expect(late).toEqual([expect.objectContaining({ outcome: 'not-executed', detail: expect.stringMatching(/used by a later tx/) })]);
  });

  it('a released tx that executes later is reported as executed and never re-signed', async () => {
    const late: LighterLateOutcome[] = [];
    let stuckHash = '';
    let releasedAt = 0;
    const { manager, state, journal, build, clock } = harness({
      managerOptions: { onLateOutcome: o => late.push(o) },
      decide: txs => (txs[0].txHash === stuckHash ? unknown() : undefined),
    });
    const error = await manager.submit(nonce => {
      const tx = build(nonce);
      stuckHash = tx.txHash;
      return tx;
    }).catch(e => e);
    expect(error).toBeInstanceOf(LighterTxUnknownError);
    releasedAt = clock.now;
    // A minute later the exchange executes it after all
    state.beforeNonceFetch = () => {
      if (clock.now - releasedAt >= 60_000 && !state.executed.has(stuckHash)) {
        state.executed.add(stuckHash);
        state.serverNonce = 11;
      }
    };
    await manager.whenSettled();
    expect(journal.get(stuckHash)?.state).toBe('accepted');
    expect(journal.get(stuckHash)?.detail).toMatch(/executed after the key was released/);
    expect(late).toEqual([expect.objectContaining({ outcome: 'executed', nonce: 10 })]);
    expect(state.signed).toEqual([10]);
  });

  it('a later tx refused for the released nonce proves the released tx executed', async () => {
    const late: LighterLateOutcome[] = [];
    let stuckHash = '';
    let refusedOnce = false;
    const { manager, state, build } = harness({
      managerOptions: { onLateOutcome: o => late.push(o) },
      decide: txs => {
        if (txs[0].txHash === stuckHash) return unknown();
        // The stuck tx executed, but neither the lookup nor nextNonce showed it yet: the next tx signed nonce 10
        // is refused as a used nonce, after which nextNonce catches up
        if (txs[0].nonce === 10 && !refusedOnce) {
          refusedOnce = true;
          state.serverNonce = 11;
          return invalidNonce();
        }
        return undefined;
      },
    });
    await manager.submit(nonce => {
      const tx = build(nonce);
      stuckHash = tx.txHash;
      return tx;
    }).catch(() => undefined);
    state.lookupFails = true;
    const next = await manager.submit(build);
    expect(next.tx.nonce).toBe(11);
    expect(state.signed).toEqual([10, 10, 11]);
    await manager.whenSettled();
    expect(late).toEqual([expect.objectContaining({ outcome: 'executed', detail: expect.stringMatching(/already used/) })]);
  });

  it('nothing reachable until ExpiredAt: LighterTxUnknownError, never a new tx', async () => {
    const { manager, state, build } = harness();
    await manager.submit(build);   // local counter known: 11
    state.sendScript.push(...Array.from({ length: 500 }, () => new Error('ENETUNREACH')));
    state.lookupFails = true;
    state.nonceFails = true;
    const error = await manager.submit(build).catch(e => e);
    expect(error).toBeInstanceOf(LighterTxUnknownError);
    expect(error.message).toMatch(/still unknown after 45 s.*may yet execute/);
    expect(state.signed).toEqual([10, 11]);
    expect(new Set(state.sent.slice(1).map(tx => tx.txInfo)).size).toBe(1);
    expect(manager.currentNonce).toBeNull();

    // With nextNonce unreachable nothing new is signed
    await expect(manager.submit(build)).rejects.toThrow(/ECONNRESET/);
    expect(state.signed).toEqual([10, 11]);
    // Still unreachable at ExpiredAt: stays unknown (in the journal for the next restart)
    await manager.whenSettled();
    expect(state.signed).toEqual([10, 11]);
  });

  it('a journal write failing after an accepted send: normal success, nonce advanced', async () => {
    class FullDiskJournal extends MemoryLighterTxJournal {
      markState(): void {
        throw new Error('SQLITE_FULL: database or disk is full');
      }
    }
    const { manager, build } = harness({ journal: new FullDiskJournal() });
    const first = await manager.submit(build);
    expect(first.tx.nonce).toBe(10);
    expect(manager.currentNonce).toBe(11);
    expect((await manager.submit(build)).tx.nonce).toBe(11);
  });

  it('a journal write failing while an unknown outcome is resolved does not change the outcome', async () => {
    class FullDiskJournal extends MemoryLighterTxJournal {
      markState(): void {
        throw new Error('SQLITE_FULL: database or disk is full');
      }
    }
    const { manager, state, build } = harness({ journal: new FullDiskJournal() });
    state.sendScript.push(() => {
      state.executed.add(state.sent[0].txHash);
      state.serverNonce = 11;
      return unknown();
    });
    const result = await manager.submit(build);
    expect(result.resolvedBy).toBe('tx-lookup');
    expect(manager.currentNonce).toBe(11);
  });

  it('anything unexpected thrown after the send is an unknown outcome, never a definite one', async () => {
    const { manager, state, build } = harness({
      managerOptions: {
        sleep: async () => {
          throw new Error('timer failure');
        },
      },
    });
    state.sendScript.push(unknown());
    const error = await manager.submit(build).catch(e => e);
    expect(error).toBeInstanceOf(LighterTxUnknownError);
    expect(error.message).toMatch(/timer failure/);
    expect(orderMayExist(error)).toBe(true);
    expect(error.mayExistUntil).toBe(state.sent[0].expiredAt + 5000);
    expect(manager.currentNonce).toBeNull();
  });

  it('a failed nextNonce read after "invalid nonce" is still a definite rejection', async () => {
    const { manager, state, build } = harness();
    // nextNonce answers before the send, then fails once the nonce is refused
    state.sendScript.push(() => {
      state.nonceFails = true;
      return invalidNonce();
    });
    const error = await manager.submit(build).catch(e => e);
    expect(error).toBeInstanceOf(LighterTxRejectedError);
    expect(error.message).toMatch(/nextNonce could not be read/);
    expect(isDefinitelyNotPlaced(error)).toBe(true);
  });

  it('unknown errors carry the tx expiry, so callers know how long the order may still appear', async () => {
    const { manager, state, build } = harness();
    state.sendScript.push(...Array.from({ length: 500 }, () => unknown()));
    const error = await manager.submit(build).catch(e => e);
    expect(error).toBeInstanceOf(LighterTxUnknownError);
    expect(error.expiredAt).toBe(state.sent[0].expiredAt);
    expect(error.mayExistUntil).toBe(state.sent[0].expiredAt + 5000);
    manager.dispose();
    await manager.whenSettled();
  });

  it('slow requests cannot hold the key past the lock bound: every request is cut to what is left of it', async () => {
    let clockRef = { now: 0 };
    const timeouts: number[] = [];
    // The background settle shares the fake clock, so the release is timed by its first request (no lock bound)
    let releasedAt: number | null = null;
    // Every request hangs until its timeout (at most the client's 10 s) and then fails
    const slow = async (options?: LighterCallOptions): Promise<never> => {
      const timeoutMs = options?.timeoutMs ?? 10_000;
      if (options?.timeoutMs !== undefined) timeouts.push(options.timeoutMs);
      else if (h.state.sent.length > 1) releasedAt ??= clockRef.now;
      clockRef.now += Math.min(10_000, timeoutMs);
      throw new Error(`timeout of ${timeoutMs}ms exceeded`);
    };
    const h = harness({
      managerOptions: {
        fetchNextNonce: async options => (options === undefined && h.state.sent.length === 0 ? 10 : slow(options)),
        lookupTx: (_hash, options) => slow(options),
        send: async (tx, options) => {
          h.state.sent.push(tx);
          return slow(options);
        },
      },
    });
    clockRef = h.clock;
    const started = h.clock.now;
    const error = await h.manager.submit(h.build).catch(e => e);
    expect(error).toBeInstanceOf(LighterTxUnknownError);
    expect(error.message).toMatch(/still unknown after 45 s/);
    // First send (10 s) + the 45 s bound + at most one minimum-length request past it
    expect(releasedAt).not.toBeNull();
    expect((releasedAt ?? Infinity) - started).toBeLessThanOrEqual(10_000 + LIGHTER_MAX_LOCKED_RESOLVE_MS + 1000);
    expect(timeouts.length).toBeGreaterThan(0);
    expect(Math.max(...timeouts)).toBeLessThanOrEqual(LIGHTER_MAX_LOCKED_RESOLVE_MS);
    expect(Math.min(...timeouts)).toBeGreaterThanOrEqual(1000);
    expect(new Set(h.state.sent.map(tx => tx.txInfo)).size).toBe(1);
    h.manager.dispose();
    await h.manager.whenSettled();
  });

  it('a nextNonce read that overlapped a new tx is not taken as proof that the released tx executed', async () => {
    const late: LighterLateOutcome[] = [];
    let stuckHash = '';
    let inNested = false;
    let nested: Promise<unknown> | null = null;
    const h = harness({
      decide: txs => (txs[0].txHash === stuckHash ? unknown() : undefined),
      managerOptions: {
        onLateOutcome: o => late.push(o),
        fetchNextNonce: async options => {
          // The first background read: a new tx is signed and accepted with nonce 10 while it is in flight
          if (options === undefined && !inNested && nested === null && h.manager.settlingCount > 0) {
            inNested = true;
            nested = h.manager.submit(h.build).finally(() => {
              inNested = false;
            });
            await nested;
          }
          return h.state.serverNonce;
        },
      },
    });
    const error = await h.manager.submit(nonce => {
      const tx = h.build(nonce);
      stuckHash = tx.txHash;
      return tx;
    }).catch(e => e);
    expect(error).toBeInstanceOf(LighterTxUnknownError);
    await h.manager.whenSettled();
    expect(nested).not.toBeNull();
    expect(h.state.signed).toEqual([10, 10]);
    expect(late).toEqual([expect.objectContaining({ outcome: 'not-executed', detail: expect.stringMatching(/used by a later tx/) })]);
  });

  it('dispose() stops background settling; the tx stays unresolved in the journal', async () => {
    const late: LighterLateOutcome[] = [];
    const { manager, state, journal, build, clock } = harness({ managerOptions: { onLateOutcome: o => late.push(o) } });
    state.sendScript.push(...Array.from({ length: 500 }, () => unknown()));
    await manager.submit(build).catch(() => undefined);
    const releasedAt = clock.now;
    manager.dispose();
    await manager.whenSettled();
    expect(manager.settlingCount).toBe(0);
    expect(clock.now - releasedAt).toBeLessThan(TEN_MIN);
    expect(late).toEqual([]);
    expect(journal.get(state.sent[0].txHash)?.state).toBe('unknown');
  });

  it('holds one lock across sign and send: concurrent submits never interleave', async () => {
    const { manager, state, build } = harness();
    state.sendScript.push(unknown());
    const results = await Promise.all([manager.submit(build), manager.submit(build), manager.submit(build)]);
    expect(results.map(r => r.tx.nonce)).toEqual([10, 11, 12]);
    expect(state.signed).toEqual([10, 11, 12]);
  });

  it('a signer error leaves the nonce untouched and the queue usable', async () => {
    const { manager, build } = harness();
    await expect(manager.submit(() => { throw new RangeError('price out of range'); })).rejects.toThrow(RangeError);
    await expect(manager.submit(build)).resolves.toMatchObject({ tx: { nonce: 10 } });
  });

  it('batch: consecutive nonces on one key; an unknown batch resolves by looking up its last tx', async () => {
    const { manager, state, build } = harness();
    const batch = await manager.submitBatch([build, build]);
    expect(batch.txs.map(tx => tx.nonce)).toEqual([10, 11]);
    expect(manager.currentNonce).toBe(12);

    state.sendScript.push(new Error('timeout'));
    const resolved = await manager.submitBatch([n => {
      const tx = build(n);
      state.executed.add(tx.txHash);
      return tx;
    }, n => {
      const tx = build(n);
      state.executed.add(tx.txHash);
      state.serverNonce = n + 1;
      return tx;
    }]);
    expect(resolved.resolvedBy).toBe('tx-lookup');
    expect(manager.currentNonce).toBe(14);
  });

  it('reconcileJournal settles txs persisted before a restart without resending them', async () => {
    const journal = new MemoryLighterTxJournal();
    const { manager, state, clock } = harness({ journal, serverNonce: 22 });
    const record = (hash: string, nonce: number, expiredAt: number) => journal.recordSigned({
      txHash: hash, txType: 14, txInfo: '{}', nonce, expiredAt, accountIndex: 5, apiKeyIndex: 3, createdAt: clock.now,
    });
    record('a'.repeat(80), 20, clock.now - 60_000);   // nonce consumed -> accepted
    record('b'.repeat(80), 25, clock.now - 60_000);   // expired, never executed
    record('c'.repeat(80), 26, clock.now + 60_000);   // still valid: stays unresolved
    record('d'.repeat(80), 27, clock.now + 60_000);
    state.executed.add('d'.repeat(80));                // found by lookup
    const counts = await manager.reconcileJournal();
    expect(counts).toEqual({ accepted: 2, expired: 1, unknown: 1 });
    expect(journal.get('b'.repeat(80))?.state).toBe('expired');
    expect(manager.currentNonce).toBe(22);
    expect(state.sent).toHaveLength(0);
  });
});

describe('SqliteLighterTxJournal', () => {
  it('persists signed txs and client order ids across reopen, per profile', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lighter-journal-'));
    const filePath = path.join(dir, 'lighter.db');
    try {
      const journal = new SqliteLighterTxJournal({ filePath, profile: 'testnet' });
      journal.recordSigned({ txHash: 'f'.repeat(80), txType: 14, txInfo: '{"Index":576460752303423611}', nonce: 7, expiredAt: 123, accountIndex: 5, apiKeyIndex: 3, createdAt: Date.now(), clientOrderIndexes: [11, 12] });
      journal.saveClientOrder({ clientOrderIndex: 17922894012121, botClientOrderId: 'al_sl_ETHUSDT_1', symbol: 'ETHUSDT', marketId: 0, role: 2, createdAt: Date.now() });
      journal.close();

      const reopened = new SqliteLighterTxJournal({ filePath, profile: 'testnet' });
      expect(reopened.get('f'.repeat(80))).toMatchObject({ state: 'signed', txInfo: '{"Index":576460752303423611}', clientOrderIndexes: [11, 12] });
      expect(reopened.unresolved(5, 3)).toHaveLength(1);
      reopened.markState('f'.repeat(80), 'accepted', 'ok');
      expect(reopened.unresolved(5, 3)).toHaveLength(0);
      expect(reopened.getClientOrder(17922894012121)).toMatchObject({ botClientOrderId: 'al_sl_ETHUSDT_1', role: 2 });
      reopened.close();

      const otherProfile = new SqliteLighterTxJournal({ filePath, profile: 'mainnet' });
      expect(otherProfile.getClientOrder(17922894012121)).toBeUndefined();
      otherProfile.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('LighterClientOrderIndexGenerator (spec §5.6)', () => {
  it('encodes the role digit, stays below 2^48 and never repeats within a 10 ms bucket', () => {
    const now = 1_792_289_401_234;
    const generator = new LighterClientOrderIndexGenerator(() => now);
    const ids = Array.from({ length: 25 }, () => generator.next(2));
    expect(new Set(ids).size).toBe(25);
    for (const id of ids) {
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThanOrEqual(LIGHTER_MAX_CLIENT_ORDER_INDEX);
      expect(clientOrderIndexRole(id)).toBe(2);
    }
    expect(ids[0]).toBe((Math.floor(now / 10) * 10 + 2) * 10);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    const entry = generator.next(1);
    expect(clientOrderIndexRole(entry)).toBe(1);
    expect(ids).not.toContain(entry);
    expect(() => generator.next(5 as any)).toThrow(RangeError);
  });
});
