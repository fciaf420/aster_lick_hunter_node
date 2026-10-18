'use client';

import React, { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from 'recharts';
import { Badge } from '@/components/ui/badge';

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
  const chartData = useMemo(() => {
    return data.map(day => ({
      date: day.date,
      'Realized PnL': day.realizedPnl,
      'Commission': Math.abs(day.commission), // Show as positive for stacking
      'Funding Fee': day.fundingFee,
      'Insurance': day.insuranceClear || 0,
      'Rebates': day.apolloxRebate || 0,
      'USDF Rewards': day.usdfReward || 0,
      'Rewards': day.marketMerchantReward || 0,
      // Store original values for tooltip
      _originalCommission: day.commission,
      _apolloxRebate: day.apolloxRebate || 0,
      _usdfReward: day.usdfReward || 0,
      _netPnl: day.netPnl,
      _tradeCount: day.tradeCount,
    }));
  }, [data]);

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;

      return (
        <div className="bg-background/95 backdrop-blur border rounded-md shadow-lg p-2">
          <p className="text-[10px] font-medium text-muted-foreground mb-1">
            {label.split('-').slice(1).reverse().join('/')}
          </p>
          <div className="space-y-0.5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-sm bg-green-500" />
                <span className="text-xs">Realized PnL</span>
              </div>
              <span className="text-xs font-semibold text-green-600">
                {formatCurrency(data['Realized PnL'])}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-sm bg-red-500" />
                <span className="text-xs">Commission</span>
              </div>
              <span className="text-xs font-semibold text-red-600">
                {formatCurrency(data._originalCommission)}
              </span>
            </div>
            {data['Funding Fee'] !== 0 && (
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-sm bg-blue-500" />
                  <span className="text-xs">Funding Fee</span>
                </div>
                <span className={`text-xs font-semibold ${data['Funding Fee'] >= 0 ? 'text-blue-600' : 'text-orange-600'}`}>
                  {formatCurrency(data['Funding Fee'])}
                </span>
              </div>
            )}
            {data['Insurance'] !== 0 && (
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-sm bg-orange-500" />
                  <span className="text-xs">Insurance</span>
                </div>
                <span className="text-xs font-semibold text-orange-600">
                  {formatCurrency(data['Insurance'])}
                </span>
              </div>
            )}
            {data['Rebates'] !== 0 && (
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-sm bg-yellow-500" />
                  <span className="text-xs">Rebates</span>
                </div>
                <span className="text-xs font-semibold text-yellow-600">
                  {formatCurrency(data['Rebates'])}
                </span>
              </div>
            )}
            {data['USDF Rewards'] !== 0 && (
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-sm bg-cyan-500" />
                  <span className="text-xs">USDF Rewards</span>
                </div>
                <span className="text-xs font-semibold text-cyan-600">
                  {formatCurrency(data['USDF Rewards'])}
                </span>
              </div>
            )}
            {data['Rewards'] !== 0 && (
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-sm bg-purple-500" />
                  <span className="text-xs">Rewards</span>
                </div>
                <span className="text-xs font-semibold text-purple-600">
                  {formatCurrency(data['Rewards'])}
                </span>
              </div>
            )}
            <div className="pt-1 mt-1 border-t flex items-center justify-between gap-4">
              <span className="text-xs font-semibold">Net PnL</span>
              <span className={`text-xs font-semibold ${data._netPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {formatCurrency(data._netPnl)}
              </span>
            </div>
            {data._tradeCount > 0 && (
              <div className="flex items-center justify-center pt-0.5">
                <Badge variant="secondary" className="h-3.5 text-[9px] px-1">
                  {data._tradeCount} trades
                </Badge>
              </div>
            )}
          </div>
        </div>
      );
    }
    return null;
  };

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[200px] text-muted-foreground">
        <p className="text-xs">No income breakdown data available</p>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
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
        <Tooltip content={<CustomTooltip />} />
        <Legend
          wrapperStyle={{ fontSize: '10px' }}
          iconType="square"
          iconSize={8}
        />
        <Bar dataKey="Realized PnL" stackId="a" fill="#10b981" radius={[0, 0, 0, 0]} />
        <Bar dataKey="Funding Fee" stackId="a" fill="#3b82f6" radius={[0, 0, 0, 0]} />
        <Bar dataKey="Insurance" stackId="a" fill="#f97316" radius={[0, 0, 0, 0]} />
        <Bar dataKey="Rebates" stackId="a" fill="#eab308" radius={[0, 0, 0, 0]} />
        <Bar dataKey="USDF Rewards" stackId="a" fill="#06b6d4" radius={[0, 0, 0, 0]} />
        <Bar dataKey="Rewards" stackId="a" fill="#a855f7" radius={[4, 4, 0, 0]} />
        {/* Commission shown as negative overlay */}
        <Bar dataKey="Commission" fill="#ef4444" opacity={0.7} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
