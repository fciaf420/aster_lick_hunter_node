#!/usr/bin/env tsx

import { liquidationStorage } from '../src/lib/services/liquidationStorage';
import { cleanupScheduler } from '../src/lib/services/cleanupScheduler';
import { LiquidationEvent } from '../src/lib/types';

async function testLiquidationStorage() {
  console.log('🧪 Testing Liquidation Storage System...\n');

  try {
    // Test 1: Save a liquidation
    console.log('📝 Test 1: Saving liquidation event...');
    const mockLiquidation: LiquidationEvent = {
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      quantity: 0.5,
      price: 45000,
      averagePrice: 45000,
      orderStatus: 'FILLED',
      orderLastFilledQuantity: 0.5,
      orderFilledAccumulatedQuantity: 0.5,
      orderTradeTime: Date.now(),
      eventTime: Date.now(),
      qty: 0.5,
      time: Date.now(),
    };

    const volumeUSDT = mockLiquidation.quantity * mockLiquidation.price;
    await liquidationStorage.saveLiquidation(mockLiquidation, volumeUSDT);
    console.log('✅ Liquidation saved successfully\n');

    // Test 2: Save multiple liquidations
    console.log('📝 Test 2: Saving multiple liquidations...');
    const symbols = ['ETHUSDT', 'BTCUSDT', 'SOLUSDT', 'BNBUSDT'];
    const sides: ('BUY' | 'SELL')[] = ['BUY', 'SELL'];

    for (let i = 0; i < 10; i++) {
      const symbol = symbols[Math.floor(Math.random() * symbols.length)];
      const side = sides[Math.floor(Math.random() * sides.length)];
      const price = symbol === 'BTCUSDT' ? 40000 + Math.random() * 10000 :
                   symbol === 'ETHUSDT' ? 2000 + Math.random() * 1000 :
                   symbol === 'SOLUSDT' ? 50 + Math.random() * 50 :
                   300 + Math.random() * 100;
      const quantity = Math.random() * 5;

      const liquidation: LiquidationEvent = {
        symbol,
        side,
        orderType: 'MARKET',
        quantity,
        price,
        averagePrice: price,
        orderStatus: 'FILLED',
        orderLastFilledQuantity: quantity,
        orderFilledAccumulatedQuantity: quantity,
        orderTradeTime: Date.now() - (i * 60000), // Space them out by 1 minute
        eventTime: Date.now() - (i * 60000),
        qty: quantity,
        time: Date.now() - (i * 60000),
      };

      await liquidationStorage.saveLiquidation(liquidation, quantity * price);
    }
    console.log('✅ Multiple liquidations saved\n');

    // Test 3: Query liquidations
    console.log('📖 Test 3: Querying liquidations...');
    const allLiquidations = await liquidationStorage.getLiquidations({ limit: 5 });
    console.log(`Found ${allLiquidations.total} total liquidations`);
    console.log(`Showing first ${allLiquidations.liquidations.length} liquidations:`);

    allLiquidations.liquidations.forEach((liq, i) => {
      console.log(`  ${i + 1}. ${liq.symbol} ${liq.side} - ${liq.quantity} @ $${liq.price} (${liq.volume_usdt.toFixed(2)} USDT)`);
    });
    console.log();

    // Test 4: Query by symbol
    console.log('🔍 Test 4: Querying liquidations by symbol...');
    const btcLiquidations = await liquidationStorage.getLiquidations({
      symbol: 'BTCUSDT',
      limit: 10
    });
    console.log(`Found ${btcLiquidations.total} BTCUSDT liquidations\n`);

    // Test 5: Get statistics
    console.log('📊 Test 5: Getting liquidation statistics...');
    const stats = await liquidationStorage.getStatistics(86400); // 24 hours
    console.log('24-hour statistics:');
    console.log(`  Total liquidations: ${stats.total_count}`);
    console.log(`  Total volume: ${stats.total_volume_usdt?.toFixed(2)} USDT`);
    console.log(`  Average volume: ${stats.avg_volume_usdt?.toFixed(2)} USDT`);
    console.log(`  Max volume: ${stats.max_volume_usdt?.toFixed(2)} USDT`);

    if (stats.symbols.length > 0) {
      console.log('  Top symbols by volume:');
      stats.symbols.forEach((sym, i) => {
        console.log(`    ${i + 1}. ${sym.symbol}: ${sym.count} liquidations, ${sym.volume_usdt.toFixed(2)} USDT`);
      });
    }
    console.log();

    // Test 6: Get recent liquidations
    console.log('🕐 Test 6: Getting recent liquidations...');
    const recent = await liquidationStorage.getRecentLiquidations(5);
    console.log(`Most recent ${recent.length} liquidations:`);
    recent.forEach((liq, i) => {
      const timeAgo = Math.floor((Date.now() - liq.event_time) / 60000);
      console.log(`  ${i + 1}. ${liq.symbol} ${liq.side} - ${timeAgo} minutes ago`);
    });
    console.log();

    // Test 7: Test cleanup (simulate old data)
    console.log('🧹 Test 7: Testing cleanup scheduler...');
    console.log('Running cleanup once (should not delete recent data)...');
    await cleanupScheduler.runOnce();

    const afterCleanup = await liquidationStorage.getLiquidations();
    console.log(`Liquidations after cleanup: ${afterCleanup.total}`);
    console.log();

    console.log('✅ All tests completed successfully!');
    console.log('\n📌 Note: The database is now populated with test data.');
    console.log('   You can query it via the API endpoints:');
    console.log('   - GET /api/liquidations');
    console.log('   - GET /api/liquidations/stats');

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }

  process.exit(0);
}

testLiquidationStorage();