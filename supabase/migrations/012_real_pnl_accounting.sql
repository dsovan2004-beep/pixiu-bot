-- Sprint 9 P0 — Real PnL accounting
--
-- Problem: paper_trades.pnl_pct / pnl_usd are derived from DexScreener
-- mid-price at close time. Jupiter sells slip, fail, or confirm at
-- different prices. 5.4 SOL phantom gap between paper math and wallet.
--
-- This migration adds two columns that record REAL on-chain SOL
-- movements parsed from Jupiter tx.meta:
--   entry_sol_cost — actual SOL spent on the buy (including fees + slippage)
--   real_pnl_sol   — solReceived - entry_sol_cost (net SOL outcome)
--
-- Both nullable. Legacy rows stay NULL and are treated as "pre-real-
-- accounting era" — do not attempt to backfill without the tx signatures,
-- which were not persisted pre-Sprint 9.

ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS entry_sol_cost NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS real_pnl_sol   NUMERIC NULL;

-- Also persist the Jupiter tx signatures for forensic lookup + future
-- backfill of recent trades. Nullable — legacy rows stay NULL.
ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS buy_tx_sig  TEXT NULL,
  ADD COLUMN IF NOT EXISTS sell_tx_sig TEXT NULL;

COMMENT ON COLUMN paper_trades.entry_sol_cost IS 'Real SOL spent on Jupiter buy, parsed from tx.meta.postBalances - preBalances. Includes fees + slippage. Null for pre-Sprint-9 trades.';
COMMENT ON COLUMN paper_trades.real_pnl_sol   IS 'Net SOL outcome of the round trip: solReceivedFromSell - entry_sol_cost. The authoritative P&L number. Null for pre-Sprint-9 trades.';
COMMENT ON COLUMN paper_trades.buy_tx_sig     IS 'Jupiter buy transaction signature, persisted on successful confirmation for forensic lookup.';
COMMENT ON COLUMN paper_trades.sell_tx_sig    IS 'Jupiter sell transaction signature. Overwritten on each retry — final write = actually-confirmed tx.';
