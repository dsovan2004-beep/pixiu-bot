# Launch-Sniper Edge Probe — SNIPER-v1 (pre-registered, frozen)

**Frozen 2026-06-24. Shadow-only. No real SOL. No live. No measure_live.**
Pre-registration discipline: the rule + features + decision gate below are fixed
BEFORE any outcome is inspected. We do not cherry-pick the winning cut after the
fact. Governed by `docs/ops/global-build-rules.md` (no hardcoding; values from
spec/policy; fail-closed; evidence-based).

## Why this exists
The copy-trade feed is structurally −EV: we act ~30s *behind* tracked wallets, so
snipers/copy-traders take the liquidity first (verified: −1.2473 SOL / 332 trades;
wallet edge disproven OOS; filtering reduces losses but never crosses zero). LP-v1
tests whether acting *faster on that same feed* helps. SNIPER-v1 tests a
**different signal source entirely**: entering at **token birth** (pump.fun
launch) instead of on a late copy-signal — i.e., being early by *source*, not just
by execution speed.

## Hypothesis (frozen)
There exists a **pre-registered, learnable launch-time filter** under which
entering a pump.fun token near its creation has **positive expectancy** after the
hardened exit logic — whereas the copy feed does not. If no pre-registered cut is
net-positive out-of-sample, launch-sniping this market is also −EV → stop/pivot.

Null hypothesis (what we expect to have to disprove): "buy launches" is
catastrophically −EV (the vast majority of pump.fun launches rug/die within
minutes). The edge, if any, lives in a **filter**, not in blanket sniping.

## Data source (confirmed available — no new spend)
- **Helius** (already integrated: `mainnet.helius-rpc.com`, `api.helius.xyz`).
  Detect new pump.fun token creations via the pump.fun program
  (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) — new-mint / create events.
- Price/liquidity forward snapshots: DexScreener + Helius (already integrated).
- Risk features: RugCheck + on-chain holder/creator data (already integrated via
  `token-risk-data.ts`).
- **No paid feed (Geyser/Bitquery) needed for the shadow probe.** A faster stream
  is only justified later IF this probe shows an edge worth executing on.

## Method (parallel to LP-v1; reuses the hardened harness)
1. **Broad collect (no filter at capture):** record EVERY detected pump.fun launch
   into a `launch_sniper_shadow` table — mint, creation time, first-seen lag, and a
   frozen set of launch-time features (below). Fail-closed: if a feature can't be
   fetched, store null, never invent.
2. **Forward paper-sim (no SOL):** snapshot price at t0 (earliest detection) and
   forward timings; paper-sim the entry with the SAME hardened exit logic exported
   from `src/scripts/shadow-paper-sim.ts` (boundedExitAtThreshold, confirmedPrice,
   STOP/CIRCUIT/TRAIL/MAX_HOLD/RUG). No forking the exit model.
3. **Walk-forward evaluation:** split by time; fit the pre-registered feature cut on
   the train window only; measure net EV on the held-out window. Report per-cut
   mean PnL, win%, N, and net SOL-equivalent.

## Pre-registered launch-time features (frozen — the only inputs we may cut on)
S1 detection lag (creation→first-seen, seconds) · S2 initial liquidity (USD) ·
S3 creator/dev initial hold % · S4 # distinct buyers in first 60s ·
S5 buy/sell ratio first 60s · S6 mint/freeze authority renounced (bool) ·
S7 LP status (burned/locked %) · S8 name/symbol offensive/stablecoin filter (reuse).
No other inputs. No hardcoded wallet allowlists. Cuts are expressed as policy
thresholds (a `launch_sniper_policy` row), never source constants.

## Decision gate (frozen, pre-committed)
- **SNIPER EDGE CANDIDATE = YES** iff, on the held-out window with **N ≥ 100
  resolved-complete** in the cut: net EV > 0 AND it survives a second walk-forward
  fold AND the broad (unfiltered) population is, as expected, net-negative (proving
  the *filter* — not the market — is doing the work).
- Otherwise **NO / INSUFFICIENT** → launch-sniping is −EV on this market → stop or
  pivot. Do not relax the gate to manufacture a pass.
- A YES is a *candidate only*. It does NOT authorize live or measure_live. Live
  restart still requires the C1–C3 hardcoded→DB migration + operator sign-off.

## Safety (LOCKED)
Shadow-only. No real SOL. No live. No measure_live. No broadcast. No
`tracked_wallets`/`bot_state` mutation. No edits to `route.ts`/agents/jupiter/
executor. New table + collector + report only, mirroring the LP-v1 build. All
thresholds policy-driven; missing data → fail closed + report.

## Build plan (Code ⇄ Codex, COLLAB.md locks)
- M: `supabase/migrations/022_launch_sniper.sql` — `launch_sniper_shadow` +
  `launch_sniper_policy` (+ anon SELECT / service ALL RLS), operator-applied.
- Collector `src/scripts/sniper-collect.ts` — Helius pump.fun new-mint poll →
  features → forward snapshots → paper-sim (reuse exported helpers).
- Report `src/scripts/sniper-report.ts` — broad vs cut, walk-forward, frozen gate.
- launchd `com.pixiu.sniper-collect` via `shadow-run.sh` (new mode).
- Dashboard panel (Codex) once data accrues.
