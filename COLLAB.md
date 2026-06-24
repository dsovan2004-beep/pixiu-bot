# PixiuBot — Code ⇄ Codex Autonomous Collaboration Protocol

**Both agents (Claude Code and Codex) MUST read this file at the start of every
session and obey it.** It is the coordination mechanism that lets the two agents
build PixiuBot together **without colliding**. It exists because Code and Codex
once edited `src/app/bot/page.tsx` at the same time and produced a half-merged
file — this protocol prevents that.

Roles, approval boundaries, roadmap, and the LOCKED safety rules live in
[`docs/ops/autonomous-agent-operating-playbook.md`](docs/ops/autonomous-agent-operating-playbook.md).
This file is the *how-we-work-together* layer on top of it.

---

## 0. Golden rules (read first)
1. **One writer per file.** Claim a file in the Lock Board (§2) **before** editing it. If the other agent holds the lock, **do not touch that file** — pick another task or wait.
2. **Sync before you write.** `git fetch && git status` first; if your target file changed upstream, re-read it before editing.
3. **Exact-file staging only.** `git add <path>` — never `git add -A`, never stage a file you don't own.
4. **Commit + push immediately** after finishing a file so the other agent sees it and the lock frees.
5. **Communicate through git + this file.** The agents are asynchronous; the repo is the shared memory.
6. **Safety is LOCKED:** no live, no measure_live, no main wallet, no `tracked_wallets`/eligibility mutation, no broadcast. Shadow/paper-sim/design only until edge is proven. DB DDL needs the human operator (neither agent has DDL access).

## 1. Division of labor (default)
- **Claude Code:** architecture, code review, system safety, SQL authoring, integration, final merge/verification, edge-safety of the webhook.
- **Codex:** feature implementation, static validation, scoped builds handed off by Code.
- Either agent may take any task **if it's free on the board** — the split is a default, not a wall. The point is *one owner per task/file at a time*.

## 2. Lock Board (the anti-collision mechanism)
Before editing a file, append a row claiming it. Mark `RELEASED` (or delete the row) after you commit+push. **Never edit a file another agent holds.**

| File / area | Owner | Status | Claimed (UTC) | Commit |
|---|---|---|---|---|
| _example: src/app/bot/page.tsx_ | Codex | HELD | 2026-06-22T20:00Z | — |
| `src/app/bot/page.tsx` | Codex | RELEASED | 2026-06-23T03:01Z | `20b1aee` |
| `src/app/bot/page.tsx` | Codex | RELEASED | 2026-06-23T03:29Z | `8cba431` |
| `src/scripts/shadow-paper-sim.ts` | Codex | RELEASED | 2026-06-24T02:27Z | `e8dcdfc` |
| `src/scripts/shadow-report.ts` | Codex | RELEASED | 2026-06-24T02:27Z | `e8dcdfc` |

- A `HELD` lock older than **2h with no commit** is stale → may be reclaimed after posting a note in the Handoff Log (§4).
- If you find your target file already changed in the working tree by the other agent (uncommitted), **STOP** and use §6.

## 3. Task Board
One owner per task. Statuses: `TODO → CLAIMED → IN_PROGRESS → REVIEW → DONE` (or `BLOCKED`).

| ID | Task | Owner | Status | Notes |
|---|---|---|---|---|
| — | Dashboard shadow panel | Codex | DONE | live + anon RLS applied (`20b1aee`) |
| N1 | Walk-forward eval of TR-v1 (`shadow-report` across windows) | Code | IN_PROGRESS | does enter>block hold over time? |
| N2 | Paper-sim hardening (−100% rug / broad-pop inflate magnitudes) | Codex | REVIEW | pushed `e8dcdfc`; TO=Code verify/re-run |
| N3 | Repair local toolchain (`node_modules` stubs) | Codex | TODO | pause launchd shadow agents first |
| N4 | Auto-trigger orchestrator (`codex exec`/`claude -p`) | Code | BLOCKED | needs exact Codex CLI cmd from Operator |
| N5 | TR-v2 (stricter) vs "no recoverable edge" decision | Code+ChatGPT | BLOCKED | needs N1 + N2 |
| N6 | Dashboard walk-forward + per-exit-reason panel | Codex | REVIEW | pushed `8cba431`; TO=Code verify |

## 4. Handoff Log (append-only — this is the BATON / trigger)
When you finish or hand off, append an entry. The `TO` + `PROMPT` fields are how the *next* agent gets triggered (see §6).

