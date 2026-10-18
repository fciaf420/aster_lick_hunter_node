'use client';

import React from 'react';
import { ExternalLink } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  LIQUIDATION_SOURCE_CATALOG,
  VENUE_CATALOG,
  getLiquidationSourceEntry,
  getVenueEntry,
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

// Trading venue and liquidation source pickers. Entries that aren't implemented yet are listed
// (with their description) but can't be selected.
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
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="tradingVenue">Trading venue</Label>
        <Select value={venueEntry.id} onValueChange={(value) => onVenueChange(value as VenueId)}>
          <SelectTrigger id="tradingVenue" className="w-full">
            <SelectValue>{venueEntry.name}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {VENUE_CATALOG.map((entry) => (
              <SelectItem
                key={entry.id}
                value={entry.id}
                disabled={entry.status !== 'available'}
                className="items-start"
              >
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{entry.name}</span>
                    <span className="text-xs text-muted-foreground">{entry.chain}</span>
                    {entry.status !== 'available' && <ComingSoonBadge />}
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
              {venueEntry.status !== 'available' && <ComingSoonBadge />}
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
      </div>

      {showLiquidationSource && onLiquidationSourceChange && (
        <div className="space-y-2">
          <Label htmlFor="liquidationSource">Liquidation source</Label>
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
                  disabled={entry.status !== 'available'}
                  className="items-start"
                >
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{entry.name}</span>
                      {entry.requiresApiKey && <Badge variant="outline">API key</Badge>}
                      {entry.status !== 'available' && <ComingSoonBadge />}
                    </div>
                    <span className="text-xs text-muted-foreground whitespace-normal">{entry.description}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{sourceEntry.description}</p>
        </div>
      )}
    </div>
  );
}

export default VenueSelector;
