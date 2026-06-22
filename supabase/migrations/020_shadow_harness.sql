-- Forward shadow harness for TR-v1. Shadow/paper-sim only — no enforcement,
-- no eligibility, no bot_state, no real SOL. Append-only audit + dynamic policy.

CREATE TABLE IF NOT EXISTS token_risk_policy (
  id TEXT PRIMARY KEY,
  rule_version TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  min_liquidity_usd NUMERIC NOT NULL,
  top10_max_pct NUMERIC NOT NULL,
  min_fdv_usd NUMERIC NOT NULL,
  min_token_age_minutes NUMERIC NOT NULL,
  max_5m_drop_pct NUMERIC NOT NULL,
  lp_lock_min_pct NUMERIC NOT NULL,
  dev_holdings_max_pct NUMERIC NOT NULL,
  insider_ratio_max NUMERIC NOT NULL,
  bundle_ratio_max NUMERIC NOT NULL,
  risk_score_block NUMERIC NOT NULL,
  soft_weights JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_token_risk_policy_one_active
  ON token_risk_policy (active) WHERE active = true;

CREATE TABLE IF NOT EXISTS stacked_filter_shadow (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decision_time TIMESTAMPTZ NOT NULL,
  signal_coin_address TEXT NOT NULL,
  coin_name TEXT,
  signal_time TIMESTAMPTZ,
  wallet_tags TEXT[],
  primary_wallet TEXT,
  -- TR-v1 decision
  token_risk_score NUMERIC,
  risk_severity TEXT,
  would_enter BOOLEAN NOT NULL,
  would_block BOOLEAN NOT NULL,
  block_reasons TEXT[],
  missing_metrics TEXT[],
  components JSONB,
  provider TEXT,
  provider_confidence NUMERIC,
  rule_version TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  entry_price_at_decision NUMERIC,
  -- paper-sim state + outcome (filled forward; never an input to the decision)
  peak_pct NUMERIC,
  last_price NUMERIC,
  last_polled_at TIMESTAMPTZ,
  sim_exit_price NUMERIC,
  sim_exit_reason TEXT,
  sim_pnl_pct NUMERIC,
  sim_hold_secs INTEGER,
  outcome_resolved_at TIMESTAMPTZ
);
-- dedup: one shadow row per (coin, signal_time)
CREATE UNIQUE INDEX IF NOT EXISTS idx_stacked_filter_shadow_dedup
  ON stacked_filter_shadow (signal_coin_address, signal_time);
CREATE INDEX IF NOT EXISTS idx_stacked_filter_shadow_unresolved
  ON stacked_filter_shadow (outcome_resolved_at, decision_time)
  WHERE outcome_resolved_at IS NULL;

-- Seed the frozen TR-v1 policy (matches docs/ops/token-risk-rule-TR-v1.md, commit b03364b)
INSERT INTO token_risk_policy (
  id, rule_version, active, min_liquidity_usd, top10_max_pct, min_fdv_usd,
  min_token_age_minutes, max_5m_drop_pct, lp_lock_min_pct, dev_holdings_max_pct,
  insider_ratio_max, bundle_ratio_max, risk_score_block, soft_weights
) VALUES (
  'tr_v1', 'TR-v1', true, 10000, 80, 10000,
  15, -20, 95, 10,
  0.10, 0.60, 50,
  '{"S1":15,"S2":15,"S3":20,"S4":20,"S5":15,"S6":15}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE token_risk_policy IS 'Dynamic token-risk policy. TR-v1 row is pre-registered/frozen; new tunings = new row + rule_version, registered before its data.';
COMMENT ON TABLE stacked_filter_shadow IS 'Append-only shadow decisions + paper-sim outcomes. Non-enforcing; never used to gate live entries.';

-- Self-check
SELECT 'policy' AS check, id, rule_version, active, risk_score_block FROM token_risk_policy;
