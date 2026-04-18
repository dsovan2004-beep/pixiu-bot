# PixiuBot Backlog

Active work queue. Ordered by priority. Move to `docs/SPRINT*-RECAP.md`
when shipped, then delete from here.

---

## Sprint 8 — status

**Pre-trading gate ✅ CLOSED.** Bot is LIVE. All 4 gate items shipped
Apr 18 + 2 follow-up bug fixes + 1 regression fix.

| Commit | Item |
|---|---|
| `1e1a6e2` | P0a Jupiter 429 retry backoff (buy + sell) |
| `1b808a7` | P0b idempotent-close latch + 6024 mark-to-zero |
| `7be0bfa` | P0c bankroll reconcile (−$909.47 drift removed) |
| `4384249` | P2a dashboard "Total Trades" relabel |
| `7adf4f0` | Bug 1 (whale-exit DB tier) + Bug 2 (bundle double-count) |
| `2fcea6f` | **P0b regression fix** — latch uses `exit_time`, not `pnl_usd` (pnl_usd defaults to 0, not NULL, so the original P0b never matched) |

Remaining Sprint 8 work below.

---

## P1 — Commit 6 cleanup pass

Dead code left behind by Sprint 7 Day 3 consolidation:

- `src/lib/entry-guards.ts` — orphaned (only `signal-validator`
  imported it; validator was deleted in `7dbe342`).
- `src/app/api/webhook/route.ts` — dead `checkLiquidity()` helper
  (lines ~160–175) + local `MIN_LIQUIDITY_USD` const, unused after
  `checkTokenSafety()` migration in commit `4bdc377`.
- `src/lib/price-guards.ts:5` — stale comment mentioning
  `price-scout.ts` (file no longer exists).
- `src/agents/wallet-watcher.ts` — still broadcasts to
  `pixiubot:signals` channel, which now has zero subscribers. Decision:
  drop or keep as a future hook.
- **`DATA_MODEL.md` schema correction.** Commit `523826a` wrote
  incorrect column names for `paper_trades`. Actual schema:
  `id, coin_address, coin_name, wallet_tag, entry_price, entry_mc,
  exit_price, exit_mc, pnl_pct, status, priority, entry_time,
  exit_time, exit_reason, grid_level, remaining_pct, partial_pnl,
  position_size_usd, pnl_usd`. No `current_grid_level`,
  `peak_pnl_pct`, or `live_tx_signature` columns exist. `[LIVE]` is
  a suffix on `wallet_tag`. `status` values are
  `open | closing | closed | failed`.
  **Important:** `pnl_usd` defaults to 0, NOT NULL — caused the
  P0b regression tonight. Document this for future idempotency
  work.
- **Remove hardcoded `TOP_ELITE_ADDRESSES` set** — now unused by
  webhook and risk-guard (both query DB tier). Only tier-manager
  mutates the set in-memory for its own promote/demote bookkeeping,
  which should also migrate to pure DB. DB has 63 active tier=1
  vs 14 in the config — the config is stale.

Single commit, bot stays running throughout.

---

## P2a — Tighten circuit-breaker on L0 or shorten guard poll

Surfaced tonight by `hold if your not gay.` going +37% → −88% between
two 5-second guard polls. Whales (Cupsey, noob mini, bandit) bought,
pumped, dumped all within one poll window. Guard fired CB at −25%
threshold but caught −88% by the time it ran.

Two options:

- **a.** Tighten CB for L0 positions from −25% to −15%. Smaller
  worst-case loss on fast rugs. Trade-off: normal volatility might
  trigger earlier. Easy change in `risk-guard.ts`.
- **b.** Drop guard poll interval from 5s to 2s for L0-only
  positions (keep 5s for L1+ where locked profits cushion the loss).
  More RPC/DB load but lower latency. Requires splitting the poll loop.

Recommend (a) first. Measure over 48h. If fast-rug losses persist,
add (b).

---

## P2b — Cloud migration: Mac → DigitalOcean

Move the swarm runner off the local MacBook so overnight sessions
don't depend on `caffeinate` and a wake-cycle-free laptop. Webhook
is already on Cloudflare Edge so no edge work needed — only the
4-agent swarm needs to move.

Scope:
- Provision droplet, install Node 22 / tsx / wrangler.
- Port `.env.local` secrets. Wallet keypair encrypted at rest.
- systemd unit for `npx tsx src/agents/run-all.ts` with
  auto-restart on crash.
- Log pipe to Grafana/loki or similar.

---

## P3 — Position size bump: 0.05 → 0.10 SOL

**Hard gate — do not bump until all three pass:**
- 48h of clean runs (no bypass, no phantom, no crash restart).
- Win rate > 55% on a 20+ LIVE trade window.
- Buy-land rate > 90%.

Change touches `src/config/smart-money.ts` `LIVE_BUY_SOL` and
`DAILY_LOSS_LIMIT_SOL` (scale loss budget proportionally).

---

## P3 cluster — small reliability fixes

Surfaced in prior sessions. Low individual impact, one commit.

**a.** SIGINT handler in `run-all.ts` writes `is_running=false`
on Ctrl+C. Every restart therefore requires a manual START click,
and the "Bot stopped via dashboard" messages in the new session
are misleading (user didn't stop it — they just restarted the
local process). Fix: remove the bot_state write from the SIGINT
handler. Exit cleanly without clobbering user intent.

**b.** Startup `bot_state` read needs retry hardening.
`[GUARD] ⚠️ Failed to read bot_state — defaulting to PAPER` observed
transiently. Fix: 3× retry with 500ms backoff inside guard startup;
same pattern in executor.

**c.** Empty `catch {}` blocks in 12 places silently swallow
errors. Not critical individually but hides real issues. Convert to
`catch (err) { console.error(...) }` with minimal context.

---

## P4 — $1K capital injection

**Gate:** 1 full week clean at 0.10 SOL position size (after P3
ships and holds).

On-chain transfer into the live wallet, dashboard recognizes the
new bankroll via `paper_bankroll` reconciliation.

---

## Parking lot (no timeline)

- Webhook → shared canonical guard module. Requires either porting
  `supabase-server.ts` to edge-safe, or moving DB reads to a small
  edge-side client. Low priority — duplication is small and stable.
- Replace DexScreener dependency with an on-chain pool reader
  (Raydium / pump.fun bonding curve). DS outages have caused
  false-negative `token_unsafe` rejects.
- Tier-4 whale detector — wallets buying before the top T1 wallets.
- **Regression harness** — tonight's P0b bug would have been caught
  by a simple "close a test trade and verify bankroll delta = pnl_usd"
  script. Worth building.
