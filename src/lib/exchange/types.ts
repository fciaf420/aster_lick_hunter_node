import type { Kline, MarkPrice, Order } from '../types';
import type { Trade } from '../types/order';
import type { AccountUpdate } from '../api/userDataStream';
import type { DailyPnL, IncomeHistoryParams, IncomeRecord, SymbolPnL } from '../api/income';

// Trading venues the bot knows about. Only venues marked 'available' in the catalog have an adapter.
export const VENUE_IDS = ['aster', 'hyperliquid', 'lighter', 'phoenix', 'bulk'] as const;
export type VenueId = typeof VENUE_IDS[number];

// Where liquidation signals come from (can differ from the trading venue)
export const LIQUIDATION_SOURCE_IDS = ['aster', 'hyperliquid', 'binance', 'lighter'] as const;
export type LiquidationSourceId = typeof LIQUIDATION_SOURCE_IDS[number];

export interface VenueCapabilities {
  hedgeMode: boolean;           // Separate LONG/SHORT positions per symbol
  setPositionMode: boolean;     // Position mode can be switched through the API
  reduceOnly: boolean;          // Supports reduce-only orders (in one-way mode)
  postOnly: boolean;            // Supports post-only (GTX) limit orders
  maxBatchOrders: number;       // Orders per batch request; 0 = place one by one
  stopMarket: boolean;          // Native STOP_MARKET (stop loss) orders
  takeProfitMarket: boolean;    // Native TAKE_PROFIT_MARKET orders
  triggerPrice: 'MARK' | 'LAST' | 'ORACLE'; // Price that SL/TP orders trigger on
  perSymbolLeverage: boolean;
  marginAsset: 'USDT' | 'USDC';
}

// Positions and orders keep the Binance-style field names the bot already reads;
// every adapter must produce these shapes
export interface VenuePosition {
  symbol: string;
  positionAmt: string;          // Signed: negative = short (one-way mode)
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  marginType: string;
  isolatedMargin: string;
  isAutoAddMargin: string;
  positionSide: string;         // 'BOTH' (one-way), 'LONG' or 'SHORT' (hedge)
  updateTime: number;
}

// Order ids are numbers whenever the venue id is an integer a JS number holds exactly (Aster order ids,
// Lighter client order indexes) and decimal strings otherwise (e.g. a Lighter order_index above 2^53).
// Adapters must follow this so ids from REST, placement results and the user data stream compare equal;
// use normalizeOrderId() (./orderId) for ids from untyped sources.
export type OrderId = number | string;

export interface VenueOrder {
  symbol: string;
  orderId: OrderId;
  clientOrderId: string;
  price: string;
  origQty: string;
  executedQty: string;
  status: string;
  type: string;
  side: string;
  stopPrice: string;
  time: number;
  updateTime: number;
  workingType: string;
  origType: string;
  positionSide: string;
  reduceOnly: boolean;
}

export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';

export interface OrderRequest {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: OrderType;
  quantity: number;
  price?: number;
  stopPrice?: number;
  reduceOnly?: boolean;
  positionSide?: 'BOTH' | 'LONG' | 'SHORT';
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'GTX';
}

export interface RequestOptions {
  // Send immediately instead of through the shared rate-limit queue. Used where the bot has
  // always bypassed the queue (position sync, SL/TP price checks, UI symbol lookups).
  bypassRateLimit?: boolean;
}

export interface TickerPrice {
  symbol: string;
  price: string;
}

export interface ProtectiveOrdersRequest {
  symbol: string;
  side: 'BUY' | 'SELL';         // BUY protects a short, SELL protects a long
  quantity: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  positionSide?: 'BOTH' | 'LONG' | 'SHORT';
  reduceOnly?: boolean;
}

// ===== User data stream (venue-neutral) =====
// Every adapter translates its private stream into this typed subset of the Binance futures user data
// events, which is what PositionManager, pnlService and the web UI read. Field names are Binance's.

export interface UserDataBalance {
  a: string;                    // Asset (the venue's capabilities.marginAsset for the margin balance)
  wb: string;                   // Wallet balance
  cw?: string;                  // Cross wallet balance
  bc?: string;                  // Balance change except PnL and commission
}

