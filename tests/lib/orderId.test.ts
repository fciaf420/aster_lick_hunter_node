/**
 * @jest-environment node
 */
import { compareOrderIds, normalizeOrderId } from '../../src/lib/exchange/orderId';

describe('normalizeOrderId', () => {
  it('keeps numeric ids as the same number', () => {
    expect(normalizeOrderId(1001)).toBe(1001);
    expect(normalizeOrderId(281474976710655)).toBe(281474976710655); // 2^48 - 1, largest Lighter client order index
  });

  it('turns integer strings a JS number holds exactly into numbers (what parseInt did for Aster ids)', () => {
    expect(normalizeOrderId('1001')).toBe(1001);
    expect(normalizeOrderId('9007199254740991')).toBe(9007199254740991); // 2^53 - 1
  });

  it('never rounds ids above 2^53 (Lighter order_index)', () => {
    expect(normalizeOrderId('9007199254740993')).toBe('9007199254740993');
    expect(normalizeOrderId('576460752303423611')).toBe('576460752303423611');
  });

  it('leaves non-numeric ids untouched', () => {
    expect(normalizeOrderId('al_sl_BTCUSDT_123')).toBe('al_sl_BTCUSDT_123');
    expect(normalizeOrderId('')).toBe('');
  });
});

describe('compareOrderIds', () => {
  it('orders numeric ids by value', () => {
    expect([1003, 1001, 1002].sort(compareOrderIds)).toEqual([1001, 1002, 1003]);
  });

  it('orders big string ids exactly, even when they round to the same number', () => {
    const ids = ['576460752303423611', '576460752303423610'];
    expect(Number(ids[0])).toBe(Number(ids[1]));
    expect([...ids].sort(compareOrderIds)).toEqual(['576460752303423610', '576460752303423611']);
  });

  it('orders mixed number and string ids by value', () => {
    expect(['9007199254740993', 5, '7'].sort(compareOrderIds)).toEqual([5, '7', '9007199254740993']);
  });
});
