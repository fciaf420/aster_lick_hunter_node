'use client';

import React from 'react';
import { useFormContext, useWatch } from 'react-hook-form';
import { AlertCircle, RotateCcw } from 'lucide-react';
import type { Config } from '@/lib/types';
import type { LiquidationSourceId, VenueId } from '@/lib/exchange/types';
import { getVenueEntry } from '@/lib/exchange/catalog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { VenueSelector } from '@/components/VenueSelector';
import { LighterFields, type LighterPositionMode } from '@/components/LighterSettings';
import { TextField } from './fields';
import { hedgePositionModeAvailable } from './form-state';

// "Exchange" tab: trading venue, liquidation source and the credentials of the selected venue
export function ExchangeTab() {
  const { control, getValues, setValue } = useFormContext<Config>();
  const [exchange, liquidationSource, positionMode] = useWatch({
    control,
    name: ['global.exchange', 'global.liquidationSource', 'global.positionMode'],
  });
  const [apiKey, secretKey] = useWatch({ control, name: ['api.apiKey', 'api.secretKey'] });
  const venueEntry = getVenueEntry(exchange);

  const handleVenueChange = (venue: VenueId) => {
    const values = getValues();
    setValue('global.exchange', venue, { shouldDirty: true });
    // Venues without hedge mode can only run one-way positions (Lighter: unless hedge mode is set up)
    if (!hedgePositionModeAvailable({ ...values, global: { ...values.global, exchange: venue } }) && values.global.positionMode === 'HEDGE') {
      setValue('global.positionMode', 'ONE_WAY', { shouldDirty: true });
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Exchange</CardTitle>
          <CardDescription>
            Choose where the bot trades and where its liquidation signals come from
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <VenueSelector
            venue={exchange}
            onVenueChange={handleVenueChange}
            liquidationSource={liquidationSource}
            onLiquidationSourceChange={(source: LiquidationSourceId) => setValue('global.liquidationSource', source, { shouldDirty: true })}
          />
          <Alert>
            <RotateCcw className="h-4 w-4" />
            <AlertDescription>
              Changing the trading venue or liquidation source takes effect after the bot restarts.
              Only switch venues when you have no open positions.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {venueEntry.id === 'aster' ? (
        <Card>
          <CardHeader>
            <CardTitle>API Configuration</CardTitle>
            <CardDescription>
              Connect your {venueEntry.name} API for live trading or leave empty for paper mode
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <TextField
              name="api.apiKey"
              id="apiKey"
              label="API Key"
              description="Your API key for exchange authentication"
              placeholder="Enter your API key (optional for paper mode)"
              inputClassName="font-mono"
            />

            <TextField
              name="api.secretKey"
              id="secretKey"
              label="Secret Key"
              description="Your secret key is encrypted and never shared"
              reveal="secret key"
              placeholder="Enter your secret key (optional for paper mode)"
              inputClassName="font-mono"
            />

            {!apiKey && !secretKey && (
              <div className="rounded-lg bg-muted p-4">
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <AlertCircle className="h-4 w-4" />
                  No API keys configured - Bot will run in paper mode only
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      ) : venueEntry.id === 'lighter' ? (
        <Card>
          <CardHeader>
            <CardTitle>Lighter Configuration</CardTitle>
            <CardDescription>
              Network and API key for trading on Lighter (USDC margin), or leave the key empty for paper mode
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LighterFields
              showCredentials
              showLiquidationFeed={liquidationSource === 'lighter'}
              showHedge
              positionMode={positionMode}
              onPositionModeChange={(mode: LighterPositionMode) => setValue('global.positionMode', mode, { shouldDirty: true })}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-lg bg-muted p-4">
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            Credentials for {venueEntry.name} can be entered once it is supported.
          </p>
        </div>
      )}

      {venueEntry.id !== 'lighter' && liquidationSource === 'lighter' && (
        <Card>
          <CardHeader>
            <CardTitle>Lighter Liquidation Feed</CardTitle>
            <CardDescription>
              Liquidation signals from Lighter&apos;s public trade stream (no Lighter API key needed)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LighterFields showCredentials={false} showLiquidationFeed idPrefix="lighter-feed" />
          </CardContent>
        </Card>
      )}
    </>
  );
}
