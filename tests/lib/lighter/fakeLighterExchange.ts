// Offline Lighter exchange for adapter tests: an HTTP transport that answers the REST endpoints the adapter
// uses, executes signed txs (from the real signer or FakeLighterSigner) against a small in-memory account, and
// records every request. Nothing here touches the network.
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  LighterAccountPosition,
  LighterHttpRequest,
  LighterHttpResponse,
  LighterHttpTransport,
  LighterOrder,
  LighterSimpleOrder,
  LighterTx,
} from '../../../src/lib/exchange/lighter/http';
import {
  guardMarketIndex,
  guardNonce,
  guardOrderIndex,
  normalizeLighterOrder,
  type LighterCancelAllRequest,
  type LighterCancelOrderRequest,
  type LighterCreateOrderRequest,
  type LighterGroupedOrdersRequest,
  type LighterSignedTx,
  type LighterSigner,
  type LighterUpdateLeverageRequest,
} from '../../../src/lib/exchange/lighter/signer';

export const FIXTURE_DETAILS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'orderBookDetails.perp.json'), 'utf8')
) as { order_book_details: Array<Record<string, unknown>> };

export const TEST_ACCOUNT = 12345;
export const TEST_KEY_INDEX = 7;
export const TEST_PUBLIC_KEY = 'ab'.repeat(40);
// Generated offline with the library's GenerateAPIKey for tests only; registered nowhere, controls nothing
export const THROWAWAY_PRIVATE_KEY = '0x280f45af48b596414d4a5fd8774eb5a59157fd0e96a7bc8a5e0bbe7aceab3c67096492a24ef4b612';

// ===== Fake signer: same tx_info shapes as the native library, deterministic hash =====

const TEN_MIN_MINUS_1S = 10 * 60 * 1000 - 1000;

export class FakeLighterSigner implements LighterSigner {
  readonly chainId = 300;
  readonly libraryPath = 'fake';
  readonly librarySha256 = 'fake';
  signed: LighterSignedTx[] = [];

  constructor(readonly accountIndex = TEST_ACCOUNT, readonly apiKeyIndex = TEST_KEY_INDEX, private readonly now: () => number = Date.now) {}

  private finish(txType: number, nonce: number, body: string): LighterSignedTx {
    const expiredAt = this.now() + TEN_MIN_MINUS_1S;
    const txInfo = `{"AccountIndex":${this.accountIndex},"ApiKeyIndex":${this.apiKeyIndex},${body},"ExpiredAt":${expiredAt},"Nonce":${nonce},"Sig":"fake"}`;
    const txHash = createHash('sha512').update(txInfo).digest('hex').slice(0, 80);
    const tx = { txType, txInfo, txHash, nonce, expiredAt };
    this.signed.push(tx);
    return tx;
  }

  private orderJson(order: ReturnType<typeof normalizeLighterOrder>): string {
    return JSON.stringify(order);
  }

  signCreateOrder(request: LighterCreateOrderRequest): LighterSignedTx {
    const nonce = guardNonce(request.nonce);
    const order = normalizeLighterOrder(request, { nowMs: this.now() });
    return this.finish(14, nonce, `${this.orderJson(order).slice(1, -1)},"L2TxAttributes":null`);
  }

  signGroupedOrders(request: LighterGroupedOrdersRequest): LighterSignedTx {
    const nonce = guardNonce(request.nonce);
    const orders = request.orders.map((order, i) =>
      normalizeLighterOrder(order, { label: `orders[${i}]`, allowZeroBaseAmount: request.groupingType !== 2 && i > 0, nowMs: this.now() }));
    return this.finish(28, nonce, `"GroupingType":${request.groupingType},"Orders":[${orders.map(o => this.orderJson(o)).join(',')}],"L2TxAttributes":null`);
  }

  signCancelOrder(request: LighterCancelOrderRequest): LighterSignedTx {
    const nonce = guardNonce(request.nonce);
    const market = guardMarketIndex('marketIndex', request.marketIndex);
    const index = guardOrderIndex(request.index);
    return this.finish(15, nonce, `"MarketIndex":${market},"Index":${index.toString()},"L2TxAttributes":null`);
  }

  signCancelAll(request: LighterCancelAllRequest): LighterSignedTx {
    const nonce = guardNonce(request.nonce);
    const scope = request.marketIndex === undefined || request.marketIndex === 255 ? 'null' : `{"5":${request.marketIndex}}`;
    return this.finish(16, nonce, `"TimeInForce":${request.timeInForce},"Time":${request.time},"L2TxAttributes":${scope}`);
  }

