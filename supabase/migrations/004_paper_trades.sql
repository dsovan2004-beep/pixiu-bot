-- Sprint 2: Paper trading engine

CREATE TABLE paper_trades (
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
CREATE INDEX idx_paper_trades_status ON paper_trades (status);
CREATE INDEX idx_paper_trades_entry_time ON paper_trades (entry_time DESC);
CREATE INDEX idx_paper_trades_coin ON paper_trades (coin_address, status);

-- RLS
ALTER TABLE paper_trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_paper_trades" ON paper_trades FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_paper_trades" ON paper_trades FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_paper_trades" ON paper_trades FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "service_all_paper_trades" ON paper_trades FOR ALL TO service_role USING (true);
