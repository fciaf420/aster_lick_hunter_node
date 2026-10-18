import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PnLChart from '@/components/PnLChart';
import IncomeBreakdownChart from '@/components/IncomeBreakdownChart';

/**
 * Tooltip and colour wiring of the shadcn-chart based PnL and income-breakdown charts.
 *
 * Recharts is mocked so the tooltip is permanently "active" on a chosen data row: the mocked
 * <Tooltip> clones its `content` element (the real ChartTooltipContent with our formatter) with a
 * payload built from the rows the chart was given. Series/cell props are exposed as data attributes.
 */

global.fetch = jest.fn();

jest.mock('@/components/ConfigProvider', () => ({
  __esModule: true,
  default: ({ children }: any) => children,
  useConfig: jest.fn(() => ({
    config: { api: { apiKey: 'test-key', secretKey: 'test-secret' } },
    loading: false,
  })),
}));

jest.mock('@/lib/services/websocketService', () => ({
  __esModule: true,
  default: { addMessageHandler: jest.fn(() => jest.fn()), connect: jest.fn(), disconnect: jest.fn() },
}));

// Prefixed with "mock" so the hoisted jest.mock factory may reference them
let mockChartData: any[] = [];
let mockSeriesKeys: string[] = [];
let mockHoverIndex: number | null = 0;

jest.mock('recharts', () => {
  const React = require('react');

  const Area = ({ stroke, fill, fillOpacity }: any) => (
    <div data-testid="area" data-stroke={stroke} data-fill={fill} data-fill-opacity={fillOpacity} />
  );
  const Bar = ({ dataKey, fill, stackId, children }: any) => (
    <div data-testid="bar" data-key={dataKey} data-fill={fill} data-stack={stackId}>
      {children}
    </div>
  );

  // Like recharts, the tooltip payload holds one entry per series (<Area>/<Bar>) of the chart
  const registerChart = (data: any[], children: any) => {
    mockChartData = data;
    mockSeriesKeys = React.Children.toArray(children)
      .filter((child: any) => child.type === Area || child.type === Bar)
      .map((child: any) => child.props.dataKey);
  };

  return {
    ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
    AreaChart: ({ children, data }: any) => {
      registerChart(data, children);
      return <div data-testid="area-chart">{children}</div>;
    },
    BarChart: ({ children, data }: any) => {
      registerChart(data, children);
      return <div data-testid="bar-chart">{children}</div>;
    },
    Area,
    Bar,
    Cell: ({ fill }: any) => <div data-testid="cell" data-fill={fill} />,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    ReferenceLine: () => null,
    Legend: () => <div data-testid="legend" />,
    Tooltip: ({ content }: any) => {
      if (mockHoverIndex === null || !mockChartData[mockHoverIndex]) return null;
      const row = mockChartData[mockHoverIndex];
      const payload = mockSeriesKeys.map((key) => ({ dataKey: key, name: key, value: row[key], payload: row }));
      return React.cloneElement(content, { active: true, label: row.date, payload });
    },
  };
});

const day = (overrides: Record<string, unknown>) => ({
  date: '2025-09-01',
  realizedPnl: 0,
  commission: 0,
  fundingFee: 0,
  insuranceClear: 0,
  marketMerchantReward: 0,
  apolloxRebate: 0,
  usdfReward: 0,
  netPnl: 0,
  tradeCount: 0,
  ...overrides,
});

const mockIncome = (dailyPnL: unknown[]) => {
  (global.fetch as jest.Mock).mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url.startsWith('/api/income?') ? { dailyPnL, metrics: { totalPnl: 0, winRate: 50 } } : {},
  }));
};

