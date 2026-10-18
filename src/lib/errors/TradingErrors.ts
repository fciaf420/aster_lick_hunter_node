import { symbolPrecision } from '../utils/symbolPrecision';

export type ErrorSubCategory =
  | 'rate-limit'
  | 'authentication'
  | 'validation'
  | 'server-error'
  | 'notional-error'
  | 'insufficient-balance'
  | 'price-precision'
  | 'quantity-precision'
  | 'order-rejection'
  | 'position-mode'
  | 'connection-lost'
  | 'reconnect-failed'
  | 'message-parse'
  | 'memory-leak'
  | 'crash'
  | 'uncaught-exception'
  | 'general';

export class TradingError extends Error {
  public subCategory?: ErrorSubCategory;
  public fingerprint?: string;
  public correlationId?: string;
  public timestamp: string;

  constructor(
    message: string,
    public code?: number,
    public symbol?: string,
    public details?: any
  ) {
    super(message);
    this.name = 'TradingError';
    this.timestamp = new Date().toISOString();
    this.determineSubCategory();
    this.generateFingerprint();
  }

  protected determineSubCategory(): void {
    // Override in subclasses for specific categorization
    this.subCategory = 'general';
  }

  protected generateFingerprint(): void {
    // Create a unique fingerprint for error deduplication
    this.fingerprint = `${this.name}-${this.code || 'NO_CODE'}-${this.symbol || 'NO_SYMBOL'}`;
  }
}

export class NotionalError extends TradingError {
  constructor(
    public symbol: string,
    public requiredNotional: number,
    public actualNotional: number,
    public price: number,
    public quantity: number,
    public leverage: number
  ) {
    const message = `Minimum notional not met for ${symbol}: Required ${requiredNotional} USDT, got ${actualNotional.toFixed(2)} USDT (price: ${price}, qty: ${quantity}, leverage: ${leverage}x)`;
    super(message, -4164, symbol, {
      requiredNotional,
      actualNotional,
      price,
      quantity,
      leverage,
      calculatedNotional: price * quantity
    });
    this.name = 'NotionalError';
  }

  protected determineSubCategory(): void {
    this.subCategory = 'notional-error';
  }
}

export class InsufficientBalanceError extends TradingError {
  constructor(
    public symbol: string,
    public required: number,
    public available: number
  ) {
    const message = `Insufficient balance for ${symbol}: Required ${required} USDT, available ${available} USDT`;
    super(message, -2019, symbol, { required, available });
    this.name = 'InsufficientBalanceError';
  }

  protected determineSubCategory(): void {
    this.subCategory = 'insufficient-balance';
  }
}

export class SymbolNotFoundError extends TradingError {
  constructor(public symbol: string) {
    const message = `Symbol ${symbol} not found or not available for trading`;
    super(message, -1121, symbol);
    this.name = 'SymbolNotFoundError';
  }

  protected determineSubCategory(): void {
    this.subCategory = 'validation';
  }
}

export class RateLimitError extends TradingError {
  constructor(public retryAfter?: number) {
    super('Rate limit exceeded, please slow down', -1003, undefined);
    this.name = 'RateLimitError';
  }

  protected determineSubCategory(): void {
    this.subCategory = 'rate-limit';
  }
}

export class InvalidOrderTypeError extends TradingError {
  constructor(public orderType: string, public symbol: string) {
    super(`Invalid order type ${orderType} for ${symbol}`, -1116, symbol);
    this.name = 'InvalidOrderTypeError';
  }

  protected determineSubCategory(): void {
    this.subCategory = 'validation';
  }
}

export class OrderRejectedError extends TradingError {
  constructor(message: string, public symbol: string, public reason?: string) {
    super(message, -2010, symbol, { reason });
    this.name = 'OrderRejectedError';
  }

  protected determineSubCategory(): void {
    this.subCategory = 'order-rejection';
  }
}

export class PricePrecisionError extends TradingError {
  constructor(public symbol: string, public price: number, public tickSize: string) {
    const message = tickSize === 'UNKNOWN'
      ? `Price ${price} doesn't meet exchange precision requirements for ${symbol}. Try using default tick size 0.0001`
      : `Price ${price} doesn't meet tick size ${tickSize} for ${symbol}. Price must be a multiple of ${tickSize}`;
    super(message, -1111, symbol, { price, tickSize });
    this.name = 'PricePrecisionError';
  }

  protected determineSubCategory(): void {
    this.subCategory = 'price-precision';
  }
}

export class QuantityPrecisionError extends TradingError {
  constructor(public symbol: string, public quantity: number, public stepSize: string) {
    const message = stepSize === 'UNKNOWN'
      ? `Quantity ${quantity} doesn't meet exchange precision requirements for ${symbol}. Try using default step size 0.001`
      : `Quantity ${quantity} doesn't meet step size ${stepSize} for ${symbol}. Quantity must be a multiple of ${stepSize}`;
    super(message, -1013, symbol, { quantity, stepSize });
    this.name = 'QuantityPrecisionError';
  }

  protected determineSubCategory(): void {
    this.subCategory = 'quantity-precision';
  }
}

