# PixiuBot Data Model

Schema + write-path ownership for the Supabase tables PixiuBot uses.
If you're about to write to one of these tables, find the table below
and confirm the write path is listed. If it isn't — stop and ask
whether it should be.

Authoritative schema lives in `supabase/` migrations; this file
documents who writes what, not column types.

---

## Purpose

Keep write paths explicit so we don't regress to the pre-Sprint-7
state where multiple code paths raced to write the same row. Every
table below names the specific file(s) and function(s) that INSERT or
UPDATE it. If you add a new writer, update this file in the same
commit.

---

## Tables

### `paper_trades` — the entry ledger

The only table that represents a live or paper position. Every row
is a single trade from entry to close.

**Key columns**
- `id` (uuid pk)
- `coin_address` (mint)
- `coin_name`
- `wallet_tag` — source wallet label (may include `[LIVE]` suffix
  once executor confirms a real swap)
- `status` — `open` | `closing` | `closed`
- `entry_price`, `entry_mc`, `entry_time`
- `exit_price`, `exit_time`, `exit_reason`, `pnl_pct`
- `position_size_usd`
- `priority` — `HIGH` (≥2 T1 confirmers) | `normal`
- `current_grid_level` — 0 | 1 | 2 | 3 (L3 = trailing mode)
- `peak_pnl_pct` — for trailing stop
- `live_tx_signature` — Jupiter buy tx sig (null if paper)

**Write paths — INSERT**
- `src/app/api/webhook/route.ts:421` inside `evaluateAndEnter()`.
  **This is the only INSERT site.** Verified by grep during Sprint 7
  D3 consolidation.

**Write paths — UPDATE**
- `src/agents/trade-executor.ts` — on successful Jupiter buy
  confirmation, sets `wallet_tag` to include `[LIVE]` and stores
  `live_tx_signature`, adjusts `entry_price` if the real fill price
  differs from the quoted price.
- `src/agents/risk-guard.ts` — atomic claim (`status=open` →
  `status=closing`), then final close (`status=closing` →
  `status=closed` with `exit_price`, `exit_time`, `exit_reason`,
  `pnl_pct`). Grid level advances also happen here.
- `src/scripts/*` one-shot recovery scripts — manual close paths for
  stuck positions (`sell-pumpfun.ts`, `sell-all-orphans.ts`, etc.).
  Recovery writes must log to `docs/JOURNAL.md`.

**Read paths** (non-exhaustive)
- Dashboard `/bot` page
- Risk guard poll (every 5s, `status=open`)
- Trade executor poll (every 3s, `status=open` without
  `live_tx_signature`)
- Webhook rug-storm check (last 5 closed in 2h)
- Webhook position-open check

---

### `coin_signals` — append-only signal stream

Every wallet BUY or SELL event observed. One row per event. Used by
the webhook for bundle detection, whale hold time, T1 confirmation
count. Also surfaces on the dashboard signal feed.

**Key columns**
- `id`
- `signal_time`
- `wallet_tag`, `coin_address`, `coin_name`
- `transaction_type` — `BUY` | `SELL`
- `rug_check_passed` — boolean, from RugCheck
- `signal_kind` — event label (`BUNDLE`, `🐳 SELL`, plain, etc.)
- `entry_mc`

**Write paths — INSERT**
- `src/app/api/webhook/route.ts` — on every Helius push that the
  webhook accepts (before entry-guard evaluation). One row per event.
- `src/agents/wallet-watcher.ts` — polls tracked wallets' recent
  transactions every 3s as a backup feed (Helius push can drop).

**Write paths — UPDATE**
- None. Append-only.

**Read paths**
- Webhook guards 10, 11, 12 (T1 count, whale hold, bundle)
- Dashboard signal feed
- `src/scripts/trace-*.ts` diagnostic scripts

---

### `bot_state` — dashboard control

Single-row table (by convention). The authoritative kill switch.

**Key columns**
- `id` (uuid; always the same constant row)
- `is_running` — `true` | `false`. Webhook and executor both halt
  entries when `false`.
- `last_updated` — ISO UTC

**Write paths — UPDATE**
- `src/app/api/settings/route.ts` — dashboard STOP/START button.
- `src/agents/run-all.ts` SIGINT handler — Ctrl+C on the swarm
  process sets `is_running=false` before exit.

