/**
 * TR-v1 token-risk evaluator (PRE-REGISTERED — see docs/ops/token-risk-rule-TR-v1.md,
 * commit b03364b). Pure + edge-safe (no node builtins, no imports).
 *
 * Decision: would_enter ⟺ (no critical veto) AND (soft_risk_score < RISK_SCORE_BLOCK).
 * Critical missing data → veto (fail-closed). Soft missing → max penalty + flagged.
 * Inputs are ENTRY-TIME ONLY; this function never sees an outcome. Do not change
 * TR-v1 thresholds — a new rule is TR-v2, pre-registered before its data.
 */

export type TokenRiskPolicy = {
  rule_version: string; // 'TR-v1'
  policy_id: string;
  // reused/validated criticals + soft floors
  min_liquidity_usd: number;
  top10_max_pct: number;
  min_fdv_usd: number;
  min_token_age_minutes: number;
  max_5m_drop_pct: number;
  // new (frozen) criticals + soft caps
  lp_lock_min_pct: number;
  dev_holdings_max_pct: number;
  insider_ratio_max: number;
  bundle_ratio_max: number;
  risk_score_block: number;
  soft_weights: { S1: number; S2: number; S3: number; S4: number; S5: number; S6: number };
};

/** All fields are entry-time observations; null = not observed (NOT assumed safe). */
export type TokenRiskInputs = {
  honeypot: boolean | null;            // C1
  mintAuthorityRenounced: boolean | null; // C2 (true = no mint authority)
  freezeAuthorityRenounced: boolean | null; // C3 (true = no freeze authority)
  lpBurnedOrLockedPct: number | null;  // C4 (% of LP burned or locked; 100 = fully)
  liquidityUsd: number | null;         // C5
  top10HoldersPct: number | null;      // C6
  fdvUsd: number | null;               // S1
  tokenAgeMinutes: number | null;      // S2
  priceChange5mPct: number | null;     // S3
  devHoldingsPct: number | null;       // S4
  insiderRatio: number | null;         // S5
  bundleRatio: number | null;          // S6
};

export type TokenRiskDecision = {
  rule_version: string;
  policy_id: string;
  would_enter: boolean;
  would_block: boolean;
  risk_severity: "critical" | "high" | "medium" | "low";
  token_risk_score: number; // soft score 0..100
  block_reasons: string[];
  missing: string[];
  components: Record<string, { value: number | boolean | null; severity: number; missing: boolean }>;
};

export function evaluateTokenRiskV1(input: TokenRiskInputs, policy: TokenRiskPolicy): TokenRiskDecision {
  const reasons: string[] = [];
  const missing: string[] = [];
  const components: TokenRiskDecision["components"] = {};

  // ── Critical checks: fail OR missing → veto (fail-closed) ──
  const crit = (name: string, value: boolean | number | null, passed: boolean | null) => {
    const isMissing = value === null || passed === null;
    components[name] = { value, severity: passed === true ? 0 : 1, missing: isMissing };
    if (isMissing) { missing.push(name); reasons.push(`${name}_missing`); return false; }
    if (!passed) { reasons.push(`${name}_fail`); return false; }
    return true;
  };

  crit("C1_honeypot", input.honeypot, input.honeypot === null ? null : input.honeypot === false);
  crit("C2_mint_authority", input.mintAuthorityRenounced, input.mintAuthorityRenounced);
  crit("C3_freeze_authority", input.freezeAuthorityRenounced, input.freezeAuthorityRenounced);
  crit("C4_lp_lock", input.lpBurnedOrLockedPct,
    input.lpBurnedOrLockedPct === null ? null : input.lpBurnedOrLockedPct >= policy.lp_lock_min_pct);
  crit("C5_liquidity", input.liquidityUsd,
    input.liquidityUsd === null ? null : input.liquidityUsd >= policy.min_liquidity_usd);
  crit("C6_top10", input.top10HoldersPct,
    input.top10HoldersPct === null ? null : input.top10HoldersPct <= policy.top10_max_pct);

  const criticalVeto = Object.keys(components).some((k) => k.startsWith("C") && components[k].severity === 1);

  // ── Soft components: missing → severity 1 (max penalty) + flagged ──
  const soft = (name: string, weightKey: keyof TokenRiskPolicy["soft_weights"], value: number | null, ok: boolean | null) => {
    const isMissing = value === null || ok === null;
    const severity = isMissing ? 1 : ok ? 0 : 1;
    components[name] = { value, severity, missing: isMissing };
    if (isMissing) missing.push(name);
    if (severity === 1 && !isMissing) reasons.push(`${name}_penalty`);
    return policy.soft_weights[weightKey] * severity;
  };

  let score = 0;
  score += soft("S1_fdv", "S1", input.fdvUsd, input.fdvUsd === null ? null : input.fdvUsd >= policy.min_fdv_usd);
  score += soft("S2_age", "S2", input.tokenAgeMinutes, input.tokenAgeMinutes === null ? null : input.tokenAgeMinutes >= policy.min_token_age_minutes);
  score += soft("S3_m5drop", "S3", input.priceChange5mPct, input.priceChange5mPct === null ? null : input.priceChange5mPct >= policy.max_5m_drop_pct);
  score += soft("S4_dev_holdings", "S4", input.devHoldingsPct, input.devHoldingsPct === null ? null : input.devHoldingsPct <= policy.dev_holdings_max_pct);
  score += soft("S5_insider", "S5", input.insiderRatio, input.insiderRatio === null ? null : input.insiderRatio <= policy.insider_ratio_max);
  score += soft("S6_bundle", "S6", input.bundleRatio, input.bundleRatio === null ? null : input.bundleRatio <= policy.bundle_ratio_max);

  const softBlock = score >= policy.risk_score_block;
  if (softBlock) reasons.push(`soft_score_${score}>=${policy.risk_score_block}`);

  const would_block = criticalVeto || softBlock;
  const risk_severity: TokenRiskDecision["risk_severity"] = criticalVeto
    ? "critical"
    : score >= policy.risk_score_block ? "high"
    : score >= policy.risk_score_block / 2 ? "medium"
    : "low";

  return {
    rule_version: policy.rule_version,
    policy_id: policy.policy_id,
    would_enter: !would_block,
    would_block,
    risk_severity,
    token_risk_score: score,
    block_reasons: reasons,
    missing,
    components,
  };
}
