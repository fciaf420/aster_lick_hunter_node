import { buildSignedQuery } from './auth';
import { ApiCredentials } from '../types';
import { getRateLimitedAxios } from './requestInterceptor';
import { getUserTrades } from './market';
import { ASTER_REST_BASE_URL } from '../exchange/aster/constants';

const BASE_URL = ASTER_REST_BASE_URL;

// Simple cache to prevent duplicate API calls
const incomeCache = new Map<string, { data: IncomeRecord[]; timestamp: number }>();

// Different cache TTL based on range - shorter ranges need fresher data
const getCacheTTL = (range: string): number => {
  switch (range) {
    case '24h':
      return 1 * 60 * 1000; // 1 minute for 24h
    case '7d':
      return 2 * 60 * 1000; // 2 minutes for 7d
    case '30d':
      return 5 * 60 * 1000; // 5 minutes for 30d
    default:
      return 10 * 60 * 1000; // 10 minutes for longer ranges
  }
};

// Function to invalidate cache when new trading activity occurs
export function invalidateIncomeCache(): void {
  console.log('[Income Cache] Invalidating all cache due to new trading activity');
  incomeCache.clear();
}

// Temporary function to clear cache for debugging
export function clearIncomeCache(): void {
  console.log('[Income Cache] Clearing all cache for debugging');
  incomeCache.clear();
}

export type IncomeType =
  | 'TRANSFER'
  | 'WELCOME_BONUS'
  | 'REALIZED_PNL'
  | 'FUNDING_FEE'
  | 'COMMISSION'
  | 'INSURANCE_CLEAR'
  | 'MARKET_MERCHANT_RETURN_REWARD'
  | 'APOLLOX_DEX_REBATE'         // Referral/trading rebates (undocumented)
  | 'USDF_BASE_REWARD'           // USDF staking rewards (undocumented)
  | 'AUTO_EXCHANGE';             // Automatic asset conversion (undocumented)

export interface IncomeRecord {
  symbol: string;
  incomeType: IncomeType;
  income: string;
  asset: string;
  info: string;
  time: number;
  tranId: string;
  tradeId: string;
}

export interface IncomeHistoryParams {
  symbol?: string;
  incomeType?: IncomeType;
  startTime?: number;
  endTime?: number;
  limit?: number;
}

export async function getIncomeHistory(
  credentials: ApiCredentials,
  params: IncomeHistoryParams = {}
): Promise<IncomeRecord[]> {
  const query = buildSignedQuery(params, credentials);

  const axios = getRateLimitedAxios();
  const response = await axios.get<IncomeRecord[]>(
    `${BASE_URL}/fapi/v1/income?${query}`,
    {
      headers: {
        'X-MBX-APIKEY': credentials.apiKey,
      },
    }
  );

  return response.data;
}

export interface DailyPnL {
  date: string;
  realizedPnl: number;
  commission: number;
  fundingFee: number;
  insuranceClear: number;
  marketMerchantReward: number;
  apolloxRebate: number;              // Trading rebates/referral rewards
  usdfReward: number;                 // USDF staking rewards
  netPnl: number;
  tradeCount: number;
}

export interface DailyPnLWithBreakdown extends DailyPnL {
  // Preserve individual income type amounts for breakdown charts
  breakdown: {
    realizedPnl: number;
    commission: number;
    fundingFee: number;
    insuranceClear: number;
    marketMerchantReward: number;
    apolloxRebate: number;
    usdfReward: number;
  };
}

export interface SymbolPnL {
  symbol: string;
  tradeCount: number;
  realizedPnl: number;
  commission: number;
  fundingFee: number;
  insuranceClear: number;
  marketMerchantReward: number;
  apolloxRebate: number;
  usdfReward: number;
  netPnl: number;
  winCount: number;
  lossCount: number;
  winRate: number;
}

