// Exact conversion between human decimals and Lighter's integer order fields (spec §3.2):
//
//   BaseAmount    = qty   x 10^size_decimals    integer 1..2^48-1 (0 only for a position-tied reduce-only order)
//   Price         = price x 10^price_decimals   uint32 1..2^32-1 (0 is invalid, even for MARKET)
//   TriggerPrice  = same scale as Price; 0 means none
//   Notional µUSDC = BaseAmount x Price          exact because size_decimals + price_decimals = 6
//
// Everything runs on decimal strings and BigInt. Math.floor(x * 10 ** d) is never used: 0.29 * 100 = 28.999...
// The signer only range-checks integers and koffi silently wraps out-of-range numbers (4294967396 -> 100),
// so every integer handed out here has been range-checked.

export type Rounding = 'floor' | 'ceil' | 'exact';
export type LighterOrderSide = 'BUY' | 'SELL';

export const MAX_BASE_AMOUNT = 281474976710655;   // 2^48 - 1 (lighter-go MaxOrderBaseAmount)
export const MAX_PRICE = 4294967295;              // 2^32 - 1 (MaxOrderPrice, MaxOrderTriggerPrice)
export const QUOTE_DECIMALS = 6;                  // USDC; also size_decimals + price_decimals on every perp
const MAX_DECIMALS = 18;

// Numbers are first rounded to 15 significant digits. Every decimal with at most 15 significant digits
// survives a round trip through a double, so this recovers the value the caller meant and drops float
// noise (0.1 + 0.2 -> 0.3, 299999999.99999994 -> 300000000). Every in-range BaseAmount or Price has at
// most 15 digits, so no valid value loses precision.
const NUMBER_SIGNIFICANT_DIGITS = 15;

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TEN = BigInt(10);

function pow10(exponent: number): bigint {
  let result = ONE;
  for (let i = 0; i < exponent; i++) result *= TEN;
  return result;
}

function checkDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new RangeError(`Invalid decimals ${decimals}: expected an integer between 0 and ${MAX_DECIMALS}`);
  }
}

