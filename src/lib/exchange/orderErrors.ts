// Venue-neutral classification of order placement errors.
//
// An error with orderMayExist === true means the venue could not tell whether the order was placed (a timeout,
// an unknown tx outcome, an order that executed but is not visible yet). The caller must not send a replacement
// order, or it may end up with two. Errors without the flag (exchange rejections, validation errors, Aster HTTP
// errors) mean the order was definitely not placed.

export function orderMayExist(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { orderMayExist?: unknown }).orderMayExist === true;
}

export function isDefinitelyNotPlaced(error: unknown): boolean {
  return !orderMayExist(error);
}

// For an order that may exist: the time (ms) after which it can no longer execute, when the venue knows it
// (e.g. a signed tx's expiry plus grace). Null when unknown.
export function orderMayExistUntil(error: unknown): number | null {
  if (!orderMayExist(error)) return null;
  const until = (error as { mayExistUntil?: unknown }).mayExistUntil;
  return typeof until === 'number' && Number.isFinite(until) && until > 0 ? until : null;
}
