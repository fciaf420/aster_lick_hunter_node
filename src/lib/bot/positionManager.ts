import WebSocket from 'ws';
import { EventEmitter } from 'events';
import axios, { AxiosResponse } from 'axios';
import { Config } from '../types';
import { getSignedParams, paramsToQuery } from '../api/auth';
import { getExchangeInfo } from '../api/market';
import { placeOrder, cancelOrder } from '../api/orders';
import { symbolPrecision } from '../utils/symbolPrecision';
import { getBalanceService } from '../services/balanceService';
import { errorLogger } from '../services/errorLogger';

interface PositionOrders {
  slOrderId?: number;
  slOrderIds?: number[];
  tpOrderId?: number;
  tpOrderIds?: number[];
}

// Exchange position from API
interface ExchangePosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  marginType: string;
  isolatedMargin: string;
  isAutoAddMargin: string;
  positionSide: string;
  updateTime: number;
}

// Exchange order from API
interface ExchangeOrder {
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

const BASE_URL = 'https://fapi.asterdex.com';

// Position tracking interface for Hunter
export interface PositionTracker {
  getMarginUsage(symbol: string): number;
  getTotalPositionCount(): number;
  getUniquePositionCount(isHedgeMode: boolean): number;
  getPositionsMap(): Map<string, ExchangePosition>;
}

export class PositionManager extends EventEmitter implements PositionTracker {
  private ws: WebSocket | null = null;
  private listenKey: string | null = null;
  private config: Config;
  private positionOrders: Map<string, PositionOrders> = new Map(); // symbol_side -> order IDs
  private currentPositions: Map<string, ExchangePosition> = new Map(); // Live position data from WebSocket
  private previousPositionSizes: Map<string, number> = new Map(); // Track position size changes
  private keepaliveInterval?: NodeJS.Timeout;
  private riskCheckInterval?: NodeJS.Timeout;
  private orderCheckInterval?: NodeJS.Timeout;
  private isRunning = false;
  private statusBroadcaster: any; // Will be injected
  private isHedgeMode: boolean;
  private orderPlacementLocks: Set<string> = new Set(); // Prevent concurrent order placement for same position
  private orderCancellationLocks: Set<string> = new Set(); // Prevent concurrent order cancellation for same symbol
  private symbolLeverage: Map<string, number> = new Map(); // Track leverage per symbol from ACCOUNT_CONFIG_UPDATE

  constructor(config: Config, isHedgeMode: boolean = false) {
    super();
    this.config = config;
    this.isHedgeMode = isHedgeMode;
  }

  // Set status broadcaster for position updates
  public setStatusBroadcaster(broadcaster: any): void {
    this.statusBroadcaster = broadcaster;
  }

  // Update configuration dynamically
  public updateConfig(newConfig: Config): void {
    const oldConfig = this.config;
    this.config = newConfig;

    // Log significant changes
    if (oldConfig.global.riskPercent !== newConfig.global.riskPercent) {
      console.log(`PositionManager: Risk percent changed from ${oldConfig.global.riskPercent}% to ${newConfig.global.riskPercent}%`);
    }

    if (oldConfig.global.maxOpenPositions !== newConfig.global.maxOpenPositions) {
      console.log(`PositionManager: Max open positions changed from ${oldConfig.global.maxOpenPositions} to ${newConfig.global.maxOpenPositions}`);
    }

    // Check for symbol parameter changes that affect existing positions
    for (const [_posKey, position] of this.currentPositions) {
      const symbol = position.symbol;

      if (oldConfig.symbols[symbol] && newConfig.symbols[symbol]) {
        const oldSym = oldConfig.symbols[symbol];
        const newSym = newConfig.symbols[symbol];

        // Log changes that would affect new SL/TP orders
        if (oldSym.tpPercent !== newSym.tpPercent) {
          console.log(`PositionManager: ${symbol} TP percent changed from ${oldSym.tpPercent}% to ${newSym.tpPercent}%`);
        }
        if (oldSym.slPercent !== newSym.slPercent) {
          console.log(`PositionManager: ${symbol} SL percent changed from ${oldSym.slPercent}% to ${newSym.slPercent}%`);
        }

        // Note: We don't modify existing SL/TP orders - changes only apply to new positions
        console.log(`PositionManager: Note: Existing SL/TP orders for ${symbol} remain unchanged`);
      }
    }

    // If paper mode changed and we have an active websocket, we may need to restart
    if (oldConfig.global.paperMode !== newConfig.global.paperMode) {
      console.log(`PositionManager: Paper mode changed to ${newConfig.global.paperMode}`);

      // If switching modes with active connection, restart the connection
      if (this.isRunning && newConfig.api.apiKey && newConfig.api.secretKey) {
        console.log('PositionManager: Restarting connection due to mode change...');
        this.restartConnection();
      }
    }
  }

  private async restartConnection(): Promise<void> {
    // Close existing connection
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // Clear intervals
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
    }
    if (this.riskCheckInterval) {
      clearInterval(this.riskCheckInterval);
    }
    if (this.orderCheckInterval) {
      clearInterval(this.orderCheckInterval);
    }

