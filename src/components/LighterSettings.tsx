'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FormProvider, useForm, useFormContext, useFormState, useWatch } from 'react-hook-form';
import { AlertCircle, AlertTriangle, ArrowLeftRight, CheckCircle2, Globe, Radio, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NativeSelectOption } from '@/components/ui/native-select';
import { NativeSelectField, NumberField, SwitchField, TextField } from '@/components/config-form/fields';
import type { Config, LighterVenueConfig } from '@/lib/types';
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
  LIGHTER_MIN_ACCOUNT_INDEX,
  LIGHTER_MIN_API_KEY_INDEX,
  LIGHTER_MIN_SEND_TX_PER_MIN,
  lighterHedgeState,
  lighterShortAccountProblems,
} from '@/lib/config/types';
import { DEFAULT_LIGHTER_VENUE_SETTINGS } from '@/lib/config/defaults';
import { createConfigResolver, lighterSettingsFormSchema, lighterSettingsValid, withoutClearedFields } from '@/lib/config/form';

// Lighter network, credentials and liquidation-feed settings (config.venues.lighter).
// The credentials are bound to the selected network: keys, account indexes and nonces differ per network.
//
// LighterFields lives in a react-hook-form form and edits venues.lighter there (the config form provides one).
// LighterSettings wraps it for hosts that hold the settings themselves (onboarding): value in, onChange out.

export function lighterProfileOf(value: LighterVenueConfig | undefined): LighterProfile {
  return PROFILES[isLighterProfileName(value?.profile) ? value.profile : DEFAULT_LIGHTER_PROFILE];
}

const isRealNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const isKeyText = (value: unknown) => typeof value === 'string' && value !== '';

// Whether the bot has everything it needs to sign for this account (formats are checked on save). An index that is
// not a number is not there yet: a field keeps text it cannot read as typed ("12.5"), which the schema then flags.
export function hasLighterCredentials(value: LighterVenueConfig | undefined): boolean {
  return isRealNumber(value?.accountIndex) && isRealNumber(value?.apiKeyIndex) &&
    isKeyText(value?.apiKeyPrivateKey) && isKeyText(value?.apiKeyPublicKey);
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

// Indexes and counts are typed as digits. Anything else stays in the field as typed so the schema can flag it.
function parseIndex(text: string): number | string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

function parsePositive(text: string): number | string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : trimmed;
}

const parseKey = (text: string) => text.trim() || null;

export type LighterPositionMode = 'ONE_WAY' | 'HEDGE';

interface LighterFieldsProps {
  showNetwork?: boolean;           // The network picker (default: shown)
  showCredentials?: boolean;       // Trading on Lighter: account, API key, slippage, tx rate
  showLiquidationFeed?: boolean;   // Lighter liquidation source: shadow / live switch
  showHedge?: boolean;             // Hedge mode over two sub-accounts (needs showCredentials)
  positionMode?: LighterPositionMode;                              // global.positionMode, for the hedge status
  onPositionModeChange?: (mode: LighterPositionMode) => void;     // Sets global.positionMode
  idPrefix?: string;               // Keeps input ids unique when rendered twice on a page
  inactiveVenue?: string;          // Name of the trading venue when it is not Lighter: these settings are shown to be fixed, not used
}

// The Lighter settings as they will be saved: cleared fields (null in the form) and the objects that only hold
// them are left out
function useLighterSettings(): LighterVenueConfig {
  const lighter = useWatch<Config, 'venues.lighter'>({ name: 'venues.lighter' });
  return useMemo(() => withoutClearedFields(lighter ?? {}), [lighter]);
}

