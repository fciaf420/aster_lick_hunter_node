import type { OrderId } from './types';

// Canonical form of an order id (see OrderId in ./types): a decimal string that a JS number holds
// exactly becomes that number, so Aster's numeric ids stay numeric and compare equal however they
// arrived. Anything else (e.g. a Lighter order_index above 2^53) stays a string and is never rounded.
export function normalizeOrderId(id: OrderId): OrderId {
  if (typeof id === 'number') return id;
  if (/^\d+$/.test(id)) {
    const value = Number(id);
    if (Number.isSafeInteger(value)) return value;
  }
  return id;
}

function asBigInt(id: OrderId): bigint | null {
  if (typeof id === 'number') return Number.isInteger(id) ? BigInt(id) : null;
  return /^\d+$/.test(id) ? BigInt(id) : null;
}

// Sort comparator: plain subtraction for numeric ids (unchanged Aster ordering), exact integer
// comparison when a string id is involved, text order for anything non-numeric
export function compareOrderIds(a: OrderId, b: OrderId): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = asBigInt(a);
  const y = asBigInt(b);
  if (x !== null && y !== null) return x < y ? -1 : x > y ? 1 : 0;
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
