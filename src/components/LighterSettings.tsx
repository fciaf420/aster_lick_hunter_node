'use client';

import React, { useState } from 'react';
import { AlertCircle, AlertTriangle, ArrowLeftRight, CheckCircle2, Eye, EyeOff, Globe, Radio, Wallet } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import type { LighterHedgeAccountConfig, LighterVenueConfig } from '@/lib/types';
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
  lighterHedgeState,
  lighterShortAccountProblems,
} from '@/lib/config/types';

// Lighter network, credentials and liquidation-feed settings (config.venues.lighter).
// The credentials are bound to the selected network: keys, account indexes and nonces differ per network.

const HEX_KEY = /^(0x)?[0-9a-fA-F]{80}$/;
const HEX_KEY_MESSAGE = 'Expected 40 bytes of hex (80 characters)';
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

export type LighterPositionMode = 'ONE_WAY' | 'HEDGE';

export interface LighterShortAccountFieldErrors {
  accountIndex?: string;
  apiKeyIndex?: string;
  apiKeyPrivateKey?: string;
  apiKeyPublicKey?: string;
}

// Format, range and same-index errors of the hedge-mode short account fields. Missing fields are not errors here:
// the status line names them (lighterShortAccountProblems). Never echoes the keys.
export function lighterShortAccountFieldErrors(value: LighterVenueConfig | undefined): LighterShortAccountFieldErrors {
  const short = value?.hedge?.shortAccount;
  const errors: LighterShortAccountFieldErrors = {};
  const index = short?.accountIndex;
  if (index !== undefined) {
    if (!Number.isSafeInteger(index) || index < 1 || index > LIGHTER_MAX_ACCOUNT_INDEX) {
      errors.accountIndex = `Must be 1-${LIGHTER_MAX_ACCOUNT_INDEX}`;
    } else if (value?.accountIndex !== undefined && index === value.accountIndex) {
      errors.accountIndex = 'Must differ from the main (long) account index';
    }
  }
  const keyIndex = short?.apiKeyIndex;
  if (keyIndex !== undefined && (!Number.isInteger(keyIndex) || keyIndex < 0 || keyIndex > LIGHTER_MAX_API_KEY_INDEX)) {
    errors.apiKeyIndex = `Must be 0-${LIGHTER_MAX_API_KEY_INDEX}`;
  }
  if (short?.apiKeyPrivateKey && !HEX_KEY.test(short.apiKeyPrivateKey.trim())) errors.apiKeyPrivateKey = HEX_KEY_MESSAGE;
  if (short?.apiKeyPublicKey && !HEX_KEY.test(short.apiKeyPublicKey.trim())) errors.apiKeyPublicKey = HEX_KEY_MESSAGE;
  return errors;
}

interface LighterSettingsProps {
  value: LighterVenueConfig | undefined;
  onChange: (next: LighterVenueConfig) => void;
  showCredentials?: boolean;       // Trading on Lighter: account, API key, slippage, tx rate
  showLiquidationFeed?: boolean;   // Lighter liquidation source: shadow / live switch
  showHedge?: boolean;             // Hedge mode over two sub-accounts (needs showCredentials)
  positionMode?: LighterPositionMode;                              // global.positionMode, for the hedge status
  onPositionModeChange?: (mode: LighterPositionMode) => void;     // Sets global.positionMode
  idPrefix?: string;               // Keeps input ids unique when rendered twice on a page
}

