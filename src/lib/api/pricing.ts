import { getOrderBook, getBookTicker, getExchangeInfo } from './market';

interface OrderBookEntry {
  price: string;
  quantity: string;
}

interface OrderBookData {
  lastUpdateId: number;
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
}

interface SymbolFilter {
  filterType: string;
  minPrice?: string;
  maxPrice?: string;
  tickSize?: string;
  minQty?: string;
  maxQty?: string;
  stepSize?: string;
  notional?: string;
}

interface SymbolInfo {
  symbol: string;
  filters: SymbolFilter[];
  pricePrecision: number;
  quantityPrecision: number;
}

// Cache for exchange info to avoid repeated API calls
let exchangeInfoCache: any = null;
let exchangeInfoCacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Get symbol filters from exchange info
export async function getSymbolFilters(symbol: string): Promise<SymbolInfo | null> {
  const now = Date.now();

  // Use cache if available and not expired
  if (exchangeInfoCache && (now - exchangeInfoCacheTime) < CACHE_DURATION) {
    const symbolInfo = exchangeInfoCache.symbols.find((s: any) => s.symbol === symbol);
    return symbolInfo || null;
  }

  try {
    exchangeInfoCache = await getExchangeInfo();
    exchangeInfoCacheTime = now;

    const symbolInfo = exchangeInfoCache.symbols.find((s: any) => s.symbol === symbol);
    return symbolInfo || null;
  } catch (error) {
    console.error('Error fetching exchange info:', error);
    return null;
  }
}

// Round price to valid tick size
export function roundToTickSize(price: number, tickSize: string): number {
  const tick = parseFloat(tickSize);
  if (tick === 0) return price;

  // Count decimal places in tickSize to determine precision
  const decimalPlaces = (tickSize.split('.')[1] || '').replace(/0+$/, '').length;

  // Round to nearest tick and use toFixed to avoid floating point errors
  const numTicks = Math.round(price / tick);
  const aligned = (numTicks * tick).toFixed(decimalPlaces);
  return parseFloat(aligned);
}

// Round quantity to valid step size
export function roundToStepSize(quantity: number, stepSize: string): number {
  const step = parseFloat(stepSize);
  if (step === 0) return quantity;

  // Count decimal places in stepSize to determine precision
  const decimalPlaces = (stepSize.split('.')[1] || '').replace(/0+$/, '').length;

  // Round to nearest step and use toFixed to avoid floating point errors
  const numSteps = Math.round(quantity / step);
  const aligned = (numSteps * step).toFixed(decimalPlaces);
  return parseFloat(aligned);
}

// Calculate optimal limit order price based on order book
export async function calculateOptimalPrice(
  symbol: string,
  side: 'BUY' | 'SELL',
  priceOffsetBps: number = 1, // 1 basis point default offset
  usePostOnly: boolean = false
): Promise<number | null> {
  try {
    // Get current best bid/ask
    const bookTicker = await getBookTicker(symbol);
    const bestBid = parseFloat(bookTicker.bidPrice);
    const bestAsk = parseFloat(bookTicker.askPrice);

    // Get symbol filters for price precision
    const symbolInfo = await getSymbolFilters(symbol);
    const tickSize = symbolInfo?.filters.find(f => f.filterType === 'PRICE_FILTER')?.tickSize || '0.01';

    let targetPrice: number;

    if (side === 'BUY') {
      if (usePostOnly) {
        // For post-only, stay below best ask to avoid crossing
        targetPrice = bestBid + parseFloat(tickSize);
      } else {
        // Aggressive but still maker: place just above best bid
        const offset = bestBid * (priceOffsetBps / 10000);
        targetPrice = bestBid + Math.max(offset, parseFloat(tickSize));
      }
    } else { // SELL
      if (usePostOnly) {
        // For post-only, stay above best bid to avoid crossing
        targetPrice = bestAsk - parseFloat(tickSize);
      } else {
        // Aggressive but still maker: place just below best ask
        const offset = bestAsk * (priceOffsetBps / 10000);
        targetPrice = bestAsk - Math.max(offset, parseFloat(tickSize));
      }
    }

    // Round to valid tick size
    targetPrice = roundToTickSize(targetPrice, tickSize);

    // Validate price is within symbol limits
    const priceFilter = symbolInfo?.filters.find(f => f.filterType === 'PRICE_FILTER');
    if (priceFilter) {
      const minPrice = parseFloat(priceFilter.minPrice || '0');
      const maxPrice = parseFloat(priceFilter.maxPrice || '999999999');

      if (targetPrice < minPrice) targetPrice = minPrice;
      if (targetPrice > maxPrice) targetPrice = maxPrice;
    }

    return targetPrice;

  } catch (error) {
    console.error('Error calculating optimal price:', error);
    return null;
  }
}

