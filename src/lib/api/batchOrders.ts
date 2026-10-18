/**
 * Batch Orders Utility
 *
 * Implements proper batch order API for Aster Finance
 * Groups multiple orders into single requests to reduce API calls
 */

import { ApiCredentials, Order } from '../types';
import { buildSignedForm } from './auth';
import { getRateLimitedAxios } from './requestInterceptor';
import { RequestPriority } from './rateLimitManager';
import { ASTER_REST_BASE_URL } from '../exchange/aster/constants';

const BASE_URL = ASTER_REST_BASE_URL;

export interface BatchOrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  quantity: number;
  price?: number;
  stopPrice?: number;
  reduceOnly?: boolean;
  positionSide?: 'BOTH' | 'LONG' | 'SHORT';
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'GTX';
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
  newClientOrderId?: string;
  priceProtect?: boolean;
}

export interface BatchOrderResult {
  success: boolean;
  order?: Order;
  error?: {
    code: number;
    msg: string;
  };
}

/**
 * Place multiple orders in a single API call
 * Max 5 orders per batch
 */
export async function placeBatchOrders(
  orders: BatchOrderParams[],
  credentials: ApiCredentials
): Promise<BatchOrderResult[]> {
  if (orders.length === 0) {
    return [];
  }

  if (orders.length > 5) {
    throw new Error('Maximum 5 orders per batch allowed');
  }

  // Prepare batch orders array
  const batchOrders = orders.map(order => {
    const params: any = {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity.toString(),
    };

    // Add optional parameters
    if (order.price !== undefined) params.price = order.price.toString();
    if (order.stopPrice !== undefined) params.stopPrice = order.stopPrice.toString();
    if (order.positionSide) params.positionSide = order.positionSide;
    if (order.timeInForce) params.timeInForce = order.timeInForce;
    if (order.reduceOnly !== undefined) params.reduceOnly = order.reduceOnly.toString();
    if (order.workingType) params.workingType = order.workingType;
    if (order.newClientOrderId) params.newClientOrderId = order.newClientOrderId;
    if (order.priceProtect !== undefined) params.priceProtect = order.priceProtect.toString().toUpperCase();

    // Add timeInForce for limit orders if not specified
    if (params.type === 'LIMIT' && !params.timeInForce) {
      params.timeInForce = 'GTC';
    }

    return params;
  });

  // Build signed form data
  const formData = buildSignedForm(
    { batchOrders: JSON.stringify(batchOrders) },
    credentials
  );

  console.log(`[BATCH ORDER] Placing ${orders.length} orders in single request`);

  try {
    const axios = getRateLimitedAxios();
    const response = await axios.post(`${BASE_URL}/fapi/v1/batchOrders`, formData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-MBX-APIKEY': credentials.apiKey
      },
      // Add metadata for rate limiter
      rateLimitMeta: {
        weight: 5,
        priority: RequestPriority.CRITICAL,
        isOrder: true
      }
    } as any);

    // Parse results
    const results: BatchOrderResult[] = response.data.map((item: any) => {
      if (item.code) {
        // Error response
        return {
          success: false,
          error: {
            code: item.code,
            msg: item.msg
          }
        };
      } else {
        // Success response
        return {
          success: true,
          order: item as Order
        };
      }
    });

    // Log results
    const successCount = results.filter(r => r.success).length;
    console.log(`[BATCH ORDER] ${successCount}/${orders.length} orders placed successfully`);

    return results;
  } catch (error: any) {
    console.error('[BATCH ORDER] Failed:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Cancel multiple orders in a batch
 */
export async function cancelBatchOrders(
  symbol: string,
  orderIds: number[],
  credentials: ApiCredentials
): Promise<any> {
  if (orderIds.length === 0) {
    return [];
  }

  // Aster Finance doesn't have batch cancel, but we can optimize by using cancelAllOrders
  // if we're cancelling all orders for a symbol
  const formData = buildSignedForm({ symbol }, credentials);

  console.log(`[BATCH CANCEL] Cancelling all orders for ${symbol}`);

  try {
    const axios = getRateLimitedAxios();
    const response = await axios.delete(`${BASE_URL}/fapi/v1/allOpenOrders`, {
      headers: {
        'X-MBX-APIKEY': credentials.apiKey
      },
      params: Object.fromEntries(formData),
      rateLimitMeta: {
        weight: 1,
        priority: RequestPriority.CRITICAL,
        isOrder: false
      }
    } as any);

    return response.data;
  } catch (error: any) {
    console.error('[BATCH CANCEL] Failed:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Smart order batching - groups orders by symbol and type for optimal batching
 */
export class OrderBatcher {
  private pendingOrders: Map<string, BatchOrderParams[]> = new Map();
  private flushTimer: NodeJS.Timeout | null = null;
  private credentials: ApiCredentials;
  private maxBatchSize = 5;
  private flushDelay = 100; // ms

  constructor(credentials: ApiCredentials) {
    this.credentials = credentials;
  }

  /**
   * Add an order to the batch queue
   */
  public async addOrder(order: BatchOrderParams): Promise<Order> {
    const key = this.getBatchKey(order);

    if (!this.pendingOrders.has(key)) {
      this.pendingOrders.set(key, []);
    }

    const batch = this.pendingOrders.get(key)!;
    batch.push(order);

    // Flush immediately if batch is full
    if (batch.length >= this.maxBatchSize) {
      return this.flushBatch(key);
    }

    // Schedule flush
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushAll(), this.flushDelay);
    }

    // Return promise that resolves when batch is sent
    return new Promise((resolve, reject) => {
      (order as any)._resolve = resolve;
      (order as any)._reject = reject;
    });
  }

  /**
   * Generate batch key for grouping similar orders
   */
  private getBatchKey(order: BatchOrderParams): string {
    // Group by symbol and order type for better batching
    return `${order.symbol}-${order.type}`;
  }

  /**
   * Flush a specific batch
   */
  private async flushBatch(key: string): Promise<any> {
    const batch = this.pendingOrders.get(key);
    if (!batch || batch.length === 0) return;

    this.pendingOrders.delete(key);

    try {
      const results = await placeBatchOrders(batch, this.credentials);

      // Resolve/reject individual promises
      batch.forEach((order, index) => {
        const result = results[index];
        const resolve = (order as any)._resolve;
        const reject = (order as any)._reject;

        if (result.success && result.order) {
          resolve?.(result.order);
        } else if (result.error) {
          reject?.(new Error(result.error.msg));
        }
      });

      return results;
    } catch (error) {
      // Reject all promises in the batch
      batch.forEach(order => {
        const reject = (order as any)._reject;
        reject?.(error);
      });
      throw error;
    }
  }

  /**
   * Flush all pending batches
   */
  public async flushAll(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const keys = Array.from(this.pendingOrders.keys());
    const promises = keys.map(key => this.flushBatch(key));

    await Promise.all(promises);
  }

  /**
   * Get pending order count
   */
  public getPendingCount(): number {
    let count = 0;
    for (const batch of this.pendingOrders.values()) {
      count += batch.length;
    }
    return count;
  }

  /**
   * Clear all pending orders
   */
  public clear(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingOrders.clear();
  }
}

/**
 * Helper function to place SL and TP orders together
 */
export async function placeStopLossAndTakeProfit(
  params: {
    symbol: string;
    side: 'BUY' | 'SELL';  // BUY for short position, SELL for long position
    quantity: number;
    stopLossPrice: number;
    takeProfitPrice: number;
    positionSide?: 'BOTH' | 'LONG' | 'SHORT';
    reduceOnly?: boolean;
  },
  credentials: ApiCredentials
): Promise<{ stopLoss?: Order; takeProfit?: Order; errors: string[] }> {
  // Build base order params without reduceOnly
  const baseSlOrder: BatchOrderParams = {
    symbol: params.symbol,
    side: params.side,
    type: 'STOP_MARKET',
    quantity: params.quantity,
    stopPrice: params.stopLossPrice,
    positionSide: params.positionSide || 'BOTH',
    workingType: 'MARK_PRICE',
    priceProtect: true,
  };

  const baseTpOrder: BatchOrderParams = {
    symbol: params.symbol,
    side: params.side,
    type: 'TAKE_PROFIT_MARKET',
    quantity: params.quantity,
    stopPrice: params.takeProfitPrice,
    positionSide: params.positionSide || 'BOTH',
    workingType: 'MARK_PRICE',
    priceProtect: true,
  };

  // Only add reduceOnly if explicitly true (for One-way mode)
  // In Hedge Mode, don't send the parameter at all
  if (params.reduceOnly === true) {
    baseSlOrder.reduceOnly = true;
    baseTpOrder.reduceOnly = true;
  }

  const orders: BatchOrderParams[] = [baseSlOrder, baseTpOrder];

  const results = await placeBatchOrders(orders, credentials);

  const response: { stopLoss?: Order; takeProfit?: Order; errors: string[] } = {
    errors: []
  };

  // Parse stop loss result
  if (results[0].success && results[0].order) {
    response.stopLoss = results[0].order;
  } else if (results[0].error) {
    response.errors.push(`SL: ${results[0].error.msg}`);
  }

  // Parse take profit result
  if (results[1].success && results[1].order) {
    response.takeProfit = results[1].order;
  } else if (results[1].error) {
    response.errors.push(`TP: ${results[1].error.msg}`);
  }

  return response;
}