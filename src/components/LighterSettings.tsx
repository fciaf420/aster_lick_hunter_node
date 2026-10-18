'use client';

import React, { useState } from 'react';
import { AlertCircle, AlertTriangle, Eye, EyeOff, Globe, Radio } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import type { LighterVenueConfig } from '@/lib/types';
import {
  DEFAULT_LIGHTER_PROFILE,
  LIGHTER_PROFILE_NAMES,
  PROFILES,
  isLighterProfileName,
  type LighterProfile,
} from '@/lib/exchange/lighter/profiles';
import {
  LIGHTER_MAX_ACCOUNT_INDEX,
  LIGHTER_MAX_API_KEY_INDEX,
  LIGHTER_MAX_SEND_TX_PER_MIN,
  LIGHTER_MAX_SLTP_SLIPPAGE_PCT,
} from '@/lib/config/types';

// Lighter network, credentials and liquidation-feed settings (config.venues.lighter).
// The credentials are bound to the selected network: keys, account indexes and nonces differ per network.

const HEX_KEY = /^(0x)?[0-9a-fA-F]{80}$/;
const SELECT_CLASS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

export function lighterProfileOf(value: LighterVenueConfig | undefined): LighterProfile {
  return PROFILES[isLighterProfileName(value?.profile) ? value.profile : DEFAULT_LIGHTER_PROFILE];
}

// Whether the bot has everything it needs to sign for this account (formats are checked on save)
export function hasLighterCredentials(value: LighterVenueConfig | undefined): boolean {
  return value?.accountIndex !== undefined && value?.apiKeyIndex !== undefined &&
    !!value?.apiKeyPrivateKey && !!value?.apiKeyPublicKey;
}

// Banner naming the network the bot talks to, so testnet and real funds are never confused
export function LighterNetworkBanner({ value }: { value: LighterVenueConfig | undefined }) {
  const profile = lighterProfileOf(value);
  const tone = profile.testnet
    ? 'border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-400'
    : 'border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/20 dark:text-red-400';
  return (
    <div role="status" data-testid="lighter-network-banner" className={`flex items-center gap-2 rounded-lg border p-3 text-sm ${tone}`}>
      <Globe className="h-4 w-4 shrink-0" />
      <span>
        <strong>{profile.label}</strong> (chain {profile.chainId}) -{' '}
        {profile.testnet ? 'test funds only' : 'REAL FUNDS'}
      </span>
    </div>
  );
}

function parseIndex(text: string): number | undefined {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}

function parsePositive(text: string): number | undefined {
  const value = Number(text);
  return text.trim() !== '' && Number.isFinite(value) && value > 0 ? value : undefined;
}

interface LighterSettingsProps {
  value: LighterVenueConfig | undefined;
  onChange: (next: LighterVenueConfig) => void;
  showCredentials?: boolean;       // Trading on Lighter: account, API key, slippage, tx rate
  showLiquidationFeed?: boolean;   // Lighter liquidation source: shadow / live switch
  idPrefix?: string;               // Keeps input ids unique when rendered twice on a page
}

