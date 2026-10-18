import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { VenueSelector } from '@/components/VenueSelector';

describe('VenueSelector', () => {
  it('shows no beta warning for Aster', () => {
    render(
      <VenueSelector venue="aster" onVenueChange={jest.fn()} liquidationSource="aster" onLiquidationSourceChange={jest.fn()} />
    );
    expect(screen.getAllByText('Aster').length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
  });

  it('marks Lighter as beta and warns that it is untested with live funds and defaults to testnet', () => {
    render(
      <VenueSelector venue="lighter" onVenueChange={jest.fn()} liquidationSource="aster" onLiquidationSourceChange={jest.fn()} />
    );
    expect(screen.getByText('Beta')).toBeInTheDocument();
    const warning = screen.getByRole('alert');
    expect(warning).toHaveTextContent('Lighter is in beta');
    expect(warning).toHaveTextContent('untested with live funds');
    expect(warning).toHaveTextContent('testnet');
    expect(screen.getByText(/USDC collateral/)).toBeInTheDocument();
    expect(screen.getByText(/Robinhood stays disabled/)).toBeInTheDocument();
  });

  it('warns when the Lighter liquidation feed is selected', () => {
    render(
      <VenueSelector venue="aster" onVenueChange={jest.fn()} liquidationSource="lighter" onLiquidationSourceChange={jest.fn()} />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Lighter liquidations is in beta');
  });

  it('lets beta venues be selected and keeps coming-soon venues disabled', async () => {
    const onVenueChange = jest.fn();
    const { container } = render(
      <VenueSelector venue="aster" onVenueChange={onVenueChange} showLiquidationSource={false} />
    );
    fireEvent.click(container.querySelector('#tradingVenue')!);
    const lighter = await screen.findByRole('option', { name: /Lighter/ });
    const hyperliquid = screen.getByRole('option', { name: /Hyperliquid/ });
    expect(within(lighter).getByText('Beta')).toBeInTheDocument();
    expect(lighter).not.toHaveAttribute('data-disabled');
    expect(hyperliquid).toHaveAttribute('data-disabled');
    expect(within(hyperliquid).getByText('Coming soon')).toBeInTheDocument();

    fireEvent.click(lighter);
    expect(onVenueChange).toHaveBeenCalledWith('lighter');
  });
});
