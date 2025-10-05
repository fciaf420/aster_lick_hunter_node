'use client';

import React from 'react';
import { Activity, Zap, AlertCircle, CheckCircle, XCircle, Clock } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useBotStatus, formatUptime } from '@/hooks/useBotStatus';

export default function BotControls() {
  const { status, isConnected, lastMessage } = useBotStatus();

  const getConnectionBadge = () => {
    if (!isConnected) {
      return (
        <Badge variant="destructive" className="flex items-center gap-1">
          <XCircle className="h-3 w-3" />
          Disconnected
        </Badge>
      );
    }

    if (!status?.isRunning) {
      return (
        <Badge variant="secondary" className="flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          Connected (Bot Idle)
        </Badge>
      );
    }

    return (
      <Badge variant="default" className="flex items-center gap-1">
        <CheckCircle className="h-3 w-3 animate-pulse" />
        Running
      </Badge>
    );
  };

  const formatTime = (date: Date | null | string | undefined) => {
    if (!date) return 'N/A';
    const d = typeof date === 'string' ? new Date(date) : date;
    const now = new Date();
    const diff = now.getTime() - d.getTime();

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleString();
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              Bot Status
            </CardTitle>
            <CardDescription>
              Real-time bot monitoring
            </CardDescription>
          </div>
          {getConnectionBadge()}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!isConnected ? (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Bot is not connected. Make sure the bot is running using <code className="rounded bg-muted px-1 py-0.5">npm start</code> or <code className="rounded bg-muted px-1 py-0.5">npm run dev</code>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {/* Status Grid */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-sm text-muted-foreground">Mode</div>
                <div className="font-medium">
                  {status?.paperMode ? (
                    <Badge variant="secondary">Paper Trading</Badge>
                  ) : (
                    <Badge variant="default">Live Trading</Badge>
                  )}
                </div>
              </div>

              <div>
                <div className="text-sm text-muted-foreground">Uptime</div>
                <div className="font-medium flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {formatUptime(status?.uptime || 0)}
                </div>
              </div>

              <div>
                <div className="text-sm text-muted-foreground">Positions</div>
                <div className="font-medium">
                  {status?.positionsOpen || 0} Open
                </div>
              </div>

              <div>
                <div className="text-sm text-muted-foreground">Total PnL</div>
                <div className={`font-medium ${
                  (status?.totalPnL || 0) >= 0
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-red-600 dark:text-red-400'
                }`}>
                  ${(status?.totalPnL || 0).toFixed(2)}
                </div>
              </div>
            </div>

            <Separator />

            {/* Symbols */}
            <div>
              <div className="text-sm text-muted-foreground mb-2">Active Symbols</div>
              <div className="flex flex-wrap gap-1">
                {status?.symbols.length ? (
                  status.symbols.map((symbol) => (
                    <Badge key={symbol} variant="outline" className="text-xs">
                      {symbol}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">No symbols configured</span>
                )}
              </div>
            </div>

            {/* Last Activity */}
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Last Activity</span>
              <span className="flex items-center gap-1">
                <Activity className="h-3 w-3" />
                {lastMessage || formatTime(status?.lastActivity)}
              </span>
            </div>

            {/* Errors */}
            {status?.errors && status.errors.length > 0 && (
              <>
                <Separator />
                <div>
                  <div className="text-sm text-muted-foreground mb-2">Recent Errors</div>
                  <div className="space-y-1 max-h-24 overflow-y-auto">
                    {status.errors.slice(-3).map((error, i) => (
                      <div key={i} className="text-xs text-red-600 dark:text-red-400">
                        {error}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </>
        )}

        <div className="rounded-lg bg-muted p-3">
          <p className="text-xs text-muted-foreground">
            <strong>Note:</strong> The bot runs alongside the web interface.
            Use <code className="rounded bg-background px-1 py-0.5">npm start</code> to run both together.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}