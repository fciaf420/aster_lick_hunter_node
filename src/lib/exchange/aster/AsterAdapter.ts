import type { ApiCredentials } from '../../types';
import type {
  AccountHistory,
  AccountStream,
  ExchangeAdapter,
  OrderRequest,
  ProtectiveOrdersRequest,
  RequestOptions,
  TickerPrice,
  VenueCapabilities,
  VenueOrder,
  VenuePosition,
} from '../types';
import {
  getAccountInfo,
  getAllSymbolPrices,
  getBalance,
  getBookTicker,
  getExchangeInfo,
  getKlines,
  getMarkPrice,
  getOpenOrders,
  getOrderBook,
  getPositionRisk,
  getSymbolPrice,
} from '../../api/market';
import { cancelAllOrders, cancelOrder, getAllOrders, getPositions, getUserTrades, placeOrder, setLeverage } from '../../api/orders';
import { placeStopLossAndTakeProfit } from '../../api/batchOrders';
import { getPositionMode, setPositionMode } from '../../api/positionMode';
import { UserDataStream } from '../../api/userDataStream';
import {
  aggregateBySymbolWithTrades,
  aggregateDailyPnLWithTrades,
  getIncomeHistory,
  getTimeRangeIncome,
} from '../../api/income';
import { AsterDirectTransport } from './transport';
import { ASTER_STREAM_BASE_URL } from './constants';

export { ASTER_REST_BASE_URL, ASTER_STREAM_BASE_URL } from './constants';

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
  readonly history: AccountHistory;

  private readonly getCredentials: () => ApiCredentials;
  private readonly direct: AsterDirectTransport;

  // Pass a function to always use the latest credentials (e.g. after a config reload)
  constructor(credentials: ApiCredentials | (() => ApiCredentials)) {
    this.getCredentials = typeof credentials === 'function' ? credentials : () => credentials;
    this.direct = new AsterDirectTransport(this.getCredentials);

    const getCredentials = this.getCredentials;
    this.history = {
      getIncomeHistory: (params) => getIncomeHistory(getCredentials(), params),
      getTimeRangeIncome: (range) => getTimeRangeIncome(getCredentials(), range),
      aggregateDailyPnLWithTrades: (records, symbols, startTime, endTime) =>
        aggregateDailyPnLWithTrades(records, getCredentials(), symbols, startTime, endTime),
      aggregateBySymbolWithTrades: (records, symbols, startTime, endTime) =>
        aggregateBySymbolWithTrades(records, getCredentials(), symbols, startTime, endTime),
      getAllOrders: (symbol, startTime, endTime, limit) => getAllOrders(symbol, getCredentials(), startTime, endTime, limit),
      getUserTrades: (symbol, params) => getUserTrades(symbol, getCredentials(), params),
    };
  }

  hasCredentials(): boolean {
    const credentials = this.getCredentials();
    return Boolean(credentials.apiKey && credentials.secretKey);
  }

  getMarkPriceStreamUrl(): string {
    return `${ASTER_STREAM_BASE_URL}/ws/!markPrice@arr@1s`;
  }

  getKlineStreamUrl(subscriptions: { symbol: string; interval: string }[]): string {
    const streams = subscriptions.map(({ symbol, interval }) => `${symbol.toLowerCase()}@kline_${interval}`);
    return `${ASTER_STREAM_BASE_URL}/stream?streams=${streams.join('/')}`;
  }

  getUserDataStreamUrl(listenKey: string): string {
    return `${ASTER_STREAM_BASE_URL}/ws/${listenKey}`;
  }

  getExchangeInfo(options?: RequestOptions) {
    return options?.bypassRateLimit ? this.direct.publicGet<any>('/fapi/v1/exchangeInfo') : getExchangeInfo();
  }

  getMarkPrice(symbol?: string) {
    return getMarkPrice(symbol);
  }

  getTickerPrice(symbol: string, options?: RequestOptions): Promise<TickerPrice> {
    return options?.bypassRateLimit
      ? this.direct.publicGet<TickerPrice>(`/fapi/v1/ticker/price?symbol=${symbol}`)
      : getSymbolPrice(symbol);
  }

  getAllTickerPrices(options?: RequestOptions): Promise<TickerPrice[]> {
    return options?.bypassRateLimit
      ? this.direct.publicGet<TickerPrice[]>('/fapi/v1/ticker/price')
      : getAllSymbolPrices();
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
    return getAccountInfo(this.getCredentials());
  }

  getBalance() {
    return getBalance(this.getCredentials());
  }

  getPositions(symbol?: string, options?: RequestOptions): Promise<VenuePosition[]> {
    if (options?.bypassRateLimit) {
      return this.direct.signedGet<VenuePosition[]>('/fapi/v2/positionRisk', symbol ? { symbol } : {});
    }
    return symbol ? getPositionRisk(symbol, this.getCredentials()) : getPositions(this.getCredentials());
  }

  getOpenOrders(symbol?: string, options?: RequestOptions): Promise<VenueOrder[]> {
    if (options?.bypassRateLimit) {
      return this.direct.signedGet<VenueOrder[]>('/fapi/v1/openOrders', symbol ? { symbol } : {});
    }
    return getOpenOrders(symbol, this.getCredentials());
  }

  getHedgeMode() {
    return getPositionMode(this.getCredentials());
  }

  setHedgeMode(enabled: boolean) {
    return setPositionMode(enabled, this.getCredentials());
  }

  setLeverage(symbol: string, leverage: number) {
    return setLeverage(symbol, leverage, this.getCredentials());
  }

  createUserDataStream(): Promise<string> {
    return this.direct.createListenKey();
  }

  keepAliveUserDataStream(): Promise<void> {
    return this.direct.keepAliveListenKey();
  }

  closeUserDataStream(): Promise<void> {
    return this.direct.closeListenKey();
  }

  createAccountStream(): AccountStream {
    return new UserDataStream(this.getCredentials());
  }

  placeOrder(request: OrderRequest) {
    return placeOrder(request, this.getCredentials());
  }

  placeProtectiveOrders(request: ProtectiveOrdersRequest) {
    return placeStopLossAndTakeProfit(request, this.getCredentials());
  }

  cancelOrder(symbol: string, orderId: number) {
    return cancelOrder({ symbol, orderId }, this.getCredentials());
  }

  cancelAllOrders(symbol: string) {
    return cancelAllOrders(symbol, this.getCredentials());
  }
}
