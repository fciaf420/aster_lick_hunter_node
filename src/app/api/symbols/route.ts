import { NextResponse } from 'next/server';
import { createPublicExchangeAdapter } from '@/lib/exchange/registry';
import { configLoader } from '@/lib/config/configLoader';

interface ExchangeSymbol {
  symbol: string;
  status: string;
}

export async function GET() {
  try {
    // Fetch exchange info from the trading venue
    const exchangeInfo = await createPublicExchangeAdapter(configLoader.getConfig()).getExchangeInfo({ bypassRateLimit: true });

    const symbols: ExchangeSymbol[] = [];

    for (const symbolInfo of exchangeInfo.symbols) {
      // Only include active USDT perpetual contracts
      if (symbolInfo.status === 'TRADING' &&
          symbolInfo.symbol.endsWith('USDT') &&
          symbolInfo.contractType === 'PERPETUAL') {

        symbols.push({
          symbol: symbolInfo.symbol,
          status: symbolInfo.status
        });
      }
    }

    // Sort alphabetically
    symbols.sort((a, b) => a.symbol.localeCompare(b.symbol));

    return NextResponse.json({ symbols });
  } catch (error) {
    console.error('Failed to fetch exchange symbols:', error);
    return NextResponse.json(
      { error: 'Failed to fetch exchange symbols' },
      { status: 500 }
    );
  }
}