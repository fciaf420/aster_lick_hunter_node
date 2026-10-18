# Pair-trade analysis of liquidation signals

The bot trades one leg: after a long liquidation (a forced SELL) it buys, after a short liquidation (a forced BUY) it
sells. This page covers `npm run analyze:pairs`, which asks, with the data you have stored, whether a **hedged** or
**paired** version of the same signal would have done better than that single leg. It is the evidence step before
building anything against a venue that executes pair and basket trades, such as Pear Protocol.

It is analysis only. It reads `data/liquidations.db` read-only, never calls an exchange, never starts a server and is
not part of the trading path. The bot has no pair mode; nothing here changes what it trades.

## Run it

```bash
# 1. Liquidations and 1m candles for your configured symbols (see docs/LIGHTER-HISTORY.md for the flags and the
#    retention rule: global.liquidationRetentionDays must be at least --days, or 0)
npm run lighter:backfill -- --profile mainnet --days 7

# 2. 1m candles for the hedge symbols. They need not be in your config. The analysis prints this exact command,
#    with the right symbols and --days, when it finds candles missing.
npm run lighter:backfill -- --profile mainnet --candles-only --symbols BTCUSDT,ETHUSDT --days 7.2

# 3. The analysis
npm run analyze:pairs
npm run analyze:pairs -- --extra-hedges ETHUSDT --min-usd 5000
npm run analyze:pairs -- --fee-bps 0 --slippage-bps 2 --json ~/pairs.json
npm run analyze:pairs -- --help
```

- `--profile` defaults to `venues.lighter.profile` from your config, which is `testnet` unless you changed it. Use the
  profile your liquidations came from; testnet prices are not mainnet prices.
- The database file is the one the bot, `lighter:backfill` and the optimizer use: `data/liquidations.db` under the
  directory you run from, or `LIQUIDATIONS_DB_PATH` when set. It is opened read-only, so it is safe while the bot runs.
- `--json` files are not git-ignored. Write them outside the repository.
- For Aster liquidations, `--venue aster` reads the Aster rows. No script stores Aster candles, so add
  `--candle-venue lighter` to price them with Lighter's 1m candles (the same bot symbols; a proxy for Aster's prices).

The results are only as good as the history behind them. A week of one symbol's liquidations is a few dozen events.
Backfill as many days as your retention allows, or let the bot record in shadow mode for a few weeks first.

## What it computes

**Events.** Liquidation rows of one venue (`--venue`, default `lighter`). The scope is the Lighter optimizer's:
`skip_reason` empty or `shadow mode`; `--include-skipped` also takes the detections a gate dropped. `--symbols`,
`--since` / `--until` (UTC, `since` inclusive, `until` exclusive) and `--min-usd` narrow them. Rows below `--min-usd`
are ignored first (the bot acts on a row that crosses its threshold), then bursts collapse: one event per symbol and
side within `--dedupe-sec` (default 60) of the first row, anchored on that row. The entry is the close of the first 1m
candle that closes at or after the event, so nothing fills before the event is known; the exit is the close of the
candle `horizon` minutes later.

**Strategies**, each at every horizon in `--horizons` (default 5, 15 and 60 minutes):

| Strategy | Trade |
|---|---|
| `single` | The bot's contrarian trade on the liquidated symbol. |
| `btc-hedged` | The same leg plus an opposite leg on `--hedge-symbol` (BTCUSDT). The hedge notional is `beta` times the leg's, with beta the slope of the symbol's 1m log returns on the hedge's over the `--beta-lookback` minutes (default 240) that closed before the entry candle opened, clamped to [0, 3]. With fewer than `--beta-min-obs` (30) minutes where both symbols have a candle and the one before it, or a hedge that did not move, beta is 1 and the event is counted as a fallback. `--hedge-sizing dollar` uses equal notional (beta 1) instead. |
| `eth-hedged` etc. | One more hedged strategy per symbol in `--extra-hedges`, built the same way. |
| `cross-pair` | When another symbol had an opposite-direction signal within `--pair-window-sec` (120): long the symbol with the long-liquidation signal, short the one with the short-liquidation signal, equal notional. The pair is entered when the **later** signal arrives, so it only uses what was known then. Events pair one-to-one, each with the most recent unpaired partner that fits. |

**Costs.** `--fee-bps` (default 5, a 0.05% taker fee) plus `--slippage-bps` (default 0), per leg and per side, on
every leg: a round trip costs `2 x (fee + slippage)` per unit of leg notional, so a hedged trade pays for the hedge leg
too and a cross pair pays for two legs. Lighter standard accounts pay no fee: use `--fee-bps 0` for those, and add a
slippage figure you believe. For Pear Protocol, use the fees you would actually pay on both the venue and Pear's side.

