# PixiuBot — Status Recap (for the Producer)

**As of 2026-06-24.** Canonical status snapshot. Source-of-truth detail lives in
`docs/BACKLOG.md` (backlog), `COLLAB.md` (Code⇄Codex protocol + handoff log), and
`docs/ops/*` (rules, runbook, pre-registered experiments). Update this file when
status materially changes.

## TL;DR
The current copy-trade strategy is **structurally −EV, now disproven THREE
independent ways**: wallet quality (walk-forward), token-risk filtering (TR-v1,
anti-edge both windows), and **latency/speed (LP-v1, verdict in)**. The only
"positive" numbers are bull-regime + 1%-tail + sub-cost artifacts that die
out-of-sample. No tradeable edge in this feed. No live trading; capital protected
(0.82 SOL, no real SOL ever used).

## Bankroll / historical (verified)
- Wallet **0.82 SOL (~$57)**. Trade PnL **−1.2473 SOL / 332 trades / 23.5% WR**
  (−9.6% ROI). L0 entries drove −1.1363 of the loss.
- Only real win mechanism: **`trailing_stop`** (+0.418 SOL @ 65.6% in the
  postmortem; +84% mean in sim).

## Key findings (out-of-sample, evidence-based)
1. **Wallet-based edge: DISPROVEN.** Walk-forward — the only train-profitable
   wallets (theo, daniww) went **−0.043 net** in the held-out window. Past wallet
   PnL does not predict future.
2. **Token-risk filtering (TR-v1): EDGE NOT PROVEN.** Pre-registered, frozen,
   shadow-tested over **4,087 decisions / 3,950 resolved**. Net-negative; on the
   full set mildly *anti*-edge. Filtering reduces losses but never crosses zero.
3. **Measurement caveat (fixed):** the paper-sim overstated losses (−50% stops vs
   a −10% trigger — a poll-gap artifact). **N2 hardened it** (realistic stop
   fills, rug re-checks). Clean verdict now needs fresh data under the hardened
   sim — accruing.

## Live experiments (shadow-only, no SOL)
- **TR-v1 harness:** 4,087 decisions; launchd-scheduled; dashboard panel live.
- **LP-v1 latency probe — VERDICT IN (N=1,918 resolved-complete): NO EDGE.**
  Speed is *anti*-edge — chasing at t0 is the worst entry (mean −1.0%, median
  −17.5%); delayed entries look better only as a **bull-regime artifact** (W1
  +6.97 / W2 −0.87 at +300s), are **100% tail-driven** (top-1% mean +450%,
  ex-top-1% −1.67%), and **die at 3% cost**. Latency is not our problem.

## Backlog status
| ID | Item | Status |
|---|---|---|
| N1 | Walk-forward eval + report pagination fix | ✅ DONE |
| N2 | Paper-sim loss-model hardening | ✅ DONE (verified) |
| N6 | Dashboard walk-forward + exit-reason panel | ✅ DONE (verified) |
| LP-v1 | Latency edge probe (build + migration 021 + scheduler) | ✅ BUILT & LIVE |
| N5 | Decision gate: TR-v2 vs "no recoverable edge" | ⏳ BLOCKED — needs clean accrual (days) |
| N3 | Repair local toolchain (tsc/eslint/next stubs) | ⛔ TODO (CF build authoritative meanwhile) |
| N4 | True no-human Code⇄Codex orchestrator | ⛔ BLOCKED — no local `codex` CLI; one-paste baton is the mechanism |
| N7 | Cloud-droplet 24/7 migration | 💤 DEFERRED (operator chose Mac + keep-awake) |
| C1–C3 | Migrate hardcoded live path (allowlist/denylist/thresholds) → DB policy | ⛔ TODO — **hard pre-live-restart gate** |

## Infrastructure / process delivered
- **Code⇄Codex collaboration working** via `COLLAB.md` (lock board + handoff
  baton) — dashboard, sim hardening, and LP-v1 built with **zero collisions**.
- **LOCKED global build rules adopted** (`docs/ops/global-build-rules.md`):
  dynamic / policy-driven / fail-closed / evidence-based. Legacy live path flagged
  non-compliant (→ C1–C3).
- Migrations 016–021 applied; shadow tables anon-readable; 5 launchd agents +
  keep-awake running.

## Safety posture (LOCKED, verified)
`is_running=false`, `mode=dry_run`, `broadcast_tx=false`, `measure_live` active=0,
`tracked_wallets` 63/751 unchanged. **No real SOL used at any point.** No live
restart until: (a) a positive-edge subset is proven out-of-sample, AND (b) the
hardcoded live path is migrated to DB policy (C1–C3).

## Decisions for the Producer
1. **Speed-edge R&D?** LP-v1 will say if latency is the killer. If yes, pursuing
   it means **Helius Geyser (~$100–300/mo)** + a real build — worth it or not?
2. **Accept the −EV conclusion?** If LP-v1 also shows no edge, the disciplined
   call is *no live restart* on this signal source — pivot (pump.fun sniper) or stop.
3. **Bottleneck = uptime + time:** verdicts need ~days of continuous collection on
   the Mac (kept awake). Cloud migration (N7) is the durable fix if wanted.

**Next checkpoint:** in a few days, read the LP-v1 + hardened-TR-v1 verdicts → the
fork on whether a real edge exists.
