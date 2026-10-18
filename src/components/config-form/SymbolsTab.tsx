'use client';

import React, { useEffect, useState } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';
import { AlertCircle, BarChart3, Plus, Settings2, Trash2, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import type { Config } from '@/lib/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { symbolSettingDefault } from '@/lib/config/defaults';
import { NumberField, SelectField, SwitchField, useHasErrors } from './fields';
import { SYMBOL_NAME_PATTERN, getDefaultSymbolConfig } from './form-state';

interface SymbolsTabProps {
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
}

// "Symbols" tab: the symbols the bot trades, and the settings of the selected one
export function SymbolsTab({ selectedSymbol, onSelectSymbol }: SymbolsTabProps) {
  const { getValues, setValue, unregister } = useFormContext<Config>();
  const symbols = useWatch<Config, 'symbols'>({ name: 'symbols' }) ?? {};
  const symbolNames = Object.keys(symbols);

  const [newSymbol, setNewSymbol] = useState('');
  const [availableSymbols, setAvailableSymbols] = useState<{ symbol: string }[]>([]);
  const [loadingSymbols, setLoadingSymbols] = useState(false);
  const [symbolSearch, setSymbolSearch] = useState('');
  const [showSymbolPicker, setShowSymbolPicker] = useState(false);

  // Fetch available symbols when the symbols tab is clicked
  const fetchAvailableSymbols = async () => {
    if (availableSymbols.length > 0) return; // Already loaded

    setLoadingSymbols(true);
    try {
      const response = await fetch('/api/symbols');
      if (!response.ok) {
        throw new Error('Failed to fetch symbols');
      }
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error('Invalid response type');
      }
      const data = await response.json();
      if (data.symbols) {
        setAvailableSymbols(data.symbols);
      }
    } catch (error) {
      console.error('Failed to fetch symbols:', error);
      toast.error('Failed to load available symbols');
    } finally {
      setLoadingSymbols(false);
    }
  };

  const addSymbol = (symbolToAdd?: string) => {
    const symbol = symbolToAdd || newSymbol;
    if (symbol && !getValues('symbols')?.[symbol]) {
      if (!SYMBOL_NAME_PATTERN.test(symbol)) {
        toast.error(`${symbol} is not a valid symbol name: it cannot contain dots, brackets or quotes`);
        return;
      }
      setValue(`symbols.${symbol}`, getDefaultSymbolConfig(), { shouldDirty: true });
      onSelectSymbol(symbol);
      setNewSymbol('');
      setShowSymbolPicker(false);
      setSymbolSearch('');
      toast.success(`Added ${symbol} to configuration`);
    }
  };

  const removeSymbol = (symbol: string) => {
    // Takes the symbol's settings along with the defaults they were loaded from, so adding it again starts fresh
    unregister(`symbols.${symbol}`);
    // Removing the last symbol removes the then empty symbols object too
    if (!getValues('symbols')) setValue('symbols', {}, { shouldDirty: true });
    if (selectedSymbol === symbol) {
      onSelectSymbol('');
    }
    toast.success(`Removed ${symbol} from configuration`);
  };

  const pickable = availableSymbols.filter((s) => !symbols[s.symbol] && (!symbolSearch || s.symbol.includes(symbolSearch)));

  return (
    <div className="space-y-4" onFocus={fetchAvailableSymbols}>
      <Card>
        <CardHeader>
          <CardTitle>Symbol Configuration</CardTitle>
          <CardDescription>
            Configure trading parameters for each symbol
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              type="text"
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
              placeholder="Enter symbol manually (e.g., BTCUSDT)"
              aria-label="Symbol"
              onKeyDown={(e) => e.key === 'Enter' && addSymbol()}
            />
            <Button type="button" onClick={() => addSymbol()} className="flex items-center gap-2">
              <Plus className="h-4 w-4" />
              Add Manual
            </Button>
            <Button
              type="button"
              onClick={() => {
                fetchAvailableSymbols();
                setShowSymbolPicker(!showSymbolPicker);
              }}
              variant="outline"
              className="flex items-center gap-2"
            >
              <Settings2 className="h-4 w-4" />
              Browse Symbols
            </Button>
          </div>

          {/* Symbol Picker */}
          {showSymbolPicker && (
            <Card className="border-2">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Available Symbols</CardTitle>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setShowSymbolPicker(false)}>
                    ✕
                  </Button>
                </div>
                <Input
                  type="text"
                  value={symbolSearch}
                  onChange={(e) => setSymbolSearch(e.target.value.toUpperCase())}
                  placeholder="Search symbols..."
                  aria-label="Search symbols"
                  className="mt-2"
                />
              </CardHeader>
              <CardContent className="max-h-96 overflow-y-auto">
                {loadingSymbols ? (
                  <div className="text-center py-4 text-muted-foreground">
                    Loading available symbols...
                  </div>
                ) : (
                  <div className="space-y-1">
                    {pickable
                      .slice(0, 50) // Show max 50 results
                      .map((symbolInfo) => (
                        <div
                          key={symbolInfo.symbol}
                          className="flex items-center justify-between p-2 rounded hover:bg-accent cursor-pointer"
                          onClick={() => addSymbol(symbolInfo.symbol)}
                        >
                          <div className="flex items-center gap-3">
                            <span className="font-medium">{symbolInfo.symbol}</span>
                          </div>
                          <Button type="button" size="sm" variant="ghost">
                            <Plus className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                    {symbolSearch && pickable.length === 0 && (
                      <div className="text-center py-4 text-muted-foreground">
                        No matching symbols found
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {symbolNames.length > 0 && (
            <>
              <div className="flex gap-2 flex-wrap">
                {symbolNames.map((symbol) => (
                  <Badge
                    key={symbol}
                    asChild
                    variant={selectedSymbol === symbol ? 'default' : 'outline'}
                    className="cursor-pointer py-1.5 px-3"
                  >
                    <button type="button" aria-pressed={selectedSymbol === symbol} onClick={() => onSelectSymbol(symbol)}>
                      {symbol}
                    </button>
                  </Badge>
                ))}
              </div>

              {selectedSymbol && symbols[selectedSymbol] && (
                SYMBOL_NAME_PATTERN.test(selectedSymbol) ? (
                  <SymbolSettings key={selectedSymbol} symbol={selectedSymbol} onRemove={() => removeSymbol(selectedSymbol)} />
                ) : (
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      {selectedSymbol} has dots, brackets or quotes in its name, which this form cannot address. Edit it in config.user.json.
                    </AlertDescription>
                  </Alert>
                )
              )}
            </>
          )}

          {symbolNames.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <Settings2 className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No symbols configured yet</p>
              <p className="text-sm">Add a symbol above to get started</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ===== Settings of one symbol =====

interface SymbolDetails {
  minNotional: number;
  minQty: number;
  currentPrice: number;
}

// Margin the exchange needs for the smallest order, at the symbol's leverage
function rawMinimumMargin(details: SymbolDetails, leverage: unknown): number {
  const lev = Number(leverage) || 1;
  // The larger of the notional requirement and the quantity requirement
  return Math.max(details.minNotional / lev, (details.minQty * details.currentPrice) / lev);
}

interface MarginHintProps {
  size: unknown;
  leverage: unknown;
  details: SymbolDetails | null;
  loading: boolean;
  side?: boolean;       // Long / short size: shorter texts
}

// What the exchange needs at least as margin for this symbol (with a 30% buffer against price moves), and
// whether the trade size reaches it
function MarginHint({ size, leverage, details, loading, side = false }: MarginHintProps) {
  const raw = details ? rawMinimumMargin(details, leverage) : null;
  const recommended = raw === null ? null : raw * 1.3;
  const tooLow = recommended !== null && (Number(size) || 0) < recommended;
  return (
    <>
      {details && !loading && recommended && raw !== null && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Badge variant={tooLow ? 'destructive' : 'default'} className="text-xs">
              {side ? `Recommended: $${recommended.toFixed(2)}` : `Recommended: $${recommended.toFixed(2)} USDT`}
            </Badge>
            {tooLow && (
              <Badge variant="destructive" className="text-xs">
                {side ? 'Too low!' : 'Too low - may be rejected!'}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {side ? `Min: $${raw.toFixed(2)} + 30% buffer` : `Exchange min: $${raw.toFixed(2)} @ ${Number(leverage) || 1}x (30% buffer added)`}
          </p>
        </div>
      )}
      {loading && !side && (
        <p className="text-xs text-muted-foreground">
          Loading minimum requirements...
        </p>
      )}
    </>
  );
}

function SymbolSettings({ symbol, onRemove }: { symbol: string; onRemove: () => void }) {
  const { control, getValues, setValue } = useFormContext<Config>();
  const path = <K extends keyof Config['symbols'][string]>(field: K) => `symbols.${symbol}.${field}` as const;
  const [leverage, tradeSize, longTradeSize, shortTradeSize, legacyThreshold, forceMarketEntry, vwapProtection, useThreshold] = useWatch({
    control,
    name: [
      path('leverage'),
      path('tradeSize'),
      path('longTradeSize'),
      path('shortTradeSize'),
      path('volumeThresholdUSDT'),
      path('forceMarketEntry'),
      path('vwapProtection'),
      path('useThreshold'),
    ],
  });
  const useThresholdSystem = useWatch<Config, 'global.useThresholdSystem'>({ name: 'global.useThresholdSystem' });

  // Settings that are shown only while their switch is on stay shown while they have an error: it still blocks Save
  const vwapErrors = useHasErrors(path('vwapTimeframe'), path('vwapLookback'));
  const thresholdErrors = useHasErrors(path('useThreshold'), path('thresholdTimeWindow'), path('thresholdCooldown'));

  // What an empty setting falls back to for this symbol
  const marginDefault = symbolSettingDefault(symbol, 'maxPositionMarginUSDT');
  const lookbackDefault = symbolSettingDefault(symbol, 'vwapLookback');
  const windowDefaultMs = symbolSettingDefault(symbol, 'thresholdTimeWindow');
  const cooldownDefaultMs = symbolSettingDefault(symbol, 'thresholdCooldown');
  const seconds = (ms: number | undefined) => (ms === undefined ? undefined : ms / 1000);
  const legacyHint = typeof legacyThreshold === 'number' ? ` Empty uses the legacy volume threshold (${legacyThreshold}).` : '';

  // Separate long and short sizes are on while either is set (null: cleared)
  const [separateSizes, setSeparateSizes] = useState(
    () => getValues(path('longTradeSize')) != null || getValues(path('shortTradeSize')) != null
  );

  const [details, setDetails] = useState<SymbolDetails | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  // Fetch the exchange's minimums when a symbol is selected
  useEffect(() => {
    let current = true;
    setLoadingDetails(true);
    (async () => {
      try {
        const response = await fetch(`/api/symbol-details/${symbol}`);
        if (!response.ok) {
          throw new Error('Failed to fetch symbol details');
        }
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          throw new Error('Invalid response type');
        }
        const data = await response.json();
        if (current) setDetails(data);
      } catch (error) {
        console.error('Failed to fetch symbol details:', error);
        if (current) setDetails(null);
      } finally {
        if (current) setLoadingDetails(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [symbol]);

  const toggleSeparateSizes = (checked: boolean) => {
    setSeparateSizes(checked);
    if (checked) {
      // Start from the shared trade size, unless a size was set before
      const shared = getValues(path('tradeSize'));
      setValue(path('longTradeSize'), getValues(path('longTradeSize')) ?? shared, { shouldDirty: true });
      setValue(path('shortTradeSize'), getValues(path('shortTradeSize')) ?? shared, { shouldDirty: true });
    } else {
      // Remove the separate sizes: cleared fields are left out of the payload
      setValue(path('longTradeSize'), null as never, { shouldDirty: true });
      setValue(path('shortTradeSize'), null as never, { shouldDirty: true });
    }
  };

  // An emptied long or short size goes back to the shared trade size when the field loses focus
  const resetSizeWhenEmpty = (field: 'longTradeSize' | 'shortTradeSize') => (e: React.FocusEvent<HTMLInputElement>) => {
    if (e.target.value === '') {
      setValue(path(field), getValues(path('tradeSize')), { shouldDirty: true });
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">{symbol} Settings</CardTitle>
          <Button type="button" variant="destructive" size="sm" onClick={onRemove} className="flex items-center gap-1">
            <Trash2 className="h-4 w-4" />
            Remove
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4">
        <NumberField
          name={path('longVolumeThresholdUSDT')}
          label="Long Volume Threshold (USDT)"
          description={`Min liquidation volume for longs (buy on sell liquidations).${legacyHint}`}
          placeholder={typeof legacyThreshold === 'number' ? String(legacyThreshold) : undefined}
          min="0"
        />

        <NumberField
          name={path('shortVolumeThresholdUSDT')}
          label="Short Volume Threshold (USDT)"
          description={`Min liquidation volume for shorts (sell on buy liquidations).${legacyHint}`}
          placeholder={typeof legacyThreshold === 'number' ? String(legacyThreshold) : undefined}
          min="0"
        />

        <NumberField
          name={path('leverage')}
          label="Leverage"
          description="Trading leverage (1-125x)"
          integer
          min="1"
          max="125"
        />

        {/* Trade Size Configuration */}
        <div className="col-span-2 space-y-4">
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={`${symbol}-separate-trade-sizes`} className="text-base">Trade Size Configuration</FieldLabel>
              <FieldDescription>Use different sizes for long and short positions</FieldDescription>
            </FieldContent>
            <Switch id={`${symbol}-separate-trade-sizes`} checked={separateSizes} onCheckedChange={toggleSeparateSizes} />
          </Field>

          {!separateSizes ? (
            <NumberField
              name={path('tradeSize')}
              label="Trade Size (USDT)"
              description="Position size in USDT (used for both long and short)"
              footer={<MarginHint size={tradeSize} leverage={leverage} details={details} loading={loadingDetails} />}
              min="0"
              step="0.01"
            />
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <NumberField
                name={path('longTradeSize')}
                label={<>Long Trade Size (USDT)<Badge variant="outline" className="text-xs">BUY</Badge></>}
                description="Margin used for long positions (buy on sell liquidations)"
                footer={<MarginHint side size={longTradeSize || tradeSize} leverage={leverage} details={details} loading={loadingDetails} />}
                onBlur={resetSizeWhenEmpty('longTradeSize')}
                min="0"
                step="0.01"
              />
              <NumberField
                name={path('shortTradeSize')}
                label={<>Short Trade Size (USDT)<Badge variant="outline" className="text-xs">SELL</Badge></>}
                description="Margin used for short positions (sell on buy liquidations)"
                footer={<MarginHint side size={shortTradeSize || tradeSize} leverage={leverage} details={details} loading={loadingDetails} />}
                onBlur={resetSizeWhenEmpty('shortTradeSize')}
                min="0"
                step="0.01"
              />
            </div>
          )}
        </div>

        <NumberField
          name={path('maxPositionMarginUSDT')}
          label="Max Position Margin (USDT)"
          description={`Max total margin exposure for this symbol. ${marginDefault === undefined ? 'Empty means no limit.' : `Empty uses ${marginDefault}.`}`}
          placeholder={marginDefault === undefined ? 'No limit' : String(marginDefault)}
          min="0"
        />

        <NumberField
          name={path('slPercent')}
          label="Stop Loss (%)"
          description="Stop loss percentage"
          min="0.1"
          step="0.1"
        />

        <NumberField
          name={path('tpPercent')}
          label="Take Profit (%)"
          description="Take profit percentage"
          min="0.1"
          step="0.1"
        />

        {/* Order Type Settings */}
        <div className="col-span-2">
          <Separator className="my-4" />
          <div className="space-y-4">
            <SelectField
              name={path('orderType')}
              label="Order Type"
              description="Default order type for opening positions"
              fallback="LIMIT"
              options={[
                { value: 'LIMIT', label: 'LIMIT Orders (Better fills)' },
                { value: 'MARKET', label: 'MARKET Orders (Instant fills)' },
              ]}
            />

            <SwitchField
              name={path('forceMarketEntry')}
              label="Force Market Entry"
              description="Always use MARKET orders for opening positions (overrides order type above)"
            />

            {forceMarketEntry && (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  <strong>Market Entry Forced:</strong> All opening orders will use MARKET type for instant fills,
                  regardless of the order type setting above. This ensures faster entry but may have higher slippage.
                </AlertDescription>
              </Alert>
            )}
          </div>
        </div>

        {/* VWAP Protection Settings */}
        <div className="col-span-2">
          <Separator className="my-4" />
          <div className="space-y-4">
            <SwitchField
              name={path('vwapProtection')}
              icon={<BarChart3 className="h-4 w-4" />}
              label="VWAP Protection"
              description="Block entries against VWAP trend"
            />

            {(vwapProtection || vwapErrors) && (
              <div className="grid grid-cols-2 gap-4 pt-2">
                <SelectField
                  name={path('vwapTimeframe')}
                  label="VWAP Timeframe"
                  description="Candle timeframe for VWAP calculation"
                  fallback="1m"
                  options={[
                    { value: '1m', label: '1 minute' },
                    { value: '5m', label: '5 minutes' },
                    { value: '15m', label: '15 minutes' },
                    { value: '30m', label: '30 minutes' },
                    { value: '1h', label: '1 hour' },
                  ]}
                />

                <NumberField
                  name={path('vwapLookback')}
                  label="Lookback Period"
                  description={`Number of candles for VWAP (10-500). Empty uses ${lookbackDefault}.`}
                  integer
                  placeholder={String(lookbackDefault)}
                  min="10"
                  max="500"
                />
              </div>
            )}

            {!vwapProtection && vwapErrors && (
              <p className="text-xs text-muted-foreground">VWAP Protection is off, but these values are invalid: fix or clear them to save.</p>
            )}

            {vwapProtection && (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  <strong>VWAP Protection Active:</strong> Long positions will only open when price is below VWAP.
                  Short positions will only open when price is above VWAP. This helps avoid entering against the trend.
                </AlertDescription>
              </Alert>
            )}
          </div>
        </div>

        {/* Threshold System Settings - Only show if global threshold is enabled (or a setting of it is invalid) */}
        {(useThresholdSystem || thresholdErrors) && (
          <div className="col-span-2">
            <Separator className="my-4" />
            <div className="space-y-4">
              <SwitchField
                name={path('useThreshold')}
                icon={<TrendingUp className="h-4 w-4" />}
                label={`Enable Threshold System for ${symbol}`}
                description="Use 60-second cumulative volume thresholds"
              />

              {(useThreshold || thresholdErrors) && (
                <div className="space-y-4 pt-2">
                  <div className="grid grid-cols-2 gap-4">
                    <NumberField
                      name={path('thresholdTimeWindow')}
                      label="Time Window (seconds)"
                      description={`Window for accumulating volume. Empty uses ${seconds(windowDefaultMs)}s.`}
                      scale={1000}
                      placeholder={String(seconds(windowDefaultMs))}
                      min="10"
                      max="300"
                      step="10"
                    />

                    <NumberField
                      name={path('thresholdCooldown')}
                      label="Cooldown Period (seconds)"
                      description={`Cooldown between triggers. Empty uses ${seconds(cooldownDefaultMs)}s.`}
                      scale={1000}
                      placeholder={String(seconds(cooldownDefaultMs))}
                      min="10"
                      max="300"
                      step="10"
                    />
                  </div>

                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      With threshold enabled, trades will only trigger when cumulative liquidation volume
                      within the time window meets the Long/Short Volume Thresholds configured above.
                    </AlertDescription>
                  </Alert>
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
