# PixiuBot Backlog

Active work queue. Ordered by priority. Move to `docs/SPRINT*-RECAP.md`
when shipped, then delete from here.

---

## 🏎️ Limo Path — Strategic Roadmap (Apr 24)

North-star plan. PixiuBot is the backbone through every stage. Every
piece of infrastructure we've built (risk guard, Jupiter integration,
Supabase trades DB, webhook entry path, wallet watcher, dashboard)
carries forward without rewrite. Each stage validates the next.

**Current state**: 1.27 SOL (~$109). Post-Apr 24 fixes expected edge:
~+0.26 SOL/week if theo/daniww hold. Avg loss post-fix: -0.0037 SOL
vs pre-fix -0.017 SOL (4.6x improvement).

### Stage 1 — Prove the edge (now → +30 days)
Just keep PixiuBot running in current form.
- **Target**: 1.27 → 3+ SOL
- **Method**: theo pump sad + daniww 2x elite sizing (shipped `918518b`),
  dump-pattern filter (`b880e8b`), phantom peak gate, 0.85 drain floor
- **Validation gate**: 30 post-fix trades must show net-positive
  expectancy before advancing to Stage 2
- **Dev time**: zero — already shipped
- **Risk**: theo/daniww could stop performing. Run postmortem every
  30 new trades to catch decay early.

### Stage 2 — Kill infrastructure bottlenecks (+30-60 days)
Upgrade execution layer without changing strategy.
- **Target**: 3 → 10 SOL
- **Ships**:
  - Helius Pro subscription ($100-300/mo) → Geyser gRPC direct
  - Signal lag drops **30s → 2-3s** (beats other copy-traders to fill)
  - BloXroute Trader API integration → replaces Jito for bundle
    submission. Fixes the 3/4 Jito timeout rate observed Apr 23-24.
  - Free BloXroute tier works for 0.05 SOL trades.
- **Dev time**: ~1 week (gRPC subscription + BloXroute drop-in)
- **Expected uplift**: 20-30% on theo/daniww PnL from reduced slippage
  + faster entries

### Stage 3 — Add pump.fun sniper module (+60-120 days)
Second strategy on same codebase. Copy-trade + snipe run in parallel.
- **Target**: 10 → 50+ SOL
- **Ships**:
  - New signal source: pump.fun bonding-curve mint events via Geyser
  - Entry within 500ms of token launch (vs our copy-trade T+2s)
  - **Reuses existing risk guard** (phantom peak, drain, L1/L2 grid)
  - **Reuses Jupiter + BloXroute** execution layer
  - New filter set for sniper mode (holder count, dev wallet patterns)
- **Dev time**: 5-7 days on top of Stage 2 infra
- **Rationale**: Copy-trading smart money at T+2s is still behind
  snipers who enter at T+100ms. Becoming the sniper captures the
  first-move premium.

### Stage 4 — Capital partnership (+120-180 days)
Use 60-90 days of verified +EV logs as pitch material.
- **Target**: 50 → 500 SOL
- **Method**:
  - Raise 30-50 SOL from 2-3 partners at 50/50 profit share
  - Operate 0.5-3 SOL per position (vs current 0.05)
  - Dashboard exposes per-partner PnL attribution
  - All execution runs through same PixiuBot
- **Risk**: capital allocation to strategy can shift — need per-stack
  PnL accounting and clear exit rules
- **Dev time**: 3-5 days (dashboard partner view + allocation rules)

### Stage 5 — 🏎️ Limo territory (+180-365 days)
500 SOL ≈ $43k at SOL=$86 → used limo cash.
- **Decision point**: cash out vs continue compounding
- **Alternative**: hire a driver because operating the bot is now a
  full-time job and we shouldn't be driving anyway

### What carries forward through every stage
| Component | Stage 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Risk guard (L1/L2 + drain + phantom) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Jupiter swap + rescue ladder | ✓ | ✓ (BloXroute) | ✓ | ✓ | ✓ |
| Supabase trades DB | ✓ | ✓ | ✓ | ✓ (proof) | ✓ |
| Wallet watcher + blacklist | ✓ | ✓ (Geyser) | ✓ | ✓ | ✓ |
| Webhook entry path + 15 guards | ✓ | ✓ | ✓ (+ sniper path) | ✓ | ✓ |
| Dashboard | ✓ | ✓ | ✓ (+ sniper view) | ✓ (+ partners) | ✓ |

