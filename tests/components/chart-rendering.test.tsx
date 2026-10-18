import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import PnLChart from '@/components/PnLChart';
import IncomeBreakdownChart from '@/components/IncomeBreakdownChart';

/**
 * Renders the charts with the real recharts (only the browser layout APIs are stubbed) to check what
 * the shadcn chart container produces: theme-token colour variables, legend order and the series
 * colours reaching the SVG.
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
