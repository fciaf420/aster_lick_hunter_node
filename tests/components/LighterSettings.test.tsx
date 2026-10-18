import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { LighterSettings, hasLighterCredentials } from '@/components/LighterSettings';
import type { LighterVenueConfig } from '@/lib/types';

const PRIVATE_KEY = 'a1'.repeat(40);
const PUBLIC_KEY = 'b2'.repeat(40);

// Holds the value like the config form does and records every change
function Harness({ initial, onChange, ...props }: {
  initial?: LighterVenueConfig;
  onChange?: (value: LighterVenueConfig) => void;
  showCredentials?: boolean;
  showLiquidationFeed?: boolean;
}) {
  const [value, setValue] = useState<LighterVenueConfig | undefined>(initial);
  return (
    <LighterSettings
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      {...props}
    />
  );
}

describe('LighterSettings', () => {
  it('defaults to testnet and shows the network banner', () => {
    render(<Harness />);
    const select = screen.getByLabelText('Lighter network') as HTMLSelectElement;
    expect(select.value).toBe('testnet');
    expect(screen.getByTestId('lighter-network-banner')).toHaveTextContent('Lighter testnet (chain 300) - test funds only');
  });

  it('switches to mainnet with a real-funds banner and keeps Robinhood disabled', () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);
    const select = screen.getByLabelText('Lighter network') as HTMLSelectElement;

    const robinhood = screen.getByRole('option', { name: /Lighter Robinhood - not available/ }) as HTMLOptionElement;
    const robinhoodTestnet = screen.getByRole('option', { name: /Robinhood testnet/ }) as HTMLOptionElement;
    expect(robinhood.disabled).toBe(true);
    expect(robinhoodTestnet.disabled).toBe(true);

    fireEvent.change(select, { target: { value: 'robinhood' } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(select, { target: { value: 'mainnet' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ profile: 'mainnet' }));
    expect(screen.getByTestId('lighter-network-banner')).toHaveTextContent('Lighter mainnet (chain 304) - REAL FUNDS');
  });

  it('collects the credentials, with the private key as a password field', () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);
    expect(screen.getByText(/credentials incomplete/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Account index'), { target: { value: '12345' } });
    fireEvent.change(screen.getByLabelText('API key index'), { target: { value: '3' } });
    const privateKey = screen.getByLabelText('API private key') as HTMLInputElement;
    expect(privateKey.type).toBe('password');
    fireEvent.change(privateKey, { target: { value: PRIVATE_KEY } });
    fireEvent.change(screen.getByLabelText('API public key'), { target: { value: PUBLIC_KEY } });

    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as LighterVenueConfig;
    expect(last).toMatchObject({ accountIndex: 12345, apiKeyIndex: 3, apiKeyPrivateKey: PRIVATE_KEY, apiKeyPublicKey: PUBLIC_KEY });
    expect(hasLighterCredentials(last)).toBe(true);
    expect(screen.queryByText(/credentials incomplete/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show API private key' }));
    expect(privateKey.type).toBe('text');
  });

  it('flags malformed keys', async () => {
    render(<Harness initial={{ apiKeyPrivateKey: 'nothex', apiKeyPublicKey: 'abc' }} />);
    // Errors come from the form's asynchronous validation
    expect(await screen.findAllByText('Expected 40 bytes of hex (80 characters)')).toHaveLength(2);
  });

  it('starts the liquidation feed in shadow mode and explains the live switch', () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} showCredentials={false} showLiquidationFeed />);
    expect(screen.queryByLabelText('Account index')).not.toBeInTheDocument();
    expect(screen.getByText('Shadow mode')).toBeInTheDocument();
    expect(screen.getByText(/never trades on them/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ liquidationsLive: true }));
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByText(/at least 7 days of shadow-mode logs/)).toBeInTheDocument();
  });
});
