import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { Config } from '../types';
import type { ExchangeAdapter } from '../exchange/types';
import { createPublicExchangeAdapter } from '../exchange/registry';

interface KlineStreamData {
  e: string;     // Event type
  E: number;     // Event time
  s: string;     // Symbol
  k: {
    t: number;   // Kline start time
    T: number;   // Kline close time
    s: string;   // Symbol
    i: string;   // Interval
    f: number;   // First trade ID
    L: number;   // Last trade ID
    o: string;   // Open price
    c: string;   // Close price
    h: string;   // High price
    l: string;   // Low price
    v: string;   // Base asset volume
    n: number;   // Number of trades
    x: boolean;  // Is this kline closed?
    q: string;   // Quote asset volume
  };
}

interface VWAPData {
  symbol: string;
  vwap: number;
  currentPrice: number;
  position: 'above' | 'below';
  timestamp: number;
}

export class VWAPStreamer extends EventEmitter {
  private ws: WebSocket | null = null;
  private isRunning = false;
  private klineBuffers: Map<string, Array<{high: number, low: number, close: number, volume: number, quoteVolume: number}>> = new Map();
  private vwapValues: Map<string, VWAPData> = new Map();
  private symbolConfigs: Map<string, {timeframe: string, lookback: number}> = new Map();
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private updateInterval: NodeJS.Timeout | null = null;
  private exchange: ExchangeAdapter | null = null;

  constructor() {
    super();
  }

  // Klines come from the given exchange, else the default venue's public market data
  private getExchange(): ExchangeAdapter {
    this.exchange ??= createPublicExchangeAdapter();
    return this.exchange;
  }

  public async start(config: Config, exchange?: ExchangeAdapter): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    if (exchange) this.exchange = exchange;

    // Collect symbols with VWAP protection enabled
    for (const [symbol, symbolConfig] of Object.entries(config.symbols)) {
      if (symbolConfig.vwapProtection) {
        const timeframe = symbolConfig.vwapTimeframe || '1m';
        const lookback = symbolConfig.vwapLookback || 100;
        this.symbolConfigs.set(symbol, { timeframe, lookback });
        this.klineBuffers.set(symbol, []);
        console.log(`📊 VWAP Streamer: Monitoring ${symbol} with ${timeframe} timeframe, ${lookback} lookback`);
      }
    }

    if (this.symbolConfigs.size === 0) {
      console.log('📊 VWAP Streamer: No symbols with VWAP protection configured');
      this.isRunning = false;
      return;
    }

    // Load initial historical klines for each symbol
    await this.loadInitialData();

    this.connectWebSocket();

