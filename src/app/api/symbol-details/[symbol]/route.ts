import { NextResponse } from 'next/server';
import { createPublicExchangeAdapter } from '@/lib/exchange/registry';
import { configLoader } from '@/lib/config/configLoader';

interface SymbolDetails {
  symbol: string;
  currentPrice: number;
  minNotional: number;
  minQty: number;
  stepSize: number;
  tickSize: number;
  pricePrecision: number;
  quantityPrecision: number;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ symbol: string }> }
) {
  try {
    const { symbol } = await params;

    // Fetch both exchange info and current price in parallel
    const exchange = createPublicExchangeAdapter(configLoader.getConfig());
    const [exchangeInfo, ticker] = await Promise.all([
      exchange.getExchangeInfo({ bypassRateLimit: true }),
      exchange.getTickerPrice(symbol, { bypassRateLimit: true })
    ]);

    // Find the symbol info
    const symbolInfo = exchangeInfo.symbols.find(
      (s: any) => s.symbol === symbol
    );

    if (!symbolInfo) {
      return NextResponse.json(
        { error: 'Symbol not found' },
        { status: 404 }
      );
    }

    // Extract filters
    const minNotionalFilter = symbolInfo.filters?.find(
      (f: any) => f.filterType === 'MIN_NOTIONAL'
    );
    const lotSizeFilter = symbolInfo.filters?.find(
      (f: any) => f.filterType === 'LOT_SIZE'
    );
    const priceFilter = symbolInfo.filters?.find(
      (f: any) => f.filterType === 'PRICE_FILTER'
    );

    // Parse values
    const minNotional = minNotionalFilter?.notional ?
      parseFloat(minNotionalFilter.notional) : 10;
    const minQty = lotSizeFilter?.minQty ?
      parseFloat(lotSizeFilter.minQty) : 0.001;
    const stepSize = lotSizeFilter?.stepSize ?
      parseFloat(lotSizeFilter.stepSize) : 0.001;
    const tickSize = priceFilter?.tickSize ?
      parseFloat(priceFilter.tickSize) : 0.01;
    const currentPrice = parseFloat(ticker.price);

    const details: SymbolDetails = {
      symbol,
      currentPrice,
      minNotional,
      minQty,
      stepSize,
      tickSize,
      pricePrecision: symbolInfo.pricePrecision || 2,
      quantityPrecision: symbolInfo.quantityPrecision || 3
    };

    return NextResponse.json(details);
  } catch (error) {
    console.error('Failed to fetch symbol details:', error);
    return NextResponse.json(
      { error: 'Failed to fetch symbol details' },
      { status: 500 }
    );
  }
}