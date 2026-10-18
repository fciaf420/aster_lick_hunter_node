import type { LiquidationEvent } from '../types';
import { lighterTimestampToMs } from '../exchange/lighter/time';

// Pure pieces of the Lighter liquidation pipeline, shared by the live feed (lighterLiquidationSource.ts) and the
// history backfill (lighterHistory/backfill.ts) so both read a liquidation the same way: row parsing, the forced
// side (§2.4), grouping, the LLP / insurance-fund exclusion, the volume summary, the taker-position side gates and
// the bot-unit event. Changing anything here changes what the live feed trades.

export type LighterForcedSide = 'BUY' | 'SELL';

// lighter-go types/txtypes/constants.go InsuranceFundOperatorAccountIndex
export const LIGHTER_INSURANCE_FUND_OPERATOR_ACCOUNT_INDEX = 1;
// 2^48 - 1: the "no account" value of market_config.insurance_fund_account_index
export const LIGHTER_NIL_ACCOUNT_INDEX = 281474976710655;

export const LIGHTER_LLP_ONLY_REASON = 'every fill is against the LLP / insurance fund (takeover, not a book liquidation)';
export const LIGHTER_TX_BOTH_SIDES_FAILURE = 'side unverified: tx has fills on both sides';

// What the liquidation pipeline needs to know about a market. The markets module builds it from the symbol map
// (botSymbol, multiplier) and the market metadata (insurance fund account).
export interface LighterLiquidationMarket {
  botSymbol: string;
  multiplier?: number;                      // Bot units per Lighter unit (NOTUSDT -> 1000NOT = 1000). Default 1.
  insuranceFundAccountIndex?: number | null; // market_config.insurance_fund_account_index
  disabledReason?: string;                  // Set to keep the market out of trading (inactive, mark-ratio guard)
}

// marketId -> bot symbol (or the richer form); undefined = unmapped, never traded
export type LighterMarketResolver = (marketId: number) => string | LighterLiquidationMarket | undefined;

