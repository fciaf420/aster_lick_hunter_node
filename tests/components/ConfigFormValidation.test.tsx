import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { toast } from 'sonner';
import SymbolConfigForm from '@/components/SymbolConfigForm';
import { LighterSettings } from '@/components/LighterSettings';
import { LIGHTER_MAX_ACCOUNT_INDEX } from '@/lib/config/types';
import type { Config, LighterVenueConfig } from '@/lib/types';

// Inline validation of the config form: which input is refused, where the error shows, what Save does about it.
// The rules are the server's (lib/config/types.ts); see tests/lib/config/form.test.ts for the schema on its own.

jest.mock('sonner', () => ({
  toast: Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() }),
}));

const PRIVATE_KEY = 'a1'.repeat(40);
const PUBLIC_KEY = 'b2'.repeat(40);
const SHORT_PRIVATE_KEY = 'c3'.repeat(40);
const SHORT_PUBLIC_KEY = 'd4'.repeat(40);

const SHORT_ACCOUNT = { accountIndex: 23456, apiKeyIndex: 4, apiKeyPrivateKey: SHORT_PRIVATE_KEY, apiKeyPublicKey: SHORT_PUBLIC_KEY };

const CONFIG: Config = {
  api: { apiKey: '', secretKey: '' },
  symbols: {
    BTCUSDT: {
      longVolumeThresholdUSDT: 10000,
      shortVolumeThresholdUSDT: 8000,
      tradeSize: 0.001,
      maxPositionMarginUSDT: 5000,
      leverage: 5,
      tpPercent: 5,
      slPercent: 2,
      orderType: 'LIMIT',
      vwapProtection: true,
      vwapTimeframe: '5m',
      vwapLookback: 200,
    },
  },
  global: {
    riskPercent: 5,
    paperMode: true,
    positionMode: 'ONE_WAY',
    maxOpenPositions: 10,
    exchange: 'aster',
    liquidationSource: 'aster',
    server: { dashboardPassword: 'fixture-pass', dashboardPort: 3000, websocketPort: 8080, useRemoteWebSocket: false, websocketHost: null },
  },
  venues: { lighter: { profile: 'testnet', liquidationsLive: false, sltpSlippagePct: 1, sendTxPerMin: 60 } },
  version: '1.3.0',
};

const LIGHTER_CONFIG: Config = {
  ...CONFIG,
  global: { ...CONFIG.global, exchange: 'lighter' },
  venues: {
    lighter: {
      profile: 'testnet',
      accountIndex: 12345,
      apiKeyIndex: 3,
      apiKeyPrivateKey: PRIVATE_KEY,
      apiKeyPublicKey: PUBLIC_KEY,
    },
  },
};

// The symbols tab asks for the exchange's minimums of the open symbol
beforeEach(() => {
  (global as any).fetch = jest.fn(async (url: string) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => (url === '/api/symbols' ? { symbols: [] } : { minNotional: 5, minQty: 0.001, currentPrice: 60000 }),
  }));
});

function renderForm(config: Config) {
  const onSave = jest.fn();
  render(<SymbolConfigForm currentConfig={config} onSave={onSave} />);
  return onSave;
}

function openTab(name: RegExp) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0, ctrlKey: false });
}

async function openSymbol(symbol = 'BTCUSDT') {
  openTab(/Symbols/);
  fireEvent.click(await screen.findByRole('button', { name: symbol }));
  await screen.findByText(`${symbol} Settings`);
}

// Inline field errors (the page has other alerts: notes and warnings)
const fieldErrors = (scope: ParentNode = document) => scope.querySelectorAll('[data-slot="field-error"]');

const clickSave = () => fireEvent.click(screen.getByRole('button', { name: /Save Configuration/ }));
const change = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

// An error is tied to its field: aria-invalid on the control, the alert listed in aria-describedby
function expectErrorOn(label: string | RegExp, message: string) {
  const field = screen.getByLabelText(label);
  expect(field).toHaveAttribute('aria-invalid', 'true');
  const alert = document.getElementById(`${field.id}-error`);
  expect(alert).toHaveTextContent(message);
  expect(alert).toHaveAttribute('role', 'alert');
  expect(field.getAttribute('aria-describedby')?.split(' ')).toContain(alert!.id);
}

function expectNoError(label: string | RegExp) {
  const field = screen.getByLabelText(label);
  expect(field).not.toHaveAttribute('aria-invalid');
  expect(document.getElementById(`${field.id}-error`)).toBeNull();
}

