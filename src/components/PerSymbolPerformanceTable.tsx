'use client';

import React, { useState, useEffect, useCallback } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header';
import { Target, RefreshCw } from 'lucide-react';
import { useConfig } from '@/components/ConfigProvider';
import websocketService from '@/lib/services/websocketService';

type TimeRange = '24h' | '7d' | '30d' | '90d' | '1y' | 'all';

interface SymbolPnL {
  symbol: string;
  tradeCount: number;
  realizedPnl: number;
  commission: number;
  fundingFee: number;
  insuranceClear: number;
  marketMerchantReward: number;
  apolloxRebate: number;
  usdfReward: number;
  netPnl: number;
  winCount: number;
  lossCount: number;
  winRate: number;
}

const ACCOUNT_REWARDS = 'Account Rewards';

const formatCurrency = (value: number) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
};

// Same order and sort keys as before: Symbol, Trades, Win Rate, Net PnL, Commission and Funding sort;
// Realized does not.
const symbolColumns: ColumnDef<SymbolPnL>[] = [
  {
    id: 'symbol',
    accessorKey: 'symbol',
    header: ({ column }) => <DataTableColumnHeader column={column} title="Symbol" />,
    sortingFn: (a, b) => a.original.symbol.localeCompare(b.original.symbol),
    cell: ({ row }) => {
      const symbolPnl = row.original;
      const isAccountRewards = symbolPnl.symbol === ACCOUNT_REWARDS;
      return (
        <Badge
          variant="outline"
          className={`font-mono ${isAccountRewards ? 'border-yellow-600 text-yellow-700 dark:border-yellow-500 dark:text-yellow-400' : ''}`}
          title={isAccountRewards ? 'Referral rebates and staking rewards (not tied to specific symbols)' : ''}
        >
          {symbolPnl.symbol}
        </Badge>
      );
    },
    meta: { cellClassName: 'font-medium' },
  },
  {
    id: 'trades',
    accessorKey: 'tradeCount',
    header: ({ column }) => <DataTableColumnHeader column={column} title="Trades" align="right" />,
    cell: ({ row }) => {
      const symbolPnl = row.original;
      return (
        <div className="flex flex-col items-end">
          <span className="text-sm">{symbolPnl.tradeCount}</span>
          {symbolPnl.tradeCount > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {symbolPnl.winCount}W/{symbolPnl.lossCount}L
            </span>
          )}
        </div>
      );
    },
    meta: { headerClassName: 'text-right', cellClassName: 'text-right' },
  },
  {
    id: 'winRate',
    accessorKey: 'winRate',
    header: ({ column }) => <DataTableColumnHeader column={column} title="Win Rate" align="right" />,
    cell: ({ row }) => {
      const symbolPnl = row.original;
      return (
        <Badge
          variant={symbolPnl.winRate >= 50 ? "outline" : "secondary"}
          className={`h-5 text-[10px] ${
            symbolPnl.winRate >= 50
              ? 'border-profit text-profit'
              : ''
          }`}
        >
          {symbolPnl.winRate.toFixed(0)}%
        </Badge>
      );
    },
    meta: { headerClassName: 'text-right', cellClassName: 'text-right' },
  },
  {
    id: 'pnl',
    accessorKey: 'netPnl',
    header: ({ column }) => <DataTableColumnHeader column={column} title="Net PnL" align="right" />,
    cell: ({ row }) => {
      const symbolPnl = row.original;
      return (
        <span className={`font-semibold ${
          symbolPnl.netPnl >= 0
            ? 'text-profit'
            : 'text-loss'
        }`}>
          {formatCurrency(symbolPnl.netPnl)}
        </span>
      );
    },
    meta: { headerClassName: 'text-right', cellClassName: 'text-right' },
  },
  {
    id: 'realized',
    accessorKey: 'realizedPnl',
    header: 'Realized',
    enableSorting: false,
    cell: ({ row }) => formatCurrency(row.original.realizedPnl),
    meta: { headerClassName: 'text-right', cellClassName: 'text-right text-sm' },
  },
  {
    id: 'commission',
    accessorKey: 'commission',
    header: ({ column }) => <DataTableColumnHeader column={column} title="Commission" align="right" />,
    cell: ({ row }) => formatCurrency(row.original.commission),
    meta: { headerClassName: 'text-right', cellClassName: 'text-right text-sm text-loss' },
  },
  {
    id: 'funding',
    accessorKey: 'fundingFee',
    header: ({ column }) => <DataTableColumnHeader column={column} title="Funding" align="right" />,
    cell: ({ row }) => {
      const symbolPnl = row.original;
      return (
        <span className={symbolPnl.fundingFee >= 0 ? 'text-profit' : 'text-loss'}>
          {formatCurrency(symbolPnl.fundingFee)}
        </span>
      );
    },
    meta: { headerClassName: 'text-right', cellClassName: 'text-right text-sm' },
  },
];

