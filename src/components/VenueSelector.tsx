'use client';

import React from 'react';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  BETA_WARNING,
  LIQUIDATION_SOURCE_CATALOG,
  VENUE_CATALOG,
  getLiquidationSourceEntry,
  getVenueEntry,
  isSelectableStatus,
  type CatalogStatus,
} from '@/lib/exchange/catalog';
import type { LiquidationSourceId, VenueId } from '@/lib/exchange/types';

interface VenueSelectorProps {
  venue?: VenueId;
  onVenueChange: (venue: VenueId) => void;
  liquidationSource?: LiquidationSourceId;
  onLiquidationSourceChange?: (source: LiquidationSourceId) => void;
  showLiquidationSource?: boolean;
  showDetails?: boolean;
}

function ComingSoonBadge() {
  return <Badge variant="secondary">Coming soon</Badge>;
}

function BetaBadge() {
  return (
    <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400">
      Beta
    </Badge>
  );
}

function StatusBadge({ status }: { status: CatalogStatus }) {
  if (status === 'coming_soon') return <ComingSoonBadge />;
  if (status === 'beta') return <BetaBadge />;
  return null;
}

function BetaWarning({ name }: { name: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-400"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        <strong>{name} is in beta.</strong> {BETA_WARNING}
      </span>
    </div>
  );
}

// Trading venue and liquidation source pickers. Entries that aren't implemented yet are listed
// (with their description) but can't be selected; beta entries can be selected and carry a warning.
export function VenueSelector({
  venue,
  onVenueChange,
  liquidationSource,
  onLiquidationSourceChange,
  showLiquidationSource = true,
  showDetails = true,
}: VenueSelectorProps) {
  const venueEntry = getVenueEntry(venue);
  const sourceEntry = getLiquidationSourceEntry(liquidationSource);

  return (
    <FieldGroup className="gap-6">
      <Field className="gap-2">
        <FieldLabel htmlFor="tradingVenue">Trading venue</FieldLabel>
        <Select value={venueEntry.id} onValueChange={(value) => onVenueChange(value as VenueId)}>
          <SelectTrigger id="tradingVenue" className="w-full">
            <SelectValue>{venueEntry.name}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {VENUE_CATALOG.map((entry) => (
              <SelectItem
                key={entry.id}
                value={entry.id}
                disabled={!isSelectableStatus(entry.status)}
                className="items-start"
              >
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{entry.name}</span>
                    <span className="text-xs text-muted-foreground">{entry.chain}</span>
                    <StatusBadge status={entry.status} />
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-normal">{entry.description}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {showDetails && (
          <div className="rounded-lg border p-3 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{venueEntry.name}</span>
              <Badge variant="outline">{venueEntry.chain}</Badge>
              <StatusBadge status={venueEntry.status} />
            </div>
            <p className="text-xs text-muted-foreground">{venueEntry.description}</p>
            <a
              href={venueEntry.signupUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              Open {venueEntry.name} (sign up / API management)
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}
        {venueEntry.status === 'beta' && <BetaWarning name={venueEntry.name} />}
      </Field>

      {showLiquidationSource && onLiquidationSourceChange && (
        <Field className="gap-2">
          <FieldLabel htmlFor="liquidationSource">Liquidation source</FieldLabel>
          <Select
            value={sourceEntry.id}
            onValueChange={(value) => onLiquidationSourceChange(value as LiquidationSourceId)}
          >
            <SelectTrigger id="liquidationSource" className="w-full">
              <SelectValue>{sourceEntry.name}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {LIQUIDATION_SOURCE_CATALOG.map((entry) => (
                <SelectItem
                  key={entry.id}
                  value={entry.id}
                  disabled={!isSelectableStatus(entry.status)}
                  className="items-start"
                >
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{entry.name}</span>
                      {entry.requiresApiKey && <Badge variant="outline">API key</Badge>}
                      <StatusBadge status={entry.status} />
                    </div>
                    <span className="text-xs text-muted-foreground whitespace-normal">{entry.description}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription className="text-xs">{sourceEntry.description}</FieldDescription>
          {sourceEntry.status === 'beta' && <BetaWarning name={sourceEntry.name} />}
        </Field>
      )}
    </FieldGroup>
  );
}

export default VenueSelector;
