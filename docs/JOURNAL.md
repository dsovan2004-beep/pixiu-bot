# PixiuBot Journal

Append-only log of material decisions, bugs shipped, architectural pivots.
Newest first.

---

## 2026-04-21 (UTC) — Sprint 10 Phase 5-6: sell-side rebuild (16 commits over ~30h)

Longest engineering window of the sprint. Started after Sprint 10 Day 2
PM closed net-negative and daily-limit halted. Three user-visible
failure classes drove the work:

1. **Openhuman-class**: -100%+ real losses on benign Token-2022 mints.
   Postmortem (`investigate-openhuman.ts`) showed the mints had no
   transfer fees — just metadata-only extensions. Real cause was pool
   drainage between entry and exit making Jupiter's quoted min-out
   unreachable at full-balance sell size. Old code bailed at first
   6024 assuming transfer-tax.

2. **SCHIZO-class**: L1 fires at mark +17%, peak +17.6%, mark drifts
   back to +11.6% over 8min, TO forces exit at mark-real divergence
   (real -20% when mark was +11.6%). Net -0.004 SOL on what "looked
   like" a winner. Between L1 and SL there's a 27pt no-man's-land
   with no retracement protection.

3. **Phantom accounting**: >100% losses appearing in dashboard because
   sell-failed rows were writing `real_pnl_sol = -entryCost` blindly
   even when L1 partials had already banked SOL (clobbering the
   credit).

### Commits (chronological, oldest first)

| Commit | What |
|---|---|
| `b261115` | `chore(config): revert daily loss limit 0.50 → 0.25` (cleanup) |
| `0a7c356` | `chore: remove dead broadcast channel, stale 'Sprint 3' banner` |
| `d2e3d54` | `feat(risk-guard): extend divergence alert to CASE A` (tokens-gone close path) |
| `7568c14` | `chore(scripts): add reconcile-rollback utility` |
| `34507ab` | `fix(risk-guard): atomic DB claim on grid_level` — closes same-session duplicate-partial race |
| `0a98636` | `fix(executor): mark daily-limit-skipped trades as failed` (stops phantom accumulation) |
| `a75eca0` | `feat(jupiter-swap): rotate Jito bundle submits across regional endpoints` (retry on 429) |
| `c8fcd6a` | `chore(scripts): daily-limit phantom cleanup + rollback utilities` (45 phantoms cleaned) |
| `e8f8257` | `feat(risk-guard): continuous liquidity drainage monitor during hold` (Openhuman class) |
| `82c1379` | `chore(config): bump DAILY_LOSS_LIMIT_SOL 0.25 → 0.50` (user-requested resume) |
| `748dd8e` | `fix(sells): skip Jito on all guard-initiated exits` — direct RPC with auto priority |
| `ae0ae6d` | `fix(sells): rescue-mode slippage + confirm timeout` — capture trailing peaks |
| `523e31d` | `chore(risk-guard): tighten trailing stop 20% → 10% from peak` |
| `6d17fdd` | `fix(sells): 6024 ladder-retry + partial-size salvage` — recover some SOL on drained pools |
| `07822a1` | `fix(sim-gate): recovery calc must use proportional cost basis` — pre-flight gate was miscalibrated at L1+ |
| `20fd68e` | `feat(risk-guard): post-L1 retracement trail` — cover the L1→TO no-man's-land |

### Material behavior changes

**Grid race durability (`34507ab`, `12b5842` earlier):** Atomic DB
claim on `grid_level` gated by `.lt("grid_level", grid.level)` prevents
parallel poll cycles from double-firing L1/L2. Sync DB write happens
immediately after `sellToken` returns, not in a background task —
eliminates rollback-on-restart class.

**Jito regional rotation (`a75eca0`):** `JITO_BUNDLE_ENDPOINTS` array
[ny, frankfurt, amsterdam, tokyo, global] rotates round-robin with
`nextJitoEndpoint()`. On 429 the caller retries with the next region.
Replaced the single-endpoint 429 dead-end.

**Skip-Jito on guard-initiated sells (`748dd8e`):** All exits
(CB/SL/TO/trailing/grid/whale/unsellable/rescue) now pass
`skipJito: true` to `sellToken`. Direct RPC with auto priority fees,
no Jito bundle poll. Rationale: memecoin exit timing beats MEV
protection — a 60-90s Jito poll routinely costs 20-50pp of fill on
volatile pumps. Buys still route through Jito (entry sandwich is a
real cost, entry timing is less pump-sensitive).

