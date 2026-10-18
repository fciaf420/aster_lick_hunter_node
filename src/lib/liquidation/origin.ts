import type { LiquidationEvent } from '../types';

// Where a LiquidationEvent came from, kept beside the event (not on it, so its shape stays the hunter's) and read
// by liquidation storage: the venue and the venue's id for the liquidation let the hunter's copy and the feed's
// own record of the same liquidation land in one row. Events without an origin are Aster forceOrder events.
export interface LiquidationOrigin {
  venue: string;
  externalId: string | null;
  mode?: 'live' | 'shadow' | null;   // Feed mode when the event was produced (Lighter shadow / live)
}

const origins = new WeakMap<LiquidationEvent, LiquidationOrigin>();

export function setLiquidationOrigin(event: LiquidationEvent, origin: LiquidationOrigin): void {
  origins.set(event, origin);
}

export function getLiquidationOrigin(event: LiquidationEvent): LiquidationOrigin | undefined {
  return origins.get(event);
}
