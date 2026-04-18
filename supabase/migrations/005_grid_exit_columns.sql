-- Sprint 2.1: Grid exit strategy columns

ALTER TABLE trades ADD COLUMN grid_level INT NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN remaining_pct FLOAT NOT NULL DEFAULT 100;
ALTER TABLE trades ADD COLUMN partial_pnl FLOAT NOT NULL DEFAULT 0;
