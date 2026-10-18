#!/usr/bin/env tsx

import { getPositionRisk, getOpenOrders } from '../src/lib/api/market';
import { loadConfig } from '../src/lib/bot/config';
import { cancelOrder } from '../src/lib/api/orders';

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

interface ExchangePosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  marginType: string;
  isolatedMargin: string;
  isAutoAddMargin: string;
  positionSide: string;
  updateTime: number;
}

interface ExchangeOrder {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  price: string;
  origQty: string;
  executedQty: string;
  status: string;
  type: string;
  side: string;
  stopPrice: string;
  time: number;
  updateTime: number;
  workingType: string;
  origType: string;
  positionSide: string;
  reduceOnly: boolean;
}

async function getCurrentState() {
  logSection('📊 Current Account State Analysis');

  try {
    const config = await loadConfig();
    const credentials = config.api;

    // Get current positions
    log('\n🔍 Fetching current positions...', colors.blue);
    const positions: ExchangePosition[] = await getPositionRisk(undefined, credentials);
    const activePositions = positions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);

    if (activePositions.length > 0) {
      log(`\n✅ Found ${activePositions.length} active position(s):`, colors.green);
      activePositions.forEach(p => {
        const posAmt = parseFloat(p.positionAmt);
        const side = posAmt > 0 ? 'LONG' : 'SHORT';
        const pnl = parseFloat(p.unRealizedProfit);
        const pnlColor = pnl >= 0 ? colors.green : colors.red;

        log(`\n📈 ${p.symbol} ${side}`, colors.bright);
        log(`   Position Size: ${Math.abs(posAmt)}`, colors.gray);
        log(`   Entry Price: $${parseFloat(p.entryPrice).toFixed(4)}`, colors.gray);
        log(`   Mark Price: $${parseFloat(p.markPrice).toFixed(4)}`, colors.gray);
        log(`   Unrealized PnL: $${pnl.toFixed(2)}`, pnlColor);
        log(`   Leverage: ${p.leverage}x`, colors.gray);
        log(`   Position Side: ${p.positionSide}`, colors.gray);
      });
    } else {
      log('\n📭 No active positions found', colors.yellow);
    }

    // Get open orders
    log('\n🔍 Fetching open orders...', colors.blue);
    const openOrders: ExchangeOrder[] = await getOpenOrders(undefined, credentials);

    if (openOrders.length > 0) {
      log(`\n✅ Found ${openOrders.length} open order(s):`, colors.green);

      // Group orders by symbol
      const ordersBySymbol: Record<string, ExchangeOrder[]> = {};
      openOrders.forEach(order => {
        if (!ordersBySymbol[order.symbol]) {
          ordersBySymbol[order.symbol] = [];
        }
        ordersBySymbol[order.symbol].push(order);
      });

      Object.keys(ordersBySymbol).forEach(symbol => {
        log(`\n📋 ${symbol} Orders:`, colors.bright);
        ordersBySymbol[symbol].forEach(order => {
          const typeColor = order.type.includes('STOP') ? colors.red :
                           order.type.includes('TAKE_PROFIT') || order.type === 'LIMIT' ? colors.green :
                           colors.yellow;

          log(`   🎯 Order #${order.orderId}`, colors.gray);
          log(`      Type: ${order.type}`, typeColor);
          log(`      Side: ${order.side}`, colors.gray);
          log(`      Quantity: ${order.origQty}`, colors.gray);
          log(`      Price: ${order.price || 'N/A'}`, colors.gray);
          log(`      Stop Price: ${order.stopPrice || 'N/A'}`, colors.gray);
          log(`      Reduce Only: ${order.reduceOnly}`, colors.gray);
          log(`      Status: ${order.status}`, colors.gray);
          log(`      Position Side: ${order.positionSide}`, colors.gray);
        });
      });
    } else {
      log('\n📭 No open orders found', colors.yellow);
    }

    return { positions: activePositions, orders: openOrders, config };
  } catch (error: any) {
    log(`❌ Error fetching account state: ${error.message}`, colors.red);
    if (error.response?.data) {
      log(`   API Error: ${JSON.stringify(error.response.data)}`, colors.red);
    }
    throw error;
  }
}

