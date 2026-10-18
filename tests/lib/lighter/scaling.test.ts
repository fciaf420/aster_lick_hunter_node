/**
 * @jest-environment node
 */
import {
  MAX_BASE_AMOUNT,
  MAX_PRICE,
  formatScaled,
  fromBaseAmountUnits,
  fromPriceUnits,
  limitPriceRounding,
  notionalUnits,
  scaleDecimal,
  toBaseAmountUnits,
  toDecimalString,
  toPriceUnits,
  worstPriceRounding,
  worstPriceUnits,
} from '../../../src/lib/exchange/lighter/scaling';

const big = (value: string | number) => BigInt(value);

describe('Lighter scaling: spec §3.2 worked examples', () => {
  it('BTC (size 5, price 1 decimals): BUY LIMIT 0.012345 @ 97,312.47', () => {
    const baseAmount = toBaseAmountUnits(0.012345, 5);          // floor(1234.5)
    expect(baseAmount).toBe(1234);
    expect(fromBaseAmountUnits(baseAmount, 5)).toBe('0.01234');

    const buyPrice = toPriceUnits(97312.47, 1, limitPriceRounding('BUY'));   // floor(973124.7)
    const sellPrice = toPriceUnits(97312.47, 1, limitPriceRounding('SELL')); // ceil
    expect(buyPrice).toBe(973124);
    expect(sellPrice).toBe(973125);
    expect(fromPriceUnits(buyPrice, 1)).toBe('97312.4');

    const notional = notionalUnits(baseAmount, buyPrice);
    expect(notional).toBe(big(1200835016));                       // micro-USDC
    expect(formatScaled(notional, 6)).toBe('1200.835016');
    expect(notional >= scaleDecimal('10.000000', 6, 'ceil')).toBe(true); // min_quote_amount $10

    expect(scaleDecimal('0.00010', 5, 'ceil')).toBe(big(10));     // BTC minimum base is 10 integer units
  });

  it('BTC example gives the same integers from decimal strings', () => {
    expect(toBaseAmountUnits('0.012345', 5)).toBe(1234);
    expect(toPriceUnits('97312.47', 1, 'floor')).toBe(973124);
    expect(toPriceUnits('97312.47', 1, 'ceil')).toBe(973125);
  });

  it('ETH (size 4, price 2 decimals): 0.1 ETH @ $4050 is base_amount 1000, price 4050_00 (lighter-python example)', () => {
    expect(toBaseAmountUnits(0.1, 4)).toBe(1000);
    expect(toPriceUnits(4050, 2, 'exact')).toBe(405000);
    expect(toPriceUnits('4050', 2, 'exact')).toBe(405000);
  });

  it('1000PEPE (size 0, price 6 decimals, min base 3000): 12,345.6 @ 0.0123456', () => {
    const baseAmount = toBaseAmountUnits(12345.6, 0);
    expect(baseAmount).toBe(12345);
    const buyPrice = toPriceUnits(0.0123456, 6, limitPriceRounding('BUY'));
    expect(buyPrice).toBe(12345);
    expect(toPriceUnits(0.0123456, 6, limitPriceRounding('SELL'))).toBe(12346);

    const notional = notionalUnits(baseAmount, buyPrice);
    expect(formatScaled(notional, 6)).toBe('152.399025');
    expect(baseAmount >= Number(scaleDecimal('3000', 0, 'ceil'))).toBe(true);

    // Largest representable 1000PEPE price
    expect(fromPriceUnits(MAX_PRICE, 6)).toBe('4294.967295');
    expect(toPriceUnits('4294.967295', 6, 'exact')).toBe(MAX_PRICE);
    expect(() => toPriceUnits('4294.967296', 6, 'exact')).toThrow(RangeError);
  });
});

describe('Lighter scaling: no float error', () => {
  it('scales 0.29 to 29 where Math.floor(0.29 * 100) gives 28', () => {
    expect(Math.floor(0.29 * 100)).toBe(28);
    expect(toBaseAmountUnits(0.29, 2)).toBe(29);
    expect(toPriceUnits(0.29, 2, 'exact')).toBe(29);
  });

  it('drops float noise from computed numbers', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(toPriceUnits(0.1 + 0.2, 1, 'ceil')).toBe(3);           // must not ceil to 0.4
    expect(toPriceUnits(0.1 + 0.2, 1, 'exact')).toBe(3);
    expect(toBaseAmountUnits(0.1 + 0.7, 1)).toBe(8);              // 0.7999999999999999 must not floor to 0.7
    expect(toBaseAmountUnits(299999999.99999994, 0)).toBe(300000000);
    expect(toPriceUnits(1.005, 3, 'exact')).toBe(1005);           // the double is 1.00499999999999989...
    expect(toBaseAmountUnits(0.000105, 6)).toBe(105);
  });

  it('reads numbers written in exponent notation', () => {
    expect(toDecimalString(1e-7)).toBe('0.0000001');
    expect(toDecimalString(1.23456e-7)).toBe('0.000000123456');
    expect(toDecimalString(1.5e21)).toBe('1500000000000000000000');
    expect(toDecimalString(123.456)).toBe('123.456');
    expect(toDecimalString(0)).toBe('0');
    expect(toDecimalString(-0)).toBe('0');
    expect(toBaseAmountUnits(5e-5, 5)).toBe(5);
  });

  it('keeps decimal strings exactly as written', () => {
    expect(toDecimalString('0.00010')).toBe('0.00010');
    expect(scaleDecimal('281474976.710655', 6, 'exact')).toBe(big('281474976710655'));
    expect(scaleDecimal('0.000000000000000000001', 0, 'ceil')).toBe(big(1));
  });
});