export function LighterSettings({
  value,
  onChange,
  showCredentials = true,
  showLiquidationFeed = false,
  showHedge = false,
  positionMode,
  onPositionModeChange,
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
  const hedgeShown = showCredentials && showHedge;

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
          {hedgeShown && settings.hedge?.enabled === true && (
            <p className="flex items-center gap-2 text-xs text-blue-700 dark:text-blue-400" data-testid="lighter-main-account-hint">
              <ArrowLeftRight className="h-4 w-4 shrink-0" />
              Main account = long account: in hedge mode every long is opened here, every short on the short account below.
            </p>
          )}
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
                ? HEX_KEY_MESSAGE
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
                ? HEX_KEY_MESSAGE
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

      {hedgeShown && (
        <LighterHedgeSettings
          settings={settings}
          onChange={onChange}
          positionMode={positionMode}
          onPositionModeChange={onPositionModeChange}
          id={id}
        />
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

// Hedge mode emulation over two sub-accounts (config.venues.lighter.hedge): longs on the main account above, shorts on
// a second sub-account with its own API key. The bot only uses it when position mode is HEDGE too (lighterHedgeState).
function LighterHedgeSettings({
  settings,
  onChange,
  positionMode,
  onPositionModeChange,
  id,
}: {
  settings: LighterVenueConfig;
  onChange: (next: LighterVenueConfig) => void;
  positionMode?: LighterPositionMode;
  onPositionModeChange?: (mode: LighterPositionMode) => void;
  id: (name: string) => string;
}) {
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const hedge = settings.hedge ?? {};
  const short = hedge.shortAccount ?? {};
  const enabled = hedge.enabled === true;
  const errors = lighterShortAccountFieldErrors(settings);
  const hasFieldErrors = Object.keys(errors).length > 0;
  const state = lighterHedgeState({ global: { exchange: 'lighter', positionMode }, venues: { lighter: settings } });
  const shortProblems = lighterShortAccountProblems(settings);

  const setEnabled = (checked: boolean) => {
    onChange({ ...settings, hedge: { ...settings.hedge, enabled: checked } });
    // Hedge mode needs position mode HEDGE; turning it off goes back to one-way, which is what the bot then runs
    onPositionModeChange?.(checked ? 'HEDGE' : 'ONE_WAY');
  };

  const updateShort = (patch: Partial<LighterHedgeAccountConfig>) => {
    onChange({ ...settings, hedge: { ...settings.hedge, shortAccount: { ...settings.hedge?.shortAccount, ...patch } } });
  };

  const hint = (error: string | undefined, text: string) => (
    <p className={`text-xs ${error ? 'text-red-600' : 'text-muted-foreground'}`}>{error ?? text}</p>
  );

  // lighterShortAccountProblems names every field "short account ...": shortened after the "Short account" prefix
  const missing = (problems: string[]) => problems.map(problem => problem.replace(/^short account /, '')).join(', ');

  let status: React.ReactNode;
  if (!enabled) {
    status = (
      <p className="text-muted-foreground">
        Hedge mode is off: the bot trades one-way on the main account (an opposite signal reduces or flips the position).
      </p>
    );
  } else if (state.mode === 'on') {
    status = hasFieldErrors ? (
      <p className="flex items-center gap-2 text-red-600">
        <AlertCircle className="h-4 w-4 shrink-0" />
        Short account has invalid fields: fix the marked fields before saving
      </p>
    ) : (
      <p className="flex items-center gap-2 text-green-700 dark:text-green-500">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        Hedge mode active after the bot restarts
      </p>
    );
  } else if (state.mode === 'incomplete') {
    status = (
      <p className="flex items-start gap-2 text-yellow-700 dark:text-yellow-500">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Short account incomplete: {missing(state.problems)}. Until it is complete the bot trades one-way on the main
          account in paper mode, and does not start live.
        </span>
      </p>
    );
  } else {
    status = (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-yellow-700 dark:text-yellow-500">
            <AlertCircle className="h-4 w-4 shrink-0" />
            Position mode is One-way
          </p>
          {onPositionModeChange && (
            <Button type="button" variant="outline" size="sm" onClick={() => onPositionModeChange('HEDGE')}>
              Use hedge position mode
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Hedge mode needs position mode Hedge (Global Settings); in one-way mode the short account is not used.
        </p>
        {shortProblems.length > 0 && (
          <p className="text-xs text-yellow-700 dark:text-yellow-500">
            Short account incomplete: {missing(shortProblems)}.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border p-4" data-testid="lighter-hedge-section">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <ArrowLeftRight className="h-4 w-4" />
            <Label htmlFor={id('hedgeEnabled')}>Hedge mode (two sub-accounts)</Label>
            {enabled ? <Badge>Enabled</Badge> : <Badge variant="secondary">Off</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">
            Lighter nets one position per market per account. With hedge mode, longs go on the main account (above) and
            shorts on a second sub-account, so a long and a short on one symbol can be open together, each with its own
            SL/TP.
          </p>
        </div>
        <Switch id={id('hedgeEnabled')} checked={enabled} onCheckedChange={setEnabled} />
      </div>

      <div className="flex items-start gap-2 rounded-md border border-blue-300 bg-blue-50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-400">
        <Wallet className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Fund both accounts with USDC. Each account has its own margin and liquidation price, and the bot never moves
          funds between them.
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={id('shortAccountIndex')}>Short account index</Label>
          <Input
            id={id('shortAccountIndex')}
            type="number"
            inputMode="numeric"
            min={1}
            max={LIGHTER_MAX_ACCOUNT_INDEX}
            step={1}
            value={short.accountIndex ?? ''}
            onChange={(e) => updateShort({ accountIndex: parseIndex(e.target.value) })}
            placeholder="e.g. 23456"
            className="font-mono"
            aria-invalid={errors.accountIndex ? true : undefined}
          />
          {hint(errors.accountIndex, 'A second sub-account of the same master, for the shorts')}
        </div>
        <div className="space-y-2">
          <Label htmlFor={id('shortApiKeyIndex')}>Short account API key index</Label>
          <Input
            id={id('shortApiKeyIndex')}
            type="number"
            inputMode="numeric"
            min={0}
            max={LIGHTER_MAX_API_KEY_INDEX}
            step={1}
            value={short.apiKeyIndex ?? ''}
            onChange={(e) => updateShort({ apiKeyIndex: parseIndex(e.target.value) })}
            placeholder="e.g. 4"
            className="font-mono"
            aria-invalid={errors.apiKeyIndex ? true : undefined}
          />
          {hint(errors.apiKeyIndex, 'A key registered on the short account, not 0')}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={id('shortApiKeyPrivateKey')}>Short account API private key</Label>
        <div className="relative">
          <Input
            id={id('shortApiKeyPrivateKey')}
            type={showPrivateKey ? 'text' : 'password'}
            autoComplete="off"
            value={short.apiKeyPrivateKey ?? ''}
            onChange={(e) => updateShort({ apiKeyPrivateKey: e.target.value.trim() || undefined })}
            placeholder="80 hex characters (optional 0x)"
            className="font-mono pr-10"
            aria-invalid={errors.apiKeyPrivateKey ? true : undefined}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={showPrivateKey ? 'Hide short account API private key' : 'Show short account API private key'}
            className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
            onClick={() => setShowPrivateKey(!showPrivateKey)}
          >
            {showPrivateKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </div>
        {hint(errors.apiKeyPrivateKey, 'Signs the short account\'s orders inside the bot process only')}
      </div>

      <div className="space-y-2">
        <Label htmlFor={id('shortApiKeyPublicKey')}>Short account API public key</Label>
        <Input
          id={id('shortApiKeyPublicKey')}
          type="text"
          autoComplete="off"
          value={short.apiKeyPublicKey ?? ''}
          onChange={(e) => updateShort({ apiKeyPublicKey: e.target.value.trim() || undefined })}
          placeholder="80 hex characters (optional 0x)"
          className="font-mono"
          aria-invalid={errors.apiKeyPublicKey ? true : undefined}
        />
        {hint(errors.apiKeyPublicKey, 'Checked at startup against the key registered for the short account')}
      </div>

      <div className="rounded-lg bg-muted p-3 text-sm" data-testid="lighter-hedge-status" aria-live="polite">
        {status}
      </div>

      {state.mode !== 'on' && short.accountIndex !== undefined && (
        <p className="text-xs text-muted-foreground">
          While hedge mode is not active, the bot does not manage short account {short.accountIndex}: positions there keep
          their exchange SL/TP only until those expire (28 days after they were placed), and the bot neither renews nor
          resizes them.
        </p>
      )}

      <p className="text-xs text-muted-foreground">Changes apply after the bot restarts.</p>
    </div>
  );
}

export default LighterSettings;