// "1.23456e-7" -> "0.000000123456", "1.5e+21" -> "1500000000000000000000"
function expandExponent(text: string): string {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(text);
  if (!match) throw new TypeError(`Cannot read number ${text}`);
  const [, whole, fraction = '', exponent] = match;
  if (!exponent) return fraction ? `${whole}.${fraction}` : whole;
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

// Canonical non-negative plain decimal string for a number or a decimal string.
// Strings must be plain decimals ("0.00010", "97312.47"); exponents, signs and blanks are refused.
export function toDecimalString(value: number | string): string {
  if (typeof value === 'string') {
    if (!DECIMAL_PATTERN.test(value)) {
      throw new TypeError(`Not a non-negative decimal: "${value}"`);
    }
    return value;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Not a finite number: ${String(value)}`);
  }
  if (value < 0) throw new RangeError(`Negative value ${value} where a non-negative decimal is required`);
  if (value === 0) return '0';
  const text = expandExponent(value.toPrecision(NUMBER_SIGNIFICANT_DIGITS));
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;   // "123.456000000000" -> "123.456"
}

// value x 10^decimals as an exact integer. 'exact' throws if digits beyond `decimals` are non-zero.
export function scaleDecimal(value: number | string, decimals: number, rounding: Rounding): bigint {
  checkDecimals(decimals);
  const text = toDecimalString(value);
  const [whole, fraction = ''] = text.split('.');
  const kept = BigInt(whole + fraction.slice(0, decimals).padEnd(decimals, '0'));
  const remainder = fraction.slice(decimals);
  if (!/[1-9]/.test(remainder)) return kept;
  if (rounding === 'exact') {
    throw new RangeError(`${text} has more than ${decimals} decimal places`);
  }
  return rounding === 'ceil' ? kept + ONE : kept;
}

// Integer units -> fixed-point decimal string with exactly `decimals` places: (973124, 1) -> "97312.4"
export function formatScaled(units: bigint | number | string, decimals: number): string {
  checkDecimals(decimals);
  let value: bigint;
  if (typeof units === 'bigint') {
    value = units;
  } else if (typeof units === 'number') {
    if (!Number.isSafeInteger(units)) throw new RangeError(`Not a safe integer: ${units}`);
    value = BigInt(units);
  } else {
    if (!/^-?\d+$/.test(units)) throw new TypeError(`Not an integer: "${units}"`);
    value = BigInt(units);
  }
  const negative = value < ZERO;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const text = decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
  return negative ? `-${text}` : text;
}

function checkedUnits(field: string, units: bigint, allowZero: boolean, max: number, context: string): number {
  if (units === ZERO && !allowZero) {
    throw new RangeError(`Lighter ${field} rounds to 0 (${context})`);
  }
  if (units < ZERO || units > BigInt(max)) {
    throw new RangeError(`Lighter ${field} ${units.toString()} is outside 0..${max} (${context})`);
  }
  return Number(units);
}

export interface UnitOptions {
  allowZero?: boolean;   // BaseAmount 0 = position-tied reduce-only; TriggerPrice 0 = no trigger
}

// Quantity -> BaseAmount. Sizes round down (spec §3.2) unless told otherwise.
export function toBaseAmountUnits(
  quantity: number | string,
  sizeDecimals: number,
  rounding: Rounding = 'floor',
  options: UnitOptions = {}
): number {
  const units = scaleDecimal(quantity, sizeDecimals, rounding);
  return checkedUnits('BaseAmount', units, options.allowZero === true, MAX_BASE_AMOUNT, `${quantity} at ${sizeDecimals} size decimals`);
}

// Price -> Price (or TriggerPrice) units. The rounding is the caller's decision: limitPriceRounding() for
// limit prices, worstPriceUnits() for MARKET and protective worst prices, 'exact' for tick-aligned prices.
export function toPriceUnits(
  price: number | string,
  priceDecimals: number,
  rounding: Rounding,
  options: UnitOptions = {}
): number {
  const units = scaleDecimal(price, priceDecimals, rounding);
  return checkedUnits('Price', units, options.allowZero === true, MAX_PRICE, `${price} at ${priceDecimals} price decimals`);
}

export function fromBaseAmountUnits(units: bigint | number | string, sizeDecimals: number): string {
  return formatScaled(units, sizeDecimals);
}

export function fromPriceUnits(units: bigint | number | string, priceDecimals: number): string {
  return formatScaled(units, priceDecimals);
}

// Limit prices never trade through the requested price: BUY rounds down, SELL rounds up
export function limitPriceRounding(side: LighterOrderSide): Rounding {
  return side === 'BUY' ? 'floor' : 'ceil';
}

// Worst prices leave at least the requested slippage room: BUY rounds up, SELL rounds down
export function worstPriceRounding(side: LighterOrderSide): Rounding {
  return side === 'BUY' ? 'ceil' : 'floor';
}

// Exact rational form of a decimal: value = numerator / 10^scale
function toRational(value: number | string): { numerator: bigint; scale: number } {
  const text = toDecimalString(value);
  const [whole, fraction = ''] = text.split('.');
  return { numerator: BigInt(whole + fraction), scale: fraction.length };
}

function divide(numerator: bigint, denominator: bigint, rounding: 'floor' | 'ceil'): bigint {
  const quotient = numerator / denominator; // both non-negative: truncation is floor
  return rounding === 'ceil' && quotient * denominator !== numerator ? quotient + ONE : quotient;
}

// MARKET / protective worst price in Price units (spec §3.2, §5.5):
//   BUY  ceil(ref x (1 + bps/10000))    SELL floor(ref x (1 - bps/10000))
// computed exactly from the decimal value of ref and bps.
export function worstPriceUnits(
  referencePrice: number | string,
  side: LighterOrderSide,
  slippageBps: number | string,
  priceDecimals: number
): number {
  checkDecimals(priceDecimals);
  const ref = toRational(referencePrice);
  const bps = toRational(slippageBps);
  // 1 +/- bps/10000 = (10000 x 10^bps.scale +/- bps.numerator) / (10000 x 10^bps.scale)
  const base = BigInt(10000) * pow10(bps.scale);
  if (bps.numerator >= base) {
    throw new RangeError(`Slippage ${slippageBps} bps must be below 10000`);
  }
  const factor = side === 'BUY' ? base + bps.numerator : base - bps.numerator;
  const numerator = ref.numerator * factor * pow10(priceDecimals);
  const denominator = pow10(ref.scale) * base;
  const units = divide(numerator, denominator, side === 'BUY' ? 'ceil' : 'floor');
  return checkedUnits('Price', units, false, MAX_PRICE,
    `${side} worst price from ${referencePrice} with ${slippageBps} bps at ${priceDecimals} price decimals`);
}

// BaseAmount x Price. In micro-USDC when size_decimals + price_decimals = 6 (every market that passes the
// LighterMarketCache filter).
export function notionalUnits(baseAmount: bigint | number, price: bigint | number): bigint {
  const toBig = (value: bigint | number, field: string): bigint => {
    if (typeof value === 'bigint') return value;
    if (!Number.isSafeInteger(value)) throw new RangeError(`${field} ${value} is not a safe integer`);
    return BigInt(value);
  };
  return toBig(baseAmount, 'BaseAmount') * toBig(price, 'Price');
}
