import React from 'react';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import RecentOrdersTable from '@/components/RecentOrdersTable';
import orderStore from '@/lib/services/orderStore';
import websocketService from '@/lib/services/websocketService';
import { Order, OrderSide, OrderStatus, OrderType, TimeInForce } from '@/lib/types/order';

jest.mock('@/components/ConfigProvider', () => ({
  __esModule: true,
  default: ({ children }: any) => children,
  useConfig: jest.fn(() => ({ config: {} })),
}));

jest.mock('@/lib/services/websocketService', () => ({
  __esModule: true,
  default: { addMessageHandler: jest.fn(() => jest.fn()) },
}));

// The order store is an event emitter: keep its listeners so tests can push live updates
const mockListeners: Record<string, Array<(payload: any) => void>> = {};
jest.mock('@/lib/services/orderStore', () => ({
  __esModule: true,
  default: {
    setFilters: jest.fn(),
    fetchOrders: jest.fn(),
    getFilteredOrders: jest.fn(() => []),
    handleWebSocketMessage: jest.fn(),
    on: jest.fn((event: string, handler: (payload: any) => void) => {
      (mockListeners[event] ||= []).push(handler);
    }),
    off: jest.fn((event: string, handler: (payload: any) => void) => {
      mockListeners[event] = (mockListeners[event] || []).filter((h) => h !== handler);
    }),
  },
}));

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let nextOrderId = 1;
const order = (overrides: Partial<Order> = {}): Order => ({
  symbol: 'BTCUSDT',
  orderId: nextOrderId++,
  price: '100',
  origQty: '1',
  executedQty: '1',
  status: OrderStatus.FILLED,
  timeInForce: TimeInForce.GTC,
  type: OrderType.MARKET,
  side: OrderSide.BUY,
  time: Date.now(),
  updateTime: Date.now(),
  ...overrides,
});

const showOrders = (orders: Order[]) => {
  (orderStore.fetchOrders as jest.Mock).mockResolvedValue(orders);
  (orderStore.getFilteredOrders as jest.Mock).mockReturnValue(orders);
};

const renderTable = async (orders: Order[] = []) => {
  showOrders(orders);
  const view = render(<RecentOrdersTable />);
  await waitFor(() => expect(orderStore.fetchOrders).toHaveBeenCalled());
  if (orders.length > 0) await screen.findByRole('table');
  return view;
};

const emit = async (event: string, payload: unknown) => {
  await act(async () => {
    (mockListeners[event] || []).forEach((handler) => handler(payload));
  });
};

const bodyRows = () => screen.getAllByRole('row').slice(1);
const cells = (row: HTMLElement) => within(row).getAllByRole('cell');
const symbolOrder = () => bodyRows().map((row) => cells(row)[1].textContent);
const sortBy = (name: string) => fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
const columnHeader = (name: string) => screen.getByRole('columnheader', { name: new RegExp(`^${name}`) });

/** Orders AAA..LLL (12 of them) with a distinct price, quantity and pnl, delivered unsorted */
const letters = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH', 'III', 'JJJ', 'KKK', 'LLL'];
const twelveOrders = () =>
  letters.map((name, i) =>
    order({
      symbol: `${name}USDT`,
      price: String(500 - i * 10), // AAA 500 ... LLL 390
      origQty: String(2 + i),
      executedQty: String(1 + i),
      updateTime: Date.now() - i * MINUTE, // AAA is the newest
      realizedProfit: i % 3 === 0 ? undefined : String((i % 2 === 0 ? 1 : -1) * i),
    })
  );