  signUpdateLeverage(request: LighterUpdateLeverageRequest): LighterSignedTx {
    const nonce = guardNonce(request.nonce);
    return this.finish(20, nonce,
      `"MarketIndex":${request.marketIndex},"InitialMarginFraction":${request.initialMarginFraction},"MarginMode":${request.marginMode},"L2TxAttributes":null`);
  }

  createAuthToken(deadlineSec: number): string {
    return `${deadlineSec}:${this.accountIndex}:${this.apiKeyIndex}:${'c'.repeat(160)}`;
  }
}

// Wraps any signer so the fake exchange can map tx_info -> tx hash (the real hash can't be recomputed here)
export function recordingSigner(signer: LighterSigner, exchange: FakeLighterExchange): LighterSigner & { calls: string[] } {
  const calls: string[] = [];
  const track = (method: string, tx: LighterSignedTx) => {
    calls.push(method);
    exchange.registerTx(tx);
    return tx;
  };
  return {
    get chainId() { return signer.chainId; },
    get accountIndex() { return signer.accountIndex; },
    get apiKeyIndex() { return signer.apiKeyIndex; },
    get libraryPath() { return signer.libraryPath; },
    get librarySha256() { return signer.librarySha256; },
    calls,
    signCreateOrder: request => track('signCreateOrder', signer.signCreateOrder(request)),
    signGroupedOrders: request => track('signGroupedOrders', signer.signGroupedOrders(request)),
    signCancelOrder: request => track('signCancelOrder', signer.signCancelOrder(request)),
    signCancelAll: request => track('signCancelAll', signer.signCancelAll(request)),
    signUpdateLeverage: request => track('signUpdateLeverage', signer.signUpdateLeverage(request)),
    createAuthToken: deadline => {
      calls.push('createAuthToken');
      return signer.createAuthToken(deadline);
    },
  };
}

// ===== Fake exchange =====

export interface ReceivedTx {
  txType: number;
  txInfo: string;
  info: Record<string, any>;
  hash: string | undefined;
  accepted: boolean;
}

type SendResponder = (tx: { txType: number; txInfo: string; info: Record<string, any> }) => LighterHttpResponse | 'drop' | null;

const ok = (data: Record<string, unknown>): LighterHttpResponse => ({ status: 200, data: { code: 200, ...data } });
const bad = (code: number, message: string, status = 400): LighterHttpResponse => ({ status, data: { code, message } });

const TYPE_NAMES: Record<number, string> = { 0: 'limit', 1: 'market', 2: 'stop-loss', 3: 'stop-loss-limit', 4: 'take-profit', 5: 'take-profit-limit', 6: 'twap' };
const TIF_NAMES: Record<number, string> = { 0: 'immediate-or-cancel', 1: 'good-till-time', 2: 'post-only' };

export interface FakeLighterExchangeOptions {
  accountIndex?: number;                  // Default TEST_ACCOUNT
  apiKeyIndex?: number;                   // Default TEST_KEY_INDEX
  publicKey?: string;                     // Registered public key; default TEST_PUBLIC_KEY
  l1Address?: string;                     // DetailedAccount.l1_address; default: left out
  firstOrderIndex?: bigint;               // First exchange order_index; default 2^48 + 1000
  // Market data shared with another fake (hedge mode: two sub-accounts on one exchange)
  details?: Array<Record<string, unknown>>;
  books?: Map<number, { asks: LighterSimpleOrder[]; bids: LighterSimpleOrder[] }>;
}

