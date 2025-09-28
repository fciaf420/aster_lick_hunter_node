'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from '@/components/ui/dialog';
import { X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

interface ClosePositionButtonProps {
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  pnl: number;
  pnlPercent: number;
  disabled?: boolean;
  onCloseSuccess?: () => void;
}

export default function ClosePositionButton({
  symbol,
  side,
  quantity,
  pnl,
  pnlPercent,
  disabled = false,
  onCloseSuccess,
}: ClosePositionButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const handleClosePosition = async () => {
    setIsLoading(true);

    try {
      console.log(`[ClosePositionButton] Closing ${symbol} ${side} position`);

      const response = await fetch('/api/positions/close', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          symbol,
          side,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      console.log(`[ClosePositionButton] Close success:`, data);

      // Show success toast
      toast.success('Position Close Initiated', {
        description: `${symbol} ${side} position close order placed`,
        duration: 4000,
      });

      // Close the dialog
      setIsDialogOpen(false);

      // Call success callback
      if (onCloseSuccess) {
        onCloseSuccess();
      }

    } catch (error) {
      console.error('[ClosePositionButton] Close failed:', error);

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Show error toast
      toast.error('Position Close Failed', {
        description: errorMessage,
        duration: 6000,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const formatCurrency = (value: number) => {
    const formatted = Math.abs(value).toFixed(2);
    return `${value >= 0 ? '+' : '-'}$${formatted}`;
  };

  const formatPercentage = (value: number) => {
    const formatted = Math.abs(value).toFixed(2);
    return `${value >= 0 ? '+' : '-'}${formatted}%`;
  };

  return (
    <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || isLoading}
          className="h-7 px-2 text-xs border-red-600 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-400 dark:text-red-400 dark:hover:bg-red-950 dark:hover:text-red-300"
        >
          {isLoading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <X className="h-3 w-3" />
          )}
          <span className="ml-1">Close</span>
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <X className="h-5 w-5 text-red-600" />
            Close Position
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3">
              <p>
                Are you sure you want to close this position? This will immediately place a market order to close the entire position.
              </p>

              {/* Position Details */}
              <div className="bg-muted/50 rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Position</span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">{symbol}</span>
                    <Badge
                      variant={side === 'LONG' ? 'outline' : 'destructive'}
                      className={`h-5 text-xs ${side === 'LONG' ? 'border-green-600 text-green-600' : ''}`}
                    >
                      {side}
                    </Badge>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Quantity</span>
                  <span className="font-mono text-sm">{quantity.toFixed(4)}</span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Current PnL</span>
                  <div className="flex items-center gap-1">
                    <span className={`font-mono text-sm ${pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {formatCurrency(pnl)}
                    </span>
                    <Badge
                      variant={pnl >= 0 ? "outline" : "destructive"}
                      className={`h-4 text-[10px] px-1 ${pnl >= 0 ? 'border-green-600 text-green-600' : ''}`}
                    >
                      {formatPercentage(pnlPercent)}
                    </Badge>
                  </div>
                </div>
              </div>

              <div className="bg-yellow-50 dark:bg-yellow-950/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3">
                <p className="text-sm text-yellow-800 dark:text-yellow-200">
                  <strong>Warning:</strong> This will place a market order which may experience slippage.
                  Any existing stop-loss and take-profit orders will be cancelled automatically.
                </p>
              </div>
            </div>
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={isLoading}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            onClick={handleClosePosition}
            disabled={isLoading}
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Closing...
              </>
            ) : (
              <>
                <X className="h-4 w-4 mr-2" />
                Close Position
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}