export function LighterFields({
  showNetwork = true,
  showCredentials = true,
  showLiquidationFeed = false,
  showHedge = false,
  positionMode,
  onPositionModeChange,
  idPrefix = 'lighter',
  inactiveVenue,
}: LighterFieldsProps) {
  const { trigger } = useFormContext<Config>();
  const settings = useLighterSettings();
  // The config form's trading mode, for the hedge status (the standalone form has none)
  const paperMode = useWatch<Config, 'global.paperMode'>({ name: 'global.paperMode' });
  const profile = lighterProfileOf(settings);
  const id = (name: string) => `${idPrefix}-${name}`;
  const live = settings.liquidationsLive === true;
  const hedgeShown = showCredentials && showHedge;

  // Settings that were saved malformed are flagged straight away, not only once they are edited
  useEffect(() => {
    void trigger('venues.lighter');
  }, [trigger]);

  return (
    <div className="space-y-5">
      {showNetwork && (
        <NativeSelectField
          name="venues.lighter.profile"
          id={id('profile')}
          label="Lighter network"
          fallback={profile.name}
          // Gated networks (Robinhood) are listed but cannot be picked
          onValueChange={(next) => isLighterProfileName(next) && !PROFILES[next].gated}
          aside={<LighterNetworkBanner value={settings} />}
          description="API keys, account indexes and nonces are per network: keys created on testnet do not work on mainnet. Changing the network takes effect after the bot restarts."
        >
          {LIGHTER_PROFILE_NAMES.map((name) => (
            <NativeSelectOption key={name} value={name} disabled={PROFILES[name].gated}>
              {PROFILES[name].label}
              {name === DEFAULT_LIGHTER_PROFILE ? ' (default)' : ''}
              {PROFILES[name].gated ? ' - not available until verified' : ''}
            </NativeSelectOption>
          ))}
        </NativeSelectField>
      )}

      {showCredentials && (
        <div className="space-y-4">
          {hedgeShown && settings.hedge?.enabled === true && (
            <p className="flex items-center gap-2 text-xs text-blue-700 dark:text-blue-400" data-testid="lighter-main-account-hint">
              <ArrowLeftRight className="h-4 w-4 shrink-0" />
              Main account = long account: in hedge mode every long is opened here, every short on the short account below.
            </p>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <NumberField
              name="venues.lighter.accountIndex"
              id={id('accountIndex')}
              label="Account index"
              description={`Your ${profile.label} account (or sub-account) index`}
              inputMode="numeric"
              min={LIGHTER_MIN_ACCOUNT_INDEX}
              max={LIGHTER_MAX_ACCOUNT_INDEX}
              step={1}
              placeholder="e.g. 12345"
              inputClassName="font-mono"
              parse={parseIndex}
              // The short account must differ from this one
              deps={['venues.lighter.hedge.shortAccount.accountIndex']}
            />
            <NumberField
              name="venues.lighter.apiKeyIndex"
              id={id('apiKeyIndex')}
              label="API key index"
              description="Use a dedicated key, not 0 (app.lighter.xyz uses key 0)"
              inputMode="numeric"
              min={LIGHTER_MIN_API_KEY_INDEX}
              max={LIGHTER_MAX_API_KEY_INDEX}
              step={1}
              placeholder="e.g. 3"
              inputClassName="font-mono"
              parse={parseIndex}
            />
          </div>

          <TextField
            name="venues.lighter.apiKeyPrivateKey"
            id={id('apiKeyPrivateKey')}
            label="API private key"
            description="Signs orders inside the bot process only; it is never sent to the dashboard clients"
            reveal="API private key"
            autoComplete="off"
            placeholder="80 hex characters (optional 0x)"
            inputClassName="font-mono"
            parse={parseKey}
          />

          <TextField
            name="venues.lighter.apiKeyPublicKey"
            id={id('apiKeyPublicKey')}
            label="API public key"
            description="At startup the bot checks it against the key registered for this account and key index"
            autoComplete="off"
            placeholder="80 hex characters (optional 0x)"
            inputClassName="font-mono"
            parse={parseKey}
          />

          {!inactiveVenue && !hasLighterCredentials(settings) && (
            <div className="rounded-lg bg-muted p-4">
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <AlertCircle className="h-4 w-4" />
                Lighter credentials incomplete - the bot will run in paper mode only
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <NumberField
              name="venues.lighter.sltpSlippagePct"
              id={id('sltpSlippagePct')}
              label="SL/TP slippage (%)"
              description={`Worst fill price of a triggered stop loss / take profit, beyond the trigger. Empty uses ${DEFAULT_LIGHTER_VENUE_SETTINGS.sltpSlippagePct}%.`}
              min={0.01}
              max={LIGHTER_MAX_SLTP_SLIPPAGE_PCT}
              step={0.1}
              placeholder={String(DEFAULT_LIGHTER_VENUE_SETTINGS.sltpSlippagePct)}
              parse={parsePositive}
            />
            <NumberField
              name="venues.lighter.sendTxPerMin"
              id={id('sendTxPerMin')}
              label="Transactions per minute"
              description={`Client-side send limit; applies after a restart. Empty uses ${DEFAULT_LIGHTER_VENUE_SETTINGS.sendTxPerMin}.`}
              min={LIGHTER_MIN_SEND_TX_PER_MIN}
              max={LIGHTER_MAX_SEND_TX_PER_MIN}
              step={1}
              placeholder={String(DEFAULT_LIGHTER_VENUE_SETTINGS.sendTxPerMin)}
              parse={parseIndex}
            />
          </div>
        </div>
      )}

      {hedgeShown && (
        <LighterHedgeSettings
          settings={settings}
          paperMode={paperMode}
          positionMode={positionMode}
          onPositionModeChange={onPositionModeChange}
          inactiveVenue={inactiveVenue}
          id={id}
        />
      )}

      {showLiquidationFeed && (
        <div className="space-y-3 rounded-lg border p-4">
          <SwitchField
            name="venues.lighter.liquidationsLive"
            id={id('liquidationsLive')}
            icon={<Radio className="h-4 w-4" />}
            label="Trade on Lighter liquidations"
            badge={live ? <Badge variant="destructive">Live</Badge> : <Badge variant="secondary">Shadow mode</Badge>}
            descriptionClassName="text-xs"
            description={
              <>
                Off (shadow mode): the bot watches {profile.label}&apos;s trade stream, detects liquidations and logs them with
                cross-checks, but never trades on them.
              </>
            }
          />
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
  paperMode,
  positionMode,
  onPositionModeChange,
  inactiveVenue,
  id,
}: {
  settings: LighterVenueConfig;
  paperMode?: boolean;
  positionMode?: LighterPositionMode;
  onPositionModeChange?: (mode: LighterPositionMode) => void;
  inactiveVenue?: string;
  id: (name: string) => string;
}) {
  const short = settings.hedge?.shortAccount ?? {};
  const enabled = settings.hedge?.enabled === true;
  // Format, range and same-index errors come from the schema; fields that are missing are named by the status line
  const { errors } = useFormState<Config>({ name: 'venues.lighter.hedge.shortAccount' });
  const hasFieldErrors = Object.keys(errors.venues?.lighter?.hedge?.shortAccount ?? {}).length > 0;
  const state = lighterHedgeState({ global: { exchange: 'lighter', positionMode }, venues: { lighter: settings } });
  const shortProblems = lighterShortAccountProblems(settings);

  // lighterShortAccountProblems names every field "short account ...": shortened after the "Short account" prefix
  const missing = (problems: string[]) => problems.map(problem => problem.replace(/^short account /, '')).join(', ');

  let status: React.ReactNode;
  if (inactiveVenue) {
    status = <p className="text-muted-foreground">Not in use: the bot trades on {inactiveVenue}.</p>;
  } else if (!enabled) {
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
          Short account incomplete: {missing(state.problems)}.{' '}
          {paperMode === false
            ? 'Saving is refused in live mode until it is complete: fill it in or turn hedge mode off.'
            : 'Until it is complete the bot trades one-way on the main account. Live mode cannot be saved with it incomplete.'}
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
      <SwitchField
        name="venues.lighter.hedge.enabled"
        id={id('hedgeEnabled')}
        icon={<ArrowLeftRight className="h-4 w-4" />}
        label="Hedge mode (two sub-accounts)"
        badge={enabled ? <Badge>Enabled</Badge> : <Badge variant="secondary">Off</Badge>}
        descriptionClassName="text-xs"
        description={
          <>
            Lighter nets one position per market per account. With hedge mode, longs go on the main account (above) and
            shorts on a second sub-account, so a long and a short on one symbol can be open together, each with its own
            SL/TP.
          </>
        }
        // Hedge mode needs position mode HEDGE; turning it off goes back to one-way, which is what the bot then runs
        onCheckedChange={(checked) => onPositionModeChange?.(checked ? 'HEDGE' : 'ONE_WAY')}
      />

      <div className="flex items-start gap-2 rounded-md border border-blue-300 bg-blue-50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-400">
        <Wallet className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Fund both accounts with USDC. Each account has its own margin and liquidation price, and the bot never moves
          funds between them.
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <NumberField
          name="venues.lighter.hedge.shortAccount.accountIndex"
          id={id('shortAccountIndex')}
          label="Short account index"
          description="A second sub-account of the same master, for the shorts"
          inputMode="numeric"
          min={LIGHTER_MIN_ACCOUNT_INDEX}
          max={LIGHTER_MAX_ACCOUNT_INDEX}
          step={1}
          placeholder="e.g. 23456"
          inputClassName="font-mono"
          parse={parseIndex}
        />
        <NumberField
          name="venues.lighter.hedge.shortAccount.apiKeyIndex"
          id={id('shortApiKeyIndex')}
          label="Short account API key index"
          description="A key registered on the short account, not 0"
          inputMode="numeric"
          min={LIGHTER_MIN_API_KEY_INDEX}
          max={LIGHTER_MAX_API_KEY_INDEX}
          step={1}
          placeholder="e.g. 4"
          inputClassName="font-mono"
          parse={parseIndex}
        />
      </div>

      <TextField
        name="venues.lighter.hedge.shortAccount.apiKeyPrivateKey"
        id={id('shortApiKeyPrivateKey')}
        label="Short account API private key"
        description="Signs the short account's orders inside the bot process only"
        reveal="short account API private key"
        autoComplete="off"
        placeholder="80 hex characters (optional 0x)"
        inputClassName="font-mono"
        parse={parseKey}
      />

      <TextField
        name="venues.lighter.hedge.shortAccount.apiKeyPublicKey"
        id={id('shortApiKeyPublicKey')}
        label="Short account API public key"
        description="Checked at startup against the key registered for the short account"
        autoComplete="off"
        placeholder="80 hex characters (optional 0x)"
        inputClassName="font-mono"
        parse={parseKey}
      />

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

// ===== Standalone: the host holds the settings =====

interface LighterSettingsProps extends LighterFieldsProps {
  value: LighterVenueConfig | undefined;
  onChange: (next: LighterVenueConfig) => void;
  // Whether the settings can be saved (no field shows an error): said with every edit and once for the value given
  onValidityChange?: (valid: boolean) => void;
}

type LighterHostValues = Pick<Config, 'venues'>;

const sameSettings = (a: LighterVenueConfig, b: LighterVenueConfig) => a === b || JSON.stringify(a) === JSON.stringify(b);

// Lighter settings for a host that keeps them in its own state (the onboarding step): every edit is passed to
// onChange as the complete settings, and a value changed from outside replaces what the form holds. The host is
// told whether they are valid, as its own state holds what was typed even where the schema refuses it ("12.5").
export function LighterSettings({ value, onChange, onValidityChange, ...fields }: LighterSettingsProps) {
  const [loaded] = useState<LighterHostValues>(() => ({ venues: { lighter: value ?? {} } }));
  const resolver = useMemo(() => createConfigResolver<LighterHostValues>(lighterSettingsFormSchema, loaded), [loaded]);
  const form = useForm<LighterHostValues>({ resolver, defaultValues: loaded, mode: 'onChange', shouldFocusError: false });
  const { watch, reset, trigger } = form;

  const onChangeRef = useRef(onChange);
  const onValidityChangeRef = useRef(onValidityChange);
  const emitted = useRef<LighterVenueConfig>(value ?? {});
  useEffect(() => {
    onChangeRef.current = onChange;
    onValidityChangeRef.current = onValidityChange;
  }, [onChange, onValidityChange]);

  useEffect(() => {
    const subscription = watch((values, { name }) => {
      if (!name) return;   // A reset, not an edit
      const next = withoutClearedFields(values.venues?.lighter ?? {}) as LighterVenueConfig;
      emitted.current = next;
      onChangeRef.current(next);
      onValidityChangeRef.current?.(lighterSettingsValid(next));
    });
    return () => subscription.unsubscribe();
  }, [watch]);

  useEffect(() => {
    const incoming = value ?? {};
    // The value the host holds may be one it has not seen validated yet (the step's first render, a reload)
    onValidityChangeRef.current?.(lighterSettingsValid(incoming));
    if (sameSettings(incoming, emitted.current)) return;
    emitted.current = incoming;
    reset({ venues: { lighter: incoming } });
    void trigger();
  }, [value, reset, trigger]);

  return (
    <FormProvider {...form}>
      <LighterFields {...fields} />
    </FormProvider>
  );
}

export default LighterSettings;
