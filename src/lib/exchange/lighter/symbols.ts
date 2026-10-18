import type { LighterMarket } from './markets';

// Bot symbol <-> Lighter market mapping (spec §3.4).
// A bot symbol (BTCUSDT) maps to the Lighter perp whose backend symbol is the name without the USDT suffix
// (BTC), but only when the bot symbol is on an explicit allowlist. Overrides map names that don't follow
// that rule (NOTUSDT -> 1000NOT with multiplier 1000). Display names such as kPEPE are never API symbols:
// overrides must use the backend name (1000PEPE).

export const BOT_SYMBOL_QUOTE = 'USDT';

// Lighter perps whose ticker can name a different instrument on Binance-style venues: stocks, ETFs, FX,
// commodities and pre-IPO markets (BB is BlackBerry, QNT and WEN are not the crypto tokens, ...), plus the
// digit-leading names the spec flags. They are never mapped automatically; map them with an override.
// Snapshot of lighter-ts src/fallbacks/tokens.json (asset_type other than CRYPTO, perps only) at e19745a.
// It cannot list markets added later: the mark-ratio guard (checkMarkRatio) is the real protection.
export const OVERRIDE_REQUIRED_LIGHTER_SYMBOLS: ReadonlySet<string> = new Set([
  'AAOI', 'AAPL', 'AMD', 'AMZN', 'ANTHROPIC', 'ARM', 'ASML', 'AUDUSD', 'AVGO', 'AXTI', 'BABA', 'BB',
  'BE', 'BMNR', 'BOT', 'BOTZ', 'BRENTOIL', 'BYD', 'CBRS', 'COIN', 'CRCL', 'CRWV', 'CXMT', 'DELL',
  'DIA', 'DRAM', 'EURUSD', 'EWY', 'GBPUSD', 'GEV', 'GME', 'GOOGL', 'H100', 'HANMI', 'HOOD',
  'HYUNDAI', 'HYUNDAIUSD', 'IBM', 'INTC', 'IWM', 'KIOXIA', 'KORU', 'KRCOMP', 'LITE', 'MAGS', 'META',
  'MINIMAX', 'MRNA', 'MRVL', 'MSFT', 'MSTR', 'MU', 'NATGAS', 'NBIS', 'NOK', 'NOW', 'NVDA', 'NZDUSD',
  'OPENAI', 'ORCL', 'PAXG', 'PLTR', 'POPMART', 'QCOM', 'QNT', 'QQQ', 'RKLB', 'SAMSUNG', 'SAMSUNGUSD',
  'SHEIN', 'SKHY', 'SKHYNIX', 'SKHYNIXUSD', 'SMIC', 'SNDK', 'SOXL', 'SOXS', 'SOXX', 'SPACEX', 'SPCX',
  'SPY', 'STABLECOINX', 'STRC', 'TENCENT', 'TSLA', 'TSM', 'TTWO', 'UNITREE', 'URA', 'US100', 'US10Y',
  'US500', 'USDCAD', 'USDCHF', 'USDJPY', 'USDKRW', 'WDC', 'WEN', 'WHEAT', 'WTI', 'XAG', 'XAU', 'XCU',
  'XIAOMI', 'XPD', 'XPT', 'ZHIPU',
  // Digit-leading names (spec §3.4)
  '0G', '2Z',
]);

// FX pairs the snapshot misses (USDHKD is tagged CRYPTO there)
const FX_PAIR_PATTERN = /^(USD[A-Z]{3}|[A-Z]{3}USD)$/;

export function requiresOverride(lighterSymbol: string): boolean {
  return OVERRIDE_REQUIRED_LIGHTER_SYMBOLS.has(lighterSymbol) || FX_PAIR_PATTERN.test(lighterSymbol);
}

export interface LighterSymbolOverride {
  market: string;               // Lighter backend symbol, e.g. '1000NOT' (never a display name like kNOT)
  multiplier?: number;          // Bot units per Lighter unit: NOTUSDT -> 1000NOT is 1000. Default 1.
}

export interface LighterSymbolMapOptions {
  // Bot symbols that may map to a Lighter market, e.g. Object.keys(config.symbols). Nothing else is mapped.
  // 'all' maps every market that maps automatically under its default name (read-only listings such as
  // the symbol picker); trading code passes the configured symbols.
  allowlist: Iterable<string> | 'all';
  // botSymbol -> Lighter backend symbol, or { market, multiplier }. An override also allowlists its symbol.
  overrides?: Record<string, string | LighterSymbolOverride>;
}

