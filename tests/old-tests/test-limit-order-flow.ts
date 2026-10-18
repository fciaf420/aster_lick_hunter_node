#!/usr/bin/env tsx

import { getBookTicker } from '../src/lib/api/market';
import { calculateOptimalPrice, validateOrderParams } from '../src/lib/api/pricing';
import { loadConfig } from '../src/lib/bot/config';

// Terminal colors
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m'
};

function log(message: string, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

async function demonstrateLimitOrderFlow() {
  console.clear();
  log('📈 LIMIT ORDER FLOW DEMONSTRATION', colors.cyan);
  log('=' .repeat(60), colors.cyan);

  try {
    const config = await loadConfig();
    const symbol = 'ASTERUSDT';
    const symbolConfig = config.symbols[symbol];

    log('\n1️⃣  MARKET ORDER (OLD APPROACH)', colors.yellow);
    log('=' .repeat(40), colors.gray);

    // Get current book ticker
    const bookTicker = await getBookTicker(symbol);
    const bestBid = parseFloat(bookTicker.bidPrice);
    const bestAsk = parseFloat(bookTicker.askPrice);
    const spread = bestAsk - bestBid;
    const spreadBps = (spread / bestBid) * 10000;

    log(`Current Market:`, colors.blue);
    log(`  Best Bid: $${bestBid.toFixed(5)}`, colors.gray);
    log(`  Best Ask: $${bestAsk.toFixed(5)}`, colors.gray);
    log(`  Spread: ${spreadBps.toFixed(2)} bps`, colors.gray);

    // Market order would cross the spread
    log(`\n❌ Market BUY Order:`, colors.red);
    log(`  Would pay: $${bestAsk.toFixed(5)} (taker)`, colors.gray);
    log(`  Cost vs mid: ${(spreadBps / 2).toFixed(2)} bps worse`, colors.gray);
    log(`  Fees: Taker fee (0.04%)`, colors.gray);

    log(`\n❌ Market SELL Order:`, colors.red);
    log(`  Would receive: $${bestBid.toFixed(5)} (taker)`, colors.gray);
    log(`  Cost vs mid: ${(spreadBps / 2).toFixed(2)} bps worse`, colors.gray);
    log(`  Fees: Taker fee (0.04%)`, colors.gray);

    log('\n2️⃣  LIMIT ORDER (NEW APPROACH)', colors.green);
    log('=' .repeat(40), colors.gray);

    // Calculate optimal prices for both sides
    const priceOffsetBps = symbolConfig.priceOffsetBps || 2;
    const usePostOnly = symbolConfig.usePostOnly || false;

    const optimalBuyPrice = await calculateOptimalPrice(symbol, 'BUY', priceOffsetBps, usePostOnly);
    const optimalSellPrice = await calculateOptimalPrice(symbol, 'SELL', priceOffsetBps, usePostOnly);

    if (optimalBuyPrice) {
      log(`\n✅ Limit BUY Order:`, colors.green);
      log(`  Optimal price: $${optimalBuyPrice.toFixed(5)} (maker)`, colors.gray);

      const improvement = bestAsk - optimalBuyPrice;
      const improvementBps = (improvement / bestAsk) * 10000;
      log(`  💰 Saves: $${improvement.toFixed(5)} per unit`, colors.cyan);
      log(`  💰 Improvement: ${improvementBps.toFixed(2)} bps`, colors.cyan);
      log(`  Fees: Maker rebate (-0.02%)`, colors.green);

      // Validate order
      const buyValidation = await validateOrderParams(symbol, 'BUY', optimalBuyPrice, symbolConfig.tradeSize);
      if (buyValidation.valid) {
        log(`  ✅ Order validation: PASSED`, colors.green);
      }
    }

    if (optimalSellPrice) {
      log(`\n✅ Limit SELL Order:`, colors.green);
      log(`  Optimal price: $${optimalSellPrice.toFixed(5)} (maker)`, colors.gray);

      const improvement = optimalSellPrice - bestBid;
      const improvementBps = (improvement / bestBid) * 10000;
      log(`  💰 Gains: $${improvement.toFixed(5)} per unit`, colors.cyan);
      log(`  💰 Improvement: ${improvementBps.toFixed(2)} bps`, colors.cyan);
      log(`  Fees: Maker rebate (-0.02%)`, colors.green);

      // Validate order
      const sellValidation = await validateOrderParams(symbol, 'SELL', optimalSellPrice, symbolConfig.tradeSize);
      if (sellValidation.valid) {
        log(`  ✅ Order validation: PASSED`, colors.green);
      }
    }

    log('\n3️⃣  PROFIT COMPARISON', colors.magenta);
    log('=' .repeat(40), colors.gray);

    const tradeSize = symbolConfig.tradeSize;
    const notional = tradeSize * bestAsk;

    // Market order costs
    const marketBuyCost = tradeSize * bestAsk;
    const marketBuyFees = marketBuyCost * 0.0004; // 0.04% taker fee
    const marketTotalCost = marketBuyCost + marketBuyFees;

    // Limit order costs
    const limitBuyCost = tradeSize * (optimalBuyPrice || bestAsk);
    const limitBuyFees = limitBuyCost * -0.0002; // -0.02% maker rebate
    const limitTotalCost = limitBuyCost + limitBuyFees;

    // Savings
    const totalSavings = marketTotalCost - limitTotalCost;
    const savingsPercent = (totalSavings / marketTotalCost) * 100;

    log(`Trade Size: ${tradeSize} units`, colors.blue);
    log(`Notional Value: $${notional.toFixed(2)}`, colors.blue);

    log(`\nMarket Order Total Cost:`, colors.red);
    log(`  Price cost: $${marketBuyCost.toFixed(4)}`, colors.gray);
    log(`  Taker fees: $${marketBuyFees.toFixed(4)}`, colors.gray);
    log(`  Total: $${marketTotalCost.toFixed(4)}`, colors.red);

    log(`\nLimit Order Total Cost:`, colors.green);
    log(`  Price cost: $${limitBuyCost.toFixed(4)}`, colors.gray);
    log(`  Maker rebate: -$${Math.abs(limitBuyFees).toFixed(4)}`, colors.green);
    log(`  Total: $${limitTotalCost.toFixed(4)}`, colors.green);

    log(`\n💰 TOTAL SAVINGS: $${totalSavings.toFixed(4)} (${savingsPercent.toFixed(2)}%)`, colors.cyan);

    // Calculate annual savings projection
    const tradesPerDay = 10; // Assume 10 trades per day
    const annualSavings = totalSavings * tradesPerDay * 365;
    log(`📊 Projected annual savings (${tradesPerDay} trades/day): $${annualSavings.toFixed(2)}`, colors.yellow);

    log('\n' + '='.repeat(60), colors.cyan);
    log('✅ DEMONSTRATION COMPLETE', colors.green);
    log('=' .repeat(60), colors.cyan);

  } catch (error) {
    log(`\n❌ Error: ${error}`, colors.red);
    process.exit(1);
  }
}

// Run demonstration
demonstrateLimitOrderFlow();