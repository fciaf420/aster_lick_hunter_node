// Symbol precision utilities for formatting prices and quantities according to exchange rules

export interface SymbolFilter {
  symbol: string;
  pricePrecision: number;
  quantityPrecision: number;
  tickSize: string;
  stepSize: string;
  minQty?: number;
  maxQty?: number;
  marketStepSize?: string;
  marketMinQty?: number;
  marketMaxQty?: number;
  minNotional?: number;
}

export class SymbolPrecisionManager {
  private symbolFilters: Map<string, SymbolFilter> = new Map();

  // Parse exchange info and store symbol filters
  public parseExchangeInfo(exchangeInfo: any): void {
    if (!exchangeInfo?.symbols) return;

    for (const symbolInfo of exchangeInfo.symbols) {
      const symbol = symbolInfo.symbol;
      if (!symbol) continue;

      const priceFilter = symbolInfo.filters?.find((f: any) => f.filterType === 'PRICE_FILTER');
      const lotSizeFilter = symbolInfo.filters?.find((f: any) => f.filterType === 'LOT_SIZE');
      const marketLotSizeFilter = symbolInfo.filters?.find((f: any) => f.filterType === 'MARKET_LOT_SIZE');
      const minNotionalFilter = symbolInfo.filters?.find((f: any) => f.filterType === 'MIN_NOTIONAL');

      if (!priceFilter || (!lotSizeFilter && !marketLotSizeFilter)) {
        continue;
      }

      const stepSource = lotSizeFilter ?? marketLotSizeFilter;
      const pricePrecision = this.getPrecisionFromString(priceFilter.tickSize);
      const quantityPrecision = this.getPrecisionFromString(stepSource.stepSize ?? '1');

      const filter: SymbolFilter = {
        symbol,
        pricePrecision,
        quantityPrecision,
        tickSize: priceFilter.tickSize,
        stepSize: lotSizeFilter?.stepSize ?? marketLotSizeFilter?.stepSize ?? '1',
      };

      if (lotSizeFilter) {
        const minQty = parseFloat(lotSizeFilter.minQty ?? '0');
        const maxQty = parseFloat(lotSizeFilter.maxQty ?? '0');
        if (minQty > 0) filter.minQty = minQty;
        if (maxQty > 0) filter.maxQty = maxQty;
      }

      if (marketLotSizeFilter) {
        const marketMinQty = parseFloat(marketLotSizeFilter.minQty ?? '0');
        const marketMaxQty = parseFloat(marketLotSizeFilter.maxQty ?? '0');
        if (marketLotSizeFilter.stepSize) filter.marketStepSize = marketLotSizeFilter.stepSize;
        if (marketMinQty > 0) filter.marketMinQty = marketMinQty;
        if (marketMaxQty > 0) filter.marketMaxQty = marketMaxQty;
      }

      if (minNotionalFilter) {
        const minNotional = parseFloat(minNotionalFilter.notional ?? '0');
        if (minNotional > 0) filter.minNotional = minNotional;
      }

      this.symbolFilters.set(symbol, filter);
    }

    console.log(`SymbolPrecisionManager: Loaded precision for ${this.symbolFilters.size} symbols`);
  }

  // Get decimal places from a string like '0.00100000'
  private getPrecisionFromString(value: string): number {
    if (!value || value === '0') return 0;

    const decimalIndex = value.indexOf('.');
    if (decimalIndex === -1) return 0;

    let precision = 0;

    for (let i = value.length - 1; i > decimalIndex; i--) {
      if (value[i] !== '0') {
        precision = i - decimalIndex;
        break;
      }
    }

    if (precision === 0) {
      for (let i = decimalIndex + 1; i < value.length; i++) {
        if (value[i] !== '0') {
          precision = i - decimalIndex;
          break;
        }
      }
    }

    return precision;
  }

  // Format price according to symbol's tick size
  public formatPrice(symbol: string, price: number): number {
    const filter = this.symbolFilters.get(symbol);
    if (!filter) {
      console.warn(`SymbolPrecisionManager: No precision info for ${symbol}, using raw price`);
      return price;
    }

    const multiplier = Math.pow(10, filter.pricePrecision);
    const rounded = Math.round(price * multiplier) / multiplier;

    const tickSize = parseFloat(filter.tickSize);
    if (tickSize > 0) {
      const aligned = Math.round(rounded / tickSize) * tickSize;
      return parseFloat(aligned.toFixed(filter.pricePrecision));
    }

    return parseFloat(rounded.toFixed(filter.pricePrecision));
  }

  // Format quantity according to symbol's step size (nearest valid increment)
  public formatQuantity(symbol: string, quantity: number): number {
    const filter = this.symbolFilters.get(symbol);
    if (!filter) {
      console.warn(`SymbolPrecisionManager: No precision info for ${symbol}, using raw quantity`);
      return quantity;
    }

    const multiplier = Math.pow(10, filter.quantityPrecision);
    const rounded = Math.round(quantity * multiplier) / multiplier;

    const stepSize = parseFloat(filter.stepSize);
    if (stepSize > 0) {
      const aligned = Math.round(rounded / stepSize) * stepSize;
      return parseFloat(aligned.toFixed(filter.quantityPrecision));
    }

    return parseFloat(rounded.toFixed(filter.quantityPrecision));
  }

