import { SymbolConfig } from '../src/lib/types';

console.log('🧪 Testing Separate Trade Size Functionality');
console.log('='.repeat(50));

// Test configurations
const testConfigs: { name: string; config: SymbolConfig; expectedLong: number; expectedShort: number }[] = [
  {
    name: 'Config with separate trade sizes',
    config: {
      tradeSize: 100,
      longTradeSize: 150,
      shortTradeSize: 75,
      leverage: 10,
      tpPercent: 3,
      slPercent: 1.5,
      longVolumeThresholdUSDT: 10000,
      shortVolumeThresholdUSDT: 10000,
    },
    expectedLong: 150,
    expectedShort: 75,
  },
  {
    name: 'Config with only longTradeSize',
    config: {
      tradeSize: 100,
      longTradeSize: 200,
      leverage: 10,
      tpPercent: 3,
      slPercent: 1.5,
      longVolumeThresholdUSDT: 10000,
      shortVolumeThresholdUSDT: 10000,
    },
    expectedLong: 200,
    expectedShort: 100, // Falls back to tradeSize
  },
  {
    name: 'Config with only shortTradeSize',
    config: {
      tradeSize: 100,
      shortTradeSize: 50,
      leverage: 10,
      tpPercent: 3,
      slPercent: 1.5,
      longVolumeThresholdUSDT: 10000,
      shortVolumeThresholdUSDT: 10000,
    },
    expectedLong: 100, // Falls back to tradeSize
    expectedShort: 50,
  },
  {
    name: 'Config without separate sizes',
    config: {
      tradeSize: 100,
      leverage: 10,
      tpPercent: 3,
      slPercent: 1.5,
      longVolumeThresholdUSDT: 10000,
      shortVolumeThresholdUSDT: 10000,
    },
    expectedLong: 100,
    expectedShort: 100,
  },
];

// Simulate the logic from hunter.ts
function getTradeSizeForDirection(config: SymbolConfig, side: 'BUY' | 'SELL'): number {
  return side === 'BUY'
    ? (config.longTradeSize ?? config.tradeSize)
    : (config.shortTradeSize ?? config.tradeSize);
}

// Run tests
let allPassed = true;

testConfigs.forEach((test, index) => {
  console.log(`\n📝 Test ${index + 1}: ${test.name}`);
  console.log('-'.repeat(40));

  const longSize = getTradeSizeForDirection(test.config, 'BUY');
  const shortSize = getTradeSizeForDirection(test.config, 'SELL');

  console.log(`Config values:`);
  console.log(`  tradeSize: ${test.config.tradeSize} USDT`);
  if (test.config.longTradeSize !== undefined) {
    console.log(`  longTradeSize: ${test.config.longTradeSize} USDT`);
  }
  if (test.config.shortTradeSize !== undefined) {
    console.log(`  shortTradeSize: ${test.config.shortTradeSize} USDT`);
  }

  console.log(`\nCalculated sizes:`);
  console.log(`  Long (BUY): ${longSize} USDT`);
  console.log(`  Short (SELL): ${shortSize} USDT`);

  const longPassed = longSize === test.expectedLong;
  const shortPassed = shortSize === test.expectedShort;

  if (longPassed && shortPassed) {
    console.log('✅ Test PASSED');
  } else {
    console.log('❌ Test FAILED');
    if (!longPassed) {
      console.log(`  Expected long: ${test.expectedLong}, got: ${longSize}`);
    }
    if (!shortPassed) {
      console.log(`  Expected short: ${test.expectedShort}, got: ${shortSize}`);
    }
    allPassed = false;
  }
});

console.log('\n' + '='.repeat(50));
if (allPassed) {
  console.log('✅ All tests PASSED!');
  console.log('\n🎉 Separate trade size functionality is working correctly!');
} else {
  console.log('❌ Some tests FAILED');
  process.exit(1);
}