async function analyzePositionProtection() {
  logSection('🛡️ Position Protection Analysis');

  try {
    const { positions, orders, config } = await getCurrentState();

    if (positions.length === 0) {
      log('\n⚠️ No positions to analyze', colors.yellow);
      return;
    }

    log('\n🔍 Analyzing each position for SL/TP protection...', colors.blue);

    for (const position of positions) {
      const symbol = position.symbol;
      const posAmt = parseFloat(position.positionAmt);
      const positionQty = Math.abs(posAmt);
      const isLong = posAmt > 0;
      const side = isLong ? 'LONG' : 'SHORT';

      log(`\n🎯 Analyzing ${symbol} ${side} (${positionQty})`, colors.bright);

      // Find related orders
      const relatedOrders = orders.filter(o => o.symbol === symbol);

      if (relatedOrders.length === 0) {
        log(`   ❌ NO PROTECTIVE ORDERS FOUND!`, colors.red);
        continue;
      }

      // Find SL orders
      const slOrders = relatedOrders.filter(o =>
        (o.type === 'STOP_MARKET' || o.type === 'STOP') &&
        o.reduceOnly &&
        ((isLong && o.side === 'SELL') || (!isLong && o.side === 'BUY'))
      );

      // Find TP orders
      const tpOrders = relatedOrders.filter(o =>
        (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT' || o.type === 'LIMIT') &&
        o.reduceOnly &&
        ((isLong && o.side === 'SELL') || (!isLong && o.side === 'BUY'))
      );

      // Analyze SL protection
      if (slOrders.length === 0) {
        log(`   ❌ NO STOP LOSS ORDERS!`, colors.red);
      } else {
        log(`   ✅ Found ${slOrders.length} Stop Loss order(s):`, colors.green);
        slOrders.forEach(sl => {
          const slQty = parseFloat(sl.origQty);
          const qtyMatch = Math.abs(slQty - positionQty) < 0.00000001;
          const qtyColor = qtyMatch ? colors.green : colors.red;

          log(`      📍 SL #${sl.orderId}: ${sl.origQty} @ ${sl.stopPrice}`, colors.gray);
          log(`      📊 Quantity Match: ${qtyMatch ? '✅' : '❌'} (Position: ${positionQty}, Order: ${slQty})`, qtyColor);
        });
      }

      // Analyze TP protection
      if (tpOrders.length === 0) {
        log(`   ❌ NO TAKE PROFIT ORDERS!`, colors.red);
      } else {
        log(`   ✅ Found ${tpOrders.length} Take Profit order(s):`, colors.green);
        tpOrders.forEach(tp => {
          const tpQty = parseFloat(tp.origQty);
          const qtyMatch = Math.abs(tpQty - positionQty) < 0.00000001;
          const qtyColor = qtyMatch ? colors.green : colors.red;

          log(`      📍 TP #${tp.orderId}: ${tp.origQty} @ ${tp.price}`, colors.gray);
          log(`      📊 Quantity Match: ${qtyMatch ? '✅' : '❌'} (Position: ${positionQty}, Order: ${tpQty})`, qtyColor);
        });
      }

      // Check symbol configuration
      const symbolConfig = config.symbols[symbol];
      if (!symbolConfig) {
        log(`   ⚠️ Symbol ${symbol} not in bot configuration`, colors.yellow);
      } else {
        log(`   ✅ Symbol configured - SL: ${symbolConfig.slPercent}%, TP: ${symbolConfig.tpPercent}%`, colors.green);
      }
    }
  } catch (error: any) {
    log(`❌ Error analyzing position protection: ${error.message}`, colors.red);
    throw error;
  }
}

async function findOrphanedOrders() {
  logSection('🧹 Orphaned Orders Detection');

  try {
    const { positions, orders } = await getCurrentState();

    log('\n🔍 Searching for orphaned orders...', colors.blue);

    // Get all symbols with active positions
    const activeSymbols = new Set(positions.map(p => p.symbol));

    // Find orders for symbols without positions
    const orphanedOrders = orders.filter(order => {
      // Only consider reduce-only orders (SL/TP type orders)
      if (!order.reduceOnly) return false;

      // Check if this symbol has an active position
      return !activeSymbols.has(order.symbol);
    });

    if (orphanedOrders.length === 0) {
      log('\n✅ No orphaned orders found', colors.green);
      return { orphanedOrders: [] };
    }

    log(`\n⚠️ Found ${orphanedOrders.length} orphaned order(s):`, colors.yellow);

    const orphansBySymbol: Record<string, ExchangeOrder[]> = {};
    orphanedOrders.forEach(order => {
      if (!orphansBySymbol[order.symbol]) {
        orphansBySymbol[order.symbol] = [];
      }
      orphansBySymbol[order.symbol].push(order);
    });

    Object.keys(orphansBySymbol).forEach(symbol => {
      log(`\n🧹 ${symbol} (No Position):`, colors.bright);
      orphansBySymbol[symbol].forEach(order => {
        const ageHours = (Date.now() - order.time) / (1000 * 60 * 60);
        log(`   🗑️ Order #${order.orderId}`, colors.red);
        log(`      Type: ${order.type} ${order.side}`, colors.gray);
        log(`      Quantity: ${order.origQty}`, colors.gray);
        log(`      Price: ${order.price || order.stopPrice || 'N/A'}`, colors.gray);
        log(`      Age: ${ageHours.toFixed(1)} hours`, colors.gray);
      });
    });

    return { orphanedOrders };
  } catch (error: any) {
    log(`❌ Error finding orphaned orders: ${error.message}`, colors.red);
    throw error;
  }
}

async function cleanupOrphanedOrders(dryRun: boolean = true) {
  logSection('🧽 Orphaned Orders Cleanup');

  try {
    const { orphanedOrders } = await findOrphanedOrders();

    if (orphanedOrders.length === 0) {
      log('\n✅ No orphaned orders to clean up', colors.green);
      return;
    }

    if (dryRun) {
      log(`\n🔍 DRY RUN: Would cancel ${orphanedOrders.length} orphaned order(s)`, colors.yellow);
      orphanedOrders.forEach(order => {
        log(`   Would cancel: ${order.symbol} Order #${order.orderId} (${order.type})`, colors.gray);
      });
      log('\n💡 Run with --live flag to actually cancel these orders', colors.blue);
      return;
    }

    const config = await loadConfig();
    const credentials = config.api;

    log(`\n🗑️ Cancelling ${orphanedOrders.length} orphaned order(s)...`, colors.yellow);

    let successCount = 0;
    let errorCount = 0;

    for (const order of orphanedOrders) {
      try {
        await cancelOrder({ symbol: order.symbol, orderId: order.orderId }, credentials);
        log(`   ✅ Cancelled ${order.symbol} Order #${order.orderId}`, colors.green);
        successCount++;
      } catch (error: any) {
        if (error?.response?.data?.code === -2011) {
          log(`   ℹ️ Order #${order.orderId} already filled/cancelled`, colors.blue);
          successCount++;
        } else {
          log(`   ❌ Failed to cancel Order #${order.orderId}: ${error.message}`, colors.red);
          errorCount++;
        }
      }
    }

    log(`\n📊 Cleanup Summary:`, colors.bright);
    log(`   ✅ Success: ${successCount}`, colors.green);
    log(`   ❌ Errors: ${errorCount}`, colors.red);

  } catch (error: any) {
    log(`❌ Error during cleanup: ${error.message}`, colors.red);
    throw error;
  }
}

async function runDiagnostics() {
  console.clear();
  log('🔬 Position Manager Diagnostics', colors.cyan);
  log('===============================\n', colors.cyan);

  const tests = [
    { name: 'Current Account State', fn: getCurrentState },
    { name: 'Position Protection Analysis', fn: analyzePositionProtection },
    { name: 'Orphaned Orders Detection', fn: findOrphanedOrders }
  ];

  const results: boolean[] = [];

  for (const test of tests) {
    try {
      await test.fn();
      results.push(true);
    } catch (error) {
      log(`\n❌ Test "${test.name}" failed with error: ${error}`, colors.red);
      results.push(false);
    }
  }

  // Summary
  logSection('📋 Diagnostic Summary');

  const passed = results.filter(r => r).length;
  const failed = results.length - passed;

  tests.forEach((test, index) => {
    const status = results[index] ? '✅' : '❌';
    const color = results[index] ? colors.green : colors.red;
    log(`${status} ${test.name}`, color);
  });

  console.log('\n' + '='.repeat(80));
  if (failed === 0) {
    log(`🎉 All ${passed} diagnostics completed successfully!`, colors.green);
  } else {
    log(`⚠️ ${passed} passed, ${failed} failed`, colors.yellow);
  }

  // Cleanup option
  const args = process.argv.slice(2);
  if (args.includes('--cleanup')) {
    await cleanupOrphanedOrders(false); // Live cleanup
  } else if (failed === 0) {
    await cleanupOrphanedOrders(true); // Dry run
  }

  console.log('='.repeat(80));
}

// Run diagnostics
runDiagnostics().catch(error => {
  log(`\n❌ Fatal error: ${error}`, colors.red);
  process.exit(1);
});