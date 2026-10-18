import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ConfigProvider, { useConfig } from '@/components/ConfigProvider';
import SymbolConfigForm from '@/components/SymbolConfigForm';
import { configSchema } from '@/lib/config/types';
import { toast } from 'sonner';

// Characterization of the config form's save payload: renders the form with a fixture config under the real
// ConfigProvider (the object the config page hands to the form), performs a set of edits through the UI, clicks
// Save, and compares the JSON body POSTed to /api/config with the exact body expected. These expectations were
// recorded against the form as it was before the react-hook-form rewrite and must keep passing.
//
// Everything is located by label text, never by implementation details: the form ties labels to controls with
// htmlFor/id, and control() falls back to the label's surroundings for any label that is not tied to one.

jest.mock('next/navigation', () => ({ usePathname: () => '/config' }));
jest.mock('@/components/onboarding/OnboardingProvider', () => ({
  OnboardingProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/onboarding/OnboardingModal', () => ({ OnboardingModal: () => null }));
jest.mock('@/components/onboarding/TutorialOverlay', () => ({ TutorialOverlay: () => null }));
jest.mock('sonner', () => ({
  toast: Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() }),
}));

type Json = Record<string, any>;

// ===== Fixtures (obviously fake credentials) =====

const LIGHTER_MAIN_PRIVATE_KEY = 'a1'.repeat(40);
const LIGHTER_MAIN_PUBLIC_KEY = 'b2'.repeat(40);
const LIGHTER_SHORT_PRIVATE_KEY = 'c3'.repeat(40);
const LIGHTER_SHORT_PUBLIC_KEY = 'd4'.repeat(40);

const RATE_LIMIT = {
  maxRequestWeight: 2400,
  maxOrderCount: 1200,
  reservePercent: 30,
  enableBatching: true,
  queueTimeout: 30000,
  enableDeduplication: true,
  deduplicationWindowMs: 1000,
  parallelProcessing: true,
  maxConcurrentRequests: 3,
};

const LIGHTER_DEFAULTS = { profile: 'testnet', liquidationsLive: false, sltpSlippagePct: 1, sendTxPerMin: 60 };

// Aster setup: two symbols, the 60-second threshold system on, BTCUSDT using it, ETHUSDT with separate trade sizes
const ASTER_CONFIG: Json = {
  api: { apiKey: 'TEST-API-KEY-NOT-REAL', secretKey: 'TEST-SECRET-KEY-NOT-REAL' },
  symbols: {
    BTCUSDT: {
      longVolumeThresholdUSDT: 10000,
      shortVolumeThresholdUSDT: 8000,
      tradeSize: 0.001,
      maxPositionMarginUSDT: 5000,
      leverage: 5,
      tpPercent: 5,
      slPercent: 2,
      priceOffsetBps: 5,
      maxSlippageBps: 50,
      orderType: 'LIMIT',
      forceMarketEntry: false,
      vwapProtection: true,
      vwapTimeframe: '5m',
      vwapLookback: 200,
      useThreshold: true,
      thresholdTimeWindow: 60000,
      thresholdCooldown: 30000,
    },
    ETHUSDT: {
      longVolumeThresholdUSDT: 5000,
      shortVolumeThresholdUSDT: 5000,
      tradeSize: 0.01,
      longTradeSize: 0.02,
      shortTradeSize: 0.03,
      maxPositionMarginUSDT: 3000,
      leverage: 10,
      tpPercent: 4,
      slPercent: 1.5,
      priceOffsetBps: 5,
      maxSlippageBps: 50,
      orderType: 'LIMIT',
      vwapProtection: false,
      vwapTimeframe: '1m',
      vwapLookback: 100,
      useThreshold: false,
    },
  },
  global: {
    riskPercent: 5,
    paperMode: true,
    positionMode: 'HEDGE',
    maxOpenPositions: 10,
    useThresholdSystem: true,
    liquidationRetentionDays: 7,
    exchange: 'aster',
    liquidationSource: 'aster',
    server: {
      dashboardPassword: 'fixture-pass',
      dashboardPort: 3000,
      websocketPort: 8080,
      useRemoteWebSocket: false,
      websocketHost: null,
    },
    rateLimit: RATE_LIMIT,
  },
  venues: { lighter: { ...LIGHTER_DEFAULTS } },
  version: '1.3.0',
};

// Lighter as the trading venue, main account filled in, one-way
const LIGHTER_CONFIG: Json = {
  ...ASTER_CONFIG,
  api: { apiKey: '', secretKey: '' },
  global: { ...ASTER_CONFIG.global, positionMode: 'ONE_WAY', exchange: 'lighter' },
  venues: {
    lighter: {
      ...LIGHTER_DEFAULTS,
      accountIndex: 12345,
      apiKeyIndex: 3,
      apiKeyPrivateKey: LIGHTER_MAIN_PRIVATE_KEY,
      apiKeyPublicKey: LIGHTER_MAIN_PUBLIC_KEY,
    },
  },
};

const SHORT_ACCOUNT = {
  accountIndex: 23456,
  apiKeyIndex: 4,
  apiKeyPrivateKey: LIGHTER_SHORT_PRIVATE_KEY,
  apiKeyPublicKey: LIGHTER_SHORT_PUBLIC_KEY,
};

// The symbol the "Add Manual" and "Browse Symbols" buttons create
const NEW_SYMBOL = {
  longVolumeThresholdUSDT: 10000,
  shortVolumeThresholdUSDT: 10000,
  leverage: 10,
  tradeSize: 100,
  maxPositionMarginUSDT: 10000,
  slPercent: 2,
  tpPercent: 3,
  priceOffsetBps: 5,
  maxSlippageBps: 50,
  orderType: 'LIMIT',
  vwapProtection: false,
  vwapTimeframe: '1m',
  vwapLookback: 100,
};

function edit(base: Json, change: (draft: Json) => void): Json {
  const draft = JSON.parse(JSON.stringify(base));
  change(draft);
  return draft;
}

// ===== Fake backend =====

interface Post {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

let posts: Post[] = [];

function respond(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => 'application/json' },
    json: async () => body,
  };
}

