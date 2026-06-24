# PixiuBot Backlog

Active work queue. Ordered by priority. Move to `docs/SPRINT*-RECAP.md`
when shipped, then delete from here.

---

## Daily Profit Recovery Roadmap (current)

**Project goal:** invest in meme coins, win consistently, make profit
daily, and protect capital.

### Verified facts (current — 2026-06-23)

- Historical strategy EV is NEGATIVE. 332-trade postmortem: total PnL
  −1.2473 SOL; L0 loss −1.1363 SOL; worst-10 wallets ≈ −0.7954 SOL.
- The only real win mechanism is `trailing_stop` (+0.418 SOL @ 65.6% in
  the postmortem). Drain/circuit/stop/timeout losses swamp it.
- **Wallet-based edge is DISPROVEN out-of-sample** — walk-forward split:
  the only train-profitable wallets (theo pump sad, daniww) went
  −0.043 net in the held-out window. Past wallet PnL does not predict
  future.
- DB wallet scorer VALIDATED (CSV + DB reproduce the postmortem exactly:
  0 promoted, 8 disabled, 19 probation, 10 unknown).
- `measure_live` is telemetry only. Live restart is blocked. Main wallet
  NEVER.
- Bot state: `mode='dry_run'`, `broadcast_tx=false`, `is_running=false`.
  measure_live_policy active = 0. tracked_wallets tier1=63 / active=751.

### Roadmap P0–P6 — COMPLETE as design + validation + shadow

| Stage | Status |
|---|---|
| P0 dry_run runtime row capture | CLOSED — blocked by entry rarity (0 organic entries cleared the 15 guards across 4 attended windows); dry_run path statically verified + broadcast-safe |
| P1 DB wallet scorer | VALIDATED (CSV + DB; migrations 017/018/019 applied, policy `tr_v1` seeded) |
| P2 shadow would-block reporting | VALIDATED (non-enforcing `logWalletScoringShadow`) |
| P3 wallet cohort | DESIGNED — count-based cohort proven HARMFUL (cohort lost 2.7× more than solo); use quality-weighted (LCB), not co-buyer count |
| P4 L0 entry-quality gate | DESIGNED — fail-closed composite (wallet+token+exec+guardrails), shadow-first |
| P5 token-risk + bundle/dev/top-holder | DESIGNED + BUILT as **TR-v1** (pre-registered, frozen) |
| P6 measure_live telemetry | DESIGNED — schema + fail-closed policy/gate ready; NOT enabled (no positive-edge candidate) |

### Forward shadow validation — LIVE (status 2026-06-24)

- TR-v1 harness built + scheduled (launchd) + dashboard panel live (anon
  RLS applied). **TR-v1: 4,087 decisions / 3,950 resolved.** Paper-sim
  loss model **hardened (N2)** — stop/circuit exits now fill at threshold
  + bounded slippage (was recording −50% via poll-gap), rug requires
  re-check before −100%.
- **TR-v1 verdict = EDGE NOT PROVEN (anti-edge on full data: would_enter
  ~−25% vs would_block ~−17%).** BUT this average is on the ~3,950
  PRE-N2 rows that carry the inflated −50% stops and can't be re-resolved
  (no past prices). The **clean verdict requires fresh data resolved
  under the hardened sim** — accruing now.
- **LP-v1 latency probe = LIVE (119 probes).** Tests whether entering at
  t0 beats +60/+180/+300s (i.e., is *speed* the edge). Needs **N≥100
  resolved-complete** + walk-forward before a verdict.
- **Standing finding:** wallet-based edge DISPROVEN out-of-sample;
  token-risk filtering reduces losses but does not cross zero. The only
  real win mechanism is `trailing_stop` (+84% mean in sim, +0.418 SOL in
  the postmortem). Daily profit needs a NEW positive-edge signal
  (speed/sniper), not more filtering — LP-v1 is testing exactly that.

### Backlog status (owners per COLLAB.md)

