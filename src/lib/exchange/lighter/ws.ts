import WebSocket from 'ws';
import { logErrorWithTimestamp, logWarnWithTimestamp } from '../../utils/timestamp';

// Reusable Lighter (zkLighter) WebSocket client (spec §2.1, §2.2, §8 risk 19).
// - Connects to {ws}?readonly=true&encoding=json and sends subscribes only after the server's
//   {"type":"connected"} frame (lighter-python ws_client.py).
// - Answers server {"type":"ping"} with a pong, sends its own app-level ping every 15 s and reconnects when
//   no pong comes back within 15 s or when no frame at all arrives for 60 s (the server drops idle sockets).
// - Reconnects with exponential backoff (1 s .. 30 s, reset once a connection has been up for 60 s), and at
//   once on a {"type":"shutdown"} notice.
// - Tracks every subscription until the server acks it (subscribed/<x> with the channel echoed as "trade:1"),
//   retries after 3 s, 6 s, 10 s, then every 15 s, up to 10 attempts (lighter-ts wsChannelReconnectTimeout,
//   MAX_WS_CHANNEL_SUBSCRIBE_RETRIES), then reports the channel as failed. Subscriptions survive reconnects.
// One reconnect path per socket: events from a socket that is no longer current are ignored, so an 'error'
// followed by a 'close' never schedules two reconnects.

export const LIGHTER_WS_PING_INTERVAL_MS = 15_000;
export const LIGHTER_WS_PONG_TIMEOUT_MS = 15_000;
export const LIGHTER_WS_FRAME_TIMEOUT_MS = 60_000;
export const LIGHTER_WS_CONNECTED_TIMEOUT_MS = 10_000;
export const LIGHTER_WS_SUBSCRIBE_RETRY_DELAYS_MS: readonly number[] = [3_000, 6_000, 10_000, 15_000];
export const LIGHTER_WS_MAX_SUBSCRIBE_ATTEMPTS = 10;
export const LIGHTER_WS_RECONNECT_INITIAL_MS = 1_000;
export const LIGHTER_WS_RECONNECT_MAX_MS = 30_000;
export const LIGHTER_WS_STABLE_CONNECTION_MS = 60_000;

const SOCKET_OPEN = 1; // WebSocket.OPEN (same value for ws and the browser API)

