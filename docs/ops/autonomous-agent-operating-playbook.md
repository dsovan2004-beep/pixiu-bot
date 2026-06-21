# PixiuBot — Autonomous Agent Operating Playbook

**Source of truth for how Claude Code and Codex work autonomously on PixiuBot
without Dustin acting as a router.** Both agents must read this file at the
start of a work session and follow it. ChatGPT (strategy/evidence) and Dustin
(chairman) operate against the same boundaries.

This file governs *agent operating protocol*. It complements — does not
replace — `AGENTS.md` (architecture / the single-entry-path rule) and
`ROADMAP.md` (the daily-profit recovery roadmap). If this file ever conflicts
with `AGENTS.md` safety rules, `AGENTS.md` wins and the conflict must be
reported.

Last updated: 2026-06-21.

---

## 1. Project north star

- **Daily profit.** Make more realized profit than realized losses.
- **Protect capital.** Capital preservation outranks any single trade.
- **Never use the main wallet.** Not for testing, not for "just once." Never.
- Current strategy EV is **NEGATIVE** (332-trade postmortem: −1.2473 SOL). No
  live restart, no size-up, and no capital injection while EV is negative and
  recovery gates are incomplete.

## 2. Locked roadmap (work in order — no skipping ahead)

| Stage | Goal | Gate to advance |
|---|---|---|
| **P0** | Dry_run runtime smoke / would-buy observability gap | Real would-buy row proves `mode='dry_run'`, `exit_reason='dry_run_would_buy'`, no broadcast — OR formally blocked with evidence |
| **P1** | DB wallet scorer validation | DB scorer reproduces the CSV/postmortem conclusions on real DB data |
| **P2** | Shadow wallet would-block reporting | Would-block surfaces the bad-wallet class without enforcement |
| **P3** | Wallet cohort confirmation | Dynamic evidence avoids weak single-wallet signals |
| **P4** | L0 entry-quality gate | Blocks bad L0 entries on wallet/token/liquidity/latency evidence |
| **P5** | Token risk + bundle/dev/top-holder filter | Bundle ratio, dev holdings, insider/rat wallets, top-holder concentration, LP/honeypot/mint/freeze fail closed |
| **P6** | `measure_live` telemetry | Explicit reduced-size policy, non-main wallet, quote-vs-fill evidence only |

**Execution rule:** do not start P(n+1) until P(n) is **closed** or **formally
blocked with verified evidence**.

## 3. Current accepted status (as of 2026-06-21)

- **P0 — CLOSED as BLOCKED BY ENTRY RARITY** (not a safety failure). 4 attended
  dry_run windows with heavy live signal flow (54–85 signals/10–15 min) produced
  **0 entries / 0 would-buy rows** — no signal cleared the 15 webhook guards.
  The dry_run code path (`src/agents/trade-executor.ts:423`) is statically
  verified and broadcast-safe.
- **P1 — wallet scoring LOGIC validated via CSV** (`src/scripts/wallet-score-csv.ts`,
  env-free). Reproduces the postmortem exactly: total −1.2473 SOL, only 3 of 37
  wallets positive-total, **0 promoted** (median/LCB breakeven gate, parameter-
  independent), elite-sized `theo pump sad` + `daniww` score **probation**.
- **DB SCORER VALIDATED: NO** — blocked: migrations 017/018/019 unapplied,
  no `wallet_scoring_policy` row, no service-role/DDL access in the agent shell.
- **SHADOW REPORTING READY: NO.**
- **measure_live: BLOCKED. live: BLOCKED. main wallet: NEVER.**
- Bot state: `mode='dry_run'`, `broadcast_tx=false`, `is_running=false`.

> Agents must update this section (with date + evidence) when a stage status
> changes, and keep it consistent with `ROADMAP.md` / `docs/BACKLOG.md`.

## 4. Roles

| Actor | Role | May decide |
|---|---|---|
| **Dustin** | Chairman / capital allocator / final go-no-go | Live trading, capital, size-up, main-wallet, anything outside roadmap scope |
| **ChatGPT** | Producer / CSO / evidence gatekeeper | Strategy direction, accepts/rejects evidence, sets task scope |
| **Claude Code** | Architecture / review / system safety / SQL planning / autonomous approved-scope execution | Reviews, audits, scoped commits/pushes, dry_run validation, SQL authoring |
| **Codex** | Implementation / static validation / audit / scorer validation | Code changes within scope, static checks, scorer runs |

**Both agents:** continue from backlog order autonomously. Do **not** ask Dustin
to route work. Do **not** hand routing back to Dustin.

## 5. Auto-approval rules

**Agents may proceed autonomously, within approved scope, for:**
- documentation
- audits / reviews
- static validation (lint-equivalent, code reading, type reasoning)
- dry_run validation (with the safety boundaries in §8)
- CSV / read-only scoring
- shadow-only reporting (read-only, non-enforcing)
- scoped commits/pushes that were already approved (exact-file only)
- blocker reports
- backlog / roadmap / docs updates

