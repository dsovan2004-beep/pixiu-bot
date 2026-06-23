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

- A `HELD` lock older than **2h with no commit** is stale → may be reclaimed after posting a note in the Handoff Log (§4).
- If you find your target file already changed in the working tree by the other agent (uncommitted), **STOP** and use §6.

## 3. Task Board
One owner per task. Statuses: `TODO → CLAIMED → IN_PROGRESS → REVIEW → DONE` (or `BLOCKED`).

| ID | Task | Owner | Status | Notes |
|---|---|---|---|---|
| _example_ | Dashboard shadow panel | Codex | IN_PROGRESS | needs anon RLS policy (operator) |

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