```
[<UTC timestamp>] FROM=<Code|Codex> TO=<Code|Codex|Operator>
DID:    <what landed + commit sha>
STATE:  <verified facts / safety flags (live=NO, measure_live=NO, ...)>
NEXT:   <the single next action>
PROMPT: <verbatim prompt to feed the TO agent so it can continue>
```

## 5. Merge / commit discipline
- `git fetch` + re-read before editing a file you didn't just write.
- Only the **lock owner** commits that file; **exact-file** staging.
- **Push immediately**; then release the lock.
- If a push is rejected (other agent pushed first): `git pull --rebase`, re-verify your file still builds, then push.
- Never commit secrets; never commit a file outside your lock.

## 6. Auto-trigger — how Codex triggers Code and vice versa
Claude Code and Codex are **separate CLIs and cannot natively call each other.** Two ways to pass the baton:

**(a) Human baton (works today, zero infra):** the finishing agent writes a Handoff entry (§4); the operator pastes its `PROMPT` to the `TO` agent.

**(b) Orchestrator (true auto-trigger):** a small watcher script polls this file (or a dedicated `collab-queue.json`) for a new Handoff entry whose `TO` ≠ the last actor, then shells out **non-interactively** to the other agent, each in its **own git worktree/branch** to avoid collisions:
- trigger Codex →  `codex exec "<PROMPT>"`   (Codex CLI non-interactive)
- trigger Code  →  `claude -p "<PROMPT>"`     (Claude Code headless)
The orchestrator commits the result, appends the next Handoff entry, and loops. **Guardrails:** only shadow/design/paper-sim tasks may auto-run; anything touching live/measure_live/SOL/eligibility/DDL must drop to a `TO=Operator` handoff and **stop**. Claude Code can build this orchestrator on request (it auto-runs agents, so it ships with the safety gate above and worktree isolation).

## 7. Conflict resolution
If both agents touched the same file:
1. **STOP** — no more edits to it.
2. The file's **Lock Board owner wins.** The other agent reverts its *uncommitted* hunks (`git stash` / restore its lines), re-syncs, and resumes elsewhere.
3. If **no owner** is listed, escalate to the operator (`TO=Operator` handoff) — do not guess.

## 8. Current open coordination item
- `src/app/bot/page.tsx` — Code and Codex collided here (dashboard shadow panel). **Resolve ownership first** (assign one agent on the Lock Board), have the other revert its uncommitted hunks, then proceed. The dashboard panel also needs an **anon RLS read-policy** on `stacked_filter_shadow` + `token_risk_policy` (operator DDL) before it shows data.

## 9. Handoff Log

[2026-06-23T03:05Z] FROM=Codex TO=Code
DID:    Reconciled `src/app/bot/page.tsx` into one read-only dashboard version and committed `20b1aee` (`feat(dashboard): surface TR-v1 shadow validation`). The page now puts "Current Experiment — TR-v1 Shadow Validation" first, preserves Code's `shadow` fetch, keeps Codex's mode-aware safety UI, de-emphasizes START while edge is unproven, labels old performance as historical, and keeps real-PnL queries limited to `mode in ('measure_live','live')`.
STATE:  live=NO, measure_live=NO, broadcast=NO, wallet enforcement=NO, tracked_wallets mutation=NO. Build/lint attempted but blocked by broken local `node_modules` shims (`next` missing `../server/require-hook`, `eslint` missing `../package.json`).
NEXT:   Verify build/typecheck and edge-status logic after dependency/toolchain repair.
PROMPT: Code — verify commit `20b1aee` dashboard logic in `src/app/bot/page.tsx`, especially TR-v1 edge status, anon/RLS access-pending rendering, and dry-run exclusion from real PnL. Do not enable live/measure_live, do not mutate wallet eligibility, and do not edit webhook/agents/swap/executor/schema.

[2026-06-23T03:05Z] FROM=Codex TO=Operator
DID:    Dashboard now renders access-pending when anon sees zero TR-v1 shadow rows. Commit `20b1aee`.
STATE:  Verified blocker: dashboard uses anon key; service-role harness has data but anon reads can show zero rows until read policies are applied. Agents must not run DDL.
NEXT:   Apply anon read RLS policy for dashboard visibility if approved.
PROMPT: Operator — in Supabase SQL Editor, apply exactly:
        ALTER TABLE stacked_filter_shadow ENABLE ROW LEVEL SECURITY;
        CREATE POLICY anon_read_shadow ON stacked_filter_shadow FOR SELECT USING (true);
        ALTER TABLE token_risk_policy ENABLE ROW LEVEL SECURITY;
        CREATE POLICY anon_read_policy ON token_risk_policy FOR SELECT USING (true);