export interface UserDataPosition {
  s: string;                    // Symbol (bot symbol, e.g. BTCUSDT)
  pa: string;                   // Signed position amount; "0" when the position closed
  ep: string;                   // Entry price
  up: string;                   // Unrealized PnL
  mt: string;                   // Margin type: 'cross' | 'isolated'
  ps?: string;                  // Position side: 'BOTH' | 'LONG' | 'SHORT'
  mp?: string;                  // Mark price
  lp?: string;                  // Liquidation price
  cr?: string;                  // Accumulated realized PnL
  iw?: string;                  // Isolated wallet
  iam?: string;                 // Is auto add margin
  bep?: string;                 // Break-even price
}

// Balances and positions. The bot treats P as the full position set: a position missing from P is kept,
// and one listed with pa "0" is treated as closed.
export interface AccountUpdateEvent {
  e: 'ACCOUNT_UPDATE';
  E: number;                    // Event time (ms)
  T?: number;                   // Transaction time (ms)
  a: {
    m?: string;                 // Reason: ORDER, FUNDING_FEE, DEPOSIT, WITHDRAW, ...
    B?: UserDataBalance[];
    P?: UserDataPosition[];
  };
}

export interface UserDataOrder {
  s: string;                    // Symbol
  c?: string;                   // Client order id
  S: string;                    // Side: 'BUY' | 'SELL'
  o: string;                    // Order type: LIMIT, MARKET, STOP_MARKET, TAKE_PROFIT_MARKET, ...
  f?: string;                   // Time in force
  q: string;                    // Original quantity
  p?: string;                   // Price
  ap?: string;                  // Average fill price
  sp?: string;                  // Stop (trigger) price
  x?: string;                   // Execution type: NEW, TRADE, CANCELED, EXPIRED, ...
  X: string;                    // Order status: NEW, PARTIALLY_FILLED, FILLED, CANCELED, EXPIRED
  i: OrderId;                   // Order id (same id the adapter returns from placeOrder and getOpenOrders)
  l?: string;                   // Last filled quantity
  z?: string;                   // Accumulated filled quantity
  L?: string;                   // Last filled price
  N?: string;                   // Commission asset
  n?: string;                   // Commission (negative = paid)
  T?: number;                   // Trade time (ms)
  t?: number | string;          // Trade id
  R?: boolean;                  // Reduce only
  ps?: string;                  // Position side
  cp?: boolean;                 // Close position (close-all)
  rp?: string;                  // Realized profit of the fill
  ot?: string;                  // Original order type
  wt?: string;                  // Stop price working type
  m?: boolean;                  // Is maker
  [key: string]: unknown;       // Venue-specific extras (kept for the UI)
}

// Order lifecycle and fills
export interface OrderTradeUpdateEvent {
  e: 'ORDER_TRADE_UPDATE';
  E: number;
  T?: number;
  o: UserDataOrder;
}

// Leverage changes
export interface AccountConfigUpdateEvent {
  e: 'ACCOUNT_CONFIG_UPDATE';
  E: number;
  T?: number;
  ac?: { s: string; l: number };
}

export type UserDataEvent = AccountUpdateEvent | OrderTradeUpdateEvent | AccountConfigUpdateEvent;

export const USER_DATA_EVENT_TYPES: ReadonlyArray<UserDataEvent['e']> = ['ACCOUNT_UPDATE', 'ORDER_TRADE_UPDATE', 'ACCOUNT_CONFIG_UPDATE'];

export interface UserDataHandlers {
  onEvent(event: UserDataEvent): void;
  // The stream is live (also after each reconnect)
  onConnected?(): void;
  // The stream dropped; unless the subscription was closed, the adapter reconnects by itself
  onDisconnected?(error?: Error): void;
  // Connection error, reported before the matching onDisconnected
  onError?(error: Error): void;
  // Awaited before the adapter re-establishes a dropped stream (PositionManager re-syncs from REST here)
  beforeReconnect?(): Promise<void>;
  // Called once with the stream's starting state (a.m 'BASELINE'): the full position set and balance the stream
  // treats as already known. Not an event: it is never passed to onEvent.
  onBaseline?(snapshot: AccountUpdateEvent): void;
}

export interface UserDataSubscription {
  close(): Promise<void>;
}

// Balance/position stream used by the balance service (Binance-style ACCOUNT_UPDATE events)
export interface AccountStream {
  start(onAccountUpdate?: (data: AccountUpdate) => void): Promise<void>;
  stop(): Promise<void>;
  isHealthy(): boolean;
}

