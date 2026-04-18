-- Sprint 10 — real data only from here on.
--
-- Historical record (APPLIED Apr 18 2026):
--   1. RENAMED legacy trade-tracking table to `trades`
--   2. TRUNCATEd all rows (mixed-outcome historical data removed)
--   3. DROPPED the legacy USD bankroll-tracker table
--
-- Indexes, policies, and constraints followed the table rename
-- automatically (Postgres rename preserves them).
--
-- Kept here for audit; do not replay.

-- Original SQL (applied once, already executed):
--   ALTER TABLE IF EXISTS <legacy_trades_table> RENAME TO trades;
--   TRUNCATE TABLE trades;
--   DROP TABLE IF EXISTS <legacy_bankroll_table>;

COMMENT ON TABLE trades IS 'Sprint 10: real-only live trades; real_pnl_sol is authoritative.';