describe('PnLChart chart wiring', () => {
  beforeEach(() => {
    mockHoverIndex = 0;
    mockChartData = [];
    (global.fetch as jest.Mock).mockReset();
  });

  describe('cumulative view (default)', () => {
    it('shows the hovered date and cumulative value coloured by sign', async () => {
      mockIncome([
        day({ date: '2025-09-01', realizedPnl: 100, commission: -5, netPnl: 95, tradeCount: 1 }),
        day({ date: '2025-09-02', realizedPnl: -30, commission: -2, fundingFee: -1, netPnl: -33, tradeCount: 2 }),
      ]);

      render(<PnLChart />);
      await screen.findByTestId('area-chart');

      // Date label is M/D/YYYY, parsed without timezone conversion
      expect(screen.getByText('9/1/2025')).toBeInTheDocument();
      const value = screen.getAllByText('$95.00').find((el) => el.className.includes('text-sm'));
      expect(value).toHaveClass('text-profit');
      expect(screen.getByText('1 trades')).toBeInTheDocument();
      // The per-day breakdown is only for the daily view
      expect(screen.queryByText(/Real:/)).not.toBeInTheDocument();
    });

    it('colours a negative cumulative value with the loss token', async () => {
      mockHoverIndex = 1;
      mockIncome([
        day({ date: '2025-09-01', netPnl: 10, tradeCount: 1 }),
        day({ date: '2025-09-02', netPnl: -40, tradeCount: 0 }),
      ]);

      render(<PnLChart />);
      await screen.findByTestId('area-chart');

      expect(screen.getByText('9/2/2025')).toBeInTheDocument();
      const value = screen.getByText('-$30.00');
      expect(value).toHaveClass('text-loss');
      // A day without trades shows no trade-count badge
      expect(screen.queryByText(/trades/)).not.toBeInTheDocument();
    });

    it('draws the area in the profit colour when the running total is positive', async () => {
      mockIncome([day({ date: '2025-09-01', netPnl: 95, tradeCount: 1 })]);

      render(<PnLChart />);
      const area = await screen.findByTestId('area');

      expect(area).toHaveAttribute('data-stroke', 'var(--color-profit)');
      expect(area).toHaveAttribute('data-fill', 'var(--color-profit)');
      expect(area).toHaveAttribute('data-fill-opacity', '0.25');
    });

    it('draws the area in the loss colour when the running total is negative', async () => {
      mockIncome([
        day({ date: '2025-09-01', netPnl: 20, tradeCount: 1 }),
        day({ date: '2025-09-02', netPnl: -50, tradeCount: 1 }),
      ]);

      render(<PnLChart />);
      const area = await screen.findByTestId('area');

      expect(area).toHaveAttribute('data-stroke', 'var(--color-loss)');
      expect(area).toHaveAttribute('data-fill', 'var(--color-loss)');
    });
  });

  describe('daily view', () => {
    const openDaily = async () => {
      render(<PnLChart />);
      await screen.findByTestId('area-chart');
      // Radix Tabs activate on mousedown
      fireEvent.mouseDown(screen.getByRole('tab', { name: /Daily/i }));
      await screen.findByTestId('bar-chart');
    };

    it('colours each bar by the sign of its net PnL', async () => {
      mockIncome([
        day({ date: '2025-09-01', netPnl: 95, tradeCount: 1 }),
        day({ date: '2025-09-02', netPnl: -33, tradeCount: 2 }),
        day({ date: '2025-09-03', netPnl: 0, tradeCount: 0 }),
      ]);

      await openDaily();

      const fills = screen.getAllByTestId('cell').map((cell) => cell.getAttribute('data-fill'));
      expect(fills).toEqual(['var(--color-profit)', 'var(--color-loss)', 'var(--color-profit)']);
    });

    it('shows the net value, trade count and the realized/fee breakdown for the hovered day', async () => {
      mockIncome([
        day({
          date: '2025-09-01',
          realizedPnl: 100,
          commission: -5,
          fundingFee: -1.5,
          insuranceClear: -2,
          marketMerchantReward: 3,
          netPnl: 94.5,
          tradeCount: 4,
        }),
      ]);

      await openDaily();

      expect(screen.getByText('9/1/2025')).toBeInTheDocument();
      expect(screen.getByText('$94.50')).toHaveClass('text-profit');
      expect(screen.getByText('4 trades')).toBeInTheDocument();
      expect(screen.getByText('Real: $100.00')).toBeInTheDocument();
      expect(screen.getByText('Fee: -$6.50')).toBeInTheDocument(); // commission + funding fee
      expect(screen.getByText('Ins: -$2.00')).toBeInTheDocument();
      expect(screen.getByText('Reward: $3.00')).toBeInTheDocument();
    });

    it('omits the insurance and reward lines when they are zero', async () => {
      mockIncome([day({ date: '2025-09-01', realizedPnl: 10, commission: -1, netPnl: 9, tradeCount: 1 })]);

      await openDaily();

      expect(screen.getByText('Real: $10.00')).toBeInTheDocument();
      expect(screen.queryByText(/Ins:/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Reward:/)).not.toBeInTheDocument();
    });

    it('colours a losing day with the loss token', async () => {
      mockIncome([day({ date: '2025-09-01', realizedPnl: -10, commission: -1, netPnl: -11, tradeCount: 1 })]);

      await openDaily();

      expect(screen.getByText('-$11.00')).toHaveClass('text-loss');
    });
  });
});

