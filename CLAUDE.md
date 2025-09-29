# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Type
This is a cryptocurrency liquidation hunting bot built with Next.js 15 and TypeScript. The application monitors liquidation events on the Aster Finance exchange and automatically places trades to capitalize on price movements, with both a web UI for monitoring and a backend bot service.

## Development Commands

```bash
# Install dependencies
npm install

# Run both web UI and bot concurrently (development)
npm run dev

# Run only the web UI (development)
npm run dev:web

# Run only the bot (development with watch mode)
npm run dev:bot

# Build for production
npm run build

# Start production (both web and bot)
npm start

# Run only the bot (one-time)
npm run bot

# Run linting
npm run lint

# Check TypeScript types
npx tsc --noEmit

# Run tests
npm test                   # Test limit orders
npm run test:simulation    # Test bot simulation
npm run test:flow         # Test limit order flow
npm run test:all          # Run all test suites

# Setup (install + build + config migration)
npm run setup

# Configuration management
npm run setup:config       # Migrate/create user configuration

# Testing error scenarios
npm run test:errors        # Generate test errors for development
npm run test:errors:clear  # Clear test errors
```

## Architecture Overview

The application has a dual architecture:
1. **Web UI**: Next.js application for configuration and monitoring
2. **Bot Service**: Standalone Node.js service that runs the trading logic

### Key Components

- **Hunter** (`src/lib/bot/hunter.ts`): Monitors liquidation WebSocket streams and triggers trades
- **PositionManager** (`src/lib/bot/positionManager.ts`): Manages open positions, SL/TP orders, and user data streams
- **AsterBot** (`src/bot/index.ts`): Main bot orchestrator that coordinates Hunter and PositionManager
- **StatusBroadcaster** (`src/bot/websocketServer.ts`): WebSocket server for real-time status updates to web UI
- **Services**: Helper services for balance (`balanceService.ts`), pricing (`priceService.ts`), VWAP calculations (`vwapService.ts`), and WebSocket management (`websocketService.ts`)
- **Database** (`src/lib/db/liquidationDb.ts`): SQLite database for persisting liquidation history and analytics

### Data Flow
1. Hunter connects to `wss://fstream.asterdex.com/ws/!forceOrder@arr` for liquidation events
2. When a qualifying liquidation occurs, Hunter analyzes order book depth and places intelligent limit orders
3. PositionManager monitors user data stream for order fills and automatically places SL/TP orders
4. Status updates are broadcasted to the web UI via internal WebSocket server on port 8080

### Process Management
The bot uses a sophisticated process management system:
- **ProcessManager** (`scripts/process-manager.js`): Orchestrates both web UI and bot service with graceful shutdown
- **Cross-platform Support**: Handles differences between Windows and Unix-like systems
- **Graceful Shutdown**: Properly cleans up WebSocket connections and child processes on Ctrl+C
- **Auto-restart**: Monitors processes and handles failures
- **Port Management**: Automatically detects and manages port conflicts

## Project Structure

