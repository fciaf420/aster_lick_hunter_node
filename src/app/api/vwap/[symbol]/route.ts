import { NextResponse } from 'next/server';
import { vwapService } from '@/lib/services/vwapService';
import { createExchangeAdapter } from '@/lib/exchange/registry';
import { loadConfig } from '@/lib/bot/config';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ symbol: string }> }
) {
  try {
    const { symbol } = await params;

    // Read config to get VWAP settings for this symbol
    const config = await loadConfig();
    const exchange = createExchangeAdapter(config);
    const symbolConfig = config.symbols[symbol];

    if (!symbolConfig) {
      return NextResponse.json(
        { error: 'Symbol not configured' },
        { status: 404 }
      );
    }

    // Get current mark price
    const markPriceData = await exchange.getMarkPrice(symbol);
    const currentPrice = parseFloat(
      Array.isArray(markPriceData) ? markPriceData[0].markPrice : markPriceData.markPrice
    );

    // Get VWAP settings with defaults
    const timeframe = symbolConfig.vwapTimeframe || '1m';
    const lookback = symbolConfig.vwapLookback || 100;

    // Calculate VWAP
    const vwap = await vwapService.getVWAP(symbol, timeframe, lookback, exchange);
    const position = currentPrice > vwap ? 'above' : 'below';

    return NextResponse.json({
      value: vwap,
      position,
      currentPrice,
      timeframe,
      lookback,
      timestamp: Date.now()
    });

  } catch (error: any) {
    console.error('Failed to fetch VWAP data:', error);

    return NextResponse.json(
      {
        error: 'Failed to fetch VWAP data',
        details: error.message
      },
      { status: 500 }
    );
  }
}