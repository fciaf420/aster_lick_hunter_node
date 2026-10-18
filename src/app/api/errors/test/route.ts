import { NextRequest, NextResponse } from 'next/server';
import { errorLogsDb } from '@/lib/db/errorLogsDb';
import { errorLogger } from '@/lib/services/errorLogger';
import { getLiquidationStreamUrl } from '@/lib/exchange/registry';

export async function POST(_request: NextRequest) {
  try {
    // Only allow in development or paper mode
    const isDev = process.env.NODE_ENV === 'development';

    if (!isDev) {
      return NextResponse.json(
        { error: 'Test errors can only be generated in development mode' },
        { status: 403 }
      );
    }

    console.log('Generating test errors for UI testing...');

    // Generate various types of test errors
    const testErrors = [
      {
        error: new Error('WebSocket connection failed: ECONNREFUSED'),
        type: 'websocket' as const,
        severity: 'high' as const,
        context: {
          component: 'Hunter',
          symbol: 'BTCUSDT',
          userAction: 'Connecting to liquidation stream',
          metadata: { url: getLiquidationStreamUrl('aster'), attemptCount: 3 }
        }
      },
      {
        error: new Error('API Rate limit exceeded (429)'),
        type: 'api' as const,
        severity: 'medium' as const,
        context: {
          component: 'PositionManager',
          userAction: 'Placing protective orders',
          metadata: { endpoint: '/fapi/v1/order', method: 'POST', statusCode: 429 }
        }
      },
      {
        error: new Error('Insufficient balance for trade'),
        type: 'trading' as const,
        severity: 'high' as const,
        context: {
          component: 'Hunter',
          symbol: 'ETHUSDT',
          userAction: 'Placing limit order',
          metadata: { required: 1000, available: 500, leverage: 10 }
        }
      },
      {
        error: new Error('Invalid API credentials'),
        type: 'config' as const,
        severity: 'critical' as const,
        context: {
          component: 'AsterBot',
          userAction: 'Initializing bot',
          metadata: { configFile: 'config.user.json' }
        }
      },
      {
        error: new Error('Order rejected: Price out of range'),
        type: 'trading' as const,
        severity: 'medium' as const,
        context: {
          component: 'Hunter',
          symbol: 'SOLUSDT',
          userAction: 'Placing stop loss order',
          metadata: { price: 150.25, minPrice: 140, maxPrice: 145 }
        }
      },
      {
        error: new Error('Database connection lost'),
        type: 'system' as const,
        severity: 'critical' as const,
        context: {
          component: 'Database',
          userAction: 'Storing liquidation event',
          metadata: { dbPath: './data/liquidations.db', errorCode: 'SQLITE_BUSY' }
        }
      },
      {
        error: new Error('WebSocket message parsing failed'),
        type: 'websocket' as const,
        severity: 'low' as const,
        context: {
          component: 'PositionManager',
          userAction: 'Processing user data stream',
          metadata: { messageType: 'ACCOUNT_UPDATE', parseError: 'Unexpected token' }
        }
      },
      {
        error: new Error('Notional value too small'),
        type: 'trading' as const,
        severity: 'medium' as const,
        context: {
          component: 'Hunter',
          symbol: 'BTCUSDT',
          userAction: 'Adjusting order size',
          metadata: { minNotional: 5, actualNotional: 3.5 }
        }
      },
      {
        error: new Error('Network timeout during order placement'),
        type: 'api' as const,
        severity: 'high' as const,
        context: {
          component: 'PositionManager',
          symbol: 'BNBUSDT',
          userAction: 'Placing take profit order',
          metadata: { timeout: 10000, endpoint: '/fapi/v1/order' }
        }
      },
      {
        error: new Error('Configuration validation failed: Invalid leverage'),
        type: 'config' as const,
        severity: 'high' as const,
        context: {
          component: 'ConfigManager',
          userAction: 'Reloading configuration',
          metadata: { symbol: 'ADAUSDT', invalidValue: 150, maxAllowed: 125 }
        }
      },
      {
        error: new Error('Memory usage exceeded threshold'),
        type: 'system' as const,
        severity: 'medium' as const,
        context: {
          component: 'System',
          userAction: 'Monitoring system health',
          metadata: { usedMemory: '3.5GB', threshold: '3GB', uptime: 86400 }
        }
      },
      {
        error: new Error('Failed to cancel orphaned order'),
        type: 'general' as const,
        severity: 'low' as const,
        context: {
          component: 'PositionManager',
          symbol: 'DOTUSDT',
          userAction: 'Cleaning up orphaned orders',
          metadata: { orderId: 123456789, reason: 'Order already filled' }
        }
      }
    ];

    // Log each error
    let errorCount = 0;
    for (const testError of testErrors) {
      await errorLogger.logError(
        testError.error,
        {
          type: testError.type,
          severity: testError.severity,
          context: testError.context,
          code: `TEST_${Date.now()}_${errorCount}`
        }
      );
      errorCount++;
    }

    // Add some duplicate errors for frequency testing
    for (let i = 0; i < 3; i++) {
      await errorLogger.logError(
        new Error('WebSocket reconnection attempt failed'),
        {
          type: 'websocket',
          severity: 'medium',
          context: {
            component: 'Hunter',
            symbol: 'BTCUSDT',
            userAction: `Reconnection attempt ${i + 1}`,
            metadata: { attemptNumber: i + 1, maxAttempts: 5 }
          }
        }
      );
    }
    errorCount += 3;

    // Get some errors and mark as resolved
    const errors = await errorLogsDb.getErrors(3, 0);
    let resolvedCount = 0;
    for (const error of errors) {
      if (error.id && Math.random() > 0.5) {
        await errorLogsDb.markResolved(error.id, 'Test resolution note');
        resolvedCount++;
      }
    }

    return NextResponse.json({
      message: 'Test errors generated successfully',
      generated: errorCount,
      resolved: resolvedCount,
      sessionId: errorLogger.getSessionId()
    });

  } catch (error) {
    console.error('Failed to generate test errors:', error);
    return NextResponse.json(
      { error: 'Failed to generate test errors' },
      { status: 500 }
    );
  }
}

export async function DELETE(_request: NextRequest) {
  try {
    // Clear all errors (for testing)
    const deleted = await errorLogsDb.clearOldErrors(0);

    return NextResponse.json({
      message: 'All test errors cleared',
      deleted
    });
  } catch (error) {
    console.error('Failed to clear test errors:', error);
    return NextResponse.json(
      { error: 'Failed to clear test errors' },
      { status: 500 }
    );
  }
}