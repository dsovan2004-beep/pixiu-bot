# PixiuBot Backlog

Active work queue. Ordered by priority. Move to `docs/SPRINT*-RECAP.md`
when shipped, then delete from here.

---

## Sprint 8

## P0 cluster — must land before next live trading session

All three must be complete before trading resumes. P0a + P0b are code
fixes + deploy; P0c is a one-shot reconcile operation that depends on
P0b being in place (otherwise it re-drifts on the next trade).

### P0a — Jupiter 429 retry backoff (buy path)
**Promoted from old Sprint 5 backlog after Apr 17 22:00–22:46 UTC
session: 5 consecutive buy attempts all failed with Jupiter 429 rate
limit (The Bull Starter, stompers, Conviction, Retail Coin #1,
Crashout). Today's DB shows 71 total `status=failed` rows with
`exit_reason=buy_failed`.**

Symptom: burst of entry signals (5 within ~25 min) → Jupiter throttles
→ every buy fails immediately → executor marks `status=failed`, no
retry. Real SOL safe (nothing swapped), but entry slots wasted and
alpha missed (Conviction ran +214% after the failed entry).

Scope:
- Add exponential backoff in `src/agents/trade-executor.ts` on HTTP
  429 from Jupiter's `/swap` endpoint. Suggested: 1s → 3s → 10s with
  max 3 retries, then `status=failed`.
- Alternative: token-bucket rate limiter keyed on Jupiter API host.
- Preserve the 3-min rescue-check on truly-failed buys (already
  implemented, working).
- Log `[JUPITER] 429 — retry N/3 in Ms` per retry for observability.

Gate target metric: buy-land rate > 90% (currently unknown; looks
much lower on bursty days). Track before/after via `verify-buy-land.ts`
style script.

### P0b — Idempotent-close race: partial → final credit path
**Surfaced by Retail Coin close on Apr 17 (trade id
`f1282382-3c14-4462-ac59-c3f2a7edce62`, entry 22:51:20 → exit 23:05:45
UTC). Same class of bug as commit `9e83741` but on a different code
path — partial-L1 fire then final close both credited the bankroll,
while the trade row only recorded the first credit.**

Repro evidence (see `src/scripts/investigate-retail-coin.ts` output):
- paper_trades row: `pnl_usd = 21.72`, `pnl_pct = 7.5`, `remaining_pct = 0`
- paper_bankroll delta during close window: +$43.44 (two consecutive
  +$21.72 credits in the log)
- On-chain wallet: 0 tokens (drained; Jupiter couldn't sell remaining
  50% due to 6024 routing gap, tokens went to zero without returning
  SOL)
- Net: bankroll absorbed a phantom +$21.72, and the remaining 50% of
  position value (≈$144.80) never marked to zero on the row either —
  so the paper bankroll is drifted roughly **−$165 vs real SOL** just
  from this one trade

Root cause hypothesis: `9e83741` added a `status=closing`→`status=closed`
latch to the trade-row UPDATE, preventing concurrent pollers from
double-writing the row. The bankroll UPDATE is not gated by that same
latch — the partial-L1 path credits directly, and the final close
path credits again without checking whether the partial credit was
already applied. Need to either (a) make the bankroll UPDATE
conditional on the same status transition, or (b) have the final
close subtract any `partial_pnl` already credited to the row.

Scope:
- Read `src/agents/risk-guard.ts` partial-sell path vs final-close path.
- Apply the same idempotent-latch pattern to bankroll credits that
  `9e83741` applied to trade-row closes.
- Add a regression test (or a manual repro script) that simulates
  partial-L1 then final close on the same trade and asserts bankroll
  delta equals `pnl_usd` on the row.
- Also mark-to-zero the remaining bag when Jupiter 6024 gives up —
  currently the final row stores the last mid-price as `exit_price`
  instead of zero, overstating realized PnL.

### P0c — Bankroll reconcile to real SOL
**One-shot operation. Run AFTER P0a and P0b deploy — otherwise the
drift reappears on the next trade.**

Today's drift estimate: paper bankroll is ≈−$165 higher than real SOL
reflects, from the P0b bug on Retail Coin alone. Longer tail may exist
from earlier trades; reconcile is authoritative against on-chain.

Runbook already documented in `PLAYBOOK.md` > "Runbook: bankroll
reconcile". Steps:
1. Run `src/scripts/phantom-balance.ts` to get real on-chain SOL +
   token positions.
2. Compute paper bankroll value from `paper_bankroll.current_balance`.
3. Compute delta; UPDATE paper_bankroll with a `reconcile_note`.
4. Log the reconcile in `docs/JOURNAL.md` with date, delta SOL,
   delta USD, and reason (reference this P0c + trade id
   `f1282382-3c14-4462-ac59-c3f2a7edce62`).

### P1 — Commit 6 cleanup pass
Dead code left behind by Sprint 7 Day 3 consolidation:
- `src/lib/entry-guards.ts` — orphaned (only `signal-validator` imported
  it; validator was deleted in `7dbe342`).
- `src/app/api/webhook/route.ts` — dead `checkLiquidity()` helper (lines
  ~160–175) + local `MIN_LIQUIDITY_USD` const, unused after
  `checkTokenSafety()` migration in commit `4bdc377`.
