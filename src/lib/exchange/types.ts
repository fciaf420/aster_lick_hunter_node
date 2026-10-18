import type { Kline, MarkPrice, Order } from '../types';
import type { Trade } from '../types/order';
import type { AccountUpdate } from '../api/userDataStream';
import type { DailyPnL, IncomeHistoryParams, IncomeRecord, SymbolPnL } from '../api/income';

// Trading venues the bot knows about. Only venues marked 'available' in the catalog have an adapter.
export const VENUE_IDS = ['aster', 'hyperliquid', 'lighter', 'phoenix'] as const;
export type VenueId = typeof VENUE_IDS[number];

// Where liquidation signals come from (can differ from the trading venue)
export const LIQUIDATION_SOURCE_IDS = ['aster', 'hyperliquid', 'binance'] as const;
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

export interface VenueOrder {
  symbol: string;
  orderId: number;
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

export interface ExchangeAdapter {
  readonly id: VenueId;
  readonly capabilities: VenueCapabilities;
  hasCredentials(): boolean;

  // Stream URLs (messages use Binance-style event formats)
  getMarkPriceStreamUrl(): string;
  getKlineStreamUrl(subscriptions: { symbol: string; interval: string }[]): string;
  getUserDataStreamUrl(listenKey: string): string;

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
  setLeverage(symbol: string, leverage: number): Promise<any>;
  readonly history: AccountHistory;

  // User data stream (order fills, position and balance updates)
  createUserDataStream(): Promise<string>;   // returns the stream key for getUserDataStreamUrl
  keepAliveUserDataStream(): Promise<void>;
  closeUserDataStream(): Promise<void>;
  createAccountStream(): AccountStream;

  // Orders
  placeOrder(request: OrderRequest): Promise<Order>;
  placeProtectiveOrders(request: ProtectiveOrdersRequest): Promise<{ stopLoss?: Order; takeProfit?: Order; errors: string[] }>;
  cancelOrder(symbol: string, orderId: number): Promise<any>;
  cancelAllOrders(symbol: string): Promise<any>;
}