describe('config form validation: symbol settings', () => {
  it('flags a leverage outside 1-125 under the field and refuses to save it', async () => {
    const onSave = renderForm(CONFIG);
    await openSymbol();

    change('Leverage', '0');
    await waitFor(() => expectErrorOn('Leverage', 'Must be at least 1'));
    change('Leverage', '126');
    await waitFor(() => expectErrorOn('Leverage', 'Must be at most 125'));

    clickSave();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText('Leverage')).toHaveFocus());

    change('Leverage', '125');
    await waitFor(() => expectNoError('Leverage'));
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].symbols.BTCUSDT.leverage).toBe(125);
  });

  it('flags a negative take profit and stop loss', async () => {
    const onSave = renderForm(CONFIG);
    await openSymbol();

    change('Take Profit (%)', '-2');
    change('Stop Loss (%)', '0');
    await waitFor(() => expectErrorOn('Take Profit (%)', 'Must be at least 0.1'));
    await waitFor(() => expectErrorOn('Stop Loss (%)', 'Must be at least 0.1'));
    expectNoError('Leverage');

    clickSave();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'Cannot save yet: fix the highlighted fields',
      expect.objectContaining({ description: '2 fields need attention' })
    ));
    expect(onSave).not.toHaveBeenCalled();
    // The first one on the page
    await waitFor(() => expect(screen.getByLabelText('Stop Loss (%)')).toHaveFocus());
  });

  it('flags a trade size below the exchange minimum of the schema', async () => {
    const onSave = renderForm(CONFIG);
    await openSymbol();
    change('Trade Size (USDT)', '0');
    await waitFor(() => expectErrorOn('Trade Size (USDT)', 'Must be at least 0.00001'));
    clickSave();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();
  });

  it('flags a VWAP lookback outside 10-500', async () => {
    renderForm(CONFIG);
    await openSymbol();
    change('Lookback Period', '5');
    await waitFor(() => expectErrorOn('Lookback Period', 'Must be at least 10'));
    change('Lookback Period', '501');
    await waitFor(() => expectErrorOn('Lookback Period', 'Must be at most 500'));
  });

  it('accepts emptied optional fields and leaves them out of what it saves', async () => {
    const onSave = renderForm(CONFIG);
    await openSymbol();
    change('Max Position Margin (USDT)', '');
    change('Lookback Period', '');
    openTab(/Global Settings/);
    change('Max Open Positions', '');
    change('Liquidation History Retention (days)', '');
    change('WebSocket Port', '');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fieldErrors()).toHaveLength(0);

    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved: Config = JSON.parse(JSON.stringify(onSave.mock.calls[0][0]));
    expect(saved.symbols.BTCUSDT).not.toHaveProperty('maxPositionMarginUSDT');
    expect(saved.symbols.BTCUSDT).not.toHaveProperty('vwapLookback');
    expect(saved.global).not.toHaveProperty('maxOpenPositions');
    expect(saved.global).not.toHaveProperty('liquidationRetentionDays');
    expect(saved.global.server).not.toHaveProperty('websocketPort');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('accepts a legacy volume threshold in place of the long and short ones', async () => {
    const legacy: Config = {
      ...CONFIG,
      symbols: { BTCUSDT: { ...CONFIG.symbols.BTCUSDT, longVolumeThresholdUSDT: undefined, shortVolumeThresholdUSDT: undefined, volumeThresholdUSDT: 7000 } },
    };
    const onSave = renderForm(legacy);
    await openSymbol();
    // The legacy value stands in for both fields until they are set
    expect(screen.getByLabelText('Long Volume Threshold (USDT)')).toHaveAttribute('placeholder', '7000');
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(JSON.parse(JSON.stringify(onSave.mock.calls[0][0])).symbols.BTCUSDT).toEqual({
      ...CONFIG.symbols.BTCUSDT,
      longVolumeThresholdUSDT: undefined,
      shortVolumeThresholdUSDT: undefined,
      volumeThresholdUSDT: 7000,
    });
  });

  it('flags a missing volume threshold on its own field', async () => {
    const onSave = renderForm(CONFIG);
    await openSymbol();
    change('Long Volume Threshold (USDT)', '');
    clickSave();
    await waitFor(() => expectErrorOn('Long Volume Threshold (USDT)', 'Required'));
    expectNoError('Short Volume Threshold (USDT)');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows the errors of a symbol that is not open, and opens it', async () => {
    const two: Config = {
      ...CONFIG,
      symbols: { ...CONFIG.symbols, ETHUSDT: { ...CONFIG.symbols.BTCUSDT, leverage: 500 } },
    };
    const onSave = renderForm(two);
    // Nothing is open: Save goes to the symbol with the error, on the symbols tab
    clickSave();
    expect(await screen.findByText('ETHUSDT Settings')).toBeInTheDocument();
    await waitFor(() => expectErrorOn('Leverage', 'Must be at most 125'));
    await waitFor(() => expect(screen.getByLabelText('Leverage')).toHaveFocus());
    expect(onSave).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      'Cannot save yet: fix the highlighted fields',
      expect.objectContaining({ description: 'ETHUSDT leverage: Must be at most 125' })
    );
  });
});