describe('IncomeBreakdownChart chart wiring', () => {
  beforeEach(() => {
    mockHoverIndex = 0;
    mockChartData = [];
  });

  const richDay = day({
    date: '2025-09-01',
    realizedPnl: 120,
    commission: -8,
    fundingFee: 2.5,
    insuranceClear: -1,
    apolloxRebate: 0.75,
    usdfReward: 0.5,
    marketMerchantReward: 4,
    netPnl: 118.75,
    tradeCount: 6,
  });

  it('stacks one bar per income type in the theme colours and keeps commission as an overlay', () => {
    render(<IncomeBreakdownChart data={[richDay as any]} timeRange="7d" />);

    const bars = screen.getAllByTestId('bar').map((bar) => ({
      key: bar.getAttribute('data-key'),
      fill: bar.getAttribute('data-fill'),
      stack: bar.getAttribute('data-stack'),
    }));
    expect(bars).toEqual([
      { key: 'realizedPnl', fill: 'var(--color-realizedPnl)', stack: 'a' },
      { key: 'fundingFee', fill: 'var(--color-fundingFee)', stack: 'a' },
      { key: 'insurance', fill: 'var(--color-insurance)', stack: 'a' },
      { key: 'rebates', fill: 'var(--color-rebates)', stack: 'a' },
      { key: 'usdfRewards', fill: 'var(--color-usdfRewards)', stack: 'a' },
      { key: 'rewards', fill: 'var(--color-rewards)', stack: 'a' },
      { key: 'commission', fill: 'var(--color-commission)', stack: null },
    ]);
    expect(screen.getByTestId('legend')).toBeInTheDocument();
  });

  it('maps the series colours to the profit/loss and chart theme tokens', () => {
    const { container } = render(<IncomeBreakdownChart data={[richDay as any]} timeRange="7d" />);

    const css = container.querySelector('style')?.textContent ?? '';
    expect(css).toContain('--color-realizedPnl: var(--profit);');
    expect(css).toContain('--color-commission: var(--loss);');
    ['fundingFee:1', 'insurance:2', 'rebates:3', 'usdfRewards:4', 'rewards:5'].forEach((pair) => {
      const [key, n] = pair.split(':');
      expect(css).toContain(`--color-${key}: var(--chart-${n});`);
    });
  });

  it('renders the day tooltip once with every non-zero income line, the net PnL and the trade count', () => {
    render(<IncomeBreakdownChart data={[richDay as any]} timeRange="7d" />);

    // Label keeps the existing day/month format
    expect(screen.getByText('01/09')).toBeInTheDocument();

    // Even though the payload holds one entry per series, the day body appears only once
    expect(screen.getAllByText('Realized PnL')).toHaveLength(1);
    expect(screen.getByText('$120.00')).toHaveClass('text-profit');
    // The commission line shows the original (negative) value, not the stacked absolute value
    expect(screen.getByText('-$8.00')).toHaveClass('text-loss');
    expect(screen.getByText('$2.50')).toHaveClass('text-blue-600'); // funding fee received
    expect(screen.getByText('-$1.00')).toHaveClass('text-orange-600'); // insurance
    expect(screen.getByText('$0.75')).toHaveClass('text-yellow-600'); // rebates
    expect(screen.getByText('$0.50')).toHaveClass('text-cyan-600'); // USDF rewards
    expect(screen.getByText('$4.00')).toHaveClass('text-purple-600'); // rewards

    const net = screen.getByText('Net PnL').parentElement as HTMLElement;
    expect(within(net).getByText('$118.75')).toHaveClass('text-profit');
    expect(screen.getByText('6 trades')).toBeInTheDocument();
  });

  it('hides zero-valued optional lines but always shows realized PnL and commission', () => {
    const quiet = day({ date: '2025-09-02', realizedPnl: -10, commission: -1, netPnl: -11, tradeCount: 0 });
    render(<IncomeBreakdownChart data={[quiet as any]} timeRange="7d" />);

    expect(screen.getByText('Realized PnL')).toBeInTheDocument();
    expect(screen.getByText('Commission')).toBeInTheDocument();
    ['Funding Fee', 'Insurance', 'Rebates', 'USDF Rewards', 'Rewards'].forEach((label) => {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/trades/)).not.toBeInTheDocument();

    const net = screen.getByText('Net PnL').parentElement as HTMLElement;
    expect(within(net).getByText('-$11.00')).toHaveClass('text-loss');
  });

  it('shows the funding fee in orange when it was paid', () => {
    const paid = day({ date: '2025-09-02', realizedPnl: 5, commission: -1, fundingFee: -3, netPnl: 1, tradeCount: 1 });
    render(<IncomeBreakdownChart data={[paid as any]} timeRange="7d" />);

    expect(screen.getByText('-$3.00')).toHaveClass('text-orange-600');
  });

  it('shows the empty state without a chart when there is no data', async () => {
    render(<IncomeBreakdownChart data={[]} timeRange="7d" />);

    expect(screen.getByText('No income breakdown data available')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('bar-chart')).not.toBeInTheDocument());
  });
});
