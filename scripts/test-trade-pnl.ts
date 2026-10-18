import { getUserTrades } from '../src/lib/api/market';
import { configLoader } from '../src/lib/config/configLoader';
import { aggregateDailyPnLWithTrades, getTimeRangeIncome } from '../src/lib/api/income';

async function testTradePnL() {
  console.log('=== Testing User Trades API for Realized PnL (7-day chunks) ===\n');

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

  // Fetch income records to discover all symbols that have been traded
  console.log('🔍 Discovering symbols from income history...\n');
  const incomeRecords = await getTimeRangeIncome(credentials, '7d');
  const symbolsFromIncome = Array.from(new Set(incomeRecords.map(r => r.symbol).filter(s => s)));

  console.log(`📊 Found ${symbolsFromIncome.length} symbols with trading activity: ${symbolsFromIncome.join(', ')}\n`);

  const symbols = symbolsFromIncome;

  // Test with 7 days (API maximum per request)
  const now = Date.now();
  const startTime = now - 7 * 24 * 60 * 60 * 1000; // Last 7 days

  console.log('--- Testing Single Symbol (7-day chunk) ---\n');

  if (symbols.length > 0) {
    const testSymbol = symbols[0];
    console.log(`Testing ${testSymbol} for last 7 days...\n`);

    try {
      const trades = await getUserTrades(testSymbol, credentials, {
        startTime,
        endTime: now,
        limit: 1000,
      });

      console.log(`✅ ${trades.length} trades fetched in single 7-day request`);

      if (trades.length > 0) {
        const totalPnl = trades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
        console.log(`💰 Total Realized PnL: $${totalPnl.toFixed(2)}`);

        // Show daily breakdown
        const dailyPnl = new Map<string, number>();
        const dailyCount = new Map<string, number>();

        trades.forEach(trade => {
          const date = new Date(trade.time);
          const dateStr = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;

          dailyPnl.set(dateStr, (dailyPnl.get(dateStr) || 0) + parseFloat(trade.realizedPnl));
          dailyCount.set(dateStr, (dailyCount.get(dateStr) || 0) + 1);
        });

        console.log(`\n📅 Daily breakdown:`);
        Array.from(dailyPnl.keys()).sort().forEach(date => {
          console.log(`  ${date}: ${dailyCount.get(date)} trades, $${dailyPnl.get(date)?.toFixed(2)}`);
        });
      }

    } catch (error) {
      console.error(`❌ Error:`, error);
    }
  }

  console.log('');

  // Test the full aggregation function
  console.log('=== Testing Full Aggregation (7 days) ===\n');

  try {
    const records = await getTimeRangeIncome(credentials, '7d');
    console.log(`✅ Fetched ${records.length} income records`);

    console.log('\nAggregating with trades (this will fetch trades in 7-day chunks)...\n');

    const dailyPnL = await aggregateDailyPnLWithTrades(
      records,
      credentials,
      symbols,
      startTime,
      now
    );

    console.log(`\n✅ Aggregated ${dailyPnL.length} days of data\n`);

    if (dailyPnL.length > 0) {
      console.log('Results:');
      dailyPnL.forEach(day => {
        console.log(`\n${day.date}:`);
        console.log(`  Realized PnL: $${day.realizedPnl.toFixed(2)}`);
        console.log(`  Commission: $${day.commission.toFixed(2)}`);
        console.log(`  Funding Fee: $${day.fundingFee.toFixed(2)}`);
        console.log(`  Net PnL: $${day.netPnl.toFixed(2)}`);
        console.log(`  Trades: ${day.tradeCount}`);
      });

      const totalRealizedPnL = dailyPnL.reduce((sum, day) => sum + day.realizedPnl, 0);
      const totalNetPnL = dailyPnL.reduce((sum, day) => sum + day.netPnl, 0);
      const totalTrades = dailyPnL.reduce((sum, day) => sum + day.tradeCount, 0);

      console.log(`\n✅ ✅ ✅ SUCCESS! ✅ ✅ ✅`);
      console.log(`   Total Realized PnL: $${totalRealizedPnL.toFixed(2)}`);
      console.log(`   Total Net PnL: $${totalNetPnL.toFixed(2)}`);
      console.log(`   Total Trades: ${totalTrades}`);
    } else {
      console.log('⚠️  No data for the selected time range');
    }
  } catch (error) {
    console.error('❌ Error in aggregation:', error);
    if (error instanceof Error) {
      console.error('Stack:', error.stack);
    }
  }
}

testTradePnL()
  .then(() => {
    console.log('\n✅ Test completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
