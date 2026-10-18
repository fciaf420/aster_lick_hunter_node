import { NextResponse } from 'next/server';
import { createExchangeAdapter } from '@/lib/exchange/registry';
import { loadConfig } from '@/lib/bot/config';

interface SymbolPrecisionInfo {
  symbol: string;
  pricePrecision: number;
  quantityPrecision: number;
  tickSize: string;
  stepSize: string;
}

// Cache symbol info for 5 minutes
let symbolInfoCache: Map<string, SymbolPrecisionInfo> | null = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Get decimal places from a string like "0.00100000"
function getPrecisionFromString(value: string): number {
  if (!value || value === '0') return 0;

  const decimal = value.indexOf('.');
  if (decimal === -1) return 0;

  // Find the position of the last non-zero digit
  let precision = 0;
  for (let i = value.length - 1; i > decimal; i--) {
    if (value[i] !== '0') {
      precision = i - decimal;
      break;
    }
  }

  // If all decimals are zero, count until first 1
  if (precision === 0 && decimal !== -1) {
    for (let i = decimal + 1; i < value.length; i++) {
      if (value[i] !== '0') {
        precision = i - decimal;
        break;
      }
    }
  }

  return precision;
}

export async function GET() {
  try {
    // Check cache
    if (symbolInfoCache && Date.now() - cacheTime < CACHE_TTL) {
      return NextResponse.json(Object.fromEntries(symbolInfoCache));
    }

    // Load config to pick the trading venue
    const config = await loadConfig();

    // Fetch exchange info
    const exchangeInfo = await createExchangeAdapter(config).getExchangeInfo();

    // Parse symbol precision info
    const symbolInfo = new Map<string, SymbolPrecisionInfo>();

    if (exchangeInfo.symbols) {
      for (const symbolData of exchangeInfo.symbols) {
        const symbol = symbolData.symbol;

        // Find PRICE_FILTER and LOT_SIZE filters
        const priceFilter = symbolData.filters?.find((f: any) => f.filterType === 'PRICE_FILTER');
        const lotSizeFilter = symbolData.filters?.find((f: any) => f.filterType === 'LOT_SIZE');

        if (priceFilter && lotSizeFilter) {
          // Calculate precision from tick size and step size
          const pricePrecision = getPrecisionFromString(priceFilter.tickSize);
          const quantityPrecision = getPrecisionFromString(lotSizeFilter.stepSize);

          symbolInfo.set(symbol, {
            symbol,
            pricePrecision,
            quantityPrecision,
            tickSize: priceFilter.tickSize,
            stepSize: lotSizeFilter.stepSize,
          });
        }
      }
    }

    // Update cache
    symbolInfoCache = symbolInfo;
    cacheTime = Date.now();

    return NextResponse.json(Object.fromEntries(symbolInfo));
  } catch (error: any) {
    console.error('Symbol info API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch symbol info' },
      { status: 500 }
    );
  }
}