| ID | Task | Owner | Status |
|---|---|---|---|
| N1 | Walk-forward eval + shadow-report full-dataset pagination fix | Code | ✅ DONE (`99aba3b`) |
| N2 | Paper-sim loss-model hardening (realistic stop fill, rug re-check, fair-resolution) | Codex | ✅ DONE (`e8dcdfc`, verified) |
| N6 | Dashboard walk-forward + per-exit-reason panel | Codex | ✅ DONE (`8cba431`, verified) |
| LP-v1 | Latency edge probe (build + migration 021 + scheduler) | Codex+Code | ✅ BUILT & LIVE (`b4da414`, mig applied, launchd every 2m) |
| FA1 | **TR-v1 failure analysis** — why anti-edge (winners concentrate in the BLOCKED set; "safe-looking" tokens underperform); quantify on clean hardened-sim data | Code | 🔬 ACTIVE NEXT — partial finding logged; formalize as hardened data accrues |
| N5 | Decision gate: TR-v2 (stricter) vs "no recoverable edge" | Code+ChatGPT | ⏳ BLOCKED — needs FA1 + clean hardened-sim + LP-v1 data (days of accrual) |
| N3 | Repair local toolchain (`node_modules` stubs: tsc/eslint/next) | Codex | ⛔ TODO — local build/typecheck blocked; CF build is authoritative |
| N4 | Auto-trigger orchestrator (true no-human Code⇄Codex) | Code | ⛔ BLOCKED — no local `codex` CLI (`codex not found`); human one-paste baton is the mechanism |
| N7 | Cloud-droplet migration (24/7 harness, off the laptop) | Code+Codex | 💤 DEFERRED — operator chose Mac + keep-awake for now |

**Strategic truth:** wallet-quality + token-risk filtering *reduces*
losses but does not cross zero. Daily profit requires a genuinely new
positive-edge signal source (faster/different signal), not a tighter
filter on the current −EV feed. No live restart until a positive-edge
subset is proven out-of-sample.

### Hard blocks

- Live trading: NO. `measure_live` for profit: NO. Main wallet: NEVER.
- Wallet enforcement: blocked (shadow-only). `tracked_wallets.tier` /
  `tracked_wallets.active` mutation: blocked.
- **No capital injection.** **No position-size bump.**
- Hardcoded live path must migrate to DB policy (C1–C3) **before any restart**.
- No real SOL until a positive-edge subset is proven out-of-sample.

---

## Archived history

Sprint 9/10 phases + Limo Path roadmap moved to
[docs/BACKLOG-ARCHIVE.md](BACKLOG-ARCHIVE.md) (Producer cleanup 2026-06-23) —
historical, predates the negative-EV postmortem.

## Compliance backlog — LOCKED dynamic-build rules (added 2026-06-23)

Governing standard: `docs/ops/global-build-rules.md` (binding on Code + Codex).
Verified gap: the legacy LIVE entry path violates the no-hardcoding rule.

| ID | Task | Owner | Status | Note |
|---|---|---|---|---|
| C1 | Migrate `WALLET_BLACKLIST` (denylist) → DB source-of-truth (e.g. `wallet_eligibility`/`current_wallet_status`); route.ts guard #10a reads DB | Code+Codex | TODO | **pre-live-restart gate** |
| C2 | Migrate `ELITE_WALLET_TAGS`/`ELITE_BUY_SOL` (allowlist+sizing) → policy table; remove `if wallet === "theo pump sad"` pattern in `getBuySolForWalletTag` | Code+Codex | TODO | **pre-live-restart gate** |
| C3 | Migrate entry thresholds (`MAX_GAP_MINUTES`, `MIN_LIQUIDITY_USD`, `MIN_FDV_USD`, `MAX_ENTRY_PRICE`, `DUMP_PATTERN_MIN_SIGNALS`, cooldowns, `LIVE_BUY_SOL`, `DAILY_LOSS_LIMIT_SOL`) → `entry_policy`/`l0_gate_policy` rows | Code+Codex | TODO | **pre-live-restart gate** |

**Hard rule:** no live restart while the entry path is hardcoded. These are
dormant today (`is_running=false`), so not urgent — but they are a blocking gate
before any real-SOL trading, per the LOCKED build rules.
