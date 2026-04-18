-- Sprint 2: Trading engine schema

CREATE TABLE trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_address TEXT NOT NULL,
  coin_name TEXT,
  wallet_tag TEXT NOT NULL,
  entry_price NUMERIC NOT NULL,
  entry_mc NUMERIC,
  exit_price NUMERIC,
  exit_mc NUMERIC,
  pnl_pct NUMERIC,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',
  entry_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  exit_time TIMESTAMPTZ,
  exit_reason TEXT
);

-- Indexes
CREATE INDEX idx_trades_status ON trades (status);
CREATE INDEX idx_trades_entry_time ON trades (entry_time DESC);
CREATE INDEX idx_trades_coin ON trades (coin_address, status);

-- RLS
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_trades" ON trades FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_trades" ON trades FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_trades" ON trades FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "service_all_trades" ON trades FOR ALL TO service_role USING (true);