### Kill criteria (know when to stop)
- **Stage 1 fails** if 30 post-fix trades show WR < 30% OR net < 0
  → pause bot, postmortem, maybe strategy pivot
- **Stage 2 fails** if faster execution doesn't lift PnL (sig lag was
  not the bottleneck) → cancel Helius Pro, reassess
- **Stage 3 fails** if sniper shows negative expectancy after 50
  trades → disable sniper module, keep copy-trade
- **Any stage** — if bankroll drops below 80% of stage entry level,
  halt and postmortem before proceeding

### Open questions (answer during Stage 1)
- Does elite 2x sizing on daniww 23.5% WR actually scale linearly?
  Losing streaks at 2x could overshoot `DAILY_LOSS_LIMIT_SOL` = 0.50.
- Should `DUMP_PATTERN_MIN_SIGNALS = 3` be tightened to 2 after more
  data? Chloe had 40+; 2 might block legitimate aged-token entries.
- When theo/daniww inevitably decay, how do we detect early? Need
  a rolling WR window (7d or 30d) that auto-demotes on regression.

---

## Sprint 10 — Phase 7 shipped (Apr 21 PM UTC — selection-layer)

Full selection-layer day after Phase 5-6 sell-side rebuild. Four
commits. See `docs/JOURNAL.md#2026-04-21-pm-utc` for detail.

| Commit | What |
|---|---|
| `ac428e8` | `chore(scripts): force-close + check-open utilities` |
| `3080ed8` | `chore(config): MIN_TOKEN_AGE_MINUTES 30 → 15 — test` |
| `2f1708d` | `chore(scripts): stop-bot.ts emergency pause utility` |
| `52c9a20` | `feat(webhook): WALLET_BLACKLIST — 9 bleeders banned` |

### What shipped

**P3 wallet postmortem completed** (deferred from Phase 5-6 backlog).
`src/scripts/wallet-postmortem.ts` with primary-wallet attribution.
Output on 114 closed LIVE trades:

- **Keep**: daniww (+0.1226 SOL, 50% WR, 6 trades) — sole proven
  winner.
- **Cut (blacklisted)**: GMGN_SM_5 (-0.076), Scharo (-0.073), cented
  (-0.070), Bluey (-0.066, 0% WR), bandit (-0.063, 2 addresses),
  decu (-0.031), chair (-0.028), Numer0 (-0.016), Cupsey (+0.008
  carried by one lucky trade).
- **Combined cut impact**: -0.463 SOL loss contribution eliminated.

Guard #10a in `evaluateAndEnter()` checks primary `walletAddress`
against `WALLET_BLACKLIST` (Set in `smart-money.ts`) BEFORE the
tier check. Survives tier-manager auto-promotion.

**Intentionally NOT tightening promotion threshold** — would have
demoted daniww (5→10 trade threshold requires 7/10 wins at 65% WR,
unreachable at her 50% pace). Blacklist handles known bad actors;
tier-manager stays forgiving for new winners.

**Age filter 30 → 15** — test change. Blocking nearly all daytime
flow at 30min; 15min opens up the 15-30min bucket we had no data
on. Death zone (<5min, 31.8% WR) still gated. Revert trigger: WR
< 25% over ≥ 10 new trades in the 15-30 bucket.

**Operational scripts**:
- `stop-bot.ts` / `start-bot.ts`: flips `bot_state.is_running`.
- `force-close.ts`: manual position close via rescue-mode ladder +
  skipJito. Locks real_pnl_sol against prior partials. Used today.
- `check-open.ts`: quick live mark read of open positions.

### Day validation (first green day)

Three L1+ grid wins on the new stack in a single session:

| Trade | Grid | Real PnL |
|---|---|---|
| terminal | L2 TO | +0.0079 |
| Solana Money | L2 manual-close | +0.0102 |
| The Traitor | L1 TO | +0.0045 |
| **Total wins** | | **+0.0226 SOL** |

Losses totaled ~-0.08 SOL. Net day: ~-0.06 SOL. Session cumulative
still -0.65 SOL but every shipped fix fired correctly. Wallet
trajectory: 1.4564 → 1.3918 SOL across ~8 hours of LIVE.

### 🟡 Edge webhook — CF Pages deploy needed

`52c9a20` and `3080ed8` are webhook config changes — require CF Pages
build + deploy to be live. Deployed today via auto-deploy on push.

---

## Sprint 10 — Phase 5-6 shipped (Apr 20-21 UTC — sell-side rebuild)

