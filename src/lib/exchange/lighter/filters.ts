import type { LighterMarket } from './markets';
import type { LighterSymbolEntry } from './symbols';
import { MAX_BASE_AMOUNT, MAX_PRICE, QUOTE_DECIMALS, formatScaled } from './scaling';

// Binance-style exchangeInfo synthesized from Lighter market metadata (spec §3.3), so
// src/lib/utils/symbolPrecision.ts, src/lib/api/pricing.ts and the UI routes work unchanged:
//
//   PRICE_FILTER  tickSize / minPrice = 10^-price_decimals, maxPrice = (2^32-1) / 10^price_decimals
//   LOT_SIZE      stepSize = 10^-size_decimals, minQty = min_base_amount, maxQty = (2^48-1) / 10^size_decimals
//   MIN_NOTIONAL  notional = min_quote_amount
//
// Values are plain decimal strings (never exponent notation), as the bot parses them with parseFloat and
// counts decimals from the text. pricing.ts falls back to DEFAULT_FILTERS for symbols it can't find, so the
// Lighter adapter itself must refuse every symbol LighterMarketCache doesn't map.

export type LighterSymbolFilter =
  | { filterType: 'PRICE_FILTER'; minPrice: string; maxPrice: string; tickSize: string }
  | { filterType: 'LOT_SIZE'; minQty: string; maxQty: string; stepSize: string }
  | { filterType: 'MIN_NOTIONAL'; notional: string };

export const LIGHTER_ORDER_TYPES = ['LIMIT', 'MARKET', 'STOP_MARKET', 'TAKE_PROFIT_MARKET'] as const;
export const LIGHTER_TIME_IN_FORCE = ['GTC', 'IOC', 'GTX'] as const;   // no FOK on Lighter

export function buildSymbolFilters(market: LighterMarket): LighterSymbolFilter[] {
  const tickSize = formatScaled(1, market.priceDecimals);
  const stepSize = formatScaled(1, market.sizeDecimals);
  return [
    {
      filterType: 'PRICE_FILTER',
      minPrice: tickSize,
      maxPrice: formatScaled(MAX_PRICE, market.priceDecimals),
      tickSize,
    },
    {
      filterType: 'LOT_SIZE',
      minQty: formatScaled(market.minBaseAmountUnits, market.sizeDecimals),
      maxQty: formatScaled(MAX_BASE_AMOUNT, market.sizeDecimals),
      stepSize,
    },
    {
      filterType: 'MIN_NOTIONAL',
      notional: formatScaled(market.minQuoteMicro, QUOTE_DECIMALS),
    },
  ];
}

// Venue extras on each symbol (adapter-internal; Binance has no equivalent)
export interface LighterSymbolInfoExtras {
  marketId: number;
  symbol: string;               // Lighter backend symbol
  orderQuoteLimit: string;      // Max notional per order (USDC)
  maxLeverage: number;
  minInitialMarginFraction: number;
  tradable: boolean;
  untradableReasons: string[];
}

export interface LighterExchangeSymbol {
  symbol: string;
  pair: string;
  contractType: 'PERPETUAL';
  status: 'TRADING' | 'BREAK';  // BREAK: known market that currently refuses new positions
  baseAsset: string;
  quoteAsset: 'USDC';
  marginAsset: 'USDC';
  pricePrecision: number;
  quantityPrecision: number;
  orderTypes: string[];
  timeInForce: string[];
  filters: LighterSymbolFilter[];
  lighter: LighterSymbolInfoExtras;
}

export interface LighterExchangeInfo {
  timezone: 'UTC';
  serverTime: number;
  venue: 'lighter';
  symbols: LighterExchangeSymbol[];
}

export function buildExchangeSymbol(entry: LighterSymbolEntry, market: LighterMarket): LighterExchangeSymbol {
  if (entry.multiplier !== 1) {
    throw new Error(`${entry.botSymbol} maps to Lighter ${entry.lighterSymbol} with multiplier ${entry.multiplier}; only multiplier 1 can be traded on Lighter`);
  }
  if (entry.marketId !== market.marketId) {
    throw new Error(`${entry.botSymbol} maps to market ${entry.marketId}, not ${market.marketId}`);
  }
  return {
    symbol: entry.botSymbol,
    pair: entry.botSymbol,
    contractType: 'PERPETUAL',
    status: market.tradable ? 'TRADING' : 'BREAK',
    baseAsset: market.symbol,
    quoteAsset: 'USDC',
    marginAsset: 'USDC',
    pricePrecision: market.priceDecimals,
    quantityPrecision: market.sizeDecimals,
    orderTypes: [...LIGHTER_ORDER_TYPES],
    timeInForce: [...LIGHTER_TIME_IN_FORCE],
    filters: buildSymbolFilters(market),
    lighter: {
      marketId: market.marketId,
      symbol: market.symbol,
      orderQuoteLimit: formatScaled(market.orderQuoteLimitMicro, QUOTE_DECIMALS),
      maxLeverage: market.maxLeverage,
      minInitialMarginFraction: market.minInitialMarginFraction,
      tradable: market.tradable,
      untradableReasons: [...market.untradableReasons],
    },
  };
}

// exchangeInfo for mapped symbols, sorted by bot symbol. Entries with a multiplier other than 1 only serve
// the liquidation feed and are left out.
export function buildExchangeInfo(
  mapped: Iterable<{ entry: LighterSymbolEntry; market: LighterMarket }>,
  serverTime: number
): LighterExchangeInfo {
  const symbols: LighterExchangeSymbol[] = [];
  for (const { entry, market } of mapped) {
    if (entry.multiplier !== 1) continue;
    symbols.push(buildExchangeSymbol(entry, market));
  }
  symbols.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return { timezone: 'UTC', serverTime, venue: 'lighter', symbols };
}
