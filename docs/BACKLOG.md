# PixiuBot Backlog

Active work queue. Ordered by priority. Move to `docs/SPRINT*-RECAP.md`
when shipped, then delete from here.

---

## Sprint 10 — Day 2 Phase 2+3 shipped (Apr 19 PM UTC — filters, holder monitor, timeout)

Continued from AM execution hardening. This half of the day shipped:
**(a)** Jito fallback bug fixes after Phase 1 drops exposed real-world
issues; **(b)** data-driven entry filters from the postmortem; **(c)**
academic-validated rug filters (SolRugDetector); **(d)** one fat-tail
win locked in (Soltards +284%).

### Sprint 10 Day 2 PM commits (chronological)

| Commit | What |
|---|---|
| `15da784` | `fix(jupiter-swap): re-quote with auto priority on Jito fallback` — Apex Penguin drop-tx bug |
| `5beeda4` | `fix(jupiter-swap): re-quote on Jito poll-timeout` (not just on submit failure) |
| `b38ee9e` | `fix(jupiter-swap): initialize signature variable for TS strict check` |
| `09fc37a` | `chore(config): revert daily loss limit 0.50 → 0.25` |
| `ef4a2c5` | `feat(scripts): daily-postmortem diagnostic` — 5 analytical cuts, read-only |
| `9327b3e` | `chore(config): raise daily loss limit 0.25 → 0.50` **again, tonight only — REVERT** |
| `5601e1f` | `feat(executor): entry filter — skip tokens <30min old` |
| `f5e7b66` | `feat(executor): entry filter — skip if >1 co-buyer within 5min` |
| `14d8861` | `feat(executor): log every filter decision (pass/skip with reason)` |
| `1eba735` | `fix(executor): mark filtered rows as status=failed` (phantom cleanup) |
| `13dd0ab` | `feat(risk-guard): tighten timeout 20min → 10min` |
| `525e18b` | `fix(dashboard): timeout countdown 20 → 10` |
| `24c43e9` | `chore(config): loosen co-buyer filter 1 → 2` (after 40min drought) |
| `3c5b1e6` | `feat(executor): freeze authority pre-buy check` — SolRugDetector 93% precision |
| `a2f4990` | `feat(risk-guard): holder drop >73% emergency exit` — SolRugDetector τ_down=0.73 |

### What shipped (runtime behavior, PM half)

**Jito fallback robustness (c2911a4 family):**
- Unified Jito-failure handling: 429, submit-fail, AND poll-timeout
  all trigger re-quote with auto priority
- One-shot RPC sig check before re-submit → prevents double-submit
- Skip the 60s RPC confirmation poll when onChainError is known

**Entry filters (postmortem-driven):**
- `MIN_TOKEN_AGE_MINUTES = 30` — skip tokens younger than 30min at
  first-seen. Postmortem showed <5min = 31.8% WR / −0.20 SOL vs
  >6h = 50% WR / +0.075 SOL.
- `MAX_CO_BUYERS_5MIN = 2` — originally 1 (based on fat-tail N=2),
  loosened to 2 after 40min drought. Still blocks 3+ wallet pump
  clusters.
- Filtered rows marked `status=failed` so guard doesn't adopt as
  phantoms after the 2-min pre-confirm window.

**Timeout tightened 20 → 10 min:**
- Research + postmortem: pump.fun winners moonshot in first 5-8 min
  or not at all. 20min let stale losers bleed. L3 trailing still
  bypasses timeout so moonshots ride.

**Academic-validated rug filters (Tier A):**
- **Freeze authority check (3c5b1e6)**: if mint has freeze authority
  set, creator can freeze holder accounts. SolRugDetector (ArXiv
  2603.24625) validated, 93% precision. Rare catch (only 2 of 117
  paper rugs used this) but near-zero false positives.
- **Holder exodus monitor (a2f4990)**: snapshot top-20 holders at
  entry (excluding bonding curve / LP). Every 60s re-query. If
  >73% of entry holders have exited OR summed balance dropped
  >73%, emergency close with `exit_reason='holder_rug'`. Targets
  the 76% of SolRugDetector Pump-and-Dump class (89 of 117 rugs).

### Day 2 results

**Wins (all trailing_stop L3):**
- Soltards: +0.1486 SOL (+284.85%, 1 wallet, 15h-old token)

**Losses (small, execution-clean):**
- Shrek2 SL −0.0025 / Potoooooooo TO −0.0058 (Phase 1 execution
  working; sim recoveries of 94-104% confirmed mid-flight).
- Multiple pre-Phase-1 trades drained the daily limit earlier.

**Filter-era trades:** 2 (Shrek2 via filter pass, Potoooooooo via
filter pass) — sample too small to validate WR uplift yet.

