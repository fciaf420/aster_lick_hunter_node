'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header';
import { Skeleton } from '@/components/ui/skeleton';
import { BarChart3, TrendingUp, TrendingDown, Shield, Target, ChevronDown, X, AlertTriangle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
import websocketService from '@/lib/services/websocketService';
import { useConfig } from '@/components/ConfigProvider';
import { useSymbolPrecision } from '@/hooks/useSymbolPrecision';
import dataStore from '@/lib/services/dataStore';
import { showApiError, showTradingError } from '@/lib/utils/errorToast';

interface Position {
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  markPrice: number;
  pnl: number;
  pnlPercent: number;
  margin: number;
  stopLoss?: number;
  takeProfit?: number;
  leverage: number;
  liquidationPrice?: number;
  hasStopLoss?: boolean;
  hasTakeProfit?: boolean;
}

interface VWAPData {
  value: number;
  position: 'above' | 'below';
  timestamp: number;
}

interface PositionTableProps {
  positions?: Position[];
  onClosePosition?: (symbol: string, side: 'LONG' | 'SHORT') => void;
}

const NO_POSITIONS: Position[] = [];

export default function PositionTable({
  positions = NO_POSITIONS,
  onClosePosition: _onClosePosition,
}: PositionTableProps) {
  const [realPositions, setRealPositions] = useState<Position[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Why the last positions fetch failed; cleared by the next successful fetch or update
  const [loadError, setLoadError] = useState<string | null>(null);
  const [markPrices, setMarkPrices] = useState<Record<string, number>>({});
  const [vwapData, setVwapData] = useState<Record<string, VWAPData>>({});
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [closePositionModal, setClosePositionModal] = useState<{
    isOpen: boolean;
    symbol: string;
    side: 'LONG' | 'SHORT';
    quantity: number;
    entryPrice?: number;
    markPrice?: number;
    pnl?: number;
    pnlPercent?: number;
  }>({
    isOpen: false,
    symbol: '',
    side: 'LONG',
    quantity: 0,
  });
  const [isClosingPosition, setIsClosingPosition] = useState(false);
  const { config } = useConfig();
  const { formatPrice, formatQuantity, formatPriceWithCommas } = useSymbolPrecision();

  // Initial load of VWAP data (fallback for when WebSocket is not yet connected)
  const loadVWAPData = useCallback(async () => {
    try {
      // Only fetch for symbols with VWAP protection enabled
      const symbolsWithVWAP = Object.entries(config?.symbols || {})
        .filter(([_, cfg]) => cfg.vwapProtection)
        .map(([symbol]) => symbol);

      if (symbolsWithVWAP.length === 0) {
        console.log('No symbols with VWAP protection enabled');
        return;
      }

      console.log('Initial VWAP load for symbols:', symbolsWithVWAP);

      const vwapPromises = symbolsWithVWAP.map(async (symbol) => {
        try {
          const response = await fetch(`/api/vwap/${symbol}`);
          if (response.ok) {
            const data = await response.json();
            return { symbol, data };
          }
        } catch (error) {
          console.error(`Failed to load initial VWAP for ${symbol}:`, error);
        }
        return null;
      });

      const results = await Promise.all(vwapPromises);
      const vwapMap: Record<string, VWAPData> = {};
      results.forEach(result => {
        if (result) {
          vwapMap[result.symbol] = result.data;
        }
      });
      console.log('Final VWAP map:', vwapMap);
      setVwapData(vwapMap);
    } catch (error) {
      console.error('Failed to load VWAP data:', error);
    }
  }, [config?.symbols]);

  // Load initial positions and set up WebSocket updates
  useEffect(() => {
    // Use data store if no positions passed as props
    if (positions.length === 0) {
      // Load initial data from data store
      dataStore.fetchPositions().then((data) => {
        setRealPositions(data);
        setLoadError(null);
        setIsLoading(false);
      }).catch((error) => {
        console.error('[PositionTable] Failed to load positions:', error);
        setLoadError(error instanceof Error ? error.message : String(error));
        setIsLoading(false);
      });

      // Subscribe to data store events
      const handlePositionsUpdate = (data: Position[]) => {
        setRealPositions(data);
        setLoadError(null);
      };

      // Also covers refreshes the data store runs after websocket updates
      const handlePositionsError = (message: string) => {
        setLoadError(message);
      };

      const handleMarkPricesUpdate = (prices: Record<string, number>) => {
        setMarkPrices(prices);
      };

      dataStore.on('positions:update', handlePositionsUpdate);
      dataStore.on('positions:error', handlePositionsError);
      dataStore.on('markPrices:update', handleMarkPricesUpdate);

      // Load initial mark prices
      const currentMarkPrices = dataStore.getMarkPrices();
      if (Object.keys(currentMarkPrices).length > 0) {
        setMarkPrices(currentMarkPrices);
      }

      // Clean up data store listeners
      const cleanupDataStore = () => {
        dataStore.off('positions:update', handlePositionsUpdate);
        dataStore.off('positions:error', handlePositionsError);
        dataStore.off('markPrices:update', handleMarkPricesUpdate);
      };

      // Forward WebSocket messages to data store and handle VWAP
      const handleWebSocketMessage = (message: any) => {
        // Forward to data store for balance/position/mark price updates
        dataStore.handleWebSocketMessage(message);

        // Handle VWAP updates separately (not in data store)
        if (message.type === 'vwap_update') {
          const data = message.data;
          if (data && data.symbol) {
            setVwapData(prev => ({
              ...prev,
              [data.symbol]: {
                value: data.vwap,
                position: data.position,
                timestamp: data.timestamp
              }
            }));
          }
        } else if (message.type === 'vwap_bulk') {
          if (Array.isArray(message.data)) {
            const vwapUpdates: Record<string, VWAPData> = {};
            message.data.forEach((data: any) => {
              vwapUpdates[data.symbol] = {
                value: data.vwap,
                position: data.position,
                timestamp: data.timestamp
              };
            });
            setVwapData(prev => ({ ...prev, ...vwapUpdates }));
          }
        }
      };

      const cleanupWebSocket = websocketService.addMessageHandler(handleWebSocketMessage);

      // Load initial VWAP data once
      loadVWAPData();

      // Cleanup on unmount
      return () => {
        cleanupDataStore();
        cleanupWebSocket();
      };
    } else {
      // Use passed positions and set up VWAP updates only
      setIsLoading(false);

      const handleVwapMessage = (message: any) => {
        if (message.type === 'vwap_update') {
          const data = message.data;
          if (data && data.symbol) {
            setVwapData(prev => ({
              ...prev,
              [data.symbol]: {
                value: data.vwap,
                position: data.position,
                timestamp: data.timestamp
              }
            }));
          }
        } else if (message.type === 'vwap_bulk') {
          if (Array.isArray(message.data)) {
            const vwapUpdates: Record<string, VWAPData> = {};
            message.data.forEach((data: any) => {
              vwapUpdates[data.symbol] = {
                value: data.vwap,
                position: data.position,
                timestamp: data.timestamp
              };
            });
            setVwapData(prev => ({ ...prev, ...vwapUpdates }));
          }
        }
      };

      const cleanupVwap = websocketService.addMessageHandler(handleVwapMessage);
      loadVWAPData();

      return () => {
        cleanupVwap();
      };
    }
  }, [positions.length, loadVWAPData]); // Include loadVWAPData dependency


  // Handle close position
  const handleClosePosition = useCallback((position: Position) => {
    setClosePositionModal({
      isOpen: true,
      symbol: position.symbol,
      side: position.side,
      quantity: position.quantity,
      entryPrice: position.entryPrice,
      markPrice: position.markPrice,
      pnl: position.pnl,
      pnlPercent: position.pnlPercent,
    });
  }, []);

  const confirmClosePosition = useCallback(async () => {
    if (!closePositionModal.symbol || !closePositionModal.side) return;

    setIsClosingPosition(true);
    try {
      const response = await fetch(`/api/positions/${closePositionModal.symbol}/${closePositionModal.side}/close`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const result = await response.json();

      if (result.success) {
        // Show success toast
        toast.success(`Successfully closed ${closePositionModal.symbol} ${closePositionModal.side} position`, {
          description: `Closed ${formatQuantity(closePositionModal.symbol, closePositionModal.quantity)} contracts`,
          duration: 5000,
        });

        // Always refresh positions data after successful close
        dataStore.fetchPositions().then((data) => {
          setRealPositions(data);
          setLoadError(null);
        }).catch((error) => {
          console.error('[PositionTable] Failed to refresh positions after close:', error);
          toast.error('Failed to refresh positions', {
            description: 'Please refresh the page to see updated positions',
          });
        });

        // Close modal
        setClosePositionModal({
          isOpen: false,
          symbol: '',
          side: 'LONG',
          quantity: 0,
        });
      } else {
        console.error('Failed to close position:', result.error);
        // Show error toast with details
        showTradingError(
          'Failed to close position',
          result.error || 'An unknown error occurred',
          {
            symbol: closePositionModal.symbol,
            component: 'PositionTable',
            rawError: result,
          }
        );
      }
    } catch (error) {
      console.error('Error closing position:', error);
      // Show error toast
      showApiError(
        'Network error',
        'Failed to connect to the server',
        {
          symbol: closePositionModal.symbol,
          component: 'PositionTable',
          rawError: error,
        }
      );
    } finally {
      setIsClosingPosition(false);
    }
  }, [closePositionModal, formatQuantity]);

  const cancelClosePosition = useCallback(() => {
    setClosePositionModal({
      isOpen: false,
      symbol: '',
      side: 'LONG',
      quantity: 0,
    });
  }, []);

  // Use passed positions if available, otherwise use fetched positions
  // Apply live mark prices to calculate real-time PnL
  const displayPositions = useMemo(() => (positions.length > 0 ? positions : realPositions).map(position => {
    const liveMarkPrice = markPrices[position.symbol];
    if (liveMarkPrice && liveMarkPrice !== position.markPrice) {
      // Calculate live PnL based on current mark price
      const entryPrice = position.entryPrice;
      const quantity = position.quantity;
      const isLong = position.side === 'LONG';

      const priceDiff = liveMarkPrice - entryPrice;
      const livePnL = isLong ? priceDiff * quantity : -priceDiff * quantity;
      const notionalValue = quantity * entryPrice;
      const livePnLPercent = notionalValue > 0 ? (livePnL / notionalValue) * 100 : 0;

      return {
        ...position,
        markPrice: liveMarkPrice,
        pnl: livePnL,
        pnlPercent: livePnLPercent
      };
    }
    return position;
  }), [positions, realPositions, markPrices]);

  const _totalPnL = displayPositions.reduce((sum, p) => sum + p.pnl, 0);
  const _totalMargin = displayPositions.reduce((sum, p) => sum + p.margin, 0);

  // Get unique symbols from positions and group by side
  const _positionSymbols = useMemo(() => {
    const symbolMap = new Map<string, Set<'LONG' | 'SHORT'>>();
    displayPositions.forEach(position => {
      if (!symbolMap.has(position.symbol)) {
        symbolMap.set(position.symbol, new Set());
      }
      symbolMap.get(position.symbol)?.add(position.side);
    });
    return Array.from(symbolMap.entries()).map(([symbol, sides]) => ({
      symbol,
      hasLong: sides.has('LONG'),
      hasShort: sides.has('SHORT'),
    }));
  }, [displayPositions]);

  const columns = useMemo<ColumnDef<Position>[]>(() => [
    {
      id: 'symbol',
      accessorKey: 'symbol',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Symbol" className="text-xs" />,
      cell: ({ row }) => {
        const position = row.original;
        return (
          <div className="flex items-center gap-1.5">
            <a
              href={`https://www.asterdex.com/en/futures/v1/${position.symbol}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-sm hover:underline hover:text-primary transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              {position.symbol}
            </a>
            <Badge variant="secondary" className="h-4 text-[10px] px-1">
              {position.leverage}x
            </Badge>
          </div>
        );
      },
      meta: {
        headerClassName: 'text-xs',
        cellClassName: 'py-2',
        skeleton: <Skeleton className="h-4 w-20" />,
      },
    },
    {
      id: 'side',
      accessorKey: 'side',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Side" className="text-xs" />,
      cell: ({ row }) => {
        const position = row.original;
        return (
          <Badge
            variant={position.side === 'LONG' ? 'outline' : 'destructive'}
            className={`h-5 text-xs px-1.5 ${position.side === 'LONG' ? 'border-long text-long' : ''}`}
          >
            {position.side === 'LONG' ? (
              <TrendingUp className="h-3 w-3 mr-0.5" />
            ) : (
              <TrendingDown className="h-3 w-3 mr-0.5" />
            )}
            {position.side[0]}
          </Badge>
        );
      },
      meta: {
        headerClassName: 'text-xs',
        cellClassName: 'py-2',
        skeleton: <Skeleton className="h-5 w-8" />,
      },
    },
    {
      id: 'size',
      accessorKey: 'quantity',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Size" align="right" className="text-xs" />,
      cell: ({ row }) => {
        const position = row.original;
        return (
          <>
            <div className="text-sm font-mono">
              {formatQuantity(position.symbol, position.quantity)}
            </div>
            <div className="text-[10px] text-muted-foreground">
              ${position.margin.toFixed(2)}
            </div>
          </>
        );
      },
      meta: {
        headerClassName: 'text-xs text-right',
        cellClassName: 'text-right py-2',
        skeleton: <Skeleton className="h-4 w-16 ml-auto" />,
      },
    },
    {
      id: 'entryMark',
      header: 'Entry/Mark',
      enableSorting: false,
      cell: ({ row }) => {
        const position = row.original;
        return (
          <>
            <div className="text-sm font-mono">
              ${formatPriceWithCommas(position.symbol, position.entryPrice)}
            </div>
            <div className="text-[10px] text-muted-foreground">
              ${formatPriceWithCommas(position.symbol, position.markPrice)}
            </div>
          </>
        );
      },
      meta: {
        headerClassName: 'text-xs text-right',
        cellClassName: 'text-right py-2',
        skeleton: <Skeleton className="h-8 w-20 ml-auto" />,
      },
    },
    {
      id: 'liquidationPrice',
      header: 'Liq. Price',
      enableSorting: false,
      cell: ({ row }) => {
        const position = row.original;
        return position.liquidationPrice && position.liquidationPrice > 0 ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex flex-col items-end gap-0.5">
                  <div className="flex items-center gap-1">
                    {(() => {
                      const distancePercent = position.side === 'LONG'
                        ? ((position.markPrice - position.liquidationPrice) / position.markPrice) * 100
                        : ((position.liquidationPrice - position.markPrice) / position.markPrice) * 100;
                      const isNearLiquidation = distancePercent < 20;
                      const isCritical = distancePercent < 10;

                      return (
                        <>
                          {(isNearLiquidation || isCritical) && (
                            <AlertTriangle className={`h-3 w-3 ${isCritical ? 'text-destructive' : 'text-orange-600 dark:text-orange-400'}`} />
                          )}
                          <span className={`text-sm font-mono ${isCritical ? 'text-destructive' : isNearLiquidation ? 'text-orange-600 dark:text-orange-400' : ''}`}>
                            ${formatPriceWithCommas(position.symbol, position.liquidationPrice)}
                          </span>
                        </>
                      );
                    })()}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {(() => {
                      const distancePercent = position.side === 'LONG'
                        ? ((position.markPrice - position.liquidationPrice) / position.markPrice) * 100
                        : ((position.liquidationPrice - position.markPrice) / position.markPrice) * 100;
                      return `${distancePercent.toFixed(1)}% away`;
                    })()}
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <div className="text-xs space-y-1">
                  <p>Liquidation Price: ${formatPrice(position.symbol, position.liquidationPrice)}</p>
                  <p className="text-muted-foreground">
                    {position.side === 'LONG'
                      ? 'Position liquidates if price drops below this level'
                      : 'Position liquidates if price rises above this level'}
                  </p>
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      },
      meta: {
        headerClassName: 'text-xs text-right',
        cellClassName: 'text-right py-2',
        skeleton: <Skeleton className="h-8 w-20 ml-auto" />,
      },
    },
    {
      id: 'pnl',
      accessorKey: 'pnl',
      header: ({ column }) => <DataTableColumnHeader column={column} title="PnL" align="right" className="text-xs" />,
      cell: ({ row }) => {
        const position = row.original;
        return (
          <div className="flex flex-col items-end gap-0.5">
            <span className={`text-sm font-semibold ${position.pnl >= 0 ? 'text-profit' : 'text-loss'}`}>
              {position.pnl >= 0 ? '+' : ''}${Math.abs(position.pnl).toFixed(2)}
            </span>
            <Badge
              variant={position.pnl >= 0 ? "outline" : "destructive"}
              className={`h-3.5 text-[9px] px-1 ${position.pnl >= 0 ? 'border-profit text-profit' : ''}`}
            >
              {position.pnlPercent >= 0 ? '+' : ''}{position.pnlPercent.toFixed(1)}%
            </Badge>
          </div>
        );
      },
      meta: {
        headerClassName: 'text-xs text-right',
        cellClassName: 'text-right py-2',
        skeleton: <Skeleton className="h-8 w-16 ml-auto" />,
      },
    },
    {
      id: 'protection',
      header: 'Protection',
      enableSorting: false,
      cell: ({ row }) => {
        const position = row.original;
        const vwap = vwapData[position.symbol];
        const hasVwapProtection = config?.symbols?.[position.symbol]?.vwapProtection;

        return (
          <div className="flex flex-col items-center gap-0.5">
            <div className="flex items-center gap-0.5">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex gap-0.5">
                      {position.hasStopLoss ? (
                        <Badge variant="outline" className="h-5 w-5 p-0 border-profit">
                          <Shield className="h-3 w-3 text-profit" />
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="h-5 w-5 p-0">
                          <Shield className="h-3 w-3 text-muted-foreground" />
                        </Badge>
                      )}
                      {position.hasTakeProfit ? (
                        <Badge variant="outline" className="h-5 w-5 p-0 border-blue-600">
                          <Target className="h-3 w-3 text-blue-600" />
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="h-5 w-5 p-0">
                          <Target className="h-3 w-3 text-muted-foreground" />
                        </Badge>
                      )}
                      {hasVwapProtection && vwap ? (
                        <Badge
                          variant="outline"
                          className={`h-5 w-5 p-0 ${
                            (position.side === 'LONG' && vwap.position === 'below') ||
                            (position.side === 'SHORT' && vwap.position === 'above')
                              ? 'border-profit'
                              : 'border-orange-600'
                          }`}
                        >
                          <BarChart3
                            className={`h-3 w-3 ${
                              (position.side === 'LONG' && vwap.position === 'below') ||
                              (position.side === 'SHORT' && vwap.position === 'above')
                                ? 'text-profit'
                                : 'text-orange-600'
                            }`}
                          />
                        </Badge>
                      ) : hasVwapProtection ? (
                        <Badge variant="outline" className="h-5 w-5 p-0">
                          <BarChart3 className="h-3 w-3 text-muted-foreground animate-pulse" />
                        </Badge>
                      ) : null}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <div className="text-xs space-y-1">
                      <p>Stop Loss: {position.hasStopLoss === undefined ? '❔ Unknown (managed by the bot)' : position.hasStopLoss ? '✅ Active' : '❌ Inactive'}</p>
                      <p>Take Profit: {position.hasTakeProfit === undefined ? '❔ Unknown (managed by the bot)' : position.hasTakeProfit ? '✅ Active' : '❌ Inactive'}</p>
                      {hasVwapProtection && vwap && (
                        <>
                          <p>VWAP: ${formatPrice(position.symbol, vwap.value)}</p>
                          <p className="text-muted-foreground">
                            {position.side === 'LONG' && vwap.position === 'below' && '✅ Long below VWAP (Good)'}
                            {position.side === 'LONG' && vwap.position === 'above' && '⚠️ Long above VWAP (Risky)'}
                            {position.side === 'SHORT' && vwap.position === 'above' && '✅ Short above VWAP (Good)'}
                            {position.side === 'SHORT' && vwap.position === 'below' && '⚠️ Short below VWAP (Risky)'}
                          </p>
                        </>
                      )}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            {hasVwapProtection && vwap && (
              <div className="text-[9px] text-muted-foreground font-mono">
                V:${formatPrice(position.symbol, vwap.value)}
              </div>
            )}
          </div>
        );
      },
      meta: {
        headerClassName: 'text-xs text-center',
        cellClassName: 'text-center py-2',
        skeleton: <Skeleton className="h-5 w-20 mx-auto" />,
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      enableSorting: false,
      cell: ({ row }) => {
        const position = row.original;
        return (
          <Button
            variant="destructive"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              handleClosePosition(position);
            }}
            className="h-7 px-2 text-xs"
          >
            <X className="h-3 w-3 mr-1" />
            Close
          </Button>
        );
      },
      meta: {
        headerClassName: 'text-xs text-center',
        cellClassName: 'text-center py-2',
        skeleton: <Skeleton className="h-8 w-16 mx-auto" />,
      },
    },
  ], [config?.symbols, vwapData, formatPrice, formatQuantity, formatPriceWithCommas, handleClosePosition]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <CardTitle className="text-base font-medium">Positions</CardTitle>
          <Badge variant="secondary" className="h-5 text-xs px-1.5">
            {displayPositions.length}
          </Badge>
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
        </button>
      </CardHeader>

      {!isCollapsed && (
        <CardContent className="pt-0">
          <DataTable
            columns={columns}
            data={displayPositions}
            getRowId={(position) => `${position.symbol}-${position.side}`}
            loading={isLoading}
            loadingRows={3}
            rowClassName="h-12"
            headerRowClassName="h-8"
            emptyState={
              loadError ? (
                // An outage must not look like a flat book
                <div role="alert" className="flex flex-col items-center gap-1">
                  <span className="flex items-center gap-1 text-sm text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Couldn&apos;t load positions — retrying
                  </span>
                  <span className="text-[10px] text-muted-foreground">{loadError}</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-1">
                  <span className="text-sm text-muted-foreground">No open positions</span>
                  <Badge variant="secondary" className="h-4 text-[10px] px-1.5">
                    Waiting for trades
                  </Badge>
                </div>
              )
            }
          />
        </CardContent>
      )}

      {/* Close Position Confirmation Modal */}
      <Dialog open={closePositionModal.isOpen} onOpenChange={cancelClosePosition}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Close Position</DialogTitle>
            <DialogDescription>
              Are you sure you want to close this position? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-sm font-medium">Symbol:</span>
                <span className="text-sm">{closePositionModal.symbol}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm font-medium">Side:</span>
                <Badge
                  variant={closePositionModal.side === 'LONG' ? 'outline' : 'destructive'}
                  className={`text-xs ${closePositionModal.side === 'LONG' ? 'border-long text-long' : ''}`}
                >
                  {closePositionModal.side === 'LONG' ? (
                    <TrendingUp className="h-3 w-3 mr-1" />
                  ) : (
                    <TrendingDown className="h-3 w-3 mr-1" />
                  )}
                  {closePositionModal.side}
                </Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-sm font-medium">Quantity:</span>
                <span className="text-sm font-mono">
                  {closePositionModal.quantity > 0 ? formatQuantity(closePositionModal.symbol, closePositionModal.quantity) : '0'}
                </span>
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={cancelClosePosition}
              disabled={isClosingPosition}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmClosePosition}
              disabled={isClosingPosition}
            >
              {isClosingPosition ? 'Closing...' : 'Close Position'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}