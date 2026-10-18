import { normalizeOrderId } from '../orderId';
import type {
  AccountConfigUpdateEvent,
  AccountUpdateEvent,
  OrderId,
  OrderTradeUpdateEvent,
  UserDataBalance,
  UserDataEvent,
  UserDataHandlers,
  UserDataOrder,
  UserDataPosition,
  UserDataSubscription,
} from '../types';
import { logErrorWithTimestamp, logWarnWithTimestamp, logWithTimestamp } from '../../utils/timestamp';
import { getProfile, lighterRestUrl, lighterStreamUrl, type LighterProfile, type LighterProfileName } from './profiles';
import type { LighterMarketCache } from './markets';
import { toDecimalString } from './scaling';
import {
  LighterWsClient,
  normalizeLighterChannel,
  type LighterSocketFactory,
  type LighterWsClientOptions,
  type LighterWsDisconnectInfo,
  type LighterWsFrame,
} from './ws';

// Lighter private account stream -> Binance-style user data events (spec §4.2-§4.7).
//
// One private socket ({ws}?readonly=true&encoding=json) carries four channels, each subscribed with the auth
// token (spec §1.2, §4.2):
//   account_all_orders/{acct}        full order objects             -> ORDER_TRADE_UPDATE
//   account_all_trades/{acct}        our fills (fees, realized PnL) -> enriches ORDER_TRADE_UPDATE
//   account_all_positions_fe/{acct}  positions (updates = only changed markets) -> ACCOUNT_UPDATE
//   account_all_assets/{acct}        balances                       -> triggers a REST balance refresh
//
// Money-safety rules this module enforces (spec §8):
//  - risk 11: every ACCOUNT_UPDATE carries the FULL non-zero position set plus pa "0" for each market that went
//    flat since the previous event (PositionManager clears its position map on every ACCOUNT_UPDATE). A market
//    only goes flat on an explicit zero (WS update or REST), never because a snapshot left it out: that is
//    confirmed through REST first.
//  - risk 9: all 17 Lighter order statuses are mapped explicitly; an unknown status raises an alert and a REST
//    re-sync, and the order keeps its last known state (it is never assumed inactive). A (re)subscribe snapshot
//    never produces a terminal event for an order that was not active in the last known state.
//  - risk 10: a partial fill that ends canceled-* first emits x=TRADE for the fill delta, then the terminal event.
//  - risk 12: the order id is the client order index (a number below 2^48) and otherwise the exchange order_id as
//    a decimal string; ids above 2^53 are never rounded.
//  - risk 18: the auth token is refreshed at least 30 min before its deadline, every private channel is then
//    re-subscribed with the new token and the state is reconciled through REST.
//  - §4.6: REST reconcile (account + active orders) on (re)connect, token refresh and every 30 s; an active order
//    that vanished is resolved through accountOrders / trades before any terminal event is synthesized.
// Tokens are never logged.

export const LIGHTER_MARGIN_ASSET = 'USDC';
export const LIGHTER_RECONCILE_INTERVAL_MS = 30_000;
export const LIGHTER_AUTH_REFRESH_MARGIN_MS = 30 * 60_000;   // Refresh with at least this much lifetime left
export const LIGHTER_AUTH_RETRY_MS = 60_000;                 // Retry delay after a failed refresh
export const LIGHTER_ACCOUNT_REFRESH_DEBOUNCE_MS = 1_000;    // REST /account after a WS position / asset change
export const LIGHTER_FILL_JOIN_WAIT_MS = 300;                // Hold a fill event this long for its trades
export const LIGHTER_CHANNEL_REARM_MS = 60_000;              // Re-subscribe a channel that was never acked
export const LIGHTER_UNRESOLVED_ORDER_ALERT_ATTEMPTS = 10;   // Reconciles before a vanished order raises an alert
export const LIGHTER_ACCOUNT_ORDERS_BATCH = 20;              // accountOrders takes at most 20 client order indexes
export const LIGHTER_ALL_MARKETS_ID = 255;
export const LIGHTER_MAX_CLIENT_ORDER_INDEX = 281474976710655; // 2^48 - 1
const MAX_ACCOUNT_INDEX = 281474976710654;                   // 2^48 - 2 (same bound as the signer)
const MAX_API_KEY_INDEX = 254;
const FILL_RETENTION_MS = 15 * 60_000;
const MAX_TRACKED_FILLS = 20_000;
const MAX_TRACKED_ORDERS = 5_000;

export const LIGHTER_ACCOUNT_PATH = '/api/v1/account';
export const LIGHTER_ACTIVE_ORDERS_PATH = '/api/v1/accountActiveOrders';
export const LIGHTER_ACCOUNT_ORDERS_PATH = '/api/v1/accountOrders';
export const LIGHTER_INACTIVE_ORDERS_PATH = '/api/v1/accountInactiveOrders';
export const LIGHTER_TRADES_PATH = '/api/v1/trades';

export const LIGHTER_ACCOUNT_CHANNELS = {
  orders: 'account_all_orders',
  positions: 'account_all_positions_fe',
  trades: 'account_all_trades',
  assets: 'account_all_assets',
} as const;

// Every value of Order.status in lighter-python openapi.json
export const LIGHTER_ACTIVE_ORDER_STATUSES = ['in-progress', 'pending', 'open'] as const;
export const LIGHTER_TERMINAL_ORDER_STATUSES = [
  'filled',
  'canceled',
  'canceled-post-only',
  'canceled-reduce-only',
  'canceled-position-not-allowed',
  'canceled-margin-not-allowed',
  'canceled-too-much-slippage',
  'canceled-not-enough-liquidity',
  'canceled-self-trade',
  'canceled-expired',
  'canceled-oco',
  'canceled-child',
  'canceled-liquidation',
  'canceled-invalid-balance',
] as const;
export const LIGHTER_ORDER_STATUSES: readonly string[] = [...LIGHTER_ACTIVE_ORDER_STATUSES, ...LIGHTER_TERMINAL_ORDER_STATUSES];

export type BinanceOrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'EXPIRED';

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(LIGHTER_ACTIVE_ORDER_STATUSES);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(LIGHTER_TERMINAL_ORDER_STATUSES);
const EXPIRED_STATUSES: ReadonlySet<string> = new Set(['canceled-expired', 'canceled-post-only']);

const ORDER_TYPE_MAP: Readonly<Record<string, string>> = {
  limit: 'LIMIT',
  market: 'MARKET',
  'stop-loss': 'STOP_MARKET',
  'stop-loss-limit': 'STOP',
  'take-profit': 'TAKE_PROFIT_MARKET',
  'take-profit-limit': 'TAKE_PROFIT',
  twap: 'TWAP',
  'twap-sub': 'MARKET',
  liquidation: 'LIQUIDATION',
};

const TIME_IN_FORCE_MAP: Readonly<Record<string, string>> = {
  'good-till-time': 'GTC',
  'immediate-or-cancel': 'IOC',
  'post-only': 'GTX',
};

// Binance types whose `p` is a real limit price; the others report p "0" (Lighter's worst price stays in lighterPrice)
const LIMIT_PRICED_TYPES: ReadonlySet<string> = new Set(['LIMIT', 'STOP', 'TAKE_PROFIT']);

// ===== Public types =====

export interface LighterHttpGetOptions {
  headers?: Record<string, string>;
}

// GET returning the parsed JSON body. It must forward `headers`: private endpoints take the auth token in the
// `authorization` header. Errors should keep the response body on error.response.data (axios style) so an
// expired token (code 29500 "invalid signature") can be recognised.
export type LighterAccountHttpGet = (url: string, options?: LighterHttpGetOptions) => Promise<unknown>;
export type LighterAccountHttp = LighterAccountHttpGet | { get: LighterAccountHttpGet };

export interface LighterAuthTokenRequest {
  reason: string;
  minValidMs: number;   // The stream refreshes once less than this is left, so return a token that lasts longer
  forceNew: boolean;    // The current token was rejected: do not return a cached one
}

export type LighterAccountMarkets = Pick<LighterMarketCache, 'profile' | 'isLoaded' | 'ensureLoaded' | 'findByMarketId'>;

export type LighterAccountStreamAlertKind =
  | 'unknown-status'
  | 'channel-failed'
  | 'server-error'
  | 'auth'
  | 'unresolved-order'
  | 'reconcile-failed';

export interface LighterAccountStreamAlert {
  kind: LighterAccountStreamAlertKind;
  message: string;
  orderId?: string;
  status?: string;
  channel?: string;
  code?: unknown;
}

export interface LighterUserStreamDeps {
  profile: LighterProfile | LighterProfileName;
  accountIndex: number;
  apiKeyIndex: number;
  // Token "<deadlineSec>:<account>:<apiKey>:<signature>" from LighterSigner.createAuthToken. Return one that is valid
  // for well over request.minValidMs (spec §1.2: deadline now + 6 h); never log it.
  getAuthToken(request?: LighterAuthTokenRequest): Promise<string>;
  markets: LighterAccountMarkets;
  http: LighterAccountHttp;
  wsFactory?: LighterSocketFactory;
  // Latest mark price (WS market_stats) for `mp` and the unrealized PnL between REST refreshes
  getMarkPrice?: (marketId: number) => number | null | undefined;
  // Persisted client order index -> bot clientOrderId (e.g. al_sl_...); default String(clientOrderIndex)
  resolveClientOrderId?: (clientOrderIndex: number, order: LighterOrderSnapshot) => string | undefined;
  onAlert?: (alert: LighterAccountStreamAlert) => void;
  reconcileIntervalMs?: number;
  tokenRefreshMarginMs?: number;
  tokenRetryMs?: number;
  accountRefreshDebounceMs?: number;
  fillJoinWaitMs?: number;        // 0 emits fill events at once, without waiting for their trades
  channelRearmMs?: number;
  unresolvedOrderAlertAttempts?: number;
  ws?: Partial<Omit<LighterWsClientOptions, 'url' | 'createSocket' | 'now' | 'label'>>;
  now?: () => number;
}

