import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PnLChart from '@/components/PnLChart';
import IncomeBreakdownChart from '@/components/IncomeBreakdownChart';

/**
 * Renders the charts with the real recharts (only the browser layout APIs are stubbed) to check what
 * the shadcn chart container produces: theme-token colour variables, legend order, the series
 * colours reaching the SVG and the tooltip a real hover produces.
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

// jsdom has no layout engine: report a fixed size so ResponsiveContainer renders its chart
class FakeResizeObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback([{ target, contentRect: { width: 600, height: 200 } } as ResizeObserverEntry], this as any);
  }
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (global as any).ResizeObserver = FakeResizeObserver;
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

describe('IncomeBreakdownChart rendering', () => {
  const data = [
    day({ date: '2025-09-01', realizedPnl: 100, commission: -5, fundingFee: 2, netPnl: 97, tradeCount: 3 }),
    day({ date: '2025-09-02', realizedPnl: -40, commission: -3, fundingFee: -1, marketMerchantReward: 1, netPnl: -43, tradeCount: 2 }),
  ] as any[];

  it('lists the legend in series order with the theme-token swatches', () => {
    const { container } = render(<IncomeBreakdownChart data={data} timeRange="7d" />);

    const legend = container.querySelector('.recharts-legend-wrapper') as HTMLElement;
    expect(legend).toBeInTheDocument();
    // recharts 3 sorts legend entries alphabetically unless itemSorter is null
    expect(legend.textContent).toBe('Realized PnLFunding FeeInsuranceRebatesUSDF RewardsRewardsCommission');

    const swatches = Array.from(legend.querySelectorAll<HTMLElement>('[style*="background-color"]')).map(
      (el) => el.style.backgroundColor
    );
    expect(swatches).toEqual([
      'var(--color-realizedPnl)',
      'var(--color-fundingFee)',
      'var(--color-insurance)',
      'var(--color-rebates)',
      'var(--color-usdfRewards)',
      'var(--color-rewards)',
      'var(--color-commission)',
    ]);
  });

  it('defines the series colour variables from the theme tokens for light and dark', () => {
    const { container } = render(<IncomeBreakdownChart data={data} timeRange="7d" />);

    const css = container.querySelector('style')?.textContent ?? '';
    const chartId = container.querySelector('[data-slot="chart"]')?.getAttribute('data-chart');
    expect(chartId).toBeTruthy();
    // One rule scoped to this chart for light mode and one for .dark
    expect(css).toContain(`[data-chart=${chartId}] {`);
    expect(css).toContain(`.dark [data-chart=${chartId}] {`);
    expect(css.match(/--color-realizedPnl: var\(--profit\);/g)).toHaveLength(2);
    expect(css.match(/--color-commission: var\(--loss\);/g)).toHaveLength(2);
  });

  it('draws a bar for every income type', async () => {
    const { container } = render(<IncomeBreakdownChart data={data} timeRange="7d" />);

    await waitFor(() => {
      expect(container.querySelectorAll('.recharts-bar')).toHaveLength(7);
    });
  });

  it('draws the realized PnL bar of a losing day in the loss colour, and a flat or winning day in the profit colour', async () => {
    const { container } = render(
      <IncomeBreakdownChart
        data={[
          ...data,
          day({ date: '2025-09-03', realizedPnl: 25, netPnl: 25, tradeCount: 1 }),
          day({ date: '2025-09-04', realizedPnl: 0, fundingFee: 3, netPnl: 3 }),
        ] as any[]}
        timeRange="7d"
      />
    );

    await waitFor(() => {
      const realizedBars = container.querySelector('.recharts-bar') as HTMLElement; // the first series
      const fills = Array.from(realizedBars.querySelectorAll('.recharts-bar-rectangle path')).map((p) =>
        p.getAttribute('fill')
      );
      expect(fills).toEqual(['var(--color-profit)', 'var(--color-loss)', 'var(--color-profit)']);
    });
    // The legend swatch of the series keeps the series colour (profit)
    const legend = container.querySelector('.recharts-legend-wrapper') as HTMLElement;
    expect(legend.querySelector<HTMLElement>('[style*="background-color"]')?.style.backgroundColor).toBe(
      'var(--color-realizedPnl)'
    );
    const css = container.querySelector('style')?.textContent ?? '';
    expect(css).toContain('--color-profit: var(--profit);');
    expect(css).toContain('--color-loss: var(--loss);');
  });
});

describe('PnLChart rendering', () => {
  beforeEach(() => {
    (global.fetch as jest.Mock).mockReset();
  });

  const mockIncome = (dailyPnL: unknown[]) => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => ({
      ok: true,
      json: async () =>
        url.startsWith('/api/income?') ? { dailyPnL, metrics: { totalPnl: 0, winRate: 50 } } : {},
    }));
  };

  it('draws the daily bars in the profit and loss token colours', async () => {
    mockIncome([
      day({ date: '2025-09-01', netPnl: 95, tradeCount: 1 }),
      day({ date: '2025-09-02', netPnl: -33, tradeCount: 2 }),
    ]);

    const { container } = render(<PnLChart />);
    await waitFor(() => expect(container.querySelector('[data-slot="chart"]')).toBeInTheDocument());

    fireEvent.mouseDown(screen.getByRole('tab', { name: /Daily/i }));

    await waitFor(() => {
      const fills = Array.from(container.querySelectorAll('.recharts-bar-rectangle path')).map((p) =>
        p.getAttribute('fill')
      );
      expect(fills).toEqual(['var(--color-profit)', 'var(--color-loss)']);
    });
  });

  it('draws the cumulative area with the sign colour of the running total', async () => {
    mockIncome([
      day({ date: '2025-09-01', netPnl: 20, tradeCount: 1 }),
      day({ date: '2025-09-02', netPnl: -50, tradeCount: 1 }),
    ]);

    const { container } = render(<PnLChart />);

    await waitFor(() => {
      const area = container.querySelector('.recharts-area-area');
      expect(area).toHaveAttribute('fill', 'var(--color-loss)');
      expect(area).toHaveAttribute('fill-opacity', '0.25');
      expect(container.querySelector('.recharts-area-curve')).toHaveAttribute('stroke', 'var(--color-loss)');
    });
  });

  it('sizes the chart through the container and exposes the profit/loss variables', async () => {
    mockIncome([day({ date: '2025-09-01', netPnl: 95, tradeCount: 1 })]);

    const { container } = render(<PnLChart />);
    const chart = await waitFor(() => {
      const el = container.querySelector('[data-slot="chart"]') as HTMLElement;
      expect(el).toBeInTheDocument();
      return el;
    });

    expect(chart).toHaveClass('h-[200px]', 'w-full', 'aspect-auto');
    expect(chart).not.toHaveClass('aspect-video');
    const css = container.querySelector('style')?.textContent ?? '';
    expect(css).toContain('--color-profit: var(--profit);');
    expect(css).toContain('--color-loss: var(--loss);');
  });
});

/**
 * Real hovers. ChartTooltipContent only calls its formatter for a payload entry that has a value and
 * a name, so these check that the formatted body (not the default "name value" rows) reaches the page
 * when recharts itself supplies the payload, which the mocked-recharts suite cannot show.
 */
