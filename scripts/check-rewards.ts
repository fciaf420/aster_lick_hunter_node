import { getTimeRangeIncome } from '../src/lib/api/income';
import { configLoader } from '../src/lib/config/configLoader';

async function checkRewards() {
  console.log('=== Checking for Referral Rewards ===\n');

  const config = await configLoader.loadConfig();

  if (!config.api?.apiKey || !config.api?.secretKey) {
    console.error('❌ API credentials not configured');
    return;
  }

  const credentials = {
    apiKey: config.api.apiKey,
    secretKey: config.api.secretKey,
  };

  console.log('Fetching income records for last 30 days...\n');
  const records = await getTimeRangeIncome(credentials, '30d');

  console.log(`✅ Total income records: ${records.length}\n`);

  // Check for reward records
  const rewardRecords = records.filter(r => r.incomeType === 'MARKET_MERCHANT_RETURN_REWARD');

  console.log(`🎁 MARKET_MERCHANT_RETURN_REWARD records: ${rewardRecords.length}\n`);

  if (rewardRecords.length > 0) {
    console.log('Sample reward records:\n');
    rewardRecords.slice(0, 5).forEach((r, i) => {
      console.log(`${i + 1}. Symbol: ${r.symbol}, Amount: ${r.income} ${r.asset}, Time: ${new Date(r.time).toISOString()}`);
      console.log(`   Info: ${r.info}\n`);
    });

    const totalRewards = rewardRecords.reduce((sum, r) => sum + parseFloat(r.income), 0);
    console.log(`💰 Total rewards (30d): $${totalRewards.toFixed(4)} USDT`);
  } else {
    console.log('⚠️  No MARKET_MERCHANT_RETURN_REWARD records found in last 30 days\n');

    // Show what income types we DO have
    const incomeTypes = new Map<string, number>();
    records.forEach(r => {
      incomeTypes.set(r.incomeType, (incomeTypes.get(r.incomeType) || 0) + 1);
    });

    console.log('Income types present:');
    Array.from(incomeTypes.entries()).forEach(([type, count]) => {
      console.log(`  - ${type}: ${count} records`);
    });

    // Show AUTO_EXCHANGE details
    const autoExchange = records.filter(r => r.incomeType === 'AUTO_EXCHANGE');
    if (autoExchange.length > 0) {
      console.log('\n📊 AUTO_EXCHANGE records (might be related to rewards):');
      autoExchange.forEach((r, i) => {
        console.log(`\n${i + 1}. Amount: ${r.income} ${r.asset}`);
        console.log(`   Symbol: ${r.symbol}`);
        console.log(`   Time: ${new Date(r.time).toISOString()}`);
        console.log(`   Info: ${r.info}`);
        console.log(`   TransID: ${r.tranId}`);
      });
    }

    // Show REALIZED_PNL from income API (we know this doesn't work well)
    const realizedPnl = records.filter(r => r.incomeType === 'REALIZED_PNL');
    if (realizedPnl.length > 0) {
      console.log(`\n💰 REALIZED_PNL in income API: ${realizedPnl.length} records`);
      console.log('   (We fetch this from /userTrades instead)');
    }
  }
}

checkRewards()
  .then(() => {
    console.log('\n✅ Check completed');
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