// One order as Lighter reports it (WS WsOrder or REST Order), amounts as canonical decimal strings in human units
export interface LighterOrderSnapshot {
  orderId: string;               // Exchange order index as a decimal string (order_id); never parsed to a number
  clientOrderIndex: number;      // 0 when the order has none
  marketId: number;
  ownerAccountIndex: number | null;
  isAsk: boolean;
  type: string;                  // limit | market | stop-loss | ... (raw)
  timeInForce: string;           // good-till-time | immediate-or-cancel | post-only (raw)
  status: string;                // raw Lighter status
  triggerStatus: string | null;
  reduceOnly: boolean;
  initialBase: string;
  filledBase: string;
  filledQuote: string;
  price: string;
  triggerPrice: string;
  orderVersion: number | null;   // REST only; the WS order objects carry none
}

export interface ParsedLighterAuthToken {
  deadlineMs: number;
  accountIndex: number;
  apiKeyIndex: number;
}

export class LighterAccountStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LighterAccountStreamError';
  }
}

// A REST body with code != 200
class LighterRestError extends Error {
  constructor(readonly path: string, readonly code: unknown, readonly serverMessage: string) {
    super(`${path} returned code ${String(code)}${serverMessage ? `: ${serverMessage}` : ''}`);
    this.name = 'LighterRestError';
  }
}

// ===== Decimal helpers (exact, BigInt based) =====

const SIGNED_DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;
const ZERO = BigInt(0);
const TEN = BigInt(10);

interface Decimal {
  units: bigint;
  scale: number;
}

function pow10(exponent: number): bigint {
  let result = BigInt(1);
  for (let i = 0; i < exponent; i++) result *= TEN;
  return result;
}

