import type { ApiCredentials } from '../../types';
import type { ExchangeAdapter, OrderRequest, VenueCapabilities, VenueOrder, VenuePosition } from '../types';
import {
  getAccountInfo,
  getBalance,
  getBookTicker,
  getExchangeInfo,
  getKlines,
  getMarkPrice,
  getOpenOrders,
  getOrderBook,
  getPositionRisk,
} from '../../api/market';
import { cancelAllOrders, cancelOrder, placeOrder, setLeverage } from '../../api/orders';
import { getPositionMode, setPositionMode } from '../../api/positionMode';

export const ASTER_REST_BASE_URL = 'https://fapi.asterdex.com';
export const ASTER_STREAM_BASE_URL = 'wss://fstream.asterdex.com';

export const ASTER_CAPABILITIES: VenueCapabilities = {
  hedgeMode: true,
  setPositionMode: true,
  reduceOnly: true,
  postOnly: true,
  maxBatchOrders: 5,
  stopMarket: true,
  takeProfitMarket: true,
  triggerPrice: 'MARK',
  perSymbolLeverage: true,
  marginAsset: 'USDT',
};

// Aster Finance (Binance-futures-style API, V1 HMAC keys). Delegates to the existing
// src/lib/api functions so requests are identical to calling them directly.
export class AsterAdapter implements ExchangeAdapter {
  readonly id = 'aster' as const;
  readonly capabilities = ASTER_CAPABILITIES;
  readonly streamBaseUrl = ASTER_STREAM_BASE_URL;

  constructor(private readonly credentials: ApiCredentials) {}

  hasCredentials(): boolean {
    return Boolean(this.credentials.apiKey && this.credentials.secretKey);
  }

  getExchangeInfo() {
    return getExchangeInfo();
  }

  getMarkPrice(symbol?: string) {
    return getMarkPrice(symbol);
  }

  getKlines(symbol: string, interval?: string, limit?: number) {
    return getKlines(symbol, interval, limit);
  }

  getOrderBook(symbol: string, limit?: number) {
    return getOrderBook(symbol, limit);
  }

  getBookTicker(symbol: string) {
    return getBookTicker(symbol);
  }

  getAccountInfo() {
    return getAccountInfo(this.credentials);
  }

  getBalance() {
    return getBalance(this.credentials);
  }

  getPositions(symbol?: string): Promise<VenuePosition[]> {
    return getPositionRisk(symbol, this.credentials);
  }

  getOpenOrders(symbol?: string): Promise<VenueOrder[]> {
    return getOpenOrders(symbol, this.credentials);
  }

  getHedgeMode() {
    return getPositionMode(this.credentials);
  }

  setHedgeMode(enabled: boolean) {
    return setPositionMode(enabled, this.credentials);
  }

  setLeverage(symbol: string, leverage: number) {
    return setLeverage(symbol, leverage, this.credentials);
  }

  placeOrder(request: OrderRequest) {
    return placeOrder(request, this.credentials);
  }

  cancelOrder(symbol: string, orderId: number) {
    return cancelOrder({ symbol, orderId }, this.credentials);
  }

  cancelAllOrders(symbol: string) {
    return cancelAllOrders(symbol, this.credentials);
  }
}