**Rescue-mode slippage ladder (`ae0ae6d`):** New `SELL_SLIPPAGE_BPS_RESCUE
= [2000, 3000]` used for `RESCUE_EXIT_REASONS` (CB, SL, trailing_stop,
whale_exit, holder_rug, pool_drain, timeout). 30s confirm timeout
and 3-retry status poll (vs 60s / 6 retries for normal grid).
Original 5%→10%→20%→30% ladder wasted 60-120s per rung on thin pools
during rug events.

**Trailing stop tightened to -10% (`523e31d`):** Was -20%. Winners
caught by the old rule exited at +30-50% mark instead of +80-90%.
The -10% trail triggers roughly when the reversal starts, not after
it's well underway.

**Liquidity drainage monitor (`e8f8257` + `07822a1` math fix):**
Periodic `simulateSellRecovery()` (60s cadence per position). If
quoted recovery on the remaining slice drops below 40% of its
proportional cost basis, emergency exit via `pool_drain`. Original
implementation at `e8f8257` divided by full entry cost, so the metric
mechanically halved after L1 (50% sold) and quartered after L2 (75%
sold) regardless of pool health. Post-`07822a1`, a healthy token at
any grid level quotes ~1.0; the 40% floor now means real drainage
across all levels.

**Sim-gate math fix (`07822a1`):** Same bug lived in the pre-flight
sell sim-gate inside `sellToken`. At L2 (remaining_pct=25), a
routine -10% dip on the remaining slice would produce recovery
22.5%, below the 30% floor — SL/CB/trailing would ABORT legitimate
rescue exits. Silently ate position value on downsides. Both call
sites now use `costBasis = entry × (remaining/100) × (sellPercent/100)`.

**6024 ladder retry + partial-size salvage (`6d17fdd`):** Old code
bailed at first 6024 assuming transfer-tax. Investigation showed
Openhuman + John Apple had no transfer-fee extensions — just
metadata. 6024 now retries through the slippage ladder like 6001;
only marks unsellable after every rung fails. Risk-guard then tries
one 25%-chunk salvage at rescue slippage before mark-to-zero. Thin
pools often take smaller orders even when full-size 6024s. Unified
L0 and L1+ accounting paths so salvage credit doesn't get clobbered.

**Post-L1 retracement trail (`20fd68e`):** New `POST_L1_TRAIL_PCT = 25`
with `POST_L1_MIN_PEAK_PCT = 5` guard. At grid levels 1 and 2, track
peak-since-activation. If retracement from peak > 25% AND peak was
≥ +5% above entry, exit via `trailing_stop`. Covers SCHIZO-class:
peak +17.6% → floor +13.2% → exits ~4-5min before TO. Estimated
SCHIZO counterfactual: +0.003 SOL instead of -0.004 SOL.

**Phantom accounting unified (`6d17fdd`):** Old L0 branch in the
unsellable path wrote `real_pnl_sol = -entryCost` blindly. New
unified path: `existingPnl - remainingCostBasis` where
`remainingCostBasis = entryCost × remainingPct / 100`. Works for
L0 (full loss = `-entryCost`), L1+ with partials already banked,
and post-salvage where `remainingPct` has been reduced.

**Dashboard exit-reason mappings (`6d17fdd`):** Added PD (pool_drain,
amber), HR (holder_rug, red), XS (unsellable_6024, red). Previously
all rendered as "-".

### Filter changes

None this sprint. Entry filters stayed at MIN_TOKEN_AGE_MINUTES=30,
MAX_CO_BUYERS_5MIN=2, MIN_ROUND_TRIP_RECOVERY=0.90. All work was on
the exit side.

### Day-end results (Apr 20-21)

101 closed LIVE trades cumulative, **-0.5635 SOL** session, 26.7% WR
(27W / 74L), avg win +36.52%, avg loss -28.04%.

Evidence the post-fix stack is working:
- **DogeWeedWojakNoScopeDuckSnoop** (first confirmed post-fix winner):
  L1 banked +0.003513, TO exit via rescue-mode 20% slip at +22.49%
  pnlPct → final +0.008453 → **net +0.0120 SOL** (+23.93%).
- **APU**: late-rescue re-opened the trade after buy marked failed
  (`🛟 [RESCUE] APU found on-chain — buy landed late, re-opening trade`),
  CB at -18.8% fired rescue mode, sim 73.73%, clean fill. Net -0.014
  SOL bounded loss.