    // Wait a bit before reconnecting
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Reconnect
    try {
      await this.syncWithExchange();
      await this.startUserDataStream();
    } catch (error) {
      console.error('PositionManager: Failed to restart connection:', error);
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('PositionManager: Starting...');

    // Fetch exchange info to get symbol precision
    try {
      console.log('PositionManager: Fetching exchange info for symbol precision...');
      const exchangeInfo = await getExchangeInfo();
      symbolPrecision.parseExchangeInfo(exchangeInfo);
    } catch (error: any) {
      console.error('PositionManager: Failed to fetch exchange info:', error.message);
      // Continue anyway - will use raw values
    }

    // Skip user data stream in paper mode with no API keys
    if (this.config.global.paperMode && (!this.config.api.apiKey || !this.config.api.secretKey)) {
      console.log('PositionManager: Running in paper mode without API keys - simulating streams');
      return;
    }

    try {
      // First, sync with exchange to get current positions and orders
      await this.syncWithExchange();
      // Then start the user data stream for real-time updates
      await this.startUserDataStream();
    } catch (error) {
      console.error('PositionManager: Failed to start:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    console.log('PositionManager: Stopping...');

    if (this.keepaliveInterval) clearInterval(this.keepaliveInterval);
    if (this.riskCheckInterval) clearInterval(this.riskCheckInterval);
    if (this.orderCheckInterval) clearInterval(this.orderCheckInterval);
    if (this.ws) this.ws.close();
    if (this.listenKey) await this.closeUserDataStream();
  }

  private async startUserDataStream(): Promise<void> {
    // For listen key endpoint, typically only needs API key header, no signature
    const headers = {
      'X-MBX-APIKEY': this.config.api.apiKey  // Binance-style header
    };

    const response: AxiosResponse = await axios.post(`${BASE_URL}/fapi/v1/listenKey`, null, { headers });
    this.listenKey = response.data.listenKey;
    console.log('PositionManager: Got listenKey:', this.listenKey);

    // Start WS
    this.ws = new WebSocket(`wss://fstream.asterdex.com/ws/${this.listenKey}`);

    this.ws.on('open', () => {
      console.log('PositionManager WS connected');
      // Set keepalive every 30 min
      this.keepaliveInterval = setInterval(() => this.keepalive(), 30 * 60 * 1000);
      // Risk check every 5 min
      this.riskCheckInterval = setInterval(() => this.checkRisk(), 5 * 60 * 1000);
      // Order check every 30 seconds to ensure SL/TP quantities match positions
      this.orderCheckInterval = setInterval(() => this.checkAndAdjustOrders(), 30 * 1000);

      // Clean up orphaned orders immediately on startup, then every 30 seconds
      this.cleanupOrphanedOrders().catch(error => {
        console.error('PositionManager: Initial cleanup failed:', error);
      });
      setInterval(() => this.cleanupOrphanedOrders(), 30 * 1000);
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const event = JSON.parse(data.toString());
        this.handleEvent(event);
      } catch (error) {
        console.error('PositionManager: WS message parse error:', error);
      }
    });

    this.ws.on('error', (error) => {
      console.error('PositionManager WS error:', error);
      // Log to error database
      errorLogger.logWebSocketError(
        `wss://fstream.asterdex.com/ws/${this.listenKey}`,
        error instanceof Error ? error : new Error(String(error)),
        1
      );
      // Broadcast error to UI
      if (this.statusBroadcaster) {
        this.statusBroadcaster.broadcastWebSocketError(
          'Position Manager WebSocket Error',
          'User data stream connection error. Reconnecting...',
          {
            component: 'PositionManager',
            rawError: error,
          }
        );
      }
    });

    this.ws.on('close', () => {
      console.log('PositionManager WS closed - reconnecting...');
      // Broadcast reconnection attempt to UI
      if (this.statusBroadcaster) {
        this.statusBroadcaster.broadcastWebSocketError(
          'Position Manager Disconnected',
          'User data stream closed. Reconnecting in 5 seconds...',
          {
            component: 'PositionManager',
          }
        );
      }
      if (this.isRunning) {
        // Re-sync with exchange on reconnect
        setTimeout(async () => {
          await this.syncWithExchange();
          await this.startUserDataStream();
        }, 5000);
      }
    });
  }

  private async keepalive(): Promise<void> {
    if (!this.listenKey) return;
    try {
      const headers = {
        'X-MBX-APIKEY': this.config.api.apiKey
      };
      await axios.put(`${BASE_URL}/fapi/v1/listenKey`, null, { headers });
      console.log('PositionManager: Keepalive sent');
    } catch (error) {
      console.error('PositionManager: Keepalive error:', error);
      // Log to error database
      errorLogger.logApiError(
        '/fapi/v1/listenKey',
        'PUT',
        error instanceof Error ? 0 : (error as any)?.response?.status || 0,
        error,
        { component: 'PositionManager', userAction: 'Keepalive' }
      );
    }
  }

  private async closeUserDataStream(): Promise<void> {
    if (!this.listenKey) return;
    try {
      const headers = {
        'X-MBX-APIKEY': this.config.api.apiKey
      };
      await axios.delete(`${BASE_URL}/fapi/v1/listenKey`, { headers });
      console.log('PositionManager: User data stream closed');
    } catch (error) {
      console.error('PositionManager: Close stream error:', error);
    }
  }

  // Sync with exchange on startup or reconnection
  private async syncWithExchange(): Promise<void> {
    console.log('PositionManager: Syncing with exchange...');

    try {
      // Get all current positions from exchange
      const positions = await this.getPositionsFromExchange();

      // Get all open orders
      const openOrders = await this.getOpenOrdersFromExchange();
      console.log(`PositionManager: Found ${openOrders.length} open orders`);

      // Log order details for debugging
      openOrders.forEach(order => {
        if (order.reduceOnly) {
          console.log(`PositionManager: Open order - ${order.symbol} ${order.type} ${order.side}, reduceOnly: ${order.reduceOnly}, orderId: ${order.orderId}`);
        }
      });

      // Clear and rebuild our position map
      this.currentPositions.clear();
      // Don't clear positionOrders completely to avoid canceling valid SL/TP orders
      // Instead, clean up only orders for positions that no longer exist

      // Process each position
      console.log(`PositionManager: Processing ${positions.length} positions from exchange...`);
      for (const position of positions) {
        const posAmt = parseFloat(position.positionAmt);
        console.log(`PositionManager: Examining position ${position.symbol}: amount=${posAmt}, positionSide=${position.positionSide}`);

        if (Math.abs(posAmt) > 0) {
          const key = this.getPositionKey(position.symbol, position.positionSide, posAmt);
          console.log(`PositionManager: Generated key for ${position.symbol}: ${key}`);
          this.currentPositions.set(key, position);

          // Only manage positions for symbols in our config
          const symbolConfig = this.config.symbols[position.symbol];
          if (!symbolConfig) {
            console.log(`PositionManager: Found position ${key}: ${posAmt} @ ${position.entryPrice} (not managed - symbol not in config)`);
            continue;
          }

          console.log(`PositionManager: Found position ${key}: ${posAmt} @ ${position.entryPrice}`);

          // Gather reduce-only SL/TP orders for this position
          const slOrders = openOrders.filter(o =>
            o.symbol === position.symbol &&
            (o.type === 'STOP_MARKET' || o.type === 'STOP') &&
            o.reduceOnly &&
            ((posAmt > 0 && o.side === 'SELL') || (posAmt < 0 && o.side === 'BUY'))
          );

          const tpOrders = openOrders.filter(o =>
            o.symbol === position.symbol &&
            (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT' || o.type === 'LIMIT') &&
            o.reduceOnly &&
            ((posAmt > 0 && o.side === 'SELL') || (posAmt < 0 && o.side === 'BUY'))
          );

          const orders: PositionOrders = {};
          let needsAdjustment = false;
          const tolerance = 0.00000001;
          const positionQty = Math.abs(posAmt);

          if (slOrders.length > 0) {
            const slIds = slOrders.map(order => order.orderId);
            orders.slOrderIds = slIds;
            orders.slOrderId = slIds[0];
            const slTotalQty = slOrders.reduce((sum, order) => sum + Math.abs(parseFloat(order.origQty)), 0);

            if (Math.abs(slTotalQty - positionQty) > tolerance) {
              console.log(`PositionManager: SL orders ${slIds.join(', ')} total quantity ${slTotalQty} mismatches position ${positionQty}`);
              needsAdjustment = true;
            } else {
              console.log(`PositionManager: Found SL orders ${slIds.join(', ')} for ${key} (total qty: ${slTotalQty})`);
            }
          }

          if (tpOrders.length > 0) {
            const tpIds = tpOrders.map(order => order.orderId);
            orders.tpOrderIds = tpIds;
            orders.tpOrderId = tpIds[0];
            const tpTotalQty = tpOrders.reduce((sum, order) => sum + Math.abs(parseFloat(order.origQty)), 0);

            if (Math.abs(tpTotalQty - positionQty) > tolerance) {
              console.log(`PositionManager: TP orders ${tpIds.join(', ')} total quantity ${tpTotalQty} mismatches position ${positionQty}`);
              needsAdjustment = true;
            } else {
              console.log(`PositionManager: Found TP orders ${tpIds.join(', ')} for ${key} (total qty: ${tpTotalQty})`);
            }
          }

          if ((orders.slOrderIds && orders.slOrderIds.length) || (orders.tpOrderIds && orders.tpOrderIds.length)) {
            this.positionOrders.set(key, orders);
          }

          // Adjust orders if quantities don't match or place missing orders
          if (needsAdjustment) {
            console.log(`PositionManager: Adjusting protective orders for ${key} due to quantity mismatch`);
            await this.adjustProtectiveOrders(position, slOrders, tpOrders);
          } else if (slOrders.length === 0 || tpOrders.length === 0) {
            console.log(`PositionManager: Position ${key} missing protection (SL: ${slOrders.length > 0}, TP: ${tpOrders.length > 0})`);
            await this.placeProtectiveOrdersWithLock(key, position, slOrders.length === 0, tpOrders.length === 0);
          }
        }
      }

      // Clean up positionOrders for positions that no longer exist
      const currentPositionKeys = new Set(this.currentPositions.keys());
      const ordersToRemove: string[] = [];

      for (const [orderKey] of this.positionOrders.entries()) {
        if (!currentPositionKeys.has(orderKey)) {
          console.log(`PositionManager: Removing orders tracking for closed position: ${orderKey}`);
          ordersToRemove.push(orderKey);
        }
      }

      // Remove orders for positions that no longer exist
      ordersToRemove.forEach(key => this.positionOrders.delete(key));

      console.log(`PositionManager: Sync complete - ${this.currentPositions.size} positions, ${this.positionOrders.size} with orders`);
    } catch (error) {
      console.error('PositionManager: Failed to sync with exchange:', error);
      throw error;
    }
  }

  // Get all positions from exchange
  private async getPositionsFromExchange(): Promise<ExchangePosition[]> {
    const params = {
      timestamp: Date.now(),
      recvWindow: 5000
    };

    const signedParams = getSignedParams(params, this.config.api);
    const queryString = paramsToQuery(signedParams);

    const response = await axios.get(`${BASE_URL}/fapi/v2/positionRisk?${queryString}`, {
      headers: { 'X-MBX-APIKEY': this.config.api.apiKey }
    });

    return response.data;
  }

  // Get all open orders from exchange
  private async getOpenOrdersFromExchange(): Promise<ExchangeOrder[]> {
    const params = {
      timestamp: Date.now(),
      recvWindow: 5000
    };

    const signedParams = getSignedParams(params, this.config.api);
    const queryString = paramsToQuery(signedParams);

    const response = await axios.get(`${BASE_URL}/fapi/v1/openOrders?${queryString}`, {
      headers: { 'X-MBX-APIKEY': this.config.api.apiKey }
    });

    return response.data;
  }

  // Helper to create consistent position keys
  private getPositionKey(symbol: string, positionSide: string, positionAmt: number): string {
    // For one-way mode (BOTH), include direction in key
    if (positionSide === 'BOTH') {
      const direction = positionAmt > 0 ? 'LONG' : 'SHORT';
      // Add a unique identifier to prevent any potential collisions
      return `${symbol}_${direction}_${positionSide}`;
    }
    // For hedge mode, use position side with additional identifier
    return `${symbol}_${positionSide}_HEDGE`;
  }

  // Ensure position has SL/TP orders
  private async ensurePositionProtected(symbol: string, positionSide: string, positionAmt: number): Promise<void> {
    const key = this.getPositionKey(symbol, positionSide, positionAmt);

    // Check if order placement is already in progress for this position
    if (this.orderPlacementLocks.has(key)) {
      console.log(`PositionManager: Order placement already in progress for ${key}, skipping`);
      return;
    }

    // Check if we already have orders tracked
    const existingOrders = this.positionOrders.get(key);
    const hasTrackedSL = (existingOrders?.slOrderIds && existingOrders.slOrderIds.length > 0) || !!existingOrders?.slOrderId;
    const hasTrackedTP = (existingOrders?.tpOrderIds && existingOrders.tpOrderIds.length > 0) || !!existingOrders?.tpOrderId;
    if (hasTrackedSL && hasTrackedTP) {
      return; // Already protected
    }

    // Get the position data
    const position = this.currentPositions.get(key);
    if (!position) {
      console.warn(`PositionManager: Position ${key} not found in map`);
      return;
    }

    // Place missing orders
    const needSL = !hasTrackedSL;
    const needTP = !hasTrackedTP;

    if (needSL || needTP) {
      await this.placeProtectiveOrdersWithLock(key, position, needSL, needTP);
    }
  }

  // Cancel protective orders for a position with retry logic
  private async cancelProtectiveOrders(positionKey: string, orders: PositionOrders): Promise<void> {
    const [symbol] = positionKey.split('_');

    // Add lock to prevent concurrent cancellations for the same symbol
    const lockKey = `cancel_${symbol}`;
    if (this.orderCancellationLocks.has(lockKey)) {
      console.log(`PositionManager: Order cancellation already in progress for ${symbol}, skipping`);
      return;
    }

    this.orderCancellationLocks.add(lockKey);

    try {
      const slOrderIds = orders.slOrderIds && orders.slOrderIds.length > 0
            ? orders.slOrderIds
            : (orders.slOrderId ? [orders.slOrderId] : []);
      const tpOrderIds = orders.tpOrderIds && orders.tpOrderIds.length > 0
            ? orders.tpOrderIds
            : (orders.tpOrderId ? [orders.tpOrderId] : []);

      const slLog = slOrderIds.length ? slOrderIds.join(', ') : 'none';
      const tpLog = tpOrderIds.length ? tpOrderIds.join(', ') : 'none';
      console.log(`PositionManager: Cancelling protective orders for position ${positionKey} - SL: ${slLog}, TP: ${tpLog}`);

      for (const slId of slOrderIds) {
        console.log(`PositionManager: Cancelling SL order ${slId} for symbol ${symbol}`);
        await this.cancelOrderWithRetry(symbol, slId, 'SL');
      }

      for (const tpId of tpOrderIds) {
        console.log(`PositionManager: Cancelling TP order ${tpId} for symbol ${symbol}`);
        await this.cancelOrderWithRetry(symbol, tpId, 'TP');
      }
    } finally {
      // Always release the lock
      this.orderCancellationLocks.delete(lockKey);
    }
  }

  // Cancel order with retry and backoff
  private async cancelOrderWithRetry(symbol: string, orderId: number, orderType: string): Promise<void> {
    const maxRetries = 3;
    const baseDelay = 1000; // 1 second

    // Validate symbol matches what we expect
    console.log(`PositionManager: Attempting to cancel ${orderType} order ${orderId} for symbol ${symbol}`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Extra validation: query the order first to ensure it belongs to the correct symbol
        // This is a safety check to prevent cross-symbol cancellation
        await this.cancelOrderById(symbol, orderId);
        console.log(`PositionManager: Successfully cancelled ${orderType} order ${orderId} for ${symbol} (attempt ${attempt})`);
        return; // Success, exit retry loop
      } catch (error: any) {
        // Error -2011 means order doesn't exist (already filled or cancelled)
        if (error?.response?.data?.code === -2011) {
          console.log(`PositionManager: ${orderType} order ${orderId} already filled or cancelled`);
          return; // Not an error to retry
        }

        console.error(`PositionManager: Failed to cancel ${orderType} order ${orderId} (attempt ${attempt}/${maxRetries}):`, error?.response?.data?.message || error?.message);

        if (attempt < maxRetries) {
          // Exponential backoff: 1s, 2s, 4s
          const delay = baseDelay * Math.pow(2, attempt - 1);
          console.log(`PositionManager: Retrying ${orderType} order cancellation in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          console.error(`PositionManager: Max retries reached for cancelling ${orderType} order ${orderId}`);
        }
      }
    }
  }

  // Cancel order by ID
  private async cancelOrderById(symbol: string, orderId: number): Promise<void> {
    await cancelOrder({ symbol, orderId }, this.config.api);
  }

  private handleEvent(event: any): void {
    if (event.e === 'ACCOUNT_UPDATE') {
      this.handleAccountUpdate(event);
    } else if (event.e === 'ORDER_TRADE_UPDATE') {
      this.handleOrderUpdate(event);
    } else if (event.e === 'ACCOUNT_CONFIG_UPDATE') {
      this.handleAccountConfigUpdate(event);
    }
  }

  private handleAccountConfigUpdate(event: any): void {
    // Handle ACCOUNT_CONFIG_UPDATE events which contain leverage information
    if (event.ac) {
      const { s: symbol, l: leverage } = event.ac;
      if (symbol && leverage !== undefined) {
        console.log(`PositionManager: Leverage update for ${symbol}: ${leverage}x`);
        this.symbolLeverage.set(symbol, leverage);

        // Update leverage for any existing positions of this symbol
        for (const [_key, position] of this.currentPositions.entries()) {
          if (position.symbol === symbol) {
            position.leverage = leverage.toString();
          }
        }
      }
    }
  }

  private handleAccountUpdate(event: any): void {
    console.log('PositionManager: Account update received');

    // Forward to PnL service for tracking
    const pnlService = require('../services/pnlService').default;
    pnlService.updateFromAccountEvent(event);

    // Broadcast PnL update if we have a broadcaster
    if (this.statusBroadcaster && this.statusBroadcaster.broadcastPnLUpdate) {
      const session = pnlService.getSessionPnL();
      const snapshot = pnlService.getLatestSnapshot();
      this.statusBroadcaster.broadcastPnLUpdate({
        session,
        snapshot,
        reason: event.a?.m,
      });
    }

    // Update our position map from the authoritative source (exchange)
    if (event.a && event.a.P) {
      const positions = event.a.P;

      // Track previous positions to detect closures
      const previousPositions = new Map(this.currentPositions);

      // Clear and rebuild position map - exchange data is the truth
      this.currentPositions.clear();

      positions.forEach(async (pos: any) => {
        const positionAmt = parseFloat(pos.pa);
        const symbol = pos.s;
        const positionSide = pos.ps || 'BOTH';

        // Check if position is closed (positionAmt = 0)
        if (Math.abs(positionAmt) === 0) {
          // Find the previous position key for this symbol/side
          let previousKey: string | undefined;
          let previousPosition: ExchangePosition | undefined;

          for (const [key, prevPos] of previousPositions.entries()) {
            if (prevPos.symbol === symbol && prevPos.positionSide === positionSide) {
              previousKey = key;
              previousPosition = prevPos;
              break;
            }
          }

          if (previousKey && previousPosition) {
            const previousAmt = parseFloat(previousPosition.positionAmt);
            console.log(`PositionManager: Position ${previousKey} fully closed`);

            // Broadcast position closed event
            if (this.statusBroadcaster) {
              this.statusBroadcaster.broadcastPositionClosed({
                symbol: symbol,
                side: previousAmt > 0 ? 'LONG' : 'SHORT',
                quantity: Math.abs(previousAmt),
                pnl: 0, // Will be updated by ORDER_TRADE_UPDATE
                reason: 'Position Closed',
              });

              // Also broadcast position_update with type closed for compatibility
              this.statusBroadcaster.broadcastPositionUpdate({
                symbol: symbol,
                side: previousAmt > 0 ? 'LONG' : 'SHORT',
                quantity: 0,
                price: 0,
                type: 'closed',
                pnl: 0,
              });
            }

            // Clean up tracking
            this.positionOrders.delete(previousKey);
            this.previousPositionSizes.delete(previousKey);

            // Trigger immediate balance refresh
            this.refreshBalance();
          }
          return; // Skip adding closed positions to map
        }

        // Store the full position data from exchange (only for open positions)
        if (Math.abs(positionAmt) > 0) {
          const key = this.getPositionKey(symbol, positionSide, positionAmt);

          // Check if position size has changed
          const previousSize = this.previousPositionSizes.get(key);
          const currentSize = Math.abs(positionAmt);
          // Use a more reasonable threshold to avoid unnecessary adjustments from tiny rounding differences
          // This prevents SL/TP order cancellation when closing other positions
          const sizeChanged = previousSize !== undefined && Math.abs(previousSize - currentSize) > 0.001;

          if (sizeChanged) {
            console.log(`PositionManager: Position size changed for ${key} from ${previousSize} to ${currentSize}`);
          }

          // Update tracking
          this.previousPositionSizes.set(key, currentSize);

          // Get leverage from our tracking or use '0' as placeholder
          const trackedLeverage = this.symbolLeverage.get(pos.s);
          const leverage = trackedLeverage ? trackedLeverage.toString() : '0';

          this.currentPositions.set(key, {
            symbol: pos.s,
            positionAmt: pos.pa,
            entryPrice: pos.ep,
            markPrice: pos.mp || '0',
            unRealizedProfit: pos.up,
            liquidationPrice: pos.lp || '0',
            leverage: leverage, // Use tracked leverage or '0' if not yet received
            marginType: pos.mt,
            isolatedMargin: pos.iw || '0',
            isAutoAddMargin: pos.iam || 'false',
            positionSide: positionSide,
            updateTime: event.E
          });

          // Check if this position has SL/TP orders and if they need adjustment
          if (sizeChanged) {
            // Position size changed significantly, check if orders need adjustment
            console.log(`PositionManager: Position ${key} size changed significantly from ${previousSize} to ${currentSize} - checking if order adjustment needed`);

            // Add symbol-specific lock to prevent interference
            const adjustLockKey = `adjust_${symbol}`;
            if (!this.orderPlacementLocks.has(adjustLockKey)) {
              this.checkAndAdjustOrdersForPosition(key).catch(error => {
                console.error(`PositionManager: Failed to adjust orders for ${key}:`, error?.response?.data || error?.message);
              });
            } else {
              console.log(`PositionManager: Order adjustment already in progress for ${symbol}, will retry on next check`);
            }
          } else {
            // Position size unchanged, no need to adjust existing orders
            console.log(`PositionManager: Position ${key} size unchanged (${currentSize}), skipping order adjustment`);

            // Only ensure protection if we don't have orders tracked yet (for new positions)
            const existingOrders = this.positionOrders.get(key);
            const hasTrackedSL = existingOrders?.slOrderIds && existingOrders.slOrderIds.length > 0 || !!existingOrders?.slOrderId;
            const hasTrackedTP = existingOrders?.tpOrderIds && existingOrders.tpOrderIds.length > 0 || !!existingOrders?.tpOrderId;
            if (!existingOrders || !hasTrackedSL || !hasTrackedTP) {
              // Add small delay to reduce race conditions with other protection logic
              setTimeout(() => {
                this.ensurePositionProtected(symbol, positionSide, positionAmt).catch(error => {
                  console.error(`PositionManager: Failed to ensure protection for ${symbol}:`, error?.response?.data || error?.message);
                });
              }, 200);
            }
          }

          // Broadcast to UI
          if (this.statusBroadcaster) {
            this.statusBroadcaster.broadcastPositionUpdate({
              symbol: pos.s,
              side: positionAmt > 0 ? 'LONG' : 'SHORT',
              quantity: Math.abs(positionAmt),
              price: parseFloat(pos.ep),
              type: 'updated',
              pnl: parseFloat(pos.up)
            });
          }

          // Trigger balance refresh if position size changed
          if (sizeChanged) {
            this.refreshBalance();
          }
        }
      });

      // Check for closed positions (positions that were in our map but aren't in the update)
      for (const [key, orders] of this.positionOrders.entries()) {
        if (!this.currentPositions.has(key)) {
          // Position was closed, clean up
          console.log(`PositionManager: Position ${key} was closed`);

          // Extract symbol from key for locking
          const [symbol] = key.split('_');
          const cancelLockKey = `cancel_${symbol}`;

          // Only cancel if not already in progress
          if (!this.orderCancellationLocks.has(cancelLockKey)) {
            console.log(`PositionManager: Cancelling protective orders for closed position ${key}`);
            // Cancel any remaining SL/TP orders if they exist (async, don't await to avoid blocking)
            this.cancelProtectiveOrders(key, orders).catch(error => {
              console.error(`PositionManager: Failed to cancel protective orders for ${key}:`, error?.response?.data || error?.message);
            });
          } else {
            console.log(`PositionManager: Order cancellation already in progress for ${symbol}, skipping`);
          }

          // Clean up tracking maps
          this.positionOrders.delete(key);
          this.previousPositionSizes.delete(key);

          // Trigger balance refresh after position closure
          this.refreshBalance();
        }
      }
    }
  }

  private handleOrderUpdate(event: any): void {
    // Forward to PnL service for commission tracking
    const pnlService = require('../services/pnlService').default;
    pnlService.updateFromOrderEvent(event);

    // Forward the ORDER_TRADE_UPDATE event to the web UI
    if (this.statusBroadcaster) {
      this.statusBroadcaster.broadcastOrderUpdate(event);
    }

    const order = event.o;
    const symbol = order.s;
    const orderType = order.o;
    const orderStatus = order.X;
    const _positionSide = order.ps || 'BOTH';
    const side = order.S;
    const orderId = order.i;

    // Enhanced logging for order lifecycle tracking
    console.log(`PositionManager: ORDER_TRADE_UPDATE - Symbol: ${symbol}, OrderId: ${orderId}, Type: ${orderType}, Status: ${orderStatus}, Side: ${side}`);

    // Check if this is a filled order that affects positions (SL/TP fills)
    if (orderStatus === 'FILLED' && order.rp) { // rp = realized profit (from exchange API)
      console.log(`PositionManager: Reduce-only order filled for ${symbol}`);
      // Trigger balance refresh after SL/TP execution
      this.refreshBalance();
    }

    // Track our SL/TP order IDs when they're placed
    if (orderStatus === 'NEW' && (orderType === 'STOP_MARKET' || orderType === 'TAKE_PROFIT_MARKET')) {
      const _executedQty = parseFloat(order.z || '0');
      const _origQty = parseFloat(order.q);

      // Find the matching position
      for (const [key, position] of this.currentPositions.entries()) {
        if (position.symbol === symbol) {
          const posAmt = parseFloat(position.positionAmt);
          // Check if this order is for this position (same symbol and opposite side)
          if ((posAmt > 0 && side === 'SELL') || (posAmt < 0 && side === 'BUY')) {
            if (!this.positionOrders.has(key)) {
              this.positionOrders.set(key, {});
            }
            const orders = this.positionOrders.get(key)!;

            if (orderType === 'STOP_MARKET') {
              orders.slOrderIds = orders.slOrderIds || [];
              if (!orders.slOrderIds.includes(orderId)) {
                orders.slOrderIds.push(orderId);
              }
              orders.slOrderId = orders.slOrderIds[0];
              console.log(`PositionManager: Tracked NEW SL order ${orderId} for position ${key} (${symbol})`);
            } else if (orderType === 'TAKE_PROFIT_MARKET') {
              orders.tpOrderIds = orders.tpOrderIds || [];
              if (!orders.tpOrderIds.includes(orderId)) {
                orders.tpOrderIds.push(orderId);
              }
              orders.tpOrderId = orders.tpOrderIds[0];
              console.log(`PositionManager: Tracked NEW TP order ${orderId} for position ${key} (${symbol})`);
            }
          }
        }
      }
    }

    // Handle filled orders
    if (orderStatus === 'FILLED') {
      const executedQty = parseFloat(order.z || '0');
      const avgPrice = parseFloat(order.ap || order.p || '0');

      if (!order.cp && !order.R) { // Not close-all and not reduce-only - this is an entry
        console.log(`PositionManager: Entry order filled for ${symbol}`);

        // Broadcast order filled event
        if (this.statusBroadcaster) {
          this.statusBroadcaster.broadcastOrderFilled({
            symbol,
            side,
            orderType,
            executedQty,
            price: avgPrice,
            orderId: orderId?.toString(),
          });
        }

        // Position will be updated via ACCOUNT_UPDATE event
        // Just wait for it and then place SL/TP
      } else if (orderType === 'STOP_MARKET' || orderType === 'STOP' ||
                 orderType === 'TAKE_PROFIT_MARKET' || orderType === 'TAKE_PROFIT' ||
                 (orderType === 'LIMIT' && order.R)) { // Any reduce-only order
        // SL/TP filled, position closed
        console.log(`PositionManager: ${orderType} (reduce-only) filled for ${symbol}`);

        // Clean up our tracking
        for (const [key, orders] of this.positionOrders.entries()) {
          const slIds = (orders.slOrderIds && orders.slOrderIds.length > 0)
            ? orders.slOrderIds
            : (orders.slOrderId ? [orders.slOrderId] : []);
          const tpIds = (orders.tpOrderIds && orders.tpOrderIds.length > 0)
            ? orders.tpOrderIds
            : (orders.tpOrderId ? [orders.tpOrderId] : []);
          const isSlOrder = slIds.includes(orderId);
          const isTpOrder = tpIds.includes(orderId);
          if (isSlOrder || isTpOrder) {
            const [posSymbol] = key.split('_');

            // Validate that the filled order is for the correct symbol
            if (posSymbol !== symbol) {
              console.error(`PositionManager: CRITICAL - Order ${orderId} filled for ${symbol} but tracked under position ${key} (${posSymbol})`);
              continue; // Don't process mismatched orders
            }

            console.log(`PositionManager: ${orderType} order ${orderId} filled for position ${key}, cancelling opposite order`);

            // Cancel the other order(s) if they exist (async, don't await to avoid blocking)
            if (isSlOrder && tpIds.length > 0) {
              for (const tpId of tpIds) {
                console.log(`PositionManager: Cancelling opposite TP order ${tpId} for ${symbol}`);
                this.cancelOrderById(symbol, tpId).catch(error => {
                  console.error(`PositionManager: Failed to cancel TP order ${tpId}:`, error?.response?.data || error?.message);
                });
              }
            } else if (isTpOrder && slIds.length > 0) {
              for (const slId of slIds) {
                console.log(`PositionManager: Cancelling opposite SL order ${slId} for ${symbol}`);
                this.cancelOrderById(symbol, slId).catch(error => {
                  console.error(`PositionManager: Failed to cancel SL order ${slId}:`, error?.response?.data || error?.message);
                });
              }
            }
            this.positionOrders.delete(key);
            break;
          }
        }


        let realizedPnl = parseFloat(order.rp || '0');

        // If exchange didn't provide PnL (returns 0), calculate it ourselves
        if (realizedPnl === 0 && (orderType === 'TAKE_PROFIT' || orderType === 'TAKE_PROFIT_MARKET' || orderType === 'STOP_MARKET' || orderType === 'STOP')) {
          console.log(`PositionManager: Exchange returned PnL=0 for ${orderType}, attempting to calculate from position data`);

          // Find the position key that matches this order
          let positionKey: string | undefined;
          for (const [key, orders] of this.positionOrders.entries()) {
          const slIds = (orders.slOrderIds && orders.slOrderIds.length > 0)
            ? orders.slOrderIds
            : (orders.slOrderId ? [orders.slOrderId] : []);
          const tpIds = (orders.tpOrderIds && orders.tpOrderIds.length > 0)
            ? orders.tpOrderIds
            : (orders.tpOrderId ? [orders.tpOrderId] : []);
            if (slIds.includes(orderId) || tpIds.includes(orderId)) {
              positionKey = key;
              break;
            }
          }

          if (positionKey) {
            const position = this.currentPositions.get(positionKey);
            if (position && position.entryPrice) {
              const entryPrice = parseFloat(position.entryPrice);
              const exitPrice = avgPrice;
              const quantity = executedQty;

              // Calculate PnL based on position direction
              // If closing with SELL order = was LONG position
              // If closing with BUY order = was SHORT position
              if (side === 'SELL') {
                // Closing LONG: profit = (exit - entry) * quantity
                realizedPnl = (exitPrice - entryPrice) * quantity;
              } else {
                // Closing SHORT: profit = (entry - exit) * quantity
                realizedPnl = (entryPrice - exitPrice) * quantity;
              }

              console.log(`PositionManager: Calculated PnL for ${symbol} ${orderType}: Entry=${entryPrice.toFixed(2)}, Exit=${exitPrice.toFixed(2)}, Qty=${quantity}, PnL=$${realizedPnl.toFixed(2)}`);
            } else {
              console.warn(`PositionManager: Could not find position entry price for ${positionKey} to calculate PnL`);
            }
          } else {
            console.warn(`PositionManager: Could not find position key for order ${orderId} to calculate PnL`);
          }
        } else if (realizedPnl !== 0) {
          console.log(`PositionManager: Using exchange-provided PnL for ${symbol} ${orderType}: $${realizedPnl.toFixed(2)}`);
        }

        // Broadcast order filled event (SL/TP)
        if (this.statusBroadcaster) {
          this.statusBroadcaster.broadcastOrderFilled({
            symbol,
            side,
            orderType,
            executedQty,
            price: avgPrice,
            orderId: orderId?.toString(),
            pnl: realizedPnl,
          });

          // Also broadcast position closed event
          this.statusBroadcaster.broadcastPositionClosed({
            symbol,
            side: side === 'BUY' ? 'SHORT' : 'LONG', // Opposite of closing order
            quantity: executedQty,
            pnl: realizedPnl,
            reason: orderType.includes('STOP') ? 'Stop Loss' : 'Take Profit',
          });

          // Keep the existing position update for backward compatibility
          this.statusBroadcaster.broadcastPositionUpdate({
            symbol: symbol,
            side: side === 'BUY' ? 'SHORT' : 'LONG',
            quantity: parseFloat(order.q),
            price: parseFloat(order.ap || '0'),
            type: 'closed',
            pnl: realizedPnl,
          });
        }
      }
    }
  }

  // Listen for new positions from Hunter
  public onNewPosition(data: { symbol: string; side: string; quantity: number; orderId?: number }): void {
    // In the new architecture, we wait for ACCOUNT_UPDATE to confirm the position
    // The WebSocket will tell us when the position is actually open
    console.log(`PositionManager: Notified of potential new position: ${data.symbol} ${data.side}`);

    // For paper mode, simulate the position
    if (this.config.global.paperMode) {
      // Use the proper position side based on hedge mode
      const positionSide = this.isHedgeMode ?
        (data.side === 'BUY' ? 'LONG' : 'SHORT') : 'BOTH';
      const key = `${data.symbol}_${positionSide}`;

      // Simulate the position in our map
      this.currentPositions.set(key, {
        symbol: data.symbol,
        positionAmt: data.side === 'BUY' ? data.quantity.toString() : (-data.quantity).toString(),
        entryPrice: '0', // Will be updated by market price
        markPrice: '0',
        unRealizedProfit: '0',
        liquidationPrice: '0',
        leverage: this.config.symbols[data.symbol]?.leverage?.toString() || '10',
        marginType: 'isolated',
        isolatedMargin: '0',
        isAutoAddMargin: 'false',
        positionSide: positionSide,
        updateTime: Date.now()
      });

      // Place SL/TP for paper mode
      this.ensurePositionProtected(data.symbol, positionSide, data.side === 'BUY' ? data.quantity : -data.quantity);
    }
  }

  // Adjust protective orders when quantities don't match position size
  private async adjustProtectiveOrders(position: ExchangePosition, currentSlOrders: ExchangeOrder[] = [], currentTpOrders: ExchangeOrder[] = []): Promise<void> {
    const symbol = position.symbol;
    const posAmt = parseFloat(position.positionAmt);
    const key = this.getPositionKey(symbol, position.positionSide, posAmt);

    if (this.orderPlacementLocks.has(key)) {
      console.log(`PositionManager: Order adjustment already in progress for ${key}, skipping`);
      return;
    }

    this.orderPlacementLocks.add(key);

    try {
      console.log(`PositionManager: Adjusting protective orders for ${symbol} - Position size: ${Math.abs(posAmt)}`);

      const orders = this.positionOrders.get(key) || {};
      const cancelPromises: Promise<void>[] = [];
      const tolerance = 0.00000001;
      const positionQty = Math.abs(posAmt);

      const slOrders = currentSlOrders || [];
      const tpOrders = currentTpOrders || [];
      const sumQuantities = (list: ExchangeOrder[]) => list.reduce((sum, order) => sum + Math.abs(parseFloat(order.origQty)), 0);

      let needNewSL = slOrders.length === 0;
      let needNewTP = tpOrders.length === 0;

      if (!needNewSL) {
        const slTotalQty = sumQuantities(slOrders);
        if (Math.abs(slTotalQty - positionQty) > tolerance) {
          console.log(`PositionManager: SL orders ${slOrders.map(o => o.orderId).join(', ')} total quantity ${slTotalQty} mismatches position ${positionQty}`);
          for (const slOrder of slOrders) {
            console.log(`PositionManager: Cancelling SL order ${slOrder.orderId}`);
            cancelPromises.push(this.cancelOrderWithRetry(symbol, slOrder.orderId, 'SL'));
          }
          needNewSL = true;
          delete orders.slOrderIds;
          delete orders.slOrderId;
        } else {
          orders.slOrderIds = slOrders.map(order => order.orderId);
          orders.slOrderId = orders.slOrderIds[0];
          console.log(`PositionManager: Existing SL orders cover ${slTotalQty} for ${symbol}`);
        }
      } else {
        delete orders.slOrderIds;
        delete orders.slOrderId;
      }

      if (!needNewTP) {
        const tpTotalQty = sumQuantities(tpOrders);
        if (Math.abs(tpTotalQty - positionQty) > tolerance) {
          console.log(`PositionManager: TP orders ${tpOrders.map(o => o.orderId).join(', ')} total quantity ${tpTotalQty} mismatches position ${positionQty}`);
          for (const tpOrder of tpOrders) {
            console.log(`PositionManager: Cancelling TP order ${tpOrder.orderId}`);
            cancelPromises.push(this.cancelOrderWithRetry(symbol, tpOrder.orderId, 'TP'));
          }
          needNewTP = true;
          delete orders.tpOrderIds;
          delete orders.tpOrderId;
        } else {
          orders.tpOrderIds = tpOrders.map(order => order.orderId);
          orders.tpOrderId = orders.tpOrderIds[0];
          console.log(`PositionManager: Existing TP orders cover ${tpTotalQty} for ${symbol}`);
        }
      } else {
        delete orders.tpOrderIds;
        delete orders.tpOrderId;
      }

      if (cancelPromises.length > 0) {
        try {
          await Promise.all(cancelPromises);
          console.log(`PositionManager: Cancelled ${cancelPromises.length} order(s) for adjustment`);
        } catch (error: any) {
          console.error('PositionManager: Error cancelling orders for adjustment:', error?.response?.data || error?.message);
        }
      }

      this.positionOrders.set(key, orders);

      if (needNewSL || needNewTP) {
        await this.placeProtectiveOrders(position, needNewSL, needNewTP);
      }
    } finally {
      this.orderPlacementLocks.delete(key);
    }
  }


  // Place protective orders with lock to prevent duplicates
  private async placeProtectiveOrdersWithLock(key: string, position: ExchangePosition, placeSL: boolean, placeTP: boolean): Promise<void> {
    // Set lock to prevent concurrent order placement
    this.orderPlacementLocks.add(key);

    try {
      await this.placeProtectiveOrders(position, placeSL, placeTP);
    } finally {
      // Always release the lock
      this.orderPlacementLocks.delete(key);
    }
  }

  // Place protective orders (SL/TP) for a position
  private async placeProtectiveOrders(position: ExchangePosition, placeSL: boolean, placeTP: boolean): Promise<void> {
    const symbol = position.symbol;
    const symbolConfig = this.config.symbols[symbol];
    if (!symbolConfig) {
      console.warn(`PositionManager: No config for symbol ${symbol}`);
      return;
    }

    const posAmt = parseFloat(position.positionAmt);
    const entryPrice = parseFloat(position.entryPrice);
    const quantity = Math.abs(posAmt);
    const isLong = posAmt > 0;
    const key = this.getPositionKey(symbol, position.positionSide, posAmt);

    // Get or create order tracking
    if (!this.positionOrders.has(key)) {
      this.positionOrders.set(key, {});
    }
    const orders = this.positionOrders.get(key)!;

    // Double-check existing orders before placing new ones
    try {
      const openOrders = await this.getOpenOrdersFromExchange();

      // Find ALL existing SL orders for this position
      const existingSlOrders = openOrders.filter(o =>
        o.symbol === symbol &&
        (o.type === 'STOP_MARKET' || o.type === 'STOP') &&
        o.reduceOnly &&
        ((posAmt > 0 && o.side === 'SELL') || (posAmt < 0 && o.side === 'BUY'))
      );

      // Find ALL existing TP orders for this position
      const existingTpOrders = openOrders.filter(o =>
        o.symbol === symbol &&
        (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT' || o.type === 'LIMIT') &&
        o.reduceOnly &&
        ((posAmt > 0 && o.side === 'SELL') || (posAmt < 0 && o.side === 'BUY'))
      );

      // Track existing protective orders so we do not place duplicates
      if (existingSlOrders.length > 0) {
        const slIds = existingSlOrders.map(order => order.orderId);
        orders.slOrderIds = slIds;
        orders.slOrderId = slIds[0];
        console.log(`PositionManager: Found existing SL orders for ${key}: ${slIds.join(", ")}`);
        placeSL = false;
      } else {
        delete orders.slOrderIds;
        delete orders.slOrderId;
      }

      if (existingTpOrders.length > 0) {
        const tpIds = existingTpOrders.map(order => order.orderId);
        orders.tpOrderIds = tpIds;
        orders.tpOrderId = tpIds[0];
        console.log(`PositionManager: Found existing TP orders for ${key}: ${tpIds.join(", ")}`);
        placeTP = false;
      } else {
        delete orders.tpOrderIds;
        delete orders.tpOrderId;
      }

      // Exit early if no orders need to be placed
      if (!placeSL && !placeTP) {
        console.log(`PositionManager: All protective orders already exist for ${key}`);
        return;
      }
    } catch (error: any) {
      console.error('PositionManager: Failed to check existing orders, proceeding with placement:', error?.response?.data || error?.message);
      // Log to error database
      errorLogger.logError(error instanceof Error ? error : new Error(String(error)), {
        type: 'api',
        severity: 'low',
        context: {
          component: 'PositionManager',
          symbol: position.symbol,
          userAction: 'Checking existing orders',
          metadata: error?.response?.data
        }
      });
    }

    try {
      const orderPositionSide = position.positionSide || 'BOTH';
      const side = isLong ? 'SELL' : 'BUY';
      let currentPriceCache: number | null = null;

      const getCurrentPrice = async (): Promise<number> => {
        if (currentPriceCache !== null) {
          return currentPriceCache;
        }
        const ticker = await axios.get(`https://fapi.asterdex.com/fapi/v1/ticker/price?symbol=${symbol}`);
        currentPriceCache = parseFloat(ticker.data.price);
        return currentPriceCache;
      };

      const placeReduceOnlyChunks = async (
        orderType: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET',
        stopPrice: number,
        clientPrefix: string
      ): Promise<number[]> => {
        const chunkQuantities = symbolPrecision.splitQuantity(symbol, quantity, orderType);
        const orderIds: number[] = [];
        const baseId = Date.now();

        for (let i = 0; i < chunkQuantities.length; i++) {
          const chunkQty = symbolPrecision.formatQuantity(symbol, chunkQuantities[i]);
          if (chunkQty <= 0) {
            console.warn(`PositionManager: Skipping ${orderType} chunk for ${symbol} with non-positive quantity ${chunkQty}`);
            continue;
          }

          const params: any = {
            symbol,
            side,
            type: orderType,
            quantity: chunkQty,
            stopPrice,
            positionSide: orderPositionSide as 'BOTH' | 'LONG' | 'SHORT',
            newClientOrderId: `${clientPrefix}_${symbol}_${baseId}_${i}`,
          };

          if (orderPositionSide === 'BOTH') {
            params.reduceOnly = true;
          }

          const orderResponse = await placeOrder(params, this.config.api);
          const orderId = typeof orderResponse.orderId === 'string'
            ? parseInt(orderResponse.orderId)
            : orderResponse.orderId;
          orderIds.push(orderId);

          console.log(`PositionManager: Placed ${orderType} chunk ${i + 1}/${chunkQuantities.length} for ${symbol} (qty ${chunkQty}, stop ${stopPrice}) orderId: ${orderResponse.orderId}`);
        }

        return orderIds;
      };

      const placeMarketChunks = async (): Promise<void> => {
        const chunkQuantities = symbolPrecision.splitQuantity(symbol, quantity, 'MARKET');
        const baseId = Date.now();

        for (let i = 0; i < chunkQuantities.length; i++) {
          const chunkQty = symbolPrecision.formatQuantity(symbol, chunkQuantities[i]);
          if (chunkQty <= 0) {
            console.warn(`PositionManager: Skipping market chunk for ${symbol} with non-positive quantity ${chunkQty}`);
            continue;
          }

          const params: any = {
            symbol,
            side,
            type: 'MARKET',
            quantity: chunkQty,
            positionSide: orderPositionSide as 'BOTH' | 'LONG' | 'SHORT',
            newClientOrderId: `al_market_tp_${symbol}_${baseId}_${i}`,
          };

          if (orderPositionSide === 'BOTH') {
            params.reduceOnly = true;
          }

          const marketOrder = await placeOrder(params, this.config.api);
          console.log(`PositionManager: Executed market chunk ${i + 1}/${chunkQuantities.length} for ${symbol}, orderId: ${marketOrder.orderId}`);
        }
      };

      if (placeSL) {
        const rawSlPrice = isLong
          ? entryPrice * (1 - symbolConfig.slPercent / 100)
          : entryPrice * (1 + symbolConfig.slPercent / 100);

        let adjustedSlPrice = rawSlPrice;
        const currentPrice = await getCurrentPrice();
        if ((isLong && rawSlPrice >= currentPrice) || (!isLong && rawSlPrice <= currentPrice)) {
          const bufferPercent = 0.1;
          adjustedSlPrice = isLong
            ? currentPrice * (1 - bufferPercent / 100)
            : currentPrice * (1 + bufferPercent / 100);

          console.log(`PositionManager: Position ${symbol} is underwater. Adjusting SL from ${rawSlPrice.toFixed(4)} to ${adjustedSlPrice.toFixed(4)} (current: ${currentPrice.toFixed(4)})`);
        }

        const slPrice = symbolPrecision.formatPrice(symbol, adjustedSlPrice);
        console.log(`PositionManager: Placing SL orders for ${symbol} with formatted price ${slPrice} and quantity ${quantity}`);

        const slOrderIds = await placeReduceOnlyChunks('STOP_MARKET', slPrice, 'al_sl');
        orders.slOrderIds = slOrderIds;
        orders.slOrderId = slOrderIds[0];

        if (this.statusBroadcaster && slOrderIds.length > 0) {
          this.statusBroadcaster.broadcastStopLossPlaced({
            symbol,
            price: slPrice,
            quantity,
            orderId: slOrderIds[0].toString(),
          });
        }
      }

      if (placeTP) {
        const rawTpPrice = isLong
          ? entryPrice * (1 + symbolConfig.tpPercent / 100)
          : entryPrice * (1 - symbolConfig.tpPercent / 100);

        const currentPrice = await getCurrentPrice();
        const pastTP = isLong
          ? currentPrice >= rawTpPrice
          : currentPrice <= rawTpPrice;

        if (pastTP) {
          const pnlPercent = isLong
            ? ((currentPrice - entryPrice) / entryPrice) * 100
            : ((entryPrice - currentPrice) / entryPrice) * 100;

          console.log(`PositionManager: Position ${symbol} has exceeded TP target! Current PnL: ${pnlPercent.toFixed(2)}%, target: ${symbolConfig.tpPercent}%`);
          console.log('PositionManager: Closing position at market - already past TP target');

          try {
            await placeMarketChunks();

            if (this.statusBroadcaster) {
              this.statusBroadcaster.broadcastPositionClosed({
                symbol,
                side: isLong ? 'LONG' : 'SHORT',
                quantity,
                pnl: pnlPercent * quantity * currentPrice / 100,
                reason: 'Auto-closed at market (exceeded TP target)',
              });
            }

            if (placeSL) {
              console.log(`PositionManager: Position closed, skipping SL placement`);
            }
            return;
          } catch (marketError: any) {
            console.error(`PositionManager: Failed to close at market: ${marketError.response?.data?.msg || marketError.message}`);
            console.log(`PositionManager: Not placing TP order since position is past target and market close failed`);
            return;
          }
        }

        const tpPrice = symbolPrecision.formatPrice(symbol, rawTpPrice);
        console.log(`PositionManager: Placing TP orders for ${symbol} with formatted price ${tpPrice} and quantity ${quantity}`);

        const tpOrderIds = await placeReduceOnlyChunks('TAKE_PROFIT_MARKET', tpPrice, 'al_tp');
        orders.tpOrderIds = tpOrderIds;
        orders.tpOrderId = tpOrderIds[0];

        if (this.statusBroadcaster && tpOrderIds.length > 0) {
          this.statusBroadcaster.broadcastTakeProfitPlaced({
            symbol,
            price: tpPrice,
            quantity,
            orderId: tpOrderIds[0].toString(),
          });
        }
      }

      this.positionOrders.set(key, orders);
    } catch (error: any) {
      const errorMsg = error.response?.data?.msg || error.message || 'Unknown error';
      console.error(`PositionManager: Failed to place protective orders for ${symbol}:`, error.response?.data || error.message);

      // Log to error database
      await errorLogger.logTradingError(
        'placeProtectiveOrders',
        symbol,
        error instanceof Error ? error : new Error(errorMsg),
        {
          entryPrice,
          quantity,
          isLong,
          slPercent: symbolConfig.slPercent,
          tpPercent: symbolConfig.tpPercent,
          errorCode: error.response?.data?.code,
          errorDetails: error.response?.data
        }
      );

      // Broadcast error to UI
      if (this.statusBroadcaster) {
        this.statusBroadcaster.broadcastTradingError(
          `Failed to Place Protective Orders - ${symbol}`,
          errorMsg,
          {
            component: 'PositionManager',
            symbol,
            errorCode: error.response?.data?.code,
            rawError: error.response?.data || error,
          }
        );
      }
    }
  }

  private async checkRisk(): Promise<void> {
    // Check total PnL
    const _riskPercent = this.config.global.riskPercent / 100;
    // Simplified: assume some PnL calculation
    // If unrealized PnL < -risk * balance, close all positions
    // Implementation depends on balance query

    console.log(`PositionManager: Risk check complete`);
  }

  // Clean up orphaned orders (orders for symbols without active positions) and duplicates
  private async cleanupOrphanedOrders(): Promise<void> {
    try {
      console.log('PositionManager: Checking for orphaned and duplicate orders...');

      const openOrders = await this.getOpenOrdersFromExchange();
      const positions = await this.getPositionsFromExchange();

      // Create map of active positions with their position details
      const activePositions = new Map<string, { symbol: string; positionAmt: number; positionSide: string }>();

      // Create a more detailed position tracking structure
      const symbolPositionDetails = new Map<string, { long: boolean; short: boolean; amounts: number[] }>();

      for (const position of positions) {
        const posAmt = parseFloat(position.positionAmt);
        if (Math.abs(posAmt) > 0) {
          const key = this.getPositionKey(position.symbol, position.positionSide, posAmt);
          activePositions.set(key, {
            symbol: position.symbol,
            positionAmt: posAmt,
            positionSide: position.positionSide
          });

          // Track position details per symbol
          if (!symbolPositionDetails.has(position.symbol)) {
            symbolPositionDetails.set(position.symbol, { long: false, short: false, amounts: [] });
          }
          const details = symbolPositionDetails.get(position.symbol)!;
          details.amounts.push(posAmt);
          if (posAmt > 0) details.long = true;
          if (posAmt < 0) details.short = true;
        }
      }

      const _activeSymbols = new Set(Array.from(activePositions.values()).map(p => p.symbol));

      // Find orphaned orders (reduce-only orders for symbols without ANY positions)
      // More precise check: an order is only orphaned if:
      // 1. It's a reduce-only order
      // 2. The symbol has NO positions at all
      // 3. OR the order direction doesn't match any existing position
      const orphanedOrders = openOrders.filter(order => {
        if (!order.reduceOnly) return false;

        const symbolDetails = symbolPositionDetails.get(order.symbol);

        // If symbol has no positions at all, it's orphaned
        if (!symbolDetails) {
          const isBotOrder = order.clientOrderId &&
            (order.clientOrderId.startsWith('al_sl_') || order.clientOrderId.startsWith('al_tp_'));
          console.log(`PositionManager: Found orphaned ${order.type} order for ${order.symbol} (no position) - OrderId: ${order.orderId}, ClientOrderId: ${order.clientOrderId || 'none'}, Bot order: ${isBotOrder ? 'yes' : 'no'}`);
          return true;
        }

        // Check if order matches any position direction
        // SELL reduce-only orders close LONG positions
        // BUY reduce-only orders close SHORT positions
        const orderMatchesPosition =
          (order.side === 'SELL' && symbolDetails.long) ||
          (order.side === 'BUY' && symbolDetails.short);

        if (!orderMatchesPosition) {
          console.log(`PositionManager: Found orphaned ${order.type} order for ${order.symbol} (direction mismatch) - OrderId: ${order.orderId}, Side: ${order.side}, Has Long: ${symbolDetails.long}, Has Short: ${symbolDetails.short}`);
          return true;
        }

        return false;
      });

      // Find stuck entry orders (non reduce-only orders that have been open for too long without creating positions)
      // These are LIMIT orders that haven't filled and don't have corresponding positions
      const stuckEntryOrders = openOrders.filter(order => {
        // Only check non reduce-only LIMIT orders
        if (order.reduceOnly || order.type !== 'LIMIT') {
          return false;
        }

        // Check if this symbol has an active position
        const hasPosition = Array.from(activePositions.values()).some(p => p.symbol === order.symbol);

        // Calculate order age
        const orderAge = Date.now() - order.time;

        // For non reduce-only LIMIT orders, ensure they're at least 30 seconds old
        // This prevents cancelling orders that were just placed
        if (orderAge < 30 * 1000) { // 30 seconds
          return false;
        }

        // If no position exists and order is older than 5 minutes, consider it stuck
        const isStuck = !hasPosition && orderAge > 5 * 60 * 1000; // 5 minutes

        if (isStuck) {
          console.log(`PositionManager: Found stuck entry order for ${order.symbol} - OrderId: ${order.orderId}, Type: ${order.type}, Age: ${Math.round(orderAge / 1000)}s`);
        }

        return isStuck;
      });

      // Find duplicate orders for each active position
      const duplicateOrders: ExchangeOrder[] = [];

      // Group orders by symbol and type for better duplicate detection
      const ordersBySymbolAndType = new Map<string, { sl: ExchangeOrder[]; tp: ExchangeOrder[] }>();

      for (const [key, positionData] of activePositions) {
        const { symbol, positionAmt } = positionData;

        // Initialize order tracking for this symbol if needed
        if (!ordersBySymbolAndType.has(symbol)) {
          ordersBySymbolAndType.set(symbol, { sl: [], tp: [] });
        }

        // Find all SL orders for this specific position
        const slOrders = openOrders.filter(o => {
          // Must match symbol
          if (o.symbol !== symbol) return false;
          // Must be a stop order type
          if (!(o.type === 'STOP_MARKET' || o.type === 'STOP')) return false;
          // Must be reduce-only
          if (!o.reduceOnly) return false;
          // Must match position direction (SELL for LONG, BUY for SHORT)
          const directionMatches = (positionAmt > 0 && o.side === 'SELL') || (positionAmt < 0 && o.side === 'BUY');
          if (!directionMatches) return false;

          // Additional validation: log what we're considering
          console.log(`PositionManager: Evaluating SL order ${o.orderId} for position ${key} - Symbol: ${o.symbol}, Side: ${o.side}, Type: ${o.type}`);
          return true;
        });

        // Find all TP orders for this specific position
        const tpOrders = openOrders.filter(o => {
          // Must match symbol
          if (o.symbol !== symbol) return false;
          // Must be a take profit or limit order type
          if (!(o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT' || o.type === 'LIMIT')) return false;
          // Must be reduce-only
          if (!o.reduceOnly) return false;
          // Must match position direction (SELL for LONG, BUY for SHORT)
          const directionMatches = (positionAmt > 0 && o.side === 'SELL') || (positionAmt < 0 && o.side === 'BUY');
          if (!directionMatches) return false;

          // Additional validation: log what we're considering
          console.log(`PositionManager: Evaluating TP order ${o.orderId} for position ${key} - Symbol: ${o.symbol}, Side: ${o.side}, Type: ${o.type}`);
          return true;
        });

        // Track orders for this symbol
        const symbolOrders = ordersBySymbolAndType.get(symbol)!;
        symbolOrders.sl.push(...slOrders);
        symbolOrders.tp.push(...tpOrders);

        // Mark duplicates for cancellation (keep first, cancel rest)
        if (slOrders.length > 1) {
          console.log(`PositionManager: Found ${slOrders.length} SL orders for position ${key} (${symbol}), marking ${slOrders.length - 1} for cancellation`);
          // Sort by order ID to ensure consistent behavior
          slOrders.sort((a, b) => a.orderId - b.orderId);
          duplicateOrders.push(...slOrders.slice(1));
        }

        if (tpOrders.length > 1) {
          console.log(`PositionManager: Found ${tpOrders.length} TP orders for position ${key} (${symbol}), marking ${tpOrders.length - 1} for cancellation`);
          // Sort by order ID to ensure consistent behavior
          tpOrders.sort((a, b) => a.orderId - b.orderId);
          duplicateOrders.push(...tpOrders.slice(1));
        }
      }

      // Cancel orphaned orders
      if (orphanedOrders.length > 0) {
        console.log(`PositionManager: Found ${orphanedOrders.length} orphaned orders to cleanup`);

        // Group by symbol for logging
        const orphanedBySymbol = new Map<string, ExchangeOrder[]>();
        for (const order of orphanedOrders) {
          if (!orphanedBySymbol.has(order.symbol)) {
            orphanedBySymbol.set(order.symbol, []);
          }
          orphanedBySymbol.get(order.symbol)!.push(order);
        }

        // Log summary
        for (const [symbol, orders] of orphanedBySymbol) {
          console.log(`PositionManager: Cancelling ${orders.length} orphaned orders for ${symbol}`);
        }

        for (const order of orphanedOrders) {
          try {
            // Double-check that this order is really for the correct symbol
            if (order.symbol && order.orderId) {
              console.log(`PositionManager: Cancelling orphaned order - Symbol: ${order.symbol}, OrderId: ${order.orderId}, Type: ${order.type}, Side: ${order.side}`);
              await this.cancelOrderById(order.symbol, order.orderId);
              console.log(`PositionManager: Successfully cancelled orphaned order ${order.symbol} #${order.orderId} (${order.type})`);
            } else {
              console.warn(`PositionManager: Skipping invalid orphaned order - missing symbol or orderId`);
            }
          } catch (error: any) {
            // Ignore "order not found" errors (already filled/cancelled)
            if (error?.response?.data?.code === -2011) {
              console.log(`PositionManager: Orphaned order ${order.symbol} #${order.orderId} already filled/cancelled`);
            } else {
              console.error(`PositionManager: Failed to cancel orphaned order ${order.symbol} #${order.orderId}:`, error?.response?.data || error?.message);
              // Log non-critical cancellation errors
              errorLogger.logError(error instanceof Error ? error : new Error(String(error)), {
                type: 'api',
                severity: 'low',
                context: {
                  component: 'PositionManager',
                  symbol: order.symbol,
                  userAction: 'Cancelling orphaned order',
                  metadata: { orderId: order.orderId, orderType: order.type }
                }
              });
            }
          }
        }
      }

      // Cancel duplicate orders
      if (duplicateOrders.length > 0) {
        console.log(`PositionManager: Found ${duplicateOrders.length} duplicate orders to cleanup`);

        // Remove any duplicates from the duplicate list itself
        const uniqueDuplicates = Array.from(new Map(duplicateOrders.map(o => [`${o.symbol}_${o.orderId}`, o])).values());

        if (uniqueDuplicates.length !== duplicateOrders.length) {
          console.log(`PositionManager: Deduplicated ${duplicateOrders.length} to ${uniqueDuplicates.length} unique duplicate orders`);
        }

        for (const order of uniqueDuplicates) {
          try {
            // Validate before cancellation
            if (order.symbol && order.orderId) {
              console.log(`PositionManager: Cancelling duplicate order - Symbol: ${order.symbol}, OrderId: ${order.orderId}, Type: ${order.type}, Side: ${order.side}`);
              await this.cancelOrderById(order.symbol, order.orderId);
              console.log(`PositionManager: Successfully cancelled duplicate order ${order.symbol} #${order.orderId} (${order.type})`);
            }
          } catch (error: any) {
            // Ignore "order not found" errors (already filled/cancelled)
            if (error?.response?.data?.code === -2011) {
              console.log(`PositionManager: Duplicate order ${order.symbol} #${order.orderId} already filled/cancelled`);
            } else {
              console.error(`PositionManager: Failed to cancel duplicate order ${order.symbol} #${order.orderId}:`, error?.response?.data || error?.message);
            }
          }
        }
      }

      // Cancel stuck entry orders
      if (stuckEntryOrders.length > 0) {
        console.log(`PositionManager: Found ${stuckEntryOrders.length} stuck entry orders to cleanup`);

        for (const order of stuckEntryOrders) {
          try {
            await this.cancelOrderById(order.symbol, order.orderId);
            console.log(`PositionManager: Cancelled stuck entry order ${order.symbol} #${order.orderId} (${order.type})`);
          } catch (error: any) {
            // Ignore "order not found" errors (already filled/cancelled)
            if (error?.response?.data?.code === -2011) {
              console.log(`PositionManager: Stuck entry order ${order.symbol} #${order.orderId} already filled/cancelled`);
            } else {
              console.error(`PositionManager: Failed to cancel stuck entry order ${order.symbol} #${order.orderId}:`, error?.response?.data || error?.message);
            }
          }
        }
      }

      if (orphanedOrders.length === 0 && duplicateOrders.length === 0 && stuckEntryOrders.length === 0) {
        console.log('PositionManager: No orphaned, duplicate, or stuck orders found');
      }
    } catch (error: any) {
      console.error('PositionManager: Error during orphaned order cleanup:', error?.response?.data || error?.message);
      // Log to error database
      errorLogger.logError(error instanceof Error ? error : new Error(String(error)), {
        type: 'general',
        severity: 'medium',
        context: {
          component: 'PositionManager',
          userAction: 'Cleaning up orphaned orders',
          metadata: error?.response?.data
        }
      });
    }
  }

  // Check and adjust all orders periodically
  private async checkAndAdjustOrders(): Promise<void> {
    // IMPORTANT: Force a sync every time to ensure we have all positions
    // This fixes the bug where HYPE/ASTER positions weren't being tracked
    console.log('PositionManager: Forcing position sync to ensure all positions are tracked...');
    try {
      await this.syncWithExchange();
    } catch (error) {
      console.error('PositionManager: Failed to sync during periodic check:', error);
    }

    if (this.currentPositions.size === 0) {
      console.log('PositionManager: No positions found after sync');
      return; // No positions to check
    }

    console.log(`PositionManager: Checking ${this.currentPositions.size} position(s) for order adjustments`);

    try {
      // Get all open orders from exchange
      const openOrders = await this.getOpenOrdersFromExchange();

      // Check each position
      for (const [key, position] of this.currentPositions.entries()) {
        const symbol = position.symbol;
        const posAmt = parseFloat(position.positionAmt);
        const positionQty = Math.abs(posAmt);
        const entryPrice = parseFloat(position.entryPrice);
        const markPrice = parseFloat(position.markPrice);
        const isLong = posAmt > 0;

        // Only manage positions for symbols in our config
        const symbolConfig = this.config.symbols[symbol];
        if (!symbolConfig) {
          continue;
        }

        // Check if position has exceeded TP target
        const tpPercent = symbolConfig.tpPercent || 0.5;
        const targetTP = isLong
          ? entryPrice * (1 + tpPercent / 100)
          : entryPrice * (1 - tpPercent / 100);

        const pastTP = isLong
          ? markPrice >= targetTP
          : markPrice <= targetTP;

        if (pastTP) {
          const pnlPercent = isLong
            ? ((markPrice - entryPrice) / entryPrice) * 100
            : ((entryPrice - markPrice) / entryPrice) * 100;

          console.log(`PositionManager: [Periodic Check] Position ${symbol} exceeded TP target!`);
          console.log(`  PnL: ${pnlPercent.toFixed(2)}%, TP target: ${tpPercent}%`);

          // Always close at market if past TP target
          if (pnlPercent > tpPercent) {
            console.log(`PositionManager: Auto-closing ${symbol} at market - PnL ${pnlPercent.toFixed(2)}% exceeds TP target`);

            try {
              const formattedQty = symbolPrecision.formatQuantity(symbol, positionQty);
              const orderPositionSide = position.positionSide || 'BOTH';

              const marketParams: any = {
                symbol,
                side: isLong ? 'SELL' : 'BUY',
                type: 'MARKET',
                quantity: formattedQty,
                positionSide: orderPositionSide as 'BOTH' | 'LONG' | 'SHORT',
                newClientOrderId: `al_periodic_close_${symbol}_${Date.now()}`,
              };

              if (orderPositionSide === 'BOTH') {
                marketParams.reduceOnly = true;
              }

              const marketOrder = await placeOrder(marketParams, this.config.api);
              console.log(`PositionManager: Position ${symbol} closed at market! Order ID: ${marketOrder.orderId}`);

              if (this.statusBroadcaster) {
                this.statusBroadcaster.broadcastPositionClosed({
                  symbol,
                  side: isLong ? 'LONG' : 'SHORT',
                  quantity: positionQty,
                  pnl: pnlPercent * positionQty * markPrice / 100,
                  reason: 'Periodic auto-close (exceeded TP target)',
                });
              }

              // Remove from tracking
              this.currentPositions.delete(key);
              this.positionOrders.delete(key);
              continue; // Skip to next position
            } catch (error: any) {
              console.error(`PositionManager: Failed to auto-close ${symbol}: ${error?.response?.data?.msg || error?.message}`);
            }
          }
        }

        // Find SL/TP orders for this position
        const slOrders = openOrders.filter(o =>
          o.symbol === symbol &&
          (o.type === 'STOP_MARKET' || o.type === 'STOP') &&
          o.reduceOnly &&
          ((posAmt > 0 && o.side === 'SELL') || (posAmt < 0 && o.side === 'BUY'))
        );

        const tpOrders = openOrders.filter(o =>
          o.symbol === symbol &&
          (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT' || o.type === 'LIMIT') &&
          o.reduceOnly &&
          ((posAmt > 0 && o.side === 'SELL') || (posAmt < 0 && o.side === 'BUY'))
        );

        let needsAdjustment = false;

        if (slOrders.length > 0) {
          const slTotalQty = slOrders.reduce((sum, order) => sum + Math.abs(parseFloat(order.origQty)), 0);
          if (Math.abs(slTotalQty - positionQty) > 0.00000001) {
            console.log(`PositionManager: [Periodic Check] SL orders ${slOrders.map(o => o.orderId).join(', ')} quantity mismatch - Total: ${slTotalQty}, Position: ${positionQty}`);
            needsAdjustment = true;
          }
        }

        if (tpOrders.length > 0) {
          const tpTotalQty = tpOrders.reduce((sum, order) => sum + Math.abs(parseFloat(order.origQty)), 0);
          if (Math.abs(tpTotalQty - positionQty) > 0.00000001) {
            console.log(`PositionManager: [Periodic Check] TP orders ${tpOrders.map(o => o.orderId).join(', ')} quantity mismatch - Total: ${tpTotalQty}, Position: ${positionQty}`);
            needsAdjustment = true;
          }
        }

        // Adjust if needed
        if (needsAdjustment) {
          await this.adjustProtectiveOrders(position, slOrders, tpOrders);
        } else if (slOrders.length === 0 || tpOrders.length === 0) {
          console.log(`PositionManager: [Periodic Check] Position ${key} missing protection (SL: ${slOrders.length > 0}, TP: ${tpOrders.length > 0})`);
          await this.placeProtectiveOrdersWithLock(key, position, slOrders.length === 0, tpOrders.length === 0);
        }
      }
    } catch (error: any) {
      console.error('PositionManager: Error during periodic order check:', error?.response?.data || error?.message);
    }
  }

  // Check and adjust orders for a specific position
  private async checkAndAdjustOrdersForPosition(positionKey: string): Promise<void> {
    const position = this.currentPositions.get(positionKey);
    if (!position) {
      return;
    }

    const symbol = position.symbol;
    const posAmt = parseFloat(position.positionAmt);
    const positionQty = Math.abs(posAmt);

    // Only manage positions for symbols in our config
    const symbolConfig = this.config.symbols[symbol];
    if (!symbolConfig) {
      return;
    }

    // Add lock to prevent concurrent adjustments
    const adjustLockKey = `adjust_${symbol}`;
    if (this.orderPlacementLocks.has(adjustLockKey)) {
      console.log(`PositionManager: Order adjustment already in progress for ${symbol}, skipping`);
      return;
    }

    this.orderPlacementLocks.add(adjustLockKey);

    console.log(`PositionManager: Checking orders for position ${positionKey} (size: ${positionQty})`);

    try {
      // Get all open orders from exchange
      const openOrders = await this.getOpenOrdersFromExchange();

      // Find SL/TP orders for this position
      const slOrders = openOrders.filter(o =>
        o.symbol === symbol &&
        (o.type === 'STOP_MARKET' || o.type === 'STOP') &&
        o.reduceOnly &&
        ((posAmt > 0 && o.side === 'SELL') || (posAmt < 0 && o.side === 'BUY'))
      );

      const tpOrders = openOrders.filter(o =>
        o.symbol === symbol &&
        (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT' || o.type === 'LIMIT') &&
        o.reduceOnly &&
        ((posAmt > 0 && o.side === 'SELL') || (posAmt < 0 && o.side === 'BUY'))
      );

      // Always adjust orders when position size changes
      await this.adjustProtectiveOrders(position, slOrders, tpOrders);
    } catch (error: any) {
      console.error(`PositionManager: Error checking orders for position ${positionKey}:`, error?.response?.data || error?.message);
      // Log to error database
      errorLogger.logError(error instanceof Error ? error : new Error(String(error)), {
        type: 'general',
        severity: 'medium',
        context: {
          component: 'PositionManager',
          symbol,
          userAction: 'Checking and adjusting orders',
          metadata: { positionKey, positionQty, error: error?.response?.data }
        }
      });
    } finally {
      // Always release the lock
      this.orderPlacementLocks.delete(adjustLockKey);
    }
  }

  // Manual cleanup method to immediately clean up orphaned/duplicate orders
  public async manualCleanup(): Promise<void> {
    console.log('PositionManager: Manual cleanup triggered');
    await this.cleanupOrphanedOrders();
  }

  // Manual methods
  public async closePosition(symbol: string, side: string): Promise<void> {
    // Find the position in our current positions map
    let targetPosition: ExchangePosition | undefined;
    let targetKey: string | undefined;

    for (const [key, position] of this.currentPositions.entries()) {
      if (position.symbol === symbol) {
        const posAmt = parseFloat(position.positionAmt);
        if ((side === 'LONG' && posAmt > 0) || (side === 'SHORT' && posAmt < 0)) {
          targetPosition = position;
          targetKey = key;
          break;
        }
      }
    }

    if (!targetPosition || !targetKey) {
      console.warn(`PositionManager: Position ${symbol} ${side} not found`);
      return;
    }

    // Cancel SL/TP if they exist
    const orders = this.positionOrders.get(targetKey);
    if (orders) {
      await this.cancelProtectiveOrders(targetKey, orders);
    }

    // Place market close orders in compliant chunks
    const posAmt = parseFloat(targetPosition.positionAmt);
    const quantity = Math.abs(posAmt);
    const closeSide = posAmt > 0 ? 'SELL' : 'BUY';
    const orderPositionSide = (targetPosition.positionSide || 'BOTH') as 'BOTH' | 'LONG' | 'SHORT';
    const orderSide = closeSide as 'BUY' | 'SELL';

    let chunkQuantities: number[] = [];
    try {
      const exchangeInfo = await getExchangeInfo();
      const symbolInfo = exchangeInfo?.symbols?.find((info: any) => info.symbol === symbol);

      const marketLot = symbolInfo?.filters?.find((f: any) => f.filterType === 'MARKET_LOT_SIZE');
      const lotSize = symbolInfo?.filters?.find((f: any) => f.filterType === 'LOT_SIZE');

      const rawStepSize = marketLot?.stepSize ?? lotSize?.stepSize ?? '0';
      const stepSize = parseFloat(rawStepSize) || 0;
      const tolerance = stepSize > 0 ? stepSize / 1000 : 1e-8;
      const maxQty = parseFloat(marketLot?.maxQty ?? '0');
      const minQty = parseFloat(marketLot?.minQty ?? lotSize?.minQty ?? '0');

      const floorToStep = (value: number) => {
        if (stepSize <= 0) return value;
        const units = Math.floor((value + tolerance) / stepSize);
        return units * stepSize;
      };

      let remaining = quantity;
      const effectiveMax = maxQty > 0 ? maxQty : quantity;

      while (remaining > tolerance) {
        let chunk = floorToStep(Math.min(remaining, effectiveMax));
        if (chunk <= tolerance) {
          chunk = floorToStep(remaining);
        }

        if (chunk <= tolerance) {
          break;
        }

        if (minQty > 0 && chunk + tolerance < minQty) {
          if (chunkQuantities.length === 0) {
            chunk = floorToStep(minQty);
            if (chunk > remaining + tolerance) {
              chunk = floorToStep(remaining);
            }
          } else {
            const lastIndex = chunkQuantities.length - 1;
            const merged = chunkQuantities[lastIndex] + chunk;
            if (maxQty > 0 && merged > maxQty + tolerance) {
              throw new Error('Cannot merge remainder for ' + symbol + ' without exceeding max quantity');
            }
            chunkQuantities[lastIndex] = symbolPrecision.formatQuantity(symbol, merged);
            remaining = floorToStep(remaining - chunk);
            continue;
          }
        }

        const formattedChunk = symbolPrecision.formatQuantity(symbol, chunk);
        if (formattedChunk <= tolerance) {
          break;
        }

        chunkQuantities.push(formattedChunk);
        remaining = floorToStep(remaining - chunk);
      }

      const executed = chunkQuantities.reduce((sum, value) => sum + value, 0);
      const residual = quantity - executed;
      if (Math.abs(residual) > tolerance) {
        const formattedResidual = symbolPrecision.formatQuantity(symbol, residual);
        if (formattedResidual > tolerance) {
          chunkQuantities.push(formattedResidual);
        }
      }

      if (chunkQuantities.length === 0) {
        chunkQuantities = [symbolPrecision.formatQuantity(symbol, quantity)];
      }
    } catch (error) {
      console.warn('PositionManager: Falling back to single close order for ' + symbol + ': ' + (error instanceof Error ? error.message : String(error)));
      const fallbackQty = symbolPrecision.formatQuantity(symbol, quantity);
      chunkQuantities = [fallbackQty > 0 ? fallbackQty : quantity];
    }

    let totalClosed = 0;
    for (const chunk of chunkQuantities) {
      if (chunk <= 0) {
        continue;
      }

      console.log('PositionManager: Closing ' + symbol + ' ' + side + ' chunk with quantity ' + chunk);
      await placeOrder({
        symbol,
        side: orderSide,
        type: 'MARKET',
        quantity: chunk,
        positionSide: orderPositionSide,
        ...(orderPositionSide === 'BOTH' ? { reduceOnly: true } : {}),
      }, this.config.api);

      totalClosed += chunk;
    }

    const quantityDiff = Math.abs(totalClosed - quantity);
    if (quantityDiff > 1e-6) {
      console.warn('PositionManager: Requested close quantity ' + quantity + ' vs executed ' + totalClosed + ' for ' + symbol);
    }

    // Remove from our maps (will be confirmed by ACCOUNT_UPDATE)
    this.currentPositions.delete(targetKey);
    this.positionOrders.delete(targetKey);

    console.log(`PositionManager: Closed position ${symbol} ${side}`);

    // Broadcast position closure
    if (this.statusBroadcaster) {
      this.statusBroadcaster.broadcastPositionUpdate({
        symbol,
        side,
        quantity: quantity,
        price: 0, // Market close
        type: 'closed',
        pnl: 0 // Will be updated by account stream
      });
    }

    // Trigger balance refresh after position close
    this.refreshBalance();
  }

  // Get current positions for API/UI
  public getPositions(): ExchangePosition[] {
    return Array.from(this.currentPositions.values());
  }

  // Check if position exists
  public hasPosition(symbol: string): boolean {
    for (const position of this.currentPositions.values()) {
      if (position.symbol === symbol && Math.abs(parseFloat(position.positionAmt)) > 0) {
        return true;
      }
    }
    return false;
  }

  // ===== Position Tracking Methods for Hunter =====

  // Calculate total margin usage for a symbol (position size × leverage × entry price)
  public getMarginUsage(symbol: string): number {
    let totalMargin = 0;

    for (const position of this.currentPositions.values()) {
      if (position.symbol === symbol) {
        const positionAmt = Math.abs(parseFloat(position.positionAmt));
        if (positionAmt > 0) {
          const entryPrice = parseFloat(position.entryPrice);
          let leverage = parseFloat(position.leverage);

          // Handle invalid leverage (0, NaN, or undefined)
          if (!leverage || leverage === 0 || isNaN(leverage)) {
            // First try to use tracked leverage from ACCOUNT_CONFIG_UPDATE
            const trackedLeverage = this.symbolLeverage.get(symbol);
            if (trackedLeverage) {
              console.log(`PositionManager: Using tracked leverage for ${symbol}: ${trackedLeverage}x`);
              leverage = trackedLeverage;
            } else {
              // Then try to use configured leverage as fallback
              const symbolConfig = this.config.symbols[symbol];
              if (symbolConfig && symbolConfig.leverage) {
                console.log(`PositionManager: Warning - No tracked leverage for ${symbol}, using configured leverage: ${symbolConfig.leverage}`);
                leverage = symbolConfig.leverage;
              } else {
                // Last resort: assume leverage of 1 (no leverage)
                console.log(`PositionManager: Warning - No tracked leverage for ${symbol} and no config found, defaulting to 1x`);
                leverage = 1;
              }
            }
          }

          // Margin = (Position Size × Entry Price) / Leverage
          const margin = (positionAmt * entryPrice) / leverage;
          totalMargin += margin;
        }
      }
    }

    return totalMargin;
  }

  // Get total count of all open positions
  public getTotalPositionCount(): number {
    let count = 0;
    for (const position of this.currentPositions.values()) {
      if (Math.abs(parseFloat(position.positionAmt)) > 0) {
        count++;
      }
    }
    return count;
  }

  // Refresh balance from the exchange
  private async refreshBalance(): Promise<void> {
    try {
      const balanceService = getBalanceService();
      if (balanceService && balanceService.isInitialized()) {
        // The balance service will automatically update via its WebSocket stream
        // We just need to trigger a manual fetch to ensure consistency
        await (balanceService as any).fetchInitialBalance();
        console.log('PositionManager: Triggered balance refresh after position change');
      }
    } catch (error) {
      console.error('PositionManager: Failed to refresh balance:', error);
    }
  }

  // Get unique position count (hedge mode: long+short on same symbol = 1 position)
  public getUniquePositionCount(isHedgeMode: boolean): number {
    if (!isHedgeMode) {
      // In one-way mode, just count positions with non-zero amount
      return this.getTotalPositionCount();
    }

    // In hedge mode, count unique symbols
    const uniqueSymbols = new Set<string>();
    for (const position of this.currentPositions.values()) {
      if (Math.abs(parseFloat(position.positionAmt)) > 0) {
        uniqueSymbols.add(position.symbol);
      }
    }
    return uniqueSymbols.size;
  }

  // Get Map of positions for direct access
  public getPositionsMap(): Map<string, ExchangePosition> {
    return this.currentPositions;
  }
}
