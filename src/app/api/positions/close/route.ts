import { NextRequest, NextResponse } from 'next/server';
import { loadConfig } from '@/lib/bot/config';
import { placeOrder } from '@/lib/api/orders';
import { getPositions } from '@/lib/api/orders';

// Simple validation schema
interface ClosePositionRequest {
  symbol: string;
  side: 'LONG' | 'SHORT';
}

function validateClosePositionRequest(body: any): ClosePositionRequest {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body is required');
  }

  const { symbol, side } = body;

  if (!symbol || typeof symbol !== 'string') {
    throw new Error('Symbol is required and must be a string');
  }

  if (!side || !['LONG', 'SHORT'].includes(side)) {
    throw new Error('Side must be either "LONG" or "SHORT"');
  }

  return { symbol: symbol.toUpperCase(), side };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { symbol, side } = validateClosePositionRequest(body);

    console.log(`[Close Position API] Request to close ${symbol} ${side} position`);

    const config = await loadConfig();

    // Check if API credentials are configured
    if (!config.api.apiKey || !config.api.secretKey) {
      return NextResponse.json(
        { error: 'API credentials not configured' },
        { status: 400 }
      );
    }

    // Check if symbol is configured (optional validation)
    if (!config.symbols[symbol]) {
      console.warn(`[Close Position API] Symbol ${symbol} not in config, but allowing close`);
    }

    // Get current positions to find the target position
    const allPositions = await getPositions(config.api);
    const targetPosition = allPositions.find(pos => {
      const posAmt = parseFloat(pos.positionAmt || '0');
      const positionSide = posAmt > 0 ? 'LONG' : 'SHORT';
      return pos.symbol === symbol && positionSide === side && Math.abs(posAmt) > 0;
    });

    if (!targetPosition) {
      return NextResponse.json(
        {
          error: 'Position not found',
          details: `No ${side} position found for ${symbol}`
        },
        { status: 404 }
      );
    }

    const positionAmt = parseFloat(targetPosition.positionAmt || '0');
    const quantity = Math.abs(positionAmt);

    console.log(`[Close Position API] Found position: ${symbol} ${side}, quantity: ${quantity}`);

    // Place a market order to close the position
    // For LONG positions, we SELL to close
    // For SHORT positions, we BUY to close
    const orderSide = side === 'LONG' ? 'SELL' : 'BUY';

    // Use MARKET order with reduceOnly for immediate execution
    // This avoids the "Order would immediately trigger" error from TAKE_PROFIT_MARKET

    // In Hedge Mode, we need to specify positionSide
    const positionSide = side; // 'LONG' or 'SHORT' from our position detection

    console.log(`[Close Position API] Setting positionSide: ${positionSide} for Hedge Mode`);
    console.log(`[Close Position API] Using MARKET order: ${orderSide} quantity: ${quantity} for immediate execution`);

    const closeOrder = await placeOrder({
      symbol,
      side: orderSide,
      type: 'MARKET',
      quantity,
      positionSide,  // Required for Hedge Mode
    }, config.api);

    console.log(`[Close Position API] Close order placed:`, closeOrder);

    return NextResponse.json({
      success: true,
      message: `Position ${symbol} ${side} closed immediately (MARKET order)`,
      symbol,
      side,
      orderId: closeOrder.orderId,
      orderType: 'MARKET',
      quantity,
      positionSide,
      originalQuantity: quantity,
      timestamp: new Date().toISOString()
    });

  } catch (error: any) {
    console.error('[Close Position API] Error:', error);

    // Handle validation errors
    if (error instanceof Error && error.message.includes('required')) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    // Handle API errors from exchange
    if (error.response?.data) {
      const apiError = error.response.data;
      return NextResponse.json(
        {
          error: 'Exchange API error',
          details: apiError.msg || apiError.message || 'Unknown API error',
          code: apiError.code
        },
        { status: 400 }
      );
    }

    // Handle other errors
    return NextResponse.json(
      {
        error: 'Failed to close position',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}