describe('Lighter scaling: rounding', () => {
  it('floor drops extra digits, ceil rounds up only when they are non-zero', () => {
    expect(scaleDecimal('1.239', 2, 'floor')).toBe(big(123));
    expect(scaleDecimal('1.231', 2, 'ceil')).toBe(big(124));
    expect(scaleDecimal('1.230000', 2, 'ceil')).toBe(big(123));
    expect(scaleDecimal('1.2', 2, 'floor')).toBe(big(120));
    expect(scaleDecimal('7', 3, 'exact')).toBe(big(7000));
  });

  it('exact refuses values off the grid', () => {
    expect(() => scaleDecimal('1.231', 2, 'exact')).toThrow(RangeError);
    expect(() => toPriceUnits(97312.47, 1, 'exact')).toThrow(/more than 1 decimal/);
  });

  it('rounds limit prices so they never trade through and worst prices so they leave room', () => {
    expect(limitPriceRounding('BUY')).toBe('floor');
    expect(limitPriceRounding('SELL')).toBe('ceil');
    expect(worstPriceRounding('BUY')).toBe('ceil');
    expect(worstPriceRounding('SELL')).toBe('floor');
  });
});

describe('Lighter scaling: input validation', () => {
  it.each(['1e-5', '-1', '.5', '1.', ' 1', '1 ', '', 'abc', '0x10', '+1', '1,5', 'NaN', 'Infinity'])(
    'refuses the string %j',
    value => {
      expect(() => toDecimalString(value)).toThrow(TypeError);
      expect(() => toBaseAmountUnits(value, 2)).toThrow(TypeError);
    }
  );

  it('refuses non-finite and negative numbers', () => {
    expect(() => toDecimalString(NaN)).toThrow(TypeError);
    expect(() => toDecimalString(Infinity)).toThrow(TypeError);
    expect(() => toDecimalString(-Infinity)).toThrow(TypeError);
    expect(() => toDecimalString(-1)).toThrow(RangeError);
    expect(() => toPriceUnits(-97312.4, 1, 'floor')).toThrow(RangeError);
    expect(() => toDecimalString(undefined as unknown as number)).toThrow(TypeError);
  });

  it('refuses invalid decimals', () => {
    expect(() => scaleDecimal('1', -1, 'floor')).toThrow(RangeError);
    expect(() => scaleDecimal('1', 1.5, 'floor')).toThrow(RangeError);
    expect(() => scaleDecimal('1', 19, 'floor')).toThrow(RangeError);
    expect(() => formatScaled(1, -1)).toThrow(RangeError);
  });
});

describe('Lighter scaling: range guards (koffi would silently wrap these)', () => {
  it('accepts BaseAmount up to 2^48 - 1 and refuses 2^48', () => {
    expect(MAX_BASE_AMOUNT).toBe(2 ** 48 - 1);
    expect(toBaseAmountUnits('281474976710655', 0)).toBe(MAX_BASE_AMOUNT);
    expect(toBaseAmountUnits('2814749767.10655', 5)).toBe(MAX_BASE_AMOUNT);
    expect(() => toBaseAmountUnits('281474976710656', 0)).toThrow(RangeError);
    expect(() => toBaseAmountUnits('2814749767.10656', 5)).toThrow(RangeError);
  });

  it('refuses a BaseAmount that rounds to 0 unless zero is allowed', () => {
    expect(() => toBaseAmountUnits(0.000001, 5)).toThrow(/rounds to 0/);
    expect(() => toBaseAmountUnits(0, 5)).toThrow(/rounds to 0/);
    expect(toBaseAmountUnits(0, 5, 'floor', { allowZero: true })).toBe(0);
  });

  it('accepts Price 1..2^32 - 1 and refuses 0 and 2^32', () => {
    expect(MAX_PRICE).toBe(2 ** 32 - 1);
    expect(toPriceUnits('0.1', 1, 'exact')).toBe(1);
    expect(toPriceUnits('4294967295', 0, 'exact')).toBe(MAX_PRICE);
    expect(toPriceUnits('429496729.5', 1, 'exact')).toBe(MAX_PRICE);      // BTC maximum
    expect(() => toPriceUnits('429496729.6', 1, 'exact')).toThrow(RangeError);
    expect(() => toPriceUnits('4294967296', 0, 'exact')).toThrow(RangeError);
    expect(() => toPriceUnits(4294967396, 0, 'exact')).toThrow(RangeError); // koffi wraps this to 100
    expect(() => toPriceUnits(0, 1, 'floor')).toThrow(/rounds to 0/);
    expect(() => toPriceUnits(0.04, 1, 'floor')).toThrow(/rounds to 0/);
  });

  it('allows TriggerPrice 0 (no trigger) only when asked', () => {
    expect(toPriceUnits(0, 1, 'exact', { allowZero: true })).toBe(0);
    expect(() => toPriceUnits(0, 1, 'exact')).toThrow(RangeError);
  });

  it('returns plain safe integers', () => {
    const units = toPriceUnits(97312.4, 1, 'exact');
    expect(typeof units).toBe('number');
    expect(Number.isSafeInteger(units)).toBe(true);
  });
});

