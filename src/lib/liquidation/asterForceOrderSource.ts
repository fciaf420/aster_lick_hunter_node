import WebSocket from 'ws';
import type { LiquidationEvent } from '../types';
import { ASTER_STREAM_BASE_URL } from '../exchange/aster/constants';
import type { LiquidationSource, LiquidationSourceHooks } from './types';

export const ASTER_FORCE_ORDER_STREAM_URL = `${ASTER_STREAM_BASE_URL}/ws/!forceOrder@arr`;
const RECONNECT_DELAY_MS = 5000;

export interface AsterForceOrderSourceOptions {
  url?: string;               // Defaults to the public Aster stream (tests point it at a local server)
  reconnectDelayMs?: number;  // Defaults to 5 s
}

// Aster (Binance-style) forceOrder frame -> LiquidationEvent; null for any other frame
export function parseForceOrderEvent(event: any): LiquidationEvent | null {
  if (event?.e !== 'forceOrder') return null; // Not a liquidation event

  return {
    symbol: event.o.s,
    side: event.o.S,
    orderType: event.o.o,
    quantity: parseFloat(event.o.q),
    price: parseFloat(event.o.p),
    averagePrice: parseFloat(event.o.ap),
    orderStatus: event.o.X,
    orderLastFilledQuantity: parseFloat(event.o.l),
    orderFilledAccumulatedQuantity: parseFloat(event.o.z),
    orderTradeTime: event.o.T,
    eventTime: event.E,
    qty: parseFloat(event.o.q), // Keep for backward compatibility
    time: event.E, // Keep for backward compatibility
  };
}

// Public !forceOrder@arr stream (all symbols). Reconnects 5 s after an error, and 5 s after a close
// while running, exactly as the hunter's own WebSocket code did before it moved here.
export class AsterForceOrderSource implements LiquidationSource {
  readonly id = 'aster' as const;
  private ws: WebSocket | null = null;
  private running = false;
  private onLiquidation: ((event: LiquidationEvent) => void) | null = null;
  private hooks: LiquidationSourceHooks = {};
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Sockets closed by stop(): their close reports a final disconnect and never reconnects
  private readonly stoppedSockets = new Set<WebSocket>();

  constructor(private readonly options: AsterForceOrderSourceOptions = {}) {}

  start(onLiquidation: (event: LiquidationEvent) => void, hooks: LiquidationSourceHooks = {}): void {
    this.onLiquidation = onLiquidation;
    this.hooks = hooks;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      this.stoppedSockets.add(ws);
      ws.close();
    }
  }

  // Reconnects only from 'close' (which follows every 'error'), only while running and only for the current
  // socket, so an error plus its close, or a stop() then start(), never opens a second stream
  private connect(): void {
    this.reconnectTimer = null;
    if (!this.running) return;
    const url = this.options.url ?? ASTER_FORCE_ORDER_STREAM_URL;
    const reconnectDelayMs = this.options.reconnectDelayMs ?? RECONNECT_DELAY_MS;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws === ws) this.hooks.onConnected?.();
    });

    ws.on('message', (data: Buffer) => {
      if (this.ws !== ws) return;
      try {
        const liquidation = parseForceOrderEvent(JSON.parse(data.toString()));
        if (liquidation) {
          this.onLiquidation?.(liquidation);
        }
      } catch (error) {
        this.hooks.onError?.(error, { kind: 'message', rawMessage: data.toString() });
      }
    });

    ws.on('error', (error) => {
      if (this.ws !== ws) return;
      // 'close' follows and schedules the reconnect
      this.hooks.onError?.(error, { kind: 'connection', url, reconnectDelayMs });
    });

    ws.on('close', () => {
      if (this.stoppedSockets.delete(ws)) {
        this.hooks.onDisconnected?.({ reconnectDelayMs: null });
        return;
      }
      if (this.ws !== ws) return;   // A socket replaced by a newer one
      this.ws = null;
      const reconnect = this.running;
      this.hooks.onDisconnected?.({ reconnectDelayMs: reconnect ? reconnectDelayMs : null });
      if (reconnect) {
        this.reconnectTimer = setTimeout(() => this.connect(), reconnectDelayMs);
      }
    });
  }
}