export interface LighterSymbolEntry {
  botSymbol: string;
  lighterSymbol: string;
  marketId: number;
  multiplier: number;           // 1 for every automatic mapping
  explicit: boolean;            // Came from an override
}

export interface LighterSymbolRejection {
  botSymbol: string;
  reason: string;
}

export interface LighterSymbolMap {
  readonly bySymbol: ReadonlyMap<string, LighterSymbolEntry>;
  readonly byMarketId: ReadonlyMap<number, LighterSymbolEntry>;
  readonly rejected: readonly LighterSymbolRejection[];
}

// BTCUSDT -> BTC. null when the bot symbol doesn't end in USDT or has nothing before it.
export function candidateLighterSymbol(botSymbol: string): string | null {
  const match = /^([A-Z0-9]+)USDT$/.exec(botSymbol);
  return match ? match[1] : null;
}

export function defaultBotSymbol(lighterSymbol: string): string {
  return `${lighterSymbol}${BOT_SYMBOL_QUOTE}`;
}

function ownOverride(
  overrides: LighterSymbolMapOptions['overrides'],
  botSymbol: string
): string | LighterSymbolOverride | undefined {
  if (!overrides || !Object.prototype.hasOwnProperty.call(overrides, botSymbol)) return undefined;
  return overrides[botSymbol];
}

type MarketRef = Pick<LighterMarket, 'symbol' | 'marketId'>;

// Build the mapping for the given markets (the cache passes every market with verified precision, tradable
// or not, so open positions in a market that stopped trading still map). Bot symbols that can't be mapped
// end up in `rejected` with the reason; a market claimed by two bot symbols maps to the explicit override,
// or to neither when both are explicit.
export function buildSymbolMap(markets: Iterable<MarketRef>, options: LighterSymbolMapOptions): LighterSymbolMap {
  const marketsBySymbol = new Map<string, MarketRef>();
  for (const market of markets) marketsBySymbol.set(market.symbol, market);

  const requested: string[] = [];
  const seen = new Set<string>();
  const request = (botSymbol: string) => {
    if (!seen.has(botSymbol)) {
      seen.add(botSymbol);
      requested.push(botSymbol);
    }
  };
  if (options.allowlist === 'all') {
    for (const market of marketsBySymbol.values()) {
      if (!requiresOverride(market.symbol)) request(defaultBotSymbol(market.symbol));
    }
  } else {
    for (const botSymbol of options.allowlist) request(botSymbol);
  }
  for (const botSymbol of Object.keys(options.overrides ?? {})) request(botSymbol);

  const rejected: LighterSymbolRejection[] = [];
  const claims = new Map<number, LighterSymbolEntry[]>();

  for (const botSymbol of requested) {
    const override = ownOverride(options.overrides, botSymbol);
    let lighterSymbol: string;
    let multiplier = 1;

    if (override !== undefined) {
      lighterSymbol = typeof override === 'string' ? override : override?.market;
      if (typeof override === 'object' && override !== null && override.multiplier !== undefined) {
        multiplier = override.multiplier;
      }
      if (typeof lighterSymbol !== 'string' || lighterSymbol === '') {
        rejected.push({ botSymbol, reason: 'override has no Lighter market symbol' });
        continue;
      }
      if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier <= 0) {
        rejected.push({ botSymbol, reason: `override multiplier ${String(multiplier)} is not a positive number` });
        continue;
      }
    } else {
      const candidate = candidateLighterSymbol(botSymbol);
      if (candidate === null) {
        rejected.push({ botSymbol, reason: `not a ${BOT_SYMBOL_QUOTE} symbol; add an override to map it` });
        continue;
      }
      if (requiresOverride(candidate)) {
        rejected.push({
          botSymbol,
          reason: `Lighter ${candidate} may be a different instrument (stock, FX, commodity or flagged name); map it with an explicit override`,
        });
        continue;
      }
      lighterSymbol = candidate;
    }

    const market = marketsBySymbol.get(lighterSymbol);
    if (!market) {
      rejected.push({ botSymbol, reason: `no usable Lighter perp named ${lighterSymbol}` });
      continue;
    }

    const entry: LighterSymbolEntry = {
      botSymbol,
      lighterSymbol,
      marketId: market.marketId,
      multiplier,
      explicit: override !== undefined,
    };
    claims.set(market.marketId, [...(claims.get(market.marketId) ?? []), entry]);
  }

  const bySymbol = new Map<string, LighterSymbolEntry>();
  const byMarketId = new Map<number, LighterSymbolEntry>();
  for (const [marketId, entries] of claims) {
    let winner: LighterSymbolEntry | undefined;
    if (entries.length === 1) {
      winner = entries[0];
    } else {
      const explicit = entries.filter(entry => entry.explicit);
      winner = explicit.length === 1 ? explicit[0] : undefined;
    }
    for (const entry of entries) {
      if (entry === winner) continue;
      const others = entries.filter(other => other !== entry).map(other => other.botSymbol).join(', ');
      rejected.push({ botSymbol: entry.botSymbol, reason: `Lighter ${entry.lighterSymbol} is also mapped from ${others}` });
    }
    if (winner) {
      bySymbol.set(winner.botSymbol, winner);
      byMarketId.set(marketId, winner);
    }
  }

  return { bySymbol, byMarketId, rejected };
}