**Session wallet trajectory:** 1.619 → 1.6243 (peak after Soltards)
→ 1.4757 by end of filter-era. Net session: roughly flat-to-mild-down
depending on exact close.

### Sprint 10 Day 2 AM commits (chronological)

| Commit | What |
|---|---|
| `06f0c09` | `fix(risk-guard): disable whale_exit` — pool drainage race, Dicknald evidence |
| `c2911a4` | `feat(jupiter-swap): add Jito tip to swap requests (0.001 SOL)` |
| `f11021d` | `feat(jupiter-swap): submit via Jito bundle with public RPC fallback` |
| `958b8f5` | `feat(risk-guard): pre-flight sim check on sells, abort if recovery <30%` |
| `5972157` | `docs(journal): Sprint 10 Phase 1 execution hardening entry` |
| `8084cec` | `chore(config): DAILY_LOSS_LIMIT_SOL 0.25 → 0.50` — **TEMPORARY, revert after validation** |

---

## Sprint 10 — Day 2 Phase 1 shipped (Apr 19 AM UTC — execution hardening)

Evening session after Dicknald post-mortem + BASED / Nintondo
mark-vs-real divergence. Surgical execution-path rebuild:
Jito bundles + pre-flight sim gate. See JOURNAL entry for full detail.

### Sprint 10 Day 2 commits (chronological)

| Commit | What |
|---|---|
| `06f0c09` | `fix(risk-guard): disable whale_exit` — pool drainage race, Dicknald evidence |
| `c2911a4` | `feat(jupiter-swap): add Jito tip to swap requests (0.001 SOL)` |
| `f11021d` | `feat(jupiter-swap): submit via Jito bundle with public RPC fallback` |
| `958b8f5` | `feat(risk-guard): pre-flight sim check on sells, abort if recovery <30%` |
| `5972157` | `docs(journal): Sprint 10 Phase 1 execution hardening entry` |
| `8084cec` | `chore(config): DAILY_LOSS_LIMIT_SOL 0.25 → 0.50` — **TEMPORARY, revert after validation** |

### What changed (runtime behavior)

- **Every swap carries a 0.001 SOL Jito tip** (jitoTipLamports in
  prioritizationFeeLamports)
- **Swaps submit via Jito block engine bundle** with public RPC as
  fallback. On Jito submitted-but-not-confirmed we reuse the signature
  and let RPC polling resolve (no duplicate submission).
- **Rescue-exit sells (whale/CB/SL/trailing) run a pre-flight sim
  gate.** If quoted recovery < 30% of entry SOL cost, abort and revert
  `closing → open`. Grid take_profit bypasses the gate (voluntary).
- **Sim recovery % logged on every sell** for floor-tuning data.
- **`wasSellSimAborted(mint)` helper** in jupiter-swap; risk-guard
  reads read-once to distinguish drain-abort from transient failure.

### Safety rails held

- No change to CB / SL / TO / grid / trailing triggers
- No change to slippage ladder (5 → 10 → 20 → 30%)
- whale_exit stays DISABLED
- `sellToken` opts param optional → all scripts still compile
- `buyToken` only gained tip + bundle; NO sim check (entry latency preserved)

### Day 2 evening results

Zero trades closed on the new code yet — Phase 1 shipped after the
Day 1 bleed exhausted the daily limit. Shipped the temporary
`DAILY_LOSS_LIMIT_SOL` bump so Phase 1 could be exercised without
waiting for 00:00 UTC. Signal feed went quiet after restart; bot
running idle, Telegram armed.

---

## Sprint 10 — Day 1 shipped (Apr 18 PM)

Framework rebuild + safety rails. See `docs/JOURNAL.md` for the full
recap.

### Sprint 10 commits (chronological)

| Commit | What |
|---|---|
| `3d11157` | Partial unique index `one_open_per_mint_idx` (migration 013) — kills webhook-race duplicate rows |
| `e31b75b` | parseSwapSolDelta uses fee-payer index 0 — ALT decode fix |
| `a386ed2` | Reaper flip-flop fix + `closing_started_at` column (migration 014) |
| `c3153cc` | Dashboard stripped of paper framework (real-only stats) |
| `d5978bc` | Dashboard shows `status='closing'` rows under Open Positions |
| `071ace8` | `DAILY_LOSS_LIMIT_SOL` 2.0 → 0.25 SOL |
| `11d8c6a` | Migration 015: `paper_trades` → `trades`, wipe rows, drop `paper_bankroll` |
| `bf149dc` | L1+ CB tightened −25% → −15% |
| `be206c4` | Full scrub — zero 'paper' references left anywhere |
| `eba800a` | Kill hardcoded STARTING_SOL; deposit-safe dashboard cards |
| `5d68772` | Daily loss limit no longer writes `is_running=false` (auto-resumes at UTC rollover) |