    // Calculate and broadcast VWAP every second
    this.updateInterval = setInterval(() => {
      this.calculateAndBroadcastVWAP();
    }, 1000);
  }

  private async loadInitialData(): Promise<void> {
    console.log('📊 VWAP Streamer: Loading initial historical klines...');

    for (const [symbol, config] of this.symbolConfigs.entries()) {
      try {
        // Fetch historical klines
        const klines = await this.getExchange().getKlines(symbol, config.timeframe, config.lookback);

        if (klines && klines.length > 0) {
          const buffer: Array<{high: number, low: number, close: number, volume: number, quoteVolume: number}> = [];

          for (const kline of klines) {
            buffer.push({
              high: parseFloat(kline.high),
              low: parseFloat(kline.low),
              close: parseFloat(kline.close),
              volume: parseFloat(kline.volume),
              quoteVolume: 0  // Quote volume not available from current API, will be calculated
            });
          }

          this.klineBuffers.set(symbol, buffer);
          console.log(`📊 VWAP Streamer: Loaded ${buffer.length} historical klines for ${symbol}`);
        }
      } catch (error) {
        console.error(`📊 VWAP Streamer: Failed to load historical data for ${symbol}:`, error);
      }
    }

    // Calculate initial VWAP with historical data
    this.calculateAndBroadcastVWAP();
  }

  public stop(): void {
    this.isRunning = false;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.klineBuffers.clear();
    this.vwapValues.clear();
    this.symbolConfigs.clear();
  }

  private connectWebSocket(): void {
    if (!this.isRunning) return;

    // Subscribe to klines for all symbols with their timeframes
    const subscriptions = [...this.symbolConfigs.entries()].map(([symbol, config]) => ({ symbol, interval: config.timeframe }));
    const streamUrl = this.getExchange().getKlineStreamUrl(subscriptions);
    console.log(`📊 VWAP Streamer: Connecting to ${streamUrl}`);

    this.ws = new WebSocket(streamUrl);

    this.ws.on('open', () => {
      console.log('📊 VWAP Streamer: WebSocket connected');
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.stream && message.data) {
          this.handleKlineData(message.data);
        }
      } catch (error) {
        console.error('📊 VWAP Streamer: Parse error:', error);
      }
    });

    this.ws.on('error', (error) => {
      console.error('📊 VWAP Streamer: WebSocket error:', error);
    });

    this.ws.on('close', () => {
      console.log('📊 VWAP Streamer: WebSocket closed');
      if (this.isRunning) {
        this.reconnectTimeout = setTimeout(() => {
          this.connectWebSocket();
        }, 5000);
      }
    });
  }

  private handleKlineData(data: KlineStreamData): void {
    if (data.e !== 'kline') return;

    const symbol = data.s;
    const config = this.symbolConfigs.get(symbol);
    if (!config) return;

    const kline = data.k;
    const klineData = {
      high: parseFloat(kline.h),
      low: parseFloat(kline.l),
      close: parseFloat(kline.c),
      volume: parseFloat(kline.v),
      quoteVolume: parseFloat(kline.q)  // Quote volume in USDT
    };

    // Update or add the kline to buffer
    const buffer = this.klineBuffers.get(symbol) || [];

    // If this is a closed kline, add it to the buffer
    if (kline.x) {
      buffer.push(klineData);

      // Maintain buffer size according to lookback period
      if (buffer.length > config.lookback) {
        buffer.shift();
      }

      this.klineBuffers.set(symbol, buffer);
    } else {
      // Update the last kline if it's not closed
      if (buffer.length > 0) {
        buffer[buffer.length - 1] = klineData;
      } else {
        buffer.push(klineData);
      }
      this.klineBuffers.set(symbol, buffer);
    }
  }

  private calculateAndBroadcastVWAP(): void {
    for (const [symbol, buffer] of this.klineBuffers.entries()) {
      if (buffer.length === 0) continue;

      try {
        const config = this.symbolConfigs.get(symbol);
        if (!config) continue;

        // Calculate VWAP
        let sumPriceVolume = 0;
        let sumVolume = 0;

        // For session-based VWAP, we should ideally reset at 00:00 UTC
        // But since we're using a buffer, we'll use the configured lookback
        // To better match exchange VWAP, consider using 24h worth of data
        const now = new Date();
        const sessionStart = new Date(now);
        sessionStart.setUTCHours(0, 0, 0, 0);

        // Calculate how many periods since session start
        const timeSinceStart = now.getTime() - sessionStart.getTime();
        const minutesSinceStart = Math.floor(timeSinceStart / (1000 * 60));

        // Convert timeframe to minutes
        const timeframeMinutes = config.timeframe === '5m' ? 5 :
                                config.timeframe === '15m' ? 15 :
                                config.timeframe === '30m' ? 30 :
                                config.timeframe === '1h' ? 60 : 1;

        // Use either periods since session start or configured lookback, whichever is smaller
        const periodsSinceStart = Math.floor(minutesSinceStart / timeframeMinutes);
        const periodsToUse = Math.min(periodsSinceStart, config.lookback, buffer.length);

        // Only use the most recent periodsToUse candles
        const startIndex = Math.max(0, buffer.length - periodsToUse);

        for (let i = startIndex; i < buffer.length; i++) {
          const kline = buffer[i];
          const typicalPrice = (kline.high + kline.low + kline.close) / 3;
          // Standard VWAP formula: Sum(Price * Volume) / Sum(Volume)
          // Using base volume is correct here
          sumPriceVolume += typicalPrice * kline.volume;
          sumVolume += kline.volume;
        }

        if (sumVolume === 0) continue;

        const vwap = sumPriceVolume / sumVolume;
        const currentPrice = buffer[buffer.length - 1].close;
        const position = currentPrice > vwap ? 'above' : 'below';



        const vwapData: VWAPData = {
          symbol,
          vwap,
          currentPrice,
          position,
          timestamp: Date.now()
        };

        // Store and emit the VWAP data
        this.vwapValues.set(symbol, vwapData);
        this.emit('vwap', vwapData);
      } catch (error) {
        console.error(`📊 VWAP Streamer: Calculation error for ${symbol}:`, error);
      }
    }
  }

  public getCurrentVWAP(symbol: string): VWAPData | null {
    return this.vwapValues.get(symbol) || null;
  }

  public getAllVWAP(): Map<string, VWAPData> {
    return new Map(this.vwapValues);
  }

  public async updateSymbols(config: Config): Promise<void> {
    console.log('📊 VWAP Streamer: Updating monitored symbols...');

    const oldSymbols = new Set(this.symbolConfigs.keys());
    const newSymbolConfigs = new Map<string, {timeframe: string, lookback: number}>();

    // Collect new symbols with VWAP protection
    for (const [symbol, symbolConfig] of Object.entries(config.symbols)) {
      if (symbolConfig.vwapProtection) {
        const timeframe = symbolConfig.vwapTimeframe || '1m';
        const lookback = symbolConfig.vwapLookback || 100;
        newSymbolConfigs.set(symbol, { timeframe, lookback });
      }
    }

    const newSymbols = new Set(newSymbolConfigs.keys());

    // Find added and removed symbols
    const addedSymbols = [...newSymbols].filter(s => !oldSymbols.has(s));
    const removedSymbols = [...oldSymbols].filter(s => !newSymbols.has(s));

    // Update configuration
    this.symbolConfigs = newSymbolConfigs;

    // Remove data for removed symbols
    for (const symbol of removedSymbols) {
      this.klineBuffers.delete(symbol);
      this.vwapValues.delete(symbol);
      console.log(`📊 VWAP Streamer: Stopped monitoring ${symbol}`);
    }

    // Add new symbols
    for (const symbol of addedSymbols) {
      const config = newSymbolConfigs.get(symbol)!;
      this.klineBuffers.set(symbol, []);
      console.log(`📊 VWAP Streamer: Started monitoring ${symbol} with ${config.timeframe} timeframe, ${config.lookback} lookback`);

      // Load initial data for new symbol
      try {
        const klines = await this.getExchange().getKlines(symbol, config.timeframe, config.lookback);
        if (klines && klines.length > 0) {
          const buffer: Array<{high: number, low: number, close: number, volume: number, quoteVolume: number}> = [];
          for (const kline of klines) {
            buffer.push({
              high: parseFloat(kline.high),
              low: parseFloat(kline.low),
              close: parseFloat(kline.close),
              volume: parseFloat(kline.volume),
              quoteVolume: parseFloat(kline.volume) * parseFloat(kline.close) // Estimate
            });
          }
          this.klineBuffers.set(symbol, buffer);
        }
      } catch (error) {
        console.error(`📊 VWAP Streamer: Failed to load initial data for ${symbol}:`, error);
      }
    }

    // Restart WebSocket if symbols changed
    if (addedSymbols.length > 0 || removedSymbols.length > 0) {
      if (this.ws) {
        this.ws.close();
        // Will automatically reconnect with new symbols
      }
    }
  }
}

// Export singleton instance
export const vwapStreamer = new VWAPStreamer();