function parseDecimal(value: unknown): Decimal | null {
  let text: string;
  if (typeof value === 'string') {
    text = value.trim();
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    try {
      text = value < 0 ? `-${toDecimalString(-value)}` : toDecimalString(value);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  if (!SIGNED_DECIMAL_PATTERN.test(text)) return null;
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const units = BigInt(whole + fraction);
  return { units: negative ? -units : units, scale: fraction.length };
}

function formatDecimal(decimal: Decimal): string {
  const negative = decimal.units < ZERO;
  let digits = (negative ? -decimal.units : decimal.units).toString();
  if (decimal.scale > 0) {
    digits = digits.padStart(decimal.scale + 1, '0');
    const whole = digits.slice(0, -decimal.scale);
    const fraction = digits.slice(-decimal.scale).replace(/0+$/, '');
    digits = fraction ? `${whole}.${fraction}` : whole;
  }
  return negative && digits !== '0' ? `-${digits}` : digits;
}

// "0010.500" -> "10.5", "-0.0" -> "0", 1e-7 -> "0.0000001"; null when not a decimal
function canonicalDecimal(value: unknown): string | null {
  const decimal = parseDecimal(value);
  return decimal ? formatDecimal(decimal) : null;
}

function aligned(a: string, b: string): [bigint, bigint, number] {
  const x = parseDecimal(a) ?? { units: ZERO, scale: 0 };
  const y = parseDecimal(b) ?? { units: ZERO, scale: 0 };
  const scale = Math.max(x.scale, y.scale);
  return [x.units * pow10(scale - x.scale), y.units * pow10(scale - y.scale), scale];
}

function decAdd(a: string, b: string): string {
  const [x, y, scale] = aligned(a, b);
  return formatDecimal({ units: x + y, scale });
}

function decSub(a: string, b: string): string {
  const [x, y, scale] = aligned(a, b);
  return formatDecimal({ units: x - y, scale });
}

function decCompare(a: string, b: string): number {
  const [x, y] = aligned(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function isZero(value: string): boolean {
  return decCompare(value, '0') === 0;
}

function isPositive(value: string | null): boolean {
  return value !== null && decCompare(value, '0') > 0;
}

// Number -> plain decimal string with at most `decimals` fraction digits
function formatNumber(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '0';
  return canonicalDecimal(value.toFixed(decimals)) ?? '0';
}

// Number -> plain decimal string with 12 significant digits (prices derived by division)
function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  return canonicalDecimal(Number(value.toPrecision(12))) ?? '0';
}

// ===== Generic parsing helpers =====

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown): number | null {
  const n = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const n = integer(value);
  return n !== null && n >= 0 ? n : null;
}

function bool(value: unknown): boolean | null {
  if (value === true || value === 1 || value === 'true') return true;
  if (value === false || value === 0 || value === 'false') return false;
  return null;
}

// Decimal id text: *_str strings and safe integers only (a JSON number above 2^53 is already rounded)
function idText(value: unknown): string | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value.replace(/^0+(?=\d)/, '');
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

// Values of a Record<marketId, T | T[]> (WS) or a plain array (REST)
function flatten(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  const items: unknown[] = [];
  for (const entry of Object.values(value)) {
    if (Array.isArray(entry)) items.push(...entry);
    else if (entry !== null && entry !== undefined) items.push(entry);
  }
  return items;
}

function errorText(error: unknown): string {
  // Never print an axios error object: its config carries the authorization header
  const parts: string[] = [error instanceof Error ? error.message : String(error)];
  const data = (error as { response?: { data?: unknown } } | null)?.response?.data;
  if (isRecord(data) && (data.code !== undefined || data.message !== undefined)) {
    parts.push(`(code ${String(data.code)}: ${String(data.message ?? '')})`);
  }
  return parts.join(' ');
}

function serverErrorBody(error: unknown): { code: unknown; message: string } | null {
  if (error instanceof LighterRestError) return { code: error.code, message: error.serverMessage };
  const data = (error as { response?: { data?: unknown } } | null)?.response?.data;
  if (isRecord(data)) return { code: data.code, message: typeof data.message === 'string' ? data.message : '' };
  return null;
}

// Spec §0 #10: HTTP 400 {code: 29500, message: "...invalid signature..."} means the auth token expired or is invalid
function isAuthRejection(code: unknown, message: string): boolean {
  if (Number(code) === 29500 && /invalid signature/i.test(message)) return true;
  return /\b(auth|token)\b.{0,40}\b(invalid|expired)\b|\b(invalid|expired)\b.{0,40}\b(auth|token)\b/i.test(message);
}

function isAuthFailure(error: unknown): boolean {
  const body = serverErrorBody(error);
  return body !== null && isAuthRejection(body.code, body.message);
}

// ===== Order mapping (exported so the adapter's REST paths produce identical values) =====

export function isLighterOrderActive(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function isLighterOrderTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

// Orders that execute at once and cannot rest: Binance reports their cancel as EXPIRED. Untriggered stop-loss /
// take-profit orders are IOC on Lighter too, but their cancel (e.g. canceled-oco) is a CANCELED on Binance.
function executesImmediately(order: Pick<LighterOrderSnapshot, 'type' | 'timeInForce'>): boolean {
  return order.type === 'market' || order.type === 'twap-sub' ||
    (order.type === 'limit' && order.timeInForce === 'immediate-or-cancel');
}

// Spec §4.5 status map. null for a status outside the 17 known values: the caller must alert and re-sync,
// never treat the order as inactive.
export function mapLighterOrderStatus(
  order: Pick<LighterOrderSnapshot, 'status' | 'filledBase' | 'type' | 'timeInForce'>
): BinanceOrderStatus | null {
  const status = order.status;
  if (status === 'in-progress' || status === 'pending') return 'NEW';
  if (status === 'open') return isPositive(canonicalDecimal(order.filledBase)) ? 'PARTIALLY_FILLED' : 'NEW';
  if (status === 'filled') return 'FILLED';
  if (EXPIRED_STATUSES.has(status)) return 'EXPIRED';
  if (TERMINAL_STATUSES.has(status)) return executesImmediately(order) ? 'EXPIRED' : 'CANCELED';
  return null;
}

// Lighter type -> Binance type; an unknown type is upper-cased (e.g. 'foo-bar' -> 'FOO_BAR')
export function mapLighterOrderType(type: string): string {
  return ORDER_TYPE_MAP[type] ?? type.toUpperCase().replace(/-/g, '_');
}

export function mapLighterTimeInForce(timeInForce: string): string {
  return TIME_IN_FORCE_MAP[timeInForce] ?? (timeInForce ? timeInForce.toUpperCase().replace(/-/g, '_') : 'GTC');
}

// The bot's order id (spec §4.5 `i`, §5.6): the client order index when it has one (a number below 2^48),
// otherwise the exchange order_id (number if exactly representable, else the decimal string).
// placeOrder, getOpenOrders and ORDER_TRADE_UPDATE must all use this.
export function lighterOrderId(order: Pick<LighterOrderSnapshot, 'clientOrderIndex' | 'orderId'>): OrderId {
  const coi = order.clientOrderIndex;
  if (Number.isSafeInteger(coi) && coi >= 1 && coi <= LIGHTER_MAX_CLIENT_ORDER_INDEX) return coi;
  return normalizeOrderId(order.orderId);
}

// WS WsOrder / REST Order -> LighterOrderSnapshot; null when an identifying field is missing
export function parseLighterOrder(raw: unknown): LighterOrderSnapshot | null {
  if (!isRecord(raw)) return null;
  const orderId = idText(raw.order_id) ?? idText(raw.order_index);
  const marketId = nonNegativeInteger(raw.market_index) ?? nonNegativeInteger(raw.market_id);
  const isAsk = bool(raw.is_ask);
  const status = typeof raw.status === 'string' ? raw.status : null;
  const type = typeof raw.type === 'string' ? raw.type : null;
  if (orderId === null || marketId === null || isAsk === null || status === null || type === null) return null;

  let clientOrderIndex = nonNegativeInteger(raw.client_order_index) ?? nonNegativeInteger(raw.client_order_id) ?? 0;
  if (clientOrderIndex > LIGHTER_MAX_CLIENT_ORDER_INDEX) clientOrderIndex = 0;
  const filledBase = canonicalDecimal(raw.filled_base_amount) ?? '0';
  const remaining = canonicalDecimal(raw.remaining_base_amount);
  const initialBase = canonicalDecimal(raw.initial_base_amount) ?? (remaining !== null ? decAdd(filledBase, remaining) : '0');
  return {
    orderId,
    clientOrderIndex,
    marketId,
    ownerAccountIndex: nonNegativeInteger(raw.owner_account_index),
    isAsk,
    type,
    timeInForce: typeof raw.time_in_force === 'string' ? raw.time_in_force : '',
    status,
    triggerStatus: typeof raw.trigger_status === 'string' ? raw.trigger_status : null,
    reduceOnly: bool(raw.reduce_only) ?? false,
    initialBase,
    filledBase,
    filledQuote: canonicalDecimal(raw.filled_quote_amount) ?? '0',
    price: canonicalDecimal(raw.price) ?? '0',
    triggerPrice: canonicalDecimal(raw.trigger_price) ?? '0',
    orderVersion: nonNegativeInteger(raw.order_version),
  };
}

// "<deadlineSec>:<account>:<apiKey>:<hex signature>" (lighter-go tx_request.go). The signature is not returned.
export function parseLighterAuthToken(token: unknown): ParsedLighterAuthToken | null {
  if (typeof token !== 'string') return null;
  const match = /^(\d{1,12}):(\d{1,16}):(\d{1,3}):[0-9a-fA-F]+$/.exec(token);
  if (!match) return null;
  const deadlineSec = Number(match[1]);
  const accountIndex = Number(match[2]);
  const apiKeyIndex = Number(match[3]);
  if (!Number.isSafeInteger(deadlineSec) || !Number.isSafeInteger(accountIndex)) return null;
  return { deadlineMs: deadlineSec * 1000, accountIndex, apiKeyIndex };
}

// ===== Internal state =====

interface AuthToken {
  value: string;
  deadlineMs: number;
}

interface TrackedOrder {
  order: LighterOrderSnapshot;
  terminal: boolean;
  lastWsSeq: number;          // orderSeq of the last WS frame that carried the order (0 = REST only)
  unresolvedAttempts: number;
  alertedUnresolved: boolean;
}

interface PositionFields {
  size?: string;
  entryPrice?: string;
  imfPercent?: string;
  marginMode?: number;
  allocatedMargin?: string;
  unrealizedPnl?: string;
  liquidationPrice?: string;
}

interface PositionState {
  marketId: number;
  size: string;               // Signed, canonical; "0" when flat
  entryPrice: string;
  imfPercent: string | null;
  marginMode: number;         // 0 cross, 1 isolated
  allocatedMargin: string;
  // REST-only values, kept with the size they were reported for
  rest: { size: string; unrealizedPnl: string | null; liquidationPrice: string | null } | null;
  wsSeq: number;              // positionSeq of the last WS frame that changed this market
  missingReads: number;       // Consecutive /account replies that left this open position out
}

interface Fill {
  key: string;                // tradeId:side (a self-trade gives one fill per side)
  tradeId: string;
  orderId: string | null;
  clientOrderIndex: number | null;
  marketId: number;
  size: string;
  price: string;
  usdAmount: number;
  feeTick: number;            // Fee in 1e-6 of the notional (spec §4.5 `n`, unit unverified §9 Q14)
  isMaker: boolean;
  pnl: string | null;
  consumed: boolean;
  receivedAt: number;
}

interface PendingItem {
  event: OrderTradeUpdateEvent;
  fillDelta: string | null;   // Base amount filled by this event
  quoteDelta: string | null;
}

interface PendingQueue {
  order: LighterOrderSnapshot;
  items: PendingItem[];
  timer: ReturnType<typeof setTimeout> | null;
}

type OrderSource = 'seed' | 'snapshot' | 'update' | 'rest' | 'resolve';

type ChannelName = 'orders' | 'positions' | 'trades' | 'assets';

const CHANNEL_KIND: Readonly<Record<string, ChannelName>> = {
  account_all_orders: 'orders',
  account_all_positions_fe: 'positions',
  account_all_positions: 'positions',
  account_all_trades: 'trades',
  account_all_assets: 'assets',
};

function positionFields(raw: Record<string, unknown>): PositionFields | null {
  const fields: PositionFields = {};
  const position = canonicalDecimal(raw.position);
  if (position !== null) {
    const magnitude = position.startsWith('-') ? position.slice(1) : position;
    const sign = integer(raw.sign);
    if (isZero(magnitude)) fields.size = '0';
    else if (sign === 1) fields.size = magnitude;
    else if (sign === -1) fields.size = `-${magnitude}`;
    else if (position.startsWith('-')) fields.size = position;
    else return null; // Size without a usable sign: refuse rather than guess the direction
  }
  const entry = canonicalDecimal(raw.avg_entry_price);
  if (entry !== null) fields.entryPrice = entry;
  const imf = canonicalDecimal(raw.initial_margin_fraction);
  if (imf !== null) fields.imfPercent = imf;
  const marginMode = integer(raw.margin_mode);
  if (marginMode !== null) fields.marginMode = marginMode;
  const allocated = canonicalDecimal(raw.allocated_margin);
  if (allocated !== null) fields.allocatedMargin = allocated;
  const upnl = canonicalDecimal(raw.unrealized_pnl);
  if (upnl !== null) fields.unrealizedPnl = upnl;
  const liquidation = canonicalDecimal(raw.liquidation_price);
  if (liquidation !== null) fields.liquidationPrice = liquidation;
  return fields;
}

// ===== The stream =====

export class LighterUserStream implements UserDataSubscription {
  readonly profile: LighterProfile;
  readonly url: string;

  private readonly accountIndex: number;
  private readonly apiKeyIndex: number;
  private readonly markets: LighterAccountMarkets;
  private readonly httpGet: LighterAccountHttpGet;
  private readonly now: () => number;
  private readonly reconcileIntervalMs: number;
  private readonly tokenRefreshMarginMs: number;
  private readonly tokenRetryMs: number;
  private readonly accountRefreshDebounceMs: number;
  private readonly fillJoinWaitMs: number;
  private readonly channelRearmMs: number;
  private readonly unresolvedAlertAttempts: number;

  private client: LighterWsClient | null = null;
  private closed = false;
  private sessionGeneration = 0;
  private needsResync = false;

  private token: AuthToken | null = null;
  private tokenTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenRefresh: Promise<boolean> | null = null;
  private lastForcedRefreshAt = Number.NEGATIVE_INFINITY;

  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private accountRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private accountSync: Promise<void> | null = null;
  private accountSyncAgain = false;
  private orderSync: Promise<void> | null = null;
  private orderSyncAgain = false;
  private readonly rearmTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconcileFailing = false;

  // Positions and balance
  private positionsSeeded = false;
  private readonly positions = new Map<number, PositionState>();
  private positionSeq = 0;
  private collateral: string | null = null;
  private readonly imfByMarket = new Map<number, string>();
  private lastEmitted = new Map<number, { symbol: string; mt: string }>();
  private lastSignature: string | null = null;
  private lastWb: string | null = null;
  private pendingFunding = false;

  // Orders and fills
  private ordersSeeded = false;
  private readonly orders = new Map<string, TrackedOrder>();
  private orderSeq = 0;
  private readonly fills = new Map<string, Fill[]>();
  private readonly fillKeys = new Map<string, number>();
  private readonly owed = new Map<string, string>();
  private readonly pendingOrders = new Map<string, PendingQueue>();

  private readonly warned = new Set<string>();
  private readonly alertedUnknown = new Set<string>();

  constructor(private readonly deps: LighterUserStreamDeps, private readonly handlers: UserDataHandlers) {
    if (typeof handlers?.onEvent !== 'function') throw new LighterAccountStreamError('handlers.onEvent is required');
    if (typeof deps.getAuthToken !== 'function') throw new LighterAccountStreamError('getAuthToken is required');
    this.profile = typeof deps.profile === 'string' ? getProfile(deps.profile) : deps.profile;
    if (!Number.isSafeInteger(deps.accountIndex) || deps.accountIndex < 1 || deps.accountIndex > MAX_ACCOUNT_INDEX) {
      throw new LighterAccountStreamError(`Invalid Lighter account index ${String(deps.accountIndex)}`);
    }
    if (!Number.isSafeInteger(deps.apiKeyIndex) || deps.apiKeyIndex < 0 || deps.apiKeyIndex > MAX_API_KEY_INDEX) {
      throw new LighterAccountStreamError(`Invalid Lighter API key index ${String(deps.apiKeyIndex)}`);
    }
    // Market data from another network would map market ids to the wrong symbols (spec §1.1, §8 risk 5)
    if (deps.markets.profile.name !== this.profile.name) {
      throw new LighterAccountStreamError(
        `Lighter market data is for ${deps.markets.profile.name} but the account stream is for ${this.profile.name}`
      );
    }
    const http = deps.http;
    if (typeof http === 'function') this.httpGet = http;
    else if (http && typeof http.get === 'function') this.httpGet = (url, options) => http.get(url, options);
    else throw new LighterAccountStreamError('http is required');

    this.accountIndex = deps.accountIndex;
    this.apiKeyIndex = deps.apiKeyIndex;
    this.markets = deps.markets;
    this.url = lighterStreamUrl(this.profile);
    this.now = deps.now ?? (() => Date.now());
    this.reconcileIntervalMs = deps.reconcileIntervalMs ?? LIGHTER_RECONCILE_INTERVAL_MS;
    this.tokenRefreshMarginMs = deps.tokenRefreshMarginMs ?? LIGHTER_AUTH_REFRESH_MARGIN_MS;
    this.tokenRetryMs = deps.tokenRetryMs ?? LIGHTER_AUTH_RETRY_MS;
    this.accountRefreshDebounceMs = deps.accountRefreshDebounceMs ?? LIGHTER_ACCOUNT_REFRESH_DEBOUNCE_MS;
    this.fillJoinWaitMs = deps.fillJoinWaitMs ?? LIGHTER_FILL_JOIN_WAIT_MS;
    this.channelRearmMs = deps.channelRearmMs ?? LIGHTER_CHANNEL_REARM_MS;
    this.unresolvedAlertAttempts = deps.unresolvedOrderAlertAttempts ?? LIGHTER_UNRESOLVED_ORDER_ALERT_ATTEMPTS;
  }

  // ===== Lifecycle =====

  // Resolves once the market data and an auth token are in hand, the REST baseline was attempted and the socket
  // is starting (handlers.onConnected fires when the private channels are subscribed). Rejects when the market
  // data or the token cannot be obtained.
  async open(): Promise<void> {
    if (this.closed) throw new LighterAccountStreamError('Lighter user stream is closed');
    if (this.client) return;
    await this.markets.ensureLoaded();
    this.token = await this.obtainToken('open', false);
    if (this.closed) return;
    this.scheduleTokenRefresh();

    // REST baseline: what the bot already synced is not replayed as events. When it fails, the first WS snapshot
    // becomes the baseline instead and the periodic reconcile keeps retrying.
    await this.reconcile('open');
    if (this.closed) return;

    const client = new LighterWsClient(
      { ...this.deps.ws, url: this.url, createSocket: this.deps.wsFactory, now: this.now, label: 'Lighter user stream' },
      {
        onMessage: (frame) => this.handleFrame(frame),
        onSessionReady: () => this.handleSessionReady(),
        onDisconnected: (info) => this.handleDisconnected(info),
        onFrameError: (error) => logWarnWithTimestamp('Lighter user stream: unreadable frame:', errorText(error)),
        onServerError: (error) => this.handleServerError(error),
        onChannelFailed: (channel, attempts) => this.handleChannelFailed(channel, attempts),
        onShutdownNotice: (closeInMs) => {
          logWithTimestamp(`Lighter user stream: server shutdown notice (closes in ${closeInMs ?? '?'} ms); reconnecting now`);
        },
      }
    );
    this.client = client;
    if (this.reconcileIntervalMs > 0) {
      this.reconcileTimer = setInterval(() => {
        this.pruneFills();
        void this.reconcile('periodic');
      }, this.reconcileIntervalMs);
    }
    client.start();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.sessionGeneration++;
    if (this.tokenTimer) clearTimeout(this.tokenTimer);
    this.tokenTimer = null;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    if (this.accountRefreshTimer) clearTimeout(this.accountRefreshTimer);
    this.accountRefreshTimer = null;
    for (const timer of this.rearmTimers.values()) clearTimeout(timer);
    this.rearmTimers.clear();
    // Held fill events are dropped: nothing is emitted after close
    for (const queue of this.pendingOrders.values()) {
      if (queue.timer) clearTimeout(queue.timer);
    }
    this.pendingOrders.clear();
    const client = this.client;
    this.client = null;
    client?.stop();
    logWithTimestamp('Lighter user stream: closed');
  }

  // ===== Session handling =====

  private channelName(kind: ChannelName): string {
    return `${LIGHTER_ACCOUNT_CHANNELS[kind]}/${this.accountIndex}`;
  }

  private channels(): string[] {
    return (Object.keys(LIGHTER_ACCOUNT_CHANNELS) as ChannelName[]).map(kind => this.channelName(kind));
  }

  private isCurrentSession(generation: number): boolean {
    return !this.closed && generation === this.sessionGeneration && this.client?.isSessionReady === true;
  }

  private handleSessionReady(): void {
    const generation = ++this.sessionGeneration;
    void this.establishSession(generation);
  }

  private async establishSession(generation: number): Promise<void> {
    const resync = this.needsResync;
    if (resync && this.handlers.beforeReconnect) {
      try {
        await this.handlers.beforeReconnect();
      } catch (error) {
        logErrorWithTimestamp('Lighter user stream: re-sync before reconnect failed (continuing):', errorText(error));
      }
    }
    if (!this.isCurrentSession(generation)) return;
    if (!this.token || this.token.deadlineMs - this.now() <= this.tokenRefreshMarginMs) {
      await this.refreshToken('session start', false);
      if (!this.isCurrentSession(generation)) return;
    }
    if (!this.token) {
      logErrorWithTimestamp('Lighter user stream: no auth token; private channels not subscribed (retrying)');
      return;
    }
    this.subscribeAll();
    this.needsResync = false;
    logWithTimestamp(`Lighter user stream: connected to ${this.profile.name}, account ${this.accountIndex}`);
    this.safely(() => this.handlers.onConnected?.());
    if (resync) void this.reconcile('reconnect');
  }

  private subscribeAll(): void {
    const client = this.client;
    const token = this.token;
    if (!client || !token) return;
    for (const channel of this.channels()) client.subscribe(channel, { auth: token.value });
  }

  // Swap the token on live channels: unsubscribe, then subscribe with the new auth (the new snapshot is diffed
  // against the known state, so nothing in between is lost)
  private resubscribeAll(): void {
    const client = this.client;
    const token = this.token;
    if (!client || !token || !client.isSessionReady) return;
    for (const channel of this.channels()) {
      client.unsubscribe(channel);
      client.subscribe(channel, { auth: token.value });
    }
  }

  private handleDisconnected(info: LighterWsDisconnectInfo): void {
    this.sessionGeneration++;
    if (this.closed || info.reason === 'stopped') return;
    this.needsResync = true;
    // Forget the subscriptions: the next session subscribes again after beforeReconnect, with a current token
    const client = this.client;
    if (client) {
      for (const channel of this.channels()) client.unsubscribe(channel);
    }
    const delay = info.reconnectDelayMs === null ? '' : ` (reconnecting in ${info.reconnectDelayMs} ms)`;
    logWarnWithTimestamp(`Lighter user stream: disconnected: ${info.reason}${info.error ? ` - ${info.error.message}` : ''}${delay}`);
    const error = info.error;
    if (error) this.safely(() => this.handlers.onError?.(error));
    this.safely(() => this.handlers.onDisconnected?.(error));
  }

  private handleServerError(error: { code?: unknown; message?: unknown }): void {
    const message = typeof error.message === 'string' ? error.message : String(error.message ?? '');
    if (isAuthRejection(error.code, message)) {
      logWarnWithTimestamp(`Lighter user stream: server rejected the auth token (code ${String(error.code)}); refreshing it`);
      void this.refreshToken('server rejected the auth token', true);
      return;
    }
    this.alert({ kind: 'server-error', code: error.code, message: `server error frame (code ${String(error.code)}): ${message}` });
  }

  private handleChannelFailed(channel: string, attempts: number): void {
    this.alert({
      kind: 'channel-failed',
      channel,
      message: `${channel} was not acknowledged after ${attempts} attempts; until it is, changes on it are only seen through the REST reconcile`,
    });
    if (this.rearmTimers.has(channel) || this.channelRearmMs <= 0) return;
    this.rearmTimers.set(channel, setTimeout(() => {
      this.rearmTimers.delete(channel);
      const client = this.client;
      if (this.closed || !client || !client.isSessionReady || !client.isFailed(channel) || !this.token) return;
      logWithTimestamp(`Lighter user stream: subscribing to ${channel} again`);
      client.unsubscribe(channel);
      client.subscribe(channel, { auth: this.token.value });
    }, this.channelRearmMs));
  }

  // ===== Auth token =====

  private async obtainToken(reason: string, forceNew: boolean): Promise<AuthToken> {
    const value = await this.deps.getAuthToken({ reason, minValidMs: this.tokenRefreshMarginMs, forceNew });
    const parsed = parseLighterAuthToken(value);
    if (!parsed) {
      throw new LighterAccountStreamError('getAuthToken returned a value that is not a Lighter auth token (<deadline>:<account>:<key>:<signature>)');
    }
    if (parsed.accountIndex !== this.accountIndex) {
      throw new LighterAccountStreamError(`auth token is for account ${parsed.accountIndex}, not ${this.accountIndex}`);
    }
    if (parsed.apiKeyIndex !== this.apiKeyIndex && !this.warned.has('token-key')) {
      this.warned.add('token-key');
      logWarnWithTimestamp(`Lighter user stream: auth token uses API key ${parsed.apiKeyIndex} (trading key ${this.apiKeyIndex})`);
    }
    const remaining = parsed.deadlineMs - this.now();
    if (remaining <= 0) throw new LighterAccountStreamError('getAuthToken returned an expired auth token');
    if (remaining <= this.tokenRefreshMarginMs) {
      logWarnWithTimestamp(`Lighter user stream: new auth token is only valid for ${Math.round(remaining / 60_000)} min`);
    }
    return { value: value as string, deadlineMs: parsed.deadlineMs };
  }

  // Get a new token; returns true when the token changed. A changed token is pushed to every private channel and
  // followed by a REST reconcile. Forced refreshes (rejected token) run at most once per tokenRetryMs.
  private refreshToken(reason: string, force: boolean): Promise<boolean> {
    if (this.tokenRefresh) return this.tokenRefresh;
    if (force) {
      if (this.now() - this.lastForcedRefreshAt < this.tokenRetryMs) return Promise.resolve(false);
      this.lastForcedRefreshAt = this.now();
    }
    this.tokenRefresh = (async () => {
      try {
        const next = await this.obtainToken(reason, force);
        if (this.closed) return false;
        const previous = this.token;
        const changed = !previous || next.value !== previous.value;
        if (!changed) {
          if (force) this.alert({ kind: 'auth', message: `auth token was rejected (${reason}) and getAuthToken returned the same token` });
          this.scheduleTokenRefresh();
          return false;
        }
        if (previous && !force && next.deadlineMs <= previous.deadlineMs) {
          logWarnWithTimestamp('Lighter user stream: getAuthToken did not return a longer-lived token; keeping the current one');
          this.scheduleTokenRefresh();
          return false;
        }
        this.token = next;
        this.scheduleTokenRefresh();
        logWithTimestamp(`Lighter user stream: auth token refreshed (${reason}); valid until ${new Date(next.deadlineMs).toISOString()}`);
        if (previous) {
          this.resubscribeAll();
          void this.reconcile('token refresh');
        }
        return true;
      } catch (error) {
        this.alert({ kind: 'auth', message: `auth token refresh failed (${reason}): ${errorText(error)}` });
        this.scheduleTokenRefresh(this.tokenRetryMs);
        return false;
      } finally {
        this.tokenRefresh = null;
      }
    })();
    return this.tokenRefresh;
  }

  private scheduleTokenRefresh(delayMs?: number): void {
    if (this.tokenTimer) clearTimeout(this.tokenTimer);
    this.tokenTimer = null;
    if (this.closed) return;
    let delay = delayMs;
    if (delay === undefined) {
      if (!this.token) return;
      delay = this.token.deadlineMs - this.tokenRefreshMarginMs - this.now();
      if (delay <= 0) delay = this.tokenRetryMs; // Already inside the margin: retry until a longer one comes back
    }
    this.tokenTimer = setTimeout(() => {
      this.tokenTimer = null;
      void this.refreshToken('scheduled refresh', false);
    }, delay);
    (this.tokenTimer as { unref?: () => void }).unref?.();
  }

  // ===== REST =====

  private async restGet(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    auth: boolean
  ): Promise<Record<string, unknown>> {
    const url = lighterRestUrl(this.profile, path, query);
    const attempt = async (): Promise<Record<string, unknown>> => {
      let options: LighterHttpGetOptions | undefined;
      if (auth) {
        if (!this.token) throw new LighterAccountStreamError('no auth token');
        options = { headers: { authorization: this.token.value } };
      }
      const body = await this.httpGet(url, options);
      if (!isRecord(body)) throw new LighterAccountStreamError(`${path} did not return a JSON object`);
      if (body.code !== undefined && body.code !== 200) {
        throw new LighterRestError(path, body.code, typeof body.message === 'string' ? body.message : '');
      }
      return body;
    };
    try {
      return await attempt();
    } catch (error) {
      if (!auth || !isAuthFailure(error)) throw error;
      const refreshed = await this.refreshToken(`${path} rejected the auth token`, true);
      if (!refreshed) throw error;
      return attempt();
    }
  }

  // ===== Reconcile (spec §4.6) =====

  private reconcile(reason: string): Promise<void> {
    return Promise.all([this.syncAccount(reason), this.syncOrders(reason)]).then(() => undefined);
  }

  private syncAccount(reason: string): Promise<void> {
    if (this.accountSync) {
      this.accountSyncAgain = true;
      return this.accountSync;
    }
    this.accountSync = (async () => {
      try {
        do {
          this.accountSyncAgain = false;
          await this.guarded(`account (${reason})`, () => this.fetchAccount());
        } while (this.accountSyncAgain && !this.closed);
      } finally {
        this.accountSync = null;
      }
    })();
    return this.accountSync;
  }

  private syncOrders(reason: string): Promise<void> {
    if (this.orderSync) {
      this.orderSyncAgain = true;
      return this.orderSync;
    }
    this.orderSync = (async () => {
      try {
        do {
          this.orderSyncAgain = false;
          await this.guarded(`orders (${reason})`, () => this.fetchOrders());
        } while (this.orderSyncAgain && !this.closed);
      } finally {
        this.orderSync = null;
      }
    })();
    return this.orderSync;
  }

  private async guarded(label: string, task: () => Promise<void>): Promise<void> {
    try {
      await task();
      if (this.reconcileFailing) {
        this.reconcileFailing = false;
        logWithTimestamp('Lighter user stream: REST reconcile recovered');
      }
    } catch (error) {
      if (this.closed) return;
      const message = `REST reconcile of ${label} failed: ${errorText(error)}`;
      if (!this.reconcileFailing) {
        this.reconcileFailing = true;
        this.alert({ kind: 'reconcile-failed', message });
      } else {
        logWarnWithTimestamp(`Lighter user stream: ${message}`);
      }
    }
  }

  private scheduleAccountRefresh(): void {
    if (this.closed || this.accountRefreshTimer) return;
    this.accountRefreshTimer = setTimeout(() => {
      this.accountRefreshTimer = null;
      void this.syncAccount('account change');
    }, this.accountRefreshDebounceMs);
  }

  private async fetchAccount(): Promise<void> {
    const startSeq = this.positionSeq;
    const body = await this.restGet(LIGHTER_ACCOUNT_PATH, { by: 'index', value: this.accountIndex, active_only: false }, false);
    if (this.closed) return;
    const account = this.pickAccount(body);
    this.applyRestAccount(account, startSeq);
  }

  private pickAccount(body: Record<string, unknown>): Record<string, unknown> {
    if (Array.isArray(body.accounts)) {
      const account = body.accounts.find(item =>
        isRecord(item) && (integer(item.index) === this.accountIndex || integer(item.account_index) === this.accountIndex)
      );
      if (isRecord(account)) return account;
      throw new LighterAccountStreamError(`account ${this.accountIndex} is missing from the /account response`);
    }
    if (Array.isArray(body.positions)) return body;
    throw new LighterAccountStreamError('/account response has no accounts');
  }

  private applyRestAccount(account: Record<string, unknown>, startSeq: number): void {
    const seeding = !this.positionsSeeded;
    const rawPositions = Array.isArray(account.positions) ? account.positions : [];
    const seen = new Set<number>();
    for (const raw of rawPositions) {
      if (!isRecord(raw)) continue;
      const marketId = nonNegativeInteger(raw.market_id);
      if (marketId !== null) seen.add(marketId); // Listed, even if unreadable: never counted as missing
      const fields = positionFields(raw);
      if (marketId === null || !fields || fields.size === undefined) {
        this.warnOnce(`rest-position-${String(raw.market_id)}`, `ignoring an unreadable /account position for market ${String(raw.market_id)}`);
        continue;
      }
      const state = this.positions.get(marketId);
      const rest = {
        size: fields.size,
        unrealizedPnl: fields.unrealizedPnl ?? null,
        liquidationPrice: fields.liquidationPrice ?? null,
      };
      if (state && state.wsSeq > startSeq) {
        // The WS changed this market while the request was out: keep the WS size; REST extras only if they agree
        if (state.size === fields.size) state.rest = rest;
        continue;
      }
      this.setPosition(marketId, fields, null, seeding);
      const next = this.positions.get(marketId);
      if (next) next.rest = rest;
    }
    // REST lists every market the account has touched (a closed one as position "0"). An open position that is
    // simply left out is only treated as closed when the next reply leaves it out too: closing a live position
    // by mistake would make PositionManager cancel its stop-loss.
    let confirm = false;
    for (const state of this.positions.values()) {
      if (seen.has(state.marketId) || state.wsSeq > startSeq || isZero(state.size)) continue;
      state.missingReads++;
      if (state.missingReads < 2) {
        confirm = true;
        continue;
      }
      logWarnWithTimestamp(`Lighter user stream: market ${state.marketId} position is no longer listed by /account; treating it as closed`);
      state.size = '0';
      state.rest = null;
      state.missingReads = 0;
    }
    const collateral = canonicalDecimal(account.collateral);
    if (collateral !== null) this.collateral = collateral;

    if (seeding) {
      this.positionsSeeded = true;
      this.markBaseline();
    } else {
      this.emitAccountUpdate();
    }
    if (confirm) this.scheduleAccountRefresh();
  }

  private async fetchOrders(): Promise<void> {
    const startSeq = this.orderSeq;
    const body = await this.restGet(
      LIGHTER_ACTIVE_ORDERS_PATH,
      { account_index: this.accountIndex, market_id: LIGHTER_ALL_MARKETS_ID, market_type: 'perp' },
      true
    );
    if (this.closed) return;
    const seeding = !this.ordersSeeded;
    const seen = new Set<string>();
    for (const raw of flatten(body.orders)) {
      const order = this.readOrder(raw);
      if (!order) continue;
      seen.add(order.orderId);
      const tracked = this.orders.get(order.orderId);
      if (tracked && tracked.lastWsSeq > startSeq) continue; // The WS is newer
      this.applyOrder(order, seeding ? 'seed' : 'rest', 0);
    }
    if (seeding) {
      this.ordersSeeded = true;
      return;
    }
    if (typeof body.next_cursor === 'string' && body.next_cursor !== '') {
      this.warnOnce('active-orders-paged', 'accountActiveOrders returned more than one page; skipping vanished-order detection');
      return;
    }
    const vanished = [...this.orders.values()].filter(tracked =>
      !tracked.terminal && !seen.has(tracked.order.orderId) && tracked.lastWsSeq <= startSeq
    );
    if (vanished.length > 0) await this.resolveVanished(vanished);
  }

  // Active orders the exchange no longer lists: look each one up and only then synthesize what happened
  private async resolveVanished(vanished: TrackedOrder[]): Promise<void> {
    const resolved = new Map<string, LighterOrderSnapshot>();
    const consider = (raw: unknown) => {
      const order = this.readOrder(raw);
      if (order && vanished.some(tracked => tracked.order.orderId === order.orderId)) resolved.set(order.orderId, order);
    };

    const withIndex = vanished.filter(tracked => tracked.order.clientOrderIndex > 0);
    for (let i = 0; i < withIndex.length; i += LIGHTER_ACCOUNT_ORDERS_BATCH) {
      const batch = withIndex.slice(i, i + LIGHTER_ACCOUNT_ORDERS_BATCH);
      try {
        const body = await this.restGet(
          LIGHTER_ACCOUNT_ORDERS_PATH,
          { account_index: this.accountIndex, client_order_indexes: batch.map(tracked => tracked.order.clientOrderIndex).join(',') },
          true
        );
        for (const raw of flatten(body.orders)) consider(raw);
      } catch (error) {
        logWarnWithTimestamp('Lighter user stream: accountOrders lookup failed:', errorText(error));
      }
    }
    // Orders without a client order index (placed outside the bot): search the market's inactive orders
    const foreignMarkets = new Set(vanished.filter(tracked => tracked.order.clientOrderIndex === 0).map(tracked => tracked.order.marketId));
    for (const marketId of foreignMarkets) {
      try {
        const body = await this.restGet(
          LIGHTER_INACTIVE_ORDERS_PATH,
          { account_index: this.accountIndex, market_id: marketId, limit: 100 },
          true
        );
        for (const raw of flatten(body.orders)) consider(raw);
      } catch (error) {
        logWarnWithTimestamp(`Lighter user stream: accountInactiveOrders lookup for market ${marketId} failed:`, errorText(error));
      }
    }
    if (this.closed) return;

    for (const tracked of vanished) {
      const order = resolved.get(tracked.order.orderId);
      const current = this.orders.get(tracked.order.orderId);
      if (!current || current.terminal) continue; // Settled by the WS meanwhile
      if (!order) {
        current.unresolvedAttempts++;
        if (current.unresolvedAttempts >= this.unresolvedAlertAttempts && !current.alertedUnresolved) {
          current.alertedUnresolved = true;
          this.alert({
            kind: 'unresolved-order',
            orderId: current.order.orderId,
            message: `order ${current.order.orderId} (client index ${current.order.clientOrderIndex}) is no longer listed as active and could not be found; it is still treated as active`,
          });
        }
        continue;
      }
      if (decCompare(order.filledBase, current.order.filledBase) > 0) await this.fetchOrderTrades(order.orderId);
      if (this.closed) return;
      this.applyOrder(order, 'resolve', 0);
    }
  }

  private async fetchOrderTrades(orderId: string): Promise<void> {
    try {
      const body = await this.restGet(
        LIGHTER_TRADES_PATH,
        { account_index: this.accountIndex, sort_by: 'trade_id', limit: 100, order_index_str: orderId },
        true
      );
      for (const raw of flatten(body.trades)) this.addTradeFills(raw);
    } catch (error) {
      logWarnWithTimestamp(`Lighter user stream: trades lookup for order ${orderId} failed (fees and realized PnL left out):`, errorText(error));
    }
  }

  // ===== WS frames =====

  private handleFrame(frame: LighterWsFrame): void {
    if (this.closed || typeof frame.channel !== 'string' || typeof frame.type !== 'string') return;
    const channel = normalizeLighterChannel(frame.channel);
    const [name, account] = channel.split('/');
    const kind = CHANNEL_KIND[name];
    if (!kind) return;
    if (integer(account) !== this.accountIndex) {
      this.warnOnce(`foreign-${channel}`, `ignoring ${channel}: not account ${this.accountIndex}`);
      return;
    }
    const snapshot = frame.type.startsWith('subscribed');
    if (!snapshot && !frame.type.startsWith('update')) return;
    switch (kind) {
      case 'orders':
        this.handleOrdersFrame(frame, snapshot);
        break;
      case 'positions':
        this.handlePositionsFrame(frame, snapshot);
        break;
      case 'trades':
        if (!snapshot) this.handleTradesFrame(frame); // The snapshot holds volume counters only
        break;
      case 'assets':
        if (!snapshot && this.positionsSeeded) this.scheduleAccountRefresh();
        break;
    }
  }

  private handlePositionsFrame(frame: LighterWsFrame, snapshot: boolean): void {
    const seq = ++this.positionSeq;
    const seeding = !this.positionsSeeded;
    if (isRecord(frame.last_funding_round) && Object.keys(frame.last_funding_round).length > 0) this.pendingFunding = true;

    const entries: Array<[number, Record<string, unknown>]> = [];
    if (isRecord(frame.positions)) {
      for (const [key, raw] of Object.entries(frame.positions)) {
        if (!isRecord(raw)) continue;
        const marketId = nonNegativeInteger(raw.market_id) ?? nonNegativeInteger(key);
        if (marketId !== null) entries.push([marketId, raw]);
      }
    } else if (Array.isArray(frame.positions)) {
      for (const raw of frame.positions) {
        const marketId = isRecord(raw) ? nonNegativeInteger(raw.market_id) : null;
        if (marketId !== null) entries.push([marketId, raw as Record<string, unknown>]);
      }
    }

    const seen = new Set<number>();
    let unreadable = false;
    for (const [marketId, raw] of entries) {
      const fields = positionFields(raw);
      if (!fields) {
        unreadable = true;
        this.warnOnce(`ws-position-${marketId}`, `position update for market ${marketId} has a size without a sign; asking REST`);
        continue;
      }
      seen.add(marketId);
      this.setPosition(marketId, fields, seq, seeding);
    }

    // A snapshot that leaves out an open position does not close it: REST confirms first (spec §8 risk 11)
    let missing = false;
    if (snapshot) {
      for (const state of this.positions.values()) {
        if (!seen.has(state.marketId) && !isZero(state.size)) missing = true;
      }
    }

    if (seeding) {
      if (snapshot) {
        this.positionsSeeded = true;
        this.markBaseline();
      }
    } else {
      this.emitAccountUpdate();
      this.scheduleAccountRefresh();
    }
    if (missing || unreadable) void this.syncAccount('positions snapshot');
  }

  private setPosition(marketId: number, fields: PositionFields, wsSeq: number | null, seeding: boolean): void {
    const previous = this.positions.get(marketId);
    const state: PositionState = previous ?? {
      marketId,
      size: '0',
      entryPrice: '0',
      imfPercent: null,
      marginMode: 0,
      allocatedMargin: '0',
      rest: null,
      wsSeq: 0,
      missingReads: 0,
    };
    if (fields.size !== undefined) state.size = fields.size;
    if (fields.entryPrice !== undefined) state.entryPrice = fields.entryPrice;
    if (fields.marginMode !== undefined) state.marginMode = fields.marginMode;
    if (fields.allocatedMargin !== undefined) state.allocatedMargin = fields.allocatedMargin;
    if (fields.imfPercent !== undefined) state.imfPercent = fields.imfPercent;
    if (wsSeq !== null) state.wsSeq = wsSeq;
    state.missingReads = 0;
    if (isZero(state.size)) state.rest = null;
    this.positions.set(marketId, state);
    if (fields.imfPercent !== undefined) this.noteLeverage(marketId, fields.imfPercent, seeding);
  }

  // ACCOUNT_CONFIG_UPDATE when a market's initial margin fraction (a percent: "20.00" = 5x) changes
  private noteLeverage(marketId: number, imfPercent: string, seeding: boolean): void {
    const previous = this.imfByMarket.get(marketId);
    this.imfByMarket.set(marketId, imfPercent);
    if (seeding || previous === imfPercent) return;
    const percent = Number(imfPercent);
    const symbol = this.symbolFor(marketId, true);
    if (!symbol || !(percent > 0)) return;
    const now = this.now();
    const event: AccountConfigUpdateEvent = { e: 'ACCOUNT_CONFIG_UPDATE', E: now, T: now, ac: { s: symbol, l: Math.round(100 / percent) } };
    this.emit(event);
  }

  private handleOrdersFrame(frame: LighterWsFrame, snapshot: boolean): void {
    const seq = ++this.orderSeq;
    const seeding = snapshot && !this.ordersSeeded;
    const seen = new Set<string>();
    for (const raw of flatten(frame.orders)) {
      const order = this.readOrder(raw);
      if (!order) {
        void this.syncOrders('unreadable order frame');
        continue;
      }
      seen.add(order.orderId);
      this.applyOrder(order, seeding ? 'seed' : snapshot ? 'snapshot' : 'update', seq);
    }
    if (seeding) {
      this.ordersSeeded = true;
      return;
    }
    if (snapshot) {
      // Active orders missing from a snapshot are looked up through REST, never assumed gone
      const missing = [...this.orders.values()].some(tracked => !tracked.terminal && !seen.has(tracked.order.orderId));
      if (missing) void this.syncOrders('orders snapshot');
    }
  }

  private handleTradesFrame(frame: LighterWsFrame): void {
    for (const raw of flatten(frame.trades)) this.addTradeFills(raw);
    for (const key of [...this.pendingOrders.keys()]) this.tryFlush(key);
  }

  // ===== Orders =====

  private readOrder(raw: unknown): LighterOrderSnapshot | null {
    const order = parseLighterOrder(raw);
    if (!order) {
      this.warnOnce('unreadable-order', 'ignoring an order object without order_id / market / side / status / type');
      return null;
    }
    if (order.ownerAccountIndex !== null && order.ownerAccountIndex !== this.accountIndex) return null;
    return order;
  }

  private applyOrder(order: LighterOrderSnapshot, source: OrderSource, wsSeq: number): void {
    const tracked = this.orders.get(order.orderId);
    if (tracked && wsSeq > 0) tracked.lastWsSeq = wsSeq;

    if (mapLighterOrderStatus(order) === null) {
      // Unknown status: alert and re-sync; the order keeps its last known state (spec §8 risk 9)
      const key = `${order.orderId}:${order.status}`;
      if (!this.alertedUnknown.has(key)) {
        this.alertedUnknown.add(key);
        this.alert({
          kind: 'unknown-status',
          orderId: order.orderId,
          status: order.status,
          message: `order ${order.orderId} has unknown status "${order.status}"; keeping its last known state and re-syncing`,
        });
      }
      if (source === 'update' || source === 'snapshot') void this.syncOrders('unknown order status');
      return;
    }

    const terminal = isLighterOrderTerminal(order.status);
    if (!tracked) {
      this.trackOrder(order, terminal, wsSeq);
      if (source === 'seed') return;
      // A snapshot or REST listing of an order that was never active in our state: record it, emit nothing
      if (terminal && (source === 'snapshot' || source === 'rest')) return;
      const symbol = this.symbolFor(order.marketId);
      if (!symbol) return;
      const items: PendingItem[] = [];
      if (order.type !== 'liquidation') {
        items.push({ event: this.buildOrderEvent(order, symbol, 'NEW', 'NEW', '0', '0', '0'), fillDelta: null, quoteDelta: null });
      }
      const opened: LighterOrderSnapshot = { ...order, status: 'open', filledBase: '0', filledQuote: '0' };
      items.push(...this.transitionItems(opened, order, symbol));
      this.enqueue(order, items, source === 'resolve');
      return;
    }

    if (tracked.terminal) return; // Terminal is final
    const previous = tracked.order;
    if (sameOrderState(previous, order)) return;
    if (decCompare(order.filledBase, previous.filledBase) < 0) {
      // Older data than what we have (e.g. a REST reply that crossed a WS update): ignore it
      return;
    }
    tracked.order = order;
    tracked.terminal = terminal;
    tracked.unresolvedAttempts = 0;
    if (source === 'seed') return;
    const symbol = this.symbolFor(order.marketId);
    if (!symbol) return;
    this.enqueue(order, this.transitionItems(previous, order, symbol), source === 'resolve');
  }

  private trackOrder(order: LighterOrderSnapshot, terminal: boolean, wsSeq: number): void {
    this.orders.set(order.orderId, { order, terminal, lastWsSeq: wsSeq, unresolvedAttempts: 0, alertedUnresolved: false });
    if (this.orders.size <= MAX_TRACKED_ORDERS) return;
    // Forget the oldest terminal orders (insertion order)
    for (const [orderId, tracked] of this.orders) {
      if (this.orders.size <= MAX_TRACKED_ORDERS * 0.8) break;
      if (tracked.terminal) this.orders.delete(orderId);
    }
  }

  // Events for previous -> next (spec §4.5): the fill delta first (x=TRADE), then the terminal event
  private transitionItems(previous: LighterOrderSnapshot, next: LighterOrderSnapshot, symbol: string): PendingItem[] {
    const items: PendingItem[] = [];
    const status = mapLighterOrderStatus(next);
    if (status === null) return items;
    const fillExecution = next.type === 'liquidation' ? 'CALCULATED' : 'TRADE';
    const delta = decSub(next.filledBase, previous.filledBase);
    const terminal = isLighterOrderTerminal(next.status);

    if (isPositive(delta)) {
      const fillStatus = next.status === 'filled' ? 'FILLED' : 'PARTIALLY_FILLED';
      items.push({
        event: this.buildOrderEvent(next, symbol, fillExecution, fillStatus, next.filledBase, next.filledQuote, delta),
        fillDelta: delta,
        quoteDelta: decSub(next.filledQuote, previous.filledQuote),
      });
    } else if (next.status === 'filled' && previous.status !== 'filled') {
      items.push({
        event: this.buildOrderEvent(next, symbol, fillExecution, 'FILLED', next.filledBase, next.filledQuote, '0'),
        fillDelta: null,
        quoteDelta: null,
      });
    }
    if (terminal && next.status !== 'filled') {
      items.push({
        event: this.buildOrderEvent(next, symbol, status, status, next.filledBase, next.filledQuote, '0'),
        fillDelta: null,
        quoteDelta: null,
      });
    }
    if (!terminal && !isPositive(delta) && orderAmended(previous, next)) {
      items.push({
        event: this.buildOrderEvent(next, symbol, 'AMENDMENT', status, next.filledBase, next.filledQuote, '0'),
        fillDelta: null,
        quoteDelta: null,
      });
    }
    return items;
  }

  private buildOrderEvent(
    order: LighterOrderSnapshot,
    symbol: string,
    execution: string,
    status: string,
    filledBase: string,
    filledQuote: string,
    lastQuantity: string
  ): OrderTradeUpdateEvent {
    const now = this.now();
    const type = mapLighterOrderType(order.type);
    const o: UserDataOrder = {
      s: symbol,
      c: this.clientOrderId(order),
      S: order.isAsk ? 'SELL' : 'BUY',
      o: type,
      f: mapLighterTimeInForce(order.timeInForce),
      q: order.initialBase,
      p: LIMIT_PRICED_TYPES.has(type) ? order.price : '0',
      ap: averagePrice(filledBase, filledQuote),
      sp: order.triggerPrice,
      x: execution,
      X: status,
      i: lighterOrderId(order),
      l: lastQuantity,
      z: filledBase,
      L: '0',
      N: LIGHTER_MARGIN_ASSET,
      n: '0',
      T: now,
      b: '0',
      a: '0',
      m: false,
      R: order.reduceOnly,
      wt: 'MARK_PRICE',
      ot: type,
      ps: 'BOTH',
      cp: false,
      rp: '0',
      lighterOrderId: order.orderId,
      lighterStatus: order.status,
      lighterType: order.type,
      lighterPrice: order.price,
      triggerStatus: order.triggerStatus,
    };
    return { e: 'ORDER_TRADE_UPDATE', E: now, T: now, o };
  }

  private clientOrderId(order: LighterOrderSnapshot): string {
    if (order.clientOrderIndex > 0) {
      try {
        const mapped = this.deps.resolveClientOrderId?.(order.clientOrderIndex, order);
        if (typeof mapped === 'string' && mapped !== '') return mapped;
      } catch (error) {
        logWarnWithTimestamp('Lighter user stream: resolveClientOrderId failed:', errorText(error));
      }
      return String(order.clientOrderIndex);
    }
    return order.orderId;
  }

  // ----- Fill events wait briefly for their trades (fees, realized PnL, trade id) -----

  private enqueue(order: LighterOrderSnapshot, items: PendingItem[], immediate: boolean): void {
    if (items.length === 0) return;
    const key = order.orderId;
    const queue = this.pendingOrders.get(key);
    if (queue) {
      queue.order = order;
      queue.items.push(...items);
      if (immediate) this.flushOrder(key);
      else this.tryFlush(key);
      return;
    }
    const delta = pendingDelta(items);
    if (immediate || this.fillJoinWaitMs <= 0 || !isPositive(delta) || this.fillsCover(order, delta)) {
      this.emitItems(order, items);
      return;
    }
    const timer = setTimeout(() => this.flushOrder(key), this.fillJoinWaitMs);
    this.pendingOrders.set(key, { order, items, timer });
  }

  private tryFlush(key: string): void {
    const queue = this.pendingOrders.get(key);
    if (queue && this.fillsCover(queue.order, pendingDelta(queue.items))) this.flushOrder(key);
  }

  private flushOrder(key: string): void {
    const queue = this.pendingOrders.get(key);
    if (!queue) return;
    this.pendingOrders.delete(key);
    if (queue.timer) clearTimeout(queue.timer);
    this.emitItems(queue.order, queue.items);
  }

  private emitItems(order: LighterOrderSnapshot, items: PendingItem[]): void {
    for (const item of items) {
      if (item.fillDelta !== null) this.enrich(item, order);
      this.emit(item.event);
    }
  }

  private enrich(item: PendingItem, order: LighterOrderSnapshot): void {
    const delta = item.fillDelta as string;
    const fills = this.takeFills(order, delta);
    const o = item.event.o;
    const filled = fills.reduce((sum, fill) => decAdd(sum, fill.size), '0');
    if (decCompare(filled, delta) < 0) {
      // Trades still missing: the late ones are absorbed (not attributed to a later event of this order)
      this.owed.set(order.orderId, decAdd(this.owed.get(order.orderId) ?? '0', decSub(delta, filled)));
    }
    if (fills.length === 0) {
      const quote = item.quoteDelta;
      o.L = quote !== null && isPositive(quote) ? formatPrice(Number(quote) / Number(delta)) : (o.ap ?? '0');
      return;
    }
    const last = fills[fills.length - 1];
    const fee = fills.reduce((sum, fill) => sum + (fill.usdAmount * fill.feeTick) / 1e6, 0);
    o.n = formatNumber(-fee, 6);
    o.rp = fills.reduce((sum, fill) => (fill.pnl !== null ? decAdd(sum, fill.pnl) : sum), '0');
    o.L = last.price;
    o.t = normalizeOrderId(last.tradeId);
    o.m = last.isMaker;
  }

  // ----- Trades -> fills -----

  private addTradeFills(raw: unknown): void {
    if (!isRecord(raw)) return;
    const tradeId = idText(raw.trade_id_str) ?? idText(raw.trade_id);
    const marketId = nonNegativeInteger(raw.market_id);
    const size = canonicalDecimal(raw.size);
    const price = canonicalDecimal(raw.price);
    const isMakerAsk = bool(raw.is_maker_ask);
    if (tradeId === null || marketId === null || size === null || price === null || isMakerAsk === null) return;
    const usd = Number(raw.usd_amount);
    const usdAmount = Number.isFinite(usd) ? usd : Number(size) * Number(price);
    const now = this.now();

    for (const side of ['ask', 'bid'] as const) {
      if (integer(raw[`${side}_account_id`]) !== this.accountIndex) continue;
      const key = `${tradeId}:${side}`;
      if (this.fillKeys.has(key)) continue;
      this.fillKeys.set(key, now);
      const isMaker = side === 'ask' ? isMakerAsk : !isMakerAsk;
      const fill: Fill = {
        key,
        tradeId,
        orderId: idText(raw[`${side}_id_str`]) ?? idText(raw[`${side}_id`]),
        clientOrderIndex: nonNegativeInteger(raw[`${side}_client_id_str`]) ?? nonNegativeInteger(raw[`${side}_client_id`]),
        marketId,
        size,
        price,
        usdAmount,
        feeTick: Number(isMaker ? raw.maker_fee : raw.taker_fee) || 0,
        isMaker,
        pnl: canonicalDecimal(raw[`${side}_account_pnl`]),
        consumed: false,
        receivedAt: now,
      };
      const bucket = fill.orderId !== null ? `id:${fill.orderId}` : fill.clientOrderIndex ? `coi:${fill.clientOrderIndex}` : null;
      if (bucket === null) continue;
      // Trades for a fill event that was already emitted without them are absorbed
      const owedKey = fill.orderId ?? this.orderIdForClientIndex(fill.clientOrderIndex, marketId);
      const owed = owedKey ? this.owed.get(owedKey) : undefined;
      if (owedKey && owed && isPositive(owed)) {
        fill.consumed = true;
        const left = decSub(owed, size);
        if (isPositive(left)) this.owed.set(owedKey, left);
        else this.owed.delete(owedKey);
      }
      this.fills.set(bucket, [...(this.fills.get(bucket) ?? []), fill]);
    }
    if (this.fillKeys.size > MAX_TRACKED_FILLS) this.pruneFills(true);
  }

  private orderIdForClientIndex(clientOrderIndex: number | null, marketId: number): string | null {
    if (!clientOrderIndex) return null;
    for (const tracked of this.orders.values()) {
      if (tracked.order.clientOrderIndex === clientOrderIndex && tracked.order.marketId === marketId) return tracked.order.orderId;
    }
    return null;
  }

  private fillsFor(order: LighterOrderSnapshot): Fill[] {
    const result = [...(this.fills.get(`id:${order.orderId}`) ?? [])];
    if (order.clientOrderIndex > 0) {
      for (const fill of this.fills.get(`coi:${order.clientOrderIndex}`) ?? []) {
        if (fill.marketId === order.marketId) result.push(fill);
      }
    }
    return result.filter(fill => !fill.consumed).sort((a, b) => compareIds(a.tradeId, b.tradeId));
  }

  private fillsCover(order: LighterOrderSnapshot, delta: string): boolean {
    const available = this.fillsFor(order).reduce((sum, fill) => decAdd(sum, fill.size), '0');
    return decCompare(available, delta) >= 0;
  }

  private takeFills(order: LighterOrderSnapshot, delta: string): Fill[] {
    const taken: Fill[] = [];
    let sum = '0';
    for (const fill of this.fillsFor(order)) {
      if (decCompare(sum, delta) >= 0) break;
      fill.consumed = true;
      taken.push(fill);
      sum = decAdd(sum, fill.size);
    }
    return taken;
  }

  private pruneFills(force = false): void {
    const cutoff = this.now() - FILL_RETENTION_MS;
    for (const [bucket, list] of this.fills) {
      const kept = list.filter(fill => fill.receivedAt >= cutoff && !(force && fill.consumed));
      if (kept.length === 0) this.fills.delete(bucket);
      else if (kept.length !== list.length) this.fills.set(bucket, kept);
    }
    for (const [key, at] of this.fillKeys) {
      if (at >= cutoff && this.fillKeys.size <= MAX_TRACKED_FILLS) break;
      this.fillKeys.delete(key);
    }
  }

  // ===== ACCOUNT_UPDATE (spec §4.4) =====

  // Bot symbol of a market, or null (unmapped, or a multiplier mapping that only serves the liquidation feed)
  private symbolFor(marketId: number, quiet = false): string | null {
    const mapped = this.markets.findByMarketId(marketId);
    if (quiet) return mapped && mapped.multiplier === 1 ? mapped.botSymbol : null;
    if (!mapped) {
      const market = this.markets.isLoaded() ? `market ${marketId}` : `market ${marketId} (market data not loaded)`;
      this.warnOnce(`unmapped-${marketId}`, `${market} is not mapped to a bot symbol; its orders and positions are not reported`);
      return null;
    }
    if (mapped.multiplier !== 1) {
      this.warnOnce(`multiplier-${marketId}`, `${mapped.botSymbol} maps to Lighter ${mapped.lighterSymbol} x${mapped.multiplier}; its orders and positions are not reported`);
      return null;
    }
    return mapped.botSymbol;
  }

  private markPrice(marketId: number): number | null {
    try {
      const mark = this.deps.getMarkPrice?.(marketId);
      return typeof mark === 'number' && Number.isFinite(mark) && mark > 0 ? mark : null;
    } catch {
      return null;
    }
  }

  private buildPosition(state: PositionState, symbol: string): UserDataPosition {
    const restMatches = state.rest !== null && state.rest.size === state.size;
    const mark = this.markPrice(state.marketId);
    let unrealized = '0';
    if (restMatches && state.rest?.unrealizedPnl != null) {
      unrealized = state.rest.unrealizedPnl;
    } else if (mark !== null) {
      unrealized = formatNumber((mark - Number(state.entryPrice)) * Number(state.size), 6);
    }
    const isolated = state.marginMode === 1;
    const position: UserDataPosition = {
      s: symbol,
      pa: state.size,
      ep: state.entryPrice,
      up: unrealized,
      mt: isolated ? 'isolated' : 'cross',
      iw: isolated ? state.allocatedMargin : '0',
      ps: 'BOTH',
    };
    if (mark !== null) position.mp = formatPrice(mark);
    const liquidation = restMatches ? state.rest?.liquidationPrice ?? null : null;
    if (liquidation !== null && isPositive(liquidation)) position.lp = liquidation;
    return position;
  }

  private currentPositions(): { list: UserDataPosition[]; open: Map<number, { symbol: string; mt: string }> } {
    const list: UserDataPosition[] = [];
    const open = new Map<number, { symbol: string; mt: string }>();
    const states = [...this.positions.values()].sort((a, b) => a.marketId - b.marketId);
    for (const state of states) {
      if (isZero(state.size)) continue;
      const symbol = this.symbolFor(state.marketId);
      if (!symbol) continue;
      const position = this.buildPosition(state, symbol);
      list.push(position);
      open.set(state.marketId, { symbol, mt: position.mt });
    }
    return { list, open };
  }

  private balance(): UserDataBalance | null {
    if (this.collateral === null) return null;
    let isolated = '0';
    for (const state of this.positions.values()) {
      if (state.marginMode === 1 && !isZero(state.size)) isolated = decAdd(isolated, state.allocatedMargin);
    }
    return {
      a: LIGHTER_MARGIN_ASSET,
      wb: this.collateral,
      cw: decSub(this.collateral, isolated),
      bc: this.lastWb === null ? '0' : decSub(this.collateral, this.lastWb),
    };
  }

  private signature(positions: UserDataPosition[], balance: UserDataBalance | null): string {
    return JSON.stringify([
      positions.map(p => [p.s, p.pa, p.ep, p.mt, p.iw]),
      balance ? [balance.wb, balance.cw] : null,
    ]);
  }

  // The seeded state counts as already known to the bot (it synced through REST itself)
  private markBaseline(): void {
    const { list, open } = this.currentPositions();
    const balance = this.balance();
    this.lastEmitted = open;
    this.lastSignature = this.signature(list, balance);
    this.lastWb = this.collateral;
  }

  private emitAccountUpdate(): void {
    if (!this.positionsSeeded || this.closed) return;
    const { list, open } = this.currentPositions();
    const balance = this.balance();
    const signature = this.signature(list, balance);

    const positions = [...list];
    for (const [marketId, previous] of this.lastEmitted) {
      if (open.has(marketId)) continue;
      const state = this.positions.get(marketId);
      if (state && !isZero(state.size)) continue; // Still open but no longer mapped: not closed, just not reported
      positions.push({ s: previous.symbol, pa: '0', ep: '0', up: '0', mt: previous.mt, iw: '0', ps: 'BOTH' });
    }
    if (signature === this.lastSignature && positions.length === list.length) return;

    const balanceChanged = balance !== null && balance.bc !== '0';
    const reason = this.pendingFunding && balanceChanged ? 'FUNDING_FEE' : 'ORDER';
    if (reason === 'FUNDING_FEE') this.pendingFunding = false;
    const now = this.now();
    const event: AccountUpdateEvent = {
      e: 'ACCOUNT_UPDATE',
      E: now,
      T: now,
      a: { m: reason, B: balance ? [balance] : [], P: positions },
    };
    this.lastEmitted = open;
    this.lastSignature = signature;
    if (balance) this.lastWb = balance.wb;
    this.emit(event);
  }

  // ===== Helpers =====

  private emit(event: UserDataEvent): void {
    if (this.closed) return;
    try {
      this.handlers.onEvent(event);
    } catch (error) {
      logErrorWithTimestamp('Lighter user stream: event handler failed:', error);
    }
  }

  private alert(alert: LighterAccountStreamAlert): void {
    logErrorWithTimestamp(`Lighter user stream [${alert.kind}]: ${alert.message}`);
    try {
      this.deps.onAlert?.(alert);
    } catch (error) {
      logErrorWithTimestamp('Lighter user stream: onAlert failed:', errorText(error));
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    logWarnWithTimestamp(`Lighter user stream: ${message}`);
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      logErrorWithTimestamp('Lighter user stream: handler error:', error);
    }
  }
}

function sameOrderState(a: LighterOrderSnapshot, b: LighterOrderSnapshot): boolean {
  return a.status === b.status &&
    a.filledBase === b.filledBase &&
    (a.orderVersion === null || b.orderVersion === null || a.orderVersion === b.orderVersion) &&
    a.price === b.price &&
    a.triggerPrice === b.triggerPrice &&
    a.initialBase === b.initialBase;
}

function orderAmended(a: LighterOrderSnapshot, b: LighterOrderSnapshot): boolean {
  if (a.orderVersion !== null && b.orderVersion !== null && b.orderVersion > a.orderVersion) return true;
  return a.price !== b.price || a.triggerPrice !== b.triggerPrice || a.initialBase !== b.initialBase;
}

function averagePrice(filledBase: string, filledQuote: string): string {
  return isPositive(filledBase) && isPositive(filledQuote) ? formatPrice(Number(filledQuote) / Number(filledBase)) : '0';
}

function pendingDelta(items: PendingItem[]): string {
  return items.reduce((sum, item) => (item.fillDelta !== null ? decAdd(sum, item.fillDelta) : sum), '0');
}

function compareIds(a: string, b: string): number {
  return a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;
}

// Open the private account stream for one Lighter account and translate it into Binance-style user data events.
// Resolves once the stream is starting; close() stops it for good. The adapter's subscribeUserData returns this.
export async function createLighterUserStream(
  deps: LighterUserStreamDeps,
  handlers: UserDataHandlers
): Promise<UserDataSubscription> {
  const stream = new LighterUserStream(deps, handlers);
  try {
    await stream.open();
  } catch (error) {
    await stream.close();
    throw error;
  }
  return stream;
}
