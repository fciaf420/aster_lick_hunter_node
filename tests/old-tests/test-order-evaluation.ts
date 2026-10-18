#!/usr/bin/env tsx

import { loadConfig } from '../src/lib/bot/config';
import { getPositionRisk, getOpenOrders } from '../src/lib/api/market';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  bright: '\x1b[1m'
};

function log(message: string, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logSection(title: string) {
  console.log('\n' + '='.repeat(80));
  log(title, colors.cyan + colors.bright);
  console.log('='.repeat(80));
}

function logSubSection(title: string) {
  console.log('\n' + '-'.repeat(60));
  log(title, colors.blue);
  console.log('-'.repeat(60));
}

// Simulate how PositionManager evaluates orders
async function testOrderEvaluation() {
  logSection('ORDER EVALUATION TEST');

  try {
    // Load config
    const config = await loadConfig();
    log('✅ Config loaded successfully', colors.green);

    // Get positions and orders
    const positions = await getPositionRisk(undefined, config.api);
    const openOrders = await getOpenOrders(undefined, config.api);

    const activePositions = positions.filter(p => parseFloat(p.positionAmt) !== 0);
    log(`Active positions: ${activePositions.length}`, colors.blue);
    log(`Total open orders: ${openOrders.length}`, colors.blue);

    // Simulate periodic order check logic
    logSubSection('Simulating Periodic Order Check');

    // Group positions by symbol for evaluation
    const positionsBySymbol = new Map<string, any[]>();
    for (const pos of activePositions) {
      const symbol = pos.symbol;
      if (!positionsBySymbol.has(symbol)) {
        positionsBySymbol.set(symbol, []);
      }
      positionsBySymbol.get(symbol)!.push(pos);
    }

    log(`\nEvaluating positions for ${positionsBySymbol.size} symbols:`, colors.cyan);

    // Process each symbol like PositionManager does
    for (const [symbol, symbolPositions] of positionsBySymbol) {
      console.log(`\n${symbol}:`);

      // Check if symbol has config
      const hasConfig = !!config.symbols[symbol];
      if (!hasConfig) {
        log(`  ⚠️ SKIPPING - No config for ${symbol}`, colors.yellow);
        continue;
      }

      log(`  ✅ Has config`, colors.green);

      // Process each position for this symbol
      for (const pos of symbolPositions) {
        const posAmt = parseFloat(pos.positionAmt);

        // Generate position key
        let positionKey: string;
        if (pos.positionSide === 'BOTH') {
          const direction = posAmt > 0 ? 'LONG' : 'SHORT';
          positionKey = `${symbol}_${direction}`;
        } else {
          positionKey = `${symbol}_${pos.positionSide}_HEDGE`;
        }

        console.log(`\n  Position: ${positionKey}`);
        console.log(`    Amount: ${pos.positionAmt}`);
        console.log(`    Entry: ${pos.entryPrice}`);

        // Find SL orders for this position
        const slOrders = openOrders.filter(o => {
          // Must match symbol
          if (o.symbol !== symbol) return false;
          // Must be stop order
          if (!(o.type === 'STOP_MARKET' || o.type === 'STOP')) return false;
          // Must be reduce-only
          if (!o.reduceOnly) return false;
          // Must match position direction
          const directionMatches = (posAmt > 0 && o.side === 'SELL') || (posAmt < 0 && o.side === 'BUY');
          if (!directionMatches) return false;

          // Log evaluation like PositionManager does
          log(`    Evaluating SL order ${o.orderId} - Symbol: ${o.symbol}, Side: ${o.side}, Type: ${o.type}`, colors.gray);
          return true;
        });

        // Find TP orders for this position
        const tpOrders = openOrders.filter(o => {
          // Must match symbol
          if (o.symbol !== symbol) return false;
          // Must be TP or limit order
          if (!(o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT' || (o.type === 'LIMIT' && o.reduceOnly))) return false;
          // Must match position direction
          const directionMatches = (posAmt > 0 && o.side === 'SELL') || (posAmt < 0 && o.side === 'BUY');
          if (!directionMatches) return false;

          // Log evaluation like PositionManager does
          log(`    Evaluating TP order ${o.orderId} - Symbol: ${o.symbol}, Side: ${o.side}, Type: ${o.type}`, colors.gray);
          return true;
        });

        console.log(`    SL Orders: ${slOrders.length}`);
        console.log(`    TP Orders: ${tpOrders.length}`);

        // Check protection status
        const hasProtection = slOrders.length > 0 && tpOrders.length > 0;
        const needsSL = slOrders.length === 0;
        const needsTP = tpOrders.length === 0;

        if (hasProtection) {
          log(`    ✅ Fully Protected`, colors.green);

          // Check for quantity mismatches
          if (slOrders.length > 0) {
            const slQty = parseFloat(slOrders[0].origQty);
            const posQty = Math.abs(posAmt);
            if (Math.abs(slQty - posQty) > 0.00000001) {
              log(`    ⚠️ SL quantity mismatch: Order=${slQty}, Position=${posQty}`, colors.yellow);
            }
          }

          if (tpOrders.length > 0) {
            const tpQty = parseFloat(tpOrders[0].origQty);
            const posQty = Math.abs(posAmt);
            if (Math.abs(tpQty - posQty) > 0.00000001) {
              log(`    ⚠️ TP quantity mismatch: Order=${tpQty}, Position=${posQty}`, colors.yellow);
            }
          }
        } else {
          log(`    ❌ NOT Protected`, colors.red);
          if (needsSL) log(`      - Missing SL order`, colors.red);
          if (needsTP) log(`      - Missing TP order`, colors.red);
          log(`    🔧 Would place protection orders`, colors.cyan);
        }

        // Check for duplicates
        if (slOrders.length > 1) {
          log(`    ⚠️ Multiple SL orders (${slOrders.length}) - would cancel duplicates`, colors.yellow);
        }
        if (tpOrders.length > 1) {
          log(`    ⚠️ Multiple TP orders (${tpOrders.length}) - would cancel duplicates`, colors.yellow);
        }
      }
    }

    // Check for orphaned orders
    logSubSection('Checking for Orphaned Orders');

    // Find reduce-only orders that don't match any position
    const orphanedOrders = [];

    for (const order of openOrders) {
      if (!order.reduceOnly) continue;

      const symbol = order.symbol;
      const symbolPositions = positionsBySymbol.get(symbol) || [];

      // Check if this order matches any position
      let matchesPosition = false;

      for (const pos of symbolPositions) {
        const posAmt = parseFloat(pos.positionAmt);

        // For SL/TP orders, check if direction matches
        if (order.type === 'STOP_MARKET' || order.type === 'STOP' ||
            order.type === 'TAKE_PROFIT_MARKET' || order.type === 'TAKE_PROFIT' ||
            (order.type === 'LIMIT' && order.reduceOnly)) {
          // Order should be opposite side of position
          const expectedSide = posAmt > 0 ? 'SELL' : 'BUY';
          if (order.side === expectedSide) {
            matchesPosition = true;
            break;
          }
        }
      }

      if (!matchesPosition) {
        orphanedOrders.push(order);
      }
    }

    if (orphanedOrders.length > 0) {
      log(`Found ${orphanedOrders.length} orphaned order(s):`, colors.yellow);
      for (const order of orphanedOrders) {
        console.log(`  ${order.symbol} - Order ${order.orderId} (${order.type}, ${order.side})`);
        log(`    ⚠️ Would cancel this orphaned order`, colors.yellow);
      }
    } else {
      log('✅ No orphaned orders found', colors.green);
    }

    // Special check for PUMPUSDT
    logSubSection('PUMPUSDT Evaluation Analysis');

    const pumpPositions = activePositions.filter(p => p.symbol === 'PUMPUSDT');
    const pumpOrders = openOrders.filter(o => o.symbol === 'PUMPUSDT');

    if (pumpPositions.length > 0) {
      log('PUMPUSDT Positions:', colors.cyan);
      for (const pos of pumpPositions) {
        const posAmt = parseFloat(pos.positionAmt);
        console.log(`  Amount: ${pos.positionAmt}, Side: ${pos.positionSide}`);

        // Check why it might not be evaluated
        const reasons = [];

        // Check config
        if (!config.symbols.PUMPUSDT) {
          reasons.push('❌ No config for PUMPUSDT');
        }

        // Check position amount
        if (Math.abs(posAmt) === 0) {
          reasons.push('❌ Position amount is zero');
        }

        // Check if evaluation would find it
        const posKey = pos.positionSide === 'BOTH'
          ? `PUMPUSDT_${posAmt > 0 ? 'LONG' : 'SHORT'}`
          : `PUMPUSDT_${pos.positionSide}_HEDGE`;

        log(`  Position Key: ${posKey}`, colors.magenta);

        if (reasons.length > 0) {
          log('  Reasons for skipping:', colors.red);
          reasons.forEach(r => log(`    ${r}`, colors.red));
        } else {
          log('  ✅ Should be evaluated', colors.green);

          // Check orders
          const slOrders = pumpOrders.filter(o =>
            (o.type === 'STOP_MARKET' || o.type === 'STOP') &&
            o.reduceOnly &&
            ((posAmt > 0 && o.side === 'SELL') || (posAmt < 0 && o.side === 'BUY'))
          );

          const tpOrders = pumpOrders.filter(o =>
            (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT' || (o.type === 'LIMIT' && o.reduceOnly)) &&
            ((posAmt > 0 && o.side === 'SELL') || (posAmt < 0 && o.side === 'BUY'))
          );

          log(`  Current Orders: SL=${slOrders.length}, TP=${tpOrders.length}`,
              slOrders.length > 0 && tpOrders.length > 0 ? colors.green : colors.red);

          if (slOrders.length === 0 || tpOrders.length === 0) {
            log('  🔧 NEEDS PROTECTION ORDERS!', colors.red + colors.bright);
          }
        }
      }
    } else {
      log('No PUMPUSDT positions found', colors.gray);
    }

    // Summary
    logSection('EVALUATION SUMMARY');

    const totalEvaluated = activePositions.filter(p => config.symbols[p.symbol]).length;
    const totalSkipped = activePositions.filter(p => !config.symbols[p.symbol]).length;

    log(`Positions Evaluated: ${totalEvaluated}`, colors.blue);
    log(`Positions Skipped: ${totalSkipped}`, totalSkipped > 0 ? colors.yellow : colors.green);

    if (totalSkipped > 0) {
      log('\nSkipped positions (no config):', colors.yellow);
      const skippedSymbols = [...new Set(activePositions.filter(p => !config.symbols[p.symbol]).map(p => p.symbol))];
      skippedSymbols.forEach(s => log(`  - ${s}`, colors.yellow));
    }

    // Protection summary
    let protectedCount = 0;
    let unprotectedCount = 0;

    for (const pos of activePositions) {
      if (!config.symbols[pos.symbol]) continue;

      const posAmt = parseFloat(pos.positionAmt);
      const slOrders = openOrders.filter(o =>
        o.symbol === pos.symbol &&
        (o.type === 'STOP_MARKET' || o.type === 'STOP') &&
        o.reduceOnly &&
        ((posAmt > 0 && o.side === 'SELL') || (posAmt < 0 && o.side === 'BUY'))
      );

      const tpOrders = openOrders.filter(o =>
        o.symbol === pos.symbol &&
        (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT' || (o.type === 'LIMIT' && o.reduceOnly)) &&
        ((posAmt > 0 && o.side === 'SELL') || (posAmt < 0 && o.side === 'BUY'))
      );

      if (slOrders.length > 0 && tpOrders.length > 0) {
        protectedCount++;
      } else {
        unprotectedCount++;
      }
    }

    log(`\nProtection Status:`, colors.cyan);
    log(`  Protected: ${protectedCount}`, protectedCount > 0 ? colors.green : colors.gray);
    log(`  Unprotected: ${unprotectedCount}`, unprotectedCount > 0 ? colors.red : colors.green);

    if (unprotectedCount > 0) {
      log('\n⚠️ ACTION REQUIRED: Unprotected positions need SL/TP orders!', colors.red + colors.bright);
    }

  } catch (error: any) {
    log(`\n❌ Error during test: ${error?.message}`, colors.red);
    if (error?.response?.data) {
      console.error('API Error:', error.response.data);
    }
    console.error(error);
  }
}

// Run the test
testOrderEvaluation().catch(console.error);