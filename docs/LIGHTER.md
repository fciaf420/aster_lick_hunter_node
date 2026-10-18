# Lighter (zkLighter): setup and status

Lighter is an order-book perpetuals exchange on an Ethereum zk-rollup, with USDC as collateral. The bot supports it in
two roles, and both are in **beta**:

- **Trading venue**: the bot places entries, stop losses and take profits on Lighter.
- **Liquidation source**: the bot reads liquidations from Lighter's public trade stream. It can trade them on Lighter or
  on Aster.

Beta means it is built and tested offline, but it has **not been run with live funds yet**. Several exchange behaviours
the bot relies on could not be confirmed without a live connection (see [What is verified](#what-is-verified-and-what-is-not)).
It therefore defaults to **testnet**, and the Lighter liquidation feed starts in **shadow mode**.

## Contents

1. [Before you start](#before-you-start)
2. [Setup, step by step](#setup-step-by-step)
3. [Shadow mode for the liquidation feed](#shadow-mode-for-the-liquidation-feed)
4. [How the bot trades on Lighter](#how-the-bot-trades-on-lighter)
5. [Hedge mode (two sub-accounts)](#hedge-mode-two-sub-accounts)
6. [Dashboard limitations](#dashboard-limitations)
7. [What is verified and what is not](#what-is-verified-and-what-is-not)
8. [Live checks (`npm run lighter:check`)](#live-checks-npm-run-lightercheck)
9. [Troubleshooting](#troubleshooting)

## Before you start

| Topic | Details |
|---|---|
| Networks | **Testnet** (default, chain 300, test funds) and **mainnet** (chain 304, real funds). Robinhood and Robinhood testnet are listed but **disabled** until they are verified. The bot cannot select them. |
| One network per process | The native signer keeps one chain id per process. Changing the network takes effect only after a bot restart. |
| Credentials are per network | API keys, account indexes and nonces differ between testnet and mainnet, so keys created on testnet do not work on mainnet. |
| Margin asset | USDC. Balances and PnL are reported in USDC. Symbol volume thresholds (`longVolumeThresholdUSDT`, ...) are compared with USDC notionals as if 1 USDC = 1 USDT. |
| Position mode | One-way per account. Lighter nets one position per market per account, so with one account the bot ignores `HEDGE` and uses one-way mode. Optional **hedge mode** puts the shorts on a second sub-account: see [Hedge mode (two sub-accounts)](#hedge-mode-two-sub-accounts). |
| Platforms | linux-x64 / arm64 (glibc; Alpine/musl is **not** supported), macOS arm64 / x64, Windows x64. The signer is a 64-bit native library. |

## Setup, step by step

### 1. Open a Lighter account

- **Testnet:** go to <https://testnet.app.lighter.xyz> and connect a wallet. Testnet hands out test USDC.
- **Mainnet:** use <https://app.lighter.xyz>. Only switch to mainnet after the testnet run and the shadow-mode period below.

### 2. Create an API key for the bot

The bot signs with a Lighter **API key**, not with your wallet key.

1. Register a new API key on the **same network** you will trade on. The supported tool is the official Python SDK
   (`elliottech/lighter-python`): set your account and network in `examples/system_setup.py` and run it. It generates a
   key pair and registers its public key with one signature from your Ethereum key. That Ethereum key is used only by
   the SDK, on your machine, and never reaches the bot.
2. Use an **API key index other than 0**: the Lighter web app uses key 0, and registering 0 would replace its key.
3. Write down four values:
   - the **account index**,
   - the **API key index**,
   - the key's **private key** (40 bytes of hex: 80 characters, optionally `0x`-prefixed),
   - the key's **public key** (also 80 hex characters).
4. Optional hardening: give the bot its own sub-account, so that a mistake can only affect the funds in that sub-account.

### 3. Install the signer

Lighter transactions are signed by Lighter's native signing library (Go, loaded through `koffi`). Install it once per
machine:

```bash
npm run lighter:signer              # download for this platform and verify the pinned sha256
npm run lighter:signer -- --verify  # check the installed file only (no network)
```

The installer and the bot handle the library as follows:

- **Pinned:** the library is downloaded from one pinned `lighter-python` commit (`5825eb1`). It is rejected unless its
  sha256 matches the pinned hash, and the bot checks the hash again every time it loads the library.
- **Location:** it is installed to `vendor/lighter-signer/`, which is gitignored. To use a file elsewhere, set the
  `LIGHTER_SIGNER_PATH` environment variable.
- **Proxy:** downloads go through `HTTPS_PROXY` when it is set (`http://` proxies only).
- **Where it loads:** only the **bot process** loads the signer. It refuses to load inside Next.js (the web UI) and in
  browsers.
- **Tests:** the native signing tests skip when the library is missing. Set `LIGHTER_SIGNER_REQUIRED=1` (for example in
  CI after `npm run lighter:signer`) to make a missing library fail the test run instead.

### 4. Configure the bot

You can configure Lighter in the web UI or in the config file.

**In the web UI** (`/config`, *Exchange* tab):

1. Under **Trading venue**, select **Lighter** (it shows a *Beta* badge).
2. Under **Lighter network**, select **Lighter testnet**. A banner shows the network and whether it uses test funds or
   real funds.
3. Enter the account index, API key index, API private key (a password field) and API public key.
4. Leave **Paper Mode** on for the first run (*Global Settings* tab).

**In `config.user.json`:**

```json
{
  "global": { "exchange": "lighter", "liquidationSource": "lighter", "paperMode": true, "positionMode": "ONE_WAY" },
  "venues": {
    "lighter": {
      "profile": "testnet",
      "accountIndex": 12345,
      "apiKeyIndex": 3,
      "apiKeyPrivateKey": "0x…80 hex characters…",
      "apiKeyPublicKey": "0x…80 hex characters…",
      "liquidationsLive": false,
      "sltpSlippagePct": 1,
      "sendTxPerMin": 60
    }
  }
}
```

| Field | Default | Meaning |
|---|---|---|
| `profile` | `testnet` | Network: `testnet` or `mainnet`. The Robinhood profiles are refused. |
| `accountIndex`, `apiKeyIndex`, `apiKeyPrivateKey`, `apiKeyPublicKey` | none | Credentials for that network. All four are required for live trading. |
| `liquidationsLive` | `false` | `false` keeps the Lighter liquidation feed in **shadow mode** (logged, never traded). |
| `sltpSlippagePct` | `1` | Worst fill price of a triggered stop loss or take profit, as a percent beyond the trigger price (maximum 10). |
| `sendTxPerMin` | `60` | Client-side limit on transactions sent per minute. The standard-tier server limit is not known yet. |
| `symbolOverrides` | none | Bot symbol → Lighter symbol, for example `{ "QNTUSDT": "QNT" }` or `{ "NOTUSDT": { "market": "1000NOT", "multiplier": 1000 } }`. See [Symbols](#symbols). |

**Where the keys are kept:**

- The keys stay in `config.user.json`, which is gitignored.
- The config broadcasts to dashboard clients leave out both `api` and `venues`.
- The Lighter private key is only ever used inside the bot process.

### 5. Start the bot and read the startup checks

Run `npm run dev` (or `npm start`). With Lighter credentials set, the bot prints the network and runs these checks
before anything can trade:

1. `GET /` (network status) answers. `network_id` is compared with the chain id and only logged: whether the two should
   match is not confirmed.
2. The configured public key equals the key registered for your account and key index (`GET /api/v1/apikeys`). This
   catches the wrong network or the wrong key index.
3. An auth token signed with your private key is accepted, and the key is **not maker-only**. A maker-only key would see
   every taker entry rejected.
4. Account tier and taker fee are read and logged.
5. Transactions from an earlier run that the bot logged as sent but never saw confirmed are resolved (journal in
   `data/lighter.db`).

If any check fails in **live mode, the bot stops**. In paper mode it logs the failure and keeps running. In either mode,
trading methods refuse to sign until the checks pass.

### 6. Paper mode, then testnet, then mainnet

1. **Paper mode on testnet.** Watch the dashboard and logs: positions, balances (USDC) and market data should look right.
2. **Live on testnet.** Turn paper mode off and keep `profile: "testnet"`. These are real orders with test funds. Check
   the following:
   - entries fill;
   - stop loss and take profit appear as one native OCO pair;
   - closing a position cancels its pair;
   - restarting the bot keeps everything in sync.
3. **Mainnet.** Only after the live checks below and the shadow-mode period. Set `profile: "mainnet"`, enter **mainnet**
   keys and restart. The network banner turns red and reads *REAL FUNDS*.

## Shadow mode for the liquidation feed

With **Lighter liquidations** as the liquidation source, the bot subscribes to `trade/{market}` for every configured
symbol that maps to a Lighter market. It falls back to `trade_fe/{market}` if the first channel is not acknowledged. It
also subscribes to `market_stats/all` for mark prices and best bid/ask.

The feed takes these steps:

- **Liquidations only:** it uses only trades of type `liquidation`. It never uses `deleverage` (ADL) or settlement trades.
- **No replay:** it never trades from the snapshot it receives when it subscribes, and it removes duplicate trade ids.
- **Grouping:** it groups the fills of one liquidation and emits the group 300 ms after the last fill (at most 1 s after
  the first).
- **Age limit:** it drops liquidations older than 10 s.
- **System accounts:** it drops fills against Lighter's liquidity pool (`systemConfig.liquidity_pool_index`), the
  insurance-fund operator (account 1) and the market's insurance-fund account. Until `systemConfig` has loaded (it is
  retried after 2, 5, 10, 30 and then every 60 s), nothing is passed to the hunter, because liquidity-pool takeovers
  can't be told apart yet.
- **Open interest cap:** when trading on Lighter, a market whose `market_stats` shows `open_interest x 2 >=
  open_interest_limit / 1e6` is skipped: the exchange only accepts reduce-only orders there.

**Why shadow mode is the default:** which side was liquidated is **inferred**. Lighter documents no field for it. The bot
assumes the liquidated account is the taker, so `is_maker_ask = false` means a forced SELL (a long was liquidated). If
that assumption is wrong, every trade goes the wrong way.

In **shadow mode** (`liquidationsLive: false`) every detection is logged, including which fills were excluded and the
best bid/ask notes, and nothing is passed to the hunter.

### Side verification gates

In live mode a liquidation reaches the hunter only when **every** gate below passes. A skipped signal is still logged,
with the failed gate as the reason (`not traded: side unverified: ...`).

- **One direction per transaction:** if the same transaction has fills on both sides of the book, every fill of it
  is skipped (`tx has fills on both sides`).
- **Taker position fields present:** `taker_position_size_before` and `taker_position_sign_changed` must be on every
  fill. If Lighter leaves them out, the signal is skipped rather than guessed.
- **No flip:** no fill has `taker_position_sign_changed = true`. Liquidation orders are internal immediate-or-cancel
  orders, so the liquidated account is the taker, and a liquidation reduces its position without flipping it.
- **Fill within the taker's position:** each fill is no larger than the taker's position before it (so a taker with no
  position fails).
- **Direction matches the taker's position:** a forced SELL is skipped when the taker was short (negative size). A
  forced BUY is skipped when the taker was long (positive size) once Lighter has shown signed sizes.
- **Book check:** uses the newest `market_stats` best bid **and** best ask whose frame timestamp is earlier than the
  liquidation's first trade timestamp (and no more than 10 s older). `market_stats` and trades are separate channels,
  so the book a sweep leaves behind can arrive before the sweep's own trades; picking the book by exchange time keeps
  a sweep from failing (or passing) its check on the book it moved. Every fill of a forced SELL must be at or below
  that mid, and every fill of a forced BUY at or above it. A missing or stale book, a `market_stats` frame without a
  timestamp, or a fill without a usable trade timestamp fails closed.

**Before switching it live:**

1. Run shadow mode for **at least 7 days**.
2. Compare the logged liquidations (side, size, price, time) with the market. The BBO notes are the strongest check:
   - a forced SELL should print at or below the best bid;
   - a forced BUY should print at or above the best ask.
3. Recalibrate the volume thresholds. Lighter reports every liquidation, while Binance-style feeds send at most one per
   symbol per second, so the same thresholds behave differently.
4. Switch it live with the **Trade on Lighter liquidations** switch, or with `"liquidationsLive": true`. The change
   applies on config reload, without a restart.

### Cross-venue mark-ratio guard

When the liquidation source and the trading venue differ (Lighter liquidations traded on Aster, or Aster liquidations
traded on Lighter), a symbol only trades while Lighter's mark price and the other venue's mark price are **within 2%**.

- **When it runs:** at startup, 15 s later (once streaming marks arrive) and every 5 minutes.
- **What it prevents:** a ×1000 scale mismatch (`NOTUSDT` vs `1000NOT`) or a ticker that names a different instrument
  (a stock on one venue and a token on the other). Either one would trade on every liquidation.
- **Fail closed:** a symbol is blocked until its first check passes.
- **When the guard cannot read prices:** it keeps its previous results.
- **Alerts:** a blocked symbol raises a dashboard alert once, when it becomes blocked.

## How the bot trades on Lighter

### Symbols

The bot maps bot symbols to Lighter markets like this:

- `BTCUSDT` maps to Lighter `BTC` only when it is one of your configured symbols. Unconfigured symbols are never traded.
- Lighter tickers that name stocks, ETFs, FX pairs, commodities or ambiguous tokens are **never mapped automatically**.
  Examples are `BB` (BlackBerry), `COIN`, `QNT`, `WEN` and `EURUSD`. Add them under `symbolOverrides` if you mean them.
- Lighter uses `1000PEPE`-style names, not display names like `kPEPE`.
- An override with a multiplier (for example `NOTUSDT` → `1000NOT` ×1000) only feeds liquidations. It can never be
  traded on Lighter.

Market data (precision, minimum size, minimum notional, maximum order value, maximum leverage) refreshes every 5 minutes.
New entries are refused for markets that:

- are inactive, reduce-only or isolated-only;
- are still listed with Lighter's own scaling (`multiplier ≠ 1`).

Closing and protecting an existing position still works in such a market.

### Orders

| Bot action | Lighter transaction |
|---|---|
| LIMIT (GTC / GTX / IOC) | Limit order. GTC and GTX expire after 28 days. The price is rounded to the tick: buys down, sells up. FOK is refused. |
| MARKET | Market order with an explicit worst price: best ask (or bid) ± the symbol's `maxSlippageBps` (default 50). |
| Stop loss + take profit | One native **OCO** pair: both legs are reduce-only, sized from the confirmed position, with one shared expiry. The worst price is the trigger ± `sltpSlippagePct`. If the exchange refuses the OCO, the bot sends both legs in one batch instead. |
| Cancel | By client order index. An order that is already closed counts as cancelled. |
| Leverage | `UpdateLeverage`, cross margin, capped at the market maximum. It is skipped when the account already has that leverage. |

Before the bot reports an order as placed, it waits for the transaction to execute and reads the order back.

**Order ids** are client order indexes: numbers below 2^48 that the bot assigns. The exchange's own order index can
exceed 2^53, so it is kept as an exact string.

**Nonces:** the bot uses one nonce sequence per API key, sends transactions through a rate limiter, and logs each
transaction to a journal before sending it. After a timeout it resends the identical transaction; it never re-signs one
with a new nonce, which could duplicate an order. A refused resend alone is not proof the original never ran; the bot
keeps checking the transaction and `nextNonce`:

- If `nextNonce` stays at or below the transaction's nonce for 3 reads over at least 10 s after the refusal, the
  transaction is **presumed** not executed.
- The API key is never blocked for more than about **45 s**: the bound is checked before every request, and each
  request's timeout is cut to what is left of it. After that (or once presumed not executed) the key is released,
  so stop losses, take profits, cancels and closes go out, and the transaction is watched in the background until it
  expires (about 10 minutes). It is never resent or re-signed in the background.
- If it executes after all, that is logged as an error and shown on the dashboard. The position it opened is picked up
  and protected by the position manager's 30 s check. Once a later transaction uses the same nonce, the old one can no
  longer execute. Background watching stops when the bot shuts down; anything unresolved stays in the journal and is
  reconciled on the next start.

**No double entries:** when an entry's outcome is unknown or only presumed (a timeout, or a transaction that executed
but whose order is not visible yet), the hunter does **not** fall back to a MARKET order. The symbol stays blocked
until the transaction can no longer execute (its expiry plus 5 s, about 10 minutes), or for 11 minutes when that is not
known. The same applies when the MARKET fallback itself ends unknown. Only a definite refusal (the exchange rejected
the transaction, its execution failed, or the order was invalid) allows the MARKET fallback.

**Prices for SL/TP:** Lighter triggers stop loss and take profit on the mark price, so the price the bot checks them
against (`getTickerPrice`) is the mark too, not the last trade. New positions are also refused before signing when the
market is at its open interest cap. Reduce-only orders (SL/TP, closes) re-read the account for up to about 1.5 s when it
does not yet show the position the user stream reported. If the account still shows a smaller position, SL/TP are
placed at that size and the shortfall is reported as an error; the position manager logs it and its 30 s check replaces
SL/TP that are smaller than the position.

## Hedge mode (two sub-accounts)

Lighter nets one position per market per account. On a single account the bot therefore runs one-way: an opposite
signal reduces or flips the open position. **Hedge mode** spreads the two sides over two sub-accounts of the same
master account. A long and a short on the same symbol can then be open together, each with its own stop loss and take
profit, as on Aster in hedge mode.

Hedge mode is **off by default**. It needs a second sub-account with its own API key and its own USDC.

### How it works

- **Long account:** the main account (`venues.lighter.accountIndex` and its API key) holds every long.
- **Short account:** a second sub-account (`venues.lighter.hedge.shortAccount`) holds every short.
- **Routing by position side:** in hedge mode every bot order carries `positionSide` `LONG` or `SHORT` and goes to
  that side's account. An order without `LONG` or `SHORT` is refused before anything is sent.
- **Opening orders:** only a BUY on the long account or a SELL on the short account can open or grow a position.
- **Everything else is reduce-only:** stop losses, take profits and closes are sent reduce-only, on the same account as
  their position. So is any SELL on the long account and any BUY on the short account. The exchange therefore never
  lets them grow or flip a position.
- **Wrong-direction check:** before every entry the bot reads the target account. If the long account holds a short,
  or the short account a long (for example after a manual trade), new entries on that account are refused until the
  position is closed. See [Operations](#operations).
- **Separate order ids:** each account's bot orders use their own client order index range: below 10^14 on the long
  account, 10^14 to 2·10^14 on the short account. An order id therefore tells which account it is on, and a cancel goes
  to that account first.
- **One merged view:** positions, open orders and balances of both accounts are read together. The bot sees one account
  with `LONG` and `SHORT` positions. If either account cannot be read, the whole read fails: half a picture would make
  the bot drop the other side's positions. The user streams of both accounts are merged the same way, and position
  updates start only once both accounts are known. Every merged REST read of the positions (the bot's 30 s sync, and
  its re-sync on reconnect) also updates the merged stream. So when one account's stream lags behind (reconnecting, or
  a late or lost update), an update of the other account never carries an older view of it than the bot already has,
  and never makes the bot cancel the SL/TP of a live position there.
- **Margin per side:** the pre-trade margin check reads only the account the entry goes to. A short entry checks the
  short account's available USDC. `maxPositionMarginUSDT` already applies per side.
- **Leverage** is set before each entry, on the account that entry goes to. A leverage failure on one account
  therefore never blocks entries on the other.

### When it is on

Hedge mode is active only when **all four** conditions hold:

1. The trading venue is **Lighter**.
2. The position mode (`global.positionMode`) is **`HEDGE`**.
3. Hedge mode is switched on in the Lighter settings (`venues.lighter.hedge.enabled: true`).
4. The **short account is complete**:
   - its account index, API key index, private key and public key are all set;
   - its account index differs from the main account's.

The switch is required because `positionMode` defaults to `HEDGE`. Without it, filling in a short account would
silently switch a running one-way setup to two accounts.

If the switch is on but the short account is incomplete:

- **Paper mode:** the bot logs a warning and runs one-way on the main account.
- **Live:** the bot refuses the config with *"Lighter hedge mode needs a complete short account when not in paper mode:
  ..."*. Fill in the short account or turn hedge mode off.

**A single account stays plain one-way.** Without hedge mode nothing changes. With `positionMode: "HEDGE"`, the bot
logs at startup that Lighter has no hedge mode and falls back to `ONE_WAY`. An opposite signal then reduces or flips
the open position, exactly as on Aster in one-way mode.

### Setting up hedge mode

Do this on the network you trade on, testnet first. Sub-accounts, account indexes and API keys are per network.

1. **Create a sub-account.**
   - In the app: open the sub-accounts page on app.lighter.xyz (or testnet.app.lighter.xyz) and create one.
   - With the SDK: run lighter-python's `examples/accounts/sub_account_create.py` (`client.create_sub_account()`). It
     signs with the master account's API key.
2. **Find its account index.** `GET /api/v1/accountsByL1Address?l1_address=...` lists the master account and every
   sub-account under `sub_accounts[].index`. The master account has the lowest index.

   ```bash
   curl "https://testnet.zklighter.elliot.ai/api/v1/accountsByL1Address?l1_address=0xYourWalletAddress"
   ```

   On mainnet the host is `https://mainnet.zklighter.elliot.ai`.
3. **Create an API key on the sub-account**, with a key index other than 0.
   - In the app: create the key with the sub-account selected.
   - With the SDK: in lighter-python's `examples/system_setup.py`, set the network, your master wallet key,
     `API_KEY_INDEX` and `ACCOUNT_INDEX` (the sub-account's index), then run it. It registers the key
     (`change_api_key`) with your master wallet's signature, and the wallet key stays on your machine.
   - Note the key index, the private key and the public key.
4. **Transfer USDC to the sub-account.**
   - In the app: transfer between your sub-accounts.
   - With the SDK: `client.transfer_same_master_account(...)` (see `examples/accounts/sub_account_transfer_usdc.py`),
     with `asset_id=client.ASSET_ID_USDC`, and set **both routes to perp**: `route_from=client.ROUTE_PERP`,
     `route_to=client.ROUTE_PERP`. The example sends to the spot route, and USDC on spot is not perp collateral.
   - Transfers between sub-accounts are free.
5. **Enter it in the bot and restart.**
   - Open `/config`, then the *Exchange* tab, then the **Hedge mode (two sub-accounts)** section of the Lighter
     settings.
   - Enter the short account index, API key index, API private key and API public key.
   - Switch hedge mode on. This also sets the position mode to Hedge; the *Use hedge position mode* button does the
     same.
   - The status line reads *Hedge mode active after the bot restarts* when everything is set.
   - Save, then **restart the bot**.
6. **Read the startup checks.**
   - The bot logs `Lighter hedge mode: long account A (key a), short account B (key b)`.
   - **Per-key checks:** each account runs the checks from
     [step 5 of the setup](#5-start-the-bot-and-read-the-startup-checks): registered key, matching public key, auth
     token, not maker-only, tier, journal.
   - **A failure names its account**, for example `short account 23456 key 4: API key 4 is not registered ...`. In
     live mode the bot stops; in paper mode it logs the failure and keeps running.
   - **Same master:** the bot compares the two accounts' L1 addresses. If they differ it warns, but it still starts:
     the accounts are not sub-accounts of one master.
   - **Wrong direction:** both accounts are scanned for a position of the wrong direction, and each one raises an
     alert.

### Example config

```json
{
  "global": { "exchange": "lighter", "paperMode": true, "positionMode": "HEDGE" },
  "venues": {
    "lighter": {
      "profile": "testnet",
      "accountIndex": 12345,
      "apiKeyIndex": 3,
      "apiKeyPrivateKey": "0x…80 hex characters…",
      "apiKeyPublicKey": "0x…80 hex characters…",
      "hedge": {
        "enabled": true,
        "shortAccount": {
          "accountIndex": 23456,
          "apiKeyIndex": 4,
          "apiKeyPrivateKey": "0x…80 hex characters…",
          "apiKeyPublicKey": "0x…80 hex characters…"
        }
      }
    }
  }
}
```

| Field | Default | Meaning |
|---|---|---|
| `hedge.enabled` | off | Turns hedge mode on, together with `positionMode: "HEDGE"`. |
| `hedge.shortAccount.accountIndex` | none | The sub-account that holds the shorts. It must differ from `accountIndex`. |
| `hedge.shortAccount.apiKeyIndex`, `apiKeyPrivateKey`, `apiKeyPublicKey` | none | The short account's own API key, in the same formats as the main key. |

Some rules apply to both accounts:

- **One network:** both accounts use the same `profile`, since there is one network per process.
- **Where the short key is kept:** the same places as the main key. It is stored in `config.user.json`, left out of
  the dashboard broadcasts, and never logged. Logs show account and key indexes only.

### Operations

- **Fund both accounts.** Each account has its own margin, available balance and liquidation price, and the bot never
  moves funds between them. Watch both:
  - when the short account runs low, short entries are skipped by its margin check while longs continue;
  - each account can be liquidated on its own.

  The dashboard balance is the sum of both accounts. When `/api/balance` reads the balance over REST
  (`source: "rest-account"`), it also lists each account under `accounts.long` and `accounts.short`.
- **Close the main account's shorts before enabling.** The main account becomes the long account. A short already
  open there counts as a wrong-direction position, and long entries are refused until it is closed.
- **Wrong-direction alert:** for example, *"Lighter hedge: the long account (12345) holds a short ETHUSDT position
  (-0.5), the wrong direction for this account (manual trade?)"*. It usually comes from a manual trade, or from a
  position opened before hedge mode was on.
  - The position stays protected: the bot keeps reduce-only SL/TP on its account.
  - New entries on that account (any symbol) are refused until the position is closed, each with a single error and
    no MARKET fallback (the fallback would be refused the same way). The bot does not close it itself, because a
    market close of that position would count as an entry. A wrong-direction position already past its take-profit
    level gets only its stop loss: its take profit would trigger at once, and the market close is refused.
  - Close it on app.lighter.xyz, or let its stop loss or take profit close it. The alert re-arms once the account is
    clear.
- **Switching back to one-way** (hedge mode off, or position mode `ONE_WAY`, then a restart): the bot only trades and
  manages the main account.
  - Positions left on the short account keep their exchange SL/TP only until those expire: Lighter trigger orders
    expire 28 days after they are placed, and the bot no longer renews them, nor resizes them when you change a
    position by hand. After that, a position left there has no stop loss.
  - The bot warns at startup: *"short account N is not managed in one-way mode ..."*, and lists the positions left
    there when it can read the account.
  - Close the short account's positions first.
- **Changes need a restart:** turning hedge mode on or off, changing the short account, and changing the network. When
  such a change is saved, the bot logs *"restart the bot to apply them"*.
- **Dashboard:** positions of both accounts are listed, `LONG` from the long account and `SHORT` from the short
  account. Closing from the dashboard is still refused (HTTP 409).

### Limitations

- **The two accounts can trade with each other.** Lighter's self-trade check works per account. A long entry can
  therefore fill against a resting order of the short account, and the other way round. Both sides pay fees on a trade
  that nets to nothing.
- **Four private WebSocket connections** instead of two: the bot keeps two per account.
- **Rate limits:** each account has its own transaction rate limiter (`sendTxPerMin`) and its own nonce sequence.
- **`maxOpenPositions` counts a hedged pair once:** a long and a short on the same symbol count as one position.
- **Leverage is set per account,** before each entry on that account. If it fails, that entry is not placed; entries
  on the other account are not affected.
- **Emulated, not native:** the venue catalog still lists Lighter as one-way, since Lighter itself has no hedge mode.

## Dashboard limitations

Only the bot process can sign, so the web UI talks to Lighter **read-only**:

| Feature | Behaviour with Lighter |
|---|---|
| Positions, balance (USDC), prices, symbol picker | Work. These are public reads. |
| SL/TP badges on positions | Shown as **Unknown (managed by the bot)**: reading your open orders needs a signed auth token. |
| **Close position** button | Refused with HTTP 409: *"Closing Lighter positions from the dashboard is not supported..."*. Close it on app.lighter.xyz, or let the bot's stop loss or take profit close it. The bot's WebSocket server has no client authentication, so a close command is deliberately not routed through it. |
| Trade, order and income history, PnL charts | Empty for now (no Lighter mapping yet). |
| Live mark-price and VWAP streams | Not used. Lighter has no Binance-format streams, so positions, SL/TP checks and VWAP use REST market data. |

## What is verified and what is not

**Verified offline** (unit and integration tests, no network):

- The five signer binaries match the pinned hashes, and the signing ABI matches (struct sizes, argument order).
  Signing was run against the real library with a throwaway key.
- Price and size scaling uses exact decimal arithmetic, checked with the worked examples from the spec. Every integer
  is range-checked before it reaches the native library.
- The market metadata parser and the symbol-mapping guards.
- The nonce flow:
  - resend the identical transaction after a timeout, never re-sign with a new nonce;
  - re-fetch and re-sign on an "invalid nonce" answer;
  - restart recovery from the journal.
- Liquidation detection: grouping, duplicate removal, snapshot handling, exclusions and shadow mode.
- The user-stream translation into the bot's events:
  - a full position set on every account update;
  - all 17 order statuses mapped, and an unknown status raises an alert rather than counting as inactive.
- The wiring: read-only adapters in the web UI, the 409 close route, the mark-ratio guard, the config schema and the
  migration.

**Not verified: needs a live exchange.** These are the spec's §9 questions. Until they are answered the bot takes the
cautious option:

| # | Question | What the bot does meanwhile |
|---|---|---|
| Q1, Q4 | Shape of the `trade/{id}` payload; do all fills of one liquidation share a tx hash and arrive in one frame? | Reads both `trades` and `liquidation_trades`, removes duplicates, groups by tx hash and taker order, falls back to `trade_fe`. |
| Q2 | Is the liquidated account the taker? | **Shadow mode by default**; excludes system accounts; in live mode a liquidation is traded only when the side verification gates (book mid, taker position) pass. |
| Q3, Q7 | Timestamp units (trades, orders, candles) | Normalizes by magnitude; requests candles in ms. |
| Q5 | WebSocket limits | Subscribes only to configured markets; raises an alert for markets that are never acknowledged. |
| Q6 | Market invariants (decimals sum to 6, multiplier 1) on each network | Refuses any market that breaks them. |
| Q8 | Which balance field equals "wallet balance" | Uses `collateral`. |
| Q9 | Nonce rules, and whether resending is idempotent | Journal plus resend of the identical transaction only. |
| Q10 | Does the server accept an OCO with an explicit size? | Falls back to two orders in one batch. |
| Q11 | What happens on the WebSocket when the auth token expires | Refreshes 30 min early, resubscribes, and reconciles over REST every 30 s. |
| Q12 | `price_protection` semantics | Leaves it out, as the Python SDK does. |
| Q13 | Are reduce-only orders below the minimum size accepted? | Allows them for closing and protection only. |
| Q14 | Fee units on trades | Commission is reported as negative USDC. |
| Q16 | sendTx rate limit (standard tier) | Client-side limit of 60/min with a burst of 10 (`sendTxPerMin`). |
| Q17 | Does `network_id` equal the chain id? | Logs a mismatch, does not stop. |
| Q18 | Robinhood collateral and markets | **Robinhood stays disabled.** |
| Q19 | Size of `order_index`; does it arrive as a JSON number above 2^53? | Reads `order_id` strings, never the rounded number. |
| Q20–Q22 | Reuse of client order indexes; stand-alone reduce-only SL with size 0; maker-only keys | Never reuses an index; never sends size 0; checks for a maker-only key at startup. |
| Q23 | Official cross-venue symbol map | Explicit allowlist and overrides, plus the mark-ratio guard. |

## Live checks (`npm run lighter:check`)

`scripts/lighter-live-check.ts` answers the **read-only** questions (Q1–Q3, Q5–Q7, Q17–Q19, Q23) and prints a report. It
**never signs and never sends a transaction**.

```bash
npm run lighter:check                                    # all read-only checks against mainnet (no key needed)
npm run lighter:check -- --profile testnet --checks Q6,Q7,Q17
npm run lighter:check -- --duration 1800 --checks Q1,Q2  # 30-minute trade-stream capture (spec Q1)
npm run lighter:check -- --compare-profiles --checks Q6,Q17   # every network, including Robinhood
npm run lighter:check -- --json lighter-check.json       # also save the raw results
```

Liquidations are rare on testnet, so run Q1 and Q2 against **mainnet**. They are public reads and need no key.

| Check | What it records |
|---|---|
| Q1 | Acknowledgements, channel separator, top-level keys, snapshot sizes, `type` values, overlap between `trades` and `liquidation_trades`, server ping cadence |
| Q2 | `/trades?type=liquidation` without auth: `is_maker_ask`, `taker_position_size_before`, sign flips, system-account counterparties; BBO cross-check over the Q1 capture |
| Q3 | Units of `timestamp` and `transaction_time` against your clock (and of your orders' times, with a token) |
| Q5 | Acknowledged subscriptions for every active market on one socket; how many parallel sockets are accepted (`--max-sockets`, default 5) |
| Q6 | Market invariants on the network, and market id differences between networks (`--compare-profiles`) |
| Q7 | Candle `t` unit, order and missing volume, requested in ms and in seconds |
| Q17 | `GET /` `network_id` against the chain id |
| Q18 | Robinhood asset list and markets |
| Q19 | Digits of `order_index`, values above 2^53, and whether they match the `order_id` strings |
| Q23 | `funding-rates` rows and how they pair Lighter markets with other exchanges' symbols |

To include your own orders in Q3 and Q19, set an auth token in the `LIGHTER_AUTH_TOKEN` environment variable and pass
`--account <index>`. The token is never printed.

The exit code is 0 when every check matches what the bot assumes, and 1 when the report contains a warning or an error.

**Checks that need signing on testnet** (Q8–Q16, Q20–Q22) are not automated: they place real testnet orders. Follow the
exact requests in the spec's §9 table, using a testnet sub-account, and record the codes and messages. Q10 (OCO), Q11
(token expiry) and Q13 (minimum sizes) matter most before mainnet.

## Troubleshooting

| Message | Fix |
|---|---|
| `Lighter signer library not found ... Run "npm run lighter:signer"` | Install the signer (step 3), or point `LIGHTER_SIGNER_PATH` at the file. |
| `... failed verification: sha256 ...` | The file is not the pinned build. Delete it and run `npm run lighter:signer` again. |
| `The Lighter signer cannot be loaded inside Next.js` | Expected: only the bot process signs. The web UI is read-only for Lighter. |
| `The Lighter signer needs glibc` | Alpine/musl is not supported. Use a glibc-based image. |
| `the configured public key does not match the key registered for ...` | Wrong network, account index or key index, or the key was rotated. Check that the keys belong to the selected network. |
| `API key N ... is maker-only` | Create a key without the maker-only restriction. |
| `Lighter credentials belong to profile "X" but the bot is set to "Y"` | You changed the network: restart the bot. If you also changed the keys, they must belong to the new network. |
| `Lighter profile "robinhood" is disabled` | Robinhood is gated until verified. Choose testnet or mainnet. |
| `X has no Lighter market: not on the Lighter symbol allowlist` | Add the symbol to your config, or map it with `symbolOverrides`. |
| `mark-ratio guard: ... is more than 2.00% away from 1` | The two venues quote different instruments or scales for that symbol. Fix the mapping, or remove the symbol. |
| `Closing Lighter positions from the dashboard is not supported` | Close it on app.lighter.xyz, or let the bot's stop loss or take profit close it. |
| `Lighter hedge mode needs a complete short account when not in paper mode: ...` | Fill in all four short-account fields in the hedge mode section, or turn hedge mode off. |
| `short account index must differ from the main (long) account index` | Use a different sub-account for the shorts: the main account holds the longs. |
| `Lighter hedge mode startup checks failed: short account N key K: ...` | The named account's key failed a startup check. Fix it as for the main key (rows above): wrong network, account index or key index. |
| `... holds a short ETHUSDT position (...), the wrong direction for this account` | Close that position on app.lighter.xyz. New entries on that account resume once it is closed. See [Operations](#operations). |
| `Lighter: short account N is not managed in one-way mode` | Hedge mode is off but a short account is configured. Its SL/TP expire after 28 days and are not renewed: close the positions the warning lists, or turn hedge mode on and restart. |
