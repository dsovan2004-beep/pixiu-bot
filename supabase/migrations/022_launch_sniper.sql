-- SNIPER-v1 launch-sniper edge probe (shadow-only, no real SOL).
-- Pre-registration: docs/ops/launch-sniper-probe-SNIPER-v1.md
-- Additive only: new tables + RLS. No mutation of trades/bot_state/tracked_wallets.

-- Broad-population capture of every detected pump.fun launch + frozen S1-S8
-- features + forward paper-sim outcome (single entry at earliest detection = t0).
CREATE TABLE IF NOT EXISTS launch_sniper_shadow (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  mint TEXT NOT NULL,
  coin_name TEXT,
  creation_time TIMESTAMPTZ NOT NULL,        -- token birth (on-chain create)
  -- frozen features (S1-S8); null = unavailable at capture, never invented
  detection_lag_secs INTEGER,                -- S1 creation -> first_seen
  feat_init_liq_usd NUMERIC,                  -- S2
  feat_creator_hold_pct NUMERIC,             -- S3
  feat_buyers_60s INTEGER,                    -- S4 distinct buyers first 60s
  feat_buy_sell_ratio_60s NUMERIC,           -- S5
  feat_auth_renounced BOOLEAN,               -- S6 mint+freeze renounced
  feat_lp_locked_pct NUMERIC,                -- S7
  feat_name_flagged BOOLEAN,                  -- S8 offensive/stablecoin name
  guard_passing BOOLEAN,                      -- optional 15-guard tag (later cut)
  -- forward paper-sim (reuses hardened exit logic; t0 = earliest detection)
  price_t0 NUMERIC,
  peak_pct NUMERIC,
  last_price NUMERIC,
  last_polled_at TIMESTAMPTZ,
  sim_exit_price NUMERIC,
  sim_pnl_pct NUMERIC,
  exit_reason TEXT,
  sim_hold_secs INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_launch_sniper_shadow_dedup ON launch_sniper_shadow (mint, creation_time);
CREATE INDEX IF NOT EXISTS idx_launch_sniper_shadow_unresolved ON launch_sniper_shadow (resolved_at, first_seen_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_launch_sniper_shadow_creation ON launch_sniper_shadow (creation_time);

-- Pre-registered cut thresholds (policy-driven per LOCKED build rules — NEVER
-- source-code constants). active=false until a cut is pre-registered before the
-- out-of-sample test. Thresholds null = feature not used in the cut.
CREATE TABLE IF NOT EXISTS launch_sniper_policy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rule_version TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  min_init_liq_usd NUMERIC,
  max_creator_hold_pct NUMERIC,
  min_buyers_60s INTEGER,
  min_buy_sell_ratio_60s NUMERIC,
  require_auth_renounced BOOLEAN,
  min_lp_locked_pct NUMERIC,
  max_detection_lag_secs INTEGER,
  notes TEXT
);

ALTER TABLE launch_sniper_shadow ENABLE ROW LEVEL SECURITY;
ALTER TABLE launch_sniper_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_launch_sniper_shadow" ON launch_sniper_shadow;
CREATE POLICY "anon_read_launch_sniper_shadow" ON launch_sniper_shadow FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "service_all_launch_sniper_shadow" ON launch_sniper_shadow;
CREATE POLICY "service_all_launch_sniper_shadow" ON launch_sniper_shadow FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "anon_read_launch_sniper_policy" ON launch_sniper_policy;
CREATE POLICY "anon_read_launch_sniper_policy" ON launch_sniper_policy FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "service_all_launch_sniper_policy" ON launch_sniper_policy;
CREATE POLICY "service_all_launch_sniper_policy" ON launch_sniper_policy FOR ALL TO service_role USING (true);

-- Seed the frozen rule version with NO active cut (broad collect first).
INSERT INTO launch_sniper_policy (rule_version, active, notes)
SELECT 'sniper_v1', false, 'Frozen 2026-06-24. Broad collect; no cut active until pre-registered before OOS test.'
WHERE NOT EXISTS (SELECT 1 FROM launch_sniper_policy WHERE rule_version = 'sniper_v1');

SELECT 'ok' AS check,
  (SELECT count(*) FROM launch_sniper_shadow) AS shadow_rows,
  (SELECT count(*) FROM launch_sniper_policy WHERE rule_version='sniper_v1') AS policy_rows;