describe('config form validation: symbol names', () => {
  it('refuses to add a symbol whose name a form path cannot hold', async () => {
    const onSave = renderForm(CONFIG);
    openTab(/Symbols/);
    fireEvent.change(await screen.findByPlaceholderText('Enter symbol manually (e.g., BTCUSDT)'), { target: { value: 'foo.bar' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Manual/ }));
    expect(toast.error).toHaveBeenCalledWith('FOO.BAR is not a valid symbol name: it cannot contain dots, brackets or quotes');
    expect(screen.queryByText('FOO.BAR')).not.toBeInTheDocument();

    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(Object.keys(onSave.mock.calls[0][0].symbols)).toEqual(['BTCUSDT']);
  });

  it('leaves a configured symbol with such a name alone, and says why it cannot be edited here', async () => {
    const odd: Config = { ...CONFIG, symbols: { ...CONFIG.symbols, 'ODD.USDT': { ...CONFIG.symbols.BTCUSDT, leverage: 7 } } };
    const onSave = renderForm(odd);
    openTab(/Symbols/);
    fireEvent.click(await screen.findByRole('button', { name: 'ODD.USDT' }));
    expect(await screen.findByText(/cannot address/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Leverage')).not.toBeInTheDocument();

    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].symbols).toEqual(odd.symbols);
  });
});