export function aggregateDailyPnL(records: IncomeRecord[]): DailyPnL[] {
  const dailyMap = new Map<string, DailyPnL>();
  const _todayString = new Date().toISOString().split('T')[0];

  // Track unique trade IDs per day to avoid double-counting
  const dailyTradeIds = new Map<string, Set<string>>();

  records.forEach((record, _index) => {
    // Use UTC date to avoid timezone shifts
    // The API returns timestamps in milliseconds
    const d = new Date(record.time);
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const amount = parseFloat(record.income);

    if (!dailyMap.has(date)) {
      dailyMap.set(date, {
        date,
        realizedPnl: 0,
        commission: 0,
        fundingFee: 0,
        insuranceClear: 0,
        marketMerchantReward: 0,
        apolloxRebate: 0,
        usdfReward: 0,
        netPnl: 0,
        tradeCount: 0,
      });
      dailyTradeIds.set(date, new Set<string>());
    }

    const daily = dailyMap.get(date)!;
    const tradeIds = dailyTradeIds.get(date)!;

    switch (record.incomeType) {
      case 'REALIZED_PNL':
        daily.realizedPnl += amount;
        // Only count unique trades using tradeId
        if (record.tradeId && !tradeIds.has(record.tradeId)) {
          tradeIds.add(record.tradeId);
          daily.tradeCount++;
        }
        break;
      case 'COMMISSION':
        daily.commission += amount;
        break;
      case 'FUNDING_FEE':
        daily.fundingFee += amount;
        break;
      case 'INSURANCE_CLEAR':
        daily.insuranceClear += amount;
        break;
      case 'MARKET_MERCHANT_RETURN_REWARD':
        daily.marketMerchantReward += amount;
        break;
      case 'APOLLOX_DEX_REBATE':
        daily.apolloxRebate += amount;
        break;
      case 'USDF_BASE_REWARD':
        daily.usdfReward += amount;
        break;
    }
  });

  // Calculate net PnL for each day including all income types
  dailyMap.forEach((daily, _date) => {
    daily.netPnl = daily.realizedPnl + daily.commission + daily.fundingFee +
                   daily.insuranceClear + daily.marketMerchantReward +
                   daily.apolloxRebate + daily.usdfReward;
  });

  const result = Array.from(dailyMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  return result;
}

export interface PerformanceMetrics {
  totalPnl: number;
  totalRealizedPnl: number;
  totalCommission: number;
  totalFundingFee: number;
  totalInsuranceClear: number;
  totalMarketMerchantReward: number;
  totalApolloxRebate: number;
  totalUsdfReward: number;
  winRate: number;
  profitableDays: number;
  lossDays: number;
  bestDay: DailyPnL | null;
  worstDay: DailyPnL | null;
  avgDailyPnl: number;
  maxDrawdown: number;
  profitFactor: number;
  sharpeRatio: number;
}

export function calculatePerformanceMetrics(dailyPnL: DailyPnL[]): PerformanceMetrics {
  if (dailyPnL.length === 0) {
    return {
      totalPnl: 0,
      totalRealizedPnl: 0,
      totalCommission: 0,
      totalFundingFee: 0,
      totalInsuranceClear: 0,
      totalMarketMerchantReward: 0,
      totalApolloxRebate: 0,
      totalUsdfReward: 0,
      winRate: 0,
      profitableDays: 0,
      lossDays: 0,
      bestDay: null,
      worstDay: null,
      avgDailyPnl: 0,
      maxDrawdown: 0,
      profitFactor: 0,
      sharpeRatio: 0,
    };
  }

  let totalPnl = 0;
  let totalRealizedPnl = 0;
  let totalCommission = 0;
  let totalFundingFee = 0;
  let totalInsuranceClear = 0;
  let totalMarketMerchantReward = 0;
  let totalApolloxRebate = 0;
  let totalUsdfReward = 0;
  let profitableDays = 0;
  let lossDays = 0;
  let bestDay = dailyPnL[0];
  let worstDay = dailyPnL[0];
  let totalProfit = 0;
  let totalLoss = 0;

  // Calculate cumulative metrics
  let cumulativePnl = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const dailyReturns: number[] = [];

  dailyPnL.forEach(day => {
    totalPnl += day.netPnl;
    totalRealizedPnl += day.realizedPnl;
    totalCommission += day.commission;
    totalFundingFee += day.fundingFee;
    totalInsuranceClear += day.insuranceClear || 0;
    totalMarketMerchantReward += day.marketMerchantReward || 0;
    totalApolloxRebate += day.apolloxRebate || 0;
    totalUsdfReward += day.usdfReward || 0;

    if (day.netPnl > 0) {
      profitableDays++;
      totalProfit += day.netPnl;
    } else if (day.netPnl < 0) {
      lossDays++;
      totalLoss += Math.abs(day.netPnl);
    }

    if (day.netPnl > bestDay.netPnl) {
      bestDay = day;
    }
    if (day.netPnl < worstDay.netPnl) {
      worstDay = day;
    }

    // Track drawdown
    cumulativePnl += day.netPnl;
    if (cumulativePnl > peak) {
      peak = cumulativePnl;
    }
    const drawdown = peak - cumulativePnl;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }

    // Store absolute PnL for now (will be used for basic volatility)
    dailyReturns.push(day.netPnl);
  });

  const totalDays = dailyPnL.length;
  const winRate = totalDays > 0 ? (profitableDays / totalDays) * 100 : 0;
  const avgDailyPnl = totalDays > 0 ? totalPnl / totalDays : 0;
  const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

  // Calculate Sharpe Ratio (simplified - assuming risk-free rate of 0)
  // Note: Ideally this should use percentage returns relative to starting capital,
  // but without knowing the starting capital, we use absolute PnL returns
  // This gives a proxy for risk-adjusted returns
  let sharpeRatio = 0;
  if (dailyReturns.length > 1) {
    const mean = avgDailyPnl;
    const variance = dailyReturns.reduce((sum, ret) => sum + Math.pow(ret - mean, 2), 0) / dailyReturns.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev > 0) {
      // Annualized Sharpe ratio (assuming 365 trading days in crypto)
      sharpeRatio = (mean / stdDev) * Math.sqrt(365);
    }
  }

  return {
    totalPnl,
    totalRealizedPnl,
    totalCommission,
    totalFundingFee,
    totalInsuranceClear,
    totalMarketMerchantReward,
    totalApolloxRebate,
    totalUsdfReward,
    winRate,
    profitableDays,
    lossDays,
    bestDay,
    worstDay,
    avgDailyPnl,
    maxDrawdown,
    profitFactor,
    sharpeRatio,
  };
}

