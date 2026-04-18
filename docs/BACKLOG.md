# PixiuBot Backlog

Active work queue. Ordered by priority. Move to `docs/SPRINT*-RECAP.md`
when shipped, then delete from here.

---

## Sprint 9 — COMPLETE (Apr 18)

All P0 sub-items shipped + two bonus hot-path exit-strategy fixes
from the real-data findings. See `docs/JOURNAL.md` for the full
afternoon recap.

### Sprint 9 commits (chronological)

| Commit | What |
|---|---|
| `e264000` | Go-forward real_pnl_sol accounting (migration 012 + parseSwapSolDelta + executor/guard writes) |
| `d690937` | Historical backfill — 310/310 LIVE trades populated |
| `8372d64` | Dashboard LIVE stats + "Real SOL" column from `real_pnl_sol` |
| `6b3c2eb` | whale_exit gated to L0 only (was #1 drain: 94 trades, 23% WR, −1.24 SOL) |
| `ee2514e` | CB threshold split: L0 −15% / L1+ −25% (was #2 drain: 53 trades, −0.96 SOL) |
| `375b18b` | `divergence-flagger.ts` observability script |
| `bc2a581` | Banner line updated |

### Key findings

Real performance by exit_reason (across 301 matched trades):

| exit | trades | real WR | real avg | SOL |
|---|---|---|---|---|
| take_profit | 57 | 66.7% | +67.1% | +2.13 |
| trailing_stop | 17 | 70.6% | +84.6% | +0.72 |
| stop_loss | 53 | 50.9% | +12.2% | +0.20 |
| timeout | 20 | 40.0% | +7.2% | +0.07 |
| rug_or_missing | 7 | 28.6% | −35.4% | −0.13 |
| circuit_breaker | 53 | 26.4% | −29.2% | −0.96 |
| whale_exit | 94 | 23.4% | −17.6% | −1.24 |

Real expectancy per trade: +8.9% (not paper's +17.5%). Still positive.
The bot IS profitable in real SOL — just half what paper claimed.

---

## Sprint 10 — candidates

### P0 (NEW, found live Apr 18) — Webhook race creates duplicate rows

**Evidence:** WHERE IS THE AIRDROP today created 5 paper_trades rows
within 230ms (16:13:00.148 to 16:13:00.378) for the same mint.
Cupsey's BUNDLE pattern fires many signals at once; webhook's
"position already open" check is not race-safe:

```ts
const { count: openCount } = await supabase
  .from("paper_trades")
  .select("id", { count: "exact", head: true })
  .eq("coin_address", mint)
  .eq("status", "open");
if ((openCount || 0) > 0) return { entered: false, reason: "position already open" };
```

When N webhook requests hit simultaneously, all N see count=0 at
check time (before any have INSERTed), then all N INSERT. Result:
N duplicate rows. Guard picks up all of them. When a trailing/CB
fires, each row's closeTrade credits bankroll independently.

**Symptom:** phantom bankroll credits. Today's incident: 4 × $90.74
= $362.96 phantom credit on one trailing_stop exit. Cleaned up
manually (see JOURNAL).

**Fix:** partial unique index on Postgres side — INSERT with
duplicate would fail at DB level, webhook gets error, skips entry.

```sql
CREATE UNIQUE INDEX IF NOT EXISTS one_open_per_mint_idx
  ON paper_trades(coin_address)
  WHERE status = 'open';
```

Requires thinking: what about paper-mode trades? What about the
executor's similar duplicate check (also non-atomic)? Full fix
scope TBD. Ship as schema migration.

### Other

Ordered by expected impact.

### P0 — Measure whale_exit + CB fix effect (48h observation)

Both fixes from `6b3c2eb` and `ee2514e` are behavioral. Before
declaring them good or rolling back, need 48h of live data with:
- ≥ 20 new LIVE trades
- At least 5 trades where whale_exit would have fired pre-fix
  (now skipped) and was instead handled by SL/trailing/TO
- At least 5 L0 crashes where the −15% CB fires (instead of −25%)

Re-run `divergence-flagger.ts` and `live-stats.ts` at 48h. Compare
whale_exit + circuit_breaker rows to pre-fix baseline. Expected:
- whale_exit count drops sharply (only L0 now)
- whale_exit real WR should IMPROVE (gating out the bleed)
- CB count may rise on L0 (earlier trigger), but avg SOL lost per
  CB should decrease (exiting at −15% instead of −40% avg)

If real WR on whale_exit L0-only stays below 40%, consider disabling
it entirely and relying on SL/trailing.

### P1 — Dedupe ghost rows (pre-P0b double-credit leftovers)

`divergence-flagger.ts` confirmed 3 duplicate pairs:
- Broke Company (2 rows, same 129.1% / +0.112 SOL)
- Justice for Raccoon (2 rows, same 42.5% / +0.183 SOL)
- Mooncoin (2 rows, same 48.5% / +0.059 SOL, 1sec apart)

These inflate WR stats by 3 phantom wins. Cleanup:
1. Identify the duplicate row ID (keep oldest, delete newest)
2. Decrement `paper_bankroll.current_balance` by the phantom pnl_usd
3. Log in JOURNAL

### P1 — Top-line dashboard Total PnL swap

Dashboard header "Real P&L" card currently shows
`phantomBalance.pnlSol` (wallet delta, includes fees + orphans).
Now that all 310 trades have `real_pnl_sol`, the "Total PnL" card
below should swap from `bankroll.total_pnl_usd` (paper bankroll
fiction) to `SUM(real_pnl_sol) × solPrice`. Fold into a single
"Trade PnL" card that's authoritative for strategy decisions.

Distinction: "Wallet Δ" and "Trade PnL" should be visibly separate.

### P2 — Poll interval reduction (L0 only)

Current 5s poll missed the `hold if your not gay.` +37% → −88%
single-poll crash. Lowering poll to 2s on L0 positions (leave 5s
for L1+) would catch mid-crash at ~−15% instead of −88%. Requires
splitting the poll loop.

Not urgent after CB L0 tighten, but worth measuring. If CB L0
−15% is still catching crashes in the wild, poll reduction is
the next marginal gain.

### P2 — Sprint 6 retro + DATA_MODEL.md schema update

- Sprint 6 has no recap file — reconstruct from git log (P3 in old
  backlog)
- `DATA_MODEL.md` needs entry_sol_cost / real_pnl_sol / buy_tx_sig /
  sell_tx_sig columns documented; originally part of commit 6
  cleanup which was never shipped

### P3 — Position size bump 0.05 → 0.10 SOL

**Gate now requires REAL data, not paper:**
- Real WR > 55% on 20+ LIVE trades (measured via `real_pnl_sol`)
- Real expectancy > +10% / trade
- 48h no accounting regressions (divergence-flagger clean)

Current real WR on the 310-trade window is 41.3% (well below 55%).
Gate is locked until behavior changes deliver sustained improvement.

### P3 cluster — leftover Sprint 8 items (not done)

From the original Sprint 8 backlog, still open:
- Commit 6 cleanup (dead code + DATA_MODEL.md schema)
- Cloud migration Mac → DO (P2b)
- `bot_state` startup retry hardening
- Empty `catch {}` block cleanup

### P4 — $1K capital injection

Original gate ("1 week clean at 0.10 SOL") was written against
paper numbers. Re-spec against real expectancy once P0 observation
window produces baseline.

---

## Parking lot (no timeline)

- Edge-safe shared guards (webhook inlined duplication)
- On-chain pool reader replacing DexScreener for liquidity signal
- Tier-4 frontrunner detector
- Regression harness (would have caught P0b pnl_usd default = 0)

---

## HISTORICAL CONTEXT (Sprint 9 definition) — kept for reference

### Shipped (go-forward)

- Migration 012: `entry_sol_cost`, `real_pnl_sol`, `buy_tx_sig`,
  `sell_tx_sig` columns added to paper_trades (applied via dashboard)
- `jupiter-swap.ts parseSwapSolDelta(sig)` — parses tx.meta for
  wallet SOL delta
- `trade-executor.ts` — writes `buy_tx_sig` + `entry_sol_cost` on
  buy confirmation (non-blocking, try/catch)
- `risk-guard.ts closeTrade()` — writes `sell_tx_sig` + `real_pnl_sol`
  on sell confirmation. Logs real vs paper side-by-side
- Dashboard `/bot` — new "Real SOL" column in Closed Trades table

### Still pending (deferred sub-items)

**P0 remaining item a — Historical backfill.**
310 pre-Sprint-9 closed LIVE trades have NULL `real_pnl_sol`. No tx
signatures stored before Sprint 9, so backfill requires signature
discovery:
1. For each trade, query Helius `getSignaturesForAddress(wallet,
   { before: exit_time + 10min, until: entry_time - 1min })`.
2. For each sig in window, `getTransaction` and check if it
   involved the trade's `coin_address`.
3. Match buy tx (SOL→token) and sell tx(s) (token→SOL).
4. Sum SOL deltas across matched sell txs; subtract buy cost.
5. Write to row.

Estimated runtime: 30-60 min with Helius rate limits. Expected
match rate: ~70-85% (some trades won't match due to: tx never
landed on-chain, token moved via sell-pumpfun.ts bypass script,
intermediate transfers, etc.). Unmatched rows get a
`backfill_status = 'unmatchable'` note.

Script target: `src/scripts/backfill-real-pnl.ts`.

**P0 remaining item b — Divergence flagger.**
Post-backfill (or even without, for go-forward trades), scan
paper_trades where both `pnl_pct` and `real_pnl_sol` are populated.
Compute `real_pct = real_pnl_sol / entry_sol_cost × 100`. Flag any
row where `|pnl_pct - real_pct| > 20%` as an accounting anomaly.

Surface top-N largest divergences as a dashboard panel or one-shot
report. Use for trading strategy tuning (e.g. "whale_exit trades
have 40% average divergence — closing sells lag whale dumps by X
seconds" → tightens fix).

**P0 remaining item c — Top-line dashboard stats swap.**
Header "Real P&L" card currently derives from paper_bankroll
(which tracks pnl_usd). Once 48h of go-forward real data
accumulates, swap the card to derive from `SUM(real_pnl_sol)`
for LIVE trades + legacy paper for pre-Sprint-9. Make it obvious
which is which.

### The problem (historical context)

`paper_trades.pnl_pct` and `pnl_usd` are derived from DexScreener
mid-price at the moment `closeTrade()` fires. This is a FICTION
relative to real wallet outcomes because:

- Jupiter sells often fail (tx expired, 6024 un-sellable)
- Slippage at 5-30% eats into the actual SOL returned
- Tokens can go to 0 on-chain while DexScreener still has a stale
  price — zero-balance close path uses `pos.partial_pnl` for the
  final PnL, which reflects locked paper partials, not reality
- Multi-retry sells at escalating slippage (5%→10%→20%→30%) book
  different real outcomes than the close-time mid-price snapshot

### The gap (evidence from Apr 18 live-stats.ts run)

```
310 LIVE closed trades
Sum of LIVE_BUY_SOL × pnl_pct / 100:   +2.70 SOL  (+$238)
Actual wallet delta (start 3.67, now 0.98): -2.69 SOL  (-$237)

Missing:  ~5.4 SOL ($476) of phantom paper gains
```

**Asymmetry: losses are accurate, gains are inflated.** When a token
rugs, the bot holds through it and real SOL is lost as calculated.
When a token pumps, the claimed gain at close time often doesn't
materialize because the Jupiter sell lands at a lower price than
the DexScreener mid used for pnl_pct.

### Top phantom wins (likely fictional paper gains)

These rows claim huge pnl_pct that almost certainly did NOT
translate to real SOL:

```
BONER             +1217.5%   claims +0.6087 SOL
SUKI               +553.8%   claims +0.2769 SOL
Edward Warchocki   +397.5%   claims +0.1987 SOL
```

Top 3 alone claim +1.08 SOL real that the wallet doesn't reflect.

### Other accounting anomalies found

- **Broke Company appears twice** with identical +129.1% / +0.0645 SOL
  on 2026-04-16 14:01. Pre-P0b double-credit ghost row. One is a
  phantom. Needs cleanup during reconcile.
- **whale_exit WR 74.7%** but visual inspection shows many of those
  "wins" are closes on tokens that whales already dumped before our
  sell landed. Real fills likely much lower than reported pnl_pct.
- **`rug_or_missing` exit_reason** (zero-balance close path, 7
  trades) uses `pos.partial_pnl` as final PnL, which is just the
  locked L1/L2 paper partials — no real SOL recovery happened.

### Fix scope

1. **Schema migration:** add `real_pnl_sol NUMERIC NULL` to
   `paper_trades`. Keep existing `pnl_pct` / `pnl_usd` columns for
   backward compat but treat them as "paper-only view".
2. **jupiter-swap.ts — `sellToken()` return shape.** Currently
   returns `string | null` (tx signature or null). Change to:
   ```ts
   { signature: string | null; solReceived: number; tokensSpent: number }
   ```
   On confirmation, parse `tx.meta.postBalances - preBalances` for
   the wallet's SOL delta (minus fees). Needs `getTransaction(sig,
   { maxSupportedTransactionVersion: 0 })` call after confirmation.
3. **buyToken() symmetric change:** return `solSpent` as well so
   we can compute true cost basis including actual swap price and
   fees, not just the `LIVE_BUY_SOL` constant.
4. **risk-guard.ts — `closeTrade()`:** when a real sell lands, compute
   `real_pnl_sol = solReceived - solSpent` using the entry side's
   actual cost basis. Write this to the row. Fall back to
   pnl_pct-derived estimate only if on-chain parse fails.
5. **Dashboard swap:** `/bot/page.tsx` top-line stats and per-trade
   PnL displays pull `real_pnl_sol` when available; show `pnl_pct`
   in a secondary "paper PnL" column. Make it obvious which number
   is authoritative.
6. **One-shot reconcile script:** `src/scripts/backfill-real-pnl.ts`
   — walks all closed LIVE trades without `real_pnl_sol`, fetches
   the tx on-chain via Helius `getTransaction`, parses in/out
   balance delta, writes the true value. Slow (rate-limited) but
   one-time.
7. **Divergence flagger:** after backfill, flag any trade where
   `|pnl_pct - (real_pnl_sol / LIVE_BUY_SOL × 100)| > 20%` as an
   accounting anomaly for manual review. Tag with
   `exit_reason='anomaly_NNN'` or a boolean column.

### Non-goals

- Don't migrate historic paper-only trades (pre-live-trading era).
  Only backfill rows with `wallet_tag LIKE '%[LIVE]%'`.
- Don't break existing dashboards — add a second column, don't
  replace the first.
- Don't auto-block trades based on this — it's accounting hygiene,
  not a trading rule change.

### Why this blocks other work

Speed optimizations (P2a tighter CB, P2b cloud migration) are
useless if we don't know whether the bot is profitable in real SOL.
Position size bump (P3) absolutely requires real accounting because
the gate metric "WR > 55% on 20+ trades" is calculated on a lying
field today.

### Success criteria

- `real_pnl_sol` populated on every LIVE close from date-of-deploy
- Backfill completed for all historic LIVE trades
- Dashboard top-line "Real P&L" matches wallet delta within 2%
- List of divergence-flagged trades surfaced for manual review
- Paper/real divergence measured over 48h after deploy to
  quantify the persistent gap vs pre-fix gap

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