- **ICEMAN**: buy via RPC after Jito timeout, L1 locked +0.003, SL
  rescue 20% slip fill. Net -0.003 SOL bounded.
- **SCHIZO SIGNALS**: L1 banked +0.001, then the bug surfaced — real
  -0.004 net on a +17% mark peak. **This trade exposed the sim-gate
  math bug and drove `07822a1` + `20fd68e`.** Would close flat to
  slightly positive under the post-commit rules.

Clean fails (no phantom): AMERIC4N P5YCHO (buy timed out twice, rescue
found no tokens, no DB row left open).

### Safety rails preserved

- No change to CB / SL / TO triggers
- L3 trailing unchanged (-10% from peak)
- whale_exit stays DISABLED
- Entry filters untouched
- `DAILY_LOSS_LIMIT_SOL` at 0.50 — still above the earlier 0.25 target,
  revert is pending user decision

### Open questions (tracked in BACKLOG)

- Does the new post-L1 trail threshold (25%) leave enough room for L2
  runs? Needs 10+ L1-ing trades to validate.
- Drain monitor floor of 40% is now on correct math — is 40% still
  the right number, or should it tighten to 60% now that the metric
  is trustworthy?
- Divergence alert threshold 25% missed SCHIZO at 23.9%; consider
  0.20.
- P3 wallet postmortem with primary-wallet attribution still pending —
  earlier agent's analysis conflated co-signers. Needs re-run on
  clean post-fix data (wait 48h for accumulation).

---

## 2026-04-19 (PM UTC) — Sprint 10 Phase 1: execution hardening (Jito + sim gate)

Three surgical commits targeting the real leak surfaced by Sprint 10
Day 1: mark-vs-real divergence on rescue exits. BASED trailing_stop
closed at +77% mark / −56% real. Nintondo: +74% mark / −40% real.
Dicknald whale_exit (already addressed): −9% mark / −97% real. Root
cause is NOT whale_exit-specific — it's any sell that lands into a
drained pool. Whale_exit just got there first.

Disabling whale_exit (`06f0c09`) stopped the reactive dumps into
post-whale depletion, but trailing/CB/SL paths still had no MEV
protection and no way to detect drainage before signing.

### Commits

| Commit | Change |
|---|---|
| `c2911a4` | `feat(jupiter-swap): add Jito tip to swap requests (0.001 SOL)` |
| `f11021d` | `feat(jupiter-swap): submit via Jito bundle with public RPC fallback` |
| `958b8f5` | `feat(risk-guard): pre-flight sim check on sells, abort if recovery <30%` |

### What each does

**1. Jito tip.** Swap requests now pass
`prioritizationFeeLamports: { jitoTipLamports: 1_000_000 }`. Jupiter
embeds the tip instruction into the returned swap tx. 0.001 SOL
matches what dominant pump.fun bots (Axiom, BullX, Photon, Trojan,
BonkBot, Banana Gun) run.

**2. Jito bundle submission.** New `submitViaJito()` helper posts
`sendBundle` to `https://mainnet.block-engine.jito.wtf/api/v1/bundles`
(public endpoint, no auth) and polls `getBundleStatuses` every 2s up
to 60s. Signature is extracted from signed tx before submission so
it's usable on either path. On Jito HTTP failure → fall back to
`connection.sendRawTransaction`. On Jito submitted-but-not-confirmed →
reuse the same signature and let the existing RPC status-poll resolve
final state (no duplicate submission). Applies to both `buyToken` and
`sellToken`. Full MEV protection requires BOTH the tip and the bundle
route — a tip-only tx through public RPC still gets sandwiched.

**3. Pre-flight sim gate.** `sellToken(coinAddress, opts?)` now takes
optional `{ entrySolCost, exitReason }`. For rescue exits
(whale_exit / circuit_breaker / stop_loss / trailing_stop) it
computes `recovery = quote.outAmount / entrySolCost` and aborts when
recovery < `SELL_MIN_RECOVERY_FLOOR` (0.30). A `connection.simulate
Transaction` call runs as a secondary sanity check for telemetry.
Grid `take_profit` always executes regardless (voluntary partial on
winners, not a rescue). Sim recovery % is logged on every sell so we
can study the distribution and tune the floor after 30+ trades.

Abort state lives in an in-memory `sellSimAborts` Map with a read-once
`wasSellSimAborted(mint)` helper. Risk-guard reads it in the sell-
failed branch, reverts `closing` → `open` with a distinct log + Telegram
alert. The existing 60s `closingPositions` lock prevents immediate
re-fire in the same cycle.