### Day 1 results (22 LIVE trades post-rebuild)

| Exit | Trades | Net SOL | WR | Note |
|---|---|---|---|---|
| trailing_stop | 2 | +0.0572 | 100% | Asteroid +101%, PercyJackson +9% — **proven edge** |
| circuit_breaker | 9 | −0.1144 | 22% | biggest drain |
| whale_exit | 5 | −0.0725 | 20% | still underperforming L0-only |
| stop_loss | 3 | −0.042 | 0% | all L1/L2 give-backs |
| timeout | 2 | −0.019 | 50% | |

Total: 22 trades, 28.6% WR, **−0.1787 SOL** (−16.4% ROI on capital deployed).

---

## Sprint 10 — remaining candidates

### P0 — **REVERT DAILY_LOSS_LIMIT_SOL 0.50 → 0.25 (again)**

Bumped TWICE today (`8084cec` → reverted by `09fc37a` → re-bumped
by `9327b3e`). Leave at 0.50 only through tonight's run; revert
tomorrow AM regardless of outcome. Pattern is getting repeat-y.

### P0 — Phase 3: liquidity velocity metric (strongest ArXiv predictor)

ArXiv 2602.14860 (655K-token study) identified **liquidity velocity**
(SOL accumulated per trade count) as "the single most informative
predictor of graduation." We track NONE of this currently.

Implementation:
1. Sample 20–30 pump.fun tokens (mix of graduated + non-graduated)
   to establish the velocity distribution baseline.
2. Add pre-buy metric: `velocity = sol_in_curve / trade_count_since_launch`
3. If velocity > p75 of sample baseline → PASS bonus; if < p25 → add
   as skip condition (or size-down via Tier 3).

Needs sampling before threshold can be set. Estimated half-day.

### P0 — Phase 3: top-K holder concentration relative to pump.fun baseline

MemeTrans (ArXiv 2602.13480) confirmed top 10-20 buyer concentration
is **17-19pp higher for rugs**. No paper validates "30% top-10" as
an absolute threshold — it's a delta from the pump.fun baseline.

Implementation:
1. Sample 100 recent pump.fun tokens at 30-min age → compute median
   top-10 concentration (likely ~25-35% due to bonding curve mechanics).
2. Set `SKIP if top_10_pct > baseline + 17pp`.

Needs same sampling pass as liquidity velocity. Do them together.

### P0 — Validate Phase 1+2 on 20+ post-filter trades

Current post-filter sample: 2 trades (Shrek2 −$0.21, Potoooooooo
−$0.50). Way too small. Watch for:
- `[FILTER] PASS` rate vs `SKIP` rate
- `[GUARD] [HOLDER]` retention distribution — validate the 73%
  threshold isn't too loose (no rug fires on healthy positions)
- `[FILTER] SKIP ... freeze authority present` — expect very rare
- `[GUARD] Sim recovery: X%` distribution on filter-era sells
- Mark-vs-real divergence post-filters — does filtering reduce?
- Real WR on filter-era trades — target >30% (current 20%)

Need log/DB distribution of:
- `[GUARD] Sim recovery: X%` on every sell (gated or not). Expected
  healthy range 0.70–1.50; abort band <0.30.
- `[JITO] Bundle landed` vs `[JITO] Bundle failed → RPC fallback`
  ratio. If >30% fall through to RPC consistently, get a Jito API
  key (rate-limit hypothesis).
- Mark-vs-real divergence on rescue exits. If still >20pp after
  Jito+sim, the tip is too low and/or Jito isn't routing; consider
  bumping 0.001 → 0.002 SOL.
- Any false sim-abort (pool NOT drained but gate fired). Tells us
  the 0.30 floor is too tight.

### P0 — Measure old thresholds (48h observation)

Behavioral fixes shipped this session need data before declaring good
or rolling back:
- Real WR on L1+ CB at −15% (new trigger; 0/2 at −25% pre-fix)
- Real WR on L0 whale_exit after `6b3c2eb` gate
- Trailing_stop conversion rate unchanged (expect ~70%)

Target: ≥ 30 more trades. Re-run `live-stats.ts` at 48h.

### P0 — Phantom positions from webhook + stopped bot

When `is_running=false` (daily-limit halt, manual stop, etc), the
webhook still inserts `trades` rows on smart-money signals. Executor
skips the buy; row sits in 'open' state with no wallet balance. Guard
eventually CB-closes the phantom with `real_pnl_sol=null`.

Harmless today (dashboard filters out null-real rows from stats), but
clutters the `trades` table and triggers guard/Jupiter calls for rows
that aren't real positions.

**Fix:** webhook should check `bot_state.is_running` before inserting.
Requires adding that field to the webhook Edge query.

### P1 — L0 whale_exit safety net underperforming

