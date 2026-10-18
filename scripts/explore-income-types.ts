import { getTimeRangeIncome } from '../src/lib/api/income';
import { configLoader } from '../src/lib/config/configLoader';

async function exploreIncomeTypes() {
  console.log('=== Exploring All Income Types ===\n');

  const config = await configLoader.loadConfig();

  if (!config.api?.apiKey || !config.api?.secretKey) {
    console.error('❌ API credentials not configured');
    return;
  }

  const credentials = {
    apiKey: config.api.apiKey,
    secretKey: config.api.secretKey,
  };

  console.log('Fetching income records for last 7 days...\n');
  const records = await getTimeRangeIncome(credentials, '7d');

  console.log(`✅ Total records: ${records.length}\n`);

  // Group by income type
  const typeMap = new Map<string, any[]>();
  records.forEach(r => {
    if (!typeMap.has(r.incomeType)) {
      typeMap.set(r.incomeType, []);
    }
    typeMap.get(r.incomeType)!.push(r);
  });

  console.log('📊 All income types found:\n');
  console.log('═'.repeat(80));

  Array.from(typeMap.entries()).sort((a, b) => b[1].length - a[1].length).forEach(([type, typeRecords]) => {
    const total = typeRecords.reduce((sum, r) => sum + parseFloat(r.income), 0);

    console.log(`\n🔹 ${type}`);
    console.log(`   Count: ${typeRecords.length} records`);
    console.log(`   Total: ${total.toFixed(6)} (mostly ${typeRecords[0].asset})`);

    // Show first 3 samples
    console.log(`   Samples:`);
    typeRecords.slice(0, 3).forEach((r, i) => {
      console.log(`     ${i + 1}. ${r.income} ${r.asset} - ${new Date(r.time).toISOString()}`);
      if (r.symbol) console.log(`        Symbol: ${r.symbol}`);
      if (r.info) console.log(`        Info: ${r.info}`);
    });
  });

  console.log('\n' + '═'.repeat(80));
  console.log('\n📝 Income types currently handled in code:');
  const handledTypes = [
    'REALIZED_PNL',
    'COMMISSION',
    'FUNDING_FEE',
    'INSURANCE_CLEAR',
    'MARKET_MERCHANT_RETURN_REWARD',
    'APOLLOX_DEX_REBATE',
    'USDF_BASE_REWARD'
  ];
  handledTypes.forEach(t => {
    const count = typeMap.get(t)?.length || 0;
    const status = count > 0 ? '✅' : '⚠️';
    console.log(`  ${status} ${t}: ${count} records`);
  });

  console.log('\n📝 Income types NOT currently handled:');
  Array.from(typeMap.keys()).forEach(type => {
    if (!handledTypes.includes(type)) {
      console.log(`  ❓ ${type}: ${typeMap.get(type)!.length} records`);
    }
  });
}

exploreIncomeTypes()
  .then(() => {
    console.log('\n✅ Exploration completed');
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