function installFetch(served: Json) {
  posts = [];
  (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/config' && method === 'POST') {
      posts.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body) });
      return respond({ success: true });
    }
    if (url === '/api/config') return respond(JSON.parse(JSON.stringify(served)));
    if (url === '/api/symbols') return respond({ symbols: [{ symbol: 'XRPUSDT' }, { symbol: 'ADAUSDT' }] });
    if (url.startsWith('/api/symbol-details/')) return respond({ minNotional: 5, minQty: 0.001, currentPrice: 60000 });
    throw new Error(`Unexpected request ${method} ${url}`);
  });
}

// ===== Rendering and locating =====

function Host() {
  const { config, loading, updateConfig } = useConfig();
  if (loading || !config) return null;
  return <SymbolConfigForm currentConfig={config} onSave={updateConfig} />;
}

async function openForm(served: Json) {
  installFetch(served);
  render(
    <ConfigProvider>
      <Host />
    </ConfigProvider>
  );
  await screen.findByRole('tab', { name: /Exchange/ });
}

const normalize = (text: string | null) => (text ?? '').replace(/\s+/g, ' ').trim();
const CONTROLS = 'input, select, textarea, button[role="switch"], button[role="combobox"]';

function control(labelText: string): HTMLElement {
  const labels = Array.from(document.querySelectorAll('label')).filter((label) => normalize(label.textContent).startsWith(labelText));
  if (labels.length === 0) throw new Error(`No label starting with "${labelText}"`);
  const label = labels.find((candidate) => normalize(candidate.textContent) === labelText) ?? labels[0];
  if (label.control) return label.control as HTMLElement;
  for (let node = label.parentElement; node && node !== document.body; node = node.parentElement) {
    const found = node.querySelector<HTMLElement>(CONTROLS);
    if (found) return found;
  }
  throw new Error(`No control for label "${labelText}"`);
}

const hasLabel = (labelText: string) =>
  Array.from(document.querySelectorAll('label')).some((label) => normalize(label.textContent).startsWith(labelText));

function type(labelText: string, value: string) {
  fireEvent.change(control(labelText), { target: { value } });
}

function flip(labelText: string) {
  fireEvent.click(control(labelText));
}

async function choose(trigger: HTMLElement, optionName: RegExp | string) {
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole('option', { name: optionName }));
}

function openTab(name: RegExp) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0, ctrlKey: false });
}

async function openSymbols(symbol?: string) {
  openTab(/Symbols/);
  await screen.findByText('Symbol Configuration');
  if (symbol) {
    fireEvent.click(screen.getByText(symbol));
    await screen.findByText(`${symbol} Settings`);
  }
}

async function save(): Promise<Json> {
  const before = posts.length;
  fireEvent.click(screen.getByRole('button', { name: /Save Configuration/ }));
  await waitFor(() => expect(posts).toHaveLength(before + 1));
  const post = posts[before];
  expect(post.url).toBe('/api/config');
  expect(post.method).toBe('POST');
  expect(post.headers).toEqual({ 'Content-Type': 'application/json' });
  const body = JSON.parse(post.body);
  // Whatever the form sends must pass the validation /api/config applies
  expect(configSchema.safeParse(body).success).toBe(true);
  return body;
}

async function expectNoSave() {
  fireEvent.click(screen.getByRole('button', { name: /Save Configuration/ }));
  // Give an asynchronous submit time to reach fetch before checking that it did not
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(posts).toHaveLength(0);
}

