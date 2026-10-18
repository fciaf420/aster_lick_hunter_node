import type { Config, LiquidationEvent } from '../types';
import type { LiquidationSourceId } from '../exchange/types';

// Error reported by a liquidation source. 'message': one frame could not be handled (the stream stays up).
// 'connection': the socket failed; the source reconnects by itself after reconnectDelayMs.
export type LiquidationSourceError =
  | { kind: 'message'; rawMessage: string }
  | { kind: 'connection'; url: string; reconnectDelayMs: number };

// Lifecycle callbacks for the hunter (logging and UI notices); the source handles reconnecting itself
export interface LiquidationSourceHooks {
  onConnected?(): void;
  // Called on every close. reconnectDelayMs is null when the source was stopped and will not reconnect.
  onDisconnected?(info: { reconnectDelayMs: number | null }): void;
  onError?(error: unknown, info: LiquidationSourceError): void;
}

// A feed of liquidations from one venue, translated to LiquidationEvent (Binance forceOrder semantics:
// side is the forced order's side, SELL = a long was liquidated)
export interface LiquidationSource {
  readonly id: LiquidationSourceId;
  start(onLiquidation: (event: LiquidationEvent) => void, hooks?: LiquidationSourceHooks): void;
  stop(): void;
}

// What a source may need from the bot. The Aster stream needs nothing; per-market sources (e.g. Lighter)
// read the configured symbols through getConfig so runtime config changes are picked up.
export interface LiquidationSourceDeps {
  getConfig?: () => Config;
}
