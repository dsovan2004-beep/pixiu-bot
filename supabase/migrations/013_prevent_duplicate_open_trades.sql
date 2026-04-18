-- Sprint 10 P0 — prevent webhook race duplicates
--
-- Today (Apr 18 2026) WHERE IS THE AIRDROP created 5 trades
-- rows within 230ms from a single Cupsey BUNDLE signal storm. The
-- webhook's "position already open" check is not race-safe: N
-- simultaneous requests all see count=0 before any commits, all
-- INSERT, and we end up with N duplicate rows. Guard treats them
-- independently → N phantom bankroll credits.
--
-- This partial unique index makes duplicate open-row INSERT fail at
-- the DB level. Webhook catches the error (already handled by the
-- existing "db error" branch) and skips the entry cleanly.
--
-- CLOSED and FAILED rows are allowed to share coin_address (re-entries
-- after cooldown are legitimate). Only the intersection status='open'
-- is constrained.

CREATE UNIQUE INDEX IF NOT EXISTS one_open_per_mint_idx
  ON trades(coin_address)
  WHERE status = 'open';

COMMENT ON INDEX one_open_per_mint_idx IS 'Sprint 10 P0: prevents webhook race from creating duplicate open rows for the same mint. Violating INSERT returns a unique-constraint error; webhook skips entry.';