beforeEach(() => {
  posts = [];
  // The old form reported a short dashboard password with window.alert (jsdom does not implement it)
  jest.spyOn(window, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function openGlobal(served: Json = ASTER_CONFIG) {
  await openForm(served);
  openTab(/Global Settings/);
  await screen.findByText('Risk management and trading mode configuration');
}

// ===== The tests =====

describe('config form save payload: Aster', () => {
  it('saves an untouched config exactly as it was loaded', async () => {
    await openForm(ASTER_CONFIG);
    expect(await save()).toEqual(ASTER_CONFIG);
  });

  it('saves edited leverage, take profit and stop loss', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols('BTCUSDT');
    type('Leverage', '12');
    type('Take Profit (%)', '6.5');
    type('Stop Loss (%)', '1.5');

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.symbols.BTCUSDT.leverage = 12;
      c.symbols.BTCUSDT.tpPercent = 6.5;
      c.symbols.BTCUSDT.slPercent = 1.5;
    }));
  });

  it('truncates leverage to a whole number', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols('BTCUSDT');
    type('Leverage', '12.7');
    expect((await save()).symbols.BTCUSDT.leverage).toBe(12);
  });

  it('keeps the symbol selection and edits each symbol separately', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols('BTCUSDT');
    type('Leverage', '20');
    fireEvent.click(screen.getByText('ETHUSDT'));
    await screen.findByText('ETHUSDT Settings');
    expect((control('Leverage') as HTMLInputElement).value).toBe('10');
    type('Leverage', '15');
    fireEvent.click(screen.getByText('BTCUSDT'));
    await screen.findByText('BTCUSDT Settings');
    expect((control('Leverage') as HTMLInputElement).value).toBe('20');

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.symbols.BTCUSDT.leverage = 20;
      c.symbols.ETHUSDT.leverage = 15;
    }));
  });

  it('saves the volume thresholds, margin cap and price offsets', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols('BTCUSDT');
    type('Long Volume Threshold (USDT)', '12500');
    type('Short Volume Threshold (USDT)', '9000.5');
    type('Max Position Margin (USDT)', '7000');
    type('Trade Size (USDT)', '0.002');

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.symbols.BTCUSDT.longVolumeThresholdUSDT = 12500;
      c.symbols.BTCUSDT.shortVolumeThresholdUSDT = 9000.5;
      c.symbols.BTCUSDT.maxPositionMarginUSDT = 7000;
      c.symbols.BTCUSDT.tradeSize = 0.002;
    }));
  });

  it('saves the per-symbol threshold window and cooldown in milliseconds', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols('BTCUSDT');
    expect((control('Time Window (seconds)') as HTMLInputElement).value).toBe('60');
    expect((control('Cooldown Period (seconds)') as HTMLInputElement).value).toBe('30');
    type('Time Window (seconds)', '90');
    type('Cooldown Period (seconds)', '45');

    fireEvent.click(screen.getByText('ETHUSDT'));
    await screen.findByText('ETHUSDT Settings');
    expect(screen.queryByText('Time Window (seconds)')).not.toBeInTheDocument();
    flip('Enable Threshold System for ETHUSDT');
    await screen.findByText('Time Window (seconds)');

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.symbols.BTCUSDT.thresholdTimeWindow = 90000;
      c.symbols.BTCUSDT.thresholdCooldown = 45000;
      c.symbols.ETHUSDT.useThreshold = true;
    }));
  });

  it('hides the per-symbol threshold settings while the global threshold system is off, and keeps their values', async () => {
    await openForm(ASTER_CONFIG);
    openTab(/Global Settings/);
    await screen.findByText('Risk management and trading mode configuration');
    flip('60-Second Volume Threshold System');
    expect(screen.queryByText(/When enabled, trades will only trigger/)).not.toBeInTheDocument();

    await openSymbols('BTCUSDT');
    expect(screen.queryByText('Time Window (seconds)')).not.toBeInTheDocument();

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.global.useThresholdSystem = false;
    }));
  });

  it('saves order type, forced market entry and VWAP settings', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols('BTCUSDT');
    await choose(control('Order Type'), /MARKET Orders/);
    flip('Force Market Entry');
    expect(await screen.findByText(/Market Entry Forced/)).toBeInTheDocument();
    await choose(control('VWAP Timeframe'), '15 minutes');
    type('Lookback Period', '150');

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.symbols.BTCUSDT.orderType = 'MARKET';
      c.symbols.BTCUSDT.forceMarketEntry = true;
      c.symbols.BTCUSDT.vwapTimeframe = '15m';
      c.symbols.BTCUSDT.vwapLookback = 150;
    }));
  });

  it('hides the VWAP settings when VWAP protection is switched off and keeps their values', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols('BTCUSDT');
    flip('VWAP Protection');
    expect(screen.queryByText('VWAP Timeframe')).not.toBeInTheDocument();
    expect(screen.queryByText(/VWAP Protection Active/)).not.toBeInTheDocument();

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.symbols.BTCUSDT.vwapProtection = false;
    }));
  });

  it('turns separate long and short trade sizes on and off', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols('BTCUSDT');
    expect(hasLabel('Long Trade Size (USDT)')).toBe(false);
    flip('Trade Size Configuration');
    // Both start from the shared trade size
    expect((control('Long Trade Size (USDT)') as HTMLInputElement).value).toBe('0.001');
    expect((control('Short Trade Size (USDT)') as HTMLInputElement).value).toBe('0.001');
    type('Long Trade Size (USDT)', '0.002');

    fireEvent.click(screen.getByText('ETHUSDT'));
    await screen.findByText('ETHUSDT Settings');
    expect((control('Long Trade Size (USDT)') as HTMLInputElement).value).toBe('0.02');
    expect((control('Short Trade Size (USDT)') as HTMLInputElement).value).toBe('0.03');
    flip('Trade Size Configuration');
    expect(hasLabel('Long Trade Size (USDT)')).toBe(false);
    expect((control('Trade Size (USDT)') as HTMLInputElement).value).toBe('0.01');

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.symbols.BTCUSDT.longTradeSize = 0.002;
      c.symbols.BTCUSDT.shortTradeSize = 0.001;
      delete c.symbols.ETHUSDT.longTradeSize;
      delete c.symbols.ETHUSDT.shortTradeSize;
    }));
  });

  it('resets an emptied long or short trade size to the shared trade size when the field loses focus', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols('ETHUSDT');
    const long = control('Long Trade Size (USDT)') as HTMLInputElement;
    const short = control('Short Trade Size (USDT)') as HTMLInputElement;
    fireEvent.change(long, { target: { value: '' } });
    expect(long.value).toBe('');
    fireEvent.blur(long);
    expect(long.value).toBe('0.01');
    fireEvent.change(short, { target: { value: '0.05' } });
    fireEvent.change(short, { target: { value: '' } });
    fireEvent.blur(short);
    expect(short.value).toBe('0.01');

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.symbols.ETHUSDT.longTradeSize = 0.01;
      c.symbols.ETHUSDT.shortTradeSize = 0.01;
    }));
  });

  it('shows the exchange minimum for the trade size from the symbol details', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols('BTCUSDT');
    // minQty 0.001 x price 60000 / leverage 5 = 12 USDT margin, plus the 30% buffer
    expect(await screen.findByText('Recommended: $15.60 USDT')).toBeInTheDocument();
    expect(screen.getByText('Too low - may be rejected!')).toBeInTheDocument();
    expect(screen.getByText('Exchange min: $12.00 @ 5x (30% buffer added)')).toBeInTheDocument();
    type('Leverage', '10');
    expect(await screen.findByText('Recommended: $7.80 USDT')).toBeInTheDocument();
  });
});