  // Floor quantity to the next valid increment (never rounds up)
  public floorQuantity(
    symbol: string,
    quantity: number,
    orderType: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET' = 'LIMIT'
  ): number {
    const filter = this.symbolFilters.get(symbol);
    if (!filter) {
      console.warn(`SymbolPrecisionManager: No precision info for ${symbol}, using raw quantity`);
      return quantity;
    }

    const useMarket = orderType.includes('MARKET');
    const stepString = useMarket ? filter.marketStepSize ?? filter.stepSize : filter.stepSize;
    const stepSize = parseFloat(stepString);
    const precision = filter.quantityPrecision;

    if (!stepSize || stepSize <= 0) {
      const multiplier = Math.pow(10, precision);
      const floored = Math.floor(quantity * multiplier) / multiplier;
      return parseFloat(floored.toFixed(precision));
    }

    const units = Math.floor(quantity / stepSize);
    const value = units * stepSize;
    return parseFloat(value.toFixed(precision));
  }

  public getPriceLimits(symbol: string): {
    tickSize: number;
    pricePrecision: number;
  } {
    const filter = this.symbolFilters.get(symbol);
    if (!filter) {
      return {
        tickSize: 0,
        pricePrecision: 0,
      };
    }

    return {
      tickSize: parseFloat(filter.tickSize) || 0,
      pricePrecision: filter.pricePrecision,
    };
  }

  public getQuantityLimits(
    symbol: string,
    orderType: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET'
  ): {
    stepSize: number;
    minQty?: number;
    maxQty?: number;
    minNotional?: number;
  } {
    const filter = this.symbolFilters.get(symbol);
    if (!filter) {
      return {
        stepSize: 0,
        minQty: undefined,
        maxQty: undefined,
        minNotional: undefined,
      };
    }

    const useMarket = orderType.includes('MARKET');
    const stepSize = parseFloat(useMarket ? filter.marketStepSize ?? filter.stepSize : filter.stepSize) || 0;
    const minQty = useMarket ? filter.marketMinQty ?? filter.minQty : filter.minQty;
    const maxQty = useMarket ? filter.marketMaxQty ?? filter.maxQty : filter.maxQty;

    return {
      stepSize,
      minQty,
      maxQty,
      minNotional: filter.minNotional,
    };
  }

  public splitQuantity(
    symbol: string,
    totalQuantity: number,
    orderType: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET'
  ): number[] {
    const filter = this.symbolFilters.get(symbol);
    if (!filter) {
      console.warn(`SymbolPrecisionManager: No precision info for ${symbol}, returning raw quantity`);
      return totalQuantity > 0 ? [totalQuantity] : [];
    }

    if (totalQuantity <= 0) {
      return [];
    }

    const { stepSize, minQty, maxQty } = this.getQuantityLimits(symbol, orderType);
    const precision = filter.quantityPrecision;
    const step = stepSize > 0 ? stepSize : Math.pow(10, -precision);

    const toUnits = (qty: number) => Math.floor((qty + 1e-12) / step);
    const toQty = (units: number) => parseFloat((units * step).toFixed(precision));

    let unitsRemaining = toUnits(totalQuantity);
    if (unitsRemaining <= 0) {
      const min = minQty ?? step;
      if (totalQuantity < min) {
        throw new Error(`Quantity ${totalQuantity} is below minimum ${min} for ${symbol}`);
      }
      unitsRemaining = toUnits(min);
    }

    const minUnits = minQty ? Math.max(1, toUnits(minQty)) : 1;
    const maxUnits = maxQty ? Math.max(minUnits, toUnits(maxQty)) : Number.MAX_SAFE_INTEGER;

    if (!maxQty || unitsRemaining <= maxUnits) {
      const qty = toQty(unitsRemaining);
      return [qty];
    }

    const chunks: number[] = [];

    while (unitsRemaining > 0) {
      const chunkUnits = Math.min(unitsRemaining, maxUnits);

      if (chunkUnits < minUnits) {
        if (chunks.length === 0) {
          throw new Error(`Cannot create valid chunk for ${symbol}: requested ${totalQuantity} but minimum is ${minQty}`);
        }

        const remainderQty = toQty(unitsRemaining);
        const lastQty = chunks.pop()!;
        const combined = this.formatQuantity(symbol, lastQty + remainderQty);

        if (maxQty && combined > (maxQty + step / 2)) {
          throw new Error(`Unable to merge remainder ${remainderQty} into previous chunk for ${symbol}`);
        }

        chunks.push(combined);
        unitsRemaining = 0;
        break;
      }

      const chunkQty = toQty(chunkUnits);
      chunks.push(chunkQty);
      unitsRemaining -= chunkUnits;
    }

    return chunks;
  }

  // Get symbol filter
  public getSymbolFilter(symbol: string): SymbolFilter | undefined {
    return this.symbolFilters.get(symbol);
  }

  // Check if we have precision info for a symbol
  public hasSymbol(symbol: string): boolean {
    return this.symbolFilters.has(symbol);
  }
}

// Singleton instance
export const symbolPrecision = new SymbolPrecisionManager();