export function LighterSettings({
  value,
  onChange,
  showCredentials = true,
  showLiquidationFeed = false,
  idPrefix = 'lighter',
}: LighterSettingsProps) {
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const settings = value ?? {};
  const profile = lighterProfileOf(settings);
  const id = (name: string) => `${idPrefix}-${name}`;

  const update = (patch: Partial<LighterVenueConfig>) => {
    onChange({ ...settings, ...patch });
  };

  const privateKeyInvalid = !!settings.apiKeyPrivateKey && !HEX_KEY.test(settings.apiKeyPrivateKey.trim());
  const publicKeyInvalid = !!settings.apiKeyPublicKey && !HEX_KEY.test(settings.apiKeyPublicKey.trim());
  const apiKeyIndexInvalid = settings.apiKeyIndex !== undefined && settings.apiKeyIndex > LIGHTER_MAX_API_KEY_INDEX;
  const live = settings.liquidationsLive === true;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor={id('profile')}>Lighter network</Label>
        <select
          id={id('profile')}
          value={profile.name}
          onChange={(e) => {
            const next = e.target.value;
            if (isLighterProfileName(next) && !PROFILES[next].gated) update({ profile: next });
          }}
          className={SELECT_CLASS}
        >
          {LIGHTER_PROFILE_NAMES.map((name) => (
            <option key={name} value={name} disabled={PROFILES[name].gated}>
              {PROFILES[name].label}
              {name === DEFAULT_LIGHTER_PROFILE ? ' (default)' : ''}
              {PROFILES[name].gated ? ' - not available until verified' : ''}
            </option>
          ))}
        </select>
        <LighterNetworkBanner value={settings} />
        <p className="text-xs text-muted-foreground">
          API keys, account indexes and nonces are per network: keys created on testnet do not work on mainnet.
          Changing the network takes effect after the bot restarts.
        </p>
      </div>

      {showCredentials && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={id('accountIndex')}>Account index</Label>
              <Input
                id={id('accountIndex')}
                type="number"
                inputMode="numeric"
                min={1}
                max={LIGHTER_MAX_ACCOUNT_INDEX}
                step={1}
                value={settings.accountIndex ?? ''}
                onChange={(e) => update({ accountIndex: parseIndex(e.target.value) })}
                placeholder="e.g. 12345"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">Your {profile.label} account (or sub-account) index</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('apiKeyIndex')}>API key index</Label>
              <Input
                id={id('apiKeyIndex')}
                type="number"
                inputMode="numeric"
                min={0}
                max={LIGHTER_MAX_API_KEY_INDEX}
                step={1}
                value={settings.apiKeyIndex ?? ''}
                onChange={(e) => update({ apiKeyIndex: parseIndex(e.target.value) })}
                placeholder="e.g. 3"
                className="font-mono"
              />
              <p className={`text-xs ${apiKeyIndexInvalid ? 'text-red-600' : 'text-muted-foreground'}`}>
                {apiKeyIndexInvalid ? `Must be 0-${LIGHTER_MAX_API_KEY_INDEX}` : 'Use a dedicated key, not 0 (app.lighter.xyz uses key 0)'}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor={id('apiKeyPrivateKey')}>API private key</Label>
            <div className="relative">
              <Input
                id={id('apiKeyPrivateKey')}
                type={showPrivateKey ? 'text' : 'password'}
                autoComplete="off"
                value={settings.apiKeyPrivateKey ?? ''}
                onChange={(e) => update({ apiKeyPrivateKey: e.target.value.trim() || undefined })}
                placeholder="80 hex characters (optional 0x)"
                className="font-mono pr-10"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={showPrivateKey ? 'Hide API private key' : 'Show API private key'}
                className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                onClick={() => setShowPrivateKey(!showPrivateKey)}
              >
                {showPrivateKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <p className={`text-xs ${privateKeyInvalid ? 'text-red-600' : 'text-muted-foreground'}`}>
              {privateKeyInvalid
                ? 'Expected 40 bytes of hex (80 characters)'
                : 'Signs orders inside the bot process only; it is never sent to the dashboard clients'}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor={id('apiKeyPublicKey')}>API public key</Label>
            <Input
              id={id('apiKeyPublicKey')}
              type="text"
              autoComplete="off"
              value={settings.apiKeyPublicKey ?? ''}
              onChange={(e) => update({ apiKeyPublicKey: e.target.value.trim() || undefined })}
              placeholder="80 hex characters (optional 0x)"
              className="font-mono"
            />
            <p className={`text-xs ${publicKeyInvalid ? 'text-red-600' : 'text-muted-foreground'}`}>
              {publicKeyInvalid
                ? 'Expected 40 bytes of hex (80 characters)'
                : 'At startup the bot checks it against the key registered for this account and key index'}
            </p>
          </div>

          {!hasLighterCredentials(settings) && (
            <div className="rounded-lg bg-muted p-4">
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <AlertCircle className="h-4 w-4" />
                Lighter credentials incomplete - the bot will run in paper mode only
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={id('sltpSlippagePct')}>SL/TP slippage (%)</Label>
              <Input
                id={id('sltpSlippagePct')}
                type="number"
                min={0.01}
                max={LIGHTER_MAX_SLTP_SLIPPAGE_PCT}
                step={0.1}
                value={settings.sltpSlippagePct ?? ''}
                onChange={(e) => update({ sltpSlippagePct: parsePositive(e.target.value) })}
                placeholder="1"
              />
              <p className="text-xs text-muted-foreground">
                Worst fill price of a triggered stop loss / take profit, beyond the trigger (default 1%)
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('sendTxPerMin')}>Transactions per minute</Label>
              <Input
                id={id('sendTxPerMin')}
                type="number"
                min={1}
                max={LIGHTER_MAX_SEND_TX_PER_MIN}
                step={1}
                value={settings.sendTxPerMin ?? ''}
                onChange={(e) => update({ sendTxPerMin: parseIndex(e.target.value) })}
                placeholder="60"
              />
              <p className="text-xs text-muted-foreground">Client-side send limit (default 60); applies after a restart</p>
            </div>
          </div>
        </div>
      )}

      {showLiquidationFeed && (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor={id('liquidationsLive')} className="flex items-center gap-2">
                <Radio className="h-4 w-4" />
                Trade on Lighter liquidations
                {live ? <Badge variant="destructive">Live</Badge> : <Badge variant="secondary">Shadow mode</Badge>}
              </Label>
              <p className="text-xs text-muted-foreground">
                Off (shadow mode): the bot watches {profile.label}&apos;s trade stream, detects liquidations and logs them with
                cross-checks, but never trades on them.
              </p>
            </div>
            <Switch
              id={id('liquidationsLive')}
              checked={live}
              onCheckedChange={(checked) => update({ liquidationsLive: checked })}
            />
          </div>
          {live ? (
            <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/20 dark:text-red-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Live: detected Lighter liquidations are traded. Which side was liquidated is inferred from Lighter&apos;s trade
                data (it is not documented), so only go live after at least 7 days of shadow-mode logs that match the market.
              </span>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Run shadow mode for at least 7 days and compare the logged liquidations (side, size, price) with the market before
              switching it live.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default LighterSettings;