// Helper function to get income for a specific time range with pagination to fetch all records
export async function getTimeRangeIncome(
  credentials: ApiCredentials,
  range: '24h' | '7d' | '30d' | '90d' | '1y' | 'all'
): Promise<IncomeRecord[]> {
  // Check cache first with range-specific TTL
  const cacheKey = `${range}_${credentials.apiKey.slice(-8)}`;
  const cached = incomeCache.get(cacheKey);
  const cacheTTL = getCacheTTL(range);
  const cacheAge = cached ? Date.now() - cached.timestamp : 0;

  if (cached && cacheAge < cacheTTL) {
    console.log(`[Income API] Using cached data for ${range} (age: ${Math.floor(cacheAge / 1000)}s)`);
    return cached.data;
  }

  const now = Date.now();
  let startTime: number | undefined;

  switch (range) {
    case '24h':
      startTime = now - 24 * 60 * 60 * 1000;
      break;
    case '7d':
      startTime = now - 7 * 24 * 60 * 60 * 1000;
      break;
    case '30d':
      startTime = now - 30 * 24 * 60 * 60 * 1000;
      break;
    case '90d':
      startTime = now - 90 * 24 * 60 * 60 * 1000;
      break;
    case '1y':
      startTime = now - 365 * 24 * 60 * 60 * 1000;
      break;
    case 'all':
      // For 'all', limit to last 2 years to prevent excessive data
      startTime = now - 2 * 365 * 24 * 60 * 60 * 1000;
      break;
  }

  try {
    const allRecords: IncomeRecord[] = [];
    let currentStartTime = startTime;
    let batchCount = 0;
    const maxBatches = 10; // Safety limit to prevent infinite loops

    console.log(`[Income API] Fetching income history for ${range}...`);

    // Pagination: Keep fetching until we get less than 1000 records or hit the startTime
    while (batchCount < maxBatches) {
      batchCount++;

      const params: IncomeHistoryParams = {
        startTime: currentStartTime,
        endTime: now,
        limit: 1000,
      };

      const batch = await getIncomeHistory(credentials, params);

      if (batch.length === 0) {
        console.log(`[Income API] Batch ${batchCount}: No more records found`);
        break;
      }

      console.log(`[Income API] Batch ${batchCount}: Fetched ${batch.length} records`);

      // Add to our collection
      allRecords.push(...batch);

      // If we got less than 1000 records, we've reached the end
      if (batch.length < 1000) {
        console.log(`[Income API] Completed: Got ${batch.length} records (less than limit). All data fetched.`);
        break;
      }

      // Records come back oldest first, so page forward from the newest record in this batch.
      // Its timestamp is requested again so records sharing it aren't skipped; duplicates are removed by tranId below
      const newestTime = batch[batch.length - 1].time;
      if (currentStartTime !== undefined && newestTime <= currentStartTime) {
        console.warn(`[Income API] Batch ${batchCount} made no progress past ${newestTime}. Stopping pagination.`);
        break;
      }
      currentStartTime = newestTime;
    }

    if (batchCount >= maxBatches) {
      console.warn(`[Income API] Warning: Hit maximum batch limit (${maxBatches}). There may be more data available.`);
    }

    // Remove duplicates based on tranId (transaction ID is unique)
    const uniqueRecords = Array.from(
      new Map(allRecords.map(record => [record.tranId, record])).values()
    );

    // Sort by time ascending (oldest first)
    uniqueRecords.sort((a, b) => a.time - b.time);

    console.log(`[Income API] Total unique records fetched: ${uniqueRecords.length} (from ${batchCount} batches)`);

    // Cache the result
    incomeCache.set(cacheKey, { data: uniqueRecords, timestamp: now });

    // Clean up old cache entries
    for (const [key, value] of incomeCache.entries()) {
      const keyRange = key.split('_')[0];
      const keyTTL = getCacheTTL(keyRange);
      if (now - value.timestamp > keyTTL) {
        incomeCache.delete(key);
      }
    }

    return uniqueRecords;
  } catch (error) {
    console.error(`[Income API] Error fetching data for ${range}:`, error);
    return [];
  }
}

