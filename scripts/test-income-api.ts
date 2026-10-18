import { getTimeRangeIncome, aggregateDailyPnL } from '../src/lib/api/income';
import { configLoader } from '../src/lib/config/configLoader';

async function testIncomeAPI() {
  console.log('=== Testing Income API ===\n');

  // Load config
  const config = await configLoader.loadConfig();

  if (!config.api || !config.api.apiKey || !config.api.secretKey) {
    console.error('❌ API credentials not configured');
    return;
  }

  const credentials = {
    apiKey: config.api.apiKey,
    secretKey: config.api.secretKey,
  };

  console.log('✅ API credentials loaded\n');

  // Test fetching income for different ranges
  const ranges: Array<'24h' | '7d' | '30d'> = ['24h', '7d', '30d'];

  for (const range of ranges) {
    console.log(`\n--- Testing ${range} range ---`);

    try {
      const records = await getTimeRangeIncome(credentials, range);

      console.log(`Total records fetched: ${records.length}`);

      if (records.length > 0) {
        // Group by income type
        const byType = records.reduce((acc, record) => {
          acc[record.incomeType] = (acc[record.incomeType] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);

        console.log('\nBreakdown by income type:');
        Object.entries(byType).forEach(([type, count]) => {
          console.log(`  ${type}: ${count} records`);
        });

        // Show first few REALIZED_PNL records
        const realizedPnlRecords = records.filter(r => r.incomeType === 'REALIZED_PNL');
        console.log(`\nREALIZED_PNL records: ${realizedPnlRecords.length}`);

        if (realizedPnlRecords.length > 0) {
          console.log('\nFirst 3 REALIZED_PNL records:');
          realizedPnlRecords.slice(0, 3).forEach(record => {
            const date = new Date(record.time);
            console.log(`  Date: ${date.toISOString()}`);
            console.log(`  Symbol: ${record.symbol}`);
            console.log(`  Income: ${record.income}`);
            console.log(`  TradeId: ${record.tradeId}`);
            console.log('  ---');
          });
        }

        // Aggregate daily
        const dailyPnL = aggregateDailyPnL(records);
        console.log(`\nDaily aggregation: ${dailyPnL.length} days`);

        if (dailyPnL.length > 0) {
          console.log('\nLast 3 days:');
          dailyPnL.slice(-3).forEach(day => {
            console.log(`  ${day.date}:`);
            console.log(`    Realized PnL: $${day.realizedPnl.toFixed(2)}`);
            console.log(`    Commission: $${day.commission.toFixed(2)}`);
            console.log(`    Funding Fee: $${day.fundingFee.toFixed(2)}`);
            console.log(`    Net PnL: $${day.netPnl.toFixed(2)}`);
            console.log(`    Trades: ${day.tradeCount}`);
          });
        }
      } else {
        console.log('⚠️  No income records found for this range');
      }
    } catch (error) {
      console.error(`❌ Error fetching ${range}:`, error);
      if (error instanceof Error) {
        console.error('Error details:', error.message);
      }
    }
  }
}

testIncomeAPI().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
