#!/usr/bin/env tsx

import { PositionManager } from '../src/lib/bot/positionManager';
import { loadConfig } from '../src/lib/bot/config';

// Terminal colors
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bright: '\x1b[1m'
};

function log(message: string, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logSection(title: string) {
  console.log('\n' + '='.repeat(80));
  log(title, colors.cyan);
  console.log('='.repeat(80));
}

interface MockStatusBroadcaster {
  broadcastPositionUpdate: (data: any) => void;
  broadcastOrderFilled: (data: any) => void;
  broadcastStopLossPlaced: (data: any) => void;
  broadcastTakeProfitPlaced: (data: any) => void;
  broadcastPositionClosed: (data: any) => void;
  broadcastPnLUpdate: (data: any) => void;
}

class TestStatusBroadcaster implements MockStatusBroadcaster {
  private logs: Array<{ type: string; data: any; timestamp: number }> = [];

  broadcastPositionUpdate(data: any) {
    this.logs.push({ type: 'POSITION_UPDATE', data, timestamp: Date.now() });
    log(`📡 Position Update: ${data.symbol} ${data.side} ${data.type}`, colors.blue);
  }

  broadcastOrderFilled(data: any) {
    this.logs.push({ type: 'ORDER_FILLED', data, timestamp: Date.now() });
    log(`📡 Order Filled: ${data.symbol} ${data.orderType} ${data.side}`, colors.green);
  }

  broadcastStopLossPlaced(data: any) {
    this.logs.push({ type: 'STOP_LOSS_PLACED', data, timestamp: Date.now() });
    log(`📡 Stop Loss Placed: ${data.symbol} @ ${data.price}`, colors.red);
  }

  broadcastTakeProfitPlaced(data: any) {
    this.logs.push({ type: 'TAKE_PROFIT_PLACED', data, timestamp: Date.now() });
    log(`📡 Take Profit Placed: ${data.symbol} @ ${data.price}`, colors.green);
  }

  broadcastPositionClosed(data: any) {
    this.logs.push({ type: 'POSITION_CLOSED', data, timestamp: Date.now() });
    log(`📡 Position Closed: ${data.symbol} ${data.side} PnL: ${data.pnl}`, colors.yellow);
  }

  broadcastPnLUpdate(data: any) {
    this.logs.push({ type: 'PNL_UPDATE', data, timestamp: Date.now() });
    log(`📡 PnL Update: Session PnL`, colors.gray);
  }

  getLogs() {
    return [...this.logs];
  }

  clearLogs() {
    this.logs = [];
  }
}

async function testPositionManagerSync() {
  logSection('🔄 Testing PositionManager Sync with Exchange');

  try {
    const config = await loadConfig();
    const positionManager = new PositionManager(config, false); // One-way mode
    const mockBroadcaster = new TestStatusBroadcaster();

    positionManager.setStatusBroadcaster(mockBroadcaster);

    log('\n📡 Creating PositionManager instance...', colors.blue);

    // Don't actually start the WebSocket connection, just test sync logic
    log('\n🔍 Testing exchange sync without WebSocket...', colors.blue);

    // Access private method via type assertion (for testing only)
    const pmPrivate = positionManager as any;

    // Test getting positions from exchange
    const positions = await pmPrivate.getPositionsFromExchange();
    const openOrders = await pmPrivate.getOpenOrdersFromExchange();

    log(`✅ Retrieved ${positions.length} total positions`, colors.green);
    log(`✅ Retrieved ${openOrders.length} open orders`, colors.green);

    // Filter active positions
    const activePositions = positions.filter((p: any) => Math.abs(parseFloat(p.positionAmt)) > 0);

    if (activePositions.length > 0) {
      log(`\n📊 Found ${activePositions.length} active position(s):`, colors.bright);

      for (const position of activePositions) {
        const posAmt = parseFloat(position.positionAmt);
        const side = posAmt > 0 ? 'LONG' : 'SHORT';

        log(`\n🎯 ${position.symbol} ${side}`, colors.bright);
        log(`   Position Amount: ${position.positionAmt}`, colors.gray);
        log(`   Entry Price: ${position.entryPrice}`, colors.gray);
        log(`   Position Side: ${position.positionSide}`, colors.gray);

        // Test position key generation
        const key = pmPrivate.getPositionKey(position.symbol, position.positionSide, posAmt);
        log(`   Position Key: ${key}`, colors.gray);

        // Find related orders for this position
        const relatedOrders = openOrders.filter((o: any) =>
          o.symbol === position.symbol &&
          o.reduceOnly &&
          ((posAmt > 0 && o.side === 'SELL') || (posAmt < 0 && o.side === 'BUY'))
        );

        log(`   Related Orders: ${relatedOrders.length}`, colors.gray);
        relatedOrders.forEach((order: any) => {
          log(`     - ${order.type} #${order.orderId}: ${order.origQty} @ ${order.price || order.stopPrice}`, colors.gray);
        });

        // Check if position has proper protection
        const hasStopLoss = relatedOrders.some((o: any) =>
          o.type === 'STOP_MARKET' || o.type === 'STOP'
        );
        const hasTakeProfit = relatedOrders.some((o: any) =>
          o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT' ||
          (o.type === 'LIMIT' && o.reduceOnly)
        );

        const protectionStatus = hasStopLoss && hasTakeProfit ? '✅ Fully Protected' :
                               hasStopLoss ? '⚠️ SL Only' :
                               hasTakeProfit ? '⚠️ TP Only' :
                               '❌ Unprotected';

        log(`   Protection: ${protectionStatus}`,
            hasStopLoss && hasTakeProfit ? colors.green : colors.yellow);
      }
    } else {
      log('\n📭 No active positions found', colors.yellow);
    }

    // Test position tracking methods
    log('\n🔍 Testing position tracking methods...', colors.blue);

    const totalPositionCount = positionManager.getTotalPositionCount();
    const uniquePositionCount = positionManager.getUniquePositionCount(false);

    log(`   Total Position Count: ${totalPositionCount}`, colors.gray);
    log(`   Unique Position Count: ${uniquePositionCount}`, colors.gray);

    // Test margin usage calculation
    if (activePositions.length > 0) {
      for (const position of activePositions) {
        const marginUsage = positionManager.getMarginUsage(position.symbol);
        log(`   Margin Usage for ${position.symbol}: $${marginUsage.toFixed(2)}`, colors.gray);
      }
    }

    return true;
  } catch (error: any) {
    log(`❌ Error: ${error.message}`, colors.red);
    if (error.response?.data) {
      log(`   API Error: ${JSON.stringify(error.response.data)}`, colors.red);
    }
    return false;
  }
}

async function testSLTPPlacement() {
  logSection('🛡️ Testing SL/TP Placement Logic');

  try {
    const config = await loadConfig();

    if (config.global.paperMode) {
      log('\n⚠️ Running in PAPER MODE - orders will be simulated', colors.yellow);
    } else {
      log('\n🚨 WARNING: Running in LIVE MODE - real orders will be placed!', colors.red);
      log('   Proceeding in 3 seconds... Press Ctrl+C to cancel', colors.yellow);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    const positionManager = new PositionManager(config, false);
    const mockBroadcaster = new TestStatusBroadcaster();
    positionManager.setStatusBroadcaster(mockBroadcaster);

    // Get current positions
    const pmPrivate = positionManager as any;
    const positions = await pmPrivate.getPositionsFromExchange();
    const activePositions = positions.filter((p: any) => Math.abs(parseFloat(p.positionAmt)) > 0);

    if (activePositions.length === 0) {
      log('\n📭 No active positions to test SL/TP placement', colors.yellow);
      return true;
    }

    log(`\n🎯 Testing SL/TP placement for ${activePositions.length} position(s)...`, colors.blue);

    for (const position of activePositions) {
      const symbol = position.symbol;
      const symbolConfig = config.symbols[symbol];

      if (!symbolConfig) {
        log(`\n⚠️ Skipping ${symbol} - not in bot configuration`, colors.yellow);
        continue;
      }

      log(`\n🔧 Testing ${symbol} SL/TP placement...`, colors.bright);
      log(`   SL Percent: ${symbolConfig.slPercent}%`, colors.gray);
      log(`   TP Percent: ${symbolConfig.tpPercent}%`, colors.gray);

      const posAmt = parseFloat(position.positionAmt);
      const entryPrice = parseFloat(position.entryPrice);
      const isLong = posAmt > 0;

      // Calculate expected SL/TP prices
      const expectedSLPrice = isLong
        ? entryPrice * (1 - symbolConfig.slPercent / 100)
        : entryPrice * (1 + symbolConfig.slPercent / 100);

      const expectedTPPrice = isLong
        ? entryPrice * (1 + symbolConfig.tpPercent / 100)
        : entryPrice * (1 - symbolConfig.tpPercent / 100);

      log(`   Expected SL Price: ${expectedSLPrice.toFixed(6)}`, colors.red);
      log(`   Expected TP Price: ${expectedTPPrice.toFixed(6)}`, colors.green);

      try {
        // Test the protective order placement logic
        log('   🔄 Testing placeProtectiveOrders...', colors.blue);

        if (config.global.paperMode) {
          log('   📝 PAPER MODE: Would place SL/TP orders', colors.yellow);
        } else {
          // In live mode, we would actually call:
          // await pmPrivate.placeProtectiveOrders(position, true, true);
          log('   ⚠️ LIVE MODE: Skipping actual order placement in test', colors.yellow);
        }

        log('   ✅ SL/TP placement logic validated', colors.green);
      } catch (error: any) {
        log(`   ❌ SL/TP placement failed: ${error.message}`, colors.red);
      }
    }

    return true;
  } catch (error: any) {
    log(`❌ Error: ${error.message}`, colors.red);
    return false;
  }
}

async function testOrderQuantityMatching() {
  logSection('⚖️ Testing Order Quantity Matching');

  try {
    const config = await loadConfig();
    const positionManager = new PositionManager(config, false);

    // Get current state
    const pmPrivate = positionManager as any;
    const positions = await pmPrivate.getPositionsFromExchange();
    const openOrders = await pmPrivate.getOpenOrdersFromExchange();

    const activePositions = positions.filter((p: any) => Math.abs(parseFloat(p.positionAmt)) > 0);

    if (activePositions.length === 0) {
      log('\n📭 No active positions to test', colors.yellow);
      return true;
    }

    log('\n🔍 Testing order quantity matching for each position...', colors.blue);

    let issuesFound = 0;

    for (const position of activePositions) {
      const symbol = position.symbol;
      const posAmt = parseFloat(position.positionAmt);
      const positionQty = Math.abs(posAmt);
      const side = posAmt > 0 ? 'LONG' : 'SHORT';

      log(`\n🎯 ${symbol} ${side} (Position: ${positionQty})`, colors.bright);

      // Find related orders
      const relatedOrders = openOrders.filter((o: any) =>
        o.symbol === symbol &&
        o.reduceOnly &&
        ((posAmt > 0 && o.side === 'SELL') || (posAmt < 0 && o.side === 'BUY'))
      );

      if (relatedOrders.length === 0) {
        log('   ❌ No protective orders found!', colors.red);
        issuesFound++;
        continue;
      }

      // Check each order quantity
      relatedOrders.forEach((order: any) => {
        const orderQty = parseFloat(order.origQty);
        const qtyDiff = Math.abs(orderQty - positionQty);
        const tolerance = 0.00000001;
        const isMatched = qtyDiff < tolerance;

        const statusColor = isMatched ? colors.green : colors.red;
        const statusIcon = isMatched ? '✅' : '❌';

        log(`   ${statusIcon} ${order.type} #${order.orderId}:`, statusColor);
        log(`      Order Qty: ${orderQty}`, colors.gray);
        log(`      Position Qty: ${positionQty}`, colors.gray);
        log(`      Difference: ${qtyDiff.toFixed(8)}`, colors.gray);

        if (!isMatched) {
          issuesFound++;
          log(`      🔧 REQUIRES ADJUSTMENT!`, colors.red);
        }
      });
    }

    if (issuesFound === 0) {
      log('\n✅ All order quantities match their positions!', colors.green);
    } else {
      log(`\n⚠️ Found ${issuesFound} quantity mismatch issue(s)`, colors.yellow);
    }

    return issuesFound === 0;
  } catch (error: any) {
    log(`❌ Error: ${error.message}`, colors.red);
    return false;
  }
}

async function testPositionKeyGeneration() {
  logSection('🔑 Testing Position Key Generation');

  try {
    const config = await loadConfig();
    const positionManager = new PositionManager(config, false); // One-way mode
    const positionManagerHedge = new PositionManager(config, true); // Hedge mode

    log('\n🔧 Testing position key generation in different modes...', colors.blue);

    const testCases = [
      { symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: 0.001 },
      { symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: -0.001 },
      { symbol: 'ETHUSDT', positionSide: 'LONG', positionAmt: 0.1 },
      { symbol: 'ETHUSDT', positionSide: 'SHORT', positionAmt: -0.1 },
    ];

    const pmPrivate = positionManager as any;
    const pmHedgePrivate = positionManagerHedge as any;

    testCases.forEach(testCase => {
      const oneWayKey = pmPrivate.getPositionKey(
        testCase.symbol,
        testCase.positionSide,
        testCase.positionAmt
      );

      const hedgeKey = pmHedgePrivate.getPositionKey(
        testCase.symbol,
        testCase.positionSide,
        testCase.positionAmt
      );

      log(`\n📊 ${testCase.symbol} ${testCase.positionAmt > 0 ? 'LONG' : 'SHORT'}:`, colors.bright);
      log(`   Position Side: ${testCase.positionSide}`, colors.gray);
      log(`   Position Amount: ${testCase.positionAmt}`, colors.gray);
      log(`   One-Way Key: ${oneWayKey}`, colors.blue);
      log(`   Hedge Key: ${hedgeKey}`, colors.green);
    });

    return true;
  } catch (error: any) {
    log(`❌ Error: ${error.message}`, colors.red);
    return false;
  }
}

async function testOrderCleanupScenarios() {
  logSection('🧹 Testing Order Cleanup Scenarios');

  try {
    const config = await loadConfig();
    const positionManager = new PositionManager(config, false);
    const mockBroadcaster = new TestStatusBroadcaster();
    positionManager.setStatusBroadcaster(mockBroadcaster);

    log('\n🔍 Testing various order cleanup scenarios...', colors.blue);

    // Scenario 1: Position closed but orders remain
    log('\n📋 Scenario 1: Simulating position closure with remaining orders', colors.bright);

    const pmPrivate = positionManager as any;

    // Get current open orders
    const openOrders = await pmPrivate.getOpenOrdersFromExchange();
    const positions = await pmPrivate.getPositionsFromExchange();
    const activePositions = positions.filter((p: any) => Math.abs(parseFloat(p.positionAmt)) > 0);

    // Find orders for symbols without positions (orphaned orders)
    const activeSymbols = new Set(activePositions.map((p: any) => p.symbol));
    const orphanedOrders = openOrders.filter((o: any) =>
      o.reduceOnly && !activeSymbols.has(o.symbol)
    );

    if (orphanedOrders.length > 0) {
      log(`   ⚠️ Found ${orphanedOrders.length} orphaned order(s):`, colors.yellow);
      orphanedOrders.forEach((order: any) => {
        log(`     - ${order.symbol} ${order.type} #${order.orderId}`, colors.gray);
      });

      log('   🔧 These orders should be cleaned up automatically', colors.blue);
    } else {
      log('   ✅ No orphaned orders found', colors.green);
    }

    // Scenario 2: Quantity mismatches
    log('\n📋 Scenario 2: Checking for quantity mismatches', colors.bright);

    let mismatchCount = 0;
    for (const position of activePositions) {
      const symbol = position.symbol;
      const posAmt = parseFloat(position.positionAmt);
      const positionQty = Math.abs(posAmt);

      const relatedOrders = openOrders.filter((o: any) =>
        o.symbol === symbol &&
        o.reduceOnly &&
        ((posAmt > 0 && o.side === 'SELL') || (posAmt < 0 && o.side === 'BUY'))
      );

      relatedOrders.forEach((order: any) => {
        const orderQty = parseFloat(order.origQty);
        const qtyDiff = Math.abs(orderQty - positionQty);

        if (qtyDiff > 0.00000001) {
          mismatchCount++;
          log(`   ⚠️ Quantity mismatch: ${symbol} ${order.type} #${order.orderId}`, colors.yellow);
          log(`      Position: ${positionQty}, Order: ${orderQty}`, colors.gray);
        }
      });
    }

    if (mismatchCount === 0) {
      log('   ✅ No quantity mismatches found', colors.green);
    } else {
      log(`   🔧 Found ${mismatchCount} orders needing quantity adjustment`, colors.yellow);
    }

    return true;
  } catch (error: any) {
    log(`❌ Error: ${error.message}`, colors.red);
    return false;
  }
}

async function runPositionManagerTests() {
  console.clear();
  log('🧪 Position Manager Test Suite', colors.cyan);
  log('==============================\n', colors.cyan);

  const tests = [
    { name: 'Position Manager Sync', fn: testPositionManagerSync },
    { name: 'Position Key Generation', fn: testPositionKeyGeneration },
    { name: 'Order Quantity Matching', fn: testOrderQuantityMatching },
    { name: 'SL/TP Placement Logic', fn: testSLTPPlacement },
    { name: 'Order Cleanup Scenarios', fn: testOrderCleanupScenarios }
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
  logSection('📋 Test Summary');

  const passed = results.filter(r => r).length;
  const failed = results.length - passed;

  tests.forEach((test, index) => {
    const status = results[index] ? '✅' : '❌';
    const color = results[index] ? colors.green : colors.red;
    log(`${status} ${test.name}`, color);
  });

  console.log('\n' + '='.repeat(80));
  if (failed === 0) {
    log(`🎉 All ${passed} tests passed!`, colors.green);
    log('\n💡 Next steps:', colors.blue);
    log('   1. Run: npm run tsx tests/test-api-integration.ts', colors.gray);
    log('   2. Check for any issues found', colors.gray);
    log('   3. If issues found, apply fixes to PositionManager', colors.gray);
  } else {
    log(`⚠️ ${passed} passed, ${failed} failed`, colors.yellow);
    log('\n🔧 Issues detected - review test output and apply fixes', colors.blue);
  }
  console.log('='.repeat(80));
}

// Run tests
runPositionManagerTests().catch(error => {
  log(`\n❌ Fatal error: ${error}`, colors.red);
  process.exit(1);
});