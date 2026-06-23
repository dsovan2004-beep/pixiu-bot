# Pre-Registered Latency Edge Probe — LP-v1

**Status: PRE-REGISTERED (frozen) — 2026-06-23.** Fixed before any LP data is
evaluated, to prevent overfitting (same discipline as TR-v1; we already learned
that capped/biased reads lie — see the TR-v1 row-cap artifact).

## The question
TR-v1 proved the copy-trade strategy is −EV *at our current speed* (we enter
~30s after the smart wallet, buying the top). **LP-v1 answers one thing: is
LATENCY the cause?** i.e., if we entered *earlier*, would the same signals turn
**+EV** — justifying a faster feed (Helius Geyser) — or do they lose **at any
speed** (→ copy-trading is hopeless; pivot to a sniper or stop)?

Scope: **shadow / paper-sim only. No SOL, no broadcast, no live, no
measure_live, no eligibility/`tracked_wallets`/`bot_state` mutation.** Reuses the
TR-v1 harness pattern.

## Method (no money)
For each fresh BUY signal (broad `coin_signals` population, same as the TR-v1
collector):
1. Snapshot DexScreener price at **first-sight (t0)** and at **+60s, +180s, +300s**
   — the post-detection price *trajectory*.
2. Paper-sim a position entered at **each** of those four timings (t0, +60s,
   +180s, +300s), forward, using the **same exit logic** as `shadow-paper-sim`
   (stop −10%, circuit −15%, trailing armed +10% / give-back 25%, timeout 120m,
   N2-hardened rug handling). Record `sim_pnl_pct` per entry-timing.
3. Resolve only after a fair max-hold window (avoid the resolution-time bias N2
   is fixing).

## Frozen parameters (LP-v1)
- Entry timings probed: `{t0, +60s, +180s, +300s}`.
- Exit logic + max-hold: identical to the (N2-hardened) `shadow-paper-sim`.
- Population: broad (all BUY signals), with a `guard-passing-only` view tagged
  alongside (the 15-webhook-guard subset).
- Min sample before any claim: **N ≥ 100** resolved signals; walk-forward across
  ≥2 time windows.

## What we record (per signal)
`coin, signal_time, price_t0, price_60, price_180, price_300,
sim_pnl_t0, sim_pnl_60, sim_pnl_180, sim_pnl_300, exit_reason_*, guard_passing(bool),
resolved_at`. No outcome is ever fed back into an entry decision.

## Decision tree (the whole point)
- **`sim_pnl_t0` is net-POSITIVE and materially > later timings** → **latency is
  the edge.** Earlier entry wins → pursue Speed (Helius Geyser, faster
  execution). *This is the green light to invest in a faster feed.*
- **`sim_pnl_t0` is still net-NEGATIVE** → copy-trading these wallets loses **at
  any speed** → speed won't save it → pivot to the **pump.fun launch sniper**
  hypothesis (LP-v2) or stop.
- **All timings ≈ equal and negative** → latency isn't even the issue; the
  wallets are simply −EV → stop copy-trading.

## Success / failure
SUCCESS (speed edge exists): `sim_pnl_t0` net-positive with margin, > the +180s/
+300s timings, holding across walk-forward windows, N≥100. Anything else = no
speed edge; follow the decision tree.

## Hard rules
- Pre-registered/frozen: any change is **LP-v2**, registered *before* its data.
- No real SOL at any point in LP-v1. Even a positive result only justifies the
  *next* shadow phase (faster-feed validation), then measure_live, then — far
  later, if proven — tiny live capital. No shortcuts to size-up.