**Dustin approval is still REQUIRED for:**
- live trading
- `measure_live` with real SOL
- main-wallet use (NEVER, even with approval is not "main wallet ok" — main wallet is permanently off)
- secret access (`.env`, keys, tokens, wallet files)
- wallet eligibility enforcement
- `tracked_wallets.tier` mutation
- `tracked_wallets.active` mutation
- `measure_live_policy` row insertion / activation
- DB role / service-role / JWT creation
- anything outside the current roadmap scope

## 6. Handoff protocol (every agent response must include)

```
A. Current status
B. Work completed
C. Evidence            (file:line, query results, exact outputs)
D. Blockers            (exact blocker + safest next path)
E. Next owner          (Dustin / ChatGPT / Claude Code / Codex)
F. Next action
G. Next prompt         (verbatim, if another agent is needed)
H. Final verdict       (status flags: measure_live NO / live NO / main wallet NEVER)
```

## 7. No-waiting rule

If the next step is clear and in scope, the agent must **propose or perform it**
in the same turn. Do not wait for Dustin to ask "what next?". Do not bounce
routing decisions back to Dustin. When another agent is the right owner, emit
the exact next prompt (handoff §6.G) so the work continues without a human router.

## 8. Safety boundaries

- `bot_state` must remain `mode='dry_run'`, `broadcast_tx=false`,
  `is_running=false` **unless** a dry_run validation explicitly requires a
  temporary `is_running=true`.
- Any temporary `is_running=true` must be **guarded** (refuse to arm unless
  `mode='dry_run'` AND `broadcast_tx=false`) and **auto-restore** `is_running=false`
  on exit. Helpers: `src/scripts/dry-run-retest.ts` (executor-only, auto-restore)
  and `src/scripts/set-running.ts true|false` (guarded setter).
- Executor-only for dry_run runs — **never** `run-all.ts` (it starts the
  tier-manager, which mutates `tracked_wallets`).
- No broadcast. No live. No measure_live. No main wallet.

## 9. Evidence rules

- Cite **file paths and line numbers** for every code claim.
- Separate **verified facts** from **hypotheses** explicitly.
- If blocked, report the **exact blocker** and the **safest next path** — do not
  guess around it.
- **No fake safety** — never report a check as passed unless it was actually run.
- **No placeholder logic** — no hardcoded/stubbed results presented as real.

## 10. Git rules

- **Exact-file staging only.** Never `git add -A`; never stage broad directories.
- Autonomous push is allowed only for **approved scoped commits** (docs, audits,
  already-approved scope). Anything broader needs explicit approval.
- GitHub auth is via **macOS Keychain** (`osxkeychain` helper). Push works
  autonomously. **Never run `gh auth setup-git`** — it re-adds a read-only `gh`
  token that shadows the Keychain write token and breaks push (fix:
  `git config --global --unset-all credential.https://github.com.helper`).
- **Never print or access tokens.** The reliable manual fallback is an
  inline-URL push run by Dustin.
- Commit only files in the approved scope. Verify `git diff --cached --name-only`
  before committing.

## 11. Profit rules (apply to every task)

Every task must answer at least one of:
- Will this **reduce bad L0 entries**?
- Will this **remove weak wallets**?
- Will this **improve execution quality**?
- Will this **increase expected profitability**?

If a task answers none of these, **deprioritize it** and say so.

## 12. Stop-here rule

When Dustin says "let's stop here," the agent must recap:
- verified status
- completed work
- active blocker
- roadmap state
- next owner
- next action

…and then stop. Do not commit or push at stop-here unless a file is reviewed
and clearly docs-only.

---

## Active blocker (live)

**P1 DB-generation** needs an operator with DB DDL / service-role access to:
1. apply migrations `017` → `018` → `019` (in order) via the Supabase SQL editor, and
2. insert one `wallet_scoring_policy` row (validation params: `mature_min_trades=5,
   disable_percentile=0.25, promotion_percentile=0.90, lower_confidence_z=1,
   breakeven_floor_sol=0, unknown_wallet_policy='disabled'`).

Exact SQL + verification + rollback were authored in the prior task. After that,
Claude Code/Codex can run `wallet-score-db.ts --policy-id <id> --dry-run` (caveat:
it opens `.env.local` on import and uses the anon key — RLS may then be the next
blocker). Until then P1 DB-gen and P2 are blocked.

## Operational notes (verified facts)

- `coin_signals` timestamp column is **`signal_time`** (not `created_at`).
- Single entry path: `src/app/api/webhook/route.ts` → `evaluateAndEnter()`
  (edge runtime). Node swarm = wallet-watcher, trade-executor, risk-guard,
  tier-manager via `run-all.ts`.
- Mode-aware webhook + dashboard dry_run exclusion are deployed on `origin/main`
  (`19cae29`, `c3f0ca5`).
