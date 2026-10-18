import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { ExchangeAdapter } from '../exchange/types';
import { createPublicExchangeAdapter } from '../exchange/registry';

interface MarkPriceData {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  timestamp: number;
}

export class PriceService extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscribedSymbols: Set<string> = new Set();
  private markPrices: Map<string, MarkPriceData> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private isConnecting = false;
  private readonly exchange: ExchangeAdapter;

  // Mark prices stream from the given exchange, else the default venue
  constructor(exchange?: ExchangeAdapter) {
    super();
    this.exchange = exchange ?? createPublicExchangeAdapter();
  }

  async start(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;

    try {
      // Subscribe to all market mark price updates
      this.ws = new WebSocket(this.exchange.getMarkPriceStreamUrl());

      this.ws.on('open', () => {
        console.log('🔗 Price Service: Connected to mark price stream');
        this.reconnectAttempts = 0;
        this.isConnecting = false;
        this.emit('connected');
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const events = JSON.parse(data.toString());
          this.handleMarkPriceUpdates(events);
        } catch (error) {
          console.error('Price Service: Failed to parse message:', error);
        }
      });

      this.ws.on('error', (error) => {
        console.error('Price Service: WebSocket error:', error);
        this.emit('error', error);
      });

      this.ws.on('close', () => {
        console.log('🔌 Price Service: WebSocket closed');
        this.isConnecting = false;
        this.emit('disconnected');

        // Attempt reconnection
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
          console.log(`🔄 Price Service: Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

          setTimeout(() => {
            if (this.ws?.readyState !== WebSocket.OPEN) {
              this.connect();
            }
          }, delay);
        } else {
          console.error('❌ Price Service: Max reconnection attempts reached');
          this.emit('maxReconnectAttemptsReached');
        }
      });

    } catch (error) {
      console.error('Price Service: Connection failed:', error);
      this.isConnecting = false;
      throw error;
    }
  }

  private handleMarkPriceUpdates(events: any[]): void {
    if (!Array.isArray(events)) {
      events = [events];
    }

    const updates: MarkPriceData[] = [];

    events.forEach(event => {
      if (event.e === 'markPriceUpdate') {
        const markPriceData: MarkPriceData = {
          symbol: event.s,
          markPrice: event.p,
          indexPrice: event.i,
          timestamp: event.E
        };

        this.markPrices.set(event.s, markPriceData);

        // Only emit for symbols we're tracking
        if (this.subscribedSymbols.has(event.s) || this.subscribedSymbols.size === 0) {
          updates.push(markPriceData);
        }
      }
    });

    if (updates.length > 0) {
      this.emit('markPriceUpdate', updates);
    }
  }

  // Subscribe to specific symbols (for filtering)
  subscribeToSymbols(symbols: string[]): void {
    symbols.forEach(symbol => {
      this.subscribedSymbols.add(symbol.toUpperCase());
    });
    console.log(`📊 Price Service: Tracking symbols: ${Array.from(this.subscribedSymbols).join(', ')}`);
  }

  // Unsubscribe from symbols
  unsubscribeFromSymbols(symbols: string[]): void {
    symbols.forEach(symbol => {
      this.subscribedSymbols.delete(symbol.toUpperCase());
    });
  }

  // Get current mark price for a symbol
  getMarkPrice(symbol: string): MarkPriceData | null {
    return this.markPrices.get(symbol.toUpperCase()) || null;
  }

  // Get all current mark prices
  getAllMarkPrices(): Map<string, MarkPriceData> {
    return new Map(this.markPrices);
  }

  // Check if connected
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // Stop the service
  stop(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscribedSymbols.clear();
    this.markPrices.clear();
    this.reconnectAttempts = 0;
    console.log('⏹️  Price Service: Stopped');
  }
}

// Singleton instance
let priceServiceInstance: PriceService | null = null;

export function getPriceService(): PriceService | null {
  return priceServiceInstance;
}

export async function initializePriceService(exchange?: ExchangeAdapter): Promise<PriceService> {
  if (!priceServiceInstance) {
    priceServiceInstance = new PriceService(exchange);
    await priceServiceInstance.start();
  }
  return priceServiceInstance;
}

export function stopPriceService(): void {
  if (priceServiceInstance) {
    priceServiceInstance.stop();
    priceServiceInstance = null;
  }
}