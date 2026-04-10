-- Sprint 2.4: Wallet quality tiers

ALTER TABLE tracked_wallets ADD COLUMN tier INT NOT NULL DEFAULT 2;
CREATE INDEX idx_tracked_wallets_tier ON tracked_wallets (tier) WHERE active = true;