describe('config form validation: server settings', () => {
  it('flags a dashboard password of 1 to 3 characters and accepts none', async () => {
    const onSave = renderForm(CONFIG);
    openTab(/Global Settings/);
    change('Dashboard Password', 'abc');
    await waitFor(() => expectErrorOn('Dashboard Password', 'Password must be at least 4 characters'));
    clickSave();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();

    change('Dashboard Password', '');
    await waitFor(() => expectNoError('Dashboard Password'));
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].global.server.dashboardPassword).toBe('');
  });

  it('accepts any port the server accepts', async () => {
    const onSave = renderForm(CONFIG);
    openTab(/Global Settings/);
    change('Dashboard Port', '80');
    change('WebSocket Port', '70000');
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].global.server).toMatchObject({ dashboardPort: 80, websocketPort: 70000 });
  });

  it('flags a risk percentage above 100', async () => {
    const onSave = renderForm(CONFIG);
    openTab(/Global Settings/);
    change('Risk Percentage', '120');
    await waitFor(() => expectErrorOn('Risk Percentage', 'Must be at most 100'));
    clickSave();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('config form validation: Lighter and hedge mode', () => {
  const section = () => screen.getByTestId('lighter-hedge-section');

  it('flags a short account index equal to the main account index and refuses to save', async () => {
    const hedged: Config = {
      ...LIGHTER_CONFIG,
      global: { ...LIGHTER_CONFIG.global, positionMode: 'HEDGE' },
      venues: { lighter: { ...LIGHTER_CONFIG.venues!.lighter, hedge: { enabled: true, shortAccount: SHORT_ACCOUNT } } },
    };
    const onSave = renderForm(hedged);
    expect(screen.getByTestId('lighter-hedge-status')).toHaveTextContent('Hedge mode active after the bot restarts');

    change('Short account index', '12345');
    await waitFor(() => expectErrorOn('Short account index', 'Must differ from the main (long) account index'));
    expect(screen.getByTestId('lighter-hedge-status')).toHaveTextContent('Short account incomplete: index must differ');

    clickSave();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText('Short account index')).toHaveFocus());

    // Moving the main account instead clears it as well
    change('Account index', '99999');
    await waitFor(() => expectNoError('Short account index'));
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].venues.lighter).toMatchObject({ accountIndex: 99999, hedge: { shortAccount: { accountIndex: 12345 } } });
  });

  it('flags the main account index when it is moved onto the short account', async () => {
    renderForm({
      ...LIGHTER_CONFIG,
      venues: { lighter: { ...LIGHTER_CONFIG.venues!.lighter, hedge: { enabled: true, shortAccount: SHORT_ACCOUNT } } },
    });
    change('Account index', '23456');
    await waitFor(() => expectErrorOn('Short account index', 'Must differ from the main (long) account index'));
  });

  it('lists what an incomplete short account is missing, and still saves it', async () => {
    const onSave = renderForm(LIGHTER_CONFIG);
    fireEvent.click(screen.getByLabelText('Hedge mode (two sub-accounts)'));
    change('Short account index', '23456');
    expect(screen.getByTestId('lighter-hedge-status')).toHaveTextContent(
      'Short account incomplete: API key index is missing, API private key is missing, API public key is missing.'
    );
    // Every Lighter field is optional so that a partial setup can be saved: the bot just does not start live
    expect(fieldErrors(section())).toHaveLength(0);

    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].global.positionMode).toBe('HEDGE');
    expect(JSON.parse(JSON.stringify(onSave.mock.calls[0][0].venues.lighter.hedge))).toEqual({ enabled: true, shortAccount: { accountIndex: 23456 } });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('accepts a Lighter config with every optional field empty', async () => {
    const onSave = renderForm({
      ...LIGHTER_CONFIG,
      venues: { lighter: { profile: 'testnet', hedge: { enabled: true, shortAccount: SHORT_ACCOUNT } } },
    });
    for (const label of [
      'Account index', 'API key index', 'API private key', 'API public key', 'SL/TP slippage (%)', 'Transactions per minute',
      'Short account index', 'Short account API key index', 'Short account API private key', 'Short account API public key',
    ]) {
      change(label, '');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fieldErrors()).toHaveLength(0);

    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(JSON.parse(JSON.stringify(onSave.mock.calls[0][0].venues.lighter))).toEqual({ profile: 'testnet', hedge: { enabled: true, shortAccount: {} } });
  });

  it('reads digits as numbers and flags anything else', async () => {
    const onSave = renderForm({ ...LIGHTER_CONFIG, venues: { lighter: { profile: 'testnet' } } });
    change('Account index', '4242');
    change('API key index', '12.5');
    await waitFor(() => expectErrorOn('API key index', 'Must be 0-254'));
    expectNoError('Account index');
    // What was typed stays in the field
    expect(screen.getByLabelText('API key index')).toHaveValue(12.5);

    clickSave();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();

    change('API key index', '254');
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].venues.lighter).toMatchObject({ accountIndex: 4242, apiKeyIndex: 254 });

    change('Account index', String(LIGHTER_MAX_ACCOUNT_INDEX + 1));
    await waitFor(() => expectErrorOn('Account index', `Must be 1-${LIGHTER_MAX_ACCOUNT_INDEX}`));
  });

  it('flags a malformed key without ever showing it', async () => {
    const secret = 'not-hex-SECRET-sentinel-0123456789';
    const onSave = renderForm(LIGHTER_CONFIG);
    change('API private key', `  ${secret}  `);
    await waitFor(() => expectErrorOn('API private key', 'Expected 40 bytes of hex (80 characters)'));

    clickSave();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();

    // Neither the page text, nor the toast, nor anything logged repeats the key
    expect(document.body.textContent).not.toContain(secret);
    expect(JSON.stringify((toast.error as jest.Mock).mock.calls)).not.toContain(secret);
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(secret);
    expect(screen.getByLabelText('API private key')).toHaveAttribute('type', 'password');
  });

  it('accepts keys with the 0x prefix', async () => {
    const onSave = renderForm(LIGHTER_CONFIG);
    change('API private key', `0x${PRIVATE_KEY}`);
    change('API public key', `0X${PUBLIC_KEY}`.replace('0X', '0x'));
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].venues.lighter.apiKeyPrivateKey).toBe(`0x${PRIVATE_KEY}`);
  });

  it('flags a slippage and a send rate outside the schema ranges', async () => {
    renderForm(LIGHTER_CONFIG);
    change('SL/TP slippage (%)', '11');
    change('Transactions per minute', '5000');
    await waitFor(() => expectErrorOn('SL/TP slippage (%)', 'Must be at most 10'));
    await waitFor(() => expectErrorOn('Transactions per minute', 'Must be 1-4000'));
    change('SL/TP slippage (%)', '0');
    await waitFor(() => expectErrorOn('SL/TP slippage (%)', 'Must be at least 0.01'));
  });

  it('flags the Lighter settings that were saved malformed as soon as they are shown', async () => {
    renderForm({ ...LIGHTER_CONFIG, venues: { lighter: { ...LIGHTER_CONFIG.venues!.lighter, apiKeyPublicKey: 'abc' } } });
    await waitFor(() => expectErrorOn('API public key', 'Expected 40 bytes of hex (80 characters)'));
  });
});