describe('formatScaled', () => {
  it('prints exactly the given number of decimals', () => {
    expect(formatScaled(973124, 1)).toBe('97312.4');
    expect(formatScaled(5, 3)).toBe('0.005');
    expect(formatScaled(1000, 4)).toBe('0.1000');
    expect(formatScaled(12345, 0)).toBe('12345');
    expect(formatScaled(0, 2)).toBe('0.00');
    expect(formatScaled(-5, 2)).toBe('-0.05');
    expect(formatScaled('281474976710655', 5)).toBe('2814749767.10655');
    expect(formatScaled(big('576460752303423611'), 0)).toBe('576460752303423611');
  });

  it('refuses unsafe numbers and non-integers', () => {
    expect(() => formatScaled(2 ** 53, 0)).toThrow(RangeError);
    expect(() => formatScaled(1.5, 0)).toThrow(RangeError);
    expect(() => formatScaled('1.5', 0)).toThrow(TypeError);
  });

  it('round-trips every in-range scaled value', () => {
    for (const [value, decimals] of [['0.01234', 5], ['97312.4', 1], ['0.012345', 6], ['3000', 0], ['42949672.95', 2]] as const) {
      expect(formatScaled(scaleDecimal(value, decimals, 'exact'), decimals)).toBe(value);
    }
  });
});

describe('notionalUnits', () => {
  it('multiplies exactly beyond 2^53', () => {
    expect(notionalUnits(MAX_BASE_AMOUNT, MAX_PRICE)).toBe(big(MAX_BASE_AMOUNT) * big(MAX_PRICE));
  });

  it('refuses unsafe inputs', () => {
    expect(() => notionalUnits(1.5, 10)).toThrow(RangeError);
    expect(() => notionalUnits(10, 2 ** 53)).toThrow(RangeError);
  });
});

describe('worstPriceUnits', () => {
  it('BUY rounds ref x (1 + s) up, SELL rounds ref x (1 - s) down', () => {
    // 97312.4 x 1.005 = 97798.962 and 97312.4 x 0.995 = 96825.838
    expect(worstPriceUnits(97312.4, 'BUY', 50, 1)).toBe(977990);
    expect(worstPriceUnits(97312.4, 'SELL', 50, 1)).toBe(968258);
    // 0.0123456 x 1.01 = 0.012469056 and x 0.99 = 0.012222144
    expect(worstPriceUnits('0.0123456', 'BUY', 100, 6)).toBe(12470);
    expect(worstPriceUnits('0.0123456', 'SELL', 100, 6)).toBe(12222);
  });

  it('does not bump values that land exactly on the grid', () => {
    expect(worstPriceUnits(100, 'BUY', 100, 2)).toBe(10100);
    expect(worstPriceUnits(100, 'SELL', 100, 2)).toBe(9900);
    expect(worstPriceUnits(100, 'BUY', 0, 2)).toBe(10000);
  });

  it('takes fractional basis points exactly', () => {
    // 4050 x (1 + 12.5 / 10000) = 4055.0625
    expect(worstPriceUnits(4050, 'BUY', '12.5', 2)).toBe(405507);
    expect(worstPriceUnits(4050, 'SELL', 12.5, 2)).toBe(404493);   // 4044.9375 floored
  });

  it('refuses slippage of 100% or more, negative slippage, and out-of-range results', () => {
    expect(() => worstPriceUnits(100, 'SELL', 10000, 2)).toThrow(RangeError);
    expect(() => worstPriceUnits(100, 'BUY', -1, 2)).toThrow(RangeError);
    expect(() => worstPriceUnits(4294.967295, 'BUY', 1, 6)).toThrow(RangeError);
    expect(() => worstPriceUnits(0.000001, 'SELL', 100, 6)).toThrow(/rounds to 0/);
  });
});
