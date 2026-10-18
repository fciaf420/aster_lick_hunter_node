'use client';

import React from 'react';
import { useFormContext, useWatch } from 'react-hook-form';
import { AlertCircle, Shield, TrendingUp } from 'lucide-react';
import type { Config } from '@/lib/types';
import { getVenueEntry } from '@/lib/exchange/catalog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { NativeSelectOption } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import { NativeSelectField, NumberField, SwitchField, TextField } from './fields';
import { hedgePositionModeAvailable, lighterHedgeConfigured } from './form-state';

// "Global Settings" tab: risk and trading mode, and the dashboard server
export function GlobalTab() {
  const { control } = useFormContext<Config>();
  const [exchange, lighter, paperMode, useThresholdSystem, useRemoteWebSocket, dashboardPassword] = useWatch({
    control,
    name: [
      'global.exchange',
      'venues.lighter',
      'global.paperMode',
      'global.useThresholdSystem',
      'global.server.useRemoteWebSocket',
      'global.server.dashboardPassword',
    ],
  });
  const venueEntry = getVenueEntry(exchange);
  const hedgeCheck = { global: { exchange }, venues: { lighter } };
  const hedgeAvailable = hedgePositionModeAvailable(hedgeCheck);
  const lighterHedge = !venueEntry.supportsHedgeMode && lighterHedgeConfigured(hedgeCheck);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Global Settings</CardTitle>
          <CardDescription>
            Risk management and trading mode configuration
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <NumberField
            name="global.riskPercent"
            id="riskPercent"
            label="Risk Percentage"
            description="Maximum percentage of your account to risk across all positions"
            suffix="% of account balance at risk"
            inputClassName="w-24"
            min="0.1"
            max="100"
            step="0.1"
          />

          <Separator />

          <SwitchField
            name="global.paperMode"
            id="paperMode"
            label="Paper Mode"
            description="Enable simulation mode for risk-free testing"
          />

          {paperMode && (
            <div className="rounded-lg bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 p-4">
              <p className="text-sm text-blue-700 dark:text-blue-400 flex items-center gap-2">
                <Shield className="h-4 w-4" />
                Paper mode is enabled - No real trades will be executed
              </p>
            </div>
          )}

          <Separator />

          <NativeSelectField
            name="global.positionMode"
            id="positionMode"
            label="Position Mode"
            fallback="ONE_WAY"
            description="One-way: All positions use BOTH | Hedge: Separate LONG and SHORT positions"
            footer={
              lighterHedge ? (
                <p className="text-xs text-blue-600 dark:text-blue-400">
                  Lighter: hedge mode uses two sub-accounts (see Hedge mode in the Lighter settings)
                </p>
              ) : !venueEntry.supportsHedgeMode && (
                <p className="text-xs text-yellow-600 dark:text-yellow-500">
                  {venueEntry.name} only supports one-way positions
                  {venueEntry.id === 'lighter' && ' on one account; hedge mode needs a second sub-account (see Hedge mode in the Lighter settings)'}
                </p>
              )
            }
          >
            <NativeSelectOption value="ONE_WAY">One-way Mode (BOTH)</NativeSelectOption>
            <NativeSelectOption value="HEDGE" disabled={!hedgeAvailable}>
              Hedge Mode (LONG/SHORT){hedgeAvailable
                ? ''
                : venueEntry.id === 'lighter'
                  ? ' - set up hedge mode in the Lighter settings first'
                  : ` - not supported on ${venueEntry.name}`}
            </NativeSelectOption>
          </NativeSelectField>

          <NumberField
            name="global.maxOpenPositions"
            id="maxOpenPositions"
            label="Max Open Positions"
            suffix="Maximum concurrent positions (hedged pairs count as one)"
            inputClassName="w-24"
            integer
            placeholder="10"
            min="1"
            max="50"
            step="1"
          />

          <NumberField
            name="global.liquidationRetentionDays"
            id="liquidationRetentionDays"
            label="Liquidation History Retention (days)"
            suffix="Recorded liquidations and candles older than this are deleted daily (0 keeps everything)"
            inputClassName="w-24"
            integer
            clamp={(days) => Math.max(0, days)}
            placeholder="7"
            min="0"
            step="1"
          />

          <Separator />

          {/* Threshold System Setting */}
          <div className="space-y-4">
            <SwitchField
              name="global.useThresholdSystem"
              icon={<TrendingUp className="h-4 w-4" />}
              label="60-Second Volume Threshold System"
              description="Accumulate liquidation volume over 60-second windows"
            />
            {useThresholdSystem && (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  When enabled, trades will only trigger when cumulative liquidation volume in a 60-second window meets the threshold. Configure per-symbol settings in the symbols tab.
                </AlertDescription>
              </Alert>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Server Settings Card */}
      <Card>
        <CardHeader>
          <CardTitle>Server Settings</CardTitle>
          <CardDescription>
            Dashboard security and network configuration
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <TextField
            name="global.server.dashboardPassword"
            id="dashboardPassword"
            type="password"
            label="Dashboard Password"
            description="Set a password to protect your dashboard when exposing it to external networks"
            placeholder="Enter dashboard password (min 4 characters)"
            minLength={4}
          />

          <Separator />

          <NumberField
            name="global.server.dashboardPort"
            id="dashboardPort"
            label="Dashboard Port"
            suffix="Port for the web dashboard (default: 3000)"
            inputClassName="w-24"
            integer
            placeholder="3000"
            min="1024"
            max="65535"
          />

          <NumberField
            name="global.server.websocketPort"
            id="websocketPort"
            label="WebSocket Port"
            suffix="Port for WebSocket server communication (default: 8080)"
            inputClassName="w-24"
            integer
            placeholder="8080"
            min="1024"
            max="65535"
          />

          <Separator />

          <div className="space-y-4">
            <SwitchField
              inline
              name="global.server.useRemoteWebSocket"
              id="useRemoteWebSocket"
              label="Enable Remote WebSocket Access"
              descriptionClassName="text-xs"
              description="Allow the dashboard to connect to the bot from remote machines. When enabled, the WebSocket will automatically use the browser's hostname instead of localhost."
            />

            {useRemoteWebSocket && (
              <TextField
                name="global.server.websocketHost"
                id="websocketHost"
                className="pl-6"
                label="WebSocket Host (Optional)"
                description="Leave empty to auto-detect the host from your browser's location. Only set this if you need a specific hostname or IP address."
                placeholder="Auto-detect from browser (recommended)"
                parse={(host) => host || null}
              />
            )}
          </div>

          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <strong>Note:</strong> After changing ports, you&apos;ll need to restart the application and access it at the new port.
              {dashboardPassword && " Password protection is active - you'll need to login to access the dashboard."}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </>
  );
}
