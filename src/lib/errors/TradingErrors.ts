export class TradingError extends Error {
  constructor(
    message: string,
    public code?: number,
    public symbol?: string,
    public details?: any
  ) {
    super(message);
    this.name = 'TradingError';
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
}

export class SymbolNotFoundError extends TradingError {
  constructor(public symbol: string) {
    const message = `Symbol ${symbol} not found or not available for trading`;
    super(message, -1121, symbol);
    this.name = 'SymbolNotFoundError';
  }
}

export class RateLimitError extends TradingError {
  constructor(public retryAfter?: number) {
    super('Rate limit exceeded, please slow down', -1003, undefined);
    this.name = 'RateLimitError';
  }
}

export class InvalidOrderTypeError extends TradingError {
  constructor(public orderType: string, public symbol: string) {
    super(`Invalid order type ${orderType} for ${symbol}`, -1116, symbol);
    this.name = 'InvalidOrderTypeError';
  }
}

export class OrderRejectedError extends TradingError {
  constructor(message: string, public symbol: string, public reason?: string) {
    super(message, -2010, symbol, { reason });
    this.name = 'OrderRejectedError';
  }
}

export class PricePrecisionError extends TradingError {
  constructor(public symbol: string, public price: number, public tickSize: string) {
    super(`Price ${price} doesn't meet tick size ${tickSize} for ${symbol}`, -1111, symbol);
    this.name = 'PricePrecisionError';
  }
}

export class QuantityPrecisionError extends TradingError {
  constructor(public symbol: string, public quantity: number, public stepSize: string) {
    super(`Quantity ${quantity} doesn't meet step size ${stepSize} for ${symbol}`, -1013, symbol);
    this.name = 'QuantityPrecisionError';
  }
}

export class ReduceOnlyError extends TradingError {
  constructor(public symbol: string) {
    super(`ReduceOnly order rejected for ${symbol}`, -2022, symbol);
    this.name = 'ReduceOnlyError';
  }
}

export class OrderWouldTriggerError extends TradingError {
  constructor(public symbol: string, public side: string, public price?: number) {
    super(`Order would immediately trigger for ${symbol}`, -2021, symbol, { side, price });
    this.name = 'OrderWouldTriggerError';
  }
}

export function parseExchangeError(error: any, context?: { symbol?: string; quantity?: number; price?: number; leverage?: number }): TradingError {
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
      // Try to get actual tick size from symbolPrecision
      let tickSize = 'UNKNOWN';
      if (context?.symbol) {
        try {
          const { symbolPrecision } = require('../utils/symbolPrecision');
          if (symbolPrecision.hasSymbol(context.symbol)) {
            const limits = symbolPrecision.getPriceLimits(context.symbol);
            tickSize = limits.tickSize?.toString() || 'UNKNOWN';
          }
        } catch (e) {
          // Fallback to UNKNOWN if symbolPrecision not available
        }
      }
      return new PricePrecisionError(context?.symbol || 'UNKNOWN', context?.price || 0, tickSize);

    case -1013:
      // INVALID_MESSAGE - Often quantity precision
      if (msg.includes('quantity')) {
        let stepSize = 'UNKNOWN';
        if (context?.symbol) {
          try {
            const { symbolPrecision } = require('../utils/symbolPrecision');
            if (symbolPrecision.hasSymbol(context.symbol)) {
              const limits = symbolPrecision.getQuantityLimits(context.symbol);
              stepSize = limits.stepSize?.toString() || 'UNKNOWN';
            }
          } catch (e) {
            // Fallback to UNKNOWN if symbolPrecision not available
          }
        }
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

    default:
      // Unknown error code
      return new TradingError(msg || 'Unknown trading error', code, context?.symbol);
  }
}