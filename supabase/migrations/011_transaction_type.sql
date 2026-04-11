-- Whale exit detection: track BUY vs SELL signals
ALTER TABLE coin_signals ADD COLUMN transaction_type TEXT NOT NULL DEFAULT 'BUY';
CREATE INDEX idx_coin_signals_type ON coin_signals (coin_address, transaction_type, signal_time);