- **src/app/**: Next.js pages and API routes
- **src/bot/**: Standalone bot service entry point and WebSocket server
- **src/lib/**: Shared business logic
  - `types.ts`: Core TypeScript interfaces for trading data
  - `api/`: Exchange API interaction (auth, orders, market data)
  - `bot/`: Bot components (hunter, position manager, config)
- **src/components/**: React components for the web UI
- **config.user.json**: User-specific trading configuration (API keys, symbols, risk parameters)
- **config.default.json**: Default configuration template with safe defaults
- **config.example.json**: Example configuration for reference

## Configuration System

The bot uses a dual-configuration system for security and flexibility:

### Configuration Files
- **`config.user.json`**: User-specific configuration (not tracked by git)
  - Contains your API keys and custom settings
  - Auto-created on first run if missing
  - This file is in `.gitignore` to protect your credentials

- **`config.default.json`**: Default configuration template (tracked by git)
  - Contains safe default values
  - Used as a fallback for missing fields
  - New settings are automatically merged to user config

- **`config.example.json`**: Example configuration (tracked by git)
  - Documentation reference with all available options

### Initial Setup
Run `npm run setup:config` to:
- Migrate existing `config.json` to `config.user.json` (if it exists)
- Create `config.user.json` from defaults (if no config exists)
- Remove `config.json` from git tracking (if applicable)
- Merge new configuration fields from defaults automatically

### Configuration Structure
- **api**: API credentials for Aster Finance exchange
- **symbols**: Per-symbol trading configuration (volume thresholds, leverage, SL/TP percentages, VWAP settings)
- **global**: Global settings (paper mode, risk percentage, max positions)
- **server**: Dashboard and WebSocket server configuration (ports, passwords, remote access)
- **rateLimits**: API rate limiting and request batching configuration
- **version**: Config schema version for automatic migrations

Example symbol configuration:
```json
"BTCUSDT": {
  "longVolumeThresholdUSDT": 10000,  // Min liquidation volume for long trades (buy on sell liquidations)
  "shortVolumeThresholdUSDT": 10000, // Min liquidation volume for short trades (sell on buy liquidations)
  "tradeSize": 100,                  // Base margin amount in USDT
  "leverage": 5,                     // Leverage multiplier
  "tpPercent": 5,                    // Take profit percentage
  "slPercent": 2,                    // Stop loss percentage
  "priceOffsetBps": 2,              // Basis points offset for limit orders
  "maxSlippageBps": 50,             // Maximum allowed slippage
  "orderType": "LIMIT",             // Order type (LIMIT or MARKET)
  "vwapProtection": true,           // Enable VWAP-based entry filtering
  "vwapTimeframe": "5m",            // Timeframe for VWAP calculation
  "vwapLookback": 100               // Number of candles for VWAP
}
```

## API Integration

Connects to Aster Finance exchange API (`https://fapi.asterdex.com`):
- **Authentication**: HMAC SHA256 signatures with API key/secret
- **Market Data**: WebSocket streams for liquidations, mark prices, klines
- **User Data**: WebSocket stream for account updates and order fills
- **Trading**: REST API for placing orders, setting leverage, managing positions

## Operating Modes

### Paper Mode
- Set `"paperMode": true` in config.json
- Simulates trading without placing real orders
- Generates mock liquidation events for testing
- Safe for development and testing

### Live Mode
- Requires valid API keys in config.json
- Places real orders on the exchange
- Monitors real liquidation streams
- Manages actual positions with real money

## Key Dependencies

- **concurrently**: Runs web UI and bot service simultaneously
- **tsx**: TypeScript execution for bot service with watch mode
- **ws**: WebSocket client for exchange connections and internal status server
- **axios**: HTTP client for REST API calls
- **@radix-ui/***: UI component library for the web interface
- **recharts**: Charts for displaying trading data
- **tailwindcss**: v4 for styling
- **ethers**: Ethereum utilities (for additional blockchain functionality)
- **zod**: Schema validation for configuration and API responses
- **sonner**: Toast notifications for the web UI

## Development Workflow

1. Configure `config.json` with your trading parameters (start in paper mode)
2. Run `npm run dev` to start both web UI and bot
3. Access web UI at http://localhost:3000 to monitor bot status
4. Bot logs will show in the terminal with detailed trade information
5. Use `/config` page to adjust settings without restarting

## Trading Strategy

The bot implements a **momentum-driven contrarian strategy** that exploits price dislocations from forced liquidations:
- **Long Liquidations** (forced SELL orders) → Price depression → **BUY opportunity**
- **Short Liquidations** (forced BUY orders) → Price spike → **SELL opportunity**

### Key Features
- **Volume-based filtering**: Only trades significant liquidations that can move markets
- **VWAP protection**: Ensures favorable entry prices relative to volume-weighted average
- **Intelligent execution**: Smart limit order placement using order book analysis
- **Risk management**: Automatic stop-loss and take-profit on all positions

## Safety Features

- Paper mode for safe testing with mock liquidation generation
- Automatic stop-loss and take-profit orders on all positions
- Risk management with configurable risk percentage per trade
- WebSocket auto-reconnection with exponential backoff
- Graceful shutdown handling (Ctrl+C to stop) with cross-platform support
- Intelligent limit orders with order book analysis and slippage protection
- Exchange filter validation (price, quantity, notional limits)
- VWAP-based entry filtering to avoid adverse price movements
- SQLite database for liquidation history and pattern analysis
- API rate limiting and request batching to prevent exchange penalties

## Web UI Structure

The Next.js application uses App Router with key pages:
- `/` (dashboard): Main trading dashboard with positions, liquidation feed, and bot status
- `/config`: Configuration page for editing trading parameters and API keys
- `/api/*`: REST endpoints for bot communication (balance, positions, trades, config)

## Important Instructions for Claude Code

**SECURITY NOTE**: User configuration is stored in `config.user.json` which is automatically excluded from git. Never commit API keys or sensitive configuration to version control.

## Making API Calls to Aster Finance Exchange

When you need to check or verify data from the Aster Finance exchange (e.g., account balance, positions, order status, market data), you can make API calls using the configured API credentials. Here's how to do it:

### Loading Configuration

First, load the API credentials from the configuration:

```typescript
import { loadConfig } from './src/lib/bot/config';

const config = await loadConfig();
const credentials = config.api; // { apiKey: string, secretKey: string }
```

Or use the config loader directly:

```typescript
import { configLoader } from './src/lib/config/configLoader';

const config = await configLoader.loadConfig();
const credentials = config.api;
```

### Authentication and API Calls

The bot uses HMAC SHA256 authentication. You can use the existing auth utilities:

#### For Account Data (Balance, Positions, Orders):
```typescript
import { getBalance, getPositions, getOpenOrders, getAccountInfo } from './src/lib/api/market';

// Get account balance
const balance = await getBalance(credentials);

// Get current positions
const positions = await getPositions(credentials);

// Get open orders
const openOrders = await getOpenOrders(undefined, credentials);

// Get account info (includes positions and account details)
const accountInfo = await getAccountInfo(credentials);
```

#### For Market Data (Public, no authentication needed):
```typescript
import { getMarkPrice, getKlines, getExchangeInfo, getOrderBook, getBookTicker } from './src/lib/api/market';

// Get current mark prices for all symbols
const markPrices = await getMarkPrice();

// Get klines (candlestick data)
const klines = await getKlines('BTCUSDT', '1m', 100);

// Get exchange information (symbols, price/quantity precision, etc.)
const exchangeInfo = await getExchangeInfo();

// Get order book depth
const orderBook = await getOrderBook('BTCUSDT', 5);

// Get best bid/ask prices
const bookTicker = await getBookTicker('BTCUSDT');
```

#### For Order Management:
```typescript
import { queryOrder, getAllOrders, setLeverage } from './src/lib/api/orders';

// Query specific order
const orderDetails = await queryOrder({ symbol: 'BTCUSDT', orderId: 12345 }, credentials);

// Get all orders for a symbol
const allOrders = await getAllOrders('BTCUSDT', credentials);

// Change leverage
const leverageResponse = await setLeverage('BTCUSDT', 10, credentials);
```

### Base URL and Headers

All API calls use:
- **Base URL**: `https://fapi.asterdex.com`
- **Request Headers**:
  - `X-MBX-APIKEY`: Your API key
  - `Content-Type`: `application/x-www-form-urlencoded` (for POST requests)

### Authentication Building Blocks

If you need to construct custom API calls:

```typescript
import { buildSignedQuery, buildSignedForm, getTimestamp } from './src/lib/api/auth';

// For GET requests (sign query parameters)
const queryString = buildSignedQuery({ symbol: 'BTCUSDT' }, credentials);
const response = await axios.get(`https://fapi.asterdex.com/fapi/v1/openOrders?${queryString}`, {
  headers: { 'X-MBX-APIKEY': credentials.apiKey }
});

// For POST requests (sign form data)
const formData = buildSignedForm({ symbol: 'BTCUSDT', leverage: 10 }, credentials);
const response = await axios.post('https://fapi.asterdex.com/fapi/v1/leverage', formData, {
  headers: {
    'X-MBX-APIKEY': credentials.apiKey,
    'Content-Type': 'application/x-www-form-urlencoded'
  }
});
```

### Important Notes

- All signed requests include timestamp and are valid for 5 seconds (recvWindow: 5000ms)
- Always check the API documentation at `docs/aster-finance-futures-api.md` for endpoint details
- Use paper mode (`"paperMode": true` in config.user.json) when testing to avoid real trades
- API responses include detailed error information in `error.response?.data` for debugging

## Additional Documentation

For comprehensive understanding of the trading strategy, refer to:
- **`docs/STRATEGY.md`**: Complete trading strategy documentation with examples and optimization guidelines
- **`docs/CONFIG_MIGRATION.md`**: Configuration migration and versioning details
- **`docs/aster-finance-futures-api.md`**: Complete API documentation for the Aster Finance exchange

## Development Tips

- The bot uses TypeScript interfaces in `src/lib/types.ts` for all trading data structures
- Configuration is validated using Zod schemas for type safety
- All WebSocket connections include automatic reconnection with exponential backoff
- Position management includes underwater position handling for volatile market entries
- The bot supports both one-way and hedge position modes for flexible trading strategies