### Safety rails (explicit)

- No change to CB / SL / TO / grid / trailing triggers
- No change to slippage ladder (5 → 10 → 20 → 30%)
- Whale_exit stays DISABLED
- Only `sellToken` gets the sim gate; `buyToken` unchanged past the tip
- Existing error handling (6024 unsellable, 6001 slippage cascade,
  late-confirm rescue) all preserved
- Script callers of `sellToken(mint)` keep working — opts is optional

### Floor rationale (0.30)

Intentionally narrow. Catches Dicknald-class tail (2.5% recovery) and
would have aborted BASED (~44% recovery based on +77% mark / −56%
real on 0.05 SOL entry) and Nintondo (~60% — NOT gated). So this will
NOT save every mark-vs-real loser. First cut is designed to block
only catastrophic drainage (<30%) while letting ordinary losses
through. Will revisit the threshold after 30+ sim-logged trades.

### Bot state on ship

Bot remains STOPPED. User flips START after reviewing final state.
Guard still runs when stopped — sim logs will appear on any natural
close of existing positions.

---

## 2026-04-19 (early morning UTC) — whale_exit DISABLED after Dicknald post-mortem

First trade post daily-limit reset. Dicknald Trump closed −97.48% real
on a −9.45% mark — 88pp divergence. Read-only investigation pointed
cleanly at AMM depth depletion, not honeypot or transfer fee.

### Post-mortem facts (verified on-chain)

- **Tokens bought:** 51,638,452,990 at slot 414148529 for 0.050005 SOL
- **Tokens sold:** 51,638,452,990 at slot 414148816 (~287 slots / 2 min later) for 0.001260 SOL
- **Recovery rate:** 2.52% of entry
- **Sell tx sig:** `65KGwpFd74vo5MBgi1JYTV2yok5vohmaVFmhZZybLYR1x5QdgPeJZ24HySGju1npFUpiEbs1iRePYS7iVE3ffFrn`
- **Sell tx err:** null. Confirmed on FIRST 5% slippage attempt — no cascade.
- **Mint:** Token-2022 with ONLY `metadataPointer` + `tokenMetadata` extensions. NO `TransferFeeConfig`, NO `TransferHook`. Not a honeypot.
- **AMM:** pump.fun post-graduation AMM program `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`

### Root cause

Jupiter's quote at sell time priced 51.6B tokens at 0.001260 SOL. The
sell executed within 5% of that quote. DexScreener mid-price at the
same moment read −9.5%. Mark and on-chain pool diverged by 88pp because
DexScreener caches pool state with 5-30s latency, and the followed
whale (GMGN_SM_5) dumped into the AMM between our buy and our sell.

By the time whale_exit fires, the whale's tx has already landed — the
pool is drained. Our reactive sell eats whatever dust is left.
"Require mark confirmation" wouldn't help because the mark source is
slower than the state it's supposed to verify.

### Fix

Commit `3a84c6c` (hypothetical — filled in below): `WHALE_EXIT_ENABLED = false`.

Logic kept intact, just flag-gated. Can re-enable if a predictive
signal materializes (exit BEFORE the whale, not after). SL (−10%),
CB (L0/L1+ −15%), trailing, and TO are now the only exits.

### Pre-disable whale_exit track record

6 L0 WE trades this sprint:

| Coin | Real % | Notes |
|---|---|---|
| Chud | +22.13% | one winner — whale-into-momentum, not reactive |
| Dicknald Trump (old) | −7.62% | |
| Walter | −21.38% | |
| Asteroid Shiba | −26.33% | |
| NarutoUzumaki... | −67.98% | |
| Dicknald Trump (new) | **−97.48%** | pool drainage, this post-mortem |

**1W / 5L, net ~−0.14 SOL.** The one win had nothing to do with the
reactive-exit mechanism; it was riding momentum the whale created.

---

## 2026-04-18 (evening) — Sprint 10 DAY 1: framework rebuild + safety rails

Started as real-data observation; evolved into a full day of framework
work. Bot now 100% real-only with deposit-safe accounting, tightened
risk thresholds, reaper race fixed, and auto-resume daily limit.

### Commits (chronological)

