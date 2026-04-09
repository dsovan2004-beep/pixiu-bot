-- Sprint 1: Allow anon writes for feed.ts script and dashboard start/stop

-- Anon can insert signals (feed.ts)
CREATE POLICY "anon_insert_coin_signals" ON coin_signals FOR INSERT TO anon WITH CHECK (true);

-- Anon can update bot_state (dashboard start/stop + feed.ts)
CREATE POLICY "anon_update_bot_state" ON bot_state FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- Anon can insert tracked_wallets (import-wallets.ts)
CREATE POLICY "anon_insert_tracked_wallets" ON tracked_wallets FOR INSERT TO anon WITH CHECK (true);
