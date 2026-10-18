// Offline Lighter hedge mode (two sub-accounts) for tests: two FakeLighterExchange accounts on one exchange (shared
// markets and order books) behind a transport that routes each request to the account it names, plus a harness that
// builds the two inner LighterAdapters and the LighterHedgeAdapter the way the runtime does. Nothing touches the network.
import type { LighterHttpRequest, LighterHttpResponse, LighterHttpTransport } from '../../../src/lib/exchange/lighter/http';
import { LighterAdapter, type LighterAdapterOptions } from '../../../src/lib/exchange/lighter/LighterAdapter';
import {
  LighterHedgeAdapter,
  type LighterHedgeAlert,
  type LighterHedgeSide,
} from '../../../src/lib/exchange/lighter/LighterHedgeAdapter';
import { LighterMarketCache } from '../../../src/lib/exchange/lighter/markets';
import { LIGHTER_HEDGE_COI_RANGES } from '../../../src/lib/exchange/lighter/nonce';
import type { AccountUpdateEvent, UserDataEvent, UserDataHandlers } from '../../../src/lib/exchange/types';
import {
  FakeLighterExchange,
  FakeLighterSigner,
  TEST_ACCOUNT,
  TEST_KEY_INDEX,
  TEST_PUBLIC_KEY,
  THROWAWAY_PRIVATE_KEY,
  recordingSigner,
} from './fakeLighterExchange';

export const HEDGE_LONG_ACCOUNT = TEST_ACCOUNT;
export const HEDGE_LONG_KEY = TEST_KEY_INDEX;
export const HEDGE_SHORT_ACCOUNT = 23456;
export const HEDGE_SHORT_KEY = 4;
export const HEDGE_SHORT_PUBLIC_KEY = 'cd'.repeat(40);
export const HEDGE_L1_ADDRESS = '0x8b1A3c9E5f2D4b6A7c8E9f0A1b2C3d4E5f6A7b8C';

// Credentials of each side as the runtime reads them (same throwaway private key; the fake signer ignores it)
export const HEDGE_CREDENTIALS: Readonly<Record<LighterHedgeSide, Readonly<Record<string, unknown>>>> = Object.freeze({
  LONG: Object.freeze({
    profile: 'testnet',
    accountIndex: HEDGE_LONG_ACCOUNT,
    apiKeyIndex: HEDGE_LONG_KEY,
    apiKeyPrivateKey: THROWAWAY_PRIVATE_KEY,
    apiKeyPublicKey: TEST_PUBLIC_KEY,
  }),
  SHORT: Object.freeze({
    profile: 'testnet',
    accountIndex: HEDGE_SHORT_ACCOUNT,
    apiKeyIndex: HEDGE_SHORT_KEY,
    apiKeyPrivateKey: THROWAWAY_PRIVATE_KEY,
    apiKeyPublicKey: HEDGE_SHORT_PUBLIC_KEY,
  }),
});

function accountOfTxInfo(txInfo: string | undefined): number | null {
  if (!txInfo) return null;
  try {
    const account = (JSON.parse(txInfo) as { AccountIndex?: unknown }).AccountIndex;
    return typeof account === 'number' ? account : null;
  } catch {
    return null;
  }
}

export interface FakeLighterHedgeExchangeOptions {
  longL1Address?: string | null;    // null: the account has no l1_address
  shortL1Address?: string | null;
}

export class FakeLighterHedgeExchange {
  readonly long: FakeLighterExchange;
  readonly short: FakeLighterExchange;
  // Every request with the account it was routed to
  readonly routed: Array<{ side: LighterHedgeSide; request: LighterHttpRequest }> = [];

  constructor(now: () => number = Date.now, options: FakeLighterHedgeExchangeOptions = {}) {
    const longL1 = options.longL1Address === undefined ? HEDGE_L1_ADDRESS : options.longL1Address;
    const shortL1 = options.shortL1Address === undefined ? HEDGE_L1_ADDRESS : options.shortL1Address;
    this.long = new FakeLighterExchange(now, longL1 === null ? {} : { l1Address: longL1 });
    this.short = new FakeLighterExchange(now, {
      accountIndex: HEDGE_SHORT_ACCOUNT,
      apiKeyIndex: HEDGE_SHORT_KEY,
      publicKey: HEDGE_SHORT_PUBLIC_KEY,
      ...(shortL1 === null ? {} : { l1Address: shortL1 }),
      firstOrderIndex: BigInt(2) ** BigInt(48) + BigInt(900_000),
      details: this.long.details,
      books: this.long.books,
    });
  }

  fake(side: LighterHedgeSide): FakeLighterExchange {
    return side === 'LONG' ? this.long : this.short;
  }

  private sideOfAccount(account: number | null): LighterHedgeSide {
    return account === this.short.accountIndex ? 'SHORT' : 'LONG';
  }

