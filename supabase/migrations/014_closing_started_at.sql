-- Sprint 10 P0 — fix reaper flip-flop bug observed on Yoshi (Apr 18 2026).
--
-- Previous reaper used `entry_time < now() - 5min` as the "stuck in closing"
-- signal. But entry_time is fixed at buy — it tells you nothing about how
-- long the row has been in `closing` state. Any trade > 5 min old that
-- entered closing would IMMEDIATELY be eligible for reaping on the very
-- next poll cycle.
--
-- Race:
--   L0 poll   : claim open→closing, start async hasTokenBalance (~1-3s)
--   L1+ poll  : reaper sees status='closing' AND entry_time>5min, reverts → open
--   L0 poll   : balance=0, tries idempotent close on status='closing' → 0 rows
--               → logs "already closed/credited", returns without closing
--   Next poll : row is 'open' again, stop_loss fires, loop repeats
--
-- Yoshi was stuck in this loop: stop_loss fired every cycle at +14.56%
-- but never actually closed. Position appears perpetually in open list.
--
-- Fix: dedicated timestamp for when the close started. Reaper checks that.

ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS closing_started_at timestamptz;

COMMENT ON COLUMN paper_trades.closing_started_at IS
  'Sprint 10 P0: set when risk-guard claims open→closing. Reaper uses this to detect truly stuck sells (>5min) without racing against in-flight closes.';
