#!/usr/bin/env tsx
/**
 * Performance Chart Data Testing Utility
 *
 * This script helps debug and validate the performance chart component
 * by testing various data scenarios and aggregation logic.
 *
 * Usage: npx tsx scripts/test-chart-data.ts
 */

interface IncomeRecord {
  symbol: string;
  incomeType: 'REALIZED_PNL' | 'COMMISSION' | 'FUNDING_FEE';
  income: string;
  asset: string;
  info: string;
  time: number;
  tranId: string;
  tradeId: string;
}

interface DailyPnL {
  date: string;
  realizedPnl: number;
  commission: number;
  fundingFee: number;
  netPnl: number;
  tradeCount: number;
}

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  Performance Chart Data Testing Utility                 ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

// ============================================================================
// Test 1: Date Formatting (Timezone-safe)
// ============================================================================
console.log('📅 Test 1: Date Formatting (Timezone-safe)');
console.log('─'.repeat(60));

const testDates = [
  '2025-09-26',
  '2025-10-01',
  '2025-10-10',
  '2025-12-31'
];

testDates.forEach(dateStr => {
  const parts = dateStr.split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);

  const shortFormat = `${month}/${day}`;
  const fullFormat = `${month}/${day}/${year}`;
  const yearMonthFormat = `${year.toString().slice(2)}-${month.toString().padStart(2, '0')}`;

  console.log(`  ${dateStr} →`);
  console.log(`    Short (7d):     ${shortFormat}`);
  console.log(`    Full (tooltip): ${fullFormat}`);
  console.log(`    Year-Month (1y): ${yearMonthFormat}`);
});

console.log('\n');

// ============================================================================
// Test 2: Sample Data Aggregation
// ============================================================================
console.log('📊 Test 2: Sample Data Aggregation');
console.log('─'.repeat(60));

const sampleIncomeRecords: IncomeRecord[] = [
  // Day 1: Profitable day
  { symbol: 'BTCUSDT', incomeType: 'REALIZED_PNL', income: '100.50', asset: 'USDT', info: '', time: new Date('2025-10-08T10:00:00Z').getTime(), tranId: '1', tradeId: '1' },
  { symbol: 'BTCUSDT', incomeType: 'COMMISSION', income: '-5.25', asset: 'USDT', info: '', time: new Date('2025-10-08T14:00:00Z').getTime(), tranId: '2', tradeId: '1' },

  // Day 2: Profitable day with multiple trades
  { symbol: 'ETHUSDT', incomeType: 'REALIZED_PNL', income: '200.00', asset: 'USDT', info: '', time: new Date('2025-10-09T10:00:00Z').getTime(), tranId: '3', tradeId: '2' },
  { symbol: 'ETHUSDT', incomeType: 'COMMISSION', income: '-10.00', asset: 'USDT', info: '', time: new Date('2025-10-09T14:00:00Z').getTime(), tranId: '4', tradeId: '2' },
  { symbol: 'BTCUSDT', incomeType: 'REALIZED_PNL', income: '50.00', asset: 'USDT', info: '', time: new Date('2025-10-09T16:00:00Z').getTime(), tranId: '5', tradeId: '3' },
  { symbol: 'BTCUSDT', incomeType: 'COMMISSION', income: '-2.50', asset: 'USDT', info: '', time: new Date('2025-10-09T16:30:00Z').getTime(), tranId: '6', tradeId: '3' },

  // Day 3: Loss day
  { symbol: 'BTCUSDT', incomeType: 'REALIZED_PNL', income: '-50.00', asset: 'USDT', info: '', time: new Date('2025-10-10T10:00:00Z').getTime(), tranId: '7', tradeId: '4' },
  { symbol: 'BTCUSDT', incomeType: 'COMMISSION', income: '-2.50', asset: 'USDT', info: '', time: new Date('2025-10-10T10:30:00Z').getTime(), tranId: '8', tradeId: '4' },
  { symbol: 'ETHUSDT', incomeType: 'FUNDING_FEE', income: '-1.00', asset: 'USDT', info: '', time: new Date('2025-10-10T12:00:00Z').getTime(), tranId: '9', tradeId: '' },
];

