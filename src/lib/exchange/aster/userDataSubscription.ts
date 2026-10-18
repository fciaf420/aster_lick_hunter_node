import WebSocket from 'ws';
import { USER_DATA_EVENT_TYPES } from '../types';
import type { UserDataEvent, UserDataHandlers, UserDataSubscription } from '../types';
import { logWithTimestamp, logErrorWithTimestamp } from '../../utils/timestamp';

const KEEPALIVE_INTERVAL_MS = 30 * 60 * 1000;
const RECONNECT_DELAY_MS = 5000;

// listenKey REST calls and stream URL of a Binance-style venue (AsterAdapter implements these)
export interface ListenKeyApi {
  createUserDataStream(): Promise<string>;
  keepAliveUserDataStream(): Promise<void>;
  closeUserDataStream(): Promise<void>;
  getUserDataStreamUrl(listenKey: string): string;
}

export interface ListenKeySubscriptionOptions {
  keepaliveIntervalMs?: number;  // Defaults to 30 min
  reconnectDelayMs?: number;     // Defaults to 5 s
}

// Loaded on first use so importing the adapter (Next.js API routes do) doesn't start the error logger
function getErrorLogger() {
  return require('../../services/errorLogger').errorLogger;
}

function isUserDataEvent(event: any): event is UserDataEvent {
  return USER_DATA_EVENT_TYPES.includes(event?.e);
}

// Binance-style user data stream: POST a listenKey, connect to its WebSocket, PUT a keepalive every
// 30 min, and after a drop wait 5 s, run beforeReconnect, then start over with a fresh listenKey.
// close() stops the keepalive, closes the socket and DELETEs the listenKey. Requests and timing are the
// ones PositionManager used when it ran the stream itself.
export class ListenKeyUserDataSubscription implements UserDataSubscription {
  private ws: WebSocket | null = null;
  private listenKey: string | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly api: ListenKeyApi,
    private readonly handlers: UserDataHandlers,
    private readonly options: ListenKeySubscriptionOptions = {}
  ) {}

  // Resolves once the listenKey exists and the socket is created (handlers.onConnected fires on open)
  async open(): Promise<void> {
    this.listenKey = await this.api.createUserDataStream();
logWithTimestamp('User data stream: got listenKey');

    const streamUrl = this.api.getUserDataStreamUrl(this.listenKey);
    const ws = new WebSocket(streamUrl);
    this.ws = ws;

    ws.on('open', () => {
      // Keepalive every 30 min
      if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = setInterval(() => this.keepalive(), this.options.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS);
      this.handlers.onConnected?.();
    });

    ws.on('message', (data: Buffer) => {
      try {
        const event = JSON.parse(data.toString());
        if (isUserDataEvent(event)) {
          this.handlers.onEvent(event);
        }
      } catch (error) {
logErrorWithTimestamp('User data stream: WS message error:', error);
      }
    });

    ws.on('error', (error) => {
logErrorWithTimestamp('User data stream WS error:', error);
      // Log to error database
      getErrorLogger().logWebSocketError(
        streamUrl,
        error instanceof Error ? error : new Error(String(error)),
        1
      );
      this.handlers.onError?.(error);
    });

    ws.on('close', () => {
      this.handlers.onDisconnected?.();
      if (!this.closed) {
        // Re-sync, then reconnect with a fresh listenKey
        setTimeout(async () => {
          if (this.closed) return;
          await this.handlers.beforeReconnect?.();
          if (this.closed) return;
          await this.open();
        }, this.options.reconnectDelayMs ?? RECONNECT_DELAY_MS);
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.ws) this.ws.close();
    if (!this.listenKey) return;
    try {
      await this.api.closeUserDataStream();
logWithTimestamp('User data stream: closed');
    } catch (error) {
logErrorWithTimestamp('User data stream: close error:', error);
    }
  }

  private async keepalive(): Promise<void> {
    if (!this.listenKey) return;
    try {
      await this.api.keepAliveUserDataStream();
logWithTimestamp('User data stream: keepalive sent');
    } catch (error) {
logErrorWithTimestamp('User data stream: keepalive error:', error);
      // Log to error database
      getErrorLogger().logApiError(
        '/fapi/v1/listenKey',
        'PUT',
        error instanceof Error ? 0 : (error as any)?.response?.status || 0,
        error,
        { component: 'PositionManager', userAction: 'Keepalive' }
      );
    }
  }
}
