-- Enable RLS and add read policies for anon (dashboard)

ALTER TABLE bot_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE coin_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;

-- Anon can read all tables (dashboard is read-only)
CREATE POLICY "anon_read_bot_state" ON bot_state FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_coin_signals" ON coin_signals FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_tracked_wallets" ON tracked_wallets FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_trades" ON trades FOR SELECT TO anon USING (true);

-- Service role can do everything (feed.ts script)
CREATE POLICY "service_all_bot_state" ON bot_state FOR ALL TO service_role USING (true);
CREATE POLICY "service_all_coin_signals" ON coin_signals FOR ALL TO service_role USING (true);
CREATE POLICY "service_all_tracked_wallets" ON tracked_wallets FOR ALL TO service_role USING (true);
CREATE POLICY "service_all_trades" ON trades FOR ALL TO service_role USING (true);
