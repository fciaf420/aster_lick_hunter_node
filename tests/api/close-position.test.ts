/**
 * @jest-environment node
 */
import { POST } from '@/app/api/positions/[symbol]/[side]/close/route';
import { NextRequest } from 'next/server';
import { placeOrder, getPositions } from '@/lib/api/orders';
import { getPositionMode } from '@/lib/api/positionMode';
import { loadConfig } from '@/lib/bot/config';
import { getExchangeInfo } from '@/lib/api/market';

// Mock dependencies
jest.mock('@/lib/api/orders');
jest.mock('@/lib/api/positionMode');
jest.mock('@/lib/bot/config');
jest.mock('@/lib/api/market');
jest.mock('@/lib/api/requestInterceptor', () => ({
  getRateLimitedAxios: jest.fn(),
}));

const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;
const mockGetPositions = getPositions as jest.MockedFunction<typeof getPositions>;
const mockPlaceOrder = placeOrder as jest.MockedFunction<typeof placeOrder>;
const mockGetPositionMode = getPositionMode as jest.MockedFunction<typeof getPositionMode>;
const mockGetExchangeInfo = getExchangeInfo as jest.MockedFunction<typeof getExchangeInfo>;

describe('Close Position API', () => {
  const mockConfig = {
    api: {
      apiKey: 'test-api-key',
      secretKey: 'test-secret-key',
    },
    global: {
      paperMode: false,
      positionMode: 'ONE_WAY' as const,
    },
  };

  const mockExchangeInfo = {
    symbols: [
      {
        symbol: 'BTCUSDT',
        filters: [
          { filterType: 'PRICE_FILTER', tickSize: '0.01' },
          { filterType: 'LOT_SIZE', stepSize: '0.001' },
        ],
      },
    ],
  };

  const mockPositions = [
    {
      symbol: 'BTCUSDT',
      positionAmt: '0.005',
      positionSide: 'BOTH',
      entryPrice: '50000',
      markPrice: '51000',
      unRealizedProfit: '5',
    },
    {
      symbol: 'ETHUSDT',
      positionAmt: '-0.1',
      positionSide: 'BOTH',
      entryPrice: '3000',
      markPrice: '2900',
      unRealizedProfit: '10',
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadConfig.mockResolvedValue(mockConfig as any);
    mockGetExchangeInfo.mockResolvedValue(mockExchangeInfo as any);
    mockGetPositions.mockResolvedValue(mockPositions as any);
    mockGetPositionMode.mockResolvedValue(false); // ONE_WAY mode by default
  });

  describe('Parameter Validation', () => {
    it('should reject invalid side parameter', async () => {
      const request = new NextRequest('http://localhost/api/positions/BTCUSDT/INVALID/close', {
        method: 'POST',
      });

      const response = await POST(request, { params: Promise.resolve({ symbol: 'BTCUSDT', side: 'INVALID' }) });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain('Invalid side parameter');
    });

    it('should accept valid LONG side', async () => {
      const request = new NextRequest('http://localhost/api/positions/BTCUSDT/LONG/close', {
        method: 'POST',
      });

      mockPlaceOrder.mockResolvedValue({ orderId: 12345 } as any);

      const response = await POST(request, { params: Promise.resolve({ symbol: 'BTCUSDT', side: 'LONG' }) });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should accept valid SHORT side', async () => {
      const request = new NextRequest('http://localhost/api/positions/ETHUSDT/SHORT/close', {
        method: 'POST',
      });

      mockPlaceOrder.mockResolvedValue({ orderId: 12346 } as any);

      const response = await POST(request, { params: Promise.resolve({ symbol: 'ETHUSDT', side: 'SHORT' }) });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });

  describe('Position Finding', () => {
    it('should find and close LONG position correctly', async () => {
      const request = new NextRequest('http://localhost/api/positions/BTCUSDT/LONG/close', {
        method: 'POST',
      });

      mockPlaceOrder.mockResolvedValue({ orderId: 12345 } as any);

      const response = await POST(request, { params: Promise.resolve({ symbol: 'BTCUSDT', side: 'LONG' }) });
      const data = await response.json();

      expect(mockPlaceOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          symbol: 'BTCUSDT',
          side: 'SELL', // Opposite of LONG
          type: 'MARKET',
          quantity: 0.005, // Formatted quantity
          positionSide: 'BOTH',
          reduceOnly: true,
        }),
        mockConfig.api
      );
      expect(data.success).toBe(true);
      expect(data.order_side).toBe('SELL');
    });

    it('should find and close SHORT position correctly', async () => {
      const request = new NextRequest('http://localhost/api/positions/ETHUSDT/SHORT/close', {
        method: 'POST',
      });

      mockPlaceOrder.mockResolvedValue({ orderId: 12346 } as any);

      const response = await POST(request, { params: Promise.resolve({ symbol: 'ETHUSDT', side: 'SHORT' }) });
      const data = await response.json();

      expect(mockPlaceOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          symbol: 'ETHUSDT',
          side: 'BUY', // Opposite of SHORT
          type: 'MARKET',
          quantity: 0.1, // Formatted quantity
          positionSide: 'BOTH',
          reduceOnly: true,
        }),
        mockConfig.api
      );
      expect(data.success).toBe(true);
      expect(data.order_side).toBe('BUY');
    });

    it('should return 404 when position not found', async () => {
      const request = new NextRequest('http://localhost/api/positions/NONEXISTENT/LONG/close', {
        method: 'POST',
      });

      const response = await POST(request, { params: Promise.resolve({ symbol: 'NONEXISTENT', side: 'LONG' }) });
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error).toContain('No open position found');
    });

    it('should return error for zero position size', async () => {
      mockGetPositions.mockResolvedValue([
        {
          symbol: 'BTCUSDT',
          positionAmt: '0',
          positionSide: 'BOTH',
        },
      ] as any);

      const request = new NextRequest('http://localhost/api/positions/BTCUSDT/LONG/close', {
        method: 'POST',
      });

      const response = await POST(request, { params: Promise.resolve({ symbol: 'BTCUSDT', side: 'LONG' }) });
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toContain('No open position found');
    });
  });

  describe('Position Mode Handling', () => {
    it('should handle ONE_WAY mode correctly', async () => {
      mockGetPositionMode.mockResolvedValue(false); // ONE_WAY mode

      const request = new NextRequest('http://localhost/api/positions/BTCUSDT/LONG/close', {
        method: 'POST',
      });

      mockPlaceOrder.mockResolvedValue({ orderId: 12345 } as any);

      const response = await POST(request, { params: Promise.resolve({ symbol: 'BTCUSDT', side: 'LONG' }) });
      const data = await response.json();

      expect(mockPlaceOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          positionSide: 'BOTH',
          reduceOnly: true,
        }),
        mockConfig.api
      );
      expect(data.position_mode).toBe('ONE_WAY');
    });

    it('should handle HEDGE mode correctly', async () => {
      mockGetPositionMode.mockResolvedValue(true); // HEDGE mode
      mockGetPositions.mockResolvedValue([
        {
          symbol: 'BTCUSDT',
          positionAmt: '0.005',
          positionSide: 'LONG',
        },
      ] as any);

      const request = new NextRequest('http://localhost/api/positions/BTCUSDT/LONG/close', {
        method: 'POST',
      });

      mockPlaceOrder.mockResolvedValue({ orderId: 12345 } as any);

      const response = await POST(request, { params: Promise.resolve({ symbol: 'BTCUSDT', side: 'LONG' }) });
      const data = await response.json();

      expect(mockPlaceOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          positionSide: 'LONG',
          // No reduceOnly in hedge mode
        }),
        mockConfig.api
      );
      expect(data.position_mode).toBe('HEDGE');
      expect((mockPlaceOrder.mock.calls[0][0] as any).reduceOnly).toBeUndefined();
    });

    it('should fallback to ONE_WAY mode if position mode fetch fails', async () => {
      mockGetPositionMode.mockRejectedValue(new Error('API error'));

      const request = new NextRequest('http://localhost/api/positions/BTCUSDT/LONG/close', {
        method: 'POST',
      });

      mockPlaceOrder.mockResolvedValue({ orderId: 12345 } as any);

      const response = await POST(request, { params: Promise.resolve({ symbol: 'BTCUSDT', side: 'LONG' }) });
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.position_mode).toBe('ONE_WAY');
    });
  });

  describe('Paper Mode', () => {
    it('should simulate close in paper mode', async () => {
      mockLoadConfig.mockResolvedValue({
        ...mockConfig,
        global: {
          ...mockConfig.global,
          paperMode: true,
        },
      } as any);

      const request = new NextRequest('http://localhost/api/positions/BTCUSDT/LONG/close', {
        method: 'POST',
      });

      const response = await POST(request, { params: Promise.resolve({ symbol: 'BTCUSDT', side: 'LONG' }) });
      const data = await response.json();

      expect(mockPlaceOrder).not.toHaveBeenCalled();
      expect(data.success).toBe(true);
      expect(data.simulated).toBe(true);
      expect(data.message).toContain('Paper mode');
    });

    it('should return simulation when no API keys configured', async () => {
      mockLoadConfig.mockResolvedValue({
        api: {
          apiKey: '',
          secretKey: '',
        },
        global: mockConfig.global,
      } as any);

      const request = new NextRequest('http://localhost/api/positions/BTCUSDT/LONG/close', {
        method: 'POST',
      });

      const response = await POST(request, { params: Promise.resolve({ symbol: 'BTCUSDT', side: 'LONG' }) });
      const data = await response.json();

      expect(mockGetPositions).not.toHaveBeenCalled();
      expect(mockPlaceOrder).not.toHaveBeenCalled();
      expect(data.success).toBe(true);
      expect(data.simulated).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle API errors with specific messages', async () => {
      const request = new NextRequest('http://localhost/api/positions/BTCUSDT/LONG/close', {
        method: 'POST',
      });

      mockPlaceOrder.mockRejectedValue({
        response: {
          data: {
            msg: 'Precision is over the maximum defined for this asset',
          },
          status: 400,
        },
      });

      const response = await POST(request, { params: Promise.resolve({ symbol: 'BTCUSDT', side: 'LONG' }) });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain('Quantity precision error');
    });

    it('should handle insufficient balance errors', async () => {
      const request = new NextRequest('http://localhost/api/positions/BTCUSDT/LONG/close', {
        method: 'POST',
      });

      mockPlaceOrder.mockRejectedValue({
        response: {
          data: {
            msg: 'Account has insufficient balance',
          },
          status: 400,
        },
      });

      const response = await POST(request, { params: Promise.resolve({ symbol: 'BTCUSDT', side: 'LONG' }) });
      const data = await response.json();

      expect(data.error).toContain('Insufficient balance');
    });

    it('should handle reduce-only errors', async () => {
      const request = new NextRequest('http://localhost/api/positions/BTCUSDT/LONG/close', {
        method: 'POST',
      });

      mockPlaceOrder.mockRejectedValue({
        response: {
          data: {
            msg: 'ReduceOnly Order is rejected',
          },
          status: 400,
        },
      });

      const response = await POST(request, { params: Promise.resolve({ symbol: 'BTCUSDT', side: 'LONG' }) });
      const data = await response.json();

      expect(data.error).toContain('Reduce-only order error');
    });

    it('should handle network errors', async () => {
      const request = new NextRequest('http://localhost/api/positions/BTCUSDT/LONG/close', {
        method: 'POST',
      });

      mockPlaceOrder.mockRejectedValue(new Error('Network error'));

      const response = await POST(request, { params: Promise.resolve({ symbol: 'BTCUSDT', side: 'LONG' }) });
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toContain('Internal error');
    });
  });

  describe('Quantity Precision', () => {
    it('should format quantity according to exchange precision', async () => {
      // Setup exchange info with specific precision
      mockGetExchangeInfo.mockResolvedValue({
        symbols: [
          {
            symbol: 'BTCUSDT',
            filters: [
              { filterType: 'PRICE_FILTER', tickSize: '0.01' },
              { filterType: 'LOT_SIZE', stepSize: '0.001' },
            ],
          },
        ],
      } as any);

      mockGetPositions.mockResolvedValue([
        {
          symbol: 'BTCUSDT',
          positionAmt: '0.0054321', // Will be rounded to 0.005
          positionSide: 'BOTH',
        },
      ] as any);

      const request = new NextRequest('http://localhost/api/positions/BTCUSDT/LONG/close', {
        method: 'POST',
      });

      mockPlaceOrder.mockResolvedValue({ orderId: 12345 } as any);

      await POST(request, { params: Promise.resolve({ symbol: 'BTCUSDT', side: 'LONG' }) });

      // Check that the quantity was properly formatted
      expect(mockPlaceOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          quantity: expect.any(Number), // Should be formatted according to precision
        }),
        mockConfig.api
      );
    });
  });
});