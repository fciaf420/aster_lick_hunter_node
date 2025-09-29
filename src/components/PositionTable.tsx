'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { BarChart3, TrendingUp, TrendingDown, Shield, Target, ChevronDown } from 'lucide-react';
import ClosePositionButton from '@/components/ClosePositionButton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import websocketService from '@/lib/services/websocketService';
import { useConfig } from '@/components/ConfigProvider';
import { useSymbolPrecision } from '@/hooks/useSymbolPrecision';
import dataStore from '@/lib/services/dataStore';

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

export default function PositionTable({
  positions = [],
  onClosePosition: _onClosePosition,
}: PositionTableProps) {
  const [realPositions, setRealPositions] = useState<Position[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [markPrices, setMarkPrices] = useState<Record<string, number>>({});
  const [vwapData, setVwapData] = useState<Record<string, VWAPData>>({});
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { config } = useConfig();
  const { formatPrice, formatQuantity, formatPriceWithCommas } = useSymbolPrecision();

  // Load initial positions and set up WebSocket updates
  useEffect(() => {
    // Use data store if no positions passed as props
    if (positions.length === 0) {
      // Load initial data from data store
      dataStore.fetchPositions().then((data) => {
        setRealPositions(data);
        setIsLoading(false);
      }).catch((error) => {
        console.error('[PositionTable] Failed to load positions:', error);
        setIsLoading(false);
      });

      // Subscribe to data store events
      const handlePositionsUpdate = (data: Position[]) => {
        setRealPositions(data);
      };

      const handleMarkPricesUpdate = (prices: Record<string, number>) => {
        setMarkPrices(prices);
      };

      dataStore.on('positions:update', handlePositionsUpdate);
      dataStore.on('markPrices:update', handleMarkPricesUpdate);

      // Load initial mark prices
      const currentMarkPrices = dataStore.getMarkPrices();
      if (Object.keys(currentMarkPrices).length > 0) {
        setMarkPrices(currentMarkPrices);
      }

      // Clean up data store listeners
      const cleanupDataStore = () => {
        dataStore.off('positions:update', handlePositionsUpdate);
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
  }, [positions.length]); // Only re-run when positions prop changes

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

  // Use passed positions if available, otherwise use fetched positions
  // Apply live mark prices to calculate real-time PnL
  const displayPositions = (positions.length > 0 ? positions : realPositions).map(position => {
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
  });

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
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow className="h-8">
                  <TableHead className="text-xs">Symbol</TableHead>
                  <TableHead className="text-xs">Side</TableHead>
                  <TableHead className="text-xs text-right">Size</TableHead>
                  <TableHead className="text-xs text-right">Entry/Mark</TableHead>
                  <TableHead className="text-xs text-right">PnL</TableHead>
                  <TableHead className="text-xs text-center">Protection</TableHead>
                  <TableHead className="text-xs text-center">Actions</TableHead>
                </TableRow>
              </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i} className="h-12">
                    <TableCell className="py-2"><Skeleton className="h-4 w-20" /></TableCell>
                    <TableCell className="py-2"><Skeleton className="h-5 w-8" /></TableCell>
                    <TableCell className="py-2 text-right"><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                    <TableCell className="py-2 text-right"><Skeleton className="h-8 w-20 ml-auto" /></TableCell>
                    <TableCell className="py-2 text-right"><Skeleton className="h-8 w-16 ml-auto" /></TableCell>
                    <TableCell className="py-2 text-center"><Skeleton className="h-5 w-20 mx-auto" /></TableCell>
                    <TableCell className="py-2 text-center"><Skeleton className="h-6 w-12 mx-auto" /></TableCell>
                  </TableRow>
                ))
            ) : displayPositions.map((position) => {
              const key = `${position.symbol}-${position.side}`;
              const vwap = vwapData[position.symbol];
              const symbolConfig = config?.symbols?.[position.symbol];
              const hasVwapProtection = symbolConfig?.vwapProtection;

              return (
                <TableRow key={key} className="h-12">
                  <TableCell className="py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-sm">{position.symbol}</span>
                      <Badge variant="secondary" className="h-4 text-[10px] px-1">
                        {position.leverage}x
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell className="py-2">
                    <Badge
                      variant={position.side === 'LONG' ? 'outline' : 'destructive'}
                      className={`h-5 text-xs px-1.5 ${position.side === 'LONG' ? 'border-green-600 text-green-600 dark:border-green-400 dark:text-green-400' : ''}`}
                    >
                      {position.side === 'LONG' ? (
                        <TrendingUp className="h-3 w-3 mr-0.5" />
                      ) : (
                        <TrendingDown className="h-3 w-3 mr-0.5" />
                      )}
                      {position.side[0]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right py-2">
                    <div className="text-sm font-mono">
                      {formatQuantity(position.symbol, position.quantity)}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      ${position.margin.toFixed(2)}
                    </div>
                  </TableCell>
                  <TableCell className="text-right py-2">
                    <div className="text-sm font-mono">
                      ${formatPriceWithCommas(position.symbol, position.entryPrice)}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      ${formatPriceWithCommas(position.symbol, position.markPrice)}
                    </div>
                  </TableCell>
                  <TableCell className="text-right py-2">
                    <div className="flex flex-col items-end gap-0.5">
                      <span className={`text-sm font-semibold ${position.pnl >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {position.pnl >= 0 ? '+' : ''}${Math.abs(position.pnl).toFixed(2)}
                      </span>
                      <Badge
                        variant={position.pnl >= 0 ? "outline" : "destructive"}
                        className={`h-3.5 text-[9px] px-1 ${position.pnl >= 0 ? 'border-green-600 text-green-600 dark:border-green-400 dark:text-green-400' : ''}`}
                      >
                        {position.pnlPercent >= 0 ? '+' : ''}{position.pnlPercent.toFixed(1)}%
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell className="text-center py-2">
                    <div className="flex flex-col items-center gap-0.5">
                      <div className="flex items-center gap-0.5">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="flex gap-0.5">
                                {position.hasStopLoss ? (
                                  <Badge variant="outline" className="h-5 w-5 p-0 border-green-600">
                                    <Shield className="h-3 w-3 text-green-600" />
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
                                        ? 'border-green-600'
                                        : 'border-orange-600'
                                    }`}
                                  >
                                    <BarChart3
                                      className={`h-3 w-3 ${
                                        (position.side === 'LONG' && vwap.position === 'below') ||
                                        (position.side === 'SHORT' && vwap.position === 'above')
                                          ? 'text-green-600'
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
                                <p>Stop Loss: {position.hasStopLoss ? '✅ Active' : '❌ Inactive'}</p>
                                <p>Take Profit: {position.hasTakeProfit ? '✅ Active' : '❌ Inactive'}</p>
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
                  </TableCell>
                  <TableCell className="text-center py-2">
                    <ClosePositionButton
                      symbol={position.symbol}
                      side={position.side}
                      quantity={position.quantity}
                      pnl={position.pnl}
                      pnlPercent={position.pnlPercent}
                      onCloseSuccess={() => {
                        // Trigger data refresh or call parent callback
                        dataStore.fetchPositions();
                      }}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
              {!isLoading && displayPositions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-6">
                    <div className="flex flex-col items-center gap-1">
                      <span className="text-sm text-muted-foreground">No open positions</span>
                      <Badge variant="secondary" className="h-4 text-[10px] px-1.5">
                        Waiting for trades
                      </Badge>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      )}
    </Card>
  );
}