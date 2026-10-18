import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ApiKeyStep } from '@/components/onboarding/steps/ApiKeyStep';
import { hasLighterCredentials } from '@/components/LighterSettings';

// The onboarding step keeps the Lighter settings in its own state and hands them to LighterSettings (the same
// fields the config form shows)

const PRIVATE_KEY = 'a1'.repeat(40);
const PUBLIC_KEY = 'b2'.repeat(40);

// Validation is asynchronous, and the fields validate their settings when they mount: let that finish before typing,
// as edits in a browser are never that close behind it (a test fires them in the same tick)
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

function fillLighter(overrides: Record<string, string> = {}) {
  const values = { 'Account index': '12345', 'API key index': '3', 'API private key': PRIVATE_KEY, 'API public key': PUBLIC_KEY, ...overrides };
  for (const [label, value] of Object.entries(values)) change(label, value);
}

function openKeysTab() {
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Enter Keys' }), { button: 0, ctrlKey: false });
}

describe('onboarding ApiKeyStep with Lighter', () => {
  it('collects the Lighter credentials and passes them on', () => {
    const onNext = jest.fn();
    render(<ApiKeyStep initialVenue="lighter" onNext={onNext} onBack={jest.fn()} onSkip={jest.fn()} />);
    openKeysTab();

    const next = screen.getByRole('button', { name: 'Enter Keys' });
    expect(next).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Account index'), { target: { value: '12345' } });
    fireEvent.change(screen.getByLabelText('API key index'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('API private key'), { target: { value: PRIVATE_KEY } });
    expect(screen.getByLabelText('API private key')).toHaveAttribute('type', 'password');
    fireEvent.change(screen.getByLabelText('API public key'), { target: { value: PUBLIC_KEY } });

    const proceed = screen.getByRole('button', { name: 'Continue' });
    expect(proceed).toBeEnabled();
    expect(screen.getByText('Testnet Trading Ready')).toBeInTheDocument();
    fireEvent.click(proceed);
    expect(onNext).toHaveBeenCalledWith('', '', 'lighter', {
      lighter: { accountIndex: 12345, apiKeyIndex: 3, apiKeyPrivateKey: PRIVATE_KEY, apiKeyPublicKey: PUBLIC_KEY },
    });
  });

  it('starts from the settings it was given and keeps the chosen network in paper mode', () => {
    const onNext = jest.fn();
    render(
      <ApiKeyStep
        initialVenue="lighter"
        initialLighter={{ profile: 'mainnet', accountIndex: 7 }}
        onNext={onNext}
        onBack={jest.fn()}
        onSkip={jest.fn()}
      />
    );
    openKeysTab();
    expect(screen.getByLabelText('Lighter network')).toHaveValue('mainnet');
    expect(screen.getByLabelText('Account index')).toHaveValue(7);

    fireEvent.click(screen.getByRole('button', { name: 'Use Paper Mode' }));
    expect(onNext).toHaveBeenCalledWith('', '', 'lighter', { lighter: { profile: 'mainnet', liquidationsLive: undefined } });
  });
});

describe('onboarding ApiKeyStep: Lighter input the server would refuse', () => {
  async function renderStep(props: Partial<React.ComponentProps<typeof ApiKeyStep>> = {}) {
    const onNext = jest.fn();
    render(<ApiKeyStep initialVenue="lighter" onNext={onNext} onBack={jest.fn()} onSkip={jest.fn()} {...props} />);
    openKeysTab();
    await settle();
    return onNext;
  }

  it('keeps Continue disabled while the account index is not a whole number, and says why', async () => {
    const onNext = await renderStep();
    fillLighter({ 'Account index': '12.5' });

    // The field keeps what was typed and flags it; the step does not count it as an index
    await waitFor(() => expect(screen.getByLabelText('Account index')).toHaveAttribute('aria-invalid', 'true'));
    const proceed = screen.getByRole('button', { name: 'Continue' });
    expect(proceed).toBeDisabled();
    expect(screen.getByText('Fix the marked fields to continue')).toBeInTheDocument();
    expect(screen.queryByText('Paper Mode Available')).not.toBeInTheDocument();
    fireEvent.click(proceed);
    expect(onNext).not.toHaveBeenCalled();

    change('Account index', '12');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onNext).toHaveBeenCalledWith('', '', 'lighter', {
      lighter: { accountIndex: 12, apiKeyIndex: 3, apiKeyPrivateKey: PRIVATE_KEY, apiKeyPublicKey: PUBLIC_KEY },
    });
  });

  it('keeps Continue disabled for a SL/TP slippage of 0', async () => {
    const onNext = await renderStep();
    fillLighter();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());

    change('SL/TP slippage (%)', '0');
    await waitFor(() => expect(screen.getByLabelText('SL/TP slippage (%)')).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(screen.getByText('Must be at least 0.01')).toBeInTheDocument();

    change('SL/TP slippage (%)', '');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // An emptied slippage is left out: the bot uses its default
    expect(onNext.mock.calls[0][3].lighter).not.toHaveProperty('sltpSlippagePct');
  });

  it('keeps Continue disabled for a key that is not hex and a send rate out of range', async () => {
    await renderStep();
    fillLighter({ 'API private key': 'not-hex' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled());
    change('API private key', PRIVATE_KEY);
    change('Transactions per minute', '4001');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled());
    change('Transactions per minute', '4000');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
  });

  it('starts disabled when the settings it was given are invalid, and lets paper mode through', async () => {
    const onNext = await renderStep({
      initialLighter: { profile: 'testnet', accountIndex: 12345, apiKeyIndex: 3, apiKeyPrivateKey: PRIVATE_KEY, apiKeyPublicKey: PUBLIC_KEY, sltpSlippagePct: 0 },
    });
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await waitFor(() => expect(screen.getByLabelText('SL/TP slippage (%)')).toHaveAttribute('aria-invalid', 'true'));

    // Paper mode keeps only the network and the feed mode, whatever the fields hold
    fireEvent.click(screen.getByRole('button', { name: 'Use Paper Mode' }));
    expect(onNext).toHaveBeenCalledWith('', '', 'lighter', { lighter: { profile: 'testnet', liquidationsLive: undefined } });
  });

  it('is not held back by a Lighter field when another venue is chosen', () => {
    const onNext = jest.fn();
    render(<ApiKeyStep initialVenue="aster" onNext={onNext} onBack={jest.fn()} onSkip={jest.fn()} initialLighter={{ sltpSlippagePct: 0 }} />);
    openKeysTab();
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'k'.repeat(64) } });
    fireEvent.change(screen.getByLabelText('Secret Key'), { target: { value: 's'.repeat(64) } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onNext).toHaveBeenCalledWith('k'.repeat(64), 's'.repeat(64), 'aster');
  });
});