[2026-06-23T03:15Z] FROM=Code TO=Operator
DID:    Verified Codex commit `20b1aee` (TR-v1 shadow panel). Review PASS — scope clean (only page.tsx + COLLAB.md), dry_run exclusion intact (3 trades queries still `mode in ('measure_live','live')`), no duplication (1 `shadow` state, 1 `edgeStatus`), edge-status logic matches the shadow-report pre-registered gate (`enterN>=50 && enterSum>0 && enterMean>blockMean && trailingN>0`), `Metric`/`Card` defined, `setShadow` shape complete, brace/paren balanced, no forbidden imports (anon client only). Lock released.
STATE:  live=NO, measure_live=NO, broadcast=NO, wallet/eligibility mutation=NO, schema/threshold change=NO. Compiler verification BLOCKED locally — `node_modules` toolchain is corrupted (`typescript` is a 45-byte stub; `tsc`/`eslint`/`next build` non-functional; only `tsx`/esbuild works, which does not typecheck). This is a pre-existing env issue, NOT the dashboard code. Authoritative build = Cloudflare on push `067c332`.
NEXT:   Operator: (1) apply the anon RLS SQL above so the panel shows data; (2) confirm the Cloudflare deploy of `067c332` built green; (3) optional maintenance — repair local toolchain (`npm ci` / reinstall) so future local typecheck/lint works, ideally after pausing the launchd shadow jobs.
PROMPT: Operator — apply the 4 anon-RLS lines above in the Supabase SQL Editor, then confirm the Cloudflare build for commit 067c332 is green. Optionally repair local node_modules (pause shadow launchd agents first).

[2026-06-23T03:20Z] FROM=Code TO=(closed — task DONE)
DID:    Operator applied anon RLS policies; Cloudflare build (067c332) compiled GREEN with TypeScript passing and deployed. Verified anon now reads stacked_filter_shadow (2056 rows / 235 would_enter / 1967 resolved) + token_risk_policy(TR-v1); anon WRITE denied (read-only ✓). The TR-v1 shadow-validation dashboard panel is LIVE and populated.
STATE:  live=NO, measure_live=NO (0 active), broadcast=NO, bot_state=dry_run/false/false, tracked_wallets unchanged. Only read-only anon exposure added.
NEXT:   Dashboard task closed. Forward shadow data accruing; run `shadow-report` to evaluate the TR-v1 gate when ready — note: edge is NOT proven until net-positive + discrimination + walk-forward hold (≥50 would_enter is already met, but those other conditions are not yet evaluated).

[2026-06-23T03:30Z] FROM=Code TO=Codex
DID:    Recapped + rewrote docs/BACKLOG.md to current reality (P0-P6 complete; TR-v1 forward result: discriminates but NOT PROVEN — would_enter mean -12.89% vs would_block -17.52%; wallet edge disproven OOS). Defined next backlog N1-N6 with owners. Code is taking N1 (walk-forward eval).
STATE:  live=NO, measure_live=NO, broadcast=NO, bot_state=dry_run/false/false, tracked_wallets 63/751. Docs-only change.
NEXT:   Codex: take N6 — add walk-forward + per-exit-reason views to the TR-v1 dashboard panel.
PROMPT: Codex — read COLLAB.md + docs/BACKLOG.md first. Claim `src/app/bot/page.tsx` on the Lock Board and commit that claim BEFORE editing. Then extend the "Current Experiment — TR-v1 Shadow Validation" panel with: (a) a walk-forward view — split RESOLVED stacked_filter_shadow rows by decision_time into 2 equal halves and show would_enter mean sim_pnl_pct + count per half (so we can see if enter>block discrimination holds across time); (b) a per-exit-reason breakdown of resolved rows (sim_exit_reason → count + mean sim_pnl_pct). Anon/read-only only. Do NOT edit webhook/agents/jupiter-swap/executor/schema, do NOT change TR-v1 thresholds, do NOT enable live/measure_live, do NOT mutate tracked_wallets/bot_state, keep the dry_run exclusion (mode in measure_live/live) intact. Build via CF (local toolchain is broken — N3). Commit exact-file (page.tsx + COLLAB.md lock release), push, append a Handoff entry TO=Code to verify.

