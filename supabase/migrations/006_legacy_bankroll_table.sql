-- Sprint 2.2: Legacy bankroll simulation

CREATE TABLE DEPRECATED_bankroll (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  starting_balance NUMERIC NOT NULL DEFAULT 10000,
  current_balance NUMERIC NOT NULL DEFAULT 10000,
  total_pnl_usd NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed
INSERT INTO DEPRECATED_bankroll (starting_balance, current_balance, total_pnl_usd) VALUES (10000, 10000, 0);

-- Add position_size_usd to trades for USD tracking
ALTER TABLE trades ADD COLUMN position_size_usd NUMERIC DEFAULT 0;
ALTER TABLE trades ADD COLUMN pnl_usd NUMERIC DEFAULT 0;

-- RLS
ALTER TABLE DEPRECATED_bankroll ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_DEPRECATED_bankroll" ON DEPRECATED_bankroll FOR SELECT TO anon USING (true);
CREATE POLICY "anon_update_DEPRECATED_bankroll" ON DEPRECATED_bankroll FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "service_all_DEPRECATED_bankroll" ON DEPRECATED_bankroll FOR ALL TO service_role USING (true);
