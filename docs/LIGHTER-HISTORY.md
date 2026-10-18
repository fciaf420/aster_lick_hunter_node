# Lighter liquidation history

The optimizer tunes thresholds, TP/SL and leverage by replaying stored liquidations against 1-minute prices. For
Aster, the bot has always recorded every liquidation it saw. This page covers the Lighter equivalent:

- recording every liquidation the Lighter feed detects, traded or not
- loading past Lighter liquidations and candles with `npm run lighter:backfill`
- running the optimizer on Lighter data with `--venue lighter`

Everything lives in `data/liquidations.db`, the same SQLite file the dashboard and the optimizer already use.

## What is stored

### Liquidations

The `liquidations` table gained five columns. When the bot (or the backfill) first opens an existing database, it
adds them automatically. Rows recorded before the upgrade get `venue = 'aster'` and `source = 'live'`.

| Column | Values |
|---|---|
| `venue` | `aster` or `lighter` |
| `source` | `live` (recorded by the running bot) or `backfill` (loaded by `lighter:backfill`) |
| `external_id` | The Lighter liquidation id `market:tx_hash:taker_order` (the feed's group key). `null` for Aster. |
| `skip_reason` | `null` means the liquidation was sent to the hunter. For backfilled rows it means the row passed the gates the backfill can apply, which **do not include the book check** (see [Backfilled rows are optimistic](#backfilled-rows-are-optimistic)). Otherwise it holds why the liquidation was not traded: `shadow mode`, or the joined drop reasons (stale, LLP takeover, unverified side, market disabled, ...). |
| `mode` | `live` or `shadow`: the feed mode when the row was recorded. `null` for Aster and backfilled rows. |

A unique index on `(venue, external_id)` (where `external_id` is set) means a Lighter liquidation is stored only
once. That holds whether it was seen live, sent to the hunter, backfilled later, or all three. When a live
detection and a backfilled row describe the same liquidation, the live information wins: `skip_reason`, `mode`,
`source` and the metadata (trade ids, notes) come from the detection. The same goes for the thinner copy the
hunter stores when it receives the event. Once a row says it was sent to the hunter, it keeps saying so. A second
detection of a liquidation that already has live metadata leaves that metadata as it is.

A new database file is created with all of these columns. An older file is migrated when it is first opened, in one
write transaction, so the bot, the backfill and the web app can open the same file at the same time. The first to
get the write lock migrates, and the others wait for it (and retry if it takes longer than the busy timeout).

Prices and quantities are in bot units: symbols mapped with a multiplier, such as `NOTUSDT` → `1000NOT`, are
converted. `volume_usdt` is `quantity × price` in USDC, which the bot treats as USDT, the same measure the hunter
compares against the thresholds. The metadata JSON keeps the Lighter market id, tx hash, trade ids, the fills left
out as LLP / insurance-fund fills, and the feed's notes.

### Candles

The `candles` table holds `(venue, symbol, interval, open_time)` → open / high / low / close / volume.
`open_time` is in ms, and `symbol` is the bot symbol in bot units. `lighter:backfill` writes Lighter `1m` candles
there, and the optimizer reads them.

## Live recording

While the bot runs with Lighter as the liquidation source, every detection of a configured symbol is stored with
`venue = 'lighter'` and `source = 'live'`:

- **Shadow mode** (`venues.lighter.liquidationsLive: false`, the default): `skip_reason = 'shadow mode'`,
  `mode = 'shadow'`. You build up history without trading.
- **Live mode**: liquidations sent to the hunter get `skip_reason = null`. Dropped ones get the reasons the feed
  logged.

Detections for markets that are not mapped to a configured symbol are not stored. Aster liquidations are stored as
before, with `venue = 'aster'`.

## Dashboard and API

Detections that no gate let through are not liquidations the bot would have traded, so the dashboard does not list
them. `GET /api/liquidations` and `GET /api/liquidations/stats` return only the rows with `skip_reason` empty or
`shadow mode`: liquidations sent to the hunter, held back by shadow mode alone, or loaded by the backfill without a
gate failure. Aster rows are always included. Rows carry `venue`, `source`, `mode` and `skip_reason`.

| Parameter | Meaning |
|---|---|
| `venue=aster\|lighter` | Only that venue (default: all). Other values are rejected with a 400. |
| `includeSkipped=true` | Also return the detections a gate dropped (and backfilled rows that failed a gate). Default `false`. |

The same filter applies to the 24-hour statistics, so the counts match the list.

## Backfilling past liquidations

```bash
npm run lighter:backfill                                   # configured symbols, last 7 days, with candles
npm run lighter:backfill -- --profile mainnet --days 3 --symbols BTCUSDT,ETHUSDT
npm run lighter:backfill -- --days 1 --dry-run             # fetch and count, store nothing
npm run lighter:backfill -- --no-candles                   # liquidations only
npm run lighter:backfill -- --candles-only                 # 1m candles only
```

| Flag | Default |
|---|---|
| `--profile mainnet\|testnet` | `venues.lighter.profile` from the config. Liquidations are rare on testnet. |
| `--days N` | 7. Fractions are allowed. |
| `--symbols A,B` | The configured symbols, mapped to Lighter markets with the bot's own mapping, `symbolOverrides` included. Symbols without a Lighter market are skipped with the reason. |
| `--no-candles` / `--candles-only` | Liquidations and candles |
| `--dry-run` | Off |
| `--delay-ms N` | 1100: a little under one request a second |
| `--max-pages N` | 2000 trade pages (100 fills each) per symbol; see [Stopping early](#stopping-early) |
| `--force` | Off. Allows `--days` beyond `global.liquidationRetentionDays`; see [Retention](#retention) |
| `--source trades\|export` | `trades` (see below) |

### Free source: public trades API (default)

The backfill pages through
`GET /api/v1/trades?type=liquidation&market_id=<id>&sort_by=timestamp&sort_dir=desc&limit=100`, following
`next_cursor` back to the start of the window. It stops early when the history runs out and says so.

The fills go through the same code the live feed uses, shared in `src/lib/liquidation/lighterLiquidationCore.ts`:

- **Forced side.** `is_maker_ask = false` means the liquidated taker sold, a forced SELL. `true` means a forced BUY.
- **Grouping.** Fills are grouped per `market:tx:taker order`.
- **Exclusions.** Fills against account 1, the market's insurance fund or the liquidity pool are excluded. The pool
  account comes from `systemConfig.liquidity_pool_index`, which the backfill loads first.
- **Taker-position gates.** The taker held a position, the fill reduced it without flipping it, and the signed size
  matches the side.
- **One-sided tx check.** A tx with fills on both sides is rejected.

The pages come newest first, but the live feed judges liquidations oldest first: the check that a forced BUY's taker
was not long only applies once a signed (negative) `taker_position_size_before` has been seen. So the backfill
collects a symbol's liquidations, sorts them by time, and judges them in that order, the way the live feed would have
met them. Markets are done one after another, and a later market starts with what the earlier ones showed.

**What the backfill cannot check:** the live feed also compares every fill with the best bid / ask from just before
it, and there is no historical order book to compare against. Backfilled rows that pass the other gates get
`skip_reason = null`, and their metadata notes `book check not applied`.

#### Backfilled rows are optimistic

A backfilled row with `skip_reason = null` passed the gates the backfill could apply, not all of them. The live
feed would have dropped some of these liquidations on the book check (a forced SELL that filled above the mid, a
forced BUY below it), and a backfilled row cannot tell. The rows are kept `null` (not marked as skipped) so they stay
usable, which means the Lighter optimizer reads **more liquidations as tradable than the live feed would have
traded**. How much more depends on how often that gate fires live; the live feed's drop reasons in its log show it.

The optimizer says how many of the rows it reads are affected, in one line at the start of a `--venue lighter` run:

```
ℹ️  Book check: not applied to 120 of 340 in-scope liquidation(s) (backfilled: they pass the non-book gates only, so results lean optimistic; see docs/LIGHTER-HISTORY.md)
```

The share shrinks as the bot records live: a live detection replaces the backfilled row of the same liquidation.

Then `GET /api/v1/candles` fills the `1m` candles of the same window, at most 500 per call.

The run is polite and resumable:

- requests are spaced by `--delay-ms`
- `429` and `5xx` responses back off (2 s, 4 s, ...) and retry up to five times
- interrupting and re-running is safe: stored liquidations are skipped through the unique index, and candles are
  overwritten. A symbol's liquidations are stored (in transactions of 500 rows) once its paging ends, so an
  interrupted symbol has stored none of them yet; its candles are stored page by page.

#### Stopping early

The REST contract has not been verified against the live API, so the paging has two limits besides the window start
and the end of the history. The report and the log say which one ended each symbol:

| Stop | Why | What is stored |
|---|---|---|
| window start | Normal: the pages reached the start of the window | everything in the window |
| history end | Normal: the API had no older rows | everything it had |
| no liquidation rows | 20 pages in a row held no `liquidation` row. The server may be ignoring `type=liquidation` and paging through every trade. | what was found before |
| page cap | `--max-pages` (default 2000) pages without reaching the window start | the liquidations the paging moved a minute past; the one at the oldest edge is left out, its fills may continue |

The last two make the script exit with status 1: the window is incomplete. Raise `--max-pages` or shorten `--days`
for the cap.

#### Authentication

The backfill never signs a transaction. Whether `/api/v1/trades` answers without an auth token is not documented
(the API spec only says auth is required for account queries). If the server refuses, the backfill signs a
read-only auth token with the configured Lighter API key for that profile. Only the signer's `createAuthToken` is
wired up, and the native signer is loaded only then: the process has no adapter, nonce manager or transaction
sender. A token in `LIGHTER_AUTH_TOKEN` is used instead when set. With neither, it stops and says what to configure.
Tokens are never printed.

### Paid source: historical export (not supported yet)

`GET /api/v1/export/historicalTrades` needs a one-time 100 LIT L2 transfer and an auth token. It returns a
presigned S3 URL per UTC day. Neither the Lighter SDK nor its OpenAPI spec documents the format of the file behind
that URL, so the backfill does not guess one. `--source export` prints that it is not supported yet.

## Retention

Once a day the bot deletes liquidations and candles older than `global.liquidationRetentionDays`:

- default `7`, the previous fixed behaviour
- `0` keeps everything

Age is measured by **event time**, so backfilled rows age like live ones. A 30-day backfill with a 7-day retention
would lose everything older than 7 days at the next cleanup, so `lighter:backfill` **refuses** a `--days` longer than
`global.liquidationRetentionDays` and says so. Set the retention to at least `--days` (or to 0), then run it again:

```json
"global": {
  "liquidationRetentionDays": 30
}
```

The same setting is on the Config page, under Global Settings (*Liquidation History Retention (days)*). Pass
`--force` to backfill anyway; the older rows are then deleted again by the next daily cleanup. Dry runs and
`--candles-only` runs (what the optimizer uses to fill gaps) are not held to the retention.

## Optimizing on Lighter data

```bash
node optimize-config.js --venue lighter                    # default: global.exchange (aster when unset)
node optimize-config.js --venue lighter --include-skipped  # also count detections the feed did not trade
npm run optimize:ui -- --venue lighter                     # the same through npm
```

In the web UI, the optimizer page has a **Liquidation Data** selector: the configured venue, Aster or Lighter. For
Lighter it also has an *include detections the feed did not trade* checkbox. The API takes the same choices as
`venue` and `includeSkipped` in `POST /api/optimizer/run`, and the CLI reads `OPTIMIZER_VENUE` /
`OPTIMIZER_INCLUDE_SKIPPED`.

With `--venue lighter`:

- **Liquidations.** Only `venue = 'lighter'` rows are read. By default these are the rows that would have been
  traded: `skip_reason` is `null`, or `shadow mode` only. `--include-skipped` adds the dropped ones. A line at the
  start counts how many of them are backfilled and so lack the book check (see
  [Backfilled rows are optimistic](#backfilled-rows-are-optimistic)).
- **Prices.** 1m prices come from the `candles` table. They cover the last 7 days, stretched back to the oldest
  stored liquidation of the symbol. When candles are missing, the optimizer runs
  `lighter:backfill --candles-only` once per symbol and reads them again. The script's own output is shown only if
  it fails: the optimizer's stdout is parsed by the web UI's job runner, and its stderr is logged there as an error.
- **Account.** The balance comes from the public Lighter account endpoint for `venues.lighter.accountIndex`. The
  Aster account and trade-history checks are skipped.

With `--venue aster`, or the default on an Aster setup, the optimizer works exactly as before: Aster rows only, and
every row of a database from before the venue column, with Aster klines.

**Thresholds differ between venues.** Lighter reports every liquidation as it happens; the bot groups fills into
one event per liquidation. Aster's forceOrder stream sends at most one snapshot per symbol per second. Lighter
liquidation counts and sizes are therefore not comparable with Aster's, and thresholds suggested from Lighter data
fit the Lighter feed only. USDC volumes are compared with the USDT thresholds one to one.

## Limitations

- **Unverified API behaviour.** These have not been checked against the live API:
  - whether `/api/v1/trades` works without auth
  - how far back its history goes
  - how `count_back` interacts with `start_timestamp` / `end_timestamp` on `/api/v1/candles`

  The backfill requests 500-minute windows of at most 500 candles, which is correct under either reading. If the
  server ignores `type=liquidation`, the paging stops after 20 pages without a liquidation row (see
  [Stopping early](#stopping-early)).
- **No book check.** Backfilled rows skip the live feed's book check, so optimizer results on them lean optimistic
  (see [Backfilled rows are optimistic](#backfilled-rows-are-optimistic)).
- **Gates that only apply live.** Staleness and market state are not reapplied to history: disabled market,
  open-interest cap, mark-ratio guard.
- **Rare duplicates in recording.**
  - A liquidation whose fills arrive more than a second apart can be flushed twice by the live feed. The second
    flush updates the same row rather than adding volume.
  - If the stream and the REST API disagree on a fill's tx hash, the same liquidation can be stored twice.
- **Unmapped markets.** Detections for markets not mapped to a configured symbol are not recorded.