**Gaps.** A missing candle at the entry or exit of any leg excludes the event from that strategy and horizon, with a
counted reason. Nothing is interpolated. A horizon whose exit candle has not closed yet is its own reason and is not
counted as a gap to fetch.

## Reading the output

The report starts with one `CAVEAT` line (see [Limitations](#limitations)), then what was read: how many rows became
how many events, how many of them are backfilled and so skipped the live feed's book check, the costs, the beta
diagnostics per hedge (fallbacks and clamps) and how many events had a cross-pair partner.

For each horizon there are three tables: the strategies, pair minus single, and a per-symbol breakdown. This sample (the
first two, trimmed) is from a run on **synthetic** data, to show the format; it says nothing about real markets:

```
=== Horizon 15 min ===
Net return per trade in bps of the liquidated leg's notional, after costs. expo: gross notional per unit of that notional.
strategy      n   mean  median  stdev  win%      t  sharpe     p5  maxDD  expo  mean/expo  excl
----------  ---  -----  ------  -----  ----  -----  ------  -----  -----  ----  ---------  ----
single      498  +23.0   +26.3   67.5   64%  +7.59  +0.340  -80.6  402.8  1.00      +23.0     5
btc-hedged  498   +6.0    +8.3   51.7   59%  +2.57  +0.115  -85.5  572.9  2.65       +2.2     5
cross-pair   38  +32.3   +28.3   70.3   66%  +2.83  +0.460  -72.7  144.7  2.00      +16.2     0

Pair minus single, same events (bps of the liquidated leg's notional: what the extra leg adds, costs included; paired t)
strategy minus single    n   mean  stdev      t  win%
---------------------  ---  -----  -----  -----  ----
btc-hedged             498  -17.0   44.9  -8.45   36%
cross-pair              38  +23.4   73.9  +1.95   63%
```

- **Units.** Every return is in bps of the notional of the liquidated symbol's leg, after costs. A hedge leg of beta 1.5
  adds 1.5 times that notional of exposure and a cross pair adds 1 times: `expo` is the gross notional deployed per unit
  of the leg's, and `mean/expo` is the mean per unit of exposure. A pair strategy that earns more only because it
  risks more is not better; compare `mean/expo` and `sharpe`, not the raw `mean` alone.
- **`n`** is the events with a result for that strategy and horizon; `excl` counts the ones left out, and the line
  under the table says why (entry or exit candle missing, hedge or partner candle missing, the event is on the hedge
  symbol, horizon not yet elapsed). `n + excl` is the number of events (the number of pairs, for `cross-pair`).
- **`win%`** is the share of trades with a positive net return. **`t`** is the t statistic of the mean (`mean / (stdev /
  sqrt(n))`). **`sharpe`** is `mean / stdev` per trade, not annualised. **`p5`** is the 5th percentile of the net
  return, the tail. **`maxDD`** is the largest peak-to-trough fall of the cumulative net return, adding up one unit per
  event in entry order, with no compounding and no overlap.
- **Pair minus single** pairs each strategy's trade with the single-leg trade of the same event (for `cross-pair`, the
  triggering event) and tests the difference, in the same units. Positive means the extra leg helped. For a hedge, the
  difference is what the hedge leg earned less what it cost; because it removes market exposure, its mean is mostly the
  market's drift times beta, and its value shows in the spread and the tail (`stdev`, `p5`, `maxDD`, `sharpe`) more than
  in the mean.
- **Per symbol** shows the mean net bps and `[n]` for each strategy (cross pairs by the symbol that triggered them) and
  the mean difference to the single leg. The `--json` output has the full per-symbol statistics, including t statistics.
- **Missing candles** at the end names the symbols that lost events to a missing candle, and prints the
  `npm run lighter:backfill -- --candles-only --symbols ... --days N` command that reaches back far enough. Some gaps
  are real: a minute without trades may have no candle, and they remain after fetching.

## Before turning on any pair mode

None of this is a reason to trade; it is the minimum for continuing to look. A pair mode earns a forward test, not
real money, when **all** of these hold:

1. **A difference worth having, with evidence.** Pair minus single is positive with a paired `|t| > 2`, in the units
   above, after costs you would really pay. Re-run with your actual `--fee-bps` and a `--slippage-bps` you believe
   (try 2 to 5); a result that needs zero slippage is not a result. For a hedge, whose point is risk, the evidence may
   instead be a clearly better `sharpe`, `p5` and `maxDD` with a mean per exposure that is not worse.
2. **Enough events.** Look at `n` of the strategy you care about, not the total: `cross-pair` has only the events that
   found a partner, often a small share. Treat fewer than about 100 events for a hedge, or about 30 pairs for
   `cross-pair`, as anecdote. Overlapping and clustered events are counted as independent, so the real evidence is
   weaker than `t` says.
3. **Several symbols, not one.** The per-symbol table shows the difference with the same sign in most symbols that have a
   reasonable `n` (say 15 or more events). One symbol that carries the total is a coincidence until shown otherwise.
4. **Stable across horizons.** The same sign, and `|t| > 2`, at 5, 15 and 60 minutes. With three horizons and two or three
   strategies you are reading six to nine comparisons, and one `|t|` near 2 among them is expected by luck.
5. **Stable in time.** Split the window and run it twice, `--until 2026-10-14` then `--since 2026-10-14`. The sign and
   rough size should survive in the half you did not look at first. A single run is in-sample by construction.
6. **Not an artefact of the data.** The `Book check` line says how many events are backfilled rows, which never faced the
   live feed's order-book gate, so they lean optimistic. Re-run as the bot records live rows (shadow mode records
   them) and the share drops. Also check `excl`: if many events are excluded for missing candles, the survivors may not
   represent the rest.
