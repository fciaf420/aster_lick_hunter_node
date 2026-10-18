import React from 'react';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import PerSymbolPerformanceTable from '@/components/PerSymbolPerformanceTable';
import websocketService from '@/lib/services/websocketService';
import { useConfig } from '@/components/ConfigProvider';

global.fetch = jest.fn();

jest.mock('@/components/ConfigProvider', () => ({
  __esModule: true,
  default: ({ children }: any) => children,
  useConfig: jest.fn(),
}));

jest.mock('@/lib/services/websocketService', () => ({
  __esModule: true,
  default: { addMessageHandler: jest.fn(() => jest.fn()) },
}));

const symbol = (overrides: Record<string, unknown>) => ({
  symbol: 'BTCUSDT',
  tradeCount: 0,
  realizedPnl: 0,
  commission: 0,
  fundingFee: 0,
  insuranceClear: 0,
  marketMerchantReward: 0,
  apolloxRebate: 0,
  usdfReward: 0,
  netPnl: 0,
  winCount: 0,
  lossCount: 0,
  winRate: 0,
  ...overrides,
});

const symbols = [
  symbol({ symbol: 'BTCUSDT', tradeCount: 10, winCount: 7, lossCount: 3, winRate: 70, realizedPnl: 150, commission: -12.5, fundingFee: 1.25, netPnl: 138.75 }),
  symbol({ symbol: 'ETHUSDT', tradeCount: 4, winCount: 1, lossCount: 3, winRate: 25, realizedPnl: -60, commission: -4, fundingFee: -2.5, netPnl: -66.5 }),
  symbol({ symbol: 'SOLUSDT', tradeCount: 25, winCount: 15, lossCount: 10, winRate: 60, realizedPnl: 400, commission: -30, fundingFee: 0, netPnl: 370 }),
  symbol({ symbol: 'Account Rewards', tradeCount: 0, winRate: 0, realizedPnl: 0, commission: 0, fundingFee: 0, netPnl: 5.5 }),
];

const withApiKeys = (hasKeys = true) =>
  (useConfig as jest.Mock).mockReturnValue({
    config: { api: hasKeys ? { apiKey: 'k', secretKey: 's' } : { apiKey: '', secretKey: '' } },
  });

const respondWith = (payload: unknown, ok = true) =>
  (global.fetch as jest.Mock).mockResolvedValue({ ok, json: async () => payload });

/** First cell of every body row: the symbol badges in display order */
const symbolOrder = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0].textContent);

const rowFor = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
const sortBy = (name: string) => fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
const columnHeader = (name: string) => screen.getByRole('columnheader', { name: new RegExp(name) });

