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

**Events.** Liquidation rows of one venue (`--venue`, default `lighter`). The scope is `skip_reason` empty or `shadow
mode`, the rows the Lighter optimizer reads; `--include-skipped` also takes the detections a gate dropped. Only Lighter
rows ever carry a `skip_reason` (Aster rows are stored without one), so for `--venue aster` the scope keeps every row and
`--include-skipped` changes nothing. `--symbols`, `--since` / `--until` (UTC; `since` inclusive, `until` exclusive; a
date that does not exist, such as `2026-02-30`, is rejected rather than rolled over) and `--min-usd` narrow them.
`--min-usd` works in one of two ways, matching the bot's two ways of reacting to a liquidation:

- **Per row** (default). Rows below `--min-usd` are ignored first, as the bot acts on a row that crosses its threshold;
  then bursts collapse: one event per symbol and side within `--dedupe-sec` (default 60) of the first remaining row,
  anchored on that row. One big liquidation trades; several small ones that add up do not.
- **Per burst** (`--burst-sum`). Every row joins the burst of its symbol and side (the first row opens a `--dedupe-sec`
  window, anchored on it), and the burst trades once its **total** reaches `--min-usd`. This models the bot's rolling
  threshold (`useThreshold`), which adds up the last 60 seconds of liquidations and acts when the sum crosses. The event
  is the row at which the total crosses, not the burst's first row: entering at the first row would use the rest of the
  burst in advance. The bot's window slides (and has a cooldown) while this one is anchored on the burst's first row, so
  it is an approximation. With `--min-usd 0` both ways give the same events.

**Entry and exit.** The entry is the close of the 1m candle that **contains** the event (its open is the event's minute,
`floor(time / 1 minute)`), so it is always after the liquidation's trade, by up to a minute; an event exactly on a minute
boundary belongs to the candle that starts there, never to the one that ended there. Every leg uses the same rule: a
hedge leg and the partner leg of a cross pair are entered at the close of the candle that contains the signal that
triggers them. The exit is the close of the candle `horizon` minutes after the entry candle. A horizon whose exit
candle closes at or after the moment you run the analysis is not known yet and is left out (`horizon not elapsed`).

**Strategies**, each at every horizon in `--horizons` (default 5, 15 and 60 minutes):

| Strategy | Trade |
|---|---|
| `single` | The bot's contrarian trade on the liquidated symbol. |
| `btc-hedged` | The same leg plus an opposite leg on `--hedge-symbol` (BTCUSDT). The hedge notional is `beta` times the leg's, with beta the slope of the symbol's 1m simple returns (the returns the legs earn) on the hedge's over the `--beta-lookback` minutes (default 240) before the entry candle: the newest candle used is the one that ended where the entry candle starts, so the liquidation's own candle never counts. Clamped to [0, 3]. With fewer than `--beta-min-obs` (30) minutes where a symbol has a candle and the one before it, or a hedge that did not move, beta is 1 and the event is counted as a fallback, with the reason: the symbol short of history, the hedge short of history, or the hedge flat. `--hedge-sizing dollar` uses equal notional (beta 1) instead. |
| `eth-hedged` etc. | One more hedged strategy per symbol in `--extra-hedges`, built the same way. |
| `cross-pair` | When another symbol had an opposite-direction signal within `--pair-window-sec` (120): long the symbol with the long-liquidation signal, short the one with the short-liquidation signal, equal notional. The pair is entered when the **later** signal (the trigger) arrives, both legs at the trigger's entry candle, so it only uses what was known then. Events pair one-to-one, each with the most recent unpaired partner that fits. It is compared with two baselines, because it differs from a single leg in two ways: **minus trigger single** is the pair against the trigger's own single trade, which is *hedging the trigger with the partner*: the partner leg, entered up to `--pair-window-sec` after its own signal, added to the trigger. **Minus both singles** is the pair against the trigger's single **plus the partner's single**, each entered at its own signal and held for the same horizon. That second baseline is what a bot that trades every symbol single-leg already holds: it bought or sold the partner at the partner's own signal, 0 to 120 s before the pair would exist. It is the comparison pair execution has to win; the first can look good while pair execution adds nothing. |

**Reading the two cross-pair comparisons.** Both baselines have the pair's gross exposure (two legs) and its costs, so
the costs cancel in the second, and the trigger's leg is the same trade on both sides. What is left is only the partner
leg: its return from the trigger's entry to the exit, less its return from its own entry to its own exit. A positive
**minus both singles** therefore means that entering the partner later, together with the trigger, beat entering it at
its own signal. For a contrarian trade the bounce starts right after the signal and a later entry misses part of it, so
near zero or negative is the unsurprising result; a clearly positive value, meeting the conditions below, is what would
justify building pair execution.

