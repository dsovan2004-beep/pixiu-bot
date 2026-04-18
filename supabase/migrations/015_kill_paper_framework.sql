-- Sprint 10 — kill paper framework. Real data only from here on.
--
-- Renames:
--   paper_trades  → trades
-- Wipes:
--   all existing rows in trades (paper-mixed outcomes — starting clean
--   so every row from here forward has real_pnl_sol populated)
-- Drops:
--   paper_bankroll        (USD paper bankroll tracker)
--
-- Indexes, policies, and constraints on paper_trades follow the table
-- under the new name automatically (Postgres rename preserves them).
--
-- Run while bot is stopped.

BEGIN;

-- 1. Rename the main trades table (keeps indexes: one_open_per_mint_idx etc.)
ALTER TABLE IF EXISTS paper_trades RENAME TO trades;

-- 2. Wipe all pre-Sprint-10 trade history — it's polluted with paper outcomes
--    and phantom-buy rows. Starting clean with real-only data.
TRUNCATE TABLE trades;

-- 3. Drop the paper bankroll tracker entirely
DROP TABLE IF EXISTS paper_bankroll;

COMMIT;

COMMENT ON TABLE trades IS 'Sprint 10: renamed from paper_trades and wiped. Every row is a real live trade; real_pnl_sol is authoritative.';
