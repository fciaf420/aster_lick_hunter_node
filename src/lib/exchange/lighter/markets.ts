import axios from 'axios';
import { logErrorWithTimestamp, logWarnWithTimestamp, logWithTimestamp } from '../../utils/timestamp';
import { getProfile, lighterRestUrl, type LighterProfile, type LighterProfileName } from './profiles';
import {
  MAX_BASE_AMOUNT,
  MAX_PRICE,
  QUOTE_DECIMALS,
  formatScaled,
  fromBaseAmountUnits,
  fromPriceUnits,
  notionalUnits,
  scaleDecimal,
  toBaseAmountUnits,
  toPriceUnits,
  worstPriceUnits,
  type LighterOrderSide,
  type Rounding,
  type UnitOptions,
} from './scaling';
import {
  buildSymbolMap,
  type LighterSymbolEntry,
  type LighterSymbolMap,
  type LighterSymbolMapOptions,
  type LighterSymbolRejection,
} from './symbols';
import { buildExchangeInfo, type LighterExchangeInfo } from './filters';

// Lighter perp market metadata (spec §3.1): GET {api}/api/v1/orderBookDetails?filter=perp, loaded at startup
// and refreshed every 5 minutes like the official frontend. Fails closed: a market whose precision can't be
// verified is left out entirely, a market that fails the tradability filter refuses new positions, and every
// lookup throws until the first load has succeeded.

export const LIGHTER_MARKET_REFRESH_MS = 5 * 60 * 1000;
export const LIGHTER_MARKET_MAX_STALE_MS = 15 * 60 * 1000;   // Three missed refreshes
export const ORDER_BOOK_DETAILS_PATH = '/api/v1/orderBookDetails';
export const MARGIN_FRACTION_TICK = 10000;                    // Margin fractions are in 1/10000 (lighter-go)
export const NIL_ACCOUNT_INDEX = 281474976710655;             // 2^48 - 1: "no account" in market_config

export interface LighterMarket {
  marketId: number;
  symbol: string;                       // Backend symbol, e.g. 'BTC' or '1000PEPE'
  status: string;                       // 'active' | 'inactive'
  sizeDecimals: number;
  priceDecimals: number;
  minBaseAmount: string;                // As listed, human units
  minQuoteAmount: string;               // USDC
  orderQuoteLimit: string;              // Max notional per order, USDC
  minBaseAmountUnits: number;           // ceil(min_base_amount x 10^size_decimals), at least 1
  minQuoteMicro: number;                // ceil(min_quote_amount x 10^6)
  orderQuoteLimitMicro: number;         // floor(order_quote_limit x 10^6)
  defaultInitialMarginFraction: number; // 1/10000 units
  minInitialMarginFraction: number;
  maintenanceMarginFraction: number;
  maxLeverage: number;                  // floor(10000 / min_initial_margin_fraction); 0 when unset
  insuranceFundAccountIndex: number | null; // null when unset (nil value)
  takerFeePercent: string;              // Percent strings; the real fee depends on the account tier
  makerFeePercent: string;
  markPrice: number | null;             // REST snapshot; the WS market_stats feed is fresher
  indexPrice: number | null;
  lastTradePrice: number | null;
  tradable: boolean;                    // Passes the tradability filter: new positions allowed
  untradableReasons: readonly string[];
}

export interface LighterMarketRejection {
  symbol?: string;
  marketId?: number;
  reasons: string[];
}

export type LighterMarketErrorCode =
  | 'NOT_LOADED'
  | 'BAD_RESPONSE'
  | 'UNKNOWN_SYMBOL'
  | 'UNKNOWN_MARKET'
  | 'UNTRADABLE'
  | 'STALE'
  | 'MULTIPLIER'
  | 'ORDER_LIMIT';

export class LighterMarketError extends Error {
  readonly code: LighterMarketErrorCode;
  readonly symbol?: string;

  constructor(message: string, code: LighterMarketErrorCode, symbol?: string) {
    super(message);
    this.name = 'LighterMarketError';
    this.code = code;
    this.symbol = symbol;
  }
}