**Costs.** `--fee-bps` (default 5, a 0.05% taker fee) plus `--slippage-bps` (default 0), per leg and per side, on
every leg: a round trip costs `2 x (fee + slippage)` per unit of leg notional, so a hedged trade pays for the hedge leg
too and a cross pair pays for two legs. Lighter standard accounts pay no fee: use `--fee-bps 0` for those, and add a
slippage figure you believe. For Pear Protocol, use the fees you would actually pay on both the venue and Pear's side.

**Gaps.** A missing candle at the entry or exit of any leg excludes the event from that strategy and horizon, with a
counted reason. Nothing is interpolated. A horizon whose exit candle has not closed yet (`horizon not elapsed`), or
that closes after `--until` with `--until-exits` (`exit past --until`), is its own reason and is not counted as a gap
to fetch.

Lighter has no candle for a minute without trades, so a missing exit candle is often a quiet market, and leaving those
events out can bias the result. Two things show it. The report always prints an **exit-candle bias** line under each
horizon's tables: how many events were lost to a missing exit candle, and what the single leg did for them at the other
horizons, where they do have candles, next to the mean of all events there. And `--exit-fill carry` (default `exact`)
lets a missing **exit** candle take the last stored close at or before the exit minute, up to `--exit-carry-max-min`
(5) minutes back and never before the entry candle: the price stood where it last traded. The report counts the trades
that used it, per strategy. An entry candle is never carried; a trade needs a price at its signal.

## Reading the output

