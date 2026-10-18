import { getIncomeHistory } from '../src/lib/api/income.js';
import { loadConfig } from '../src/lib/bot/config.js';

async function checkRebateSymbols() {
  const config = await loadConfig();
  const endTime = Date.now();
  const startTime = endTime - (7 * 24 * 60 * 60 * 1000);

  console.log('[Income API] Fetching income history for 7d...');
  const records = await getIncomeHistory(config.api, { startTime, endTime });

  const rebates = records.filter(r => r.incomeType === 'APOLLOX_DEX_REBATE');
  const usdfRewards = records.filter(r => r.incomeType === 'USDF_BASE_REWARD');

  console.log('\n📊 APOLLOX_DEX_REBATE Analysis:');
  console.log(`Total rebate records: ${rebates.length}`);

  const withSymbol = rebates.filter(r => r.symbol);
  const withoutSymbol = rebates.filter(r => !r.symbol);

  console.log(`  With symbol: ${withSymbol.length} records`);
  console.log(`  Without symbol: ${withoutSymbol.length} records`);

  const totalWithSymbol = withSymbol.reduce((sum, r) => sum + parseFloat(r.income), 0);
  const totalWithoutSymbol = withoutSymbol.reduce((sum, r) => sum + parseFloat(r.income), 0);
  const totalRebates = rebates.reduce((sum, r) => sum + parseFloat(r.income), 0);

  console.log(`\n💰 Totals:`);
  console.log(`  With symbol: $${totalWithSymbol.toFixed(2)}`);
  console.log(`  Without symbol: $${totalWithoutSymbol.toFixed(2)}`);
  console.log(`  Total rebates: $${totalRebates.toFixed(2)}`);

  if (withSymbol.length > 0) {
    console.log(`\n🔍 Sample rebates WITH symbols:`);
    withSymbol.slice(0, 5).forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.symbol}: ${r.income} ${r.asset} (${new Date(r.time).toISOString()})`);
    });
  }

  console.log('\n📊 USDF_BASE_REWARD Analysis:');
  console.log(`Total USDF reward records: ${usdfRewards.length}`);
  const totalUsdf = usdfRewards.reduce((sum, r) => sum + parseFloat(r.income), 0);
  console.log(`Total USDF rewards: $${totalUsdf.toFixed(2)}`);
  usdfRewards.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.symbol || 'NO SYMBOL'}: ${r.income} ${r.asset} (${new Date(r.time).toISOString()})`);
  });

  console.log(`\n✅ Total account-level income (UNKNOWN): $${(totalWithoutSymbol + totalUsdf).toFixed(2)}`);
}

checkRebateSymbols();