export class PositionModeError extends TradingError {
  constructor(
    public symbol: string,
    public attemptedMode: string,
    public requiredMode?: string
  ) {
    const message = requiredMode
      ? `Position mode mismatch for ${symbol}: Attempted to use ${attemptedMode} mode, but exchange requires ${requiredMode} mode`
      : `Order's position side does not match user's setting for ${symbol}. Attempted mode: ${attemptedMode}`;
    super(message, -4061, symbol, { attemptedMode, requiredMode });
    this.name = 'PositionModeError';
  }

  protected determineSubCategory(): void {
    this.subCategory = 'position-mode';
  }
}

export class ReduceOnlyError extends TradingError {
  constructor(public symbol: string) {
    super(`ReduceOnly order rejected for ${symbol}`, -2022, symbol);
    this.name = 'ReduceOnlyError';
  }

  protected determineSubCategory(): void {
    this.subCategory = 'order-rejection';
  }
}

export class OrderWouldTriggerError extends TradingError {
  constructor(public symbol: string, public side: string, public price?: number) {
    super(`Order would immediately trigger for ${symbol}`, -2021, symbol, { side, price });
    this.name = 'OrderWouldTriggerError';
  }

  protected determineSubCategory(): void {
    this.subCategory = 'order-rejection';
  }
}

export function parseExchangeError(error: any, context?: { symbol?: string; quantity?: number; price?: number; leverage?: number; positionSide?: string }): TradingError {
  const code = error.response?.data?.code;
  const msg = error.response?.data?.msg || error.message;

  switch (code) {
    case -4164:
      // MIN_NOTIONAL - Extract required notional from error message if possible
      const match = msg.match(/no smaller than ([\d.]+)/);
      const requiredNotional = match ? parseFloat(match[1]) : 5.0;
      const actualNotional = (context?.price || 0) * (context?.quantity || 0);

      return new NotionalError(
        context?.symbol || 'UNKNOWN',
        requiredNotional,
        actualNotional,
        context?.price || 0,
        context?.quantity || 0,
        context?.leverage || 1
      );

    case -2019:
      // MARGIN_NOT_SUFFICIENT - Insufficient margin
      return new InsufficientBalanceError(
        context?.symbol || 'UNKNOWN',
        0, // Would need to parse from message
        0
      );

    case -1121:
      // BAD_SYMBOL - Invalid symbol
      return new SymbolNotFoundError(context?.symbol || 'UNKNOWN');

    case -1003:
      // TOO_MANY_REQUESTS - Rate limit
      return new RateLimitError();

    case -1116:
      // INVALID_ORDER_TYPE
      return new InvalidOrderTypeError('UNKNOWN', context?.symbol || 'UNKNOWN');

    case -2010:
      // NEW_ORDER_REJECTED
      return new OrderRejectedError(msg, context?.symbol || 'UNKNOWN');

    case -2021:
      // ORDER_WOULD_IMMEDIATELY_TRIGGER
      return new OrderWouldTriggerError(context?.symbol || 'UNKNOWN', 'UNKNOWN', context?.price);

    case -2022:
      // REDUCE_ONLY_REJECT
      return new ReduceOnlyError(context?.symbol || 'UNKNOWN');

    case -1111:
      // BAD_PRECISION - Price precision error
      // Try to extract tick size from error message, else use loaded exchange filters
      const tickSizeMatch = msg.match(/tick size[\s:]*(\d+\.\d+)/i);
      const tickSize = tickSizeMatch
        ? tickSizeMatch[1]
        : (context?.symbol && symbolPrecision.getSymbolFilter(context.symbol)?.tickSize) || 'UNKNOWN';
      return new PricePrecisionError(context?.symbol || 'UNKNOWN', context?.price || 0, tickSize);

    case -1013:
      // INVALID_MESSAGE - Often quantity precision
      if (msg.includes('quantity')) {
        // Try to extract step size from error message, else use loaded exchange filters
        const stepSizeMatch = msg.match(/step size[\s:]*(\d+\.\d+)/i);
        const stepSize = stepSizeMatch
          ? stepSizeMatch[1]
          : (context?.symbol && symbolPrecision.getSymbolFilter(context.symbol)?.stepSize) || 'UNKNOWN';
        return new QuantityPrecisionError(context?.symbol || 'UNKNOWN', context?.quantity || 0, stepSize);
      }
      return new TradingError(msg, code, context?.symbol);

    case -1102:
      // MANDATORY_PARAM_EMPTY_OR_MALFORMED
      return new TradingError(`Mandatory parameter missing or malformed: ${msg}`, code, context?.symbol);

    case -2015:
      // REJECTED_MBX_KEY - Invalid API key
      return new TradingError('Invalid API key or permissions', code, context?.symbol);

    case -1022:
      // INVALID_SIGNATURE
      return new TradingError('Invalid signature - check API credentials', code, context?.symbol);

    case -1021:
      // INVALID_TIMESTAMP
      return new TradingError('Invalid timestamp - check system time sync', code, context?.symbol);

    case -4061:
      // POSITION_SIDE_NOT_MATCH
      // Order's position side does not match user's setting
      return new PositionModeError(
        context?.symbol || 'UNKNOWN',
        context?.positionSide || 'UNKNOWN'
      );

    default:
      // Unknown error code
      return new TradingError(msg || 'Unknown trading error', code, context?.symbol);
  }
}