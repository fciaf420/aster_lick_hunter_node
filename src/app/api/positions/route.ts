import { NextRequest, NextResponse } from 'next/server';
import { createExchangeAdapter } from '@/lib/exchange/registry';
import { isLighterReadOnlyError } from '@/lib/exchange/lighter/runtime';
import { loadConfig } from '@/lib/bot/config';
import { withAuth } from '@/lib/auth/with-auth';

// Simple in-memory cache
interface CacheEntry {
  data: any;
  timestamp: number;
}

const cache: Map<string, CacheEntry> = new Map();
const CACHE_TTL = 5000; // 5 seconds

export const GET = withAuth(async (request: NextRequest, _user) => {
  const cacheKey = 'positions';

  // Check if force refresh is requested
  const searchParams = request.nextUrl.searchParams;
  const forceRefresh = searchParams.get('force') === 'true';

  // Check cache first (skip if force refresh)
  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log('[Positions API] Returning cached data');
      return NextResponse.json(cached.data);
    }
  }

  try {
    const config = await loadConfig();
    const exchange = createExchangeAdapter(config);

    // If no API key is configured, return empty positions
    if (!exchange.hasCredentials()) {
      return NextResponse.json([]);
    }

    // Get positions and open orders from exchange. Lighter open orders need an auth token, which only the
    // bot process can sign: there the SL/TP flags are left unknown instead of failing the whole list.
    const [positions, openOrders] = await Promise.all([
      exchange.getPositions(),
      exchange.getOpenOrders().catch((error: unknown) => {
        if (isLighterReadOnlyError(error)) return null;
        throw error;
      })
    ]);

    // Filter out positions with zero amount and format for UI
    const activePositions = positions
      .filter(pos => Math.abs(parseFloat(pos.positionAmt || '0')) > 0)
      .map(pos => {
        const positionAmt = parseFloat(pos.positionAmt || '0');
        const entryPrice = parseFloat(pos.entryPrice || '0');
        const markPrice = parseFloat(pos.markPrice || '0');
        const unRealizedProfit = parseFloat(pos.unRealizedProfit || '0');
        const leverage = parseInt(pos.leverage || '1');
        const quantity = Math.abs(positionAmt);
        const notionalValue = quantity * entryPrice;
        const currentNotionalValue = quantity * markPrice;
        const side = positionAmt > 0 ? 'LONG' : 'SHORT';

        // Check for active SL/TP orders for this position (undefined when open orders are unavailable)
        const hasStopLoss = openOrders?.some(order =>
          order.symbol === pos.symbol &&
          (order.type === 'STOP_MARKET' || order.type === 'STOP') &&
          order.reduceOnly === true &&
          ((side === 'LONG' && order.side === 'SELL') || (side === 'SHORT' && order.side === 'BUY'))
        );

        const hasTakeProfit = openOrders?.some(order =>
          order.symbol === pos.symbol &&
          (order.type === 'TAKE_PROFIT_MARKET' || order.type === 'TAKE_PROFIT' ||
           (order.type === 'LIMIT' && order.reduceOnly === true)) &&
          ((side === 'LONG' && order.side === 'SELL') || (side === 'SHORT' && order.side === 'BUY'))
        );

        return {
          symbol: pos.symbol,
          side,
          quantity,
          entryPrice,
          markPrice,
          pnl: unRealizedProfit,
          pnlPercent: notionalValue > 0 ? (unRealizedProfit / notionalValue) * 100 : 0,
          margin: currentNotionalValue / leverage,
          leverage,
          liquidationPrice: pos.liquidationPrice ? parseFloat(pos.liquidationPrice) : undefined,
          hasStopLoss,
          hasTakeProfit,
        };
      });

    // Cache the successful response
    cache.set(cacheKey, {
      data: activePositions,
      timestamp: Date.now(),
    });

    return NextResponse.json(activePositions);
  } catch (error) {
    console.error('Error fetching positions:', error);
    return NextResponse.json(
      { error: 'Failed to fetch positions' },
      { status: 500 }
    );
  }
});