  // The account a request belongs to: txs by their AccountIndex, reads by account_index / value, tx lookups by
  // whichever account knows the hash, other private reads by the auth token's account; market data goes to long.
  route(request: LighterHttpRequest): LighterHedgeSide {
    const url = new URL(request.url);
    const query = url.searchParams;
    if (request.method === 'POST') {
      const form = new URLSearchParams(request.body ?? '');
      const info = url.pathname === '/api/v1/sendTxBatch'
        ? (JSON.parse(form.get('tx_infos') ?? '[]') as string[])[0]
        : form.get('tx_info') ?? undefined;
      return this.sideOfAccount(accountOfTxInfo(info));
    }
    if (url.pathname === '/api/v1/account') return this.sideOfAccount(Number(query.get('value')));
    if (url.pathname === '/api/v1/tx') {
      const hash = query.get('value') ?? '';
      return this.short.txs.has(hash) || [...this.short.hashes.values()].includes(hash) ? 'SHORT' : 'LONG';
    }
    if (query.has('account_index')) return this.sideOfAccount(Number(query.get('account_index')));
    const token = request.headers?.authorization;
    if (token) return this.sideOfAccount(Number(token.split(':')[1]));
    return 'LONG';
  }

  readonly transport: LighterHttpTransport = async (request): Promise<LighterHttpResponse> => {
    const side = this.route(request);
    this.routed.push({ side, request });
    return this.fake(side).transport(request);
  };

  // Accepted txs per account
  txs(side: LighterHedgeSide, txType?: number) {
    return this.fake(side).received.filter(tx => tx.accepted && (txType === undefined || tx.txType === txType));
  }
}

export interface FakeHedgeStream {
  subscribes: number;
  closes: number;
  handlers: UserDataHandlers | null;
  emit(event: UserDataEvent): void;
  // Delivered through onBaseline while subscribing, as the real stream does after its REST seed (null: none)
  baselineOnSubscribe: AccountUpdateEvent | null;
  // The next subscribe fails with this error
  failNext: Error | null;
  // Call onConnected after subscribing (setTimeout 0)
  autoConnect: boolean;
}

export interface LighterHedgeHarnessOptions {
  credentials?: boolean;
  symbols?: string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  seedRetryMs?: ReadonlyArray<number>;
  exchange?: FakeLighterHedgeExchangeOptions;
  adapterOptions?: Partial<LighterAdapterOptions>;   // Applied to both inner adapters
}

export function lighterHedgeHarness(options: LighterHedgeHarnessOptions = {}) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, 5))));
  const exchange = new FakeLighterHedgeExchange(now, options.exchange);
  const symbols = options.symbols ?? ['ETHUSDT', 'BTCUSDT'];
  const markets = new LighterMarketCache({
    profile: 'testnet',
    symbols: () => ({ allowlist: symbols }),
    httpGet: async url => (await exchange.long.transport({ method: 'GET', url, timeoutMs: 1000 })).data,
    now,
  });
  const credentials: Record<LighterHedgeSide, Record<string, unknown>> = {
    LONG: { ...HEDGE_CREDENTIALS.LONG },
    SHORT: { ...HEDGE_CREDENTIALS.SHORT },
  };
  const current: Record<LighterHedgeSide, Record<string, unknown> | null> = {
    LONG: options.credentials ? credentials.LONG : null,
    SHORT: options.credentials ? credentials.SHORT : null,
  };
  const alerts: LighterHedgeAlert[] = [];

  const makeStream = (): FakeHedgeStream => {
    const stream: FakeHedgeStream = {
      subscribes: 0,
      closes: 0,
      handlers: null,
      baselineOnSubscribe: null,
      failNext: null,
      autoConnect: true,
      emit(event: UserDataEvent) {
        if (!stream.handlers) throw new Error('the user stream is not open');
        stream.handlers.onEvent(event);
      },
    };
    return stream;
  };
  const streams: Record<LighterHedgeSide, FakeHedgeStream> = { LONG: makeStream(), SHORT: makeStream() };

  const build = (side: LighterHedgeSide): LighterAdapter => {
    const fake = exchange.fake(side);
    const stream = streams[side];
    const account = side === 'LONG' ? HEDGE_CREDENTIALS.LONG : HEDGE_CREDENTIALS.SHORT;
    return new LighterAdapter({
      profile: 'testnet',
      credentials: () => current[side],
      markets,
      transport: exchange.transport,
      signer: recordingSigner(new FakeLighterSigner(account.accountIndex as number, account.apiKeyIndex as number, now), fake),
      journal: 'memory',
      clientOrderIndexRange: LIGHTER_HEDGE_COI_RANGES[side],
      now,
      sleep,
      // Stands in for the account stream: hands the handlers to the test
      createUserStream: async (_deps, handlers) => {
        stream.subscribes++;
        const failure = stream.failNext;
        if (failure) {
          stream.failNext = null;
          throw failure;
        }
        stream.handlers = handlers;
        if (stream.baselineOnSubscribe) handlers.onBaseline?.(stream.baselineOnSubscribe);
        if (stream.autoConnect) setTimeout(() => handlers.onConnected?.(), 0);
        return { close: async () => { stream.closes++; } };
      },
      ...options.adapterOptions,
    });
  };

  const long = build('LONG');
  const short = build('SHORT');
  const adapter = new LighterHedgeAdapter({
    long,
    short,
    onAlert: alert => alerts.push(alert),
    now,
    seedRetryMs: options.seedRetryMs ?? [5, 5, 5],
  });

  return {
    exchange,
    long,
    short,
    adapter,
    markets,
    streams,
    credentials,
    alerts,
    setCredentials(side: LighterHedgeSide, value: Record<string, unknown> | null) {
      current[side] = value;
    },
  };
}

export type LighterHedgeHarness = ReturnType<typeof lighterHedgeHarness>;
