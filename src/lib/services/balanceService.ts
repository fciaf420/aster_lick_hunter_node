import type { AccountUpdate } from '../api/userDataStream';
import type { AccountStream, ExchangeAdapter } from '../exchange/types';
import { EventEmitter } from 'events';

export interface BalanceData {
  totalBalance: number;
  availableBalance: number;
  totalPositionValue: number;
  totalPnL: number;
  lastUpdate: number;
}

export class BalanceService extends EventEmitter {
  private userDataStream: AccountStream | null = null;
  private currentBalance: BalanceData = {
    totalBalance: 0,
    availableBalance: 0,
    totalPositionValue: 0,
    totalPnL: 0,
    lastUpdate: 0
  };
  private exchange: ExchangeAdapter | null = null;
  private initialized = false;
  private connectionError: string | null = null;
  private lastSuccessfulUpdate = 0;
  private retryCount = 0;
  private maxRetries = 3;
  private retryDelay = 1000;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
  }

  async initialize(exchange: ExchangeAdapter): Promise<void> {

    // Validate credentials
    if (!exchange.hasCredentials()) {
      throw new Error('Invalid credentials: API key and secret key are required');
    }

    this.exchange = exchange;
    this.connectionError = null;
    this.retryCount = 0;

    try {
      // Get initial balance data from REST API
      await this.fetchInitialBalance();

      // Start WebSocket stream for real-time updates
      this.userDataStream = exchange.createAccountStream();
      await this.userDataStream.start(this.handleAccountUpdate.bind(this));

      this.initialized = true;
      this.lastSuccessfulUpdate = Date.now();

      // Start health check
      this.startHealthCheck();

      // Emit initial balance
      this.emit('balanceUpdate', this.currentBalance);
    } catch (error) {
      this.connectionError = error instanceof Error ? error.message : 'Unknown error during initialization';

      // Try to at least get initial balance if WebSocket fails
      if (!this.currentBalance.lastUpdate) {
        try {
          await this.fetchInitialBalance();
          this.initialized = true; // Partially initialized (REST only)
          this.emit('balanceUpdate', this.currentBalance);
        } catch (_fallbackError) {
          throw error; // Throw original error
        }
      }

      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.userDataStream) {
      await this.userDataStream.stop();
      this.userDataStream = null;
    }
    this.initialized = false;
  }

  getCurrentBalance(): BalanceData {
    return { ...this.currentBalance };
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getConnectionStatus(): { connected: boolean; error: string | null; lastUpdate: number } {
    return {
      connected: this.initialized && !this.connectionError,
      error: this.connectionError,
      lastUpdate: this.lastSuccessfulUpdate
    };
  }

  public async fetchInitialBalance(): Promise<void> {
    if (!this.exchange) throw new Error('No credentials available');

    const attemptFetch = async (): Promise<void> => {
      try {
        const accountData = await this.exchange!.getAccountInfo();

        if (accountData) {
          // availableBalance is the free balance available for trading
          const availableBalance = parseFloat(accountData.availableBalance || '0');
          // totalUnrealizedProfit is the sum of all unrealized PnL
          const totalPnL = parseFloat(accountData.totalUnrealizedProfit || '0');
          // totalPositionInitialMargin is the total margin used in positions
          const totalPositionMargin = parseFloat(accountData.totalPositionInitialMargin || '0');
          // Total wallet balance = available + margin used
          const totalBalance = availableBalance + totalPositionMargin;

          this.currentBalance = {
            totalBalance,
            availableBalance,
            totalPositionValue: totalPositionMargin, // This is actually margin, not notional value
            totalPnL,
            lastUpdate: Date.now()
          };


          this.lastSuccessfulUpdate = Date.now();
          this.connectionError = null;
          this.retryCount = 0; // Reset retry count on success

        } else {
          throw new Error('No account data received from API');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        if (this.retryCount < this.maxRetries) {
          this.retryCount++;
          const delay = this.retryDelay * Math.pow(2, this.retryCount - 1); // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, delay));
          return attemptFetch(); // Recursive retry
        }

        this.connectionError = errorMessage;
        throw error;
      }
    };

    return attemptFetch();
  }

  private handleAccountUpdate(update: AccountUpdate): void {

    try {
      // Update balance data based on WebSocket update
      this.updateBalanceFromStream(update);

      // Update timestamp
      this.currentBalance.lastUpdate = update.eventTime;
      this.lastSuccessfulUpdate = Date.now();
      this.connectionError = null;


      // Emit balance update event
      this.emit('balanceUpdate', this.currentBalance);
    } catch (error) {
      this.connectionError = error instanceof Error ? error.message : 'Error processing update';
    }
  }

  private updateBalanceFromStream(update: AccountUpdate): void {
    const { balances, positions } = update.updateData;

    // Find USDT balance update
    const usdtBalance = balances.find(b => b.asset === 'USDT');
    if (usdtBalance) {
      // walletBalance is the total balance in the account
      // crossWalletBalance is the balance across all margin assets (usually same as wallet for single asset mode)
      const walletBalance = parseFloat(usdtBalance.walletBalance);
      const _crossWalletBalance = parseFloat(usdtBalance.crossWalletBalance);

      // Calculate available balance (wallet balance minus margin used in positions)
      // We'll calculate margin from positions below, then derive available
      this.currentBalance.totalBalance = walletBalance;
    }

    // Calculate total unrealized PnL and margin from all positions
    let totalUnrealizedPnL = 0;
    let totalPositionMargin = 0;

    positions.forEach(position => {
      const unrealizedPnL = parseFloat(position.unrealizedPnL);
      const positionAmount = parseFloat(position.positionAmount);
      const entryPrice = parseFloat(position.entryPrice);

      totalUnrealizedPnL += unrealizedPnL;

      // Calculate actual margin used (notional / leverage)
      // For futures, margin = (position size * entry price) / leverage
      // We need to get leverage from position or config
      if (positionAmount !== 0) {
        const notional = Math.abs(positionAmount * entryPrice);
        // Default to 10x leverage if not specified (will be refined based on actual data)
        const leverage = 10; // TODO: Get actual leverage from position data or config
        totalPositionMargin += notional / leverage;
      }
    });

    this.currentBalance.totalPnL = totalUnrealizedPnL;
    this.currentBalance.totalPositionValue = totalPositionMargin;

    // Available balance = Total balance - margin used in positions
    this.currentBalance.availableBalance = Math.max(0, this.currentBalance.totalBalance - totalPositionMargin);
  }

  private startHealthCheck(): void {
    // Check every 30 seconds if balance updates are coming through
    this.healthCheckInterval = setInterval(async () => {
      const timeSinceLastUpdate = Date.now() - this.lastSuccessfulUpdate;

      if (timeSinceLastUpdate > 120000) { // No updates for 2 minutes

        // Check if WebSocket is healthy
        if (this.userDataStream && !this.userDataStream.isHealthy()) {
          try {
            await this.fetchInitialBalance();
            this.emit('balanceUpdate', this.currentBalance);
          } catch (_error) {
          }
        }

        // If still no recent updates after 5 minutes, try to restart connection
        if (timeSinceLastUpdate > 300000) {
          this.attemptFullReconnection();
        }
      }
    }, 30000); // Check every 30 seconds
  }

  private async attemptFullReconnection(): Promise<void> {
    if (!this.exchange) return;

    try {

      // Stop existing connection
      if (this.userDataStream) {
        await this.userDataStream.stop();
        this.userDataStream = null;
      }

      // Get fresh balance from REST
      await this.fetchInitialBalance();

      // Restart WebSocket
      this.userDataStream = this.exchange.createAccountStream();
      await this.userDataStream.start(this.handleAccountUpdate.bind(this));

      this.connectionError = null;
      this.emit('balanceUpdate', this.currentBalance);
    } catch (error) {
      this.connectionError = error instanceof Error ? error.message : 'Reconnection failed';
    }
  }
}

// Global instance
let balanceService: BalanceService | null = null;

export function getBalanceService(): BalanceService | null {
  return balanceService;
}

export async function initializeBalanceService(exchange: ExchangeAdapter): Promise<void> {
  balanceService = new BalanceService();
  try {
    await balanceService.initialize(exchange);
  } catch (error) {
    // Keep the service instance even if initialization fails
    // so we can try to get balance via REST API fallback
    throw error;
  }
}

export async function stopBalanceService(): Promise<void> {
  if (balanceService) {
    await balanceService.stop();
    balanceService = null;
  }
}