| Commit | What |
|---|---|
| `3d11157` | Partial unique index `one_open_per_mint_idx` — webhook race can no longer create duplicate open rows |
| `e31b75b` | `parseSwapSolDelta` uses fee-payer index 0 — fixes ALT decode failure on Jupiter v0 txs |
| `a386ed2` | **Reaper flip-flop fix** — `closing_started_at` column + migration 014. Reaper now uses close-time, not entry-time. Yoshi stop-loss loop resolved |
| `c3153cc` | Dashboard stripped of paper framework — real-only stats, no Recovery Goal, no Mode toggle |
| `d5978bc` | Dashboard includes `status='closing'` rows under Open Positions (no more vanishing mid-close) |
| `071ace8` | Daily loss limit tightened 2.0 → 0.25 SOL (wallet dropped to 0.82 SOL, old cap too wide) |
| `11d8c6a` | Migration 015: rename `paper_trades` → `trades`, wipe rows, drop `paper_bankroll`. Fresh real-only DB |
| `d7829b4` | Backlog: Sprint 10 post-session findings |
| `bf149dc` | **L1+ CB tightened −25% → −15%** (was 0W/2L, banked profit giving back past entry) |
| `be206c4` | Full scrub — 'paper' word removed from entire repo (33 files, 4 migration renames) |
| `eba800a` | Kill hardcoded `STARTING_SOL`. Dashboard shows Wallet/Wallet USD/Trade PnL/Trade ROI — deposit-safe |
| `5d68772` | Daily loss limit no longer writes `is_running=false`. Counter-based gate auto-clears at midnight UTC |

### Real results (Sprint 10 Day 1, 22 LIVE trades post-rebuild)

```
Win Rate:   28.6%   (6W / 16L)
Trade PnL:  −0.1787 SOL (−$15.38)
Trade ROI:  −16.41%  (on ~1.09 SOL deployed)
Avg Win:    +24.15%
Avg Loss:   −32.74%
Wallet:     1.77 SOL after $95 deposit
```

### Exit reason breakdown — matches Sprint 9 Day 2 pattern

| Reason | Trades | Net SOL | Real WR | Note |
|---|---|---|---|---|
| trailing_stop | 2 | +0.0572 | 100% | Asteroid +100.8%, PercyJackson +8.87% — **proven edge** |
| circuit_breaker | 9 | −0.1144 | 22% | biggest drain; L0 dominates |
| whale_exit | 5 | −0.0725 | 20% | still underperforming even L0-only |
| stop_loss | 3 | −0.042 | 0% | all on L1/L2 — giving back banked profit |
| timeout | 2 | −0.019 | 50% | |

### Architectural decisions

- **Mark-to-market vs real — fully separated.** `pnl_pct` / `pnl_usd` columns remain in `trades` but are no longer written. All outcome accounting flows from `real_pnl_sol`. Mark-to-market is an internal trigger signal only.
- **Wallet display vs performance accounting — decoupled.** Dashboard wallet card = live Helius RPC balance. Performance cards derived only from `real_pnl_sol` / `entry_sol_cost`. Deposits & withdrawals no longer affect metrics.
- **Daily loss limit — soft gate.** No longer halts bot. Per-buy check in executor blocks entries until midnight UTC rollover. Bot stays RUNNING throughout.

### Bugs fixed this session

- **Webhook race** (3d11157): 5 duplicate rows from one Cupsey signal storm
- **ALT decode** (e31b75b): parseSwapSolDelta was failing silently on v0 txs with Address Lookup Tables
- **Reaper flip-flop** (a386ed2): stuck close loops on trades > 5 min old
- **STARTING_SOL hardcode** (eba800a): deposit of 1.1 SOL showed as −1.1 SOL loss on dashboard
- **Daily limit auto-halt** (5d68772): required manual START BOT click every day after limit trip

### Sanity check: 19/19 passed

```
▸ Database schema: trades table ok, paper_* all removed, all cols present, unique index enforced
▸ Bot state: mode=live, is_running=true
▸ Config: LIVE_BUY_SOL=0.05, DAILY_LOSS_LIMIT_SOL=0.25, CB L0/L1+=15/15
▸ Source: daily limit no longer writes is_running=false
▸ Runtime code: zero 'paper' references
▸ APIs: phantom-balance returns only {sol, usd, lamports, solPrice}; settings returns live_trading:true
▸ Tables: coin_signals ok, 751 active wallets
```

### State at sign-off

- Bot: RUNNING, watching for 2+ smart-money confirmers
- Wallet: 1.77 SOL ($152) after deposit
- Daily limit: 0/0.25 SOL (fresh counter, midnight UTC rolled)
- Next: observe L1+ −15% CB behavior and trailing_stop conversion rate