**Read paths**
- `src/app/api/webhook/route.ts` `webhookIsBotRunning()` — every
  entry evaluation (guard #1).
- `src/agents/trade-executor.ts` — every 3s poll (rechecks before
  each buy attempt, commit `883a3d7`).

---

### `paper_bankroll` — virtual + real accounting

Tracks the paper/real hybrid balance used for position sizing. Single
row by convention.

**Key columns**
- `current_balance` — SOL (or USD-scaled paper units depending on era;
  currently paper-USD for sizing, real-SOL for reporting)
- `last_updated`
- `reconcile_note` (optional)

**Write paths — UPDATE**
- `src/agents/risk-guard.ts` — on every close. Credits
  `position_size_usd × (1 + pnl_pct/100)` back. The idempotent-close
  guard (`status=closing` → `status=closed` with
  `.select().maybeSingle()`) prevents double-credit.
- Manual reconcile via SQL console — see `PLAYBOOK.md` runbook.
  Always logged in `docs/JOURNAL.md`.

**Read paths**
- Webhook entry sizing (`evaluateAndEnter()` fetches `current_balance`
  to compute `position_size_usd`)
- Dashboard header

---

### `tracked_wallets` — wallet registry + tier

The set of wallets we watch. Includes tier, activity flag, display
name.

**Key columns**
- `tag` (pk-ish) — display label
- `address` — Solana pubkey
- `tier` — `1` (solo-trigger eligible) | `2` (confirmation-only) | `0`
  (watch-only, usually demoted)
- `active` — boolean; webhook only counts `active=true` for tier checks
- `win_rate_24h`, `win_rate_7d` — maintained by tier-manager

**Write paths — INSERT**
- Manual SQL / admin script. No automated INSERT path.

**Write paths — UPDATE**
- `src/agents/tier-manager.ts` — demotes T1 → T2 on WR < 50% over 3+
  trades in 24h; promotes T2 → T1 on WR > 65% over 5+ trades in 7d.
  Writes `tier` and `active`.

**Read paths**
- Webhook guard #10 (tier check via join over incoming signal tags)
- Wallet-watcher poll list

---

## Broadcast channels (DEPRECATED)

PixiuBot historically used Supabase Realtime broadcast channels to
wire agents together. All three are now dead; listed here so nobody
reintroduces them without knowing the history.

### `pixiubot:signals`

- **Publisher:** `wallet-watcher.ts` (still broadcasts as of Sprint 7
  D3 — not yet removed).
- **Subscribers:** zero after `signal-validator.ts` delete. Slated
  for removal in Sprint 8 commit 6.

### `pixiubot:entries`

- **Deleted** in Sprint 7 D3 (`7dbe342`). Publisher was
  `signal-validator.ts`, subscriber was `price-scout.ts` — both files
  removed.

### `pixiubot:confirmed`

- **Deleted** in Sprint 7 D3. Publisher was `price-scout.ts`;
  subscribers were supposed to drive trade execution but none existed
  after Sprint 5 D1 (`d59053e`, which replaced broadcast with
  `paper_trades` polling). Scout's output landed nowhere for weeks
  before its delete.

### Policy going forward

**Do not add new broadcast channels.** Use either:
- a table with a polling consumer (what executor/guard do today), or
- a direct function call within the same process.

Broadcasts are easy to orphan silently — see the Sprint 7 D3 lessons
in `PLAYBOOK.md`.

---

## Cross-cutting rules

### Idempotent close (the `status=closing` latch)

Any code that closes a `paper_trades` row must:

1. First UPDATE from `status='open'` to `status='closing'` with
   `RETURNING *`. If zero rows returned, another path claimed it —
   stop.
2. Perform the sell / balance check / PnL computation.
3. UPDATE from `status='closing'` to `status='closed'` with
   `.eq("status", "closing").select().maybeSingle()`. If zero rows
   come back, **do not credit the bankroll** — somebody else beat
   you to the final write.

This pattern prevents the double-credit and phantom infinite-loop
bugs that ate SOL before commits `9e83741` and `2bb9246`.

### No direct deletes

Use status flags (`status=closed`) rather than DELETE. Historical
rows are load-bearing for rug-storm detection, tier-manager WR
calculations, and dashboard trade history.

### Timestamps in ISO UTC

Every time column uses `new Date().toISOString()`. Do not introduce
local-time or unix-epoch columns.

### Column-level invariants

- `paper_trades.pnl_pct` on a `closed` row is the final realized PnL
  percentage including slippage. It's the single number the daily
  loss counter uses (`PLAYBOOK.md` > Daily loss accounting).
- `paper_trades.wallet_tag` is informational only. Do not parse it
  for routing decisions. The `[LIVE]` suffix is a signal for
  reporting / daily-loss filtering but the source of truth for
  "this trade really swapped" is `live_tx_signature != null`.
- `coin_signals.signal_kind` is free-form label text. Don't build
  guards on it; parse `transaction_type` and wallet tier instead.
