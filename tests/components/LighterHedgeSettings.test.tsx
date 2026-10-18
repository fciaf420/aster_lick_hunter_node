import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { LighterSettings, type LighterPositionMode } from '@/components/LighterSettings';
import SymbolConfigForm, { hedgePositionModeAvailable, lighterHedgeConfigured } from '@/components/SymbolConfigForm';
import { LIGHTER_MAX_ACCOUNT_INDEX, LIGHTER_MAX_API_KEY_INDEX } from '@/lib/config/types';
import type { Config, LighterVenueConfig } from '@/lib/types';

const MAIN_PRIVATE_KEY = 'a1'.repeat(40);
const MAIN_PUBLIC_KEY = 'b2'.repeat(40);
const SHORT_PRIVATE_KEY = 'c3'.repeat(40);
const SHORT_PUBLIC_KEY = 'd4'.repeat(40);

const MAIN: LighterVenueConfig = {
  profile: 'testnet',
  accountIndex: 12345,
  apiKeyIndex: 3,
  apiKeyPrivateKey: MAIN_PRIVATE_KEY,
  apiKeyPublicKey: MAIN_PUBLIC_KEY,
};

const SHORT_ACCOUNT = {
  accountIndex: 23456,
  apiKeyIndex: 4,
  apiKeyPrivateKey: SHORT_PRIVATE_KEY,
  apiKeyPublicKey: SHORT_PUBLIC_KEY,
};

const COMPLETE: LighterVenueConfig = { ...MAIN, hedge: { enabled: true, shortAccount: SHORT_ACCOUNT } };

// Holds the Lighter settings and the position mode like the config form does, and records every change in order
function Harness({ initial, initialMode, onChange, onPositionModeChange, withModeHandler = true, ...props }: {
  initial?: LighterVenueConfig;
  initialMode?: LighterPositionMode;
  onChange?: (value: LighterVenueConfig) => void;
  onPositionModeChange?: (mode: LighterPositionMode) => void;
  withModeHandler?: boolean;
  showCredentials?: boolean;
  showHedge?: boolean;
}) {
  const [value, setValue] = useState<LighterVenueConfig | undefined>(initial);
  const [mode, setMode] = useState<LighterPositionMode | undefined>(initialMode);
  return (
    <LighterSettings
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      positionMode={mode}
      onPositionModeChange={withModeHandler ? (next) => {
        setMode(next);
        onPositionModeChange?.(next);
      } : undefined}
      {...props}
    />
  );
}

function lastValue(onChange: jest.Mock): LighterVenueConfig {
  return onChange.mock.calls[onChange.mock.calls.length - 1][0] as LighterVenueConfig;
}

const section = () => screen.getByTestId('lighter-hedge-section');
const status = () => screen.getByTestId('lighter-hedge-status');