5 L0 WE trades on Sprint 10 Day 1: 1W (Chud +22%), 4L (−68%, −26%,
−21%, −8%). Net −0.0725 SOL.
Hypothesis: by the time the bot's Jupiter sell lands, the whale dump
is already priced in.
Options (DON'T ship yet, need 15+ sample):
- require 2+ whales selling within N seconds
- only fire if mark already dropped >X% during the window
- disable WE entirely on L0, rely on SL + CB

### P1 — Stop loss on L1+ positions is bleeding banked profit

3 SL exits Sprint 10 Day 1 on L1/L2 positions, all losers. Same
dynamic as the CB-on-L1+ issue we fixed. SL −10% threshold AFTER a
grid partial triggered = giving back the bank.

**Proposal:** scale SL threshold by grid_level:
- L0: −10% (current)
- L1: −7% (after +15% lock)
- L2: −5% (after +40% lock)
- L3: trailing-stop only, no SL

Don't ship until ≥ 30 SL-exit trades at current baseline for A/B
comparison.

### P2 — Consider lowering L3 trailing activation +100% → +50%

Trailing_stop is the only consistently profitable exit type (100% WR
on 2 trades so far, 70.6% WR across 17 in the pre-rebuild dataset).
Lowering activation threshold would catch more moonshots that pump
+50–99% then dump without ever hitting +100%.

Risk: trailing prematurely activates on noise, converts L2+40%
winners into smaller trails. Measure trigger rate + per-trade PnL
delta before/after.

### P2 — DATA_MODEL.md schema update

Current schema diverged from the doc:
- Table renamed: `paper_trades` → `trades`
- Dropped: `paper_bankroll` (migration 015)
- New cols: `entry_sol_cost`, `real_pnl_sol`, `buy_tx_sig`,
  `sell_tx_sig`, `closing_started_at`

### P3 — Position size bump 0.05 → 0.10 SOL

**Gate:**
- Real WR > 55% on 20+ LIVE trades
- Real expectancy > +10% / trade
- 48h no accounting regressions

Current real WR on the 22-trade post-rebuild window is 28.6% — gate
locked until behavior changes deliver sustained improvement.

### P3 cluster — leftover reliability items

- `src/lib/price-guards.ts:5` — stale comment mentioning deleted `price-scout.ts`
- `src/agents/wallet-watcher.ts` — still broadcasts to `pixiubot:signals` channel with zero subscribers
- Remove hardcoded `TOP_ELITE_ADDRESSES` set — webhook/risk-guard both query DB tier now; only tier-manager mutates in-memory
- Cloud migration Mac → DO (move swarm off local laptop)
- `bot_state` startup retry hardening (3× retry with 500ms backoff)
- Empty `catch {}` blocks in ~12 places — add minimal error logging

### P4 — $1K capital injection

Gate: 1 week clean at 0.10 SOL position size (after P3 ships and holds).
Re-spec the "clean week" definition against real expectancy post-P0
observation window.

---

## Parking lot (no timeline)

- Edge-safe shared guards (webhook inlined duplication)
- On-chain pool reader replacing DexScreener for liquidity signal
- Tier-4 frontrunner detector (wallets buying before top T1 wallets)
- Regression harness (would have caught the `exit_time` latch bug)
- Replace DexScreener dependency entirely (outages cause false `token_unsafe` rejects)

---

## Sprint 9 — COMPLETE (Apr 18 morning)

Shipped the real-only accounting framework + two hot-path exit-strategy
fixes.

### Sprint 9 commits

| Commit | What |
|---|---|
| `e264000` | Go-forward real_pnl_sol accounting (migration 012 + parseSwapSolDelta + executor/guard writes) |
| `d690937` | Historical backfill — 310/310 LIVE trades populated |
| `8372d64` | Dashboard LIVE stats from `real_pnl_sol` |
| `6b3c2eb` | whale_exit gated to L0 only (was #1 drain: 94 trades, 23% WR, −1.24 SOL) |
| `ee2514e` | CB threshold split: L0 −15% / L1+ −25% (superseded by `bf149dc` to L1+ −15%) |
| `375b18b` | `divergence-flagger.ts` observability script |

### Real performance by exit_reason (301 pre-rebuild matched trades)

| exit | trades | WR | avg | SOL |
|---|---|---|---|---|
| take_profit | 57 | 66.7% | +67.1% | +2.13 |
| trailing_stop | 17 | 70.6% | +84.6% | +0.72 |
| stop_loss | 53 | 50.9% | +12.2% | +0.20 |
| timeout | 20 | 40.0% | +7.2% | +0.07 |
| rug_or_missing | 7 | 28.6% | −35.4% | −0.13 |
| circuit_breaker | 53 | 26.4% | −29.2% | −0.96 |
| whale_exit | 94 | 23.4% | −17.6% | −1.24 |