describe('hasLighterCredentials', () => {
  const complete = { accountIndex: 12345, apiKeyIndex: 3, apiKeyPrivateKey: PRIVATE_KEY, apiKeyPublicKey: PUBLIC_KEY };

  it('needs real numbers for the indexes and text for the keys', () => {
    expect(hasLighterCredentials(complete)).toBe(true);
    // 0 is a number (the schema judges the range)
    expect(hasLighterCredentials({ ...complete, apiKeyIndex: 0 })).toBe(true);
    expect(hasLighterCredentials(undefined)).toBe(false);
    expect(hasLighterCredentials({})).toBe(false);
    expect(hasLighterCredentials({ ...complete, accountIndex: undefined })).toBe(false);
    expect(hasLighterCredentials({ ...complete, apiKeyPublicKey: '' })).toBe(false);
  });

  it('does not count text that a field kept as typed', () => {
    expect(hasLighterCredentials({ ...complete, accountIndex: '12.5' as unknown as number })).toBe(false);
    expect(hasLighterCredentials({ ...complete, apiKeyIndex: 'x' as unknown as number })).toBe(false);
    expect(hasLighterCredentials({ ...complete, accountIndex: NaN })).toBe(false);
    expect(hasLighterCredentials({ ...complete, apiKeyPrivateKey: 5 as unknown as string })).toBe(false);
  });
});
