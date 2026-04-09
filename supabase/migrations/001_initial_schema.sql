-- PixiuBot Sprint 0: Initial Schema
-- Observe-only mode — no trading logic

-- Tracked wallets to monitor on-chain
CREATE TABLE tracked_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT NOT NULL UNIQUE,
  tag TEXT NOT NULL DEFAULT 'unknown',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Signals detected from wallet activity
CREATE TABLE coin_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_address TEXT NOT NULL,
  coin_name TEXT,
  wallet_tag TEXT NOT NULL,
  entry_mc NUMERIC,
  signal_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  rug_check_passed BOOLEAN,
  price_gap_minutes INTEGER
);

-- Trades (observe-only for now — no rows will be inserted in Sprint 0)
CREATE TABLE trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_address TEXT NOT NULL,
  entry_price NUMERIC,
  exit_price NUMERIC,
  entry_mc NUMERIC,
  pnl NUMERIC,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bot state singleton
CREATE TABLE bot_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  is_running BOOLEAN NOT NULL DEFAULT false,
  mode TEXT NOT NULL DEFAULT 'observe',
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default bot state
INSERT INTO bot_state (is_running, mode) VALUES (false, 'observe');

-- Indexes
CREATE INDEX idx_tracked_wallets_active ON tracked_wallets (active) WHERE active = true;
CREATE INDEX idx_coin_signals_time ON coin_signals (signal_time DESC);
CREATE INDEX idx_trades_status ON trades (status);