// ===== Cross-venue mark-price guard =====
// When the liquidation source and the execution venue differ, a symbol may only trade while
// |lighterMark / venueMark - 1| <= 2% (checked at startup and every 5 minutes). A x1000 mismatch would make
// the hunter's price-ratio check fire a SELL on every BUY-side liquidation.

export const MARK_RATIO_TOLERANCE = 0.02;

export interface MarkRatioResult {
  ok: boolean;
  ratio: number | null;         // (lighterMark / multiplier) / venueMark
  reason?: string;
}

function positivePrice(value: unknown): number | null {
  const price = typeof value === 'string' ? (value.trim() === '' ? NaN : Number(value)) : value;
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
}

// Fails closed: a missing, zero or unreadable mark fails the check.
export function checkMarkRatio(
  lighterMark: number | string | null | undefined,
  venueMark: number | string | null | undefined,
  multiplier = 1,
  tolerance = MARK_RATIO_TOLERANCE
): MarkRatioResult {
  const lighter = positivePrice(lighterMark);
  const venue = positivePrice(venueMark);
  if (lighter === null) return { ok: false, ratio: null, reason: `no usable Lighter mark price (${String(lighterMark)})` };
  if (venue === null) return { ok: false, ratio: null, reason: `no usable venue mark price (${String(venueMark)})` };
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    return { ok: false, ratio: null, reason: `invalid multiplier ${multiplier}` };
  }
  const ratio = lighter / multiplier / venue;
  if (Math.abs(ratio - 1) > tolerance) {
    return {
      ok: false,
      ratio,
      reason: `mark ratio ${ratio.toFixed(6)} is more than ${(tolerance * 100).toFixed(2)}% away from 1`,
    };
  }
  return { ok: true, ratio };
}

export interface MarkRatioFailure {
  entry: LighterSymbolEntry;
  result: MarkRatioResult;
}

// Run the guard over mapped symbols. Symbols in `failed` must be disabled until a later check passes.
export function evaluateMarkRatios(
  entries: Iterable<LighterSymbolEntry>,
  getLighterMark: (entry: LighterSymbolEntry) => number | string | null | undefined,
  getVenueMark: (botSymbol: string) => number | string | null | undefined,
  tolerance = MARK_RATIO_TOLERANCE
): { passed: LighterSymbolEntry[]; failed: MarkRatioFailure[] } {
  const passed: LighterSymbolEntry[] = [];
  const failed: MarkRatioFailure[] = [];
  for (const entry of entries) {
    const result = checkMarkRatio(getLighterMark(entry), getVenueMark(entry.botSymbol), entry.multiplier, tolerance);
    if (result.ok) passed.push(entry);
    else failed.push({ entry, result });
  }
  return { passed, failed };
}

// Lighter price / size -> bot units for a mapped symbol (liquidation events; multiplier 1 is a no-op)
export function toBotPrice(lighterPrice: number, entry: Pick<LighterSymbolEntry, 'multiplier'>): number {
  return entry.multiplier === 1 ? lighterPrice : lighterPrice / entry.multiplier;
}

export function toBotQuantity(lighterQuantity: number, entry: Pick<LighterSymbolEntry, 'multiplier'>): number {
  return entry.multiplier === 1 ? lighterQuantity : lighterQuantity * entry.multiplier;
}
