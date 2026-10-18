import React from 'react';
import { readFileSync } from 'fs';
import * as path from 'path';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import SymbolConfigForm from '@/components/SymbolConfigForm';
import type { Config } from '@/lib/types';

// A field that is left empty falls back to a default: the placeholder and the hint under the field say which one.
// The values are the ones the config loader fills in from config.default.json (see tests/lib/config/defaults.test.ts
// for how the constants behind them are pinned), so they are compared with that file here.

jest.mock('sonner', () => ({
  toast: Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() }),
}));

const defaultFile = JSON.parse(readFileSync(path.join(process.cwd(), 'config.default.json'), 'utf8'));
const shipped = defaultFile.symbols.ASTERUSDT;

const SYMBOL = {
  longVolumeThresholdUSDT: 10000,
  shortVolumeThresholdUSDT: 8000,
  tradeSize: 0.001,
  leverage: 5,
  tpPercent: 5,
  slPercent: 2,
  useThreshold: true,
};

const CONFIG: Config = {
  api: { apiKey: '', secretKey: '' },
  symbols: { BTCUSDT: { ...SYMBOL }, ASTERUSDT: { ...SYMBOL } },
  global: {
    riskPercent: 5,
    paperMode: true,
    positionMode: 'ONE_WAY',
    useThresholdSystem: true,
    exchange: 'aster',
    liquidationSource: 'aster',
    server: { dashboardPassword: 'fixture-pass', useRemoteWebSocket: false, websocketHost: null },
  },
  venues: { lighter: { profile: 'testnet' } },
  version: '1.3.0',
};

beforeEach(() => {
  (global as any).fetch = jest.fn(async (url: string) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => (url === '/api/symbols' ? { symbols: [] } : { minNotional: 5, minQty: 0.001, currentPrice: 60000 }),
  }));
});

function openTab(name: RegExp) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0, ctrlKey: false });
}

async function openSymbol(symbol: string) {
  openTab(/Symbols/);
  fireEvent.click(await screen.findByRole('button', { name: symbol }));
  await screen.findByText(`${symbol} Settings`);
}

const placeholderOf = (label: string) => screen.getByLabelText(label).getAttribute('placeholder');

describe('what an empty global setting falls back to', () => {
  it('shows the defaults of config.default.json as placeholders, and says that empty uses them', async () => {
    render(<SymbolConfigForm currentConfig={CONFIG} onSave={jest.fn()} />);
    openTab(/Global Settings/);
    await screen.findByText('Server Settings');

    expect(defaultFile.global.maxOpenPositions).toBe(5);
    expect(placeholderOf('Max Open Positions')).toBe(String(defaultFile.global.maxOpenPositions));
    expect(screen.getByText(/Maximum concurrent positions.*Empty uses 5\./)).toBeInTheDocument();

    expect(placeholderOf('Liquidation History Retention (days)')).toBe(String(defaultFile.global.liquidationRetentionDays));
    expect(screen.getByText(/Empty uses 7\./)).toBeInTheDocument();

    expect(placeholderOf('Dashboard Port')).toBe(String(defaultFile.global.server.dashboardPort));
    expect(screen.getByText('Port for the web dashboard. Empty uses 3000.')).toBeInTheDocument();
    expect(placeholderOf('WebSocket Port')).toBe(String(defaultFile.global.server.websocketPort));
    expect(screen.getByText('Port for WebSocket server communication. Empty uses 8080.')).toBeInTheDocument();
  });
});