- `src/lib/price-guards.ts:5` — stale comment mentioning
  `price-scout.ts` (file no longer exists).
- `src/agents/wallet-watcher.ts` — still broadcasts to
  `pixiubot:signals` channel, which now has zero subscribers
  (validator was the only one). Either drop the broadcast or keep
  as a future hook — decision pending.
- **`DATA_MODEL.md` schema correction.** Commit `523826a` wrote
  incorrect column names for `paper_trades`. Actual schema (verified
  Apr 17 2026 via investigate-session.ts):
  `id, coin_address, coin_name, wallet_tag, entry_price, entry_mc,
  exit_price, exit_mc, pnl_pct, status, priority, entry_time,
  exit_time, exit_reason, grid_level, remaining_pct, partial_pnl,
  position_size_usd, pnl_usd`. No `current_grid_level`,
  `peak_pnl_pct`, or `live_tx_signature` columns exist. `[LIVE]` is
  a suffix appended to `wallet_tag`, not a separate column. `status`
  values are `open | closing | closed | failed` (doc missed
  `failed`). Fix in same cleanup commit.

Single commit, bot stays running throughout (node-side only, no edge
change).

### P2a — Dashboard "Total Trades" relabel (UX)
**Promoted from P3 cluster after Apr 17 session caused a false
"dashboard broken" alert.** High visibility, easy fix — not blocking
but worth catching before the next surprise.

Symptom: the top-line counter on `/bot` filters on `status='closed'
AND wallet_tag LIKE '%[LIVE]%'` but the label just reads "Total
Trades". On Apr 17 the user saw "303" stuck despite active trading
and assumed the dashboard had stopped writing — it hadn't, there
simply hadn't been a LIVE *close* yet (one Retail Coin trade was
successfully open but still held). Verified correct via
`investigate-session.ts`.

Fix: rename the counter to "Total LIVE Trades" (or "LIVE Trades
Closed") — something that signals the filter. Optional:
parenthetical note "(LIVE, closed)" or an info tooltip. Component:
dashboard page at `/bot`.

Single-file React edit. Zero risk — cosmetic only. Can land with
any other commit.

### P2b — Cloud migration: Mac → DigitalOcean
Move the swarm runner off the local MacBook so overnight sessions
don't depend on `caffeinate` and a wake-cycle-free laptop. Webhook
is already on Cloudflare Edge so no edge work needed — only the
4-agent swarm (`wallet-watcher`, `trade-executor`, `risk-guard`,
`tier-manager`) needs to move.

Scope:
- Provision droplet, install Node 22 / tsx / wrangler.
- Port `.env.local` secrets to droplet (Helius, Supabase, RPC, wallet
  keypair). Keep wallet key encrypted at rest.
- systemd unit for `npx tsx src/agents/run-all.ts` with auto-restart.
- Observability: pipe logs to Grafana/loki or similar.

### P3 — Position size bump: 0.05 → 0.10 SOL
**Hard gate — do not bump until all three pass:**
- 48h of clean runs (no bypass, no phantom, no crash restart).
- Win rate > 55% on a 20+ trade window.
- Buy-land rate > 90% (real fills / attempted entries).

Change touches `src/config/smart-money.ts` `LIVE_BUY_SOL` and
`DAILY_LOSS_LIMIT_SOL` (scale loss budget proportionally). Backfill
script may need to re-scale historical SOL accounting for reporting
parity.

### P4 — $1K capital injection
**Gate:** 1 full week clean at 0.10 SOL position size (after P3
ships and holds).

On-chain transfer into the live wallet, dashboard recognizes the
new bankroll automatically via `paper_bankroll` reconciliation.

### P3 cluster — startup reliability

Surfaced by the Apr 17 22:00 investigation. Low individual impact,
grouped so a single cleanup commit can knock them out. (Dashboard
relabel was promoted out of this cluster to P2a.)

**a. Startup `bot_state` read needs retry hardening.**
Observed once on Apr 17 22:16:58 UTC session start:
`[GUARD] ⚠️ Failed to read bot_state — defaulting to PAPER`.
Transient Supabase read failure during guard initialization. If
the fallback ever flips the wrong way it could open / suppress
trades without the dashboard's knowledge. Fix: 3× retry with 500ms
backoff inside `risk-guard.ts startup`; fail closed (=PAPER) only
after retries exhausted. Same pattern likely wanted in executor.

**b. `[GUARD] ⚠️ Failed to read bot_state` log line is the visible
symptom of (a).** Once retry lands, this message should become
rare enough to treat as a legitimate alert rather than startup
noise. Consider upgrading to `console.error` with a distinct
prefix once the retry guard is in.

---

## Parking lot (no timeline)

- Webhook → shared canonical guard module (currently inlined). Would
  require either porting `supabase-server.ts` to edge-safe, or moving
  DB reads to a small edge-side client. Low priority — duplication
  is small and stable.
- Replace DexScreener dependency with an on-chain pool reader (Raydium
  / pump.fun bonding curve). DS outages have caused false-negative
  `token_unsafe` rejects.
- Tier-4 whale detector — wallets buying before the top T1 wallets.
