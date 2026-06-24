-- LP-v1 latency edge probe. Shadow/paper-sim only: no enforcement, no SOL,
-- no bot_state/tracked_wallets writes. Operator applies this migration.

CREATE TABLE IF NOT EXISTS latency_probe_shadow (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,

  coin_address TEXT NOT NULL,
  coin_name TEXT,
  signal_time TIMESTAMPTZ NOT NULL,
  primary_wallet TEXT,
  wallet_tags TEXT[],
  guard_passing BOOLEAN,

  entry_time_t0 TIMESTAMPTZ NOT NULL,
  entry_time_60 TIMESTAMPTZ NOT NULL,
  entry_time_180 TIMESTAMPTZ NOT NULL,
  entry_time_300 TIMESTAMPTZ NOT NULL,

  price_t0 NUMERIC,
  price_60 NUMERIC,
  price_180 NUMERIC,
  price_300 NUMERIC,

  peak_pct_t0 NUMERIC,
  peak_pct_60 NUMERIC,
  peak_pct_180 NUMERIC,
  peak_pct_300 NUMERIC,

  last_price_t0 NUMERIC,
  last_price_60 NUMERIC,
  last_price_180 NUMERIC,
  last_price_300 NUMERIC,

  last_polled_at_t0 TIMESTAMPTZ,
  last_polled_at_60 TIMESTAMPTZ,
  last_polled_at_180 TIMESTAMPTZ,
  last_polled_at_300 TIMESTAMPTZ,

  sim_exit_price_t0 NUMERIC,
  sim_exit_price_60 NUMERIC,
  sim_exit_price_180 NUMERIC,
  sim_exit_price_300 NUMERIC,

  sim_pnl_t0 NUMERIC,
  sim_pnl_60 NUMERIC,
  sim_pnl_180 NUMERIC,
  sim_pnl_300 NUMERIC,

  exit_reason_t0 TEXT,
  exit_reason_60 TEXT,
  exit_reason_180 TEXT,
  exit_reason_300 TEXT,

  sim_hold_secs_t0 INTEGER,
  sim_hold_secs_60 INTEGER,
  sim_hold_secs_180 INTEGER,
  sim_hold_secs_300 INTEGER,

  resolved_at_t0 TIMESTAMPTZ,
  resolved_at_60 TIMESTAMPTZ,
  resolved_at_180 TIMESTAMPTZ,
  resolved_at_300 TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_latency_probe_shadow_dedup
  ON latency_probe_shadow (coin_address, signal_time);

CREATE INDEX IF NOT EXISTS idx_latency_probe_shadow_unresolved
  ON latency_probe_shadow (resolved_at, first_seen_at)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_latency_probe_shadow_signal_time
  ON latency_probe_shadow (signal_time);

ALTER TABLE latency_probe_shadow ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_latency_probe_shadow"
  ON latency_probe_shadow
  FOR SELECT TO anon
  USING (true);

CREATE POLICY "service_all_latency_probe_shadow"
  ON latency_probe_shadow
  FOR ALL TO service_role
  USING (true);

COMMENT ON TABLE latency_probe_shadow IS
  'LP-v1 shadow-only latency probe. Compares paper outcomes for t0/+60/+180/+300 entry timings; never gates live trading.';
