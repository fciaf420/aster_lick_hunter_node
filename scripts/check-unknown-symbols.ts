import { getIncomeHistory } from '../src/lib/api/income.js';
import { loadConfig } from '../src/lib/bot/config.js';

async function checkUnknownSymbols() {
  const config = await loadConfig();
  const endTime = Date.now();
  const startTime = endTime - (7 * 24 * 60 * 60 * 1000);

  const records = await getIncomeHistory(config.api, { startTime, endTime });

  console.log('📊 Income records WITHOUT symbols:');
  const noSymbol = records.filter(r => !r.symbol);
  console.log('Total:', noSymbol.length);

  const grouped = noSymbol.reduce((acc, r) => {
    const type = r.incomeType;
    if (!acc[type]) acc[type] = { count: 0, total: 0 };
    acc[type].count++;
    acc[type].total += parseFloat(r.income);
    return acc;
  }, {} as Record<string, { count: number; total: number }>);

  console.log('\n🔍 Grouped by income type:');
  Object.entries(grouped).forEach(([type, data]) => {
    console.log(`  ${type}: ${data.count} records, Total: $${data.total.toFixed(2)}`);
  });

  console.log('\n📝 Sample records without symbols:');
  noSymbol.slice(0, 5).forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.incomeType}: ${r.income} ${r.asset} (${new Date(r.time).toISOString()})`);
  });
}

checkUnknownSymbols();