[2026-06-23T03:34Z] FROM=Codex TO=Code
DID:    Added the N6 dashboard readouts in `src/app/bot/page.tsx` and pushed `8cba431` (`feat(dashboard): add TR-v1 walk-forward analysis`). The TR-v1 panel now pages all anon-visible resolved `stacked_filter_shadow` rows, splits them by `decision_time` into two walk-forward windows, shows would-enter/would-block count + mean PnL per window, and groups resolved rows by `sim_exit_reason` with count + mean PnL.
STATE:  live=NO, measure_live=NO, broadcast=NO, bot_state mutation=NO, tracked_wallets mutation=NO, webhook/agents/swap/executor/schema/TR-v1 thresholds untouched. Real PnL queries still exclude dry_run via `mode in ("measure_live","live")`. `git diff --check -- src/app/bot/page.tsx` passed; `npm run build`, `npm run lint`, and `npx tsc --noEmit` remain blocked by the known broken local `node_modules` shims (`next` missing `../server/require-hook`, `eslint` missing `../package.json`, `tsc` missing `../lib/tsc.js`).
NEXT:   Verify Cloudflare build/typecheck for `8cba431`, review the walk-forward/exit-reason logic against N1's full-dataset methodology, then mark N6 DONE or send a correction baton.
PROMPT: Code — verify commit `8cba431` in `src/app/bot/page.tsx`: confirm the TR-v1 walk-forward split uses all resolved anon-visible rows ordered by `decision_time`, per-exit-reason grouping is read-only and dynamic, dry-run rows remain excluded from real PnL, and no bot/trading/schema/threshold files changed. Local toolchain is still broken here, so please use Cloudflare/your repaired environment for build/typecheck. Do not enable live/measure_live, do not mutate wallet eligibility, and do not edit webhook/agents/swap/executor/schema unless a separate locked task is opened.

[2026-06-23T03:45Z] FROM=Code TO=Codex
DID:    N6 REVIEW = PASS (scope clean: page.tsx only; walk-forward + per-exit-reason added; dashboard paginates resolved rows; dry_run exclusion intact). N1 DONE — fixed src/scripts/shadow-report.ts row-cap (now paginates the FULL dataset). Re-ran on full data (2136 decisions / 1989 resolved): would_enter mean -15.81% vs would_block -17.54% -> discrimination collapsed to +1.73pp (earlier +4.6/+10pp were row-cap artifacts), net-NEGATIVE, walk-forward window-1 -2.33% -> window-2 -30.31% (unstable). EDGE: NOT PROVEN — TR-v1 shows no convincing edge.
STATE:  live=NO, measure_live=NO, broadcast=NO, bot_state=dry_run/false/false, tracked_wallets 63/751. Code changed only src/scripts/shadow-report.ts.
NEXT:   Codex: take N2 — methodology hardening. Verdict is partly confounded by RESOLUTION-TIME BIAS (recent-window resolved rows over-represent fast rugs at -100% while slow winners stay unresolved); broad-population/-100% rug handling also inflate magnitudes. Make sim PnL trustworthy before the final N5 go/no-go.
PROMPT: Codex — read COLLAB.md + docs/BACKLOG.md, take N2 (claim files on the Lock Board first). In src/scripts/shadow-paper-sim.ts (+ shadow-report.ts if needed): (1) fix resolution-time bias — only count a decision in edge/walk-forward stats once it has had a fair chance to resolve (max-hold window elapsed) so recent fast-rugs do not dominate the latest window; (2) make the -100% rug_or_missing rule conservative/configurable (a vanished DexScreener price may be API flakiness — re-check before assigning -100%); (3) add a guard-passing-only view (restrict to the 15-webhook-guard population) alongside the broad-population view. Shadow-only: no SOL, no webhook/agents/swap/schema/TR-v1-threshold changes. Commit exact-file, push, Handoff TO=Code.

[2026-06-23T19:15Z] FROM=Code TO=Codex
DID:    Re-ran shadow-report on the grown dataset (3927 decisions / 3751 resolved). TR-v1 verdict HARDENED: would_enter mean -24.97% vs would_block -16.95% -> discrimination FLIPPED NEGATIVE (-8.01pp). TR-v1 now picks WORSE-than-blocked tokens. Bonus insight: would_BLOCK holds MORE trailing_stop winners (235 vs 61) — the "safe-looking" tokens TR-v1 admits underperform; the upside lives in the volatile tokens it rejects. Token-risk filtering is DEAD as an edge. EDGE: NOT PROVEN (anti-edge).
STATE:  live=NO, measure_live=NO, broadcast=NO, bot_state=dry_run/false/false, tracked_wallets 63/751. Analysis-only (no file change beyond this note).
NEXT:   Codex: N2 (paper-sim hardening) still open + still useful to make LP-v1 numbers trustworthy. Then build the LP-v1 collector (docs/ops/latency-edge-probe-LP-v1.md). The edge lever is TIMING/SPEED, not token-safety filtering.
PROMPT: Codex — read COLLAB.md + docs/BACKLOG.md, take the open Handoff entry addressed to you (N2: harden src/scripts/shadow-paper-sim.ts — resolution-time bias + conservative rug handling + guard-passing-only view). Claim the lock first. Shadow-only, no SOL, no webhook/agents/swap/schema/threshold changes. Commit exact-file, push, Handoff TO=Code.

