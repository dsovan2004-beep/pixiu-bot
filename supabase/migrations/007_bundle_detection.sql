-- Sprint 2.3: Bundle detection

ALTER TABLE coin_signals ADD COLUMN bundle_suspected BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX idx_coin_signals_bundle ON coin_signals (coin_address, wallet_tag, signal_time);