export type IncomeRange = '24h' | '7d' | '30d' | '90d' | '1y' | 'all';

// Trade, order and income history for the dashboard. Shapes are still Aster's;
// normalizing them across venues is left for when a second venue is added.
export interface AccountHistory {
  getIncomeHistory(params?: IncomeHistoryParams): Promise<IncomeRecord[]>;
  getTimeRangeIncome(range: IncomeRange): Promise<IncomeRecord[]>;
  aggregateDailyPnLWithTrades(records: IncomeRecord[], symbols: string[], startTime: number, endTime: number): Promise<DailyPnL[]>;
  aggregateBySymbolWithTrades(records: IncomeRecord[], symbols: string[], startTime: number, endTime: number): Promise<SymbolPnL[]>;
  getAllOrders(symbol: string, startTime?: number, endTime?: number, limit?: number): Promise<Order[]>;
  getUserTrades(symbol: string, params?: { startTime?: number; endTime?: number; fromId?: number; limit?: number }): Promise<Trade[]>;
}

// Margin of the account a new entry would use (decimal strings in the margin asset)
export interface EntryMargin {
  totalWalletBalance: string;
  availableBalance: string;
}

export interface ExchangeAdapter {
  readonly id: VenueId;
  readonly capabilities: VenueCapabilities;
  hasCredentials(): boolean;

  // Stream URLs (messages use Binance-style event formats)
  getMarkPriceStreamUrl(): string;
  getKlineStreamUrl(subscriptions: { symbol: string; interval: string }[]): string;

  // Market data
  getExchangeInfo(options?: RequestOptions): Promise<any>;
  getMarkPrice(symbol?: string): Promise<MarkPrice | MarkPrice[]>;
  getTickerPrice(symbol: string, options?: RequestOptions): Promise<TickerPrice>;
  getAllTickerPrices(options?: RequestOptions): Promise<TickerPrice[]>;
  getKlines(symbol: string, interval?: string, limit?: number): Promise<Kline[]>;
  getOrderBook(symbol: string, limit?: number): Promise<any>;
  getBookTicker(symbol: string): Promise<any>;

  // Account
  getAccountInfo(): Promise<any>;
  getBalance(): Promise<any>;
  getPositions(symbol?: string, options?: RequestOptions): Promise<VenuePosition[]>;
  getOpenOrders(symbol?: string, options?: RequestOptions): Promise<VenueOrder[]>;
  getHedgeMode(): Promise<boolean>;
  setHedgeMode(enabled: boolean): Promise<void>;
  // positionSide: the side of the entry the leverage is set for. Venues that keep each position side on its own
  // account (Lighter hedge mode) then set it on that account only; venues with one account ignore it.
  setLeverage(symbol: string, leverage: number, positionSide?: 'LONG' | 'SHORT'): Promise<any>;
  // Venues that keep each position side on its own account (Lighter hedge mode): the margin of the account an
  // entry on that side would use. Venues with one account leave it out; callers then read getAccountInfo().
  getEntryMargin?(positionSide: 'LONG' | 'SHORT'): Promise<EntryMargin>;
  readonly history: AccountHistory;

  // User data stream (order fills, position and balance updates). The adapter owns the connection:
  // it authenticates, keeps the stream alive and reconnects until the subscription is closed.
  subscribeUserData(handlers: UserDataHandlers): Promise<UserDataSubscription>;
  createAccountStream(): AccountStream;

  // Binance-style listenKey stream (Aster). Venues without listenKeys leave these out; the bot itself
  // only uses subscribeUserData.
  getUserDataStreamUrl?(listenKey: string): string;
  createUserDataStream?(): Promise<string>;   // returns the stream key for getUserDataStreamUrl
  keepAliveUserDataStream?(): Promise<void>;
  closeUserDataStream?(): Promise<void>;

  // Orders
  placeOrder(request: OrderRequest): Promise<Order>;
  // mayExist: the outcome is unknown and the orders may still appear on the exchange, so callers must not
  // place them again (the periodic order check re-evaluates from the exchange's open orders)
  placeProtectiveOrders(request: ProtectiveOrdersRequest): Promise<{ stopLoss?: Order; takeProfit?: Order; errors: string[]; mayExist?: boolean }>;
  cancelOrder(symbol: string, orderId: OrderId): Promise<any>;
  cancelAllOrders(symbol: string): Promise<any>;
}
