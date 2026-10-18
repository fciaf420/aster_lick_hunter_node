import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ApiKeyStep } from '@/components/onboarding/steps/ApiKeyStep';

// The onboarding step keeps the Lighter settings in its own state and hands them to LighterSettings (the same
// fields the config form shows)

const PRIVATE_KEY = 'a1'.repeat(40);
const PUBLIC_KEY = 'b2'.repeat(40);

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
