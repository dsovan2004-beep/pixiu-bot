# Global Dynamic Build Rules — LOCKED

**Binding on BOTH Claude Code and Codex.** Read at session start (linked from
`AGENTS.md` → `COLLAB.md` → playbook). These govern every build. Operator-set;
do not relax without explicit approval.

## Non-negotiable
No guessing · no assumptions · no drifting · no hardcoding · no hardwiring · no
placeholders · no fake data · no synthetic success · no manual allowlists unless
explicitly approved · no temporary hacks presented as final · no "just for now"
logic · no magic numbers **unless** sourced from policy tables, config tables,
validated source-of-truth data, or documented protocol specs.

## Dynamic build requirement
If a value can change in the future it must come from **database policy /
configuration / runtime calculation / validated provider data / source-of-truth
tables** — NOT source-code constants.

- **Forbidden:** `if wallet === "theo pump sad"`, `const GOOD_WALLETS=[...]`,
  `const BAD_WALLETS=[...]`, `const THRESHOLD = 0.65`.
- **Allowed (data/policy sources):** `wallet_performance`, `current_wallet_status`,
  `token_risk_policy`, `wallet_scoring_policy`, `cohort_policy`, `l0_gate_policy`.

## Fail-closed
Missing required data → **stop, report blocker, do not invent, do not silently
continue.** Missing critical input ⇒ would_block ⇒ fail_closed ⇒ report. Never
substitute guessed values.

## Verification
Before claiming success: show evidence, source, file(s), and query results.
Separate **verified facts / hypotheses / unknowns.** Never present a hypothesis
as fact.

## Architecture
Systems must survive new wallets / tokens / chains / providers / policies
**without source-code changes.** If a future change requires editing source, the
design is probably hardcoded.

## Pixiu-specific
Goal: **daily profit** — not more trades, signals, or complexity. Every feature
must answer: *"How does this improve profitability or reduce bad entries?"* If it
does neither, do not build it.

## Forbidden outcomes
Hardcoded wallet names · token names · allowlists · denylists · profitability
thresholds · promotion logic · cohort counts · entry-quality thresholds ·
placeholder policy values presented as production · temporary production logic.

## Required outcome
Dynamic · policy-driven · data-driven · auditable · fail-closed · evidence-based.

---

## Compliance status (verified 2026-06-23 — facts, not assumptions)

**Compliant (the new shadow/scoring layer):**
- TR-v1 token risk → `token_risk_policy` table (DB-driven). ✅
- Wallet scoring → `wallet_scoring_policy` / `wallet_performance` / `current_wallet_status`. ✅
- Shadow harness reads policy from DB; fail-closed on missing policy. ✅

**NON-compliant (legacy LIVE entry path — currently dormant, `is_running=false`):**
- `src/config/smart-money.ts`: `ELITE_WALLET_TAGS = {theo pump sad, daniww}` +
  `ELITE_BUY_SOL` + `getBuySolForWalletTag()` → hardcoded **allowlist + sizing**
  (the literal forbidden `if wallet === "theo pump sad"` pattern). `WALLET_BLACKLIST`
  (hardcoded **denylist**, consumed by `route.ts` guard #10a). Hardcoded wallet
  **addresses**. Magic-number thresholds: `DUMP_PATTERN_MIN_SIGNALS`, `MAX_GAP_MINUTES`,
  `MAX_ENTRY_MC`, cooldowns, `LIVE_BUY_SOL`, `DAILY_LOSS_LIMIT_SOL`.
- `src/lib/price-guards.ts`: `MIN_LIQUIDITY_USD`, `MIN_FDV_USD`, `MAX_ENTRY_PRICE`,
  `MAX_5M_DROP_PCT` (consumed by `route.ts`).

**Implication (LOCKED):** the legacy hardcoded wallets/allowlists/denylists/
thresholds must migrate to DB policy tables (e.g., `l0_gate_policy`, a
`wallet_eligibility` source-of-truth, `entry_policy`) **before any live restart.**
Tracked in `docs/BACKLOG.md`. No live restart while the entry path is hardcoded.
