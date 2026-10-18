import { Kline } from '../types';
import type { ExchangeAdapter } from '../exchange/types';
import { createPublicExchangeAdapter } from '../exchange/registry';

interface VWAPCache {
  value: number;
  timestamp: number;
  pricePosition: 'above' | 'below';
}

class VWAPService {
  private cache: Map<string, VWAPCache> = new Map();
  private readonly CACHE_TTL = 60000; // 60 seconds cache TTL (increased since we have WebSocket now)
  private defaultExchange: ExchangeAdapter | null = null;

  // Klines come from the given exchange, else the default venue's public market data
  private getExchange(exchange?: ExchangeAdapter): ExchangeAdapter {
    if (exchange) return exchange;
    this.defaultExchange ??= createPublicExchangeAdapter();
    return this.defaultExchange;
  }

  /**
   * Calculate VWAP from kline data
   * VWAP = Σ(Typical Price × Volume) / Σ(Volume)
   * Typical Price = (High + Low + Close) / 3
   */
  public calculateVWAP(klines: Kline[]): number {
    if (!klines || klines.length === 0) {
      throw new Error('No kline data available for VWAP calculation');
    }

    let sumPriceVolume = 0;
    let sumVolume = 0;

    for (const kline of klines) {
      const high = parseFloat(kline.high);
      const low = parseFloat(kline.low);
      const close = parseFloat(kline.close);
      const volume = parseFloat(kline.volume);

      // Calculate typical price (HLC/3)
      const typicalPrice = (high + low + close) / 3;

      // Accumulate price * volume and volume
      sumPriceVolume += typicalPrice * volume;
      sumVolume += volume;
    }

    if (sumVolume === 0) {
      throw new Error('Total volume is zero, cannot calculate VWAP');
    }

    return sumPriceVolume / sumVolume;
  }

  /**
   * Get VWAP for a symbol with caching
   */
  public async getVWAP(
    symbol: string,
    timeframe: string = '1m',
    lookback: number = 100,
    exchange?: ExchangeAdapter
  ): Promise<number> {
    const cacheKey = `${symbol}_${timeframe}_${lookback}`;
    const cached = this.cache.get(cacheKey);

    // Return cached value if still valid
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.value;
    }

    try {
      // Fetch klines from the exchange
      const klines = await this.getExchange(exchange).getKlines(symbol, timeframe, lookback);

      // Calculate VWAP
      const vwap = this.calculateVWAP(klines);

      // Cache the result
      const currentPrice = parseFloat(klines[klines.length - 1].close);
      this.cache.set(cacheKey, {
        value: vwap,
        timestamp: Date.now(),
        pricePosition: currentPrice > vwap ? 'above' : 'below'
      });

      return vwap;
    } catch (error) {
      console.error(`VWAP calculation error for ${symbol}:`, error);
      throw error;
    }
  }

  /**
   * Get current price position relative to VWAP
   */
  public async getVWAPPosition(
    symbol: string,
    currentPrice: number,
    timeframe: string = '1m',
    lookback: number = 100,
    exchange?: ExchangeAdapter
  ): Promise<'above' | 'below'> {
    const vwap = await this.getVWAP(symbol, timeframe, lookback, exchange);
    return currentPrice > vwap ? 'above' : 'below';
  }

  /**
   * Check if trade is allowed based on VWAP filter
   * Returns true if trade is allowed, false if blocked by VWAP
   */
  public async checkVWAPFilter(
    symbol: string,
    side: 'BUY' | 'SELL',
    currentPrice: number,
    timeframe: string = '1m',
    lookback: number = 100,
    exchange?: ExchangeAdapter
  ): Promise<{ allowed: boolean; vwap: number; reason?: string }> {
    try {
      const vwap = await this.getVWAP(symbol, timeframe, lookback, exchange);
      const position = currentPrice > vwap ? 'above' : 'below';

      // For BUY orders (longs), we want price to be below VWAP
      // For SELL orders (shorts), we want price to be above VWAP
      if (side === 'BUY' && position === 'above') {
        return {
          allowed: false,
          vwap,
          reason: `Price ($${currentPrice.toFixed(2)}) is above VWAP ($${vwap.toFixed(2)}) - blocking long entry`
        };
      }

      if (side === 'SELL' && position === 'below') {
        return {
          allowed: false,
          vwap,
          reason: `Price ($${currentPrice.toFixed(2)}) is below VWAP ($${vwap.toFixed(2)}) - blocking short entry`
        };
      }

      return {
        allowed: true,
        vwap,
        reason: `Price is ${position} VWAP - ${side} entry allowed`
      };
    } catch (error) {
      // On error, allow trade but log warning
      console.warn(`VWAP filter check failed for ${symbol}, allowing trade:`, error);
      return {
        allowed: true,
        vwap: 0,
        reason: 'VWAP check failed - allowing trade with warning'
      };
    }
  }

  /**
   * Clear cache for a specific symbol or all symbols
   */
  public clearCache(symbol?: string): void {
    if (symbol) {
      // Clear cache for specific symbol
      const keysToDelete: string[] = [];
      for (const key of this.cache.keys()) {
        if (key.startsWith(symbol)) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(key => this.cache.delete(key));
    } else {
      // Clear entire cache
      this.cache.clear();
    }
  }

  /**
   * Get cache statistics for monitoring
   */
  public getCacheStats(): { size: number; symbols: string[] } {
    const symbols = new Set<string>();
    for (const key of this.cache.keys()) {
      const symbol = key.split('_')[0];
      symbols.add(symbol);
    }
    return {
      size: this.cache.size,
      symbols: Array.from(symbols)
    };
  }
}

// Export singleton instance
export const vwapService = new VWAPService();