The report starts with one `CAVEAT` line (see [Limitations](#limitations)), then what was read: how many rows became
how many events, how many of them are backfilled and so skipped the live feed's book check, the costs, the beta
diagnostics per hedge (fallbacks with their reasons, and clamps), the exit fill mode and how many events had a
cross-pair partner.

For each horizon there are three tables: the strategies, the paired differences, and a per-symbol breakdown. This
sample (the first two, for the 15-minute horizon only) is from a run on **synthetic** data, a six-day database of seven made-up symbols
(`--since 2026-10-13 --min-usd 5000 --extra-hedges ETHUSDT`), to show the format; it says nothing about real markets:

```
=== Horizon 15 min ===
Net return per trade in bps of the liquidated leg's notional, after costs. expo: gross notional per unit of that notional.
strategy      n   mean  median  stdev  win%      t  sharpe     p5  maxDD  expo  mean/expo  excl
----------  ---  -----  ------  -----  ----  -----  ------  -----  -----  ----  ---------  ----
single      498  +23.0   +26.3   67.5   64%  +7.59  +0.340  -80.6  402.8  1.00      +23.0     5
btc-hedged  498   +6.0    +8.3   51.7   59%  +2.57  +0.115  -85.5  573.0  2.65       +2.2     5
eth-hedged  428  +17.3   +17.5   63.8   62%  +5.60  +0.271  -83.4  424.0  1.67      +10.4    75
cross-pair   38  +32.3   +28.3   70.3   66%  +2.83  +0.460  -72.7  144.7  2.00      +16.2     0
  excluded from single: exit candle missing 3, entry candle missing 2
  excluded from btc-hedged: exit candle missing 3, entry candle missing 2
  excluded from eth-hedged: exit candle missing 3, event is the hedge symbol 70, hedge candle missing 1, entry candle missing 1
  Exit-candle bias: 3 event(s) lack an exit candle at 15 min and are left out. Their single-leg mean net bps [n] at the horizons where they do have candles: 5 min +9.2 [3] (all events +4.5); 60 min -66.1 [3] (all events +16.1)

Paired differences, same events (bps of the liquidated leg's notional: what the extra leg(s) add, costs included; paired t)
strategy minus baseline            n   mean  stdev      t  win%
-------------------------------  ---  -----  -----  -----  ----
btc-hedged minus single          498  -17.0   44.9  -8.45   36%
eth-hedged minus single          428   -5.6   37.1  -3.14   41%
cross-pair minus trigger single   38  +23.4   73.9  +1.95   63%
cross-pair minus both singles     38   -3.8   23.6  -0.99   32%
  cross-pair minus trigger single: the partner leg added to the trigger's trade (hedging the trigger with the partner, entered late).
  cross-pair minus both singles: the pair against holding both legs from their own signals; this is what executing the pair has to beat.
```

- **Units.** Every return is in bps of the notional of the liquidated symbol's leg, after costs. A hedge leg of beta 1.5
  adds 1.5 times that notional of exposure and a cross pair adds 1 times: `expo` is the gross notional deployed per unit
  of the leg's, and `mean/expo` is the mean per unit of exposure. A pair strategy that earns more only because it
  risks more is not better; compare `mean/expo` and `sharpe`, not the raw `mean` alone.
- **`stdev`, `p5` and `maxDD` are not divided by `expo`.** That is deliberate. They answer: if I take this signal at the
  same primary size, what does the strategy do to the return I get and the risk I carry? A hedge that deploys 2.65 times
  the notional should cut `stdev`, `p5` and `maxDD` in these units, and a pair that doubles the notional should show the
  risk it adds. Dividing by `expo` would answer another question (risk per dollar of gross notional), would make any
  strategy that merely adds legs look safer, and would hide whether a hedge reduced risk at all. Capital efficiency is
  what `mean/expo` is for; `sharpe` is scale-free.
- **`n`** is the events with a result for that strategy and horizon; `excl` counts the ones left out, and the line
  under the table says why (entry or exit candle missing, hedge or partner candle missing, the event is on the hedge
  symbol, horizon not yet elapsed). `n + excl` is the number of events (the number of pairs, for `cross-pair`).
- **`win%`** is the share of trades with a positive net return. **`t`** is the t statistic of the mean (`mean / (stdev /
  sqrt(n))`). **`sharpe`** is `mean / stdev` per trade, not annualised. **`p5`** is the 5th percentile of the net
  return, the tail. **`maxDD`** is the largest peak-to-trough fall of the cumulative net return, adding up one unit per
  event in entry order, with no compounding and no overlap.
- **Paired differences** pair each strategy's trade with a baseline trade of the same events and test the difference, in
  the same units, with a paired t. Positive means the extra leg helped. There are three kinds of row:
  - *hedged minus single*: against the single leg of the same event. The difference is what the hedge leg earned less
    what it cost; because it removes market exposure, its mean is mostly the market's drift times beta, and its value
    shows in the spread and the tail (`stdev`, `p5`, `maxDD`, `sharpe`) more than in the mean.
  - *cross-pair minus trigger single*: against the triggering event's single leg. This is **hedging the trigger with the
    partner**: it is mostly the partner leg itself, entered late. It can be positive without pair execution adding
    anything, because a bot trading every symbol single-leg holds that partner leg already.
  - *cross-pair minus both singles*: against the trigger's single plus the partner's single, each entered at its own
    signal and held for the same horizon. Same exposure, same costs. This is the one that says whether executing the two
    legs as a pair beats what single-leg trading holds anyway. Its `n` can be smaller than the pair count: it needs the
    partner's own single leg to exist too.
- **Exit-candle bias** is the line after the excluded reasons: the events with no exit candle at that horizon, and their
  single-leg mean net bps at the horizons where they do have candles, next to the mean of all events there. A large gap
  means the survivors are not representative; run again with `--exit-fill carry` and see whether the conclusion moves.
- **Per symbol** shows the mean net bps and `[n]` for each strategy (cross pairs by the symbol that triggered them) and
  the mean differences (`d ...` columns; for the cross pair, to the trigger's single and, as `both`, to both singles).
  The `--json` output has the full per-symbol statistics, including t statistics.
- **Missing candles** at the end names the symbols that lost events to a missing candle, and prints the
  `npm run lighter:backfill -- --candles-only --symbols ... --days N` command that reaches back far enough. A hedge is
  named for its candles only when the **hedge** was short of history for the beta lookback (or has none stored); a
  liquidated symbol that was short of history is named itself; a flat hedge needs no fetching and is not named. Some
  gaps are real: a minute without trades may have no candle, and they remain after fetching.

## Before turning on any pair mode

None of this is a reason to trade; it is the minimum for continuing to look. A pair mode earns a forward test, not
real money, when **all** of these hold:

1. **A difference worth having, with evidence.** For a pair, the paired difference is positive with a paired `|t| > 2`,
   in the units above, after costs you would really pay, and for `cross-pair` that difference is **minus both singles**.
   *Minus trigger single* is hedging the trigger with the partner, not a reason to execute a pair: it is mostly the
   partner leg, which single-leg trading already holds. Re-run with your actual `--fee-bps` and a `--slippage-bps` you
   believe (try 2 to 5); a result that needs zero slippage is not a result. For a hedge, whose point is risk, the
   evidence may instead be a clearly better `sharpe`, `p5` and `maxDD` with a mean per exposure that is not worse.
2. **Enough events.** Look at `n` of the strategy you care about, not the total: `cross-pair` has only the events that
   found a partner, often a small share. Treat fewer than about 100 events for a hedge, or about 30 pairs for
   `cross-pair` (count the `n` of *minus both singles*), as anecdote. Overlapping and clustered events are counted as
   independent, so the real evidence is weaker than `t` says.
3. **Several symbols, not one.** The per-symbol table shows the difference with the same sign in most symbols that have a
   reasonable `n` (say 15 or more events). One symbol that carries the total is a coincidence until shown otherwise.
4. **Stable across horizons.** The same sign, and `|t| > 2`, at 5, 15 and 60 minutes. With three horizons and up to four
   comparisons per horizon you are reading about a dozen, and one `|t|` near 2 among them is expected by luck.
5. **Stable in time.** Split the window and run it twice, `--until 2026-10-14 --until-exits` then `--since 2026-10-14`.
   The sign and rough size should survive in the half you did not look at first. A single run is in-sample by
   construction. The halves are not perfectly separate: a trade entered shortly before the split exits after it, so
   without `--until-exits` the first half uses up to the longest horizon (60 minutes by default) of the second half's
   prices. `--until-exits` drops those trades, counted as `exit past --until`. The second half's beta looks back into
   the first half, which is fine: that data was known by then.
6. **Not an artefact of the data.** The `Book check` line says how many events are backfilled rows, which never faced the
   live feed's order-book gate, so they lean optimistic. Re-run as the bot records live rows (shadow mode records
   them) and the share drops. Also check `excl` and the exit-candle bias line: if many events are excluded for missing
   candles, the survivors may not represent the rest; compare with `--exit-fill carry`.
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
  1m returns say. A liquidation cascade is exactly when betas change. Check the fallback (with its reasons) and clamp
  counts in the report.
- **Thin symbols.** Candles of illiquid symbols have holes; the exclusions are counted, never filled, unless you ask
  for `--exit-fill carry`, which fills only a missing exit, from the last close, and counts it.
- **`--burst-sum` is an approximation.** The bot's threshold window slides and has a cooldown; this one is a fixed
  window anchored on the burst's first row.
- **Volumes and units.** Lighter volumes are USDC, treated as USDT, as in the rest of the bot.

## Options

| Option | Default | |
|---|---|---|
| `--venue aster\|lighter` | `lighter` | Whose liquidations to read |
| `--candle-venue aster\|lighter` | the venue | Whose candles to price with. Only Lighter candles are stored. |
| `--include-skipped` | off | Also use detections the feed did not trade |
| `--symbols A,B` | all | Only these symbols |
| `--since TIME` / `--until TIME` | none | Event-time window, UTC (`2026-10-12` or `2026-10-12T06:00:00Z`); a date that does not exist is rejected |
| `--until-exits` | off | With `--until`: also leave out trades whose exit closes after it |
| `--min-usd N` | 0 | Ignore liquidations below N USD, each row on its own |
| `--burst-sum` | off | Apply `--min-usd` to the total of the burst (rows of a symbol and side within `--dedupe-sec`); the event is the row where it crosses |
| `--dedupe-sec N` | 60 | One event per symbol and side within N seconds |
| `--horizons 5,15,60` | `5,15,60` | Holding times in whole minutes |
| `--hedge-symbol S` | `BTCUSDT` | The hedge leg of `btc-hedged` |
| `--extra-hedges A,B` | none | More hedged strategies, one per symbol |
| `--hedge-sizing beta\|dollar` | `beta` | Hedge notional = beta x the leg, or equal |
| `--beta-lookback N` | 240 | Minutes of 1m returns before the event |
| `--beta-min-obs N` | 30 | Fewer paired returns than this: beta 1, counted with its reason |
| `--pair-window-sec N` | 120 | Window for an opposite-direction partner |
| `--exit-fill exact\|carry` | `exact` | A missing exit candle excludes the event (`exact`) or takes the last stored close (`carry`) |
| `--exit-carry-max-min N` | 5 | With `carry`: the furthest back from the exit minute to look |
| `--fee-bps N` | 5 | Fee per leg and side |
| `--slippage-bps N` | 0 | Slippage per leg and side |
| `--json PATH` | none | Write the full result as JSON |
| `--json-trades` | off | Include every trade in the JSON (large) |

The JSON has the options, the event counts, the per-strategy and per-horizon metrics with exclusion counts, carried
exits and per-symbol statistics, the paired-difference statistics (overall and per symbol; each entry names its
`baseline`: `single`, and for `cross-pair` also `both-singles`), the exit-candle bias per horizon (`exitGapBias`), the
hedge diagnostics with the beta fallback reasons, the symbols with missing candles and the caveats.
