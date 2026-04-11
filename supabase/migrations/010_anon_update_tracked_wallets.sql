-- Allow anon to update tracked_wallets (for disable/tier scripts)
CREATE POLICY "anon_update_tracked_wallets" ON tracked_wallets FOR UPDATE TO anon USING (true) WITH CHECK (true);