// Aggregate income records by symbol
export function aggregateBySymbol(records: IncomeRecord[]): SymbolPnL[] {
  const symbolMap = new Map<string, SymbolPnL>();

  // Track unique trade IDs per symbol to count wins/losses
  const symbolTradeResults = new Map<string, Map<string, number>>();

  records.forEach(record => {
    const symbol = record.symbol || 'Account Rewards';
    const amount = parseFloat(record.income);

    if (!symbolMap.has(symbol)) {
      symbolMap.set(symbol, {
        symbol,
        tradeCount: 0,
        realizedPnl: 0,
        commission: 0,
        fundingFee: 0,
        insuranceClear: 0,
        marketMerchantReward: 0,
        apolloxRebate: 0,
        usdfReward: 0,
        netPnl: 0,
        winCount: 0,
        lossCount: 0,
        winRate: 0,
      });
      symbolTradeResults.set(symbol, new Map<string, number>());
    }

    const symbolData = symbolMap.get(symbol)!;
    const tradeResults = symbolTradeResults.get(symbol)!;

    switch (record.incomeType) {
      case 'REALIZED_PNL':
        symbolData.realizedPnl += amount;
        // Track trade result by tradeId
        if (record.tradeId) {
          // Accumulate PnL for the same tradeId (in case of partial fills)
          const currentPnL = tradeResults.get(record.tradeId) || 0;
          tradeResults.set(record.tradeId, currentPnL + amount);
        }
        break;
      case 'COMMISSION':
        symbolData.commission += amount;
        break;
      case 'FUNDING_FEE':
        symbolData.fundingFee += amount;
        break;
      case 'INSURANCE_CLEAR':
        symbolData.insuranceClear += amount;
        break;
      case 'MARKET_MERCHANT_RETURN_REWARD':
        symbolData.marketMerchantReward += amount;
        break;
      case 'APOLLOX_DEX_REBATE':
        symbolData.apolloxRebate += amount;
        break;
      case 'USDF_BASE_REWARD':
        symbolData.usdfReward += amount;
        break;
    }
  });

  // Calculate win/loss counts and trade counts from unique trade results
  symbolMap.forEach((symbolData, symbol) => {
    const tradeResults = symbolTradeResults.get(symbol)!;
    symbolData.tradeCount = tradeResults.size;

    tradeResults.forEach(pnl => {
      if (pnl > 0) {
        symbolData.winCount++;
      } else if (pnl < 0) {
        symbolData.lossCount++;
      }
    });

    // Calculate net PnL
    symbolData.netPnl = symbolData.realizedPnl + symbolData.commission +
                        symbolData.fundingFee + symbolData.insuranceClear +
                        symbolData.marketMerchantReward + symbolData.apolloxRebate +
                        symbolData.usdfReward;

    // Calculate win rate
    symbolData.winRate = symbolData.tradeCount > 0
      ? (symbolData.winCount / symbolData.tradeCount) * 100
      : 0;
  });

  // Sort by net PnL descending (most profitable first)
  return Array.from(symbolMap.values()).sort((a, b) => b.netPnl - a.netPnl);
}