// Validate order parameters against symbol filters
export async function validateOrderParams(
  symbol: string,
  side: 'BUY' | 'SELL',
  price: number,
  quantity: number
): Promise<{ valid: boolean; adjustedPrice?: number; adjustedQuantity?: number; error?: string }> {
  try {
    const symbolInfo = await getSymbolFilters(symbol);
    if (!symbolInfo) {
      return { valid: false, error: 'Symbol info not found' };
    }

    let adjustedPrice = price;
    let adjustedQuantity = quantity;

    // Validate and adjust price
    const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
    if (priceFilter) {
      const minPrice = parseFloat(priceFilter.minPrice || '0');
      const maxPrice = parseFloat(priceFilter.maxPrice || '999999999');
      const tickSize = priceFilter.tickSize || '0.01';

      adjustedPrice = roundToTickSize(adjustedPrice, tickSize);

      if (adjustedPrice < minPrice) {
        return { valid: false, error: `Price ${adjustedPrice} below minimum ${minPrice}` };
      }
      if (adjustedPrice > maxPrice) {
        return { valid: false, error: `Price ${adjustedPrice} above maximum ${maxPrice}` };
      }
    }

    // Validate and adjust quantity
    const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
    if (lotSizeFilter) {
      const minQty = parseFloat(lotSizeFilter.minQty || '0');
      const maxQty = parseFloat(lotSizeFilter.maxQty || '999999999');
      const stepSize = lotSizeFilter.stepSize || '0.001';

      adjustedQuantity = roundToStepSize(adjustedQuantity, stepSize);

      if (adjustedQuantity < minQty) {
        return { valid: false, error: `Quantity ${adjustedQuantity} below minimum ${minQty}` };
      }
      if (adjustedQuantity > maxQty) {
        return { valid: false, error: `Quantity ${adjustedQuantity} above maximum ${maxQty}` };
      }
    }

    // Validate notional value
    const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');
    if (minNotionalFilter) {
      const minNotional = parseFloat(minNotionalFilter.notional || '0');
      const notionalValue = adjustedPrice * adjustedQuantity;

      if (notionalValue < minNotional) {
        return {
          valid: false,
          error: `Notional value ${notionalValue} below minimum ${minNotional}`
        };
      }
    }

    return {
      valid: true,
      adjustedPrice,
      adjustedQuantity
    };

  } catch (error) {
    console.error('Error validating order params:', error);
    return { valid: false, error: 'Validation error: ' + (error as Error).message };
  }
}

// Get order book depth analysis for better entry timing
export async function analyzeOrderBookDepth(
  symbol: string,
  side: 'BUY' | 'SELL',
  targetNotional: number = 10000 // Target order size in USDT
): Promise<{
  avgPrice: number;
  priceImpact: number;
  liquidityOk: boolean;
}> {
  try {
    const orderBook: OrderBookData = await getOrderBook(symbol, 20); // Get deeper book
    const orders = side === 'BUY' ? orderBook.asks : orderBook.bids;

    let cumulativeNotional = 0;
    let weightedPriceSum = 0;
    let totalQuantity = 0;

    const firstPrice = parseFloat(orders[0]?.price || '0');

    for (const order of orders) {
      const price = parseFloat(order.price);
      const quantity = parseFloat(order.quantity);
      const notional = price * quantity;

      if (cumulativeNotional + notional >= targetNotional) {
        // Partial fill of this level
        const remainingNotional = targetNotional - cumulativeNotional;
        const remainingQuantity = remainingNotional / price;

        weightedPriceSum += price * remainingQuantity;
        totalQuantity += remainingQuantity;
        break;
      }

      weightedPriceSum += price * quantity;
      totalQuantity += quantity;
      cumulativeNotional += notional;
    }

    const avgPrice = totalQuantity > 0 ? weightedPriceSum / totalQuantity : firstPrice;
    const priceImpact = Math.abs((avgPrice - firstPrice) / firstPrice) * 100;
    const liquidityOk = cumulativeNotional >= targetNotional * 0.8; // At least 80% can be filled

    return {
      avgPrice,
      priceImpact,
      liquidityOk
    };

  } catch (error) {
    console.error('Error analyzing order book depth:', error);
    return {
      avgPrice: 0,
      priceImpact: 100,
      liquidityOk: false
    };
  }
}