describe('chart tooltips on a real hover', () => {
  const originalRect = Element.prototype.getBoundingClientRect;

  beforeAll(() => {
    // recharts maps the pointer onto the plot through the wrapper's rect, which jsdom reports as 0x0.
    // Only the wrapper gets a size: a blanket stub would make the legend 200px tall and leave no plot area.
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (!this.matches('.recharts-wrapper')) return originalRect.call(this);
      return { x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 200, width: 600, height: 200, toJSON() {} } as DOMRect;
    };
  });

  afterAll(() => {
    Element.prototype.getBoundingClientRect = originalRect;
  });

  beforeEach(() => {
    (global.fetch as jest.Mock).mockReset();
  });

  const mockIncome = (dailyPnL: unknown[]) => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => ({
      ok: true,
      json: async () =>
        url.startsWith('/api/income?') ? { dailyPnL, metrics: { totalPnl: 0, winRate: 50 } } : {},
    }));
  };

  const hover = (container: HTMLElement) =>
    fireEvent.mouseMove(container.querySelector('.recharts-wrapper') as HTMLElement, { clientX: 150, clientY: 100 });
  const tooltip = (container: HTMLElement) => container.querySelector('.recharts-tooltip-wrapper') as HTMLElement;

  const twoDays = [
    day({ date: '2025-09-01', realizedPnl: 100, commission: -5, fundingFee: 2, netPnl: 97, tradeCount: 3 }),
    day({ date: '2025-09-02', realizedPnl: -40, commission: -3, fundingFee: -1, netPnl: -43, tradeCount: 2 }),
  ];

  it('PnLChart (cumulative) shows the formatted date, running total and trade count', async () => {
    mockIncome([
      day({ date: '2025-09-01', realizedPnl: 100, commission: -5, netPnl: 95, tradeCount: 1 }),
      day({ date: '2025-09-02', realizedPnl: -30, commission: -2, netPnl: -33, tradeCount: 2 }),
    ]);
    const { container } = render(<PnLChart />);
    await waitFor(() => expect(container.querySelector('.recharts-area-area')).toBeInTheDocument());

    hover(container);

    await waitFor(() => expect(tooltip(container).textContent).toBe('Sep 1, 2025$95.001 trades'));
    expect(within(tooltip(container)).getByText('$95.00')).toHaveClass('text-profit');
  });

  it('PnLChart (daily) shows the formatted date, the day and its realized/fee breakdown', async () => {
    mockIncome([
      day({ date: '2025-09-01', realizedPnl: 100, commission: -5, netPnl: 95, tradeCount: 1 }),
      day({ date: '2025-09-02', realizedPnl: -30, commission: -2, netPnl: -33, tradeCount: 2 }),
    ]);
    const { container } = render(<PnLChart />);
    await waitFor(() => expect(container.querySelector('[data-slot="chart"]')).toBeInTheDocument());
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Daily/i }));
    await waitFor(() => expect(container.querySelector('.recharts-bar-rectangle')).toBeInTheDocument());

    hover(container);

    await waitFor(() =>
      expect(tooltip(container).textContent).toBe('Sep 1, 2025$95.001 tradesReal: $100.00Fee: -$5.00')
    );
  });

  it('IncomeBreakdownChart shows the whole-day body once, under the formatted date', async () => {
    const { container } = render(<IncomeBreakdownChart data={twoDays as any[]} timeRange="7d" />);
    await waitFor(() => expect(container.querySelectorAll('.recharts-bar')).toHaveLength(7));

    hover(container);

    await waitFor(() => expect(within(tooltip(container)).getByText('Net PnL')).toBeInTheDocument());
    const body = within(tooltip(container));
    expect(body.getAllByText('Net PnL')).toHaveLength(1);
    // One payload entry per series reaches the tooltip, but the day is described only once
    expect(body.getAllByText('Realized PnL')).toHaveLength(1);
    expect(tooltip(container).textContent).toBe(
      'Sep 1, 2025Realized PnL$100.00Commission-$5.00Funding Fee$2.00Net PnL$97.003 trades'
    );
  });
});