// ===== Parsing =====

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
const ONE_PATTERN = /^0*1(\.0+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function intField(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

function isOne(value: unknown): boolean {
  return value === 1 || (typeof value === 'string' && ONE_PATTERN.test(value));
}

function optionalPrice(value: unknown): number | null {
  const price = typeof value === 'string' ? (DECIMAL_PATTERN.test(value) ? Number(value) : NaN) : value;
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
}

// Scaled value of a decimal string as a safe integer, or undefined
function scaledField(value: string, decimals: number, rounding: Rounding): number | undefined {
  try {
    const units = scaleDecimal(value, decimals, rounding);
    return units <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(units) : undefined;
  } catch {
    return undefined;
  }
}

// Normalize one PerpsOrderBookDetail. Anything that makes the integer scaling uncertain rejects the market;
// anything that only bars new positions marks it untradable (spec §3.1 filter, re-run on every refresh).
export function parseMarket(raw: unknown): { market: LighterMarket } | { rejection: LighterMarketRejection } {
  if (!isRecord(raw)) return { rejection: { reasons: ['not an object'] } };

  const problems: string[] = [];
  const symbol = typeof raw.symbol === 'string' && raw.symbol !== '' ? raw.symbol : undefined;
  const marketId = intField(raw.market_id, 0, Number.MAX_SAFE_INTEGER);
  if (symbol === undefined) problems.push('symbol missing');
  if (marketId === undefined) problems.push(`market_id ${String(raw.market_id)} is not a non-negative integer`);
  if (raw.market_type !== 'perp') problems.push(`market_type ${String(raw.market_type)}`);

  const sizeDecimals = intField(raw.size_decimals, 0, QUOTE_DECIMALS);
  const priceDecimals = intField(raw.price_decimals, 0, QUOTE_DECIMALS);
  if (sizeDecimals === undefined) problems.push(`size_decimals ${String(raw.size_decimals)}`);
  if (priceDecimals === undefined) problems.push(`price_decimals ${String(raw.price_decimals)}`);
  if (sizeDecimals !== undefined && raw.supported_size_decimals !== sizeDecimals) {
    problems.push(`supported_size_decimals ${String(raw.supported_size_decimals)} differs from size_decimals ${sizeDecimals}`);
  }
  if (priceDecimals !== undefined && raw.supported_price_decimals !== priceDecimals) {
    problems.push(`supported_price_decimals ${String(raw.supported_price_decimals)} differs from price_decimals ${priceDecimals}`);
  }
  if (sizeDecimals !== undefined && priceDecimals !== undefined && sizeDecimals + priceDecimals !== QUOTE_DECIMALS) {
    problems.push(`size_decimals + price_decimals = ${sizeDecimals + priceDecimals}, expected ${QUOTE_DECIMALS}`);
  }
  if (!isOne(raw.multiplier)) problems.push(`multiplier ${String(raw.multiplier)}`);
  if (!isOne(raw.quote_multiplier)) problems.push(`quote_multiplier ${String(raw.quote_multiplier)}`);

  const decimalText = (field: string): string | undefined => {
    const value = raw[field];
    if (typeof value === 'string' && DECIMAL_PATTERN.test(value)) return value;
    problems.push(`${field} ${String(value)} is not a decimal string`);
    return undefined;
  };
  const minBaseAmount = decimalText('min_base_amount');
  const minQuoteAmount = decimalText('min_quote_amount');
  const orderQuoteLimit = decimalText('order_quote_limit');

  // 0 shows up on delisted markets (MKR); it only bars trading (checked below)
  const marginFraction = (field: string): number | undefined => {
    const value = intField(raw[field], 0, MARGIN_FRACTION_TICK);
    if (value === undefined) problems.push(`${field} ${String(raw[field])}`);
    return value;
  };
  const defaultImf = marginFraction('default_initial_margin_fraction');
  const minImf = marginFraction('min_initial_margin_fraction');
  const maintenanceMf = marginFraction('maintenance_margin_fraction');

  let minBaseAmountUnits: number | undefined;
  let minQuoteMicro: number | undefined;
  let orderQuoteLimitMicro: number | undefined;
  if (sizeDecimals !== undefined && minBaseAmount !== undefined) {
    minBaseAmountUnits = scaledField(minBaseAmount, sizeDecimals, 'ceil');
    if (minBaseAmountUnits === undefined || minBaseAmountUnits > MAX_BASE_AMOUNT) {
      problems.push(`min_base_amount ${minBaseAmount} out of range`);
    }
  }
  if (minQuoteAmount !== undefined) {
    minQuoteMicro = scaledField(minQuoteAmount, QUOTE_DECIMALS, 'ceil');
    if (minQuoteMicro === undefined) problems.push(`min_quote_amount ${minQuoteAmount} out of range`);
  }
  if (orderQuoteLimit !== undefined) {
    orderQuoteLimitMicro = scaledField(orderQuoteLimit, QUOTE_DECIMALS, 'floor');
    if (orderQuoteLimitMicro === undefined) problems.push(`order_quote_limit ${orderQuoteLimit} out of range`);
  }

  if (
    problems.length > 0 || symbol === undefined || marketId === undefined ||
    sizeDecimals === undefined || priceDecimals === undefined ||
    minBaseAmount === undefined || minQuoteAmount === undefined || orderQuoteLimit === undefined ||
    minBaseAmountUnits === undefined || minQuoteMicro === undefined || orderQuoteLimitMicro === undefined ||
    defaultImf === undefined || minImf === undefined || maintenanceMf === undefined
  ) {
    return { rejection: { symbol, marketId, reasons: problems } };
  }

  // Tradability filter. Every check requires the known-good value, so unknown values also bar trading.
  const untradableReasons: string[] = [];
  if (raw.status !== 'active') untradableReasons.push(`status ${String(raw.status)}`);
  let insuranceFundAccountIndex: number | null = null;
  const config = raw.market_config;
  if (!isRecord(config)) {
    untradableReasons.push('market_config missing');
  } else {
    if (config.force_reduce_only !== false) untradableReasons.push('force reduce-only');
    if (config.hidden !== false) untradableReasons.push('hidden');
    if (config.market_margin_mode !== 0) untradableReasons.push(`isolated margin only (market_margin_mode ${String(config.market_margin_mode)})`);
    if (config.trading_hours !== '') untradableReasons.push(`trading hours ${JSON.stringify(config.trading_hours)}`);
    if (config.liquidation_mode !== 0) untradableReasons.push(`liquidation mode ${String(config.liquidation_mode)}`);
    const insuranceFund = intField(config.insurance_fund_account_index, 0, NIL_ACCOUNT_INDEX);
    if (insuranceFund === undefined) {
      untradableReasons.push(`insurance_fund_account_index ${String(config.insurance_fund_account_index)} unreadable`);
    } else if (insuranceFund !== NIL_ACCOUNT_INDEX) {
      insuranceFundAccountIndex = insuranceFund;
    }
  }
  // market_flags other than 0 can make a market isolated-only (lighter-ts utils/marketFlags.ts)
  if (raw.market_flags !== 0) untradableReasons.push(`market_flags ${String(raw.market_flags)}`);
  if (orderQuoteLimitMicro === 0) {
    untradableReasons.push(`order_quote_limit ${orderQuoteLimit} allows no orders`);
  } else if (orderQuoteLimitMicro < minQuoteMicro) {
    untradableReasons.push(`order_quote_limit ${orderQuoteLimit} is below min_quote_amount ${minQuoteAmount}`);
  }
  if (minImf === 0 || defaultImf === 0 || maintenanceMf === 0) {
    untradableReasons.push(`margin fractions not set (min ${minImf}, default ${defaultImf}, maintenance ${maintenanceMf})`);
  }

  const market: LighterMarket = {
    marketId,
    symbol,
    status: String(raw.status),
    sizeDecimals,
    priceDecimals,
    minBaseAmount,
    minQuoteAmount,
    orderQuoteLimit,
    minBaseAmountUnits: Math.max(1, minBaseAmountUnits),
    minQuoteMicro,
    orderQuoteLimitMicro,
    defaultInitialMarginFraction: defaultImf,
    minInitialMarginFraction: minImf,
    maintenanceMarginFraction: maintenanceMf,
    maxLeverage: minImf > 0 ? Math.floor(MARGIN_FRACTION_TICK / minImf) : 0,
    insuranceFundAccountIndex,
    takerFeePercent: typeof raw.taker_fee === 'string' ? raw.taker_fee : '',
    makerFeePercent: typeof raw.maker_fee === 'string' ? raw.maker_fee : '',
    markPrice: optionalPrice(raw.mark_price),
    indexPrice: optionalPrice(raw.index_price),
    lastTradePrice: optionalPrice(raw.last_trade_price),
    tradable: untradableReasons.length === 0,
    untradableReasons: Object.freeze(untradableReasons),
  };
  return { market: Object.freeze(market) };
}

// Parse an orderBookDetails response. Throws for an unusable envelope; individual bad markets and markets
// sharing a symbol or market_id are returned in `rejected` (a duplicate makes both copies ambiguous).
export function parseOrderBookDetails(body: unknown): { markets: LighterMarket[]; rejected: LighterMarketRejection[] } {
  if (!isRecord(body)) {
    throw new LighterMarketError('orderBookDetails response is not a JSON object', 'BAD_RESPONSE');
  }
  if (body.code !== undefined && body.code !== 200) {
    const message = typeof body.message === 'string' ? `: ${body.message}` : '';
    throw new LighterMarketError(`orderBookDetails returned code ${String(body.code)}${message}`, 'BAD_RESPONSE');
  }
  if (!Array.isArray(body.order_book_details)) {
    throw new LighterMarketError('orderBookDetails response has no order_book_details array', 'BAD_RESPONSE');
  }

  const parsed: LighterMarket[] = [];
  const rejected: LighterMarketRejection[] = [];
  for (const raw of body.order_book_details) {
    const result = parseMarket(raw);
    if ('market' in result) parsed.push(result.market);
    else rejected.push(result.rejection);
  }

  const symbolCounts = new Map<string, number>();
  const idCounts = new Map<number, number>();
  for (const market of parsed) {
    symbolCounts.set(market.symbol, (symbolCounts.get(market.symbol) ?? 0) + 1);
    idCounts.set(market.marketId, (idCounts.get(market.marketId) ?? 0) + 1);
  }
  const markets: LighterMarket[] = [];
  for (const market of parsed) {
    const reasons: string[] = [];
    if ((symbolCounts.get(market.symbol) ?? 0) > 1) reasons.push(`duplicate symbol ${market.symbol}`);
    if ((idCounts.get(market.marketId) ?? 0) > 1) reasons.push(`duplicate market_id ${market.marketId}`);
    if (reasons.length > 0) rejected.push({ symbol: market.symbol, marketId: market.marketId, reasons });
    else markets.push(market);
  }
  return { markets, rejected };
}

// ===== Leverage and open-interest helpers =====

// Leverage -> InitialMarginFraction for UpdateLeverage (spec §3.5, §5.5): cap at the market maximum, then
// imf = ceil(10000 / leverage) clamped to [min_initial_margin_fraction, 10000]. Rounding up gives slightly
// less leverage than asked, never more.
export function leverageToImf(
  market: Pick<LighterMarket, 'minInitialMarginFraction' | 'maxLeverage'>,
  leverage: number
): { leverage: number; initialMarginFraction: number; effectiveLeverage: number; capped: boolean } {
  if (typeof leverage !== 'number' || !Number.isFinite(leverage) || leverage <= 0) {
    throw new RangeError(`Invalid leverage ${String(leverage)}`);
  }
  const minImf = market.minInitialMarginFraction;
  if (!Number.isInteger(minImf) || minImf < 1 || minImf > MARGIN_FRACTION_TICK || !(market.maxLeverage >= 1)) {
    throw new RangeError(`Market has no usable initial margin fraction (min ${minImf}, max leverage ${market.maxLeverage})`);
  }
  const applied = Math.min(leverage, market.maxLeverage);
  const imf = Math.min(MARGIN_FRACTION_TICK, Math.max(market.minInitialMarginFraction, Math.ceil(MARGIN_FRACTION_TICK / applied)));
  return {
    leverage: applied,
    initialMarginFraction: imf,
    effectiveLeverage: MARGIN_FRACTION_TICK / imf,
    capped: applied < leverage,
  };
}

// open_interest_limit at or above this (2^56), or 0, means the market has no cap (lighter-ts MAX_OI_LIMIT)
export const LIGHTER_NO_OPEN_INTEREST_LIMIT = 2 ** 56;
// open_interest_limit is in millionths of open_interest's unit: the FE divides it by 1e6 before comparing
export const LIGHTER_OPEN_INTEREST_LIMIT_SCALE = 1e6;

// The exchange forces reduce-only once open_interest x 2 >= open_interest_limit / 1e6 (raw WS market_stats values;
// lighter-ts selectCurrentMarketOpenInterestLimit + selectIsOpenInterestLimitReached). A limit of 0 or >= 2^56 is
// "no cap" (false). null when a value is missing or unreadable: the caller decides what that means.
export function isOpenInterestCapped(openInterest: unknown, openInterestLimit: unknown): boolean | null {
  const oi = typeof openInterest === 'string' ? (openInterest.trim() === '' ? NaN : Number(openInterest)) : openInterest;
  const limit = typeof openInterestLimit === 'string' ? (openInterestLimit.trim() === '' ? NaN : Number(openInterestLimit)) : openInterestLimit;
  if (typeof oi !== 'number' || typeof limit !== 'number' || !Number.isFinite(oi) || !Number.isFinite(limit) || oi < 0 || limit < 0) {
    return null;
  }
  if (limit === 0 || limit >= LIGHTER_NO_OPEN_INTEREST_LIMIT) return false;
  return oi * 2 >= limit / LIGHTER_OPEN_INTEREST_LIMIT_SCALE;
}

// ===== Cache =====

// GET returning the parsed JSON body (wire it to the bot's rate-limited REST client)
export type LighterHttpGet = (url: string) => Promise<unknown>;

export interface LighterMarketCacheOptions {
  profile: LighterProfile | LighterProfileName;
  // Which bot symbols map to which markets; a function is re-read on every load (config reloads)
  symbols: LighterSymbolMapOptions | (() => LighterSymbolMapOptions);
  httpGet?: LighterHttpGet;
  refreshIntervalMs?: number;
  maxStaleMs?: number;
  now?: () => number;
}

export interface MappedLighterMarket extends LighterSymbolEntry {
  market: LighterMarket;
}

export interface MarketLookupOptions {
  // Return markets that refuse new positions (closing, protecting and translating existing positions).
  // Without it, lookups throw for untradable markets and while the metadata is stale.
  allowUntradable?: boolean;
}

const defaultHttpGet: LighterHttpGet = async (url: string) => (await axios.get(url, { timeout: 10_000 })).data;

const EMPTY_SYMBOL_MAP: LighterSymbolMap = { bySymbol: new Map(), byMarketId: new Map(), rejected: [] };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LighterMarketCache {
  readonly profile: LighterProfile;
  private readonly httpGet: LighterHttpGet;
  private readonly refreshIntervalMs: number;
  private readonly maxStaleMs: number;
  private readonly now: () => number;
  private symbolOptions: LighterSymbolMapOptions | (() => LighterSymbolMapOptions);

  private marketsById = new Map<number, LighterMarket>();
  private symbolMap: LighterSymbolMap = EMPTY_SYMBOL_MAP;
  private rejectedMarketList: LighterMarketRejection[] = [];
  private loadedAt: number | null = null;
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<(cache: LighterMarketCache) => void>();
  private loggedNotices = new Set<string>();

  constructor(options: LighterMarketCacheOptions) {
    this.profile = typeof options.profile === 'string' ? getProfile(options.profile) : options.profile;
    this.symbolOptions = options.symbols;
    this.httpGet = options.httpGet ?? defaultHttpGet;
    this.refreshIntervalMs = options.refreshIntervalMs ?? LIGHTER_MARKET_REFRESH_MS;
    this.maxStaleMs = options.maxStaleMs ?? LIGHTER_MARKET_MAX_STALE_MS;
    this.now = options.now ?? Date.now;
  }

  // ----- Loading -----

  get lastLoadedAt(): number | null {
    return this.loadedAt;
  }

  isLoaded(): boolean {
    return this.loadedAt !== null;
  }

  isStale(): boolean {
    return this.loadedAt === null || this.now() - this.loadedAt > this.maxStaleMs;
  }

  // Fetch and apply the market list. Rejects when the response is unusable; the previous snapshot stays.
  load(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.fetchAndApply().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  // Load on first use; when stale, try a refresh but keep serving the last snapshot if it fails
  async ensureLoaded(): Promise<void> {
    if (this.loadedAt === null) {
      await this.load();
      return;
    }
    if (this.isStale()) {
      try {
        await this.load();
      } catch (error) {
        logWarnWithTimestamp(`LighterMarketCache: refresh failed, using market data from ${new Date(this.loadedAt).toISOString()}:`, errorMessage(error));
      }
    }
  }

  // Refresh every refreshIntervalMs (5 minutes by default) until stop()
  startAutoRefresh(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.load().catch(error => {
        logErrorWithTimestamp(`LighterMarketCache: refresh from ${this.profile.name} failed (keeping the previous market data):`, errorMessage(error));
      });
    }, this.refreshIntervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Replace the symbol mapping (config change) and rebuild it from the current market data
  setSymbolOptions(options: LighterSymbolMapOptions | (() => LighterSymbolMapOptions)): void {
    this.symbolOptions = options;
    if (this.loadedAt !== null) {
      this.symbolMap = this.buildMap(this.marketsById);
      this.logMapNotices();
      this.notify();
    }
  }

  // Called after every successful load and mapping change. Returns an unsubscribe function.
  onUpdate(listener: (cache: LighterMarketCache) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async fetchAndApply(): Promise<void> {
    const url = lighterRestUrl(this.profile, ORDER_BOOK_DETAILS_PATH, { filter: 'perp' });
    const body = await this.httpGet(url);
    const { markets, rejected } = parseOrderBookDetails(body);
    if (markets.length === 0) {
      throw new LighterMarketError(
        `Lighter ${this.profile.name} returned no usable perp markets (${rejected.length} rejected)`,
        'BAD_RESPONSE'
      );
    }

    const next = new Map<number, LighterMarket>(markets.map(market => [market.marketId, market]));
    const nextMap = this.buildMap(next);  // Before committing: a bad symbol config leaves the old state

    const firstLoad = this.loadedAt === null;
    if (!firstLoad) this.logMarketChanges(next);
    this.marketsById = next;
    this.symbolMap = nextMap;
    this.rejectedMarketList = rejected;
    this.loadedAt = this.now();

    if (firstLoad) {
      const tradable = markets.filter(market => market.tradable).length;
      logWithTimestamp(`LighterMarketCache: loaded ${markets.length} perp markets from ${this.profile.name} (${tradable} tradable, ${nextMap.bySymbol.size} mapped to bot symbols)`);
    }
    this.logMapNotices();
    this.notify();
  }

  private buildMap(markets: Map<number, LighterMarket>): LighterSymbolMap {
    const options = typeof this.symbolOptions === 'function' ? this.symbolOptions() : this.symbolOptions;
    return buildSymbolMap(markets.values(), options);
  }

  // Precision and tradability changes on mapped markets between two loads
  private logMarketChanges(next: Map<number, LighterMarket>): void {
    for (const entry of this.symbolMap.bySymbol.values()) {
      const before = this.marketsById.get(entry.marketId);
      const after = next.get(entry.marketId);
      if (!before) continue;
      if (!after || after.symbol !== before.symbol) {
        logErrorWithTimestamp(`LighterMarketCache: ${entry.botSymbol} (Lighter ${before.symbol}, market ${entry.marketId}) is no longer listed with usable metadata`);
        continue;
      }
      if (after.sizeDecimals !== before.sizeDecimals || after.priceDecimals !== before.priceDecimals) {
        logErrorWithTimestamp(`LighterMarketCache: ${entry.botSymbol} precision changed: size decimals ${before.sizeDecimals} -> ${after.sizeDecimals}, price decimals ${before.priceDecimals} -> ${after.priceDecimals}`);
      }
      if (after.tradable !== before.tradable) {
        if (after.tradable) logWithTimestamp(`LighterMarketCache: ${entry.botSymbol} is tradable again`);
        else logWarnWithTimestamp(`LighterMarketCache: ${entry.botSymbol} no longer accepts new positions: ${after.untradableReasons.join(', ')}`);
      }
    }
  }

  // Log mapping problems and untradable mapped symbols once, and again only after they change
  private logMapNotices(): void {
    const notices = new Set<string>();
    for (const rejection of this.symbolMap.rejected) {
      notices.add(`${rejection.botSymbol} is not mapped to a Lighter market: ${rejection.reason}`);
    }
    for (const entry of this.symbolMap.bySymbol.values()) {
      const market = this.marketsById.get(entry.marketId);
      if (market && !market.tradable) {
        notices.add(`${entry.botSymbol} (Lighter ${market.symbol}) refuses new positions: ${market.untradableReasons.join(', ')}`);
      }
      if (entry.multiplier !== 1) {
        notices.add(`${entry.botSymbol} maps to Lighter ${entry.lighterSymbol} x${entry.multiplier}: usable as a liquidation feed only, not for trading on Lighter`);
      }
    }
    for (const notice of notices) {
      if (!this.loggedNotices.has(notice)) logWarnWithTimestamp(`LighterMarketCache: ${notice}`);
    }
    this.loggedNotices = notices;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this);
      } catch (error) {
        logErrorWithTimestamp('LighterMarketCache: update listener failed:', errorMessage(error));
      }
    }
  }

  // ----- Lookups -----

  private assertLoaded(symbol?: string): void {
    if (this.loadedAt === null) {
      throw new LighterMarketError('Lighter market data has not been loaded', 'NOT_LOADED', symbol);
    }
  }

  // Every market with verified precision, tradable or not, mapped or not
  markets(): LighterMarket[] {
    return [...this.marketsById.values()];
  }

  // Market by id whether or not a bot symbol maps to it (e.g. a position opened outside the bot)
  findMarket(marketId: number): LighterMarket | undefined {
    return this.marketsById.get(marketId);
  }

  // Mapped symbols, tradable or not
  entries(): MappedLighterMarket[] {
    const result: MappedLighterMarket[] = [];
    for (const entry of this.symbolMap.bySymbol.values()) {
      const market = this.marketsById.get(entry.marketId);
      if (market) result.push({ ...entry, market });
    }
    return result;
  }

  rejectedSymbols(): readonly LighterSymbolRejection[] {
    return this.symbolMap.rejected;
  }

  rejectedMarkets(): readonly LighterMarketRejection[] {
    return this.rejectedMarketList;
  }

  // Non-throwing lookups (tradable or not); undefined when unmapped or not loaded
  findBySymbol(botSymbol: string): MappedLighterMarket | undefined {
    const entry = this.symbolMap.bySymbol.get(botSymbol);
    const market = entry && this.marketsById.get(entry.marketId);
    return entry && market ? { ...entry, market } : undefined;
  }

  findByMarketId(marketId: number): MappedLighterMarket | undefined {
    const entry = this.symbolMap.byMarketId.get(marketId);
    const market = entry && this.marketsById.get(entry.marketId);
    return entry && market ? { ...entry, market } : undefined;
  }

  // Throwing lookups. By default the market must be tradable and the metadata fresh (new positions);
  // pass { allowUntradable: true } to close, protect or translate existing positions.
  getBySymbol(botSymbol: string, options: MarketLookupOptions = {}): MappedLighterMarket {
    this.assertLoaded(botSymbol);
    const entry = this.symbolMap.bySymbol.get(botSymbol);
    if (!entry) {
      const rejection = this.symbolMap.rejected.find(item => item.botSymbol === botSymbol);
      const reason = rejection ? rejection.reason : 'not on the Lighter symbol allowlist';
      throw new LighterMarketError(`${botSymbol} has no Lighter market: ${reason}`, 'UNKNOWN_SYMBOL', botSymbol);
    }
    return this.checked(entry, options);
  }

  getByMarketId(marketId: number, options: MarketLookupOptions = {}): MappedLighterMarket {
    this.assertLoaded();
    const entry = this.symbolMap.byMarketId.get(marketId);
    if (!entry) {
      const market = this.marketsById.get(marketId);
      const detail = market ? `Lighter ${market.symbol} is not mapped to a bot symbol` : 'unknown or unusable market';
      throw new LighterMarketError(`Lighter market ${marketId}: ${detail}`, 'UNKNOWN_MARKET');
    }
    return this.checked(entry, options);
  }

  private checked(entry: LighterSymbolEntry, options: MarketLookupOptions): MappedLighterMarket {
    const market = this.marketsById.get(entry.marketId);
    if (!market) {
      throw new LighterMarketError(`Lighter market ${entry.marketId} for ${entry.botSymbol} is missing`, 'UNKNOWN_MARKET', entry.botSymbol);
    }
    if (!options.allowUntradable) {
      if (this.isStale()) {
        const age = this.loadedAt === null ? 'never' : `${Math.round((this.now() - this.loadedAt) / 1000)}s ago`;
        throw new LighterMarketError(`Lighter market data is stale (last loaded ${age}); refusing new positions on ${entry.botSymbol}`, 'STALE', entry.botSymbol);
      }
      if (!market.tradable) {
        throw new LighterMarketError(
          `${entry.botSymbol} (Lighter ${market.symbol}) does not accept new positions: ${market.untradableReasons.join(', ')}`,
          'UNTRADABLE',
          entry.botSymbol
        );
      }
    }
    return { ...entry, market };
  }

  // Market used for order precision: mapped (tradable or not) with multiplier 1
  private precisionMarket(botSymbol: string): LighterMarket {
    const mapped = this.getBySymbol(botSymbol, { allowUntradable: true });
    if (mapped.multiplier !== 1) {
      throw new LighterMarketError(
        `${botSymbol} maps to Lighter ${mapped.lighterSymbol} with multiplier ${mapped.multiplier}; only multiplier 1 can be traded on Lighter`,
        'MULTIPLIER',
        botSymbol
      );
    }
    return mapped.market;
  }

  // ----- Precision (spec §3.2) -----

  // Quantity -> BaseAmount, rounded down by default. Throws when it rounds to 0 or exceeds 2^48-1.
  toBaseAmount(botSymbol: string, quantity: number | string, rounding: Rounding = 'floor', options?: UnitOptions): number {
    return toBaseAmountUnits(quantity, this.precisionMarket(botSymbol).sizeDecimals, rounding, options);
  }

  // Price -> Price units. 'exact' by default: an off-tick price throws. Use limitPriceRounding(side) for
  // limit prices and worstPrice() for MARKET / protective worst prices.
  toPrice(botSymbol: string, price: number | string, rounding: Rounding = 'exact', options?: UnitOptions): number {
    return toPriceUnits(price, this.precisionMarket(botSymbol).priceDecimals, rounding, options);
  }

  // Worst execution price in Price units: BUY ceil(ref x (1 + bps)), SELL floor(ref x (1 - bps))
  worstPrice(botSymbol: string, referencePrice: number | string, side: LighterOrderSide, slippageBps: number | string): number {
    return worstPriceUnits(referencePrice, side, slippageBps, this.precisionMarket(botSymbol).priceDecimals);
  }

  fromBaseAmount(botSymbol: string, units: bigint | number | string): string {
    return fromBaseAmountUnits(units, this.precisionMarket(botSymbol).sizeDecimals);
  }

  fromPrice(botSymbol: string, units: bigint | number | string): string {
    return fromPriceUnits(units, this.precisionMarket(botSymbol).priceDecimals);
  }

  // The signer only checks integer ranges, so the adapter enforces the market limits (spec §3.2):
  //   BaseAmount >= min_base_amount, BaseAmount x Price >= min_quote_amount   (skipped for reduce-only)
  //   BaseAmount x Price <= order_quote_limit
  // For MARKET and protective orders pass the worst price.
  assertOrderLimits(botSymbol: string, baseAmount: number, price: number, options: { reduceOnly?: boolean } = {}): void {
    const market = this.precisionMarket(botSymbol);
    const fail = (message: string): never => {
      throw new LighterMarketError(`${botSymbol}: ${message}`, 'ORDER_LIMIT', botSymbol);
    };
    if (!Number.isSafeInteger(baseAmount) || baseAmount < 1 || baseAmount > MAX_BASE_AMOUNT) {
      fail(`BaseAmount ${baseAmount} is outside 1..${MAX_BASE_AMOUNT}`);
    }
    if (!Number.isSafeInteger(price) || price < 1 || price > MAX_PRICE) {
      fail(`Price ${price} is outside 1..${MAX_PRICE}`);
    }
    const notional = notionalUnits(baseAmount, price);
    const size = `${fromBaseAmountUnits(baseAmount, market.sizeDecimals)} ${market.symbol}`;
    const value = `$${formatScaled(notional, QUOTE_DECIMALS)}`;
    if (!options.reduceOnly) {
      if (baseAmount < market.minBaseAmountUnits) {
        fail(`size ${size} is below the minimum ${fromBaseAmountUnits(market.minBaseAmountUnits, market.sizeDecimals)}`);
      }
      if (notional < BigInt(market.minQuoteMicro)) {
        fail(`order value ${value} is below the minimum $${formatScaled(market.minQuoteMicro, QUOTE_DECIMALS)}`);
      }
    }
    if (notional > BigInt(market.orderQuoteLimitMicro)) {
      fail(`order value ${value} is above the per-order limit $${formatScaled(market.orderQuoteLimitMicro, QUOTE_DECIMALS)}`);
    }
  }

  // Binance-style exchangeInfo for the mapped symbols (spec §3.3). Status TRADING only when tradable.
  exchangeInfo(): LighterExchangeInfo {
    this.assertLoaded();
    return buildExchangeInfo(this.entries().map(({ market, ...entry }) => ({ entry, market })), this.now());
  }
}