interface PerSymbolPerformanceTableProps {
  timeRange: TimeRange;
}

export default function PerSymbolPerformanceTable({ timeRange }: PerSymbolPerformanceTableProps) {
  const { config } = useConfig();
  const [symbolData, setSymbolData] = useState<SymbolPnL[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const hasApiKeys = config?.api?.apiKey && config?.api?.secretKey;

  const fetchData = useCallback(async (isRefresh = false) => {
    if (isRefresh) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }

    try {
      const response = await fetch(`/api/income/symbols?range=${timeRange}`);
      if (response.ok) {
        const data = await response.json();
        setSymbolData(data.symbols || []);
      } else {
        setSymbolData([]);
      }
    } catch (error) {
      console.error('Failed to fetch per-symbol data:', error);
      setSymbolData([]);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [timeRange]);

  useEffect(() => {
    if (hasApiKeys) {
      fetchData();
    } else {
      setIsLoading(false);
    }
  }, [timeRange, hasApiKeys, fetchData]);

  // Refresh on trade updates
  useEffect(() => {
    const handleMessage = (message: any) => {
      if (message.type === 'pnl_update' || message.type === 'trade_update') {
        fetchData(true);
      }
    };

    const cleanup = websocketService.addMessageHandler(handleMessage);
    return cleanup;
  }, [fetchData]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[200px] text-muted-foreground">
        <div className="text-center">
          <RefreshCw className="h-6 w-6 mx-auto animate-spin mb-2" />
          <p className="text-xs">Loading symbol performance...</p>
        </div>
      </div>
    );
  }

  if (!hasApiKeys) {
    return (
      <div className="flex items-center justify-center h-[200px] text-muted-foreground">
        <div className="text-center">
          <Target className="h-6 w-6 mx-auto opacity-50 mb-2" />
          <p className="text-xs font-medium">API keys required</p>
        </div>
      </div>
    );
  }

  if (symbolData.length === 0) {
    return (
      <div className="flex items-center justify-center h-[200px] text-muted-foreground">
        <div className="text-center">
          <Target className="h-6 w-6 mx-auto opacity-50 mb-2" />
          <p className="text-xs font-medium">No trading data</p>
          <Badge variant="secondary" className="h-4 text-[10px] px-1.5 mt-1">
            {timeRange} period
          </Badge>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      {isRefreshing && (
        <div className="absolute inset-0 z-10 bg-background/50 flex items-center justify-center">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}
      <DataTable
        columns={symbolColumns}
        data={symbolData}
        getRowId={(row) => row.symbol}
        initialSorting={[{ id: 'pnl', desc: true }]}
        sortDescFirst
        sortingRemovable={false}
        rowClassName={(row) => (row.symbol === ACCOUNT_REWARDS ? 'bg-yellow-50/50 dark:bg-yellow-950/20' : undefined)}
      />
    </div>
  );
}