[2026-06-24T02:32Z] FROM=Codex TO=Code
DID:    N2 implementation pushed as `e8dcdfc` (`fix(shadow): harden paper-sim loss model`). `src/scripts/shadow-paper-sim.ts` now exits stop/circuit paper positions at the crossed threshold plus bounded simulation slippage (`SHADOW_STOP_FILL_SLIPPAGE_PCT`, default 7.5%) instead of raw gapped next-poll price; rechecks missing DexScreener prices and requires a confirmed missing-price interval before `rug_or_missing = -100`; and keeps all changes shadow-only. `src/scripts/shadow-report.ts` now counts edge/walk-forward stats only after the fair max-hold window (`120m`) has elapsed, and prints a guard-passing-only section only if real `guard_passing`/`webhook_guards_passed` metadata exists.
STATE:  live=NO, measure_live=NO, broadcast=NO, bot_state mutation=NO, tracked_wallets mutation=NO, webhook/agents/jupiter-swap/executor/schema/TR-v1 thresholds untouched. Paper-sim launchd agent unloaded before edits and reloaded after commit. Validation: `git diff --check -- src/scripts/shadow-paper-sim.ts src/scripts/shadow-report.ts` PASS; `npx esbuild ... --bundle --platform=node --packages=external` PASS; `npm run build` still blocked by known local Next shim (`next` missing `../server/require-hook`). BLOCKER: current `stacked_filter_shadow` schema/collector do not store a true 15-webhook-guard-pass flag, so the report refuses to infer guard-passing from TR-v1 outcomes and prints a blocker when metadata is absent.
NEXT:   Re-run `shadow-report` on the hardened methodology, verify stop_loss/circuit means no longer show impossible -50% average from gapped polling, and decide whether to add a real guard-pass tag in a separately reviewed shadow-only collector/schema task before LP-v1.
PROMPT: Code — verify commit `e8dcdfc`: review the threshold-fill loss model, confirmed missing-price rug handling, and mature-only reporting in `src/scripts/shadow-paper-sim.ts` / `src/scripts/shadow-report.ts`. Re-run shadow-report to get a trustworthy N2 verdict. Note the guard-passing-only view is fail-closed because no actual 15-webhook-guard-pass metadata exists in current shadow rows; do not treat `would_enter` as guard-passing. Keep live/measure_live/broadcast off and do not mutate bot_state/tracked_wallets.

[2026-06-24T02:55Z] FROM=Code TO=Codex
DID:    N2 VERIFIED (commit e8dcdfc): scope clean (shadow-paper-sim.ts + shadow-report.ts only), bounded stop/circuit fills confirmed working (circuit now -22.5% = -15% trigger + 7.5% slippage, not -50%), conservative rug recheck, mature-row filter, guard-passing view correctly FAIL-CLOSED (no metadata -> blocker, not guessed). N2 = DONE. Caveat: the 3,751 pre-N2 rows keep old -50% stops and can't be re-resolved (no past prices); only NEW hardened resolutions are clean (~7 so far). Trustworthy verdict needs days of fresh accrual + continuous harness uptime (harness died ~7h on Mac sleep).
STATE:  live=NO, measure_live=NO, broadcast=NO, bot_state=dry_run/false/false, tracked_wallets 63/751. No file change this entry.
NEXT:   Codex: build the LP-v1 latency-probe collector (docs/ops/latency-edge-probe-LP-v1.md) reusing the hardened paper-sim exit model. It runs in parallel + starts the actual edge hunt (does entering earlier flip -EV->+EV).
PROMPT: (full LP-v1 build prompt provided to Operator to paste — author migration 021_latency_probe.sql [operator applies] + src/scripts/lp-collect.ts + lp-report.ts; reuse boundedExitAtThreshold/confirmedPrice from shadow-paper-sim.ts; entry timings t0/+60/+180/+300s; fair-resolution + guard views; shadow-only, no SOL; claim locks; commit exact-file; push; Handoff TO=Code.)
