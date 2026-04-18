# PixiuBot Sprint Log

Top-level index of sprints. Per-sprint detail lives in
`docs/SPRINT*-RECAP.md`. Day-to-day running log is
`docs/JOURNAL.md`. Active backlog is `docs/BACKLOG.md`.

---

## Current sprint

**Sprint 8 — opened Apr 17 2026, in progress.** Reliability +
cleanup + cloud migration. **Trading is paused until the P0 cluster
ships.**

### Pre-trading gate (all must be done before the next live session)

1. **P0a — Jupiter 429 retry backoff** shipped + CF green.
2. **P0b — Idempotent-close race fix** (partial→final credit path)
   shipped + CF green.
3. **P0c — Bankroll reconcile** run against real SOL. Must come
   AFTER P0a + P0b deploy, otherwise it re-drifts on the next trade.
4. **P2a — Dashboard "Total Trades" relabel** shipped. (Carried
   over from Apr 17 — UX bug that caused the false "dashboard
   broken" alert.)

Only when all four are green does `is_running` flip back on.

### Status

Scoped, no code shipped yet. Backlog priorities set after the
Apr 17 22:00 UTC session surfaced two P0 issues:
- Jupiter 429 cascade (71 `status=failed` buys today)
- Bankroll double-credit on Retail Coin close (+$21.72
  phantom + ≈$145 unbooked mark-to-zero = ≈$165 drift)

### Active backlog

`docs/BACKLOG.md`. Full priority order:
- **P0a/P0b/P0c** — pre-trading gate (above)
- **P1** — commit 6 dead-code cleanup pass (includes `DATA_MODEL.md`
  schema correction)
- **P2a** — dashboard "Total Trades" relabel *(gate item above;
  listed here for completeness)*
- **P2b** — Mac → DigitalOcean swarm migration
- **P3** — position size 0.05 → 0.10 SOL bump (hard-gated)
- **P3 cluster** — startup `bot_state` retry + log cleanup
- **P4** — $1K capital injection (gated after P3)

### Gates unlocked next

Position size 0.05 → 0.10 SOL (P3) pending 48h clean + WR > 55%
on 20+ trades + buy-land > 90%. The P0a Jupiter 429 fix directly
enables the buy-land metric; P0b prevents accounting drift that
would otherwise corrupt the WR measurement.

---

## Sprint history

| Sprint | Dates | Headline | Recap |
|---|---|---|---|
| 1–2 | early Apr 2026 | Webhook + trader monolith | *(no dedicated recap)* |
| 3 | mid Apr 2026 | 6-agent swarm shipped — 131 trades, 56.5% WR | *(no dedicated recap)* |
| 4 | Apr 14 2026 | Jupiter live swaps, dashboard toggle, safety audit | `docs/SPRINT4-COMPLETE.md` |
| 5 D1 | Apr 15 2026 | First live trades — 4/5 wins, +0.0224 SOL | `docs/SPRINT5-DAY1-RECAP.md` |
| 5 D2 | Apr 16 2026 | Double-credit race fixed, 8 stuck bags recovered | `docs/SPRINT5-DAY2-RECAP.md` |
| 5 D3 | Apr 17 2026 | Phantom-loop + 6024 bail + Token-2022 filter + pump.fun rescue | `docs/SPRINT5-DAY3-RECAP.md` |
| 5 LIVE overview | Apr 15 2026 | Live trading launch summary | `docs/SPRINT5-LIVE.md` |
| 6 | Apr 16–17 2026 | **gap — docs missing, reconstruct from git log** | *(see note below)* |
| 7 D3 | Apr 17 2026 | **Shared-guard consolidation — dual entry path removed** ✅ | `docs/SPRINT7-DAY3-RECAP.md` |
| 8 | Apr 18 2026 → | (in progress) | TBD |

### Sprint 6 reconstruction note

No `docs/SPRINT6-*.md` was written at the time. From `git log`, the
Sprint 6 window (between the Sprint 5 D3 recap commit `fc89b03` and
the Sprint 7 D3 consolidation starting `add1a4d`) contained:

- `bdf4bae` — trailing stop replaces grid L3 sell
- `255ea83` — rug storm threshold 3/5 → 4/5 + name cooldown 30min
- `0488eca` — revert rug storm 4/5 → 3/5 after overnight 2 SOL loss
- `030fa63` — raise `DAILY_LOSS_LIMIT_SOL` 2.0 → 3.0 (temp)
- `8bac7c5` — daily loss counter now tracks real SOL, not count × size
- `0ac8725` — (attempted) webhook rug-storm check — broke CF edge build
- `e888c5e` — (urgent) inline rug-storm check in webhook to fix edge
- `9e83741` — idempotent close on normal path (double-credit fix)
- `8772d39` — **critical:** webhook must check `is_running` before
  inserting `trades`

Pattern: parameter tuning + critical webhook bypass fixes. The
`is_running` bypass fix (`8772d39`) was the trigger for Sprint 7 D3 —
once we saw webhook was bypassing `bot_state`, we decided to
consolidate guards properly rather than keep patching one-by-one.

**TODO for Sprint 8:** consider whether to write a retrospective
`docs/SPRINT6-RECAP.md` reconstructing these commits, or just let
this index entry stand as the record.

---

## Conventions

### How a sprint gets scoped

Sprints are not time-boxed on a fixed calendar. A sprint opens when
a thematic body of work starts (a feature, a migration, a cleanup
pass) and closes when that theme is shipped + documented.

Typical length: 1–3 days given our current solo-operator pace.

### How a sprint gets closed

1. Write `docs/SPRINT<N>-<D>-RECAP.md` with:
   - Summary paragraph
   - Headline metrics table
   - Commits shipped (SHA + one-line each)
   - Architecture / behavioral changes
   - Known follow-ups deferred to next sprint
   - Verification notes (CF build, local restart, grep checks)
2. Append a newest-first entry to `docs/JOURNAL.md` with commit list
   and current-state snapshot.
3. Update this file (`SPRINT.md`) — add the row to Sprint history,
   update the "Current sprint" block.
4. Move newly-surfaced follow-ups into `docs/BACKLOG.md`.

### Where things live

- `docs/SPRINT*-RECAP.md` — per-sprint retrospectives (archived)
- `docs/JOURNAL.md` — append-only running log (newest first)
- `docs/BACKLOG.md` — active Sprint N+1 queue
- `SPRINT.md` (this file) — top-level index
- `ROADMAP.md` — longer-horizon gates + timeline
- `PLAYBOOK.md` — operational runbook (stable, not sprint-scoped)
- `DATA_MODEL.md` — schema + write-path ownership (stable)
- `AGENTS.md` — agent-directed project rules (stable)