Longest engineering window of the sprint. 16 commits. Covered:
**(a)** grid race durability (atomic claim + sync write), **(b)** Jito
regional rotation, **(c)** skip-Jito on guard-initiated sells,
**(d)** rescue-mode slippage ladder, **(e)** drainage monitor during
hold, **(f)** 6024 retry + partial-size salvage, **(g)** sim-gate math
fix (silently blocked legitimate CB/SL exits at L2+), **(h)** post-L1
retracement trail (SCHIZO-class coverage), **(i)** unified phantom
accounting so partial credit isn't clobbered, **(j)** dashboard
exit-reason mappings.

See `docs/JOURNAL.md#2026-04-21` for the full writeup. Commit list:

| Commit | What |
|---|---|
| `20fd68e` | `feat(risk-guard): post-L1 retracement trail` — SCHIZO-class coverage |
| `07822a1` | `fix(sim-gate): proportional cost basis` — was aborting L2+ SL/CB |
| `6d17fdd` | `fix(sells): 6024 ladder-retry + partial-size salvage + unified accounting` |
| `523e31d` | `chore(risk-guard): tighten trailing stop 20% → 10%` |
| `ae0ae6d` | `fix(sells): rescue-mode slippage [20,30]% + 30s confirm timeout` |
| `748dd8e` | `fix(sells): skip Jito on all guard-initiated exits` |
| `82c1379` | `chore(config): DAILY_LOSS_LIMIT_SOL 0.25 → 0.50` (resume) |
| `e8f8257` | `feat(risk-guard): continuous liquidity drainage monitor` (Openhuman class) |
| `c8fcd6a` | `chore(scripts): daily-limit phantom cleanup + rollback` (45 phantoms) |
| `a75eca0` | `feat(jupiter-swap): rotate Jito bundle endpoints + 429 retry` |
| `0a98636` | `fix(executor): mark daily-limit-skipped as failed` |
| `34507ab` | `fix(risk-guard): atomic DB claim on grid_level` |
| `7568c14` | `chore(scripts): reconcile-rollback utility` |
| `d2e3d54` | `feat(risk-guard): divergence alert CASE A extension` |
| `0a7c356` | `chore: remove dead broadcast channel + stale banner` |
| `b261115` | `chore(config): revert daily loss 0.50 → 0.25` (superseded) |

### Evidence post-fix stack works

- **DogeWeedWojakNoScopeDuckSnoop**: first confirmed winner on new
  stack. L1 +0.0035 + TO rescue-mode final +0.0085 = **+0.0120 SOL net**.
- **APU late-rescue**: buy marked failed → found on-chain → rescue
  re-opened → CB fired with sim 73.73% → clean fill, bounded -0.014.
- **ICEMAN**: L1 locked +0.003, SL rescue-mode 20% slip, bounded -0.003.
- **AMERIC4N P5YCHO**: clean fail, no phantom row.
- **SCHIZO SIGNALS**: exposed the sim-gate math bug that drove `07822a1`
  and the L1→TO gap that drove `20fd68e`. Would close flat-to-positive
  under post-commit rules.

### Day 2 PM stats still apply (nothing closed on full new stack yet)

101 closed LIVE trades cumulative, -0.5635 SOL session, 26.7% WR.

### 🟡 Requires node-agent restart to activate

All changes in `src/lib/*` and `src/agents/*` need the node swarm
(`npx tsx src/agents/run-all.ts`) to restart. Edge webhook unchanged.

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

### P0 — Next wallet-postmortem re-run (~30 new closed trades from now)

First round cut 9 bleeders saving -0.463 SOL of expected future loss.
Re-run `src/scripts/wallet-postmortem.ts` every ~30 new closed trades
to catch the next wave.

Likely next-round candidates (based on Phase 7 insufficient-data
wallets that may cross the 5-trade threshold with more data):
- `Johnson` — 4 trades, 25% WR, -0.016 SOL so far
- `Trenchman` — 4 trades, 0% WR, -0.074 SOL (already eligible but
  was in insufficient-data bucket at time of first run)
- `SmokezXBT` — 3 trades, 0% WR, -0.042 SOL
- `chester` — 3 trades, 0% WR, -0.072 SOL
- `pr6spr` — 1 trade, 0% WR, -0.052 SOL (single massive loss)

Cadence: after every 30 closed trades, or when session crosses
-0.20 SOL, whichever first.

### P0 — Validate post-fix stack (ongoing)