---

## 2026-04-18 (afternoon) — Sprint 9 P0 COMPLETE + strategy changes from real data

Backfill finished all 310 LIVE trades, dashboard flipped to real math,
and two hot-path exit-strategy fixes shipped based on the real-data
findings. This was the first day the bot's dashboard told the truth.

### Commits

| Commit | What |
|---|---|
| `d690937` | Historical backfill — 310/310 LIVE trades now have `real_pnl_sol` (301 fully matched, 9 NEVER_LANDED) |
| `8372d64` | Dashboard swap — Live Trade Performance stats compute from `real_pnl_sol`, new "Sum real PnL" header line, "Real SOL" column in closed trades |
| `6b3c2eb` | **whale_exit gated to L0 positions only** — 94 trades at 23% real WR / −1.24 SOL was our #1 drain |
| `ee2514e` | **CB threshold split: L0 −15% / L1+ −25%** — 53 trades at 26% real WR / −0.96 SOL (P2a from backlog) |
| `375b18b` | `divergence-flagger.ts` observability script |
| `bc2a581` | Banner line updated to reflect new CB + whale_exit logic |

### The 5.4 → 1.83 SOL mark-vs-real gap

Previous-session finding of a "5.4 SOL gap" was across all 310 trades
via sum(pnl_pct) × 0.05 vs wallet delta. Refined after backfill:

```
Mark-to-market (Σ pnl_pct × 0.05):  +2.67 SOL
Real (Σ real_pnl_sol):              +0.79 SOL
Mark inflation:                     +1.83 SOL
Wallet delta:                       −2.70 SOL
Remaining gap (wallet − real):      −3.49 SOL
```

The 3.49 SOL gap between real PnL and wallet delta = fees on 71 failed
Jupiter buys + orphan tokens + rescue sells outside the trade records.
Trade-level accounting is now accurate; wallet-level reconciliation is
separate and not needed for strategy decisions.

### Real performance by exit_reason (across 301 matched trades)

| exit | trades | real WR | real avg | total SOL | verdict |
|---|---|---|---|---|---|
| take_profit | 57 | 66.7% | +67.1% | +2.13 | 🏆 real alpha |
| trailing_stop | 17 | 70.6% | +84.6% | +0.72 | 🏆 real alpha |
| stop_loss | 53 | 50.9% | +12.2% | +0.20 | marginal |
| timeout | 20 | 40.0% | +7.2% | +0.07 | marginal |
| rug_or_missing | 7 | 28.6% | −35.4% | −0.13 | expected loss |
| circuit_breaker | 53 | 26.4% | −29.2% | −0.96 | 🩸 #2 drain |
| whale_exit | 94 | 23.4% | −17.6% | −1.24 | 🩸 #1 drain |

### The whale_exit realisation

Mark-at-close said whale_exit had 74.7% WR / +47% avg. Real says 23.4%
WR / −17.6% avg. By the time our Jupiter sell lands, the whale has
already dumped; we fill at the bottom while the DexScreener mid still
reads as a profit.

Fix: whale_exit only fires on L0 positions (where there's no grid
cushion). Once L1+ has locked ≥ +7.5%, let SL/trailing/timeout handle
exits — don't panic-sell into the whale's dump.

### Accounting anomalies surfaced by divergence-flagger

- 73–88% of rows flagged with >20pp divergence across all exit_reasons
- 3 duplicate row pairs confirmed (Broke Company, Justice for Raccoon,
  Mooncoin) — pre-P0b ghost credits still in the data
- Many trailing_stop / take_profit rows were mark UNDER-claimed
  (Jupiter filled higher than DS mid) — we made more than the old
  dashboard showed on winners

### State at sign-off

- Bot: STOPPED (standing order until user decides to resume)
- Sprint 9 P0: all sub-items COMPLETE (backfill + dashboard + flagger)
- Remaining: observation window to measure whale_exit + CB fixes

---

## 2026-04-18 (late night) — Sprint 9 P0 go-forward accounting shipped

Turning point. After live-stats.ts surfaced a 5.4 SOL gap between
mark-to-market math and wallet reality, shipped the first half of
Sprint 9 P0 despite earlier "doc-only tonight" plan — bot was STOPPED
with 0 open positions, which is the safest possible window for
hot-path changes.

### The gap confirmed