7. **Execution you can reproduce.** The analysis fills every leg at the same 1m close with no spread, depth or latency.
   Both legs of a Pear basket will not fill at exactly the same price and instant, and a hedge leg's size is rounded and
   its fees are real. Run a forward test, recording the pair signals live without trading, for several weeks and compare
   its result with this one before risking money.

If the single leg is the best row, or the pair rows only win by deploying more exposure, the answer is to keep the
single leg.

## Limitations

- **In-sample.** The data used to look is the data used to judge. Nothing is fitted here, but every choice of horizon,
  symbol set and threshold you try is a comparison, so use `--since` / `--until` and a forward test.
- **Backfilled Lighter rows are optimistic.** They pass the gates the backfill can apply but not the book-side gate, so
  they include liquidations the live feed would have dropped. See
  [Backfilled rows are optimistic](LIGHTER-HISTORY.md#backfilled-rows-are-optimistic).
- **Funding is ignored.** Holding a perp for an hour pays or earns funding; at these horizons it is small next to a fee
  but not zero, and a hedge leg pays it too.
- **1m-close fills.** Entry and exit are candle closes. Real fills have a spread, queue and latency, which cost most
  exactly when the liquidation moves the market. `--slippage-bps` is the only allowance.
- **Fixed-horizon exits.** The bot exits on take-profit and stop-loss; this holds for the horizon. The comparison of
  hedged with single legs is fair, but the numbers are not the bot's P&L.
- **Independence.** Events close in time share market moves, and trades overlap in time. Each event is in at most one
  cross pair, but nothing else is made independent, so the t statistics are optimistic and `maxDD` ignores overlapping
  positions.
- **Beta is a regression on the last few hours.** A hedge sized from it is only as good as the last 240 minutes of
  1m returns say. A liquidation cascade is exactly when betas change. Check the fallback and clamp counts in the report.
- **Thin symbols.** Candles of illiquid symbols have holes; the exclusions are counted, never filled.
- **Volumes and units.** Lighter volumes are USDC, treated as USDT, as in the rest of the bot.

## Options

| Option | Default | |
|---|---|---|
| `--venue aster\|lighter` | `lighter` | Whose liquidations to read |
| `--candle-venue aster\|lighter` | the venue | Whose candles to price with. Only Lighter candles are stored. |
| `--include-skipped` | off | Also use detections the feed did not trade |
| `--symbols A,B` | all | Only these symbols |
| `--since TIME` / `--until TIME` | none | Event-time window, UTC (`2026-10-12` or `2026-10-12T06:00:00Z`) |
| `--min-usd N` | 0 | Ignore liquidations below N USD |
| `--dedupe-sec N` | 60 | One event per symbol and side within N seconds |
| `--horizons 5,15,60` | `5,15,60` | Holding times in whole minutes |
| `--hedge-symbol S` | `BTCUSDT` | The hedge leg of `btc-hedged` |
| `--extra-hedges A,B` | none | More hedged strategies, one per symbol |
| `--hedge-sizing beta\|dollar` | `beta` | Hedge notional = beta x the leg, or equal |
| `--beta-lookback N` | 240 | Minutes of 1m log returns before the event |
| `--beta-min-obs N` | 30 | Fewer paired returns than this: beta 1, counted |
| `--pair-window-sec N` | 120 | Window for an opposite-direction partner |
| `--fee-bps N` | 5 | Fee per leg and side |
| `--slippage-bps N` | 0 | Slippage per leg and side |
| `--json PATH` | none | Write the full result as JSON |
| `--json-trades` | off | Include every trade in the JSON (large) |

The JSON has the options, the event counts, the per-strategy and per-horizon metrics with exclusion counts and
per-symbol statistics, the pair-minus-single statistics (overall and per symbol), the hedge diagnostics, the symbols
with missing candles and the caveats.
