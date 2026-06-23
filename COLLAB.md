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