// The parts of a `ws` WebSocket the client uses; tests inject a fake through LighterWsClientOptions.createSocket
export interface LighterSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'close', listener: (code: number, reason: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type LighterSocketFactory = (url: string) => LighterSocket;

export const defaultLighterSocketFactory: LighterSocketFactory = (url) => new WebSocket(url) as unknown as LighterSocket;

// A decoded server frame. Data frames carry `type` ('subscribed/trade', 'update/trade', ...) and `channel`
// ('trade:1'); error frames carry only `error`.
export interface LighterWsFrame {
  type?: string;
  channel?: string;
  [key: string]: unknown;
}

export type LighterWsDisconnectReason = 'close' | 'error' | 'frame-timeout' | 'pong-timeout' | 'shutdown' | 'stopped';

export interface LighterWsDisconnectInfo {
  reason: LighterWsDisconnectReason;
  error?: Error;                  // Set for 'error', 'frame-timeout' and 'pong-timeout'
  reconnectDelayMs: number | null; // null when the client was stopped and will not reconnect
}

export interface LighterWsHandlers {
  // Every data frame (subscribed/*, update/*, anything unrecognised), after acks have been recorded
  onMessage(frame: LighterWsFrame, rawMessage: string): void;
  // The server sent {"type":"connected"} (sessionId null when it never came and the client went ahead after
  // connectedTimeoutMs). Subscriptions are (re)sent right after this returns, so channels added here go out once.
  onSessionReady?(sessionId: string | null): void;
  // Called once per lost socket
  onDisconnected?(info: LighterWsDisconnectInfo): void;
  // A frame that is not JSON, or one whose onMessage handler threw (the socket stays up)
  onFrameError?(error: unknown, rawMessage: string): void;
  // {"error":{"code":..,"message":..}} frames (no `type`); they name no channel
  onServerError?(error: { code?: unknown; message?: unknown }, rawMessage: string): void;
  onChannelAcked?(channel: string): void;
  // No ack after maxSubscribeAttempts: the channel stays unsubscribed until the next reconnect
  onChannelFailed?(channel: string, attempts: number): void;
  onShutdownNotice?(closeInMs: number | null): void;
}

export interface LighterWsClientOptions {
  url: string;                         // Full stream URL; readonly=true&encoding=json are added when missing
  createSocket?: LighterSocketFactory; // Defaults to the `ws` package
  now?: () => number;
  pingIntervalMs?: number;             // 0 disables the client ping (and the pong check)
  pongTimeoutMs?: number;              // 0 disables the pong check
  frameTimeoutMs?: number;             // 0 disables the frame watchdog
  connectedTimeoutMs?: number;
  subscribeRetryDelaysMs?: readonly number[];
  maxSubscribeAttempts?: number;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  stableConnectionMs?: number;
  label?: string;                      // Log prefix, e.g. 'Lighter liquidations'
}

interface ChannelState {
  channel: string;
  message: Record<string, unknown>;
  attempts: number;
  acked: boolean;
  failed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

// The server echoes channels with ':' ("trade:1"); subscriptions use '/' ("trade/1")
export function normalizeLighterChannel(channel: string): string {
  return channel.replace(/:/g, '/');
}

// Ensure readonly=true and encoding=json (the only encoding this client decodes) on a stream URL
export function withLighterStreamParams(url: string): string {
  const parsed = new URL(url);
  const encoding = parsed.searchParams.get('encoding');
  if (encoding !== null && encoding !== 'json') {
    throw new Error(`Lighter stream URL must use encoding=json (got encoding=${encoding})`);
  }
  if (parsed.searchParams.get('readonly') === null) parsed.searchParams.set('readonly', 'true');
  if (encoding === null) parsed.searchParams.set('encoding', 'json');
  return parsed.toString();
}

function rawToText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return String(data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class LighterWsClient {
  readonly url: string;
  private readonly createSocket: LighterSocketFactory;
  private readonly now: () => number;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly frameTimeoutMs: number;
  private readonly connectedTimeoutMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly maxSubscribeAttempts: number;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly stableConnectionMs: number;
  private readonly label: string;

  private socket: LighterSocket | null = null;
  private running = false;
  private sessionReady = false;
  private sessionId: string | null = null;
  private openedAt: number | null = null;
  private lastFrameAt = 0;
  private reconnectAttempt = 0;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private connectedTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly channels = new Map<string, ChannelState>();
  // Channels dropped before their ack: a late ack gets an unsubscribe instead of a live stream
  private readonly cancelled = new Set<string>();

  constructor(options: LighterWsClientOptions, private readonly handlers: LighterWsHandlers) {
    this.url = withLighterStreamParams(options.url);
    this.createSocket = options.createSocket ?? defaultLighterSocketFactory;
    this.now = options.now ?? (() => Date.now());
    this.pingIntervalMs = options.pingIntervalMs ?? LIGHTER_WS_PING_INTERVAL_MS;
    this.pongTimeoutMs = options.pongTimeoutMs ?? LIGHTER_WS_PONG_TIMEOUT_MS;
    this.frameTimeoutMs = options.frameTimeoutMs ?? LIGHTER_WS_FRAME_TIMEOUT_MS;
    this.connectedTimeoutMs = options.connectedTimeoutMs ?? LIGHTER_WS_CONNECTED_TIMEOUT_MS;
    this.retryDelaysMs = options.subscribeRetryDelaysMs ?? LIGHTER_WS_SUBSCRIBE_RETRY_DELAYS_MS;
    this.maxSubscribeAttempts = options.maxSubscribeAttempts ?? LIGHTER_WS_MAX_SUBSCRIBE_ATTEMPTS;
    this.reconnectInitialMs = options.reconnectInitialMs ?? LIGHTER_WS_RECONNECT_INITIAL_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? LIGHTER_WS_RECONNECT_MAX_MS;
    this.stableConnectionMs = options.stableConnectionMs ?? LIGHTER_WS_STABLE_CONNECTION_MS;
    this.label = options.label ?? 'Lighter WS';
    if (this.retryDelaysMs.length === 0) throw new Error('subscribeRetryDelaysMs must not be empty');
  }

  get isRunning(): boolean {
    return this.running;
  }

  // True between the server's 'connected' frame and the loss of that socket
  get isSessionReady(): boolean {
    return this.sessionReady;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.reconnectAttempt = 0;
    this.connect();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.clearTimer('reconnectTimer');
    const socket = this.socket;
    if (socket) {
      this.drop(socket, 'stopped');
    } else {
      this.resetSession();
    }
  }

  // Add a subscription. It is sent now if the session is ready, else after the next 'connected' frame, and
  // retried until acked. `extra` adds fields to the subscribe frame (e.g. auth for private channels).
  subscribe(channel: string, extra: Record<string, unknown> = {}): void {
    if (this.channels.has(channel)) return;
    this.cancelled.delete(channel);
    const state: ChannelState = {
      channel,
      message: { ...extra, type: 'subscribe', channel },
      attempts: 0,
      acked: false,
      failed: false,
      timer: null,
    };
    this.channels.set(channel, state);
    if (this.sessionReady) this.sendSubscribe(state);
  }

  // Drop a subscription. An acked channel gets an unsubscribe frame; a pending one is forgotten and a late
  // ack for it is answered with an unsubscribe.
  unsubscribe(channel: string): void {
    const state = this.channels.get(channel);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    this.channels.delete(channel);
    if (!this.sessionReady) return;
    if (state.acked) {
      this.send({ type: 'unsubscribe', channel });
    } else if (state.attempts > 0) {
      this.cancelled.add(channel);
    }
  }

  hasChannel(channel: string): boolean {
    return this.channels.has(channel);
  }

  isAcked(channel: string): boolean {
    return this.channels.get(channel)?.acked === true;
  }

  isFailed(channel: string): boolean {
    return this.channels.get(channel)?.failed === true;
  }

  // Send a frame on the current socket; false when there is no open socket
  send(message: Record<string, unknown>): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      logWarnWithTimestamp(`${this.label}: send failed:`, error instanceof Error ? error.message : error);
      return false;
    }
  }

  // ===== Connection lifecycle =====

  private connect(): void {
    this.reconnectTimer = null;
    if (!this.running) return;

    let socket: LighterSocket;
    try {
      socket = this.createSocket(this.url);
    } catch (error) {
      this.scheduleReconnect('error', error instanceof Error ? error : new Error(String(error)));
      return;
    }

    this.socket = socket;
    this.resetSession();
    this.lastFrameAt = this.now();
    this.armWatchdog(socket); // Also covers a handshake that never completes

    socket.on('open', () => {
      if (socket !== this.socket) return;
      this.openedAt = this.now();
      this.lastFrameAt = this.openedAt;
      this.startHeartbeat(socket);
      if (this.connectedTimeoutMs > 0) {
        this.connectedTimer = setTimeout(() => {
          this.connectedTimer = null;
          if (socket !== this.socket || this.sessionReady) return;
          logWarnWithTimestamp(
            `${this.label}: no "connected" frame ${this.connectedTimeoutMs} ms after open; subscribing anyway (acks are still checked)`
          );
          this.beginSession(socket, null);
        }, this.connectedTimeoutMs);
      }
    });

    socket.on('message', (data: unknown) => {
      if (socket !== this.socket) return;
      this.handleRaw(socket, rawToText(data));
    });

    socket.on('error', (error: Error) => {
      if (socket !== this.socket) return;
      this.drop(socket, 'error', error instanceof Error ? error : new Error(String(error)));
    });

    socket.on('close', () => {
      if (socket !== this.socket) return;
      this.drop(socket, 'close');
    });
  }

  // Tear the current socket down (once) and reconnect unless stopped
  private drop(socket: LighterSocket, reason: LighterWsDisconnectReason, error?: Error): void {
    if (socket !== this.socket) return;
    const openedAt = this.openedAt;
    this.socket = null;
    this.resetSession();
    try {
      if (typeof socket.terminate === 'function') socket.terminate();
      else socket.close();
    } catch {
      // Already closed
    }

    if (!this.running || reason === 'stopped') {
      this.safely(() => this.handlers.onDisconnected?.({ reason, error, reconnectDelayMs: null }));
      return;
    }

    if (openedAt !== null && this.now() - openedAt >= this.stableConnectionMs) this.reconnectAttempt = 0;
    this.scheduleReconnect(reason, error);
  }

  private scheduleReconnect(reason: LighterWsDisconnectReason, error?: Error): void {
    let delay = 0;
    if (reason !== 'shutdown') {
      delay = Math.min(this.reconnectMaxMs, this.reconnectInitialMs * 2 ** this.reconnectAttempt);
      this.reconnectAttempt++;
    }
    this.safely(() => this.handlers.onDisconnected?.({ reason, error, reconnectDelayMs: delay }));
    if (!this.running || this.reconnectTimer) return; // A handler may have stopped the client
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  // Forget everything tied to the current socket; desired subscriptions stay and are resent next session
  private resetSession(): void {
    this.sessionReady = false;
    this.sessionId = null;
    this.openedAt = null;
    this.clearTimer('pingTimer');
    this.clearTimer('pongTimer');
    this.clearTimer('watchdogTimer');
    this.clearTimer('connectedTimer');
    this.cancelled.clear();
    for (const state of this.channels.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.attempts = 0;
      state.acked = false;
      state.failed = false;
    }
  }

  private beginSession(socket: LighterSocket, sessionId: string | null): void {
    this.clearTimer('connectedTimer');
    this.sessionReady = true;
    this.sessionId = sessionId;
    this.safely(() => this.handlers.onSessionReady?.(sessionId));
    if (socket !== this.socket || !this.sessionReady) return;
    for (const state of this.channels.values()) {
      if (state.attempts === 0) this.sendSubscribe(state);
    }
  }

  // ===== Keepalive =====

  private startHeartbeat(socket: LighterSocket): void {
    if (this.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      if (socket !== this.socket) return;
      // Arm the pong deadline first so a pong delivered during send() clears it
      if (this.pongTimeoutMs > 0 && !this.pongTimer) {
        this.pongTimer = setTimeout(() => {
          this.pongTimer = null;
          this.drop(socket, 'pong-timeout', new Error(`no pong within ${this.pongTimeoutMs} ms`));
        }, this.pongTimeoutMs);
      }
      this.send({ type: 'ping' });
    }, this.pingIntervalMs);
  }

  private armWatchdog(socket: LighterSocket): void {
    if (this.frameTimeoutMs <= 0) return;
    const check = () => {
      this.watchdogTimer = null;
      if (socket !== this.socket) return;
      const idle = this.now() - this.lastFrameAt;
      if (idle >= this.frameTimeoutMs) {
        this.drop(socket, 'frame-timeout', new Error(`no frame for ${idle} ms`));
        return;
      }
      this.watchdogTimer = setTimeout(check, this.frameTimeoutMs - idle);
    };
    this.watchdogTimer = setTimeout(check, this.frameTimeoutMs);
  }

  // ===== Frames =====

  private handleRaw(socket: LighterSocket, text: string): void {
    this.lastFrameAt = this.now();

    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch (error) {
      this.safely(() => this.handlers.onFrameError?.(error, text));
      return;
    }
    // The server sends null frames in groups of 3 (lighter-ts LighterWs.ts)
    if (!isRecord(frame)) return;

    const type = frame.type;
    switch (type) {
      case 'connected': {
        const sessionId = typeof frame.session_id === 'string' ? frame.session_id : null;
        if (!this.sessionReady) this.beginSession(socket, sessionId);
        else this.sessionId = sessionId; // Arrived after the connectedTimeoutMs fallback
        return;
      }
      case 'ping':
        this.send({ type: 'pong' });
        return;
      case 'pong':
        this.clearTimer('pongTimer');
        return;
      case 'shutdown': {
        const closeInMs = typeof frame.close_in_ms === 'number' ? frame.close_in_ms : null;
        this.safely(() => this.handlers.onShutdownNotice?.(closeInMs));
        this.drop(socket, 'shutdown');
        return;
      }
      case 'unsubscribed':
        if (typeof frame.channel === 'string') this.handleUnsubscribed(normalizeLighterChannel(frame.channel));
        return;
    }

    if (type === undefined && frame.error !== undefined) {
      const error = isRecord(frame.error) ? frame.error : { message: frame.error };
      this.safely(() => this.handlers.onServerError?.(error, text));
      return;
    }

    if (typeof type === 'string' && type.startsWith('subscribed') && typeof frame.channel === 'string') {
      const channel = normalizeLighterChannel(frame.channel);
      if (this.cancelled.has(channel)) {
        // Acked after we dropped it: unsubscribe and don't pass its data on
        this.cancelled.delete(channel);
        this.send({ type: 'unsubscribe', channel });
        return;
      }
      this.markAcked(channel);
    }

    try {
      this.handlers.onMessage(frame as LighterWsFrame, text);
    } catch (error) {
      this.safely(() => this.handlers.onFrameError?.(error, text));
    }
  }

  private markAcked(channel: string): void {
    const state = this.channels.get(channel);
    if (!state || state.acked) return;
    state.acked = true;
    state.failed = false;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    this.safely(() => this.handlers.onChannelAcked?.(channel));
  }

  // The server dropped a channel we still want: subscribe again from scratch
  private handleUnsubscribed(channel: string): void {
    const state = this.channels.get(channel);
    if (!state || !state.acked || !this.sessionReady) return;
    logWarnWithTimestamp(`${this.label}: server unsubscribed ${channel}; subscribing again`);
    state.acked = false;
    state.attempts = 0;
    this.sendSubscribe(state);
  }

  private sendSubscribe(state: ChannelState): void {
    if (state.timer) clearTimeout(state.timer);
    state.attempts++;
    state.failed = false;
    this.send(state.message);
    const delays = this.retryDelaysMs;
    const delay = delays[Math.min(state.attempts, delays.length) - 1];
    state.timer = setTimeout(() => {
      state.timer = null;
      if (state.acked || !this.sessionReady || this.channels.get(state.channel) !== state) return;
      if (state.attempts >= this.maxSubscribeAttempts) {
        state.failed = true;
        this.safely(() => this.handlers.onChannelFailed?.(state.channel, state.attempts));
        return;
      }
      this.sendSubscribe(state);
    }, delay);
  }

  // ===== Helpers =====

  private clearTimer(name: 'reconnectTimer' | 'pongTimer' | 'watchdogTimer' | 'connectedTimer' | 'pingTimer'): void {
    const timer = this[name];
    if (timer) {
      if (name === 'pingTimer') clearInterval(timer);
      else clearTimeout(timer);
    }
    this[name] = null;
  }

  // A throwing handler must not break the connection bookkeeping (several handlers run from timers)
  private safely(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      logErrorWithTimestamp(`${this.label}: handler error:`, error);
    }
  }
}