Phase 5-6 stack now has 3 post-fix wins: terminal +0.0079, Solana
Money +0.0102, The Traitor +0.0045. All three used atomic claim,
sync write, skipJito, rescue-mode slippage, post-L1 trail.

Remaining verification items for larger sample:

- `🆘 salvage recovered X SOL` fires (no 6024 unsellable cases yet
  on new stack — can't validate salvage math empirically)
- `[POST-L1 TRAIL]` firings — The Traitor had close-to-trigger retrace
  but never fired. Need more data on trail effectiveness vs TO.
- Rescue-mode slippage distribution — most sells landing at 20%.
  Tracking whether 30% rung ever needed.
- DexScreener mark vs Jupiter real divergence at CLOSE. L1 slices
  show large gaps (15pt+); L2/final slices cleaner. Worth studying.

### P0 — Age filter test (30 → 15) — revert trigger watch

`3080ed8` loosened MIN_TOKEN_AGE_MINUTES 30 → 15. Test. Revert
target: WR < 25% over ≥ 10 new trades from the 15-30min bucket.
Early data: 2 trades in bucket so far (J. Edgar Boozer -0.015,
terminal +0.0079). Net -0.007 on n=2 — not enough to conclude.

### P0 — Tune new thresholds based on validation data

After the 48h window, reassess:

- **`POST_L1_TRAIL_PCT`** (currently 25%). Looser = more L2 runs
  captured, tighter = less give-back at close. Candidate tunes: 20,
  25, 30.
- **`LIQUIDITY_DROP_THRESHOLD`** (currently 0.40). Now on correct
  math. With the denominator fixed, 40% is strict — a healthy token
  post-L1 should quote ~1.0. Consider bumping to 0.60 for earlier
  drain detection. Risk: transient Jupiter quote noise could cause
  false pool_drain exits.
- **Divergence alert threshold** (currently 0.25). SCHIZO was 23.9%
  — just below. Dropping to 0.20 surfaces this class in Telegram.
  Pure telemetry change, no trading behavior impact.

### P0 — REVERT DAILY_LOSS_LIMIT_SOL 0.50 → 0.25

Bumped TWICE (`82c1379` Apr 20 after `b261115` revert). Left at 0.50
to let the new sell-side stack run after midnight UTC rollover. Revert
target: after 20+ trades on new stack OR at next UTC rollover if the
session crosses 0.30 SOL loss. User-decision gate.

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

### ~~P1 — Wallet postmortem with primary-wallet attribution~~ (SHIPPED Phase 7)

Completed Apr 21 PM. Script at `src/scripts/wallet-postmortem.ts`.
9 wallets blacklisted via `52c9a20`. Re-run every ~30 new closed
trades to catch new bleeders.

### P1 — Zombie row cleanup (~21 rows, different class from the 45 phantoms)

Existing: 45 `filter_daily_limit_retro` phantoms cleaned by
`c8fcd6a` (Apr 20). Distinct from the pre-atomic-claim zombies
where `grid_level > 0 AND remaining_pct = 100 AND sell_tx_sig IS NULL`
— rows where L1 was claimed but the sell never landed before
`34507ab` made claims atomic.

Verification query first:
```sql
SELECT count(*) FROM trades
WHERE grid_level > 0 AND remaining_pct = 100 AND sell_tx_sig IS NULL;
```

If count matches ~21, write a targeted cleanup that:
- Backs up the rows to JSON (same pattern as `c8fcd6a`)
- Resets `grid_level = 0` and `remaining_pct = 100` if status='open'
- Flags status='closed' with `exit_reason='zombie_cleanup'` if orphaned

### ~~P1 — L0 whale_exit safety net underperforming~~ (DEFERRED)

whale_exit remains DISABLED per Sprint 10 Day 1 Dicknald postmortem
(`06f0c09`). Structural latency — we see whale sells AFTER they land
on-chain, by which time pool is already drained. Re-enable requires
a predictive signal (mempool-level or pattern-based), not a config
flip. Code preserved but path is off.

### ~~P1 — Stop loss on L1+ positions bleeding banked profit~~ (SUPERSEDED)

Largely addressed by the post-L1 retracement trail (`20fd68e`). SL
-10% still fires on L1+ but the trail catches peak retracements
before SL triggers. Grid-scaled SL (L1: -7%, L2: -5%) remains a
candidate if the 25% retrace trail proves insufficient — validate on
48h sample first.

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