describe('RecentOrdersTable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    nextOrderId = 1;
    Object.keys(mockListeners).forEach((key) => delete mockListeners[key]);
    (websocketService.addMessageHandler as jest.Mock).mockReturnValue(jest.fn());
    (orderStore.getFilteredOrders as jest.Mock).mockReturnValue([]);
    (orderStore.fetchOrders as jest.Mock).mockResolvedValue([]);
  });

  describe('loading orders', () => {
    it('asks the store for the 50 latest filled orders on mount', async () => {
      await renderTable([order()]);

      expect(orderStore.setFilters).toHaveBeenCalledWith({ status: 'FILLED', symbol: undefined, limit: 50 });
      expect(orderStore.fetchOrders).toHaveBeenCalledWith(false);
    });

    it('shows placeholder rows while the first load is pending', () => {
      (orderStore.fetchOrders as jest.Mock).mockImplementation(() => new Promise(() => {}));

      render(<RecentOrdersTable />);

      expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(5);
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('shows an error message when loading fails', async () => {
      (orderStore.fetchOrders as jest.Mock).mockRejectedValue(new Error('boom'));

      render(<RecentOrdersTable />);

      expect(await screen.findByText('Failed to load orders')).toBeInTheDocument();
    });

    it('shows the empty state when there are no orders', async () => {
      await renderTable([]);

      expect(await screen.findByText('No orders found')).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('reloads from the exchange when the refresh button is pressed', async () => {
      await renderTable([order()]);
      (orderStore.fetchOrders as jest.Mock).mockClear();

      fireEvent.click(document.querySelector('.lucide-refresh-cw')!.closest('button')!);

      await waitFor(() => expect(orderStore.fetchOrders).toHaveBeenCalledWith(true));
    });
  });

  describe('columns and values', () => {
    it('renders every column in the original order', async () => {
      await renderTable([order()]);

      expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
        'Time',
        'Symbol',
        'Action',
        'Type',
        'Side',
        'Price',
        'Quantity',
        'Filled',
        'Status',
        'PnL',
      ]);
    });

    it('formats a filled order across the row', async () => {
      await renderTable([
        order({
          symbol: 'ETHUSDT',
          type: OrderType.LIMIT,
          side: OrderSide.SELL,
          price: '3000',
          avgPrice: '3012.456',
          origQty: '2.5',
          executedQty: '2.5',
          realizedProfit: '12.3',
          updateTime: Date.now() - 2 * MINUTE,
        }),
      ]);

      const row = cells(bodyRows()[0]);
      expect(row.map((cell) => cell.textContent)).toEqual([
        '2m ago',
        'ETH', // USDT suffix is dropped
        'OPEN',
        'LIMIT',
        'SELL',
        '3012.46', // average fill price wins over the limit price
        '2.500',
        '2.500',
        'Filled',
        '+$12.30',
      ]);
      expect(within(row[10 - 1]).getByText('+$12.30')).toHaveClass('text-profit');
    });

    it('formats relative times and falls back to a date after a week', async () => {
      const old = Date.now() - 10 * DAY;
      await renderTable([
        order({ symbol: 'AAAUSDT', updateTime: Date.now() }),
        order({ symbol: 'BBBUSDT', updateTime: Date.now() - 5 * HOUR }),
        order({ symbol: 'CCCUSDT', updateTime: Date.now() - 3 * DAY }),
        order({ symbol: 'DDDUSDT', updateTime: old }),
      ]);

      expect(bodyRows().map((row) => cells(row)[0].textContent)).toEqual([
        'Just now',
        '5h ago',
        '3d ago',
        new Date(old).toLocaleDateString(),
      ]);
    });

    it('keeps orders from different symbols that share an orderId as separate rows', async () => {
      const errorSpy = jest.spyOn(console, 'error');
      try {
        // The order store dedupes on symbol + orderId, so two symbols can legitimately reuse an orderId
        await renderTable([
          order({ symbol: 'BTCUSDT', orderId: 77, price: '100' }),
          order({ symbol: 'ETHUSDT', orderId: 77, price: '300' }),
          order({ symbol: 'SOLUSDT', orderId: 78, price: '200' }),
        ]);

        expect(symbolOrder()).toEqual(['BTC', 'ETH', 'SOL']);
        sortBy('Price');
        expect(symbolOrder()).toEqual(['ETH', 'SOL', 'BTC']);
        sortBy('Price');
        expect(symbolOrder()).toEqual(['BTC', 'SOL', 'ETH']);

        const duplicateKeyWarnings = errorSpy.mock.calls.filter(([message]) => String(message).includes('same key'));
        expect(duplicateKeyWarnings).toEqual([]);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('scales price and quantity precision to the magnitude and dashes missing values', async () => {
      await renderTable([
        order({ symbol: 'AAAUSDT', price: '0.00001234', origQty: '0.0004', executedQty: '0' }),
        order({ symbol: 'BBBUSDT', price: '0.5', origQty: '0.25', executedQty: '0.25' }),
        order({ symbol: 'CCCUSDT', price: '0', avgPrice: '0', origQty: '12.34567', executedQty: '12.34567' }),
      ]);

      const rows = bodyRows().map((row) => cells(row).map((c) => c.textContent));
      expect([rows[0][5], rows[0][6], rows[0][7]]).toEqual(['0.000012', '0.000400', '-']);
      expect([rows[1][5], rows[1][6], rows[1][7]]).toEqual(['0.5000', '0.2500', '0.2500']);
      expect([rows[2][5], rows[2][6], rows[2][7]]).toEqual(['-', '12.346', '12.346']);
    });

    it('colours the side and the PnL sign, and leaves PnL blank when there is none', async () => {
      await renderTable([
        order({ symbol: 'AAAUSDT', side: OrderSide.BUY, realizedProfit: '4.5' }),
        order({ symbol: 'BBBUSDT', side: OrderSide.SELL, realizedProfit: '-3' }),
        order({ symbol: 'CCCUSDT', realizedProfit: '0' }),
        order({ symbol: 'DDDUSDT' }),
      ]);

      const [win, loss, zero, none] = bodyRows();
      expect(within(win).getByText('BUY').closest('[data-slot="badge"]')).toHaveClass('text-long');
      expect(within(win).getByText('+$4.50')).toHaveClass('text-profit');
      expect(within(loss).getByText('SELL').closest('[data-slot="badge"]')).toHaveClass('text-short');
      expect(within(loss).getByText('-$3.00')).toHaveClass('text-loss');
      expect(cells(zero)[9].textContent).toBe('');
      expect(cells(none)[9].textContent).toBe('');
    });

    it('labels the position action of each order', async () => {
      await renderTable([
        order({ symbol: 'AAAUSDT' }),
        order({ symbol: 'BBBUSDT', reduceOnly: true, type: OrderType.STOP_MARKET }),
        order({ symbol: 'CCCUSDT', reduceOnly: true, type: OrderType.TAKE_PROFIT_MARKET }),
        order({ symbol: 'DDDUSDT', reduceOnly: true, type: OrderType.MARKET }),
        order({ symbol: 'EEEUSDT', closePosition: true, type: OrderType.STOP_MARKET }),
      ]);

      expect(bodyRows().map((row) => cells(row)[2].textContent)).toEqual([
        'OPEN',
        'STOP LOSS',
        'TAKE PROFIT',
        'REDUCE',
        'CLOSE ALL',
      ]);
      expect(within(bodyRows()[1]).getByText('STOP LOSS')).toHaveClass('text-loss');
      expect(within(bodyRows()[2]).getByText('TAKE PROFIT')).toHaveClass('text-profit');
      expect(cells(bodyRows()[1])[3].textContent).toBe('STOP MARKET');
    });

    it('labels and colours each order status', async () => {
      await renderTable([
        order({ symbol: 'AAAUSDT', status: OrderStatus.FILLED }),
        order({ symbol: 'BBBUSDT', status: OrderStatus.NEW }),
        order({ symbol: 'CCCUSDT', status: OrderStatus.PARTIALLY_FILLED }),
        order({ symbol: 'DDDUSDT', status: OrderStatus.CANCELED }),
        order({ symbol: 'EEEUSDT', status: OrderStatus.EXPIRED }),
        order({ symbol: 'FFFUSDT', status: OrderStatus.REJECTED }),
      ]);

      const statuses = bodyRows().map((row) => cells(row)[8]);
      expect(statuses.map((cell) => cell.textContent)).toEqual([
        'Filled',
        'Open',
        'Partial',
        'Canceled',
        'Expired',
        'Rejected',
      ]);
      expect(within(statuses[0]).getByText('Filled').closest('[data-slot="badge"]')).toHaveClass('text-profit');
      expect(within(statuses[5]).getByText('Rejected').closest('[data-slot="badge"]')).toHaveClass('text-loss');
    });
  });

  describe('sorting', () => {
    it('keeps the order the store delivers until a header is clicked', async () => {
      await renderTable(twelveOrders());

      expect(symbolOrder()).toEqual(letters.slice(0, 10));
      screen.getAllByRole('columnheader').forEach((header) => {
        if (['Time', 'Symbol', 'Price', 'Quantity', 'Filled', 'PnL'].includes(header.textContent ?? '')) {
          expect(header).toHaveAttribute('aria-sort', 'none');
        }
      });
    });

    it('sorts across every loaded order, not only the ones currently shown', async () => {
      await renderTable(twelveOrders());
      expect(symbolOrder()).not.toContain('LLL');

      sortBy('Price'); // numbers: highest first
      expect(symbolOrder()[0]).toBe('AAA');

      sortBy('Price'); // lowest first: LLL (390) was hidden behind "Show More"
      expect(symbolOrder().slice(0, 3)).toEqual(['LLL', 'KKK', 'JJJ']);
      expect(columnHeader('Price')).toHaveAttribute('aria-sort', 'ascending');
      expect(bodyRows()).toHaveLength(10);

      sortBy('Price'); // third click restores the delivered order
      expect(symbolOrder()).toEqual(letters.slice(0, 10));
    });

    it('sorts by quantity and filled quantity', async () => {
      await renderTable(twelveOrders());

      sortBy('Quantity');
      expect(symbolOrder().slice(0, 2)).toEqual(['LLL', 'KKK']); // 13, 12 ...
      sortBy('Filled');
      expect(symbolOrder().slice(0, 2)).toEqual(['LLL', 'KKK']); // 12, 11 ...
      sortBy('Filled');
      expect(symbolOrder().slice(0, 2)).toEqual(['AAA', 'BBB']);
    });

    it('sorts by time with the newest first, then the oldest first', async () => {
      await renderTable([...twelveOrders()].reverse());
      expect(symbolOrder()[0]).toBe('LLL');

      sortBy('Time');
      expect(symbolOrder().slice(0, 2)).toEqual(['AAA', 'BBB']);

      sortBy('Time');
      expect(symbolOrder().slice(0, 2)).toEqual(['LLL', 'KKK']);
    });

    it('sorts by symbol name A to Z first', async () => {
      await renderTable([...twelveOrders()].reverse());

      sortBy('Symbol');
      expect(symbolOrder().slice(0, 3)).toEqual(['AAA', 'BBB', 'CCC']);

      sortBy('Symbol');
      expect(symbolOrder().slice(0, 3)).toEqual(['LLL', 'KKK', 'JJJ']);
    });

    it('sorts by PnL and always keeps orders without PnL at the end', async () => {
      const orders = [
        order({ symbol: 'AAAUSDT' }),
        order({ symbol: 'BBBUSDT', realizedProfit: '-8' }),
        order({ symbol: 'CCCUSDT', realizedProfit: '15' }),
        order({ symbol: 'DDDUSDT', realizedProfit: '0' }),
        order({ symbol: 'EEEUSDT', realizedProfit: '3' }),
      ];
      await renderTable(orders);

      sortBy('PnL');
      expect(symbolOrder()).toEqual(['CCC', 'EEE', 'BBB', 'AAA', 'DDD']);

      sortBy('PnL');
      expect(symbolOrder()).toEqual(['BBB', 'EEE', 'CCC', 'AAA', 'DDD']);
    });

    it('does not offer sorting on the badge columns', async () => {
      await renderTable([order()]);

      ['Action', 'Type', 'Side', 'Status'].forEach((name) => {
        expect(screen.queryByRole('button', { name: new RegExp(`^${name}`) })).not.toBeInTheDocument();
      });
    });
  });

  describe('show more', () => {
    it('shows the first ten orders with a button for the rest', async () => {
      await renderTable(twelveOrders());

      expect(bodyRows()).toHaveLength(10);
      expect(screen.getByRole('button', { name: /Show More \(2 more\)/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Load 50 More Orders/ })).not.toBeInTheDocument();
    });

    it('reveals all orders and goes back with Show Less', async () => {
      await renderTable(twelveOrders());

      fireEvent.click(screen.getByRole('button', { name: /Show More/ }));
      expect(bodyRows()).toHaveLength(12);
      expect(symbolOrder()[11]).toBe('LLL');

      fireEvent.click(screen.getByRole('button', { name: /Show Less/ }));
      expect(bodyRows()).toHaveLength(10);
    });

    it('keeps the chosen sort when showing more', async () => {
      await renderTable(twelveOrders());
      sortBy('Price');
      sortBy('Price');

      fireEvent.click(screen.getByRole('button', { name: /Show More/ }));

      expect(symbolOrder()).toEqual([...letters].reverse());
    });

    it('has no show-more button for ten orders or fewer', async () => {
      await renderTable(twelveOrders().slice(0, 10));

      expect(screen.queryByRole('button', { name: /Show More/ })).not.toBeInTheDocument();
      expect(bodyRows()).toHaveLength(10);
    });

    it('offers to load 50 more orders when the store may hold more, and requests the larger limit', async () => {
      const fifty = Array.from({ length: 50 }, (_, i) => order({ symbol: `S${i}USDT` }));
      await renderTable(fifty);
      expect(screen.queryByRole('button', { name: /Load 50 More Orders/ })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Show More/ }));
      expect(bodyRows()).toHaveLength(50);
      (orderStore.setFilters as jest.Mock).mockClear();
      (orderStore.fetchOrders as jest.Mock).mockClear();

      fireEvent.click(screen.getByRole('button', { name: /Load 50 More Orders/ }));

      await waitFor(() => expect(orderStore.fetchOrders).toHaveBeenCalledWith(true));
      expect(orderStore.setFilters).toHaveBeenCalledWith({ status: 'FILLED', symbol: undefined, limit: 100 });
    });
  });

  describe('filters and statistics', () => {
    it('reloads with the chosen status', async () => {
      await renderTable([order()]);
      (orderStore.setFilters as jest.Mock).mockClear();

      fireEvent.click(screen.getAllByRole('combobox')[0]);
      fireEvent.click(await screen.findByRole('option', { name: 'Open' }));

      await waitFor(() =>
        expect(orderStore.setFilters).toHaveBeenCalledWith({ status: 'NEW', symbol: undefined, limit: 50 })
      );
    });

    it('fetches filled orders for the Reduce filter and keeps only the closing ones', async () => {
      const closing = order({ symbol: 'AAAUSDT', reduceOnly: true });
      const withPnl = order({ symbol: 'BBBUSDT', realizedProfit: '2' });
      const opening = order({ symbol: 'CCCUSDT' });
      await renderTable([closing, withPnl, opening]);
      (orderStore.setFilters as jest.Mock).mockClear();

      fireEvent.click(screen.getAllByRole('combobox')[0]);
      fireEvent.click(await screen.findByRole('option', { name: 'Reduce' }));

      await waitFor(() =>
        expect(orderStore.setFilters).toHaveBeenCalledWith({ status: 'FILLED', symbol: undefined, limit: 50 })
      );
      await waitFor(() => expect(symbolOrder()).toEqual(['AAA', 'BBB']));
    });

    it('lists the symbols of the loaded orders in the symbol filter', async () => {
      await renderTable([order({ symbol: 'SOLUSDT' }), order({ symbol: 'BTCUSDT' }), order({ symbol: 'SOLUSDT' })]);

      fireEvent.click(screen.getAllByRole('combobox')[1]);

      expect(await screen.findByRole('option', { name: 'All Symbols' })).toBeInTheDocument();
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
        'All Symbols',
        'BTCUSDT',
        'SOLUSDT',
      ]);
    });

    it('summarises win rate, net PnL and the closed and open order counts', async () => {
      await renderTable([
        order({ symbol: 'AAAUSDT', realizedProfit: '10' }),
        order({ symbol: 'BBBUSDT', realizedProfit: '-4' }),
        order({ symbol: 'CCCUSDT', realizedProfit: '6' }),
        order({ symbol: 'DDDUSDT', status: OrderStatus.NEW }),
      ]);

      expect(screen.getByText('Win Rate:').nextSibling).toHaveTextContent('66.7% (2W/1L)');
      expect(screen.getByText('Net PnL:').nextSibling).toHaveTextContent('+$12.00');
      expect(screen.getByText('Net PnL:').nextSibling).toHaveClass('text-profit');
      expect(screen.getByText('Closed:').nextSibling).toHaveTextContent('3');
      expect(screen.getByText('Open:').nextSibling).toHaveTextContent('1');
    });
  });

  describe('real-time updates', () => {
    it('shows the orders the store publishes and keeps the chosen sort', async () => {
      await renderTable(twelveOrders().slice(0, 3));
      sortBy('Price');
      expect(symbolOrder()).toEqual(['AAA', 'BBB', 'CCC']);

      const updated = [
        order({ symbol: 'NEWUSDT', price: '900' }),
        ...twelveOrders().slice(0, 3),
      ];
      (orderStore.getFilteredOrders as jest.Mock).mockReturnValue(updated);
      await emit('orders:filtered', updated);

      expect(symbolOrder()).toEqual(['NEW', 'AAA', 'BBB', 'CCC']);
      expect(columnHeader('Price')).toHaveAttribute('aria-sort', 'descending');
    });

    it('flashes a newly arrived order for two seconds', async () => {
      jest.useFakeTimers();
      try {
        const fresh = order({ symbol: 'FRSUSDT' });
        await renderTable([fresh, order({ symbol: 'OLDUSDT' })]);
        const rowOf = (name: string) => screen.getByText(name).closest('tr')!;
        expect(rowOf('FRS')).not.toHaveClass('animate-pulse');

        await emit('order:new', fresh);
        expect(rowOf('FRS')).toHaveClass('animate-pulse', 'bg-blue-500/5');
        expect(rowOf('OLD')).not.toHaveClass('animate-pulse');

        await act(async () => {
          jest.advanceTimersByTime(2000);
        });
        expect(rowOf('FRS')).not.toHaveClass('animate-pulse');
      } finally {
        jest.useRealTimers();
      }
    });

    it('flashes only the order of the symbol that arrived when another symbol reuses its orderId', async () => {
      jest.useFakeTimers();
      try {
        const btc = order({ symbol: 'BTCUSDT', orderId: 77 });
        await renderTable([btc, order({ symbol: 'ETHUSDT', orderId: 77 })]);
        const rowOf = (name: string) => screen.getByText(name).closest('tr')!;

        await emit('order:new', btc);

        expect(rowOf('BTC')).toHaveClass('animate-pulse');
        expect(rowOf('ETH')).not.toHaveClass('animate-pulse');
        await act(async () => {
          jest.advanceTimersByTime(2000);
        });
        expect(rowOf('BTC')).not.toHaveClass('animate-pulse');
      } finally {
        jest.useRealTimers();
      }
    });

    it('re-evaluates the relative times every minute even when no new data arrives', async () => {
      jest.useFakeTimers();
      try {
        await renderTable([order({ symbol: 'AAAUSDT', updateTime: Date.now() - 30 * 1000 })]);
        const time = () => cells(bodyRows()[0])[0].textContent;
        expect(time()).toBe('Just now');

        await act(async () => {
          jest.advanceTimersByTime(MINUTE);
        });
        expect(time()).toBe('1m ago');

        await act(async () => {
          jest.advanceTimersByTime(HOUR);
        });
        expect(time()).toBe('1h ago');
      } finally {
        jest.useRealTimers();
      }
    });

    it('stops the minute tick when the table unmounts', async () => {
      jest.useFakeTimers();
      try {
        const { unmount } = await renderTable([order()]);
        expect(jest.getTimerCount()).toBe(1);

        unmount();

        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('passes order websocket messages to the store and ignores the rest', async () => {
      await renderTable([order()]);
      const handler = (websocketService.addMessageHandler as jest.Mock).mock.calls[0][0];

      handler({ type: 'order_update', data: { x: 1 } });
      handler({ type: 'ORDER_TRADE_UPDATE', data: { x: 2 } });
      handler({ type: 'balance_update', data: {} });

      expect(orderStore.handleWebSocketMessage).toHaveBeenCalledTimes(2);
      expect(orderStore.handleWebSocketMessage).toHaveBeenCalledWith({ type: 'order_update', data: { x: 1 } });
    });

    it('unsubscribes from the store and the websocket on unmount', async () => {
      const cleanup = jest.fn();
      (websocketService.addMessageHandler as jest.Mock).mockReturnValue(cleanup);
      const { unmount } = await renderTable([order()]);

      unmount();

      expect(cleanup).toHaveBeenCalled();
      expect(orderStore.off).toHaveBeenCalledWith('orders:filtered', expect.any(Function));
      expect(orderStore.off).toHaveBeenCalledWith('order:new', expect.any(Function));
    });
  });
});
