import type { LighterSocket, LighterSocketFactory } from '../../../src/lib/exchange/lighter/ws';

// In-memory stand-in for a `ws` WebSocket: the test plays the server (open, frames, close, error) and reads
// what the client sent. No network.
export class FakeLighterSocket implements LighterSocket {
  readyState = 0; // CONNECTING
  readonly sent: Record<string, any>[] = [];
  terminated = false;
  closed = false;
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  constructor(readonly url: string) {}

  on(event: string, listener: (...args: any[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  // Answer client pings like the Lighter server does (turn off to test the pong timeout)
  autoPong = true;

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket is not open');
    const message = JSON.parse(data);
    this.sent.push(message);
    if (this.autoPong && message.type === 'ping') this.serverSend({ type: 'pong' });
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }

  // ===== Server side =====

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  // A frame as the server sends it (objects are JSON-encoded into a Buffer like `ws` delivers them)
  serverSend(frame: unknown): void {
    const text = typeof frame === 'string' ? frame : JSON.stringify(frame);
    this.emit('message', Buffer.from(text, 'utf8'));
  }

  serverClose(code = 1006): void {
    this.readyState = 3;
    this.emit('close', code, Buffer.from(''));
  }

  fail(error: Error = new Error('ECONNRESET')): void {
    this.emit('error', error);
  }

  // Channels of the subscribe / unsubscribe frames the client sent, in order
  subscribes(): string[] {
    return this.sent.filter(message => message.type === 'subscribe').map(message => message.channel);
  }

  unsubscribes(): string[] {
    return this.sent.filter(message => message.type === 'unsubscribe').map(message => message.channel);
  }

  count(type: string): number {
    return this.sent.filter(message => message.type === type).length;
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

export function fakeSocketFactory(): { sockets: FakeLighterSocket[]; factory: LighterSocketFactory; last(): FakeLighterSocket } {
  const sockets: FakeLighterSocket[] = [];
  return {
    sockets,
    factory: (url: string) => {
      const socket = new FakeLighterSocket(url);
      sockets.push(socket);
      return socket;
    },
    last: () => {
      const socket = sockets[sockets.length - 1];
      if (!socket) throw new Error('no socket was created');
      return socket;
    },
  };
}
