# Pre-Registered Token-Risk Rule — TR-v1

**Status: PRE-REGISTERED (frozen) — 2026-06-21.**
This rule is fixed *before* any forward shadow data is evaluated, to prevent
overfitting. Changing any value below = a new version (TR-v2), which must also
be registered **before** seeing the data it will be judged on. Never tune
thresholds to forward outcomes already observed.

This is the **only remaining edge hypothesis** after P0–P6: wallet-based edge
was disproven out-of-sample (walk-forward: train-profitable wallets went
−0.043 net in the held-out period). TR-v1 tests whether **per-trade token risk
at entry** separates the trailing-stop winners (+0.418) from the drain/rug
losers (≈−0.563, of which `pool_drain` = −0.360).

Scope: **shadow/paper-sim only.** Non-enforcing. No real SOL, no live, no
measure_live, no wallet mutation. `rule_version='TR-v1'`.

---

## 1. The rule (decision)
```
would_enter  ⟺  (no critical veto)  AND  (soft_risk_score < RISK_SCORE_BLOCK)
would_block  otherwise, with block_reasons[]
```
- **Critical veto** = any C-check fails OR its data is missing (fail-CLOSED).
- **soft_risk_score** = weighted sum of S-components (0–100); missing soft
  metric → that component takes its **max penalty** and is flagged in `missing[]`.
- The rule consumes **only entry-time** token metadata (see §5). It never reads
  any post-entry price or the paper-sim outcome.

## 2. Inputs (all captured at decision_time)
| Input | Source | Used as |
|---|---|---|
| honeypot flag | RugCheck `/report` risks | Critical C1 |
| mint authority | RugCheck / Helius | Critical C2 |
| freeze authority | RugCheck / Helius | Critical C3 |
| LP burned / LP-lock % | RugCheck markets/lockers | Critical C4 |
| liquidity (USD) | DexScreener | Critical C5 |
| top-10 holder % | RugCheck `top10HoldersPercent` | Critical C6 |
| FDV (USD) | DexScreener | Soft S1 |
| token age (min) | DexScreener pair age | Soft S2 |
| 5-min price change | DexScreener `priceChange.m5` | Soft S3 |
| dev / creator holdings % | RugCheck creator balance | Soft S4 |
| insider / rat-wallet ratio | RugCheck insider networks | Soft S5 |
| bundle ratio | RugCheck / on-chain | Soft S6 |
| provider confidence / coverage | response completeness | gating |

> NOTE: mint/freeze authority, LP-lock %, dev holdings, insider ratio, and
> bundle ratio are present in RugCheck's full `/report` payload but **not
> currently consumed** by the webhook. The harness must extend RugCheck parsing.

## 3. Critical checks (fail OR missing → would_block; fail-closed)
| # | Check | Pass condition |
|---|---|---|
| C1 | honeypot | flag = false |
| C2 | mint authority | null / renounced |
| C3 | freeze authority | null / renounced |
| C4 | LP | burned OR locked ≥ `LP_LOCK_MIN_PCT` |
| C5 | liquidity | ≥ `MIN_LIQUIDITY_USD` |
| C6 | top-10 concentration | ≤ `TOP10_MAX_PCT` |

C4 is the `pool_drain` defense (−0.360 / 29% of total loss). Any missing
critical datum → `would_block` + recorded in `missing[]` (we measure coverage,
we do not assume safe).

## 4. Soft components (→ soft_risk_score 0–100; missing → max penalty + flag)
| # | Component | Worse when | Weight (frozen) |
|---|---|---|---|
| S1 | FDV | < `MIN_FDV_USD` | 15 |
| S2 | token age | < `MIN_TOKEN_AGE_MINUTES` | 15 |
| S3 | m5 price change | < `MAX_5M_DROP_PCT` | 20 |
| S4 | dev/creator holdings % | > `DEV_HOLDINGS_MAX_PCT` | 20 |
| S5 | insider/rat ratio | > `INSIDER_RATIO_MAX` | 15 |
| S6 | bundle ratio | > `BUNDLE_RATIO_MAX` | 15 |

`soft_risk_score` = Σ (weight × component_severity 0..1). Block if
`soft_risk_score ≥ RISK_SCORE_BLOCK`.

## 5. Policy thresholds (frozen for TR-v1; live in a `token_risk_policy` row, not source constants)
**Reused (already validated production values):**
- `MIN_LIQUIDITY_USD = 10000`
- `MIN_FDV_USD = 10000`
- `TOP10_MAX_PCT = 80`
- `MIN_TOKEN_AGE_MINUTES = 15`
- `MAX_5M_DROP_PCT = -20`

**New (pre-registered conservative defaults — NOT yet validated; frozen):**
- `LP_LOCK_MIN_PCT = 95`
- `DEV_HOLDINGS_MAX_PCT = 10`
- `INSIDER_RATIO_MAX = 0.10`
- `BUNDLE_RATIO_MAX = 0.60`
- `RISK_SCORE_BLOCK = 50`
- soft weights = {S1:15, S2:15, S3:20, S4:20, S5:15, S6:15}
- `PROVIDER_CONFIDENCE_MIN`: if RugCheck report incomplete → treat criticals as missing → block.

These "new" values are explicit hypotheses, frozen so the forward test judges
*this* rule honestly. If they prove wrong, that is a real result — we register
TR-v2, we do **not** re-tune TR-v1 on the same data.

## 6. Output fields (per decision, written to `stacked_filter_shadow`)
`would_enter, would_block, block_reasons[], risk_severity (critical|high|medium|low),
token_risk_score, components{S1..S6 values+severities}, missing[], provider,
provider_confidence, rule_version='TR-v1', policy_id`.
Severity: `critical` if any C veto; else `high/medium/low` by score band.

## 7. Success / failure criteria (forward, walk-forward)
**Success (rule has edge) — ALL must hold:**
- `would_enter` net paper-sim PnL **positive with margin** (outside noise).
- Holds in **≥2 independent forward sub-windows** (walk-forward).
- **Discrimination:** `would_block` mean sim PnL is materially **more negative**
  than `would_enter` (the rule separates losers from winners).
- **Trailing winners preserved** (rule does not block the +trailing engine).
**Failure:** would_enter net ≤ 0 or within noise; OR no discrimination; OR it
blocks the trailing winners; OR token-risk coverage too low to gate.

## 8. Minimum forward sample (before any edge claim / measure_live consideration)
- **N ≥ 150** resolved paper-sim decisions (use the broad signal population to
  beat entry rarity), of which **≥ 50 `would_enter`** and a comparable
  `would_block` set.
- Split into **≥ 2 walk-forward sub-windows**; criteria must hold in each.
- Hard time box: if N<150 after **~4 weeks**, report the coverage blocker.

## 9. What must be recorded for honest evaluation
Every field in §6 **plus** `decision_time`, `entry_price_at_decision`, the
frozen `policy_id`/threshold snapshot, and (filled later, separately)
`sim_exit_price, sim_exit_reason, sim_pnl_sol, sim_hold_secs, outcome_resolved_at`.
The threshold snapshot makes the freeze auditable.

## 10. No-future-data guarantee
TR-v1 decision inputs (§2) are **all token metadata observable at/before
`decision_time`**. The paper-sim outcome (`sim_pnl_sol`) is stored in separate
columns and is used **only** in §7 evaluation — **never** as a rule input.
Confirmed: the rule cannot see the future.