function formatUnits(units: number, decimals: number): string {
  const digits = String(units).padStart(decimals + 1, '0');
  return decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

export class FakeLighterExchange {
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly requests: LighterHttpRequest[] = [];
  readonly received: ReceivedTx[] = [];
  nextNonce = 100;
  networkId = 300;
  publicKey = TEST_PUBLIC_KEY;
  makerOnlyKeys: number[] = [];
  authFailures = 0;                       // Upcoming private requests answered with 29500 invalid signature
  txVisible = true;                       // false: /tx never finds anything
  txLookupFailures = 0;                   // Upcoming /tx lookups answered 503
  txStatus: number | null = null;         // Status for the next executed txs (default 2)
  txPendingPolls = 0;                     // Lookups that see status 1 before the real status
  privateFailures = 0;                    // Upcoming private requests answered 503
  sendResponders: SendResponder[] = [];   // Scripted sendTx answers, consumed in order
  rejectGrouped: { code: number; message: string } | null = null;
  txFailure: { code: number; message: string } | null = null;   // Next executed tx fails (status 0), one-shot
  ignoreLeverage = false;                                        // UpdateLeverage executes but changes nothing
  orderOutcome: ((order: LighterOrder) => Partial<LighterOrder> | void) | null = null;
  readonly orders: LighterOrder[] = [];
  readonly txs = new Map<string, LighterTx>();
  readonly hashes = new Map<string, string>();   // txInfo -> hash from the signer
  readonly books: Map<number, { asks: LighterSimpleOrder[]; bids: LighterSimpleOrder[] }>;
  candles: Array<Record<string, unknown>> = [];
  details: Array<Record<string, unknown>>;
  account: {
    index: number;
    l1_address?: string;
    collateral: string;
    available_balance: string;
    total_asset_value: string;
    cross_asset_value: string;
    cross_initial_margin_requirement: string;
    cross_maintenance_margin_requirement: string;
    positions: LighterAccountPosition[];
  } = {
    index: TEST_ACCOUNT,
    collateral: '1000.000000',
    available_balance: '800.000000',
    total_asset_value: '1012.500000',
    cross_asset_value: '1012.500000',
    cross_initial_margin_requirement: '200.000000',
    cross_maintenance_margin_requirement: '120.000000',
    positions: [] as LighterAccountPosition[],
  };
  private nextOrderIndex: bigint;
  private pendingPolls = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now, options: FakeLighterExchangeOptions = {}) {
    this.accountIndex = options.accountIndex ?? TEST_ACCOUNT;
    this.apiKeyIndex = options.apiKeyIndex ?? TEST_KEY_INDEX;
    this.publicKey = options.publicKey ?? TEST_PUBLIC_KEY;
    this.nextOrderIndex = options.firstOrderIndex ?? BigInt(2) ** BigInt(48) + BigInt(1000);
    this.details = options.details ?? FIXTURE_DETAILS.order_book_details.map(item => ({ ...item }));
    this.books = options.books ?? new Map();
    this.account.index = this.accountIndex;
    if (options.l1Address !== undefined) this.account.l1_address = options.l1Address;
  }

  registerTx(tx: LighterSignedTx): void {
    this.hashes.set(tx.txInfo, tx.txHash);
  }

  setPosition(marketId: number, signedSize: string, fields: Partial<LighterAccountPosition> = {}): void {
    const details = this.details.find(d => d.market_id === marketId);
    const negative = signedSize.startsWith('-');
    const size = negative ? signedSize.slice(1) : signedSize;
    const existing = this.account.positions.find(p => p.market_id === marketId);
    const position: LighterAccountPosition = {
      market_id: marketId,
      symbol: String(details?.symbol ?? marketId),
      sign: negative ? -1 : 1,
      position: size,
      avg_entry_price: '100.00',
      position_value: '0',
      unrealized_pnl: '0.000000',
      realized_pnl: '0.000000',
      liquidation_price: '0',
      initial_margin_fraction: existing?.initial_margin_fraction ?? '20.00',
      margin_mode: 0,
      allocated_margin: '0.000000',
      ...fields,
    };
    this.account.positions = [...this.account.positions.filter(p => p.market_id !== marketId), position];
  }

  setBook(marketId: number, bids: Array<[string, string]>, asks: Array<[string, string]>): void {
    const toOrders = (levels: Array<[string, string]>) => levels.map(([price, size], i) => ({
      order_id: String(1000 + i), price, remaining_base_amount: size, initial_base_amount: size,
    }));
    this.books.set(marketId, { bids: toOrders(bids), asks: toOrders(asks) });
  }

  findOrder(coi: number): LighterOrder | undefined {
    return this.orders.find(order => order.client_order_index === coi);
  }

  accepted(): ReceivedTx[] {
    return this.received.filter(tx => tx.accepted);
  }

  readonly transport: LighterHttpTransport = async (request) => {
    this.requests.push(request);
    const url = new URL(request.url);
    const query = Object.fromEntries(url.searchParams.entries());
    if (request.method === 'POST') {
      const form = new URLSearchParams(request.body ?? '');
      if (url.pathname === '/api/v1/sendTx') return this.sendTx(Number(form.get('tx_type')), form.get('tx_info') ?? '');
      if (url.pathname === '/api/v1/sendTxBatch') {
        const types = JSON.parse(form.get('tx_types') ?? '[]') as number[];
        const infos = JSON.parse(form.get('tx_infos') ?? '[]') as string[];
        return this.sendBatch(types, infos);
      }
      return bad(20000, 'unknown endpoint', 404);
    }
    const isPrivate = ['/api/v1/accountActiveOrders', '/api/v1/accountOrders', '/api/v1/getMakerOnlyApiKeys', '/api/v1/accountLimits', '/api/v1/accountInactiveOrders'].includes(url.pathname);
    if (isPrivate) {
      const token = request.headers?.authorization ?? '';
      if (!new RegExp(`^\\d+:${this.accountIndex}:${this.apiKeyIndex}:[0-9a-f]{160}$`).test(token)) return bad(20001, 'missing or malformed auth');
      if (this.authFailures > 0) {
        this.authFailures--;
        return bad(29500, 'internal error: invalid signature');
      }
      if (this.privateFailures > 0) {
        this.privateFailures--;
        return bad(29500, 'internal server error', 503);
      }
    }
    switch (url.pathname) {
      case '/':
        return { status: 200, data: { status: 1, network_id: this.networkId, timestamp: Math.floor(this.now() / 1000) } };
      case '/api/v1/nextNonce':
        return ok({ nonce: this.nextNonce });
      case '/api/v1/apikeys':
        return ok({ api_keys: Number(query.api_key_index) === this.apiKeyIndex && Number(query.account_index) === this.accountIndex
          ? [{ account_index: this.accountIndex, api_key_index: this.apiKeyIndex, nonce: this.nextNonce, public_key: this.publicKey }]
          : [] });
      case '/api/v1/getMakerOnlyApiKeys':
        return ok({ api_key_indexes: this.makerOnlyKeys });
      case '/api/v1/accountLimits':
        return ok({ user_tier: 'std', user_tier_name: 'standard', current_taker_fee_tick: 200, current_maker_fee_tick: 0 });
      case '/api/v1/account':
        return ok({ total: 1, accounts: [JSON.parse(JSON.stringify(this.account))], next_cursor: '' });
      case '/api/v1/accountActiveOrders': {
        const market = Number(query.market_id ?? 255);
        return ok({ orders: this.orders.filter(o => ['open', 'pending', 'in-progress'].includes(o.status ?? '') && (market === 255 || o.market_index === market)) });
      }
      case '/api/v1/accountOrders': {
        const cois = (query.client_order_indexes ?? '').split(',').map(Number);
        return ok({ orders: this.orders.filter(o => cois.includes(o.client_order_index as number)).map(o => ({ ...o })) });
      }
      case '/api/v1/tx':
        return this.lookupTx(query.value ?? '');
      case '/api/v1/orderBookDetails': {
        if (query.market_id !== undefined) return ok({ order_book_details: this.details.filter(d => d.market_id === Number(query.market_id)) });
        return ok({ order_book_details: this.details, spot_order_book_details: [] });
      }
      case '/api/v1/orderBookOrders': {
        const book = this.books.get(Number(query.market_id)) ?? { asks: [], bids: [] };
        return ok({ total_asks: book.asks.length, asks: book.asks, total_bids: book.bids.length, bids: book.bids });
      }
      case '/api/v1/candles':
        return ok({ r: query.resolution, c: this.candles });
      default:
        return bad(20000, `unknown endpoint ${url.pathname}`, 404);
    }
  };

  private lookupTx(hash: string): LighterHttpResponse {
    if (this.txLookupFailures > 0) {
      this.txLookupFailures--;
      return bad(29500, 'service unavailable', 503);
    }
    const tx = this.txs.get(hash);
    if (!tx || !this.txVisible) return bad(21500, 'transaction not found');
    const polls = this.pendingPolls.get(hash) ?? 0;
    if (polls > 0) {
      this.pendingPolls.set(hash, polls - 1);
      return ok({ ...tx, status: 1 });
    }
    return ok({ ...tx });
  }

  private sendTx(txType: number, txInfo: string): LighterHttpResponse {
    const info = JSON.parse(txInfo) as Record<string, any>;
    const record: ReceivedTx = { txType, txInfo, info, hash: this.hashes.get(txInfo), accepted: false };
    this.received.push(record);
    const responder = this.sendResponders.shift();
    if (responder) {
      const scripted = responder({ txType, txInfo, info });
      if (scripted === 'drop') {
        // Executed, but the answer never reached the client
        this.execute(record);
        throw new Error('socket hang up');
      }
      if (scripted) return scripted;
    }
    if (info.Nonce !== this.nextNonce) return bad(21104, 'invalid nonce');
    if (txType === 28 && this.rejectGrouped) return bad(this.rejectGrouped.code, this.rejectGrouped.message);
    this.execute(record);
    return ok({ tx_hash: record.hash ?? '', predicted_execution_time_ms: 300, volume_quota_remaining: 1000 });
  }

  private sendBatch(types: number[], infos: string[]): LighterHttpResponse {
    const hashes: string[] = [];
    let expected = this.nextNonce;
    for (const txInfo of infos) {
      if ((JSON.parse(txInfo) as Record<string, any>).Nonce !== expected++) return bad(21104, 'invalid nonce');
    }
    types.forEach((txType, i) => {
      const record: ReceivedTx = { txType, txInfo: infos[i], info: JSON.parse(infos[i]), hash: this.hashes.get(infos[i]), accepted: false };
      this.received.push(record);
      this.execute(record);
      hashes.push(record.hash ?? '');
    });
    return ok({ tx_hash: hashes, predicted_execution_time_ms: 300, volume_quota_remaining: 1000 });
  }

  // Apply an accepted tx to the account
  private execute(record: ReceivedTx): void {
    record.accepted = true;
    this.nextNonce = record.info.Nonce + 1;
    let status = this.txStatus ?? 2;
    let eventInfo = '{}';
    const { info } = record;
    const failure = this.txFailure;
    this.txFailure = null;
    if (failure) {
      status = 0;
      eventInfo = JSON.stringify({ ae: failure.message, code: failure.code, message: failure.message });
    }
    switch (failure ? -1 : record.txType) {
      case 14:
        this.createOrder(info);
        break;
      case 28:
        for (const order of info.Orders) this.createOrder(order);
        break;
      case 15: {
        const index = /"Index":(\d+)[,}]/.exec(record.txInfo)?.[1] ?? '';
        const order = this.orders.find(o => o.market_index === info.MarketIndex &&
          (String(o.client_order_index) === index || o.order_id === index));
        if (order && ['open', 'pending', 'in-progress'].includes(order.status ?? '')) {
          order.status = 'canceled';
        } else {
          status = 0;
          eventInfo = JSON.stringify({ ae: 'order not found', code: 21600, message: 'order not found' });
        }
        break;
      }
      case 16: {
        const market = info.L2TxAttributes?.['5'];
        for (const order of this.orders) {
          if ((market === undefined || order.market_index === market) && ['open', 'pending', 'in-progress'].includes(order.status ?? '')) {
            order.status = 'canceled';
          }
        }
        break;
      }
      case 20: {
        if (this.ignoreLeverage) break;
        const existing = this.account.positions.find(p => p.market_id === info.MarketIndex);
        const percent = (info.InitialMarginFraction / 100).toFixed(2);
        if (existing) existing.initial_margin_fraction = percent;
        else this.setPosition(info.MarketIndex, '0', { initial_margin_fraction: percent });
        break;
      }
    }
    if (record.hash) {
      this.txs.set(record.hash, { hash: record.hash, type: record.txType, status, event_info: eventInfo, nonce: info.Nonce, account_index: this.accountIndex });
      if (this.txPendingPolls > 0) this.pendingPolls.set(record.hash, this.txPendingPolls);
    }
  }

  private createOrder(params: Record<string, any>): void {
    const details = this.details.find(d => d.market_id === params.MarketIndex) as Record<string, any>;
    const sd = Number(details?.size_decimals ?? 0);
    const pd = Number(details?.price_decimals ?? 0);
    const type = TYPE_NAMES[params.Type] ?? 'limit';
    const orderIndex = this.nextOrderIndex;
    this.nextOrderIndex += BigInt(1);
    const base = formatUnits(params.BaseAmount, sd);
    const order: LighterOrder = {
      order_index: Number(orderIndex),
      order_id: orderIndex.toString(),
      client_order_index: params.ClientOrderIndex,
      client_order_id: String(params.ClientOrderIndex),
      market_index: params.MarketIndex,
      owner_account_index: this.accountIndex,
      initial_base_amount: base,
      remaining_base_amount: base,
      filled_base_amount: formatUnits(0, sd),
      filled_quote_amount: '0.000000',
      price: formatUnits(params.Price, pd),
      is_ask: params.IsAsk === 1,
      type,
      time_in_force: TIF_NAMES[params.TimeInForce],
      reduce_only: params.ReduceOnly === 1,
      trigger_price: formatUnits(params.TriggerPrice, pd),
      order_expiry: params.OrderExpiry,
      status: type === 'stop-loss' || type === 'take-profit' ? 'pending' : type === 'market' ? 'filled' : 'open',
      trigger_status: type === 'stop-loss' || type === 'take-profit' ? 'mark-price' : 'na',
      created_at: Math.floor(this.now() / 1000),
      updated_at: Math.floor(this.now() / 1000),
      order_version: 1,
    };
    if (type === 'market') {
      order.filled_base_amount = base;
      order.remaining_base_amount = formatUnits(0, sd);
      order.filled_quote_amount = ((params.BaseAmount * params.Price) / 1e6).toFixed(6);
    }
    Object.assign(order, this.orderOutcome?.(order) ?? {});
    this.orders.push(order);
  }
}