describe('config form save payload: settings the form has no field for', () => {
  const WITH_EXTRAS = edit(LIGHTER_CONFIG, (c) => {
    c.venues.lighter.symbolOverrides = { QNTUSDT: 'QNT', NOTUSDT: { market: '1000NOT', multiplier: 1000 } };
    c.venues.hyperliquid = { wallet: 'FAKE-WALLET-NOT-REAL' };
    c.symbols.BTCUSDT.usePostOnly = true;
    c.symbols.BTCUSDT.hunterCooldownMs = 90000;
    c.global.hunterCooldownMs = 120000;
    c.global.server.envWebSocketHost = 'env.example.test';
    c.global.rateLimit.maxConcurrentRequests = 5;
  });

  it('saves them as they were loaded', async () => {
    await openForm(WITH_EXTRAS);
    expect(await save()).toEqual(WITH_EXTRAS);
  });

  it('saves them along with the edits', async () => {
    await openForm(WITH_EXTRAS);
    type('Account index', '999');
    await openSymbols('BTCUSDT');
    type('Leverage', '9');
    openTab(/Global Settings/);
    await screen.findByText('Risk management and trading mode configuration');
    type('Risk Percentage', '6');

    expect(await save()).toEqual(edit(WITH_EXTRAS, (c) => {
      c.venues.lighter.accountIndex = 999;
      c.symbols.BTCUSDT.leverage = 9;
      c.global.riskPercent = 6;
    }));
  });
});

