'use client';

import React, { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from 'recharts';
import { Badge } from '@/components/ui/badge';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { cn } from '@/lib/utils';

interface DailyPnL {
  date: string;
  realizedPnl: number;
  commission: number;
  fundingFee: number;
  insuranceClear: number;
  marketMerchantReward: number;
  apolloxRebate: number;
  usdfReward: number;
  netPnl: number;
  tradeCount: number;
}

interface IncomeBreakdownChartProps {
  data: DailyPnL[];
  timeRange: string;
}

// One stacked-bar series per income type. The colours are theme tokens
// (profit/loss and chart-1..5) exposed by the chart container as --color-<key>.
const incomeChartConfig = {
  realizedPnl: { label: 'Realized PnL', color: 'var(--profit)' },
  fundingFee: { label: 'Funding Fee', color: 'var(--chart-1)' },
  insurance: { label: 'Insurance', color: 'var(--chart-2)' },
  rebates: { label: 'Rebates', color: 'var(--chart-3)' },
  usdfRewards: { label: 'USDF Rewards', color: 'var(--chart-4)' },
  rewards: { label: 'Rewards', color: 'var(--chart-5)' },
  commission: { label: 'Commission', color: 'var(--loss)' },
} satisfies ChartConfig;

interface IncomeChartRow {
  date: string;
  realizedPnl: number;
  commission: number;
  fundingFee: number;
  insurance: number;
  rebates: number;
  usdfRewards: number;
  rewards: number;
  originalCommission: number;
  netPnl: number;
  tradeCount: number;
}

type TooltipBodyRenderer = (value: unknown, name: unknown, item: { payload?: IncomeChartRow }) => React.ReactNode;

// The tooltip describes the whole hovered day (every income type), not one series, so the body is
// rendered once, for the first series in the payload, inside the standard chart tooltip shell.
function IncomeTooltip({
  renderBody,
  ...props
}: React.ComponentProps<typeof ChartTooltipContent> & { renderBody: TooltipBodyRenderer }) {
  return (
    <ChartTooltipContent
      {...props}
      payload={props.payload?.slice(0, 1)}
      className="min-w-0 gap-1 p-2 bg-background/95 backdrop-blur"
      labelClassName="text-[10px] text-muted-foreground"
      labelFormatter={(label) =>
        typeof label === 'string' ? label.split('-').slice(1).reverse().join('/') : label
      }
      formatter={renderBody}
    />
  );
}

export default function IncomeBreakdownChart({ data, timeRange }: IncomeBreakdownChartProps) {
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  // Format date for chart based on time range
  const formatDateTick = (value: string) => {
    if (!value || typeof value !== 'string') return '';

    const parts = value.split('-');
    if (parts.length !== 3) return value;

    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const day = parseInt(parts[2], 10);

    if (isNaN(year) || isNaN(month) || isNaN(day)) return value;

    switch (timeRange) {
      case '24h':
      case '7d':
        return `${month}/${day}`;
      case '30d':
      case '90d':
        return `${month}/${day}`;
      case '1y':
      case 'all':
        return `${year.toString().slice(2)}-${month.toString().padStart(2, '0')}`;
      default:
        return `${month}/${day}`;
    }
  };

  // Transform data for stacked bar chart
  const chartData = useMemo<IncomeChartRow[]>(() => {
    return data.map(day => ({
      date: day.date,
      realizedPnl: day.realizedPnl,
      commission: Math.abs(day.commission), // Show as positive for stacking
      fundingFee: day.fundingFee,
      insurance: day.insuranceClear || 0,
      rebates: day.apolloxRebate || 0,
      usdfRewards: day.usdfReward || 0,
      rewards: day.marketMerchantReward || 0,
      // Store original values for tooltip
      originalCommission: day.commission,
      netPnl: day.netPnl,
      tradeCount: day.tradeCount,
    }));
  }, [data]);

  // One tooltip line per income type; swatch colours use the same theme tokens as the bars
  const tooltipLine = (label: string, swatchClass: string, value: string, valueClass: string) => (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-1.5">
        <div className={cn('w-2 h-2 rounded-sm', swatchClass)} />
        <span className="text-xs">{label}</span>
      </div>
      <span className={cn('text-xs font-semibold', valueClass)}>{value}</span>
    </div>
  );

  // Tooltip body for the hovered day; the tooltip shell and the date label come from ChartTooltipContent
  const renderTooltipBody = (_value: unknown, _name: unknown, item: { payload?: IncomeChartRow }) => {
    const row = item.payload;
    if (!row) return null;

    return (
      <div className="w-full space-y-0.5">
        {tooltipLine('Realized PnL', 'bg-profit', formatCurrency(row.realizedPnl), 'text-profit')}
        {tooltipLine('Commission', 'bg-loss', formatCurrency(row.originalCommission), 'text-loss')}
        {row.fundingFee !== 0 &&
          tooltipLine('Funding Fee', 'bg-chart-1', formatCurrency(row.fundingFee), row.fundingFee >= 0 ? 'text-blue-600' : 'text-orange-600')}
        {row.insurance !== 0 &&
          tooltipLine('Insurance', 'bg-chart-2', formatCurrency(row.insurance), 'text-orange-600')}
        {row.rebates !== 0 &&
          tooltipLine('Rebates', 'bg-chart-3', formatCurrency(row.rebates), 'text-yellow-600')}
        {row.usdfRewards !== 0 &&
          tooltipLine('USDF Rewards', 'bg-chart-4', formatCurrency(row.usdfRewards), 'text-cyan-600')}
        {row.rewards !== 0 &&
          tooltipLine('Rewards', 'bg-chart-5', formatCurrency(row.rewards), 'text-purple-600')}
        <div className="pt-1 mt-1 border-t flex items-center justify-between gap-4">
          <span className="text-xs font-semibold">Net PnL</span>
          <span className={cn('text-xs font-semibold', row.netPnl >= 0 ? 'text-profit' : 'text-loss')}>
            {formatCurrency(row.netPnl)}
          </span>
        </div>
        {row.tradeCount > 0 && (
          <div className="flex items-center justify-center pt-0.5">
            <Badge variant="secondary" className="h-3.5 text-[9px] px-1">
              {row.tradeCount} trades
            </Badge>
          </div>
        )}
      </div>
    );
  };

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[200px] text-muted-foreground">
        <p className="text-xs">No income breakdown data available</p>
      </div>
    );
  }

  return (
    <ChartContainer config={incomeChartConfig} className="aspect-auto h-[200px] w-full">
      <BarChart data={chartData} margin={{ left: 0, right: 10, top: 5, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10 }}
          tickFormatter={formatDateTick}
          interval={chartData.length <= 5 ? 0 : chartData.length <= 20 ? 'preserveStartEnd' : 'preserveStart'}
          minTickGap={chartData.length <= 10 ? 10 : 20}
        />
        <YAxis tick={{ fontSize: 10 }} width={40} />
        <ChartTooltip content={<IncomeTooltip renderBody={renderTooltipBody} />} />
        {/* itemSorter={null} keeps the legend in series order (recharts 3 sorts it alphabetically by default) */}
        <ChartLegend itemSorter={null} content={<ChartLegendContent className="text-[10px]" />} />
        <Bar dataKey="realizedPnl" stackId="a" fill="var(--color-realizedPnl)" radius={[0, 0, 0, 0]} />
        <Bar dataKey="fundingFee" stackId="a" fill="var(--color-fundingFee)" radius={[0, 0, 0, 0]} />
        <Bar dataKey="insurance" stackId="a" fill="var(--color-insurance)" radius={[0, 0, 0, 0]} />
        <Bar dataKey="rebates" stackId="a" fill="var(--color-rebates)" radius={[0, 0, 0, 0]} />
        <Bar dataKey="usdfRewards" stackId="a" fill="var(--color-usdfRewards)" radius={[0, 0, 0, 0]} />
        <Bar dataKey="rewards" stackId="a" fill="var(--color-rewards)" radius={[4, 4, 0, 0]} />
        {/* Commission shown as negative overlay */}
        <Bar dataKey="commission" fill="var(--color-commission)" opacity={0.7} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}