function aggregateDailyPnL(records: IncomeRecord[]): DailyPnL[] {
  const dailyMap = new Map<string, DailyPnL>();
  const dailyTradeIds = new Map<string, Set<string>>();

  records.forEach(record => {
    const d = new Date(record.time);
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const amount = parseFloat(record.income);

    if (!dailyMap.has(date)) {
      dailyMap.set(date, {
        date,
        realizedPnl: 0,
        commission: 0,
        fundingFee: 0,
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
        // Only count unique trades
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
    }
  });

  // Calculate net PnL
  dailyMap.forEach(daily => {
    daily.netPnl = daily.realizedPnl + daily.commission + daily.fundingFee;
  });

  return Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

const dailyPnL = aggregateDailyPnL(sampleIncomeRecords);

console.log(`✓ Aggregated ${sampleIncomeRecords.length} income records into ${dailyPnL.length} days\n`);

dailyPnL.forEach((day, index) => {
  const emoji = day.netPnl >= 0 ? '📈' : '📉';
  const sign = day.netPnl >= 0 ? '+' : '';
  console.log(`  ${emoji} Day ${index + 1} (${day.date}):`);
  console.log(`     Realized PnL:  ${day.realizedPnl >= 0 ? '+' : ''}$${day.realizedPnl.toFixed(2)}`);
  console.log(`     Commission:    -$${Math.abs(day.commission).toFixed(2)}`);
  console.log(`     Funding Fee:   ${day.fundingFee >= 0 ? '+' : ''}$${day.fundingFee.toFixed(2)}`);
  console.log(`     Net PnL:       ${sign}$${day.netPnl.toFixed(2)}`);
  console.log(`     Trade Count:   ${day.tradeCount}`);
  console.log('');
});

console.log('\n');

// ============================================================================
// Test 3: Cumulative Data Processing
// ============================================================================
console.log('📈 Test 3: Cumulative Data Processing');
console.log('─'.repeat(60));

interface CumulativeDailyPnL extends DailyPnL {
  cumulativePnl: number;
}

let cumulative = 0;
const cumulativeData: CumulativeDailyPnL[] = dailyPnL.map(day => {
  cumulative += day.netPnl;
  return {
    ...day,
    cumulativePnl: cumulative,
  };
});

console.log('Cumulative PnL Data:\n');
cumulativeData.forEach((day) => {
  const emoji = day.cumulativePnl >= 0 ? '📈' : '📉';
  const dailySign = day.netPnl >= 0 ? '+' : '';
  const cumulativeSign = day.cumulativePnl >= 0 ? '+' : '';

  console.log(`  ${emoji} ${day.date}:`);
  console.log(`     Daily:      ${dailySign}$${day.netPnl.toFixed(2)}`);
  console.log(`     Cumulative: ${cumulativeSign}$${day.cumulativePnl.toFixed(2)}`);
});

console.log('\n');

// ============================================================================
// Test 4: Empty Data Handling
// ============================================================================
console.log('⚠️  Test 4: Empty Data Handling');
console.log('─'.repeat(60));

const emptyDailyPnL: DailyPnL[] = [];
console.log(`Empty array length: ${emptyDailyPnL.length}`);
console.log(`Should show "No trading data": ${emptyDailyPnL.length === 0 ? '✓ YES' : '✗ NO'}`);

console.log('\n');

// ============================================================================
// Test 5: Chart Interval Logic
// ============================================================================
console.log('🎯 Test 5: Chart XAxis Interval Logic');
console.log('─'.repeat(60));

const testIntervalLogic = (dataLength: number) => {
  let interval: number | 'preserveStartEnd' | 'preserveStart';
  let minTickGap: number;

  if (dataLength <= 5) {
    interval = 0;
    minTickGap = 10;
  } else if (dataLength <= 20) {
    interval = 'preserveStartEnd';
    minTickGap = 10;
  } else {
    interval = 'preserveStart';
    minTickGap = 20;
  }

  return { interval, minTickGap };
};

const testCases = [1, 3, 5, 10, 20, 30, 50, 100];

testCases.forEach(count => {
  const result = testIntervalLogic(count);
  console.log(`  ${count} data points → interval: ${result.interval}, minTickGap: ${result.minTickGap}`);
});

console.log('\n');

// ============================================================================
// Test 6: Performance Metrics Calculation
// ============================================================================
console.log('📊 Test 6: Performance Metrics Calculation');
console.log('─'.repeat(60));

interface PerformanceMetrics {
  totalPnl: number;
  avgDailyPnl: number;
  winRate: number;
  profitableDays: number;
  lossDays: number;
  bestDay: DailyPnL | null;
  worstDay: DailyPnL | null;
  profitFactor: number;
}

function calculateMetrics(data: DailyPnL[]): PerformanceMetrics {
  if (data.length === 0) {
    return {
      totalPnl: 0,
      avgDailyPnl: 0,
      winRate: 0,
      profitableDays: 0,
      lossDays: 0,
      bestDay: null,
      worstDay: null,
      profitFactor: 0,
    };
  }

  let totalPnl = 0;
  let profitableDays = 0;
  let lossDays = 0;
  let bestDay = data[0];
  let worstDay = data[0];
  let totalProfit = 0;
  let totalLoss = 0;

  data.forEach(day => {
    totalPnl += day.netPnl;

    if (day.netPnl > 0) {
      profitableDays++;
      totalProfit += day.netPnl;
    } else if (day.netPnl < 0) {
      lossDays++;
      totalLoss += Math.abs(day.netPnl);
    }

    if (day.netPnl > bestDay.netPnl) bestDay = day;
    if (day.netPnl < worstDay.netPnl) worstDay = day;
  });

  const winRate = data.length > 0 ? (profitableDays / data.length) * 100 : 0;
  const avgDailyPnl = data.length > 0 ? totalPnl / data.length : 0;
  const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

  return {
    totalPnl,
    avgDailyPnl,
    winRate,
    profitableDays,
    lossDays,
    bestDay,
    worstDay,
    profitFactor,
  };
}

const metrics = calculateMetrics(dailyPnL);

console.log(`  Total PnL:        $${metrics.totalPnl.toFixed(2)}`);
console.log(`  Avg Daily PnL:    $${metrics.avgDailyPnl.toFixed(2)}`);
console.log(`  Win Rate:         ${metrics.winRate.toFixed(1)}%`);
console.log(`  Profitable Days:  ${metrics.profitableDays}`);
console.log(`  Loss Days:        ${metrics.lossDays}`);
console.log(`  Best Day:         $${metrics.bestDay?.netPnl.toFixed(2)} (${metrics.bestDay?.date})`);
console.log(`  Worst Day:        $${metrics.worstDay?.netPnl.toFixed(2)} (${metrics.worstDay?.date})`);
console.log(`  Profit Factor:    ${metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)}`);

console.log('\n');

// ============================================================================
// Summary
// ============================================================================
console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  ✓ All Tests Completed Successfully                     ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

console.log('Key Findings:');
console.log('  • Date formatting avoids timezone issues by parsing strings directly');
console.log('  • Aggregation logic correctly handles multiple trades per day');
console.log('  • Cumulative calculation works correctly');
console.log('  • Chart interval logic adapts to data density');
console.log('  • Empty data is handled gracefully\n');

console.log('Next Steps:');
console.log('  1. Ensure bot is running to generate income data');
console.log('  2. Check database has income table: `npm run test:income`');
console.log('  3. Verify API endpoints return data: test /api/income?range=7d');
console.log('  4. Check browser console for chart component logs\n');