describe('LighterSettings held by its host', () => {
  function Host({ onChange }: { onChange: (value: LighterVenueConfig) => void }) {
    const [value, setValue] = React.useState<LighterVenueConfig | undefined>({ profile: 'testnet', accountIndex: 7 });
    return (
      <>
        <button type="button" onClick={() => setValue({ profile: 'mainnet', accountIndex: 99, apiKeyIndex: 5 })}>load</button>
        <LighterSettings value={value} onChange={(next) => { setValue(next); onChange(next); }} />
      </>
    );
  }

  it('takes over a value that the host changed', async () => {
    const onChange = jest.fn();
    render(<Host onChange={onChange} />);
    expect(screen.getByLabelText('Account index')).toHaveValue(7);

    fireEvent.click(screen.getByRole('button', { name: 'load' }));
    await waitFor(() => expect(screen.getByLabelText('Account index')).toHaveValue(99));
    expect(screen.getByLabelText('API key index')).toHaveValue(5);
    expect(screen.getByLabelText('Lighter network')).toHaveValue('mainnet');
    // Taking a value over is not an edit
    expect(onChange).not.toHaveBeenCalled();

    change('Account index', '100');
    expect(onChange).toHaveBeenLastCalledWith({ profile: 'mainnet', accountIndex: 100, apiKeyIndex: 5 });
  });

  it('passes edits on without the fields that were cleared', () => {
    const onChange = jest.fn();
    render(<Host onChange={onChange} />);
    change('Account index', '');
    expect(onChange).toHaveBeenLastCalledWith({ profile: 'testnet' });
    expect(Object.keys(onChange.mock.calls[onChange.mock.calls.length - 1][0])).toEqual(['profile']);
  });
});

describe('config form accessibility', () => {
  // Every control has a name, and everything it points to for its description exists
  function expectNamedControls() {
    const controls = document.querySelectorAll<HTMLElement>('input, select, textarea, [role="switch"], [role="combobox"]');
    expect(controls.length).toBeGreaterThan(0);
    for (const element of Array.from(controls)) {
      const labelled = (element as HTMLInputElement).labels?.length || element.getAttribute('aria-label') || element.getAttribute('aria-labelledby');
      if (!labelled) throw new Error(`Control without a label: ${element.outerHTML.slice(0, 200)}`);
      for (const id of (element.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)) {
        if (!document.getElementById(id)) throw new Error(`aria-describedby ${id} points nowhere (${element.id})`);
      }
    }
  }

  it('labels every control on every tab', async () => {
    const config: Config = {
      ...LIGHTER_CONFIG,
      global: { ...LIGHTER_CONFIG.global, useThresholdSystem: true, liquidationSource: 'lighter', positionMode: 'HEDGE' },
      symbols: { BTCUSDT: { ...CONFIG.symbols.BTCUSDT, longTradeSize: 0.01, shortTradeSize: 0.02, useThreshold: true } },
      venues: { lighter: { ...LIGHTER_CONFIG.venues!.lighter, hedge: { enabled: true, shortAccount: SHORT_ACCOUNT } } },
    };
    renderForm(config);
    expectNamedControls();
    openTab(/Global Settings/);
    await screen.findByText('Server Settings');
    fireEvent.click(screen.getByLabelText('Enable Remote WebSocket Access'));
    expectNamedControls();
    await openSymbol();
    expectNamedControls();
  });

  it('labels the Aster credentials and the venue pickers', () => {
    renderForm(CONFIG);
    expectNamedControls();
    expect(screen.getByLabelText('Trading venue')).toHaveAttribute('role', 'combobox');
    expect(screen.getByLabelText('Liquidation source')).toHaveAttribute('role', 'combobox');
    expect(screen.getByLabelText('Secret Key')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Show secret key' })).toBeInTheDocument();
  });
});
