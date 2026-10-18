import type { Kline, MarkPrice, Order } from '../types';

// Trading venues the bot knows about. Only venues marked 'available' in the catalog have an adapter.
export const VENUE_IDS = ['aster', 'hyperliquid', 'lighter', 'drift'] as const;
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

export interface ExchangeAdapter {
  readonly id: VenueId;
  readonly capabilities: VenueCapabilities;
  hasCredentials(): boolean;

  // WebSocket endpoints for public and user-data streams
  readonly streamBaseUrl: string;

  // Market data
  getExchangeInfo(): Promise<any>;
  getMarkPrice(symbol?: string): Promise<MarkPrice | MarkPrice[]>;
  getKlines(symbol: string, interval?: string, limit?: number): Promise<Kline[]>;
  getOrderBook(symbol: string, limit?: number): Promise<any>;
  getBookTicker(symbol: string): Promise<any>;

  // Account
  getAccountInfo(): Promise<any>;
  getBalance(): Promise<any>;
  getPositions(symbol?: string): Promise<VenuePosition[]>;
  getOpenOrders(symbol?: string): Promise<VenueOrder[]>;
  getHedgeMode(): Promise<boolean>;
  setHedgeMode(enabled: boolean): Promise<void>;
  setLeverage(symbol: string, leverage: number): Promise<any>;

  // Orders
  placeOrder(request: OrderRequest): Promise<Order>;
  cancelOrder(symbol: string, orderId: number): Promise<any>;
  cancelAllOrders(symbol: string): Promise<any>;
}