describe('what an empty symbol setting falls back to', () => {
  it('shows what the bot applies to a symbol config.default.json does not list', async () => {
    render(<SymbolConfigForm currentConfig={CONFIG} onSave={jest.fn()} />);
    await openSymbol('BTCUSDT');

    // VWAP lookback: the bot's own 100 (hunter.ts, vwapStreamer.ts), with VWAP protection off or on
    expect(screen.queryByLabelText('Lookback Period')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('VWAP Protection'));
    expect(placeholderOf('Lookback Period')).toBe('100');
    expect(screen.getByText('Number of candles for VWAP (10-500). Empty uses 100.')).toBeInTheDocument();

    // No margin limit unless one is set
    expect(placeholderOf('Max Position Margin (USDT)')).toBe('No limit');
    expect(screen.getByText('Max total margin exposure for this symbol. Empty means no limit.')).toBeInTheDocument();

    // The threshold system: 60 s window, 30 s cooldown (thresholdMonitor.ts), shown in seconds
    expect(placeholderOf('Time Window (seconds)')).toBe('60');
    expect(screen.getByText('Window for accumulating volume. Empty uses 60s.')).toBeInTheDocument();
    expect(placeholderOf('Cooldown Period (seconds)')).toBe('30');
    expect(screen.getByText('Cooldown between triggers. Empty uses 30s.')).toBeInTheDocument();
  });

  it('shows what config.default.json fills in for a symbol it lists', async () => {
    render(<SymbolConfigForm currentConfig={CONFIG} onSave={jest.fn()} />);
    await openSymbol('ASTERUSDT');

    fireEvent.click(screen.getByLabelText('VWAP Protection'));
    expect(placeholderOf('Lookback Period')).toBe(String(shipped.vwapLookback));
    expect(screen.getByText(`Number of candles for VWAP (10-500). Empty uses ${shipped.vwapLookback}.`)).toBeInTheDocument();

    expect(placeholderOf('Max Position Margin (USDT)')).toBe(String(shipped.maxPositionMarginUSDT));
    expect(screen.getByText(`Max total margin exposure for this symbol. Empty uses ${shipped.maxPositionMarginUSDT}.`)).toBeInTheDocument();

    expect(placeholderOf('Time Window (seconds)')).toBe(String(shipped.thresholdTimeWindow / 1000));
    expect(placeholderOf('Cooldown Period (seconds)')).toBe(String(shipped.thresholdCooldown / 1000));
  });

  it('follows the symbol that is open', async () => {
    render(<SymbolConfigForm currentConfig={CONFIG} onSave={jest.fn()} />);
    await openSymbol('BTCUSDT');
    expect(placeholderOf('Max Position Margin (USDT)')).toBe('No limit');
    fireEvent.click(screen.getByRole('button', { name: 'ASTERUSDT' }));
    await screen.findByText('ASTERUSDT Settings');
    expect(placeholderOf('Max Position Margin (USDT)')).toBe('200');
  });

  it('shows the legacy volume threshold as what an empty threshold uses, and no made-up number otherwise', async () => {
    const legacy: Config = {
      ...CONFIG,
      symbols: { BTCUSDT: { tradeSize: 0.001, leverage: 5, tpPercent: 5, slPercent: 2, volumeThresholdUSDT: 7000 } },
    };
    const { unmount } = render(<SymbolConfigForm currentConfig={legacy} onSave={jest.fn()} />);
    await openSymbol('BTCUSDT');
    expect(placeholderOf('Long Volume Threshold (USDT)')).toBe('7000');
    expect(screen.getAllByText(/Empty uses the legacy volume threshold \(7000\)\./)).toHaveLength(2);
    unmount();

    render(<SymbolConfigForm currentConfig={CONFIG} onSave={jest.fn()} />);
    await openSymbol('BTCUSDT');
    expect(screen.getByLabelText('Long Volume Threshold (USDT)')).not.toHaveAttribute('placeholder');
    expect(screen.queryByText(/legacy volume threshold/)).not.toBeInTheDocument();
  });
});

describe('what an empty Lighter setting falls back to', () => {
  it('shows the defaults of the Lighter settings', () => {
    render(
      <SymbolConfigForm
        currentConfig={{ ...CONFIG, global: { ...CONFIG.global, exchange: 'lighter' } }}
        onSave={jest.fn()}
      />
    );
    expect(placeholderOf('SL/TP slippage (%)')).toBe(String(defaultFile.venues.lighter.sltpSlippagePct));
    expect(screen.getByText(/beyond the trigger\. Empty uses 1%\./)).toBeInTheDocument();
    expect(placeholderOf('Transactions per minute')).toBe(String(defaultFile.venues.lighter.sendTxPerMin));
    expect(screen.getByText(/applies after a restart\. Empty uses 60\./)).toBeInTheDocument();
  });
});
