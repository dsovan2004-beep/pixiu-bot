# Sprint 6 Recap — Apr 16–17 2026

## Summary

**Reconstructed retrospective.** Sprint 6 was the window between the
Sprint 5 D3 recap commit (`fc89b03`) and the Sprint 7 D3 consolidation
opener (`add1a4d`). No dedicated recap file was written at the time;
this document is the post-hoc record from git log + context in JOURNAL.

Theme: **parameter tuning + critical webhook bypass fixes**. The sprint
opened with alpha-capture experiments (trailing stop, looser rug storm)
and closed with the discovery + fix of the webhook `is_running` bypass
that had been silently causing real SOL losses. That discovery directly
motivated Sprint 7's full shared-guard consolidation.

## Headline metrics

| Metric | Value |
|---|---|
| Duration | Apr 16 ~15:00 UTC → Apr 17 ~22:00 UTC |
| Commits shipped | 9 |
| Critical bugs fixed | 2 (webhook bypass, daily-loss overstatement) |
| Loss days surfaced | Overnight Apr 16 −2 SOL on live wallet |

## Commits

| Commit | What |
|---|---|
| `bdf4bae` | **Trailing stop replaces grid L3 sell** — ride moonshots past the old +42.5% grid cap. Shipped after the `airdropper 140x miss` from Sprint 5 D3 |
| `255ea83` | Rug storm threshold loosened 3/5 → 4/5, name cooldown 30min |
| `0488eca` | **Reverted** rug storm 4/5 → 3/5 after overnight −2 SOL loss showed looser filter was catastrophic |
| `030fa63` | Raised `DAILY_LOSS_LIMIT_SOL` 2.0 → 3.0 as a temp workaround for the overstated daily-loss counter |
| `8bac7c5` | **Fixed daily-loss counter** to track REAL SOL lost (`Σ LIVE_BUY_SOL × pnl_pct/100`) instead of `count × size` overstatement. Verified ~3.55× overstatement on live data. Reverted the temp 3.0 back toward conservative range |
| `0ac8725` | Attempted webhook rug-storm check — **BROKE CF Edge build** because `entry-guards.ts` imported `supabase-server.ts` which pulled `path` (Node builtin). Webhook was down ~10min |
| `e888c5e` | **Emergency fix** — inlined rug-storm check in `webhook/route.ts` with edge-safe Supabase client. Unblocked CF deploy |
| `9e83741` | Idempotent-close on the normal path — completes the double-credit fix from Sprint 5 D2 (`status='closing' → status='closed'` gate on final UPDATE) |
| `8772d39` | **CRITICAL** — webhook must check `is_running` before inserting paper_trades. Discovery: The Bull −60.61%, 千鳥 −44.66%, dogwifbeanie −37.71% all opened while bot was STOPPED via dashboard. Added inline `webhookIsBotRunning()` as guard #1 |

## Pattern recognition (drove Sprint 7)

Three of the nine commits (`0ac8725`/`e888c5e`/`8772d39`) were
variations on the same theme: **webhook and swarm validator guards
had drifted out of sync, and webhook's Cloudflare Edge runtime made
naive code-sharing impossible.** Every attempt to "fix by copy-paste
from validator" either broke the edge build (0ac8725) or missed a
critical invariant (is_running bypass).

This directly motivated Sprint 7 D3's architectural decision:
consolidate ALL entry guards into the webhook path, delete the swarm
validator + price-scout, and accept edge-safe inline duplication
rather than fighting shared modules.

## Bugs found & fixed

### Webhook bypass of `is_running` (`8772d39`)

**Symptom:** dashboard showed STOPPED, but new `paper_trades` rows
kept appearing with `[LIVE]` tag — opening real-SOL positions that
the user had explicitly disabled. Three losing trades confirmed as
unauthorized: The Bull, 千鳥, dogwifbeanie.

**Root cause:** webhook's `evaluateAndEnter()` never checked
`bot_state.is_running`. Only the swarm-side executor did. So the
dashboard STOP button halted execution but not entry — webhook kept
filling `paper_trades`.

**Fix:** inline `webhookIsBotRunning()` as guard #1 of evaluation.

**Lesson:** every entry path must check `is_running`. This became
the Golden Rule in PLAYBOOK.md.

### Daily-loss counter overstated ~3.55× (`8bac7c5`)

**Symptom:** bot halted early on losing days even when real SOL loss
was well under the 2 SOL limit. Overnight Apr 16 halted after ~0.6
SOL actual loss.

**Root cause:** counter was `count × LIVE_BUY_SOL` — a −5% loss was
counted as a full 0.05 SOL loss instead of 0.0025 SOL.

**Fix:** recompute as `Σ LIVE_BUY_SOL × |pnl_pct|/100` across today's
losing LIVE trades.

**Lesson:** kill-switch counters must derive from the same numbers
used for actual P&L. Never proxy.

### Rug storm threshold tuning (reverted)

`255ea83` attempted to loosen the rug-storm filter from 3/5 to 4/5
to increase trade frequency. `0488eca` reverted it the next day
after overnight losses confirmed 3/5 was the correct threshold. A
learning: "fewer filters = more alpha" is often wrong when the
filter was load-bearing.

## Alpha work

### Trailing stop (`bdf4bae`)

Grid L3 (+100%) previously sold 25% at that level. Problem: airdropper
ran 140x after L3 trigger, and we'd already sold. Replaced L3 sell
with **trailing-stop mode**: peak tracks upward, exit when price drops
TRAILING_STOP_PCT (20%) from peak.

Later validated in Sprint 9 real-PnL analysis: trailing_stop had 70.6%
real WR / +84.6% avg / +0.72 SOL across 17 trades. One of two
strongly-positive exit reasons.

## Known follow-ups that carried into Sprint 7+

- Webhook/validator guard drift → full consolidation in Sprint 7 D3
- `entry-guards.ts` orphaned after validator delete → flagged for
  Sprint 8 cleanup
- Paper/real PnL divergence suspected but not quantified → surfaced in
  Sprint 9 as the 5.4→1.83 SOL gap
