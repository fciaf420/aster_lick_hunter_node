/**
 * @jest-environment node
 */
import {
  getIncomeHistory,
  getTimeRangeIncome,
  aggregateDailyPnL,
  calculatePerformanceMetrics,
  clearIncomeCache,
  invalidateIncomeCache,
  IncomeRecord,
  DailyPnL,
} from '@/lib/api/income';
import { MockIncomeDataGenerator } from '../utils/mock-income-data';
import axios from 'axios';

// Mock axios
jest.mock('axios');
jest.mock('@/lib/api/requestInterceptor', () => ({
  getRateLimitedAxios: () => axios,
}));

const mockCredentials = {
  apiKey: 'test-api-key',
  secretKey: 'test-secret-key',
};

// The mock data generators use the current time and Math.random, so pin both:
// midday UTC keeps "today minus a few hours" records on the same UTC day, and a
// seeded generator makes the win/loss patterns reproducible
const FIXED_NOW = new Date('2025-10-15T12:00:00.000Z');

function seededRandom(seed: number): () => number {
  // mulberry32
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Income API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearIncomeCache(); // Clear cache before each test
    jest.useFakeTimers({ now: FIXED_NOW, advanceTimers: true });
    jest.spyOn(Math, 'random').mockImplementation(seededRandom(42));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('getIncomeHistory', () => {
    it('should fetch income history from API', async () => {
      const mockData = MockIncomeDataGenerator.createProfitablePattern(7);
      (axios.get as jest.Mock).mockResolvedValue({ data: mockData });

      const result = await getIncomeHistory(mockCredentials, {
        startTime: Date.now() - 7 * 24 * 60 * 60 * 1000,
        endTime: Date.now(),
      });

      expect(result).toEqual(mockData);
      expect(axios.get).toHaveBeenCalledWith(
        expect.stringContaining('/fapi/v1/income'),
        expect.objectContaining({
          headers: { 'X-MBX-APIKEY': mockCredentials.apiKey },
        })
      );
    });

    it('should handle API errors gracefully', async () => {
      (axios.get as jest.Mock).mockRejectedValue(new Error('API Error'));

      await expect(
        getIncomeHistory(mockCredentials, {})
      ).rejects.toThrow('API Error');
    });

    it('should include signature in query string', async () => {
      (axios.get as jest.Mock).mockResolvedValue({ data: [] });

      await getIncomeHistory(mockCredentials, { limit: 500 });

      const callUrl = (axios.get as jest.Mock).mock.calls[0][0];
      expect(callUrl).toContain('signature=');
      expect(callUrl).toContain('timestamp=');
    });
  });

  describe('getTimeRangeIncome', () => {
    it('should fetch data for 24h range', async () => {
      const mockData = MockIncomeDataGenerator.createIncomeRecordsForDateRange(
        new Date(Date.now() - 24 * 60 * 60 * 1000),
        new Date(),
        { tradesPerDay: 5 }
      );
      (axios.get as jest.Mock).mockResolvedValue({ data: mockData });

      const result = await getTimeRangeIncome(mockCredentials, '24h');

      expect(result).toEqual(mockData);
      const callUrl = (axios.get as jest.Mock).mock.calls[0][0];
      expect(callUrl).toContain('startTime=');
    });

    it('should fetch data for 7d range', async () => {
      const mockData = MockIncomeDataGenerator.createProfitablePattern(7);
      (axios.get as jest.Mock).mockResolvedValue({ data: mockData });

      const result = await getTimeRangeIncome(mockCredentials, '7d');

      expect(result).toEqual(mockData);
    });

    it('should handle large datasets with pagination', async () => {
      // First call returns the oldest 1000 records in the 30d window (max limit, oldest first like the API)
      const windowStart = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const oldRecords = MockIncomeDataGenerator.createLargeDataset()
        .filter(record => record.time >= windowStart)
        .slice(0, 1000);
      // Second call returns recent data including today
      const recentRecords = MockIncomeDataGenerator.createIncomeRecordsForDateRange(
        new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        new Date(),
        { tradesPerDay: 10 }
      );

      (axios.get as jest.Mock)
        .mockResolvedValueOnce({ data: oldRecords })
        .mockResolvedValueOnce({ data: recentRecords });

      const result = await getTimeRangeIncome(mockCredentials, '30d');

      // Should make two API calls when hitting limit
      expect(axios.get).toHaveBeenCalledTimes(2);
      // Result should include both old and recent records (without duplicates)
      expect(result.length).toBeGreaterThanOrEqual(1000);
    });

    it('should use cache for repeated calls within TTL', async () => {
      const mockData = MockIncomeDataGenerator.createProfitablePattern(7);
      (axios.get as jest.Mock).mockResolvedValue({ data: mockData });

      // First call
      const result1 = await getTimeRangeIncome(mockCredentials, '7d');

      // Second call (should use cache)
      const result2 = await getTimeRangeIncome(mockCredentials, '7d');

      expect(result1).toEqual(result2);
      expect(axios.get).toHaveBeenCalledTimes(1); // Only one API call
    });

    it('should invalidate cache when called', async () => {
      const mockData1 = MockIncomeDataGenerator.createProfitablePattern(7);
      const mockData2 = MockIncomeDataGenerator.createLosingPattern(7);

      (axios.get as jest.Mock)
        .mockResolvedValueOnce({ data: mockData1 })
        .mockResolvedValueOnce({ data: mockData2 });

      // First call
      await getTimeRangeIncome(mockCredentials, '7d');

      // Invalidate cache
      invalidateIncomeCache();

      // Second call (should not use cache)
      await getTimeRangeIncome(mockCredentials, '7d');

      expect(axios.get).toHaveBeenCalledTimes(2);
    });

    it('should handle all time ranges correctly', async () => {
      const timeRanges: Array<'24h' | '7d' | '30d' | '90d' | '1y' | 'all'> =
        ['24h', '7d', '30d', '90d', '1y', 'all'];

      for (const range of timeRanges) {
        (axios.get as jest.Mock).mockResolvedValue({ data: [] });
        clearIncomeCache(); // Clear cache between tests

        await getTimeRangeIncome(mockCredentials, range);

        const callUrl = (axios.get as jest.Mock).mock.calls[0][0];
        expect(callUrl).toContain('startTime=');
      }
    });

    it('should handle empty responses', async () => {
      (axios.get as jest.Mock).mockResolvedValue({ data: [] });

      const result = await getTimeRangeIncome(mockCredentials, '7d');

      expect(result).toEqual([]);
    });

    it('should return empty array on API failure', async () => {
      (axios.get as jest.Mock).mockRejectedValue(new Error('Network error'));

      const result = await getTimeRangeIncome(mockCredentials, '7d');

      expect(result).toEqual([]);
    });
  });

  describe('aggregateDailyPnL', () => {
    it('should aggregate income records by day', () => {
      const records = MockIncomeDataGenerator.createProfitablePattern(3);
      const result = aggregateDailyPnL(records);

      expect(result.length).toBeLessThanOrEqual(3); // At most 3 days
      result.forEach(day => {
        expect(day).toHaveProperty('date');
        expect(day).toHaveProperty('realizedPnl');
        expect(day).toHaveProperty('commission');
        expect(day).toHaveProperty('fundingFee');
        expect(day).toHaveProperty('netPnl');
        expect(day).toHaveProperty('tradeCount');

        // Net PnL should be sum of components
        expect(day.netPnl).toBeCloseTo(
          day.realizedPnl + day.commission + day.fundingFee,
          8
        );
      });
    });

    it('should handle records with same timestamp', () => {
      const { duplicateTimes } = MockIncomeDataGenerator.createEdgeCaseRecords();
      const result = aggregateDailyPnL(duplicateTimes);

      expect(result.length).toBe(1); // All on same day
      expect(result[0].realizedPnl).toBe(125); // 50 + 75
      expect(result[0].commission).toBe(-3);
      expect(result[0].tradeCount).toBe(2);
    });

    it('should handle mixed symbols', () => {
      const { mixedSymbols } = MockIncomeDataGenerator.createEdgeCaseRecords();
      const result = aggregateDailyPnL(mixedSymbols);

      // Should aggregate all symbols together
      expect(result.length).toBe(1);
      expect(result[0].realizedPnl).toBe(125); // 100 + 50 - 25
      expect(result[0].tradeCount).toBe(3);
    });

    it('should handle empty input', () => {
      const result = aggregateDailyPnL([]);
      expect(result).toEqual([]);
    });

    it('should sort results chronologically', () => {
      const records: IncomeRecord[] = [
        MockIncomeDataGenerator.createIncomeRecord({
          time: new Date('2025-09-28').getTime(),
          income: '100',
        }),
        MockIncomeDataGenerator.createIncomeRecord({
          time: new Date('2025-09-26').getTime(),
          income: '50',
        }),
        MockIncomeDataGenerator.createIncomeRecord({
          time: new Date('2025-09-27').getTime(),
          income: '75',
        }),
      ];

      const result = aggregateDailyPnL(records);

      expect(result[0].date).toBe('2025-09-26');
      expect(result[1].date).toBe('2025-09-27');
      expect(result[2].date).toBe('2025-09-28');
    });

    it('should correctly parse dates at day boundaries', () => {
      const records = MockIncomeDataGenerator.createDateParsingTestRecords();
      const result = aggregateDailyPnL(records);

      // Should have 3 days (25th, 26th, 27th)
      expect(result.length).toBe(3);

      const day26 = result.find(d => d.date === '2025-09-26');
      expect(day26).toBeDefined();
      expect(day26!.realizedPnl).toBe(60); // Records 1, 2, 3 (10 + 20 + 30)
      expect(day26!.tradeCount).toBe(3);
    });

    it('should handle only funding fees', () => {
      const { noTrades } = MockIncomeDataGenerator.createEdgeCaseRecords();
      const result = aggregateDailyPnL(noTrades);

      expect(result.length).toBe(1);
      expect(result[0].realizedPnl).toBe(0);
      expect(result[0].fundingFee).toBe(0.75); // 1.5 - 0.75
      expect(result[0].tradeCount).toBe(0);
    });
  });

  describe('calculatePerformanceMetrics', () => {
    it('should calculate correct metrics for profitable pattern', () => {
      const records = MockIncomeDataGenerator.createProfitablePattern(7);
      const dailyPnL = aggregateDailyPnL(records);
      const metrics = calculatePerformanceMetrics(dailyPnL);

      expect(metrics.totalPnl).toBeGreaterThan(0);
      expect(metrics.winRate).toBeGreaterThan(50); // Should be around 70%
      expect(metrics.profitableDays).toBeGreaterThan(metrics.lossDays);
      expect(metrics.profitFactor).toBeGreaterThan(1);
      expect(metrics.bestDay).toBeDefined();
      expect(metrics.worstDay).toBeDefined();
      expect(metrics.avgDailyPnl).toBeGreaterThan(0);
    });

    it('should calculate correct metrics for losing pattern', () => {
      const records = MockIncomeDataGenerator.createLosingPattern(7);
      const dailyPnL = aggregateDailyPnL(records);
      const metrics = calculatePerformanceMetrics(dailyPnL);

      expect(metrics.totalPnl).toBeLessThan(0);
      expect(metrics.winRate).toBeLessThan(50); // Should be around 30%
      expect(metrics.lossDays).toBeGreaterThan(metrics.profitableDays);
      expect(metrics.profitFactor).toBeLessThan(1);
      expect(metrics.avgDailyPnl).toBeLessThan(0);
    });

    it('should handle empty data', () => {
      const metrics = calculatePerformanceMetrics([]);

      expect(metrics.totalPnl).toBe(0);
      expect(metrics.winRate).toBe(0);
      expect(metrics.profitableDays).toBe(0);
      expect(metrics.lossDays).toBe(0);
      expect(metrics.bestDay).toBeNull();
      expect(metrics.worstDay).toBeNull();
      expect(metrics.avgDailyPnl).toBe(0);
      expect(metrics.maxDrawdown).toBe(0);
      expect(metrics.profitFactor).toBe(0);
      expect(metrics.sharpeRatio).toBe(0);
    });

    it('should calculate drawdown correctly', () => {
      const dailyPnL: DailyPnL[] = [
        { date: '2025-09-01', realizedPnl: 100, commission: -5, fundingFee: 0, netPnl: 95, tradeCount: 1 },
        { date: '2025-09-02', realizedPnl: 150, commission: -5, fundingFee: 0, netPnl: 145, tradeCount: 1 },
        { date: '2025-09-03', realizedPnl: -200, commission: -5, fundingFee: 0, netPnl: -205, tradeCount: 1 },
        { date: '2025-09-04', realizedPnl: -50, commission: -5, fundingFee: 0, netPnl: -55, tradeCount: 1 },
        { date: '2025-09-05', realizedPnl: 100, commission: -5, fundingFee: 0, netPnl: 95, tradeCount: 1 },
      ];

      const metrics = calculatePerformanceMetrics(dailyPnL);

      // Peak is at day 2 (95 + 145 = 240)
      // Lowest point is at day 4 (240 - 205 - 55 = -20)
      // Max drawdown = 240 - (-20) = 260
      expect(metrics.maxDrawdown).toBe(260);
    });

    it('should calculate Sharpe ratio', () => {
      const records = MockIncomeDataGenerator.createProfitablePattern(30);
      const dailyPnL = aggregateDailyPnL(records);
      const metrics = calculatePerformanceMetrics(dailyPnL);

      // Sharpe ratio should be positive for profitable pattern
      expect(metrics.sharpeRatio).toBeGreaterThan(0);
      expect(metrics.sharpeRatio).toBeLessThan(50); // High Sharpe for very profitable pattern
    });

    it('should calculate profit factor correctly', () => {
      const dailyPnL: DailyPnL[] = [
        { date: '2025-09-01', realizedPnl: 100, commission: 0, fundingFee: 0, netPnl: 100, tradeCount: 1 },
        { date: '2025-09-02', realizedPnl: 150, commission: 0, fundingFee: 0, netPnl: 150, tradeCount: 1 },
        { date: '2025-09-03', realizedPnl: -50, commission: 0, fundingFee: 0, netPnl: -50, tradeCount: 1 },
        { date: '2025-09-04', realizedPnl: -25, commission: 0, fundingFee: 0, netPnl: -25, tradeCount: 1 },
      ];

      const metrics = calculatePerformanceMetrics(dailyPnL);

      // Total profit = 250, Total loss = 75
      // Profit factor = 250 / 75 = 3.33...
      expect(metrics.profitFactor).toBeCloseTo(3.33, 1);
    });

    it('should handle all profitable days', () => {
      const dailyPnL: DailyPnL[] = [
        { date: '2025-09-01', realizedPnl: 100, commission: 0, fundingFee: 0, netPnl: 100, tradeCount: 1 },
        { date: '2025-09-02', realizedPnl: 200, commission: 0, fundingFee: 0, netPnl: 200, tradeCount: 1 },
      ];

      const metrics = calculatePerformanceMetrics(dailyPnL);

      expect(metrics.winRate).toBe(100);
      expect(metrics.profitFactor).toBe(Infinity);
      expect(metrics.maxDrawdown).toBe(0);
    });

    it('should identify best and worst days', () => {
      const dailyPnL: DailyPnL[] = [
        { date: '2025-09-01', realizedPnl: 50, commission: -5, fundingFee: 0, netPnl: 45, tradeCount: 1 },
        { date: '2025-09-02', realizedPnl: 500, commission: -10, fundingFee: 0, netPnl: 490, tradeCount: 3 },
        { date: '2025-09-03', realizedPnl: -300, commission: -10, fundingFee: 0, netPnl: -310, tradeCount: 2 },
        { date: '2025-09-04', realizedPnl: 100, commission: -5, fundingFee: 0, netPnl: 95, tradeCount: 1 },
      ];

      const metrics = calculatePerformanceMetrics(dailyPnL);

      expect(metrics.bestDay?.date).toBe('2025-09-02');
      expect(metrics.bestDay?.netPnl).toBe(490);
      expect(metrics.worstDay?.date).toBe('2025-09-03');
      expect(metrics.worstDay?.netPnl).toBe(-310);
    });

    it('should calculate average daily PnL correctly', () => {
      const dailyPnL: DailyPnL[] = [
        { date: '2025-09-01', realizedPnl: 100, commission: 0, fundingFee: 0, netPnl: 100, tradeCount: 1 },
        { date: '2025-09-02', realizedPnl: 200, commission: 0, fundingFee: 0, netPnl: 200, tradeCount: 1 },
        { date: '2025-09-03', realizedPnl: -60, commission: 0, fundingFee: 0, netPnl: -60, tradeCount: 1 },
      ];

      const metrics = calculatePerformanceMetrics(dailyPnL);

      expect(metrics.avgDailyPnl).toBeCloseTo(80, 1); // (100 + 200 - 60) / 3
    });

    it('should handle single day of data', () => {
      const { singleDay } = MockIncomeDataGenerator.createEdgeCaseRecords();
      const dailyPnL = aggregateDailyPnL(singleDay);
      const metrics = calculatePerformanceMetrics(dailyPnL);

      expect(metrics.totalPnl).toBe(98); // 100 - 2
      expect(metrics.winRate).toBe(100); // Single positive day
      expect(metrics.profitableDays).toBe(1);
      expect(metrics.lossDays).toBe(0);
      expect(metrics.bestDay?.netPnl).toBe(98);
      expect(metrics.worstDay?.netPnl).toBe(98); // Same day
      expect(metrics.sharpeRatio).toBe(0); // Need multiple days for variance
    });
  });

  describe('Date consistency across time zones', () => {
    it('should maintain date consistency regardless of local timezone', () => {
      // Test records at UTC day boundaries
      const records: IncomeRecord[] = [
        MockIncomeDataGenerator.createIncomeRecord({
          time: new Date('2025-09-26T23:59:59.999Z').getTime(),
          income: '100',
        }),
        MockIncomeDataGenerator.createIncomeRecord({
          time: new Date('2025-09-27T00:00:00.000Z').getTime(),
          income: '200',
        }),
      ];

      const dailyPnL = aggregateDailyPnL(records);

      // Should be on different days
      expect(dailyPnL.length).toBe(2);
      expect(dailyPnL[0].date).toBe('2025-09-26');
      expect(dailyPnL[1].date).toBe('2025-09-27');
    });

    it('should handle today\'s data correctly', () => {
      const today = new Date();
      const todayString = today.toISOString().split('T')[0];

      const records = [
        MockIncomeDataGenerator.createIncomeRecord({
          time: today.getTime(),
          income: '100',
        }),
      ];

      const dailyPnL = aggregateDailyPnL(records);

      expect(dailyPnL.length).toBe(1);
      expect(dailyPnL[0].date).toBe(todayString);
    });
  });
});