// One liquidation fill (a Trade row of type 'liquidation')
export interface LighterLiquidationFill {
  tradeId: string;
  marketId: number;
  txHash: string | null;
  takerOrderId: string;
  side: LighterForcedSide;
  size: number;
  price: number;
  usdAmount: number | null;
  time: number;
  timeFallback: boolean;    // No usable trade timestamp: time is the receive time
  aheadMs: number;          // How far the trade timestamp was ahead of the local clock (clamped to now)
  askAccount: number | null;
  bidAccount: number | null;
  takerSignChanged: boolean | null;
  takerSizeBefore: number | null;
  mismatchedChannelMarketId: number | null; // Set when the row's market_id differs from the channel's
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function positiveNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = typeof value === 'string' ? (value.trim() === '' ? NaN : Number(value)) : value;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function nonNegativeNumber(value: unknown): number | null {
  const n = finiteNumber(value);
  return n !== null && n >= 0 ? n : null;
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = typeof value === 'string' ? (value.trim() === '' ? NaN : Number(value)) : value;
  return Number.isFinite(n) ? n : null;
}

export function accountIndex(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function marketIdValue(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function idString(strValue: unknown, numValue: unknown): string | null {
  if (typeof strValue === 'string' && strValue !== '') return strValue;
  if (typeof numValue === 'number' && Number.isFinite(numValue)) return String(numValue);
  if (typeof numValue === 'string' && numValue !== '') return numValue;
  return null;
}

// Trim float noise from sums (0.1 + 0.2) without touching real precision
export function tidy(value: number): number {
  return Number(value.toPrecision(12));
}

export function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(tidy(value)) : String(value);
}

// Forced order side from the taker rule (§2.4, INFERRED): taker sold into bids -> forced SELL
export function lighterForcedSide(isMakerAsk: boolean): LighterForcedSide {
  return isMakerAsk ? 'BUY' : 'SELL';
}

// The id a trade row is deduplicated on
export function lighterTradeId(row: Record<string, unknown>): string | null {
  return idString(row.trade_id_str, row.trade_id);
}

export interface ParseLighterFillOptions {
  now: () => number;          // Local clock (read once, after the row passed validation)
  timestampWindowMs: number;  // A trade timestamp further than this from now is unusable
}

// A liquidation trade row -> fill, or why it can't be used. Uses timestamp, else transaction_time; one further than
// timestampWindowMs from the local clock is unusable (now is used and timeFallback set). A timestamp ahead of the
// clock is clamped to now so the fill can't outlive the hunter's threshold window.
export function parseLighterLiquidationFill(
  row: Record<string, unknown>,
  tradeId: string,
  channelMarketId: number | null,
  options: ParseLighterFillOptions
): { fill: LighterLiquidationFill } | { error: string } {
  const rowMarketId = marketIdValue(row.market_id);
  const marketId = rowMarketId ?? channelMarketId;
  if (marketId === null) return { error: 'no market id' };
  if (typeof row.is_maker_ask !== 'boolean') return { error: `is_maker_ask is ${JSON.stringify(row.is_maker_ask)}, not a boolean` };
  const size = positiveNumber(row.size);
  const price = positiveNumber(row.price);
  if (size === null) return { error: `bad size ${JSON.stringify(row.size)}` };
  if (price === null) return { error: `bad price ${JSON.stringify(row.price)}` };

  const isMakerAsk = row.is_maker_ask;
  const takerOrderId = (isMakerAsk ? idString(row.bid_id_str, row.bid_id) : idString(row.ask_id_str, row.ask_id)) ?? '?';
  const txHash = typeof row.tx_hash === 'string' && row.tx_hash !== '' ? row.tx_hash : null;

  const now = options.now();
  let time: number | null = null;
  for (const candidate of [row.timestamp, row.transaction_time]) {
    const ms = lighterTimestampToMs(candidate);
    if (ms !== null && Math.abs(ms - now) <= options.timestampWindowMs) {
      time = ms;
      break;
    }
  }
  const aheadMs = time !== null && time > now ? time - now : 0;

  return {
    fill: {
      tradeId,
      marketId,
      txHash,
      takerOrderId,
      side: lighterForcedSide(isMakerAsk),
      size,
      price,
      usdAmount: positiveNumber(row.usd_amount),
      time: time === null ? now : Math.min(time, now),
      timeFallback: time === null,
      aheadMs,
      askAccount: accountIndex(row.ask_account_id),
      bidAccount: accountIndex(row.bid_account_id),
      takerSignChanged: typeof row.taker_position_sign_changed === 'boolean' ? row.taker_position_sign_changed : null,
      takerSizeBefore: finiteNumber(row.taker_position_size_before),
      mismatchedChannelMarketId:
        rowMarketId !== null && channelMarketId !== null && rowMarketId !== channelMarketId ? channelMarketId : null,
    },
  };
}

// One liquidation sweeping several levels = one Trade per maker fill: grouped by market:tx hash:taker order.
// The key is also the liquidation's id in storage (live detections and backfilled rows share it).
export function lighterGroupKey(fill: Pick<LighterLiquidationFill, 'marketId' | 'txHash' | 'tradeId' | 'takerOrderId'>): string {
  return `${fill.marketId}:${fill.txHash ?? `trade-${fill.tradeId}`}:${fill.takerOrderId}`;
}

// The resolver's answer in its rich form; null when unmapped (with the reason when the lookup itself failed)
export function resolveLighterMarket(
  resolveSymbol: LighterMarketResolver,
  marketId: number
): { market: LighterLiquidationMarket | null; error?: string } {
  let resolved: string | LighterLiquidationMarket | undefined;
  try {
    resolved = resolveSymbol(marketId);
  } catch (error) {
    return { market: null, error: `symbol lookup failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (resolved === undefined || resolved === null) return { market: null };
  if (typeof resolved === 'string') {
    return resolved === '' ? { market: null } : { market: { botSymbol: resolved } };
  }
  if (typeof resolved.botSymbol !== 'string' || resolved.botSymbol === '') return { market: null };
  const multiplier = resolved.multiplier ?? 1;
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    return { market: null, error: `invalid multiplier ${String(resolved.multiplier)} for market ${marketId}` };
  }
  return { market: resolved };
}

// Accounts whose fills are never traded: account 1 (insurance fund operator), the market's insurance fund
// account and the extra ones (GET /api/v1/systemConfig liquidity_pool_index). A failing extra list is reported
// through onError and the accounts read before the failure are kept.
export function lighterExcludedAccounts(
  market: Pick<LighterLiquidationMarket, 'insuranceFundAccountIndex'> | null,
  extra?: () => Iterable<unknown> | undefined,
  onError?: (error: unknown) => void
): Set<number> {
  const excluded = new Set<number>([LIGHTER_INSURANCE_FUND_OPERATOR_ACCOUNT_INDEX]);
  const fund = market?.insuranceFundAccountIndex;
  if (typeof fund === 'number' && Number.isSafeInteger(fund) && fund >= 0 && fund !== LIGHTER_NIL_ACCOUNT_INDEX) excluded.add(fund);
  try {
    for (const value of extra?.() ?? []) {
      const index = accountIndex(value);
      if (index !== null && index !== LIGHTER_NIL_ACCOUNT_INDEX) excluded.add(index);
    }
  } catch (error) {
    onError?.(error);
  }
  return excluded;
}

export function isLighterFillExcluded(fill: Pick<LighterLiquidationFill, 'askAccount' | 'bidAccount'>, excluded: ReadonlySet<number>): boolean {
  return (fill.askAccount !== null && excluded.has(fill.askAccount)) ||
    (fill.bidAccount !== null && excluded.has(fill.bidAccount));
}

export interface LighterFillSummary {
  tradable: LighterLiquidationFill[];
  excluded: LighterLiquidationFill[];   // Fills against the LLP / insurance fund
  counted: LighterLiquidationFill[];    // Tradable fills, or every fill when none is tradable
  quantity: number;                     // Lighter units
  averagePrice: number;
  notional: number;                     // sum(size * price)
  usdAmount: number;                    // sum(usd_amount) when every fill has one, else notional
  eventTime: number;                    // Newest counted fill
}

// quantity = sum(size), price = sum(size*price)/sum(size), eventTime = max(time) over the counted fills
export function summarizeLighterFills(fills: LighterLiquidationFill[], excludedAccounts: ReadonlySet<number>): LighterFillSummary {
  const tradable = fills.filter((fill) => !isLighterFillExcluded(fill, excludedAccounts));
  const excluded = fills.filter((fill) => isLighterFillExcluded(fill, excludedAccounts));
  const counted = tradable.length > 0 ? tradable : fills;

  const sizeSum = counted.reduce((sum, fill) => sum + fill.size, 0);
  const notional = counted.reduce((sum, fill) => sum + fill.size * fill.price, 0);
  const samePrice = counted.every((fill) => fill.price === counted[0].price);
  const usdAmount = counted.every((fill) => fill.usdAmount !== null)
    ? counted.reduce((sum, fill) => sum + (fill.usdAmount ?? 0), 0)
    : notional;
  return {
    tradable,
    excluded,
    counted,
    quantity: tidy(sizeSum),
    averagePrice: samePrice ? counted[0].price : tidy(notional / sizeSum),
    notional,
    usdAmount,
    eventTime: Math.max(...counted.map((fill) => fill.time)),
  };
}

// Whether any fill shows a signed taker_position_size_before (a negative one): until one does, a positive size
// on a forced BUY can't be told apart from an unsigned field
export function lighterSawSignedSize(fills: LighterLiquidationFill[]): boolean {
  return fills.some((fill) => fill.takerSizeBefore !== null && fill.takerSizeBefore < 0);
}

// Side gates on the taker's position: the taker must have held a position that each fill reduced without
// flipping. Anything missing fails closed.
export function lighterPositionGateFailures(
  side: LighterForcedSide,
  fills: LighterLiquidationFill[],
  sawSignedSizeBefore: boolean
): string[] {
  const failures: string[] = [];
  if (fills.some((fill) => fill.takerSignChanged === null || fill.takerSizeBefore === null)) {
    failures.push('side unverified: taker_position_size_before / taker_position_sign_changed missing');
  }
  if (fills.some((fill) => fill.takerSignChanged === true)) {
    failures.push('side unverified: taker_position_sign_changed=true (a liquidation never flips the taker)');
  }
  if (fills.some((fill) => fill.takerSizeBefore !== null && Math.abs(fill.takerSizeBefore) < fill.size)) {
    failures.push('side unverified: fill larger than the taker position before it');
  }
  const sizes = fills.map((fill) => fill.takerSizeBefore).filter((size): size is number => size !== null);
  if (side === 'SELL' && sizes.some((size) => size < 0)) {
    failures.push('side unverified: forced SELL but the taker was short');
  } else if (side === 'BUY' && sawSignedSizeBefore && sizes.some((size) => size > 0)) {
    failures.push('side unverified: forced BUY but the taker was long');
  }
  return failures;
}

// §2.4 cross-checks (a) and (b), logged as notes for diagnosis (the gates decide trading)
export function lighterCrossCheckNotes(side: LighterForcedSide, fills: LighterLiquidationFill[], sawSignedSizeBefore: boolean): string[] {
  const notes: string[] = [];
  if (fills.some((fill) => fill.takerSignChanged === true)) {
    notes.push('CHECK: taker_position_sign_changed=true (a liquidation should not flip the taker)');
  }
  const sizes = fills.map((fill) => fill.takerSizeBefore).filter((size): size is number => size !== null);
  if (sizes.length > 0) {
    if (side === 'SELL' && sizes.some((size) => size < 0)) {
      notes.push(`CHECK: forced SELL but taker_position_size_before is negative (${sizes.join(', ')}): the taker was short`);
    } else if (side === 'BUY' && sawSignedSizeBefore && sizes.some((size) => size > 0)) {
      notes.push(`CHECK: forced BUY but taker_position_size_before is positive (${sizes.join(', ')}): the taker was long`);
    }
  }
  return notes;
}

// The liquidation in bot units (Binance forceOrder semantics), as the hunter receives it
export function lighterLiquidationEvent(
  market: LighterLiquidationMarket,
  side: LighterForcedSide,
  quantity: number,
  averagePrice: number,
  eventTime: number
): LiquidationEvent {
  const multiplier = market.multiplier ?? 1;
  const botQuantity = multiplier === 1 ? quantity : tidy(quantity * multiplier);
  const botPrice = multiplier === 1 ? averagePrice : tidy(averagePrice / multiplier);
  return {
    symbol: market.botSymbol,
    side,
    orderType: 'LIMIT',
    quantity: botQuantity,
    price: botPrice,
    averagePrice: botPrice,
    orderStatus: 'FILLED',
    orderLastFilledQuantity: botQuantity,
    orderFilledAccumulatedQuantity: botQuantity,
    orderTradeTime: eventTime,
    eventTime,
    qty: botQuantity,
    time: eventTime,
  };
}
