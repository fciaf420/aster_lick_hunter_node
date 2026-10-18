import React from 'react';
import { screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import PositionTable from '@/components/PositionTable';
import dataStore from '@/lib/services/dataStore';
import websocketService from '@/lib/services/websocketService';
import { useConfig } from '@/components/ConfigProvider';
import { toast } from 'sonner';
import { showApiError, showTradingError } from '@/lib/utils/errorToast';
import { renderWithProviders } from '../utils/render-with-providers';

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

// The data store is an event emitter: keep its listeners so tests can push live updates
const mockListeners: Record<string, Array<(payload: any) => void>> = {};
jest.mock('@/lib/services/dataStore', () => ({
  __esModule: true,
  default: {
    fetchPositions: jest.fn(),
    getMarkPrices: jest.fn(() => ({})),
    handleWebSocketMessage: jest.fn(),
    on: jest.fn((event: string, handler: (payload: any) => void) => {
      (mockListeners[event] ||= []).push(handler);
    }),
    off: jest.fn((event: string, handler: (payload: any) => void) => {
      mockListeners[event] = (mockListeners[event] || []).filter((h) => h !== handler);
    }),
  },
}));

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

jest.mock('@/lib/utils/errorToast', () => ({
  showApiError: jest.fn(),
  showTradingError: jest.fn(),
}));

const LIGHTER_REFUSAL =
  'Closing Lighter positions from the dashboard is not supported: Lighter orders can only be signed by the bot process. ' +
  "Close the position on the Lighter exchange (app.lighter.xyz), or let the bot's stop loss / take profit close it.";

const btc = {
  symbol: 'BTCUSDT',
  side: 'LONG' as const,
  quantity: 0.5,
  entryPrice: 50000,
  markPrice: 51000,
  pnl: 500,
  pnlPercent: 2,
  margin: 2500,
  leverage: 10,
  liquidationPrice: 45000,
  hasStopLoss: true,
  hasTakeProfit: false,
};
const eth = {
  symbol: 'ETHUSDT',
  side: 'SHORT' as const,
  quantity: 10,
  entryPrice: 3000,
  markPrice: 3100,
  pnl: -1000,
  pnlPercent: -3.3,
  margin: 3000,
  leverage: 5,
  liquidationPrice: 3300,
  // hasStopLoss / hasTakeProfit unknown
};
const sol = {
  symbol: 'SOLUSDT',
  side: 'LONG' as const,
  quantity: 100,
  entryPrice: 100,
  markPrice: 110,
  pnl: 1000,
  pnlPercent: 10,
  margin: 1234,
  leverage: 3,
  hasStopLoss: true,
  hasTakeProfit: true,
};
const positionsFixture = [btc, eth, sol];

type FetchRoute = (url: string, init?: RequestInit) => unknown;

const mockFetch = (routes: Record<string, FetchRoute> = {}) =>
  (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
    const route = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!route) return { ok: false, json: async () => ({}) };
    const result = routes[route](url, init) as any;
    // A route may return a ready response (or a promise of one), otherwise its value is the JSON body
    if (result instanceof Promise || typeof result?.json === 'function') return result;
    return { ok: true, json: async () => result };
  });

const setConfig = (symbols: Record<string, unknown> = {}) =>
  (useConfig as jest.Mock).mockReturnValue({ config: { symbols } });

const loadPositions = (positions: unknown[]) =>
  (dataStore.fetchPositions as jest.Mock).mockResolvedValue(positions);

const emit = async (event: string, payload: unknown) => {
  await act(async () => {
    (mockListeners[event] || []).forEach((handler) => handler(payload));
  });
};

const wsHandler = () => {
  const calls = (websocketService.addMessageHandler as jest.Mock).mock.calls;
  return calls[calls.length - 1][0] as (message: any) => void;
};

const renderTable = async (props: React.ComponentProps<typeof PositionTable> = {}) => {
  const view = renderWithProviders(<PositionTable {...props} />);
  await screen.findByText('Positions');
  return view;
};

