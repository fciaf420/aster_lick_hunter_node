#!/usr/bin/env tsx

import { getOrderBook, getBookTicker, getMarkPrice } from '../src/lib/api/market';
import { calculateOptimalPrice, validateOrderParams, analyzeOrderBookDepth, getSymbolFilters } from '../src/lib/api/pricing';
import { loadConfig } from '../src/lib/bot/config';

// Terminal colors
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

function log(message: string, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logSection(title: string) {
  console.log('\n' + '='.repeat(60));
  log(title, colors.cyan);
  console.log('='.repeat(60));
}

async function testOrderBookFetching() {
  logSection('Testing Order Book Fetching');

  try {
    // Test with ASTERUSDT
    const symbol = 'ASTERUSDT';
    log(`\nFetching order book for ${symbol}...`, colors.blue);

    const orderBook = await getOrderBook(symbol, 5);

    if (orderBook && orderBook.bids && orderBook.asks) {
      log('✅ Order book fetched successfully', colors.green);
      log(`Best Bid: ${orderBook.bids[0][0]} @ ${orderBook.bids[0][1]}`, colors.gray);
      log(`Best Ask: ${orderBook.asks[0][0]} @ ${orderBook.asks[0][1]}`, colors.gray);

      // Calculate spread
      const spread = parseFloat(orderBook.asks[0][0]) - parseFloat(orderBook.bids[0][0]);
      const spreadBps = (spread / parseFloat(orderBook.bids[0][0])) * 10000;
      log(`Spread: ${spread.toFixed(4)} (${spreadBps.toFixed(2)} bps)`, colors.gray);
    } else {
      log('❌ Failed to fetch order book', colors.red);
    }

    // Test book ticker
    log(`\nFetching book ticker for ${symbol}...`, colors.blue);
    const bookTicker = await getBookTicker(symbol);

    if (bookTicker) {
      log('✅ Book ticker fetched successfully', colors.green);
      log(`Bid: ${bookTicker.bidPrice} x ${bookTicker.bidQty}`, colors.gray);
      log(`Ask: ${bookTicker.askPrice} x ${bookTicker.askQty}`, colors.gray);
    } else {
      log('❌ Failed to fetch book ticker', colors.red);
    }

    return true;
  } catch (error) {
    log(`❌ Error: ${error}`, colors.red);
    return false;
  }
}

async function testOptimalPriceCalculation() {
  logSection('Testing Optimal Price Calculation');

  try {
    const symbol = 'ASTERUSDT';

    // Test BUY side
    log(`\nCalculating optimal BUY price for ${symbol}...`, colors.blue);
    const buyPrice = await calculateOptimalPrice(symbol, 'BUY', 2, false);

    if (buyPrice) {
      log(`✅ Optimal BUY price: ${buyPrice}`, colors.green);

      // Get current mark price for comparison
      const markPriceData = await getMarkPrice(symbol);
      const markPrice = parseFloat(Array.isArray(markPriceData) ? markPriceData[0].markPrice : markPriceData.markPrice);
      const buyDiff = ((buyPrice - markPrice) / markPrice) * 10000;
      log(`  Mark price: ${markPrice}`, colors.gray);
      log(`  Difference: ${buyDiff.toFixed(2)} bps`, colors.gray);
    } else {
      log('❌ Failed to calculate optimal BUY price', colors.red);
    }

    // Test SELL side
    log(`\nCalculating optimal SELL price for ${symbol}...`, colors.blue);
    const sellPrice = await calculateOptimalPrice(symbol, 'SELL', 2, false);

    if (sellPrice) {
      log(`✅ Optimal SELL price: ${sellPrice}`, colors.green);

      const markPriceData = await getMarkPrice(symbol);
      const markPrice = parseFloat(Array.isArray(markPriceData) ? markPriceData[0].markPrice : markPriceData.markPrice);
      const sellDiff = ((sellPrice - markPrice) / markPrice) * 10000;
      log(`  Mark price: ${markPrice}`, colors.gray);
      log(`  Difference: ${sellDiff.toFixed(2)} bps`, colors.gray);
    } else {
      log('❌ Failed to calculate optimal SELL price', colors.red);
    }

    // Test Post-Only mode
    log(`\nCalculating Post-Only BUY price for ${symbol}...`, colors.blue);
    const postOnlyPrice = await calculateOptimalPrice(symbol, 'BUY', 2, true);

    if (postOnlyPrice) {
      log(`✅ Post-Only BUY price: ${postOnlyPrice}`, colors.green);
      log('  (Guaranteed maker order)', colors.gray);
    }

    return true;
  } catch (error) {
    log(`❌ Error: ${error}`, colors.red);
    return false;
  }
}

async function testSymbolFilterValidation() {
  logSection('Testing Symbol Filter Validation');

  try {
    const symbol = 'ASTERUSDT';

    log(`\nFetching symbol filters for ${symbol}...`, colors.blue);
    const symbolInfo = await getSymbolFilters(symbol);

    if (symbolInfo) {
      log('✅ Symbol filters fetched', colors.green);

      const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
      const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
      const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');

      if (priceFilter) {
        log('\nPrice Filter:', colors.yellow);
        log(`  Min Price: ${priceFilter.minPrice}`, colors.gray);
        log(`  Max Price: ${priceFilter.maxPrice}`, colors.gray);
        log(`  Tick Size: ${priceFilter.tickSize}`, colors.gray);
      }

      if (lotSizeFilter) {
        log('\nLot Size Filter:', colors.yellow);
        log(`  Min Qty: ${lotSizeFilter.minQty}`, colors.gray);
        log(`  Max Qty: ${lotSizeFilter.maxQty}`, colors.gray);
        log(`  Step Size: ${lotSizeFilter.stepSize}`, colors.gray);
      }

      if (minNotionalFilter) {
        log('\nMin Notional Filter:', colors.yellow);
        log(`  Min Notional: ${minNotionalFilter.notional}`, colors.gray);
      }

      // Test validation with sample order
      log(`\nValidating sample order parameters...`, colors.blue);
      const validation = await validateOrderParams(symbol, 'BUY', 1.234567, 0.999999);

      if (validation.valid) {
        log('✅ Order validation passed', colors.green);
        log(`  Adjusted Price: ${validation.adjustedPrice}`, colors.gray);
        log(`  Adjusted Quantity: ${validation.adjustedQuantity}`, colors.gray);
      } else {
        log(`❌ Order validation failed: ${validation.error}`, colors.red);
      }
    } else {
      log('❌ Failed to fetch symbol filters', colors.red);
    }

    return true;
  } catch (error) {
    log(`❌ Error: ${error}`, colors.red);
    return false;
  }
}

async function testOrderBookDepthAnalysis() {
  logSection('Testing Order Book Depth Analysis');

  try {
    const symbol = 'ASTERUSDT';
    const targetNotional = 1000; // $1000 USDT

    log(`\nAnalyzing BUY side liquidity for ${symbol}...`, colors.blue);
    log(`Target notional: $${targetNotional}`, colors.gray);

    const buyAnalysis = await analyzeOrderBookDepth(symbol, 'BUY', targetNotional);

    log('\nBUY Side Analysis:', colors.yellow);
    log(`  Average Price: ${buyAnalysis.avgPrice.toFixed(4)}`, colors.gray);
    log(`  Price Impact: ${buyAnalysis.priceImpact.toFixed(2)}%`, colors.gray);
    log(`  Liquidity OK: ${buyAnalysis.liquidityOk ? '✅' : '❌'}`, buyAnalysis.liquidityOk ? colors.green : colors.red);

    log(`\nAnalyzing SELL side liquidity for ${symbol}...`, colors.blue);

    const sellAnalysis = await analyzeOrderBookDepth(symbol, 'SELL', targetNotional);

    log('\nSELL Side Analysis:', colors.yellow);
    log(`  Average Price: ${sellAnalysis.avgPrice.toFixed(4)}`, colors.gray);
    log(`  Price Impact: ${sellAnalysis.priceImpact.toFixed(2)}%`, colors.gray);
    log(`  Liquidity OK: ${sellAnalysis.liquidityOk ? '✅' : '❌'}`, sellAnalysis.liquidityOk ? colors.green : colors.red);

    return true;
  } catch (error) {
    log(`❌ Error: ${error}`, colors.red);
    return false;
  }
}

async function testLimitOrderPlacement() {
  logSection('Testing Limit Order Placement (PAPER MODE)');

  try {
    const config = await loadConfig();

    if (!config.global.paperMode) {
      log('⚠️  Skipping live order test - not in paper mode', colors.yellow);
      log('Set paperMode: true in config.json to test order placement', colors.gray);
      return true;
    }

    const symbol = 'ASTERUSDT';
    const symbolConfig = config.symbols[symbol];

    if (!symbolConfig) {
      log(`❌ No configuration found for ${symbol}`, colors.red);
      return false;
    }

    log(`\nPreparing LIMIT order for ${symbol}...`, colors.blue);
    log(`Configuration:`, colors.yellow);
    log(`  Trade Size: ${symbolConfig.tradeSize}`, colors.gray);
    log(`  Leverage: ${symbolConfig.leverage}x`, colors.gray);
    log(`  Price Offset: ${symbolConfig.priceOffsetBps || 2} bps`, colors.gray);
    log(`  Post-Only: ${symbolConfig.usePostOnly || false}`, colors.gray);
    log(`  Max Slippage: ${symbolConfig.maxSlippageBps || 50} bps`, colors.gray);

    // Calculate optimal price
    const side = 'BUY';
    const optimalPrice = await calculateOptimalPrice(
      symbol,
      side,
      symbolConfig.priceOffsetBps || 2,
      symbolConfig.usePostOnly || false
    );

    if (!optimalPrice) {
      log('❌ Failed to calculate optimal price', colors.red);
      return false;
    }

    log(`\n✅ Calculated optimal ${side} price: ${optimalPrice}`, colors.green);

    // Validate order parameters
    const validation = await validateOrderParams(symbol, side, optimalPrice, symbolConfig.tradeSize);

    if (!validation.valid) {
      log(`❌ Order validation failed: ${validation.error}`, colors.red);
      return false;
    }

    log('✅ Order parameters validated', colors.green);
    log(`  Final Price: ${validation.adjustedPrice}`, colors.gray);
    log(`  Final Quantity: ${validation.adjustedQuantity}`, colors.gray);

    // Simulate order object
    const orderParams = {
      symbol,
      side: side as 'BUY' | 'SELL',
      type: 'LIMIT' as const,
      price: validation.adjustedPrice,
      quantity: validation.adjustedQuantity!,
      timeInForce: (symbolConfig.usePostOnly ? 'GTX' : 'GTC') as 'GTC' | 'GTX',
      positionSide: 'BOTH' as const
    };

    log('\n📋 Order Details:', colors.cyan);
    log(JSON.stringify(orderParams, null, 2), colors.gray);

    log('\n✅ PAPER MODE: Order would be placed successfully', colors.green);

    return true;
  } catch (error) {
    log(`❌ Error: ${error}`, colors.red);
    return false;
  }
}

async function runAllTests() {
  console.clear();
  log('🚀 Starting Limit Order System Tests', colors.cyan);
  log('=====================================\n', colors.cyan);

  const tests = [
    { name: 'Order Book Fetching', fn: testOrderBookFetching },
    { name: 'Optimal Price Calculation', fn: testOptimalPriceCalculation },
    { name: 'Symbol Filter Validation', fn: testSymbolFilterValidation },
    { name: 'Order Book Depth Analysis', fn: testOrderBookDepthAnalysis },
    { name: 'Limit Order Placement', fn: testLimitOrderPlacement }
  ];

  const results: boolean[] = [];

  for (const test of tests) {
    try {
      const result = await test.fn();
      results.push(result);
    } catch (error) {
      log(`\n❌ Test "${test.name}" failed with error: ${error}`, colors.red);
      results.push(false);
    }
  }

  // Summary
  logSection('Test Summary');

  const passed = results.filter(r => r).length;
  const failed = results.length - passed;

  tests.forEach((test, index) => {
    const status = results[index] ? '✅' : '❌';
    const color = results[index] ? colors.green : colors.red;
    log(`${status} ${test.name}`, color);
  });

  console.log('\n' + '='.repeat(60));
  if (failed === 0) {
    log(`🎉 All ${passed} tests passed!`, colors.green);
  } else {
    log(`⚠️  ${passed} passed, ${failed} failed`, colors.yellow);
  }
  console.log('='.repeat(60));
}

// Run tests
runAllTests().catch(error => {
  log(`\n❌ Fatal error: ${error}`, colors.red);
  process.exit(1);
});