describe('PerSymbolPerformanceTable', () => {
  beforeEach(() => {
    (global.fetch as jest.Mock).mockReset();
    (websocketService.addMessageHandler as jest.Mock).mockReset().mockReturnValue(jest.fn());
    withApiKeys();
  });

  describe('data and formatting', () => {
    it('requests the per-symbol income for the selected range', async () => {
      respondWith({ symbols });

      render(<PerSymbolPerformanceTable timeRange="30d" />);

      await screen.findByText('BTCUSDT');
      expect(global.fetch).toHaveBeenCalledWith('/api/income/symbols?range=30d');
    });

    it('shows every column of a symbol row, formatted', async () => {
      respondWith({ symbols });
      render(<PerSymbolPerformanceTable timeRange="7d" />);
      await screen.findByText('BTCUSDT');

      expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
        'Symbol',
        'Trades',
        'Win Rate',
        'Net PnL',
        'Realized',
        'Commission',
        'Funding',
      ]);

      const cells = within(rowFor('BTCUSDT')).getAllByRole('cell');
      expect(cells.map((c) => c.textContent)).toEqual([
        'BTCUSDT',
        '107W/3L',
        '70%',
        '$138.75',
        '$150.00',
        '-$12.50',
        '$1.25',
      ]);
    });

    it('colours net PnL, commission and funding by sign and the win rate by the 50% line', async () => {
      respondWith({ symbols });
      render(<PerSymbolPerformanceTable timeRange="7d" />);
      await screen.findByText('BTCUSDT');

      const btc = within(rowFor('BTCUSDT'));
      expect(btc.getByText('$138.75')).toHaveClass('text-profit');
      expect(btc.getByText('$1.25')).toHaveClass('text-profit'); // funding received
      expect(btc.getByText('70%')).toHaveClass('border-profit', 'text-profit');
      // Commission column is always loss-coloured
      expect(btc.getByText('-$12.50').closest('td')).toHaveClass('text-loss');

      const eth = within(rowFor('ETHUSDT'));
      expect(eth.getByText('-$66.50')).toHaveClass('text-loss');
      expect(eth.getByText('-$2.50')).toHaveClass('text-loss'); // funding paid
      expect(eth.getByText('25%')).not.toHaveClass('text-profit');
    });

    it('omits the win/loss line for symbols without trades', async () => {
      respondWith({ symbols });
      render(<PerSymbolPerformanceTable timeRange="7d" />);
      await screen.findByText('Account Rewards');

      const cells = within(rowFor('Account Rewards')).getAllByRole('cell');
      expect(cells[1].textContent).toBe('0');
    });

    it('highlights the Account Rewards row and explains it in the badge title', async () => {
      respondWith({ symbols });
      render(<PerSymbolPerformanceTable timeRange="7d" />);
      await screen.findByText('Account Rewards');

      expect(rowFor('Account Rewards')).toHaveClass('bg-yellow-50/50');
      expect(screen.getByText('Account Rewards')).toHaveAttribute(
        'title',
        'Referral rebates and staking rewards (not tied to specific symbols)'
      );
      expect(rowFor('BTCUSDT')).not.toHaveClass('bg-yellow-50/50');
      expect(screen.getByText('BTCUSDT')).toHaveAttribute('title', '');
    });
  });

  describe('sorting', () => {
    beforeEach(async () => {
      respondWith({ symbols });
      render(<PerSymbolPerformanceTable timeRange="7d" />);
      await screen.findByText('BTCUSDT');
    });

    it('starts sorted by net PnL, best first', () => {
      expect(symbolOrder()).toEqual(['SOLUSDT', 'BTCUSDT', 'Account Rewards', 'ETHUSDT']);
      expect(columnHeader('Net PnL')).toHaveAttribute('aria-sort', 'descending');
    });

    it('toggles the direction of the sorted column on every click', () => {
      sortBy('Net PnL');
      expect(symbolOrder()).toEqual(['ETHUSDT', 'Account Rewards', 'BTCUSDT', 'SOLUSDT']);
      expect(columnHeader('Net PnL')).toHaveAttribute('aria-sort', 'ascending');

      sortBy('Net PnL');
      expect(symbolOrder()).toEqual(['SOLUSDT', 'BTCUSDT', 'Account Rewards', 'ETHUSDT']);
      expect(columnHeader('Net PnL')).toHaveAttribute('aria-sort', 'descending');

      // It never falls back to an unsorted state
      sortBy('Net PnL');
      expect(columnHeader('Net PnL')).toHaveAttribute('aria-sort', 'ascending');
    });

    it('sorts a newly chosen column descending first', () => {
      sortBy('Trades');
      expect(symbolOrder()).toEqual(['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'Account Rewards']);

      sortBy('Win Rate');
      expect(symbolOrder()).toEqual(['BTCUSDT', 'SOLUSDT', 'ETHUSDT', 'Account Rewards']);

      sortBy('Commission');
      expect(symbolOrder()).toEqual(['Account Rewards', 'ETHUSDT', 'BTCUSDT', 'SOLUSDT']);

      sortBy('Funding');
      expect(symbolOrder()).toEqual(['BTCUSDT', 'SOLUSDT', 'Account Rewards', 'ETHUSDT']);
    });

    it('sorts the symbol column Z to A first, then A to Z', () => {
      sortBy('Symbol');
      expect(symbolOrder()).toEqual(['SOLUSDT', 'ETHUSDT', 'BTCUSDT', 'Account Rewards']);

      sortBy('Symbol');
      expect(symbolOrder()).toEqual(['Account Rewards', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    });

    it('does not sort by the Realized column', () => {
      expect(screen.queryByRole('button', { name: /Realized/ })).not.toBeInTheDocument();
      expect(columnHeader('Realized')).not.toHaveAttribute('aria-sort');
    });
  });

  describe('states', () => {
    it('shows the loading state while the request is pending', () => {
      (global.fetch as jest.Mock).mockImplementation(() => new Promise(() => {}));

      render(<PerSymbolPerformanceTable timeRange="7d" />);

      expect(screen.getByText('Loading symbol performance...')).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('asks for API keys without calling the API', async () => {
      withApiKeys(false);

      render(<PerSymbolPerformanceTable timeRange="7d" />);

      expect(await screen.findByText('API keys required')).toBeInTheDocument();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('shows the empty state with the time range', async () => {
      respondWith({ symbols: [] });

      render(<PerSymbolPerformanceTable timeRange="90d" />);

      expect(await screen.findByText('No trading data')).toBeInTheDocument();
      expect(screen.getByText('90d period')).toBeInTheDocument();
    });

    it('treats a failed response and a network error as no data', async () => {
      respondWith({}, false);
      const { unmount } = render(<PerSymbolPerformanceTable timeRange="7d" />);
      expect(await screen.findByText('No trading data')).toBeInTheDocument();
      unmount();

      (global.fetch as jest.Mock).mockRejectedValue(new Error('offline'));
      render(<PerSymbolPerformanceTable timeRange="7d" />);
      expect(await screen.findByText('No trading data')).toBeInTheDocument();
    });
  });

  describe('real-time updates', () => {
    const lastHandler = () => {
      const calls = (websocketService.addMessageHandler as jest.Mock).mock.calls;
      return calls[calls.length - 1][0] as (message: any) => void;
    };

    it('refetches on pnl and trade updates, keeping the chosen sort', async () => {
      respondWith({ symbols });
      render(<PerSymbolPerformanceTable timeRange="7d" />);
      await screen.findByText('BTCUSDT');
      sortBy('Symbol');
      expect(symbolOrder()[0]).toBe('SOLUSDT');
      expect(global.fetch).toHaveBeenCalledTimes(1);

      respondWith({
        symbols: [
          ...symbols,
          symbol({ symbol: 'XRPUSDT', tradeCount: 2, winCount: 2, winRate: 100, netPnl: 12, realizedPnl: 13, commission: -1 }),
        ],
      });
      await act(async () => {
        lastHandler()({ type: 'trade_update' });
      });

      await screen.findByText('XRPUSDT');
      expect(global.fetch).toHaveBeenCalledTimes(2);
      // Still sorted by symbol, descending
      expect(symbolOrder()).toEqual(['XRPUSDT', 'SOLUSDT', 'ETHUSDT', 'BTCUSDT', 'Account Rewards']);

      await act(async () => {
        lastHandler()({ type: 'pnl_update' });
      });
      await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(3));
    });

    it('ignores unrelated messages and unsubscribes on unmount', async () => {
      const cleanup = jest.fn();
      (websocketService.addMessageHandler as jest.Mock).mockReturnValue(cleanup);
      respondWith({ symbols });
      const { unmount } = render(<PerSymbolPerformanceTable timeRange="7d" />);
      await screen.findByText('BTCUSDT');

      await act(async () => {
        lastHandler()({ type: 'vwap_update' });
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);

      unmount();
      expect(cleanup).toHaveBeenCalled();
    });

    it('refetches when the time range changes', async () => {
      respondWith({ symbols });
      const { rerender } = render(<PerSymbolPerformanceTable timeRange="7d" />);
      await screen.findByText('BTCUSDT');

      rerender(<PerSymbolPerformanceTable timeRange="1y" />);

      await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/income/symbols?range=1y'));
    });
  });
});