const rowFor = (symbol: string) => screen.getByRole('link', { name: symbol }).closest('tr') as HTMLElement;
const cellTexts = (row: HTMLElement) => within(row).getAllByRole('cell').map((cell) => cell.textContent);
const symbolOrder = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0].textContent?.replace(/\d+x$/, ''));
const sortBy = (name: string) => fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
const columnHeader = (name: string) => screen.getByRole('columnheader', { name: new RegExp(`^${name}`) });

describe('PositionTable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockListeners).forEach((key) => delete mockListeners[key]);
    (dataStore.getMarkPrices as jest.Mock).mockReturnValue({});
    (websocketService.addMessageHandler as jest.Mock).mockReturnValue(jest.fn());
    setConfig();
    mockFetch();
    loadPositions(positionsFixture);
  });

  describe('columns and values', () => {
    it('renders every column in the original order', async () => {
      await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });

      expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
        'Symbol',
        'Side',
        'Size',
        'Entry/Mark',
        'Liq. Price',
        'PnL',
        'Protection',
        'Actions',
      ]);
      expect(screen.getByText('3')).toBeInTheDocument(); // position count badge
    });

    it('shows symbol link, leverage, side, size, prices and PnL for a position', async () => {
      await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });

      const row = rowFor('BTCUSDT');
      expect(screen.getByRole('link', { name: 'BTCUSDT' })).toHaveAttribute(
        'href',
        'https://www.asterdex.com/en/futures/v1/BTCUSDT'
      );
      expect(screen.getByRole('link', { name: 'BTCUSDT' })).toHaveAttribute('target', '_blank');
      expect(within(row).getByText('10x')).toBeInTheDocument();
      expect(within(row).getByText('L')).toBeInTheDocument();
      // size and margin / entry and mark price / liquidation price and its distance
      expect(cellTexts(row)[2]).toBe('0.500000$2500.00');
      expect(cellTexts(row)[3]).toBe('$50,000$51,000');
      expect(cellTexts(row)[4]).toBe('$45,00011.8% away');
      expect(cellTexts(row)[5]).toBe('+$500.00+2.0%');
    });

    it('colours the side and the PnL by sign', async () => {
      await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });

      const long = within(rowFor('BTCUSDT'));
      expect(long.getByText('L').closest('[data-slot="badge"]')).toHaveClass('border-long', 'text-long');
      expect(long.getByText('+$500.00')).toHaveClass('text-profit');
      expect(long.getByText('+2.0%').closest('[data-slot="badge"]')).toHaveClass('border-profit', 'text-profit');

      const short = within(rowFor('ETHUSDT'));
      expect(short.getByText('S').closest('[data-slot="badge"]')).toHaveAttribute('data-variant', 'destructive');
      // Losses are shown without a sign, in the loss colour
      expect(short.getByText('$1000.00')).toHaveClass('text-loss');
      expect(short.getByText('-3.3%').closest('[data-slot="badge"]')).toHaveAttribute('data-variant', 'destructive');
    });

    it('warns when a position is close to liquidation and shows a dash when there is no liquidation price', async () => {
      await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });

      // BTC long: 11.8% away is "near" (orange); ETH short: 6.5% away is critical (destructive)
      const near = within(rowFor('BTCUSDT')).getByText('$45,000');
      expect(near).toHaveClass('text-orange-600');
      expect(within(rowFor('BTCUSDT')).getByText('11.8% away')).toBeInTheDocument();

      const critical = within(rowFor('ETHUSDT')).getByText('$3,300.00');
      expect(critical).toHaveClass('text-destructive');
      expect(within(rowFor('ETHUSDT')).getByText('6.5% away')).toBeInTheDocument();

      expect(within(rowFor('SOLUSDT')).getByText('—')).toBeInTheDocument();
    });
  });

  describe('protection', () => {
    const openProtection = (symbol: string) => {
      const trigger = rowFor(symbol).querySelector('.lucide-shield')!.closest('div.flex.gap-0\\.5') as HTMLElement;
      fireEvent.focus(trigger);
    };

    it('shows the stop loss, take profit and VWAP states as badges', async () => {
      setConfig({ BTCUSDT: { vwapProtection: true }, SOLUSDT: { vwapProtection: true } });
      mockFetch({ '/api/vwap/BTCUSDT': () => ({ value: 50500, position: 'below', timestamp: 1 }) });
      await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });
      await screen.findByText('V:$50500');

      const btcRow = within(rowFor('BTCUSDT'));
      // Stop loss active, take profit missing, VWAP favourable for a long below VWAP
      expect(rowFor('BTCUSDT').querySelector('.lucide-shield')).toHaveClass('text-profit');
      expect(rowFor('BTCUSDT').querySelector('.lucide-target')).toHaveClass('text-muted-foreground');
      expect(rowFor('BTCUSDT').querySelector('.lucide-chart-column')).toHaveClass('text-profit');
      expect(btcRow.getByText('V:$50500')).toBeInTheDocument();

      // SOL has VWAP protection but no VWAP value yet: a pulsing placeholder
      expect(rowFor('SOLUSDT').querySelector('.lucide-chart-column')).toHaveClass('animate-pulse');
      // ETH has no VWAP protection configured at all
      expect(rowFor('ETHUSDT').querySelector('.lucide-chart-column')).toBeNull();
    });

    it('explains the states in a tooltip, including unknown stop loss and take profit', async () => {
      setConfig({ BTCUSDT: { vwapProtection: true } });
      mockFetch({ '/api/vwap/BTCUSDT': () => ({ value: 50500, position: 'below', timestamp: 1 }) });
      await renderTable();
      await screen.findByText('V:$50500');

      openProtection('BTCUSDT');
      expect((await screen.findAllByText('Stop Loss: ✅ Active')).length).toBeGreaterThan(0);
      expect(screen.getAllByText('Take Profit: ❌ Inactive').length).toBeGreaterThan(0);
      expect(screen.getAllByText('VWAP: $50500').length).toBeGreaterThan(0);
      expect(screen.getAllByText('✅ Long below VWAP (Good)').length).toBeGreaterThan(0);
    });

    it('marks stop loss and take profit as unknown when the exchange does not report them', async () => {
      await renderTable();
      await screen.findByRole('link', { name: 'ETHUSDT' });

      openProtection('ETHUSDT');

      expect((await screen.findAllByText('Stop Loss: ❔ Unknown (managed by the bot)')).length).toBeGreaterThan(0);
      expect(screen.getAllByText('Take Profit: ❔ Unknown (managed by the bot)').length).toBeGreaterThan(0);
    });

    it('turns the VWAP badge orange when a live VWAP update makes the entry unfavourable', async () => {
      setConfig({ BTCUSDT: { vwapProtection: true } });
      mockFetch({ '/api/vwap/BTCUSDT': () => ({ value: 50500, position: 'below', timestamp: 1 }) });
      await renderTable();
      await screen.findByText('V:$50500');
      expect(rowFor('BTCUSDT').querySelector('.lucide-chart-column')).toHaveClass('text-profit');

      await act(async () => {
        wsHandler()({ type: 'vwap_update', data: { symbol: 'BTCUSDT', vwap: 52000, position: 'above', timestamp: 2 } });
      });

      expect(await screen.findByText('V:$52000')).toBeInTheDocument();
      expect(rowFor('BTCUSDT').querySelector('.lucide-chart-column')).toHaveClass('text-orange-600');
    });
  });

  describe('sorting', () => {
    it('keeps the order the data store delivers until a header is clicked', async () => {
      await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });

      expect(symbolOrder()).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    });

    it('sorts by PnL (best first), then worst first, then back to the original order', async () => {
      await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });

      sortBy('PnL');
      expect(symbolOrder()).toEqual(['SOLUSDT', 'BTCUSDT', 'ETHUSDT']);
      expect(columnHeader('PnL')).toHaveAttribute('aria-sort', 'descending');

      sortBy('PnL');
      expect(symbolOrder()).toEqual(['ETHUSDT', 'BTCUSDT', 'SOLUSDT']);

      sortBy('PnL');
      expect(symbolOrder()).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    });

    it('sorts by symbol, side and size', async () => {
      await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });

      sortBy('Symbol');
      expect(symbolOrder()).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
      sortBy('Symbol');
      expect(symbolOrder()).toEqual(['SOLUSDT', 'ETHUSDT', 'BTCUSDT']);

      sortBy('Side');
      expect(symbolOrder()).toEqual(['BTCUSDT', 'SOLUSDT', 'ETHUSDT']); // LONG, LONG, SHORT

      sortBy('Size');
      expect(symbolOrder()).toEqual(['SOLUSDT', 'ETHUSDT', 'BTCUSDT']); // 100, 10, 0.5
    });

    it('does not offer sorting on the price, protection and action columns', async () => {
      await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });

      ['Entry/Mark', 'Liq. Price', 'Protection', 'Actions'].forEach((name) => {
        expect(screen.queryByRole('button', { name: new RegExp(`^${name}`) })).not.toBeInTheDocument();
      });
    });
  });

  describe('real-time updates', () => {
    it('recalculates PnL from live mark prices and re-sorts accordingly', async () => {
      await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });
      sortBy('PnL');
      expect(symbolOrder()).toEqual(['SOLUSDT', 'BTCUSDT', 'ETHUSDT']);

      // BTC mark 53000: (53000 - 50000) * 0.5 = +1500 (+6.0% of the 25000 notional)
      await emit('markPrices:update', { BTCUSDT: 53000 });

      const row = rowFor('BTCUSDT');
      expect(cellTexts(row)[3]).toBe('$50,000$53,000');
      expect(cellTexts(row)[5]).toBe('+$1500.00+6.0%');
      expect(symbolOrder()).toEqual(['BTCUSDT', 'SOLUSDT', 'ETHUSDT']);
    });

    it('computes short PnL in the opposite direction', async () => {
      await renderTable();
      await screen.findByRole('link', { name: 'ETHUSDT' });

      // ETH short, mark falls to 2900: (3000 - 2900) * 10 = +1000 (+3.3%)
      await emit('markPrices:update', { ETHUSDT: 2900 });

      const eth = within(rowFor('ETHUSDT'));
      expect(eth.getByText('+$1000.00')).toHaveClass('text-profit');
      expect(eth.getByText('+3.3%')).toBeInTheDocument();
    });

    it('starts from the mark prices the data store already has', async () => {
      (dataStore.getMarkPrices as jest.Mock).mockReturnValue({ SOLUSDT: 90 });
      await renderTable();
      await screen.findByRole('link', { name: 'SOLUSDT' });

      // SOL long, mark 90: (90 - 100) * 100 = -1000
      expect(within(rowFor('SOLUSDT')).getByText('$1000.00')).toHaveClass('text-loss');
    });

    it('replaces the rows when the positions update', async () => {
      await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });

      await emit('positions:update', [{ ...eth, pnl: -250 }, { ...sol, symbol: 'XRPUSDT' }]);

      expect(screen.queryByRole('link', { name: 'BTCUSDT' })).not.toBeInTheDocument();
      expect(symbolOrder()).toEqual(['ETHUSDT', 'XRPUSDT']);
      expect(within(rowFor('ETHUSDT')).getByText('$250.00')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
    });

    it('forwards websocket messages to the data store and unsubscribes on unmount', async () => {
      const cleanup = jest.fn();
      (websocketService.addMessageHandler as jest.Mock).mockReturnValue(cleanup);
      const { unmount } = await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });

      const message = { type: 'position_update', data: [] };
      wsHandler()(message);
      expect(dataStore.handleWebSocketMessage).toHaveBeenCalledWith(message);

      unmount();
      expect(cleanup).toHaveBeenCalled();
      expect(dataStore.off).toHaveBeenCalledWith('positions:update', expect.any(Function));
      expect(dataStore.off).toHaveBeenCalledWith('markPrices:update', expect.any(Function));
    });

    it('uses positions passed as props instead of loading them', async () => {
      await renderTable({ positions: [sol] });

      expect(await screen.findByRole('link', { name: 'SOLUSDT' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'BTCUSDT' })).not.toBeInTheDocument();
      expect(dataStore.fetchPositions).not.toHaveBeenCalled();
    });
  });

  describe('loading, empty and collapsed states', () => {
    it('shows placeholder rows under the header while positions load', async () => {
      (dataStore.fetchPositions as jest.Mock).mockImplementation(() => new Promise(() => {}));

      renderWithProviders(<PositionTable />);

      expect(screen.getAllByRole('columnheader')).toHaveLength(8);
      const rows = screen.getAllByRole('row').slice(1);
      expect(rows).toHaveLength(3);
      expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(24);
      expect(screen.queryByText('No open positions')).not.toBeInTheDocument();
    });

    it('shows the empty state when there are no positions', async () => {
      loadPositions([]);

      await renderTable();

      expect(await screen.findByText('No open positions')).toBeInTheDocument();
      expect(screen.getByText('Waiting for trades')).toBeInTheDocument();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });

    describe('when loading positions fails', () => {
      const OUTAGE = "Couldn't load positions — retrying";

      it('shows a distinct outage state with the error muted, not the "no open positions" state', async () => {
        (dataStore.fetchPositions as jest.Mock).mockRejectedValue(new Error('Positions API failed: 502'));

        await renderTable();

        expect(await screen.findByText(OUTAGE)).toBeInTheDocument();
        expect(screen.getByText('Positions API failed: 502')).toHaveClass('text-muted-foreground');
        expect(screen.getByRole('alert')).toHaveTextContent(OUTAGE);
        expect(screen.queryByText('No open positions')).not.toBeInTheDocument();
        expect(screen.queryByText('Waiting for trades')).not.toBeInTheDocument();
        // The placeholder rows are gone and the outage fills one full-width row
        expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
        expect(screen.getByText(OUTAGE).closest('td')).toHaveAttribute('colspan', '8');
      });

      it('shows the rejection as text when it is not an Error', async () => {
        (dataStore.fetchPositions as jest.Mock).mockRejectedValue('network down');

        await renderTable();

        expect(await screen.findByText('network down')).toBeInTheDocument();
      });

      it('recovers when the next positions update arrives', async () => {
        (dataStore.fetchPositions as jest.Mock).mockRejectedValue(new Error('boom'));
        await renderTable();
        await screen.findByText(OUTAGE);

        await emit('positions:update', [btc]);

        expect(await screen.findByRole('link', { name: 'BTCUSDT' })).toBeInTheDocument();
        expect(screen.queryByText(OUTAGE)).not.toBeInTheDocument();
        expect(screen.queryByText('boom')).not.toBeInTheDocument();
      });

      it('returns to the plain empty state when the recovering update has no positions', async () => {
        (dataStore.fetchPositions as jest.Mock).mockRejectedValue(new Error('boom'));
        await renderTable();
        await screen.findByText(OUTAGE);

        await emit('positions:update', []);

        expect(await screen.findByText('No open positions')).toBeInTheDocument();
        expect(screen.queryByText(OUTAGE)).not.toBeInTheDocument();
      });

      it('also shows the outage when a later refresh fails while no position is open', async () => {
        loadPositions([]);
        await renderTable();
        await screen.findByText('No open positions');

        await emit('positions:error', 'Positions API failed: 500');

        expect(screen.getByText(OUTAGE)).toBeInTheDocument();
        expect(screen.getByText('Positions API failed: 500')).toBeInTheDocument();
        expect(screen.queryByText('No open positions')).not.toBeInTheDocument();

        await emit('positions:update', []);
        expect(screen.getByText('No open positions')).toBeInTheDocument();
        expect(screen.queryByText(OUTAGE)).not.toBeInTheDocument();
      });

      it('clears the error when a later fetch succeeds', async () => {
        mockFetch({ '/api/positions/': () => ({ success: true }) });
        await renderTable();
        await screen.findByRole('link', { name: 'BTCUSDT' });
        // A failed refresh keeps the last known positions on screen...
        await emit('positions:error', 'Positions API failed: 500');
        expect(screen.getByRole('link', { name: 'BTCUSDT' })).toBeInTheDocument();
        expect(screen.queryByText(OUTAGE)).not.toBeInTheDocument();

        // ...and the next successful fetch (here the refresh after a close) must not leave the error behind
        loadPositions([]);
        fireEvent.click(within(rowFor('BTCUSDT')).getByRole('button', { name: /Close/ }));
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close Position' }));

        expect(await screen.findByText('No open positions')).toBeInTheDocument();
        expect(screen.queryByText(OUTAGE)).not.toBeInTheDocument();
      });

      it('unsubscribes from the error event on unmount', async () => {
        const { unmount } = await renderTable();
        await screen.findByRole('link', { name: 'BTCUSDT' });

        unmount();

        expect(dataStore.off).toHaveBeenCalledWith('positions:error', expect.any(Function));
      });
    });

    it('collapses and expands the table from the title', async () => {
      await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });

      fireEvent.click(screen.getByRole('button', { name: /Positions/ }));
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Positions/ }));
      expect(screen.getByRole('table')).toBeInTheDocument();
    });
  });

  describe('closing a position', () => {
    const closeButton = (symbol: string) => within(rowFor(symbol)).getByRole('button', { name: /Close/ });
    const dialog = () => screen.getByRole('dialog');

    it('opens a confirmation for the clicked row without calling the API', async () => {
      await renderTable();
      await screen.findByRole('link', { name: 'ETHUSDT' });

      fireEvent.click(closeButton('ETHUSDT'));

      const confirm = within(dialog());
      expect(confirm.getByText('Close Position', { selector: '[data-slot="dialog-title"]' })).toBeInTheDocument();
      expect(confirm.getByText('ETHUSDT')).toBeInTheDocument();
      expect(confirm.getByText('SHORT')).toBeInTheDocument();
      expect(confirm.getByText('10.0000')).toBeInTheDocument();
      expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining('/close'), expect.anything());
    });

    it('closes the dialog on Cancel and never sends the close request', async () => {
      await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });
      fireEvent.click(closeButton('BTCUSDT'));

      fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining('/close'), expect.anything());
    });

    it('sends the close request for the confirmed position, reports success and refreshes the positions', async () => {
      mockFetch({ '/api/positions/': () => ({ success: true }) });
      await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });
      (dataStore.fetchPositions as jest.Mock).mockClear();
      loadPositions([eth, sol]); // BTC is gone after the close

      fireEvent.click(closeButton('BTCUSDT'));
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Close Position' }));

      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(global.fetch).toHaveBeenCalledWith('/api/positions/BTCUSDT/LONG/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(toast.success).toHaveBeenCalledWith('Successfully closed BTCUSDT LONG position', {
        description: 'Closed 0.500000 contracts',
        duration: 5000,
      });
      expect(dataStore.fetchPositions).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(screen.queryByRole('link', { name: 'BTCUSDT' })).not.toBeInTheDocument());
      expect(screen.getByRole('link', { name: 'ETHUSDT' })).toBeInTheDocument();
      expect(showTradingError).not.toHaveBeenCalled();
    });

    it('closes the right position after the rows were re-sorted', async () => {
      mockFetch({ '/api/positions/': () => ({ success: true }) });
      await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });

      sortBy('PnL'); // SOL, BTC, ETH
      const firstRow = screen.getAllByRole('row')[1];
      fireEvent.click(within(firstRow).getByRole('button', { name: /Close/ }));
      expect(within(dialog()).getByText('SOLUSDT')).toBeInTheDocument();
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Close Position' }));

      await waitFor(() =>
        expect(global.fetch).toHaveBeenCalledWith('/api/positions/SOLUSDT/LONG/close', expect.anything())
      );
    });

    it('shows a pending state and blocks the dialog buttons while closing', async () => {
      let finish: (value: unknown) => void = () => {};
      mockFetch({
        '/api/positions/': () => new Promise((resolve) => (finish = resolve)),
      });
      await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });
      fireEvent.click(closeButton('BTCUSDT'));

      fireEvent.click(within(dialog()).getByRole('button', { name: 'Close Position' }));

      const closing = await within(dialog()).findByRole('button', { name: 'Closing...' });
      expect(closing).toBeDisabled();
      expect(within(dialog()).getByRole('button', { name: 'Cancel' })).toBeDisabled();

      await act(async () => {
        finish({ ok: true, json: async () => ({ success: false, error: 'rejected' }) });
      });
      await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'Close Position' })).toBeEnabled());
    });

    it('surfaces the refusal when the dashboard cannot close a Lighter position and keeps the position', async () => {
      mockFetch({
        '/api/positions/': () => ({
          ok: false,
          status: 400,
          json: async () => ({ error: LIGHTER_REFUSAL, success: false, venue: 'lighter' }),
        }),
      });
      await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });
      (dataStore.fetchPositions as jest.Mock).mockClear();
      fireEvent.click(closeButton('BTCUSDT'));

      fireEvent.click(within(dialog()).getByRole('button', { name: 'Close Position' }));

      await waitFor(() => expect(showTradingError).toHaveBeenCalled());
      expect(showTradingError).toHaveBeenCalledWith('Failed to close position', LIGHTER_REFUSAL, {
        symbol: 'BTCUSDT',
        component: 'PositionTable',
        rawError: { error: LIGHTER_REFUSAL, success: false, venue: 'lighter' },
      });
      // Nothing was closed: no success toast, no refresh, the dialog and the row stay
      expect(toast.success).not.toHaveBeenCalled();
      expect(dataStore.fetchPositions).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      // (the page behind the open dialog is hidden from the accessibility tree)
      expect(screen.getByRole('link', { name: 'BTCUSDT', hidden: true })).toBeInTheDocument();
      expect(within(dialog()).getByRole('button', { name: 'Close Position' })).toBeEnabled();
    });

    it('reports an unknown error when the refusal carries no message', async () => {
      mockFetch({ '/api/positions/': () => ({ success: false }) });
      await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });
      fireEvent.click(closeButton('BTCUSDT'));

      fireEvent.click(within(dialog()).getByRole('button', { name: 'Close Position' }));

      await waitFor(() =>
        expect(showTradingError).toHaveBeenCalledWith(
          'Failed to close position',
          'An unknown error occurred',
          expect.objectContaining({ symbol: 'BTCUSDT' })
        )
      );
    });

    it('reports a network error and keeps the dialog open', async () => {
      (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
        if (url.includes('/close')) throw new Error('connection refused');
        return { ok: false, json: async () => ({}) };
      });
      await renderTable();
      await screen.findByRole('link', { name: 'BTCUSDT' });
      fireEvent.click(closeButton('BTCUSDT'));

      fireEvent.click(within(dialog()).getByRole('button', { name: 'Close Position' }));

      await waitFor(() => expect(showApiError).toHaveBeenCalled());
      expect(showApiError).toHaveBeenCalledWith(
        'Network error',
        'Failed to connect to the server',
        expect.objectContaining({ symbol: 'BTCUSDT', component: 'PositionTable' })
      );
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  describe('hedge mode (one symbol held long and short)', () => {
    const hedgeLong = {
      symbol: 'BTCUSDT',
      side: 'LONG' as const,
      quantity: 0.5,
      entryPrice: 50000,
      markPrice: 51000,
      pnl: 500,
      pnlPercent: 2,
      margin: 2500,
      leverage: 10,
    };
    const hedgeShort = {
      symbol: 'BTCUSDT',
      side: 'SHORT' as const,
      quantity: 0.2,
      entryPrice: 52000,
      markPrice: 51000,
      pnl: 200,
      pnlPercent: 1.9,
      margin: 1000,
      leverage: 10,
    };

    const bodyRows = () => screen.getAllByRole('row').slice(1);
    const sides = () => bodyRows().map((row) => within(row).getAllByRole('cell')[1].textContent);
    const rowOfSide = (side: 'L' | 'S') => bodyRows().find((row) => within(row).queryByText(side)) as HTMLElement;

    beforeEach(() => {
      loadPositions([hedgeLong, hedgeShort]);
    });

    it('keeps the long and short rows of the same symbol distinct', async () => {
      const errorSpy = jest.spyOn(console, 'error');
      try {
        await renderTable();
        await screen.findAllByRole('link', { name: 'BTCUSDT' });

        // Rows are keyed symbol-side: one symbol on two rows must not collapse or warn about duplicate keys
        expect(sides()).toEqual(['L', 'S']);
        expect(screen.getByText('2')).toBeInTheDocument(); // position count badge
        sortBy('PnL');
        sortBy('PnL');
        expect(sides()).toEqual(['S', 'L']);
        expect(errorSpy.mock.calls.filter(([message]) => String(message).includes('same key'))).toEqual([]);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('prices each side from the shared mark price, in the right colour', async () => {
      await renderTable();
      await screen.findAllByRole('link', { name: 'BTCUSDT' });

      // Mark 49000: the long loses (49000 - 50000) * 0.5 = -500, the short wins (52000 - 49000) * 0.2 = +600
      await emit('markPrices:update', { BTCUSDT: 49000 });

      const long = within(rowOfSide('L'));
      expect(long.getByText('$500.00')).toHaveClass('text-loss');
      expect(long.getByText('-2.0%').closest('[data-slot="badge"]')).toHaveAttribute('data-variant', 'destructive');
      expect(long.queryByText('+$500.00')).not.toBeInTheDocument();

      const short = within(rowOfSide('S'));
      expect(short.getByText('+$600.00')).toHaveClass('text-profit');
      expect(short.getByText('+5.8%').closest('[data-slot="badge"]')).toHaveClass('border-profit', 'text-profit');
      expect(short.queryByText('$600.00')).not.toBeInTheDocument();
    });

    it('closes the right side after sorting by PnL', async () => {
      mockFetch({ '/api/positions/': () => ({ success: true }) });
      await renderTable();
      await screen.findAllByRole('link', { name: 'BTCUSDT' });
      await emit('markPrices:update', { BTCUSDT: 49000 });
      const closeUrls = () =>
        (global.fetch as jest.Mock).mock.calls.map(([url]) => url).filter((url) => String(url).includes('/close'));

      sortBy('PnL'); // best first: the short (+600), then the long (-500)
      expect(sides()).toEqual(['S', 'L']);
      fireEvent.click(within(bodyRows()[0]).getByRole('button', { name: /Close/ }));
      expect(within(screen.getByRole('dialog')).getByText('SHORT')).toBeInTheDocument();
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close Position' }));
      await waitFor(() => expect(closeUrls()).toEqual(['/api/positions/BTCUSDT/SHORT/close']));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

      sortBy('PnL'); // worst first: the long on top
      expect(sides()).toEqual(['L', 'S']);
      fireEvent.click(within(bodyRows()[0]).getByRole('button', { name: /Close/ }));
      expect(within(screen.getByRole('dialog')).getByText('LONG')).toBeInTheDocument();
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close Position' }));
      await waitFor(() =>
        expect(closeUrls()).toEqual(['/api/positions/BTCUSDT/SHORT/close', '/api/positions/BTCUSDT/LONG/close'])
      );
    });
  });
});
