'use client';

import React, { useState, useEffect } from 'react';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';

interface OptimizerWeightSlidersProps {
  pnlWeight: number;
  sharpeWeight: number;
  drawdownWeight: number;
  onPnlWeightChange: (value: number) => void;
  onSharpeWeightChange: (value: number) => void;
  onDrawdownWeightChange: (value: number) => void;
}

/**
 * OptimizerWeightSliders Component
 *
 * Customizable weight controls for PnL/Sharpe/Drawdown scoring
 * Auto-adjusts Drawdown weight to maintain 100% sum when PnL or Sharpe changes
 * Uses internal state to avoid stale closure issues
 */
export function OptimizerWeightSliders({
  pnlWeight: initialPnl,
  sharpeWeight: initialSharpe,
  drawdownWeight: initialDrawdown,
  onPnlWeightChange,
  onSharpeWeightChange,
  onDrawdownWeightChange,
}: OptimizerWeightSlidersProps) {
  // Internal state to avoid stale closures in parent callbacks
  const [pnl, setPnl] = useState(initialPnl);
  const [sharpe, setSharpe] = useState(initialSharpe);
  const [drawdown, setDrawdown] = useState(initialDrawdown);

  // Sync with external props when they change
  useEffect(() => {
    setPnl(initialPnl);
    setSharpe(initialSharpe);
    setDrawdown(initialDrawdown);
  }, [initialPnl, initialSharpe, initialDrawdown]);

  const total = pnl + sharpe + drawdown;
  const isValid = Math.abs(total - 100) < 0.1;

  const handlePnlChange = (value: number) => {
    const newDrawdown = Math.max(0, Math.min(100, 100 - value - sharpe));

    setPnl(value);
    setDrawdown(newDrawdown);

    // Call parent callbacks with final values
    onPnlWeightChange(value);
    onDrawdownWeightChange(newDrawdown);
  };

  const handleSharpeChange = (value: number) => {
    const newDrawdown = Math.max(0, Math.min(100, 100 - pnl - value));

    setSharpe(value);
    setDrawdown(newDrawdown);

    // Call parent callbacks with final values
    onSharpeWeightChange(value);
    onDrawdownWeightChange(newDrawdown);
  };

  const handleDrawdownChange = (value: number) => {
    setDrawdown(value);
    onDrawdownWeightChange(value);
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="pnl-weight">PnL Weight</Label>
          <span className="text-sm font-medium">{pnl}%</span>
        </div>
        <Slider
          id="pnl-weight"
          min={0}
          max={100}
          step={5}
          value={[pnl]}
          onValueChange={(value) => handlePnlChange(value[0])}
          className="w-full"
        />
        <p className="text-xs text-muted-foreground">
          Prioritize total profit generation
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="sharpe-weight">Sharpe Ratio Weight</Label>
          <span className="text-sm font-medium">{sharpe}%</span>
        </div>
        <Slider
          id="sharpe-weight"
          min={0}
          max={100}
          step={5}
          value={[sharpe]}
          onValueChange={(value) => handleSharpeChange(value[0])}
          className="w-full"
        />
        <p className="text-xs text-muted-foreground">
          Prioritize consistency & risk-adjusted returns
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="drawdown-weight">Drawdown Protection Weight</Label>
          <span className="text-sm font-medium">{drawdown}%</span>
        </div>
        <Slider
          id="drawdown-weight"
          min={0}
          max={100}
          step={5}
          value={[drawdown]}
          onValueChange={(value) => handleDrawdownChange(value[0])}
          className="w-full"
        />
        <p className="text-xs text-muted-foreground">
          Prioritize capital preservation
        </p>
      </div>

      <div className="pt-2 border-t space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Total:</span>
          <span className={`font-medium ${isValid ? 'text-green-600 dark:text-green-400' : 'text-destructive'}`}>
            {total.toFixed(1)}%
            {!isValid && ' (Must equal 100%)'}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          💡 Tip: Adjusting PnL or Sharpe will auto-adjust Drawdown to maintain 100% total
        </p>
      </div>
    </div>
  );
}