describe('LighterSettings hedge mode (two sub-accounts)', () => {
  it('is hidden by default and without the credentials', () => {
    const { unmount } = render(<Harness initial={COMPLETE} initialMode="HEDGE" />);
    expect(screen.queryByTestId('lighter-hedge-section')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Short account index')).not.toBeInTheDocument();
    expect(screen.queryByText(/Main account = long account/)).not.toBeInTheDocument();
    unmount();

    render(<Harness initial={COMPLETE} initialMode="HEDGE" showHedge showCredentials={false} />);
    expect(screen.queryByTestId('lighter-hedge-section')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('shows the explanation, the funding note and the restart note', () => {
    render(<Harness initial={MAIN} initialMode="ONE_WAY" showHedge />);
    const box = section();
    expect(within(box).getByText(/Lighter nets one position per market per account/)).toHaveTextContent(
      /longs go on the main account \(above\) and\s+shorts on a second sub-account/
    );
    expect(within(box).getByText(/each with its own\s+SL\/TP/)).toBeInTheDocument();
    expect(within(box).getByText(/Fund both accounts with USDC/)).toHaveTextContent(
      /own margin and liquidation price, and the bot never moves\s+funds between them/
    );
    expect(within(box).getByText('Changes apply after the bot restarts.')).toBeInTheDocument();
    expect(within(box).queryByText(/credentials incomplete/)).not.toBeInTheDocument();
  });

  it('uses distinct labels from the main account and masks the short private key', () => {
    render(<Harness initial={COMPLETE} initialMode="HEDGE" showHedge />);

    const labels = [
      'Account index', 'API key index', 'API private key', 'API public key',
      'Short account index', 'Short account API key index', 'Short account API private key', 'Short account API public key',
    ];
    const inputs = labels.map(label => screen.getByLabelText(label));
    expect(new Set(inputs).size).toBe(labels.length);

    const switchControl = screen.getByLabelText('Hedge mode (two sub-accounts)');
    expect(switchControl).toHaveAttribute('role', 'switch');
    expect(switchControl).toHaveAttribute('aria-checked', 'true');

    const shortPrivate = screen.getByLabelText('Short account API private key') as HTMLInputElement;
    const mainPrivate = screen.getByLabelText('API private key') as HTMLInputElement;
    expect(shortPrivate.type).toBe('password');
    expect(shortPrivate.value).toBe(SHORT_PRIVATE_KEY);
    expect((screen.getByLabelText('Short account API public key') as HTMLInputElement).type).toBe('text');

    fireEvent.click(screen.getByRole('button', { name: 'Show short account API private key' }));
    expect(shortPrivate.type).toBe('text');
    expect(mainPrivate.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Hide short account API private key' }));
    expect(shortPrivate.type).toBe('password');
  });

  it('never shows either private key outside its own input', () => {
    const { container } = render(<Harness initial={COMPLETE} initialMode="HEDGE" showHedge />);
    fireEvent.click(screen.getByRole('button', { name: 'Show short account API private key' }));
    expect(container.textContent).not.toContain(SHORT_PRIVATE_KEY);
    expect(container.textContent).not.toContain(MAIN_PRIVATE_KEY);
    expect(container.innerHTML.split(SHORT_PRIVATE_KEY)).toHaveLength(2);   // only the input's value attribute
  });

  it('writes the short account under hedge.shortAccount and keeps the main account', () => {
    const onChange = jest.fn();
    render(<Harness initial={{ ...MAIN, hedge: { enabled: true } }} initialMode="HEDGE" onChange={onChange} showHedge />);

    fireEvent.change(screen.getByLabelText('Short account index'), { target: { value: '23456' } });
    fireEvent.change(screen.getByLabelText('Short account API key index'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Short account API private key'), { target: { value: `  ${SHORT_PRIVATE_KEY} ` } });
    fireEvent.change(screen.getByLabelText('Short account API public key'), { target: { value: SHORT_PUBLIC_KEY } });

    expect(lastValue(onChange)).toEqual({ ...MAIN, hedge: { enabled: true, shortAccount: SHORT_ACCOUNT } });

    fireEvent.change(screen.getByLabelText('Short account API public key'), { target: { value: '  ' } });
    fireEvent.change(screen.getByLabelText('Short account index'), { target: { value: '' } });
    expect(lastValue(onChange).hedge?.shortAccount).toEqual({
      accountIndex: undefined,
      apiKeyIndex: 4,
      apiKeyPrivateKey: SHORT_PRIVATE_KEY,
      apiKeyPublicKey: undefined,
    });
    expect(lastValue(onChange)).toMatchObject(MAIN);
  });

  it('flags malformed short keys inside the hedge section only', async () => {
    render(
      <Harness
        initial={{ ...MAIN, hedge: { enabled: true, shortAccount: { ...SHORT_ACCOUNT, apiKeyPrivateKey: 'nothex', apiKeyPublicKey: 'abc' } } }}
        initialMode="HEDGE"
        showHedge
      />
    );
    // Errors come from the form's asynchronous validation
    expect(await within(section()).findAllByText('Expected 40 bytes of hex (80 characters)')).toHaveLength(2);
    expect(screen.getAllByText('Expected 40 bytes of hex (80 characters)')).toHaveLength(2);   // main keys are valid
    expect(screen.getByLabelText('Short account API private key')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Short account API public key')).toHaveAttribute('aria-invalid', 'true');
    // Set but malformed keys pass lighterHedgeState (formats are checked on save): the status says so
    expect(status()).toHaveTextContent('Short account has invalid fields');
    expect(status()).not.toHaveTextContent('Hedge mode active');
  });

  it('flags out-of-range indexes and the main account index', async () => {
    const onChange = jest.fn();
    render(<Harness initial={{ ...MAIN, hedge: { enabled: true } }} initialMode="HEDGE" onChange={onChange} showHedge />);

    // Errors come from the form's asynchronous validation
    fireEvent.change(screen.getByLabelText('Short account API key index'), { target: { value: '255' } });
    expect(await within(section()).findByText(`Must be 0-${LIGHTER_MAX_API_KEY_INDEX}`)).toBeInTheDocument();
    expect(screen.getByLabelText('Short account API key index')).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(screen.getByLabelText('Short account index'), { target: { value: '0' } });
    expect(await within(section()).findByText(`Must be 1-${LIGHTER_MAX_ACCOUNT_INDEX}`)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Short account index'), { target: { value: '12345' } });
    expect(await within(section()).findByText('Must differ from the main (long) account index')).toBeInTheDocument();
    expect(screen.getByLabelText('Short account index')).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(screen.getByLabelText('Short account index'), { target: { value: '23456' } });
    fireEvent.change(screen.getByLabelText('Short account API key index'), { target: { value: '4' } });
    await waitFor(() => expect(within(section()).queryByText(/^Must /)).not.toBeInTheDocument());
    expect(screen.getByLabelText('Short account index')).not.toHaveAttribute('aria-invalid');
  });

  it('turns hedge mode on: sets hedge.enabled first, then asks for position mode HEDGE', () => {
    const calls: string[] = [];
    const onChange = jest.fn((value: LighterVenueConfig) => calls.push(`change:${value.hedge?.enabled}`));
    const onPositionModeChange = jest.fn((mode: LighterPositionMode) => calls.push(`mode:${mode}`));
    render(
      <Harness
        initial={{ ...MAIN, hedge: { shortAccount: SHORT_ACCOUNT } }}
        initialMode="ONE_WAY"
        onChange={onChange}
        onPositionModeChange={onPositionModeChange}
        showHedge
      />
    );
    expect(screen.getByLabelText('Hedge mode (two sub-accounts)')).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByLabelText('Hedge mode (two sub-accounts)'));
    expect(calls).toEqual(['change:true', 'mode:HEDGE']);
    expect(onChange).toHaveBeenCalledWith({ ...MAIN, hedge: { enabled: true, shortAccount: SHORT_ACCOUNT } });
    expect(onPositionModeChange).toHaveBeenCalledWith('HEDGE');
    expect(screen.getByLabelText('Hedge mode (two sub-accounts)')).toHaveAttribute('aria-checked', 'true');
    expect(status()).toHaveTextContent('Hedge mode active after the bot restarts');

    // Off again: back to one-way, the short account stays filled in
    fireEvent.click(screen.getByLabelText('Hedge mode (two sub-accounts)'));
    expect(calls).toEqual(['change:true', 'mode:HEDGE', 'change:false', 'mode:ONE_WAY']);
    expect(lastValue(onChange)).toEqual({ ...MAIN, hedge: { enabled: false, shortAccount: SHORT_ACCOUNT } });
    expect(status()).toHaveTextContent('Hedge mode is off');
  });

  it('turns hedge mode on without a position mode handler', () => {
    const onChange = jest.fn();
    render(<Harness initial={MAIN} onChange={onChange} withModeHandler={false} showHedge />);
    fireEvent.click(screen.getByLabelText('Hedge mode (two sub-accounts)'));
    expect(onChange).toHaveBeenLastCalledWith({ ...MAIN, hedge: { enabled: true } });
  });

  describe('status line', () => {
    it('says hedge mode is off while the switch is off', () => {
      render(<Harness initial={{ ...MAIN, hedge: { shortAccount: SHORT_ACCOUNT } }} initialMode="HEDGE" showHedge />);
      expect(status()).toHaveTextContent('Hedge mode is off: the bot trades one-way on the main account');
      expect(screen.queryByRole('button', { name: 'Use hedge position mode' })).not.toBeInTheDocument();
      expect(within(section()).getByText(/does not manage short account 23456/)).toBeInTheDocument();
    });

    it('names a one-way position mode and offers to switch it to HEDGE', () => {
      const onPositionModeChange = jest.fn();
      render(<Harness initial={COMPLETE} initialMode="ONE_WAY" onPositionModeChange={onPositionModeChange} showHedge />);
      expect(status()).toHaveTextContent('Position mode is One-way');
      expect(status()).not.toHaveTextContent('Short account incomplete');

      fireEvent.click(screen.getByRole('button', { name: 'Use hedge position mode' }));
      expect(onPositionModeChange).toHaveBeenCalledWith('HEDGE');
      expect(status()).toHaveTextContent('Hedge mode active after the bot restarts');
      expect(screen.queryByRole('button', { name: 'Use hedge position mode' })).not.toBeInTheDocument();
    });

    it('also lists what the short account is missing while the position mode is one-way', () => {
      render(<Harness initial={{ ...MAIN, hedge: { enabled: true, shortAccount: { accountIndex: 23456 } } }} initialMode="ONE_WAY" showHedge />);
      expect(status()).toHaveTextContent('Position mode is One-way');
      expect(status()).toHaveTextContent(
        'Short account incomplete: API key index is missing, API private key is missing, API public key is missing.'
      );
      expect(within(status()).getAllByText(/^Short account incomplete/)).toHaveLength(1);
    });

    it('treats a missing position mode as one-way and hides the button without a handler', () => {
      render(<Harness initial={COMPLETE} withModeHandler={false} showHedge />);
      expect(status()).toHaveTextContent('Position mode is One-way');
      expect(screen.queryByRole('button', { name: 'Use hedge position mode' })).not.toBeInTheDocument();
    });

    it('lists what the short account is missing', () => {
      render(
        <Harness
          initial={{ ...MAIN, hedge: { enabled: true, shortAccount: { accountIndex: 23456, apiKeyIndex: 4 } } }}
          initialMode="HEDGE"
          showHedge
        />
      );
      expect(status()).toHaveTextContent(
        'Short account incomplete: API private key is missing, API public key is missing.'
      );
      // Without a trading mode (the standalone fields) it reads as paper mode: one-way on the main account
      expect(status()).toHaveTextContent('Until it is complete the bot trades one-way on the main account');
      expect(status()).not.toHaveTextContent('does not start live');
      expect(within(section()).queryByText(/credentials incomplete/)).not.toBeInTheDocument();
      expect(within(section()).getByText(/does not manage short account 23456/)).toBeInTheDocument();
    });

    it('lists every missing field of an empty short account', () => {
      render(<Harness initial={{ ...MAIN, hedge: { enabled: true } }} initialMode="HEDGE" showHedge />);
      expect(status()).toHaveTextContent(
        'Short account incomplete: index is missing, API key index is missing, API private key is missing, API public key is missing.'
      );
      expect(within(section()).queryByText(/does not manage short account/)).not.toBeInTheDocument();
    });

    it('reports the same index as the main account as incomplete', async () => {
      render(
        <Harness
          initial={{ ...MAIN, hedge: { enabled: true, shortAccount: { ...SHORT_ACCOUNT, accountIndex: MAIN.accountIndex } } }}
          initialMode="HEDGE"
          showHedge
        />
      );
      expect(status()).toHaveTextContent('Short account incomplete: index must differ from the main (long) account index');
      expect(await within(section()).findByText('Must differ from the main (long) account index')).toBeInTheDocument();
    });

    it('says hedge mode is active after a restart when everything is set', () => {
      render(<Harness initial={COMPLETE} initialMode="HEDGE" showHedge />);
      expect(status()).toHaveTextContent('Hedge mode active after the bot restarts');
      expect(within(section()).queryByText(/does not manage short account/)).not.toBeInTheDocument();
    });
  });

  it('marks the main account as the long account while hedge mode is on', () => {
    const { unmount } = render(<Harness initial={COMPLETE} initialMode="HEDGE" showHedge />);
    expect(screen.getByTestId('lighter-main-account-hint')).toHaveTextContent('Main account = long account');
    unmount();

    render(<Harness initial={{ ...COMPLETE, hedge: { ...COMPLETE.hedge, enabled: false } }} initialMode="HEDGE" showHedge />);
    expect(screen.queryByText(/Main account = long account/)).not.toBeInTheDocument();
  });

  it('keeps the existing single-account texts and the liquidation feed switch', () => {
    render(<Harness initial={{ profile: 'testnet' }} initialMode="ONE_WAY" showHedge showLiquidationFeed />);
    // The main credentials warning is unchanged; the hedge section never uses that wording
    expect(screen.getAllByText(/credentials incomplete/)).toHaveLength(1);
    expect(screen.getAllByRole('switch')).toHaveLength(2);
    expect(screen.getByLabelText(/Trade on Lighter liquidations/)).toHaveAttribute('role', 'switch');
  });
});

// ===== Config form: when position mode HEDGE can be chosen =====

function lighterConfig(lighter: LighterVenueConfig | undefined, positionMode: LighterPositionMode = 'ONE_WAY'): Config {
  return {
    api: { apiKey: '', secretKey: '' },
    global: {
      riskPercent: 2,
      paperMode: true,
      positionMode,
      maxOpenPositions: 5,
      exchange: 'lighter',
      liquidationSource: 'aster',
    },
    symbols: {},
    venues: lighter ? { lighter } : undefined,
    version: '1.2.0',
  };
}

describe('hedgePositionModeAvailable', () => {
  it('allows HEDGE on Aster (native hedge mode), also when no venue is set', () => {
    const aster = lighterConfig(undefined);
    expect(hedgePositionModeAvailable({ ...aster, global: { ...aster.global, exchange: 'aster' } })).toBe(true);
    expect(hedgePositionModeAvailable({ ...aster, global: { ...aster.global, exchange: undefined } })).toBe(true);
    expect(lighterHedgeConfigured({ ...aster, global: { ...aster.global, exchange: 'aster' }, venues: { lighter: COMPLETE } })).toBe(false);
  });

  it('allows HEDGE on Lighter only with hedge mode enabled and a complete short account', () => {
    expect(hedgePositionModeAvailable(lighterConfig(undefined))).toBe(false);
    expect(hedgePositionModeAvailable(lighterConfig(MAIN))).toBe(false);
    expect(hedgePositionModeAvailable(lighterConfig({ ...MAIN, hedge: { shortAccount: SHORT_ACCOUNT } }))).toBe(false);
    expect(hedgePositionModeAvailable(lighterConfig({ ...MAIN, hedge: { enabled: false, shortAccount: SHORT_ACCOUNT } }))).toBe(false);
    expect(hedgePositionModeAvailable(lighterConfig({ ...MAIN, hedge: { enabled: true } }))).toBe(false);
    expect(hedgePositionModeAvailable(lighterConfig({
      ...MAIN,
      hedge: { enabled: true, shortAccount: { ...SHORT_ACCOUNT, apiKeyPublicKey: undefined } },
    }))).toBe(false);
    expect(hedgePositionModeAvailable(lighterConfig({
      ...MAIN,
      hedge: { enabled: true, shortAccount: { ...SHORT_ACCOUNT, accountIndex: MAIN.accountIndex } },
    }))).toBe(false);

    expect(hedgePositionModeAvailable(lighterConfig(COMPLETE))).toBe(true);
    expect(lighterHedgeConfigured(lighterConfig(COMPLETE))).toBe(true);
  });

  it('does not depend on the current position mode', () => {
    expect(hedgePositionModeAvailable(lighterConfig(COMPLETE, 'ONE_WAY'))).toBe(true);
    expect(hedgePositionModeAvailable(lighterConfig(COMPLETE, 'HEDGE'))).toBe(true);
  });
});

describe('SymbolConfigForm with Lighter hedge mode', () => {
  function openGlobalSettings() {
    const tab = screen.getByRole('tab', { name: /Global Settings/ });
    fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
    fireEvent.focus(tab);
  }

  function hedgeOption(): HTMLOptionElement {
    return within(screen.getByLabelText('Position Mode')).getByRole('option', { name: /Hedge Mode/ }) as HTMLOptionElement;
  }

  it('applies the hedge switch and the position mode change of one click together', async () => {
    const onSave = jest.fn();
    render(<SymbolConfigForm onSave={onSave} currentConfig={lighterConfig({ ...MAIN, hedge: { shortAccount: SHORT_ACCOUNT } })} />);

    expect(screen.getByTestId('lighter-hedge-section')).toBeInTheDocument();
    expect(status()).toHaveTextContent('Hedge mode is off');
    fireEvent.click(screen.getByLabelText('Hedge mode (two sub-accounts)'));
    expect(status()).toHaveTextContent('Hedge mode active after the bot restarts');

    fireEvent.click(screen.getByRole('button', { name: /Save Configuration/ }));
    // Saving validates first, asynchronously
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0] as Config;
    expect(saved.global.positionMode).toBe('HEDGE');
    expect(saved.venues?.lighter).toEqual({ ...MAIN, hedge: { enabled: true, shortAccount: SHORT_ACCOUNT } });
  });

  it('enables the HEDGE option for Lighter once hedge mode is set up', () => {
    render(<SymbolConfigForm onSave={jest.fn()} currentConfig={lighterConfig(COMPLETE, 'HEDGE')} />);
    openGlobalSettings();
    expect(hedgeOption().disabled).toBe(false);
    expect(hedgeOption().textContent).toBe('Hedge Mode (LONG/SHORT)');
    expect(screen.getByText('Lighter: hedge mode uses two sub-accounts (see Hedge mode in the Lighter settings)')).toBeInTheDocument();
    expect(screen.queryByText(/only supports one-way positions/)).not.toBeInTheDocument();
  });

  it('keeps the HEDGE option disabled for Lighter without a complete short account', () => {
    render(<SymbolConfigForm onSave={jest.fn()} currentConfig={lighterConfig({ ...MAIN, hedge: { enabled: true } }, 'ONE_WAY')} />);
    openGlobalSettings();
    expect(hedgeOption().disabled).toBe(true);
    expect(screen.getByText(/Lighter only supports one-way positions/)).toHaveTextContent(/hedge mode needs a second sub-account/);
    expect(screen.queryByText(/Lighter: hedge mode uses two sub-accounts/)).not.toBeInTheDocument();
  });

  it('leaves the Aster form without a hedge section', () => {
    const aster = lighterConfig(COMPLETE, 'HEDGE');
    render(<SymbolConfigForm onSave={jest.fn()} currentConfig={{ ...aster, global: { ...aster.global, exchange: 'aster' } }} />);
    expect(screen.queryByTestId('lighter-hedge-section')).not.toBeInTheDocument();
    openGlobalSettings();
    expect(hedgeOption().disabled).toBe(false);
    expect(screen.queryByText(/hedge mode uses two sub-accounts/)).not.toBeInTheDocument();
  });
});