// NEW: Aggregate by symbol WITH REAL realized PnL from user trades
export async function aggregateBySymbolWithTrades(
  records: IncomeRecord[],
  credentials: ApiCredentials,
  symbols: string[],
  startTime: number,
  endTime: number
): Promise<SymbolPnL[]> {
  const symbolMap = new Map<string, SymbolPnL>();

  // First, initialize symbol data from income records (commission, funding, etc.)
  records.forEach(record => {
    const symbol = record.symbol || 'Account Rewards';
    const amount = parseFloat(record.income);

    if (!symbolMap.has(symbol)) {
      symbolMap.set(symbol, {
        symbol,
        tradeCount: 0,
        realizedPnl: 0,
        commission: 0,
        fundingFee: 0,
        insuranceClear: 0,
        marketMerchantReward: 0,
        apolloxRebate: 0,
        usdfReward: 0,
        netPnl: 0,
        winCount: 0,
        lossCount: 0,
        winRate: 0,
      });
    }

    const symbolData = symbolMap.get(symbol)!;

    switch (record.incomeType) {
      case 'COMMISSION':
        symbolData.commission += amount;
        break;
      case 'FUNDING_FEE':
        symbolData.fundingFee += amount;
        break;
      case 'INSURANCE_CLEAR':
        symbolData.insuranceClear += amount;
        break;
      case 'MARKET_MERCHANT_RETURN_REWARD':
        symbolData.marketMerchantReward += amount;
        break;
      case 'APOLLOX_DEX_REBATE':
        symbolData.apolloxRebate += amount;
        break;
      case 'USDF_BASE_REWARD':
        symbolData.usdfReward += amount;
        break;
    }
  });

  // Now fetch REAL realized PnL from user trades
  console.log(`[Per-Symbol] Fetching trades for ${symbols.length} symbols...`);

  // API limit: max 7 days per request
  const CHUNK_DAYS = 7;
  const CHUNK_MS = CHUNK_DAYS * 24 * 60 * 60 * 1000;

  const totalDays = Math.ceil((endTime - startTime) / (24 * 60 * 60 * 1000));
  const numChunks = Math.ceil(totalDays / CHUNK_DAYS);

  // Fetch trades for each symbol, in 7-day chunks
  for (const symbol of symbols) {
    try {
      const tradeResults = new Map<number, number>();

      // Split into 7-day chunks (API maximum window)
      for (let chunkIndex = 0; chunkIndex < numChunks; chunkIndex++) {
        const chunkStart = startTime + (chunkIndex * CHUNK_MS);
        const chunkEnd = Math.min(chunkStart + CHUNK_MS, endTime);

        try {
          const trades = await getUserTrades(symbol, credentials, {
            startTime: chunkStart,
            endTime: chunkEnd,
            limit: 1000,
          });

          // Aggregate realized PnL and count wins/losses
          trades.forEach(trade => {
            const pnl = parseFloat(trade.realizedPnl);

            // Only count each unique trade ID once
            if (!tradeResults.has(trade.id)) {
              tradeResults.set(trade.id, pnl);
            }
          });

          // Small delay to avoid rate limiting between chunks
          if (trades.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        } catch (err) {
          console.error(`[Per-Symbol] Error fetching ${symbol} chunk ${chunkIndex}:`, err);
        }
      }

      // Update symbol data with trade results
      if (!symbolMap.has(symbol)) {
        symbolMap.set(symbol, {
          symbol,
          tradeCount: 0,
          realizedPnl: 0,
          commission: 0,
          fundingFee: 0,
          insuranceClear: 0,
          marketMerchantReward: 0,
          apolloxRebate: 0,
          usdfReward: 0,
          netPnl: 0,
          winCount: 0,
          lossCount: 0,
          winRate: 0,
        });
      }

      const symbolData = symbolMap.get(symbol)!;
      symbolData.tradeCount = tradeResults.size;

      tradeResults.forEach((pnl) => {
        symbolData.realizedPnl += pnl;

        if (pnl > 0) {
          symbolData.winCount++;
        } else if (pnl < 0) {
          symbolData.lossCount++;
        }
      });

      console.log(`[Per-Symbol] ${symbol}: ${symbolData.tradeCount} trades, $${symbolData.realizedPnl.toFixed(2)} realized PnL`);
    } catch (err) {
      console.error(`[Per-Symbol] Error fetching ${symbol}:`, err);
    }
  }

  // Calculate final metrics for each symbol
  symbolMap.forEach((symbolData) => {
    // Calculate net PnL
    symbolData.netPnl = symbolData.realizedPnl + symbolData.commission +
                        symbolData.fundingFee + symbolData.insuranceClear +
                        symbolData.marketMerchantReward + symbolData.apolloxRebate +
                        symbolData.usdfReward;

    // Calculate win rate
    symbolData.winRate = symbolData.tradeCount > 0
      ? (symbolData.winCount / symbolData.tradeCount) * 100
      : 0;
  });

  // Sort by net PnL descending (most profitable first)
  return Array.from(symbolMap.values()).sort((a, b) => b.netPnl - a.netPnl);
}

// NEW: Fetch user trades with REAL realized PnL for all symbols (in 7-day chunks per API limit)
export async function getRealizedPnLFromTrades(
  credentials: ApiCredentials,
  symbols: string[],
  startTime: number,
  endTime: number
): Promise<Map<string, { date: string; realizedPnl: number; tradeCount: number }[]>> {
  const dailyPnLByDate = new Map<string, Map<string, { realizedPnl: number; tradeCount: number; tradeIds: Set<number> }>>();

  console.log(`[Trade PnL] Fetching trades for ${symbols.length} symbols in 7-day chunks...`);

  // API limit: max 7 days per request
  const CHUNK_DAYS = 7;
  const CHUNK_MS = CHUNK_DAYS * 24 * 60 * 60 * 1000;

  const totalDays = Math.ceil((endTime - startTime) / (24 * 60 * 60 * 1000));
  const numChunks = Math.ceil(totalDays / CHUNK_DAYS);
  console.log(`[Trade PnL] Time range: ${totalDays} days (${numChunks} chunks of ${CHUNK_DAYS} days)`);

  // Fetch trades for each symbol, in 7-day chunks
  for (const symbol of symbols) {
    console.log(`[Trade PnL] Fetching ${symbol}...`);

    let symbolTotalTrades = 0;

    try {
      // Split into 7-day chunks (API maximum window)
      for (let chunkIndex = 0; chunkIndex < numChunks; chunkIndex++) {
        const chunkStart = startTime + (chunkIndex * CHUNK_MS);
        const chunkEnd = Math.min(chunkStart + CHUNK_MS, endTime);

        try {
          const trades = await getUserTrades(symbol, credentials, {
            startTime: chunkStart,
            endTime: chunkEnd,
            limit: 1000,
          });

          symbolTotalTrades += trades.length;

          // Aggregate by date
          trades.forEach(trade => {
            const date = new Date(trade.time);
            const dateStr = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;

            if (!dailyPnLByDate.has(dateStr)) {
              dailyPnLByDate.set(dateStr, new Map());
            }

            const dayData = dailyPnLByDate.get(dateStr)!;

            if (!dayData.has(symbol)) {
              dayData.set(symbol, {
                realizedPnl: 0,
                tradeCount: 0,
                tradeIds: new Set(),
              });
            }

            const symbolDayData = dayData.get(symbol)!;

            // Only count each unique trade ID once
            if (!symbolDayData.tradeIds.has(trade.id)) {
              symbolDayData.realizedPnl += parseFloat(trade.realizedPnl);
              symbolDayData.tradeCount++;
              symbolDayData.tradeIds.add(trade.id);
            }
          });

          // Small delay to avoid rate limiting between chunks
          if (trades.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        } catch (chunkError) {
          console.error(`[Trade PnL] Error fetching ${symbol} chunk ${chunkIndex}:`, chunkError);
        }
      }

      console.log(`[Trade PnL] ${symbol}: ${symbolTotalTrades} total trades`);
    } catch (error) {
      console.error(`[Trade PnL] Error fetching trades for ${symbol}:`, error);
    }
  }

  // Convert to final structure
  const result = new Map<string, { date: string; realizedPnl: number; tradeCount: number }[]>();

  dailyPnLByDate.forEach((dayData, date) => {
    const dayArray: { date: string; realizedPnl: number; tradeCount: number }[] = [];

    dayData.forEach((data, _symbol) => {
      dayArray.push({
        date,
        realizedPnl: data.realizedPnl,
        tradeCount: data.tradeCount,
      });
    });

    result.set(date, dayArray);
  });

  console.log(`[Trade PnL] Aggregated ${dailyPnLByDate.size} days with trade data`);

  return result;
}

// UPDATED: Enhanced aggregation that includes REAL realized PnL from trades
export async function aggregateDailyPnLWithTrades(
  records: IncomeRecord[],
  credentials: ApiCredentials,
  symbols: string[],
  startTime: number,
  endTime: number
): Promise<DailyPnL[]> {
  // First, get traditional income data (commission, funding, etc.)
  const dailyMap = new Map<string, DailyPnL>();

  records.forEach(record => {
    const d = new Date(record.time);
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

    if (!dailyMap.has(date)) {
      dailyMap.set(date, {
        date,
        realizedPnl: 0,
        commission: 0,
        fundingFee: 0,
        insuranceClear: 0,
        marketMerchantReward: 0,
        apolloxRebate: 0,
        usdfReward: 0,
        netPnl: 0,
        tradeCount: 0,
      });
    }

    const daily = dailyMap.get(date)!;
    const amount = parseFloat(record.income);

    switch (record.incomeType) {
      case 'COMMISSION':
        daily.commission += amount;
        break;
      case 'FUNDING_FEE':
        daily.fundingFee += amount;
        break;
      case 'INSURANCE_CLEAR':
        daily.insuranceClear += amount;
        break;
      case 'MARKET_MERCHANT_RETURN_REWARD':
        daily.marketMerchantReward += amount;
        break;
      case 'APOLLOX_DEX_REBATE':
        daily.apolloxRebate += amount;
        break;
      case 'USDF_BASE_REWARD':
        daily.usdfReward += amount;
        break;
    }
  });

  // Now fetch REAL realized PnL from user trades
  const tradePnLByDate = await getRealizedPnLFromTrades(credentials, symbols, startTime, endTime);

  // Merge trade PnL into daily data
  tradePnLByDate.forEach((dayTrades, date) => {
    if (!dailyMap.has(date)) {
      dailyMap.set(date, {
        date,
        realizedPnl: 0,
        commission: 0,
        fundingFee: 0,
        insuranceClear: 0,
        marketMerchantReward: 0,
        apolloxRebate: 0,
        usdfReward: 0,
        netPnl: 0,
        tradeCount: 0,
      });
    }

    const daily = dailyMap.get(date)!;

    // Sum up realized PnL and trade counts from all symbols for this day
    dayTrades.forEach(symbolData => {
      daily.realizedPnl += symbolData.realizedPnl;
      daily.tradeCount += symbolData.tradeCount;
    });
  });

  // Calculate net PnL for each day
  dailyMap.forEach(daily => {
    daily.netPnl = daily.realizedPnl + daily.commission + daily.fundingFee +
                   daily.insuranceClear + daily.marketMerchantReward +
                   daily.apolloxRebate + daily.usdfReward;
  });

  const result = Array.from(dailyMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  console.log(`[Trade PnL] Final aggregation: ${result.length} days with realized PnL data`);

  return result;
}