describe('config form save payload: adding and removing symbols', () => {
  it('adds a typed symbol with the default settings and removes another', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols();
    fireEvent.change(screen.getByPlaceholderText('Enter symbol manually (e.g., BTCUSDT)'), { target: { value: 'solusdt' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Manual/ }));
    await screen.findByText('SOLUSDT Settings');

    fireEvent.click(screen.getByText('ETHUSDT'));
    await screen.findByText('ETHUSDT Settings');
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    expect(screen.queryByText('ETHUSDT')).not.toBeInTheDocument();
    expect(screen.queryByText('ETHUSDT Settings')).not.toBeInTheDocument();

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      delete c.symbols.ETHUSDT;
      c.symbols.SOLUSDT = NEW_SYMBOL;
    }));
  });

  it('edits the symbol it just added', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols();
    fireEvent.change(screen.getByPlaceholderText('Enter symbol manually (e.g., BTCUSDT)'), { target: { value: 'SOLUSDT' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Manual/ }));
    await screen.findByText('SOLUSDT Settings');
    type('Leverage', '20');

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.symbols.SOLUSDT = { ...NEW_SYMBOL, leverage: 20 };
    }));
  });

  it('adds a symbol picked from the available symbols and ignores one that is already configured', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols();
    fireEvent.click(screen.getByRole('button', { name: /Browse Symbols/ }));
    const row = await screen.findByText('XRPUSDT');
    // Symbols that are already configured are not offered
    expect(screen.queryAllByText('BTCUSDT')).toHaveLength(1);
    fireEvent.click(row);
    await screen.findByText('XRPUSDT Settings');

    fireEvent.change(screen.getByPlaceholderText('Enter symbol manually (e.g., BTCUSDT)'), { target: { value: 'btcusdt' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Manual/ }));

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.symbols.XRPUSDT = NEW_SYMBOL;
    }));
  });

  it('starts a symbol that is added again from the default settings, not from what it had', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols('ETHUSDT');
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    fireEvent.change(screen.getByPlaceholderText('Enter symbol manually (e.g., BTCUSDT)'), { target: { value: 'ethusdt' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Manual/ }));
    await screen.findByText('ETHUSDT Settings');
    // ETHUSDT had separate trade sizes and VWAP off before; the new one has neither
    expect((control('Trade Size (USDT)') as HTMLInputElement).value).toBe('100');
    expect(hasLabel('Long Trade Size (USDT)')).toBe(false);

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.symbols.ETHUSDT = NEW_SYMBOL;
    }));
  });

  it('adds the typed symbol when Enter is pressed', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols();
    const input = screen.getByPlaceholderText('Enter symbol manually (e.g., BTCUSDT)');
    fireEvent.change(input, { target: { value: 'dogeusdt' } });
    expect(input).toHaveValue('DOGEUSDT');
    // A browser fires keydown and keypress for one key press; the form listens to one of them
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });
    fireEvent.keyPress(input, { key: 'Enter', code: 'Enter', charCode: 13 });
    await screen.findByText('DOGEUSDT Settings');
    expect(input).toHaveValue('');

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.symbols.DOGEUSDT = NEW_SYMBOL;
    }));
  });

  it('filters the available symbols and closes the picker', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols();
    fireEvent.click(screen.getByRole('button', { name: /Browse Symbols/ }));
    await screen.findByText('XRPUSDT');
    expect(screen.getByText('ADAUSDT')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Search symbols...'), { target: { value: 'xrp' } });
    expect(screen.queryByText('ADAUSDT')).not.toBeInTheDocument();
    expect(screen.getByText('XRPUSDT')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Search symbols...'), { target: { value: 'zzz' } });
    expect(screen.getByText('No matching symbols found')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '✕' }));
    expect(screen.queryByText('Available Symbols')).not.toBeInTheDocument();
    expect(await save()).toEqual(ASTER_CONFIG);
  });

  it('saves a config with no symbols left', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols('BTCUSDT');
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    fireEvent.click(screen.getByText('ETHUSDT'));
    await screen.findByText('ETHUSDT Settings');
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    expect(await screen.findByText('No symbols configured yet')).toBeInTheDocument();

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.symbols = {};
    }));
  });
});

describe('config form save payload: venue and Lighter', () => {
  it('switches the venue to Lighter and saves position mode ONE_WAY', async () => {
    await openForm(ASTER_CONFIG);
    expect(screen.getByText('API Configuration')).toBeInTheDocument();
    await choose(control('Trading venue'), /Lighter/);
    // Beta venue: warned, and the Lighter card replaces the Aster API card
    expect(await screen.findByText('Lighter Configuration')).toBeInTheDocument();
    expect(screen.queryByText('API Configuration')).not.toBeInTheDocument();
    expect(screen.getByText(/Lighter is in beta/).closest('[role="alert"]')).toHaveTextContent('untested with live funds');

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.global.exchange = 'lighter';
      c.global.positionMode = 'ONE_WAY';
    }));
  });

  it('adds no Lighter settings to a config without any when only the venue is switched', async () => {
    const bare = edit(ASTER_CONFIG, (c) => { delete c.venues; });
    await openForm(bare);
    await choose(control('Trading venue'), /Lighter/);
    await screen.findByText('Lighter Configuration');
    // Lighter's fields are shown, empty, and none of them leaves a trace in what is saved
    expect(hasLabel('Short account index')).toBe(true);

    expect(await save()).toEqual(edit(bare, (c) => {
      c.global.exchange = 'lighter';
      c.global.positionMode = 'ONE_WAY';
    }));
  });

  it('keeps position mode HEDGE when switching to Lighter with hedge mode fully set up', async () => {
    const withHedge = edit(ASTER_CONFIG, (c) => {
      c.venues.lighter = {
        ...LIGHTER_DEFAULTS,
        accountIndex: 12345,
        apiKeyIndex: 3,
        apiKeyPrivateKey: LIGHTER_MAIN_PRIVATE_KEY,
        apiKeyPublicKey: LIGHTER_MAIN_PUBLIC_KEY,
        hedge: { enabled: true, shortAccount: SHORT_ACCOUNT },
      };
    });
    await openForm(withHedge);
    await choose(control('Trading venue'), /Lighter/);
    await screen.findByText('Lighter Configuration');

    expect(await save()).toEqual(edit(withHedge, (c) => {
      c.global.exchange = 'lighter';
    }));
  });

  it('keeps Aster on one-way when switching back from Lighter', async () => {
    await openForm(LIGHTER_CONFIG);
    await choose(control('Trading venue'), /Aster/);
    await screen.findByText('API Configuration');

    expect(await save()).toEqual(edit(LIGHTER_CONFIG, (c) => {
      c.global.exchange = 'aster';
    }));
  });

  it('keeps coming-soon venues from being selected', async () => {
    await openForm(ASTER_CONFIG);
    fireEvent.click(control('Trading venue'));
    const hyperliquid = await screen.findByRole('option', { name: /Hyperliquid/ });
    expect(hyperliquid).toHaveAttribute('data-disabled');
    fireEvent.click(hyperliquid);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(await save()).toEqual(ASTER_CONFIG);
  });

  it('saves the Lighter network, credentials, slippage and rate', async () => {
    await openForm(edit(LIGHTER_CONFIG, (c) => {
      c.venues.lighter = { ...LIGHTER_DEFAULTS };
    }));
    expect(await screen.findByText(/Lighter credentials incomplete/)).toBeInTheDocument();
    expect(control('Lighter network')).toHaveValue('testnet');
    fireEvent.change(control('Lighter network'), { target: { value: 'mainnet' } });
    expect(screen.getByTestId('lighter-network-banner')).toHaveTextContent('REAL FUNDS');
    type('Account index', '12345');
    type('API key index', '3');
    type('API private key', `  ${LIGHTER_MAIN_PRIVATE_KEY} `);
    type('API public key', LIGHTER_MAIN_PUBLIC_KEY);
    type('SL/TP slippage (%)', '2.5');
    type('Transactions per minute', '120');
    expect(screen.queryByText(/Lighter credentials incomplete/)).not.toBeInTheDocument();

    expect(await save()).toEqual(edit(LIGHTER_CONFIG, (c) => {
      c.venues.lighter.profile = 'mainnet';
      c.venues.lighter.sltpSlippagePct = 2.5;
      c.venues.lighter.sendTxPerMin = 120;
    }));
  });

  it('leaves Lighter fields out of the payload when they are emptied', async () => {
    await openForm(LIGHTER_CONFIG);
    type('Account index', '');
    type('API private key', '');
    type('SL/TP slippage (%)', '');
    type('Transactions per minute', '');

    expect(await save()).toEqual(edit(LIGHTER_CONFIG, (c) => {
      delete c.venues.lighter.accountIndex;
      delete c.venues.lighter.apiKeyPrivateKey;
      delete c.venues.lighter.sltpSlippagePct;
      delete c.venues.lighter.sendTxPerMin;
    }));
  });

  it('keeps the private keys as password fields', async () => {
    await openForm(LIGHTER_CONFIG);
    const key = control('API private key') as HTMLInputElement;
    expect(key.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Show API private key' }));
    expect(key.type).toBe('text');
    expect(control('API public key')).toHaveAttribute('type', 'text');
  });

  it('saves hedge mode with a short account and switches position mode to HEDGE', async () => {
    await openForm(LIGHTER_CONFIG);
    expect(screen.getByTestId('lighter-hedge-status')).toHaveTextContent('Hedge mode is off');
    flip('Hedge mode (two sub-accounts)');
    expect(screen.getByTestId('lighter-hedge-status')).toHaveTextContent('Short account incomplete');
    type('Short account index', '23456');
    type('Short account API key index', '4');
    type('Short account API private key', LIGHTER_SHORT_PRIVATE_KEY);
    type('Short account API public key', LIGHTER_SHORT_PUBLIC_KEY);
    expect(screen.getByTestId('lighter-hedge-status')).toHaveTextContent('Hedge mode active after the bot restarts');

    expect(await save()).toEqual(edit(LIGHTER_CONFIG, (c) => {
      c.global.positionMode = 'HEDGE';
      c.venues.lighter.hedge = { enabled: true, shortAccount: SHORT_ACCOUNT };
    }));
  });

  it('turns hedge mode off again: one-way, with the short account kept', async () => {
    const hedged = edit(LIGHTER_CONFIG, (c) => {
      c.global.positionMode = 'HEDGE';
      c.venues.lighter.hedge = { enabled: true, shortAccount: SHORT_ACCOUNT };
    });
    await openForm(hedged);
    flip('Hedge mode (two sub-accounts)');

    expect(await save()).toEqual(edit(hedged, (c) => {
      c.global.positionMode = 'ONE_WAY';
      c.venues.lighter.hedge.enabled = false;
    }));
  });

  it('offers the HEDGE position mode on Lighter only once hedge mode is set up', async () => {
    await openForm(edit(LIGHTER_CONFIG, (c) => {
      c.venues.lighter.hedge = { enabled: true, shortAccount: { accountIndex: 23456 } };
    }));
    openTab(/Global Settings/);
    await screen.findByText('Risk management and trading mode configuration');
    const option = within(control('Position Mode')).getByRole('option', { name: /Hedge Mode/ }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(option.textContent).toContain('set up hedge mode in the Lighter settings first');
  });

  it('shows the Lighter liquidation feed for another trading venue and saves the live switch', async () => {
    await openForm(ASTER_CONFIG);
    expect(screen.queryByText('Lighter Liquidation Feed')).not.toBeInTheDocument();
    await choose(control('Liquidation source'), /Lighter/);
    expect(await screen.findByText('Lighter Liquidation Feed')).toBeInTheDocument();
    expect(screen.getByText('Shadow mode')).toBeInTheDocument();
    flip('Trade on Lighter liquidations');
    expect(screen.getByText('Live')).toBeInTheDocument();

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.global.liquidationSource = 'lighter';
      c.venues.lighter.liquidationsLive = true;
    }));
  });
});

describe('config form save payload: global and server settings', () => {
  it('saves the liquidation history retention days', async () => {
    await openGlobal();
    expect((control('Liquidation History Retention (days)') as HTMLInputElement).value).toBe('7');
    type('Liquidation History Retention (days)', '14');
    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => { c.global.liquidationRetentionDays = 14; }));
  });

  it('saves 0 retention days (keep everything) and clamps a negative value to 0', async () => {
    await openGlobal();
    type('Liquidation History Retention (days)', '0');
    expect((await save()).global.liquidationRetentionDays).toBe(0);

    type('Liquidation History Retention (days)', '30');
    type('Liquidation History Retention (days)', '-5');
    expect((control('Liquidation History Retention (days)') as HTMLInputElement).value).toBe('0');
    expect((await save()).global.liquidationRetentionDays).toBe(0);
  });

  it('saves paper mode switched off, and hides the paper mode notice', async () => {
    await openGlobal();
    expect(screen.getByText('Paper mode is enabled - No real trades will be executed')).toBeInTheDocument();
    expect(control('Paper Mode')).toHaveAttribute('aria-checked', 'true');
    flip('Paper Mode');
    expect(control('Paper Mode')).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText('Paper mode is enabled - No real trades will be executed')).not.toBeInTheDocument();

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => { c.global.paperMode = false; }));
  });

  it('saves the risk, open position and position mode settings', async () => {
    await openGlobal();
    type('Risk Percentage', '7.5');
    type('Max Open Positions', '8');
    fireEvent.change(control('Position Mode'), { target: { value: 'ONE_WAY' } });

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.global.riskPercent = 7.5;
      c.global.maxOpenPositions = 8;
      c.global.positionMode = 'ONE_WAY';
    }));
  });

  it('says why hedge mode is not offered on a venue without it', async () => {
    await openGlobal(LIGHTER_CONFIG);
    expect(screen.getByText(/Lighter only supports one-way positions/)).toBeInTheDocument();
    const option = within(control('Position Mode')).getByRole('option', { name: /Hedge Mode/ }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it('saves the server settings', async () => {
    await openGlobal();
    type('Dashboard Password', 'new-pass-1');
    type('Dashboard Port', '3100');
    type('WebSocket Port', '8090');
    expect(hasLabel('WebSocket Host (Optional)')).toBe(false);
    flip('Enable Remote WebSocket Access');
    type('WebSocket Host (Optional)', 'dash.example.test');

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.global.server = {
        dashboardPassword: 'new-pass-1',
        dashboardPort: 3100,
        websocketPort: 8090,
        useRemoteWebSocket: true,
        websocketHost: 'dash.example.test',
      };
    }));
  });

  it('saves an emptied WebSocket host as null and an emptied password as empty', async () => {
    const remote = edit(ASTER_CONFIG, (c) => {
      c.global.server.useRemoteWebSocket = true;
      c.global.server.websocketHost = 'dash.example.test';
    });
    await openGlobal(remote);
    type('WebSocket Host (Optional)', '');
    type('Dashboard Password', '');

    expect(await save()).toEqual(edit(remote, (c) => {
      c.global.server.websocketHost = null;
      c.global.server.dashboardPassword = '';
    }));
  });

  it('keeps the dashboard password as a password field', async () => {
    await openGlobal();
    expect(control('Dashboard Password')).toHaveAttribute('type', 'password');
  });

  it('does not save a dashboard password shorter than 4 characters', async () => {
    await openGlobal();
    type('Dashboard Password', 'abc');
    // Waits: the form validates asynchronously, so the error shows a moment after the edit
    expect(await screen.findByText('Password must be at least 4 characters')).toBeInTheDocument();
    await expectNoSave();
    // Intended difference: the refusal used to be a window.alert; it is now the inline error above, a focused
    // field and a toast, so that a refused save is reported the same way for every field
    expect(window.alert).not.toHaveBeenCalled();
    await waitFor(() => expect(control('Dashboard Password')).toHaveFocus());
    expect(toast.error).toHaveBeenCalledWith(
      'Cannot save yet: fix the highlighted fields',
      expect.objectContaining({ description: 'dashboard password: Password must be at least 4 characters' })
    );

    type('Dashboard Password', 'abcd');
    expect((await save()).global.server.dashboardPassword).toBe('abcd');
  });
});

describe('config form save payload: API keys', () => {
  it('saves the Aster API key and secret, with the secret as a password field', async () => {
    await openForm(edit(ASTER_CONFIG, (c) => { c.api = { apiKey: '', secretKey: '' }; }));
    expect(screen.getByText('No API keys configured - Bot will run in paper mode only')).toBeInTheDocument();
    const secret = control('Secret Key') as HTMLInputElement;
    expect(secret.type).toBe('password');
    type('API Key', 'FAKE-API-KEY-0001');
    type('Secret Key', 'FAKE-SECRET-KEY-0001');
    expect(screen.queryByText('No API keys configured - Bot will run in paper mode only')).not.toBeInTheDocument();

    // The reveal button sits next to the secret input
    const reveal = secret.parentElement!.querySelector('button') as HTMLButtonElement;
    fireEvent.click(reveal);
    expect(secret.type).toBe('text');
    fireEvent.click(reveal);
    expect(secret.type).toBe('password');

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.api = { apiKey: 'FAKE-API-KEY-0001', secretKey: 'FAKE-SECRET-KEY-0001' };
    }));
  });

  it('saves emptied API keys as empty strings', async () => {
    await openForm(ASTER_CONFIG);
    type('API Key', '');
    type('Secret Key', '');
    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => { c.api = { apiKey: '', secretKey: '' }; }));
  });
});

describe('config form save payload: emptied and out-of-range number fields', () => {
  // Intended difference. The form used to replace an emptied number field with a fallback value on every keystroke
  // (leverage 1, risk 0, margin cap 0, ...), so a field could never be left empty, and it posted values the server
  // rejects (take profit 0, leverage 200) for the server to answer 400. Now an empty field is what it says: unset
  // for the optional settings (the bot applies its own default, as it does for a config without them), and an
  // error for the required ones, shown under the field. Save is refused until the errors are fixed.
  it('leaves an emptied optional symbol field out of the payload', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols('BTCUSDT');
    type('Max Position Margin (USDT)', '');
    type('Lookback Period', '');
    type('Time Window (seconds)', '');
    type('Cooldown Period (seconds)', '');
    expect((control('Max Position Margin (USDT)') as HTMLInputElement).value).toBe('');

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      delete c.symbols.BTCUSDT.maxPositionMarginUSDT;
      delete c.symbols.BTCUSDT.vwapLookback;
      delete c.symbols.BTCUSDT.thresholdTimeWindow;
      delete c.symbols.BTCUSDT.thresholdCooldown;
    }));
  });

  it('leaves an emptied optional global field out of the payload', async () => {
    await openGlobal();
    type('Max Open Positions', '');
    type('Liquidation History Retention (days)', '');
    type('Dashboard Port', '');
    type('WebSocket Port', '');

    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      delete c.global.maxOpenPositions;
      delete c.global.liquidationRetentionDays;
      delete c.global.server.dashboardPort;
      delete c.global.server.websocketPort;
    }));
  });

  it('refuses to save while a required symbol field is empty, and shows where', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols('BTCUSDT');
    type('Take Profit (%)', '');
    type('Leverage', '');
    // Move away from the symbol tab: the refusal brings the first invalid field back
    openTab(/Global Settings/);
    await screen.findByText('Risk management and trading mode configuration');
    await expectNoSave();

    await screen.findByText('BTCUSDT Settings');
    await waitFor(() => expect(control('Leverage')).toHaveFocus());
    expect(control('Leverage')).toHaveAttribute('aria-invalid', 'true');
    expect(control('Take Profit (%)')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getAllByText('Required')).toHaveLength(2);
    expect(toast.error).toHaveBeenCalledWith('Cannot save yet: fix the highlighted fields', expect.objectContaining({ description: '2 fields need attention' }));

    type('Take Profit (%)', '4');
    type('Leverage', '8');
    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.symbols.BTCUSDT.tpPercent = 4;
      c.symbols.BTCUSDT.leverage = 8;
    }));
  });

  it('refuses to save a symbol without volume thresholds', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols('BTCUSDT');
    // The server demands a legacy threshold or both new ones; the form says which one is missing
    type('Short Volume Threshold (USDT)', '');
    await expectNoSave();
    await waitFor(() => expect(control('Short Volume Threshold (USDT)')).toHaveFocus());
    expect(await screen.findByText('Required')).toBeInTheDocument();
    expect(control('Long Volume Threshold (USDT)')).not.toHaveAttribute('aria-invalid');

    type('Short Volume Threshold (USDT)', '7500');
    expect(await save()).toEqual(edit(ASTER_CONFIG, (c) => {
      c.symbols.BTCUSDT.shortVolumeThresholdUSDT = 7500;
    }));
  });

  it('refuses to save an empty risk percentage', async () => {
    await openGlobal();
    type('Risk Percentage', '');
    await expectNoSave();
    await waitFor(() => expect(control('Risk Percentage')).toHaveFocus());
    expect(await screen.findByText('Required')).toBeInTheDocument();
  });

  it('refuses to save values the server would reject, and says why', async () => {
    await openForm(ASTER_CONFIG);
    await openSymbols('BTCUSDT');
    type('Leverage', '200');
    type('Stop Loss (%)', '-1');
    expect(await screen.findByText('Must be at most 125')).toBeInTheDocument();
    expect(screen.getByText('Must be at least 0.1')).toBeInTheDocument();
    await expectNoSave();
  });
});
