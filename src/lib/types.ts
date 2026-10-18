import type { LiquidationSourceId, OrderId, VenueId } from './exchange/types';
import type { LighterProfileName } from './exchange/lighter/profiles';

export interface SymbolConfig {
  // Volume thresholds
  volumeThresholdUSDT?: number;       // Legacy field for backward compatibility
  longVolumeThresholdUSDT?: number;   // Min liquidation volume to trigger long trades (buy on sell liquidations)
  shortVolumeThresholdUSDT?: number;  // Min liquidation volume to trigger short trades (sell on buy liquidations)

  // Position sizing
  tradeSize: number;                  // Base quantity for trades (adjusted by leverage)
  longTradeSize?: number;              // Optional: Specific margin in USDT for long positions
  shortTradeSize?: number;             // Optional: Specific margin in USDT for short positions
  maxPositionMarginUSDT?: number;     // Max margin exposure for this symbol (position size × leverage × price)

  // Risk parameters
  leverage: number;            // Leverage (1-125)
  tpPercent: number;           // Take profit as percentage (e.g., 5 for 5%)
  slPercent: number;           // Stop loss as percentage (e.g., 2 for 2%)

  // Limit order specific settings
  priceOffsetBps?: number;     // Price offset in basis points from best bid/ask (default: 1)
  usePostOnly?: boolean;       // Use post-only orders to guarantee maker fees (default: false)
  maxSlippageBps?: number;     // Maximum acceptable slippage in basis points (default: 50)
  orderType?: 'LIMIT' | 'MARKET'; // Order type preference (default: 'LIMIT')
  forceMarketEntry?: boolean;  // Force market orders for opening positions (default: false)

  // VWAP protection settings
  vwapProtection?: boolean;    // Enable VWAP-based entry filtering (default: false)
  vwapTimeframe?: string;      // Timeframe for VWAP calculation: 1m, 5m, 15m, 30m, 1h (default: '1m')
  vwapLookback?: number;       // Number of candles to use for VWAP calculation (default: 100)

  // Threshold system settings (60-second rolling window)
  useThreshold?: boolean;       // Enable threshold-based triggering for this symbol (default: false)
  thresholdTimeWindow?: number; // Time window in ms for volume accumulation (default: 60000)
  thresholdCooldown?: number;   // Cooldown period in ms between triggers (default: 30000)
  hunterCooldownMs?: number;    // Minimum ms between threshold-triggered entries per side (default: global or 120000)
}

export interface ApiCredentials {
  apiKey: string;          // API Key from Aster Finance exchange
  secretKey: string;       // Secret Key from Aster Finance exchange
}

export interface ServerConfig {
  dashboardPassword?: string;  // Optional password to protect the dashboard
  dashboardPort?: number;       // Port for the web UI (default: 3000)
  websocketPort?: number;       // Port for the WebSocket server (default: 8080)
  useRemoteWebSocket?: boolean; // Enable remote WebSocket access (default: false)
  websocketHost?: string | null; // Optional WebSocket host override (null for auto-detect)
}

export interface RateLimitConfig {
  maxRequestWeight?: number;  // Max request weight per minute (default: 2400)
  maxOrderCount?: number;      // Max orders per minute (default: 1200)
  reservePercent?: number;     // Percentage to reserve for critical operations (default: 30)
  enableBatching?: boolean;    // Enable order batching (default: true)
  queueTimeout?: number;       // Timeout for queued requests in ms (default: 30000)
  enableDeduplication?: boolean; // Enable request deduplication (default: true)
  deduplicationWindowMs?: number; // Time window for request deduplication in ms (default: 1000)
  parallelProcessing?: boolean; // Enable parallel processing of requests (default: false)
  maxConcurrentRequests?: number; // Maximum number of concurrent requests (default: 3)
}

export interface GlobalConfig {
  riskPercent: number;     // Max risk per trade as % of account balance
  paperMode: boolean;      // If true, simulate trades without executing
  positionMode?: 'ONE_WAY' | 'HEDGE'; // Position mode preference (optional)
  maxOpenPositions?: number; // Max number of open positions (hedged pairs count as one)
  useThresholdSystem?: boolean; // Enable 60-second rolling volume threshold system (default: false)
  hunterCooldownMs?: number; // Minimum ms between threshold-triggered entries per symbol side (default: 120000)
  exchange?: VenueId;       // Trading venue (default: 'aster')
  liquidationSource?: LiquidationSourceId; // Where liquidation signals come from (default: 'aster')
  server?: ServerConfig;    // Optional server configuration
  rateLimit?: RateLimitConfig; // Rate limit configuration
}

// Lighter settings and credentials (config.venues.lighter; validated by lighterVenueConfigSchema)
export interface LighterVenueConfig {
  profile?: LighterProfileName;    // Network (default 'testnet'); Robinhood profiles are gated
  accountIndex?: number;
  apiKeyIndex?: number;            // 0..254
  apiKeyPrivateKey?: string;       // 40 bytes hex
  apiKeyPublicKey?: string;        // As registered on the exchange (checked at startup)
  liquidationsLive?: boolean;      // false (default) = shadow mode: Lighter liquidations are logged, not traded
  sltpSlippagePct?: number;        // SL/TP worst-price slippage after trigger, percent (default 1)
  sendTxPerMin?: number;           // Client-side sendTx limit (default 60)
  symbolOverrides?: Record<string, string | { market: string; multiplier?: number }>;
}

export type VenueSettings = Partial<Record<Exclude<VenueId, 'lighter'>, Record<string, string>>> & {
  lighter?: LighterVenueConfig;
};

export interface Config {
  api: ApiCredentials;     // Aster credentials
  venues?: VenueSettings;  // Settings and credentials for other trading venues
  symbols: Record<string, SymbolConfig>; // key: symbol like "BTCUSDT"
  global: GlobalConfig;
  version?: string; // Optional version field for config schema versioning
}

// API response types
export interface LiquidationEvent {
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: string;
  quantity: number;
  price: number;
  averagePrice: number;
  orderStatus: string;
  orderLastFilledQuantity: number;
  orderFilledAccumulatedQuantity: number;
  orderTradeTime: number;
  eventTime: number;

  // Keep for backward compatibility
  qty: number;
  time: number;
}

export interface Order {
  symbol: string;
  orderId: OrderId;   // number when exactly representable (Aster returns numbers), else a decimal string
  clientOrderId?: string;
  side: 'BUY' | 'SELL';
  type: string;
  quantity: number;
  price: number;
  status: string;
  updateTime: number;
}

export interface Position {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unrealizedProfit: number;
  liquidationPrice?: number;
  leverage: number;
}

// Other types as needed
export interface Kline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface MarkPrice {
  symbol: string;
  markPrice: string;
  indexPrice: string;
};