```
310 LIVE closed trades
Sum(pnl_pct × 0.05 / 100) = +2.6989 SOL  (mark-to-market)
Wallet delta (3.6705 → 0.9669) = -2.7036 SOL  (reality)
Gap: 5.4025 SOL ($~476) of phantom gains in the mark
```

Root cause: `pnl_pct` is derived from DexScreener mid-price at close
time. Jupiter sells slip, fail, or confirm at different prices. Losses
are accurate (bot holds through crashes); gains were inflated (big-pump
trades claimed wins that never materialized in the wallet).

### Commits tonight (late)

| Commit | What |
|---|---|
| `c06e7c0` | BACKLOG — Sprint 9 P0 defined in detail (7-step fix scope, evidence, success criteria) |
| `e264000` | **Sprint 9 P0 go-forward fix** — migration 012 + on-chain SOL delta parsing + real PnL writes + dashboard "Real SOL" column |

### What `e264000` does

1. **Migration 012** — adds `entry_sol_cost`, `real_pnl_sol`,
   `buy_tx_sig`, `sell_tx_sig` to the trades table. All nullable.
   Applied via Supabase dashboard SQL editor — verified 4 columns
   present post-apply.
2. **`jupiter-swap.ts parseSwapSolDelta(sig)`** — fetches tx,
   reads wallet's pre/post SOL balance from `tx.meta.postBalances -
   preBalances`, returns net SOL delta (includes fees).
3. **`trade-executor.ts`** — on buy success, non-blocking UPDATE
   writes `buy_tx_sig` + `entry_sol_cost`. Wrapped in try/catch.
4. **`risk-guard.ts closeTrade()`** — on sell success, non-blocking
   UPDATE writes `sell_tx_sig` + `real_pnl_sol` (= solReceived −
   entry_sol_cost). Logs real PnL:
   ```
   [GUARD] 📊 real PnL: +0.012345 SOL (entry 0.050123 → received
   0.062468)
   ```
5. **Dashboard `/bot`** — new "Real SOL" column in Closed Trades
   table.

### What's still pending from Sprint 9 P0

- **Historical backfill** — 310 pre-Sprint-9 trades have NULL
  real_pnl_sol. Backfilling requires `getSignaturesForAddress`
  per trade to find the Jupiter tx, then parse tx.meta. ~30+ min
  runtime with rate limits. Deferred.
- **Divergence flagger** — post-backfill analysis. Flag trades
  with large mark-vs-real gaps. Deferred.
- **Top-line dashboard stats swap** — wait 48h for go-forward real
  data to accumulate, then swap the top card.

### State at sign-off

- Bot: STOPPED (user will flip START when ready)
- Open positions: 0
- Migration 012 applied ✅
- All tonight's prior fixes still live (SIGINT no-write, exit_time
  latch, whale-exit DB tier, bundle detect, Jupiter 429 retry, P0b
  idempotent close)
- Next LIVE buy+sell will show real PnL in terminal logs — first
  ground truth in the bot's history

---

## 2026-04-18 (evening) — Sprint 8 gate closed; 2 new bug fixes + P0b regression caught

Bot resumed live trading after the P0 gate shipped this morning.
Tonight: 2 new bugs found in sanity check + a regression in the P0b
fix surfaced live.

### Commits tonight

| Commit | What |
|---|---|
| `7adf4f0` | Sanity-check fixes: whale-exit now uses DB `tier=1` (not stale hardcoded 14-wallet set — DB has 63 active T1); bundle-detect no longer double-counts the current walletTag |
| `2fcea6f` | **P0b-regression fix**: idempotent-close latch switched from `.is("pnl_usd", null)` → `.is("exit_time", null)`. The pnl_usd column defaults to 0 (not NULL), so the original latch matched zero rows on every close attempt — positions stayed stuck in 'closing' until the reaper reverted them. 4 positions were stuck mid-evening; all flushed when the fix shipped. |

### Trade results tonight (after P0b-regression fix)

| Coin | PnL | Grid | Reason |
|---|---|---|---|
| X CEO Flōki | +7.50% | L1 | TP |
| Moon Dog | +17.50% | L2 | TP |
| Tung Tung Tung Sahur | −42.15% | L0 | CB |
| hold if your not gay. | −88.67% | L0 | CB (price collapsed faster than 5s guard poll; whales buy+dumped within one window) |
| Retail Coin | +7.50% | L1 | TP (afternoon) |

Real SOL: 1.0043 → 0.9811 tonight.
Cumulative real P&L today: −$238.74.

### Lessons

- **Supabase column defaults matter.** `pnl_usd` has a 0 default, not
  NULL. Any `.is(column, null)` idempotency latch must pick a column
  that's actually nullable. `exit_time` is the right choice.
- **A 5s guard poll is sometimes too slow.** `hold if your not gay.`
  went +37% → −88% between polls. Worth considering either a tighter
  CB threshold (−15% on L0) or a 2s poll for L0-only positions.
- **Tier-manager has promoted a lot of wallets.** DB has 63 tier=1
  active vs 14 hardcoded in config. The hardcoded list is stale
  and should probably be removed.

### State at sign-off

- Bot: RUNNING
- Open positions: 0
- Real SOL: 0.9811
- All bankroll credits flowing correctly
- No stale `closing` rows, no drift

---

## 2026-04-18 (morning) — Sprint 8 P0a/P0b/P0c shipped; bankroll reconciled

Sprint 8 pre-trading gate — 3 of 4 items complete. P2a still pending.

| Commit | What |
|---|---|
| `1e1a6e2` | **P0a** — Jupiter 429 retry backoff (1s/3s/10s, buy + sell paths) |
| `1b808a7` | **P0b** — Idempotent bankroll credit (`.is("pnl_usd", null)` latch on close UPDATEs) + gated sell-failed revert + mark-to-zero on Jupiter 6024 un-sellable tokens |
| *(post-deploy run)* | **P0c** — `src/scripts/reconcile-bankroll-p0c.ts` executed |

### P0c reconcile result

```
Starting balance:    $10,000.00
Current balance:     $29,004.40   ← before reconcile
Σ pnl_usd (ledger):  $18,094.93
Expected balance:    $28,094.93
Drift:               +$909.47     ← phantom credits from P0b bug
Closed trades:       646
Real on-chain SOL:   1.0043
```

Bankroll adjusted $29,004.40 → $28,094.93. Drift of $909.47 was
larger than the $165 estimated from Retail Coin alone, indicating a
longer tail of historical double-credits from the same code path.
P0b fix in `1b808a7` prevents recurrence.

Authoritative source going forward: `SUM(trades.pnl_usd)` for
`status='closed'`. Any future drift > $0.01 indicates a regression.

### Bot state

- Status: STOPPED (per pre-trading gate rule).
- P2a dashboard relabel still pending — ships next, then trading
  can resume.

---

## 2026-04-17 — Sprint 7 Day 3: Shared-Guard Consolidation COMPLETE

**5 commits shipped.** Webhook is now the single entry path. Swarm down
to 4 agents. All 15 guards normalized with `[WEBHOOK] ❌` rejection
logging.

| Commit | What |
|---|---|
| `add1a4d` | Token-2022 extension filter → webhook |
| `e87f6a0` | Whale hold time (2min sell-after-buy) → webhook |
| `4bdc377` | Full `checkTokenSafety` (liq + fdv + m5); `MIN_LIQUIDITY_USD` $5k → $10k |
| `2e41899` | `[WEBHOOK] ❌` normalized rejection logging across all 15 guards |
| `7dbe342` | Deleted `signal-validator.ts` + `price-scout.ts` (−577 lines); `run-all.ts` 6→4 agents |

**Architecture delta:**
- Entry: webhook `evaluateAndEnter()` is now the **only** place
  trade inserts happen.
- Swarm agents: `wallet-watcher`, `trade-executor`, `risk-guard`,
  `tier-manager`. Validator + scout deleted.
- Dead code confirmed: validator/scout were producing log lines with
  zero enforcement — `pixiubot:confirmed` channel had no subscribers.

**Current state:**
- Balance: 1.0248 SOL (start 3.6705, day P&L −2.6457 SOL / −$235.81)
- Win rate 62.4% (189W / 114L)
- Avg gain +42.93%, avg loss −23.77% → expectancy +17.8%/trade
- Bot RUNNING, LIVE, 0 open positions

Day-negative P&L = pre-fix bypass losses (Asteroid, TROLL, jek duvel,
dogwifbeanie window). Now architecturally impossible going forward.

Full recap: `docs/SPRINT7-DAY3-RECAP.md`. Backlog: `docs/BACKLOG.md`.

---

## 2026-04-17 — Sprint 5 Day 3 (earlier)

Phantom infinite-loop + Jupiter 6024 fixes, Token-2022 filter added
(initially to scout). Commits `2bb9246`, `1c0eeea`, `10db69c`.

Full recap: `docs/SPRINT5-DAY3-RECAP.md`.
