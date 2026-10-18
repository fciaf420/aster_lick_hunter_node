# Realized PnL Tracking Issue

## Problem

The Aster Finance `/fapi/v1/income` API endpoint does **NOT** reliably record `REALIZED_PNL` entries when positions are closed.

### Evidence

Testing the income API shows:
- **24h range**: 194 records, **0 REALIZED_PNL** entries
- **7d range**: 447 records, **0 REALIZED_PNL** entries
- **30d range**: 822 records, **1 REALIZED_PNL** entry (from Sept 21)

What we DO see:
- ✅ COMMISSION entries (generated on every trade)
- ✅ FUNDING_FEE entries
- ✅ APOLLOX_DEX_REBATE entries
- ✅ Other income types

## Root Cause

Aster Finance's income history endpoint (`/fapi/v1/income`) does not properly track realized PnL from closed positions. This appears to be an exchange-side issue or API limitation.

## Where Realized PnL DOES Exist

The `cr` field (Cumulative Realized PnL) is available in:

1. **USER_DATA WebSocket Stream** - `ACCOUNT_UPDATE` events contain position data with `cr` field
2. **Position Risk API** (`/fapi/v2/positionRisk`) - Returns current positions with `cr` field

## Current Workarounds

### For Live Session Tracking
The `pnlService.ts` correctly tracks realized PnL from the USER_DATA WebSocket stream by:
- Reading the `cr` (cumulative realized) field from position updates
- Calculating session PnL as: `currentAccumulatedPnl - startingAccumulatedPnl`

This works perfectly for **real-time session tracking**.

### For Historical Data
**Problem**: We cannot get historical realized PnL from the Income API.

**Potential Solutions**:

1. **Track in Database** - Store `cr` field updates in local database
   - Pro: Complete historical record
   - Con: Requires database schema changes, only tracks future data

2. **Calculate from Commission** - Estimate trades from commission records
   - Pro: Works with existing data
   - Con: Approximate, doesn't give actual PnL amounts

3. **Use Position API Snapshots** - Periodically snapshot position `cr` field
   - Pro: Gives current cumulative PnL
   - Con: Doesn't provide day-by-day breakdown

4. **Accept Limitation** - Show only fees/funding in historical charts
   - Pro: Simple, accurate for what we show
   - Con: Missing key metric

## Recommended Approach

### Short-term
1. Update UI to clarify that historical charts show **Fees & Funding** only (not realized PnL)
2. Keep showing live session PnL (which works correctly)
3. Add note explaining the limitation

### Long-term
1. Implement database tracking of `cr` field from WebSocket
2. Build historical PnL charts from stored cr snapshots
3. Backfill when possible from position API

## Code Locations

- **Income API**: `src/lib/api/income.ts`
- **PnL Service** (works correctly): `src/lib/services/pnlService.ts`
- **Charts** (affected): `src/components/PnLChart.tsx`, `PerformanceCardInline.tsx`
- **Diagnostic Script**: `scripts/test-income-api.ts`
