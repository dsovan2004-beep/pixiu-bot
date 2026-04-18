-- Allow anon to delete trades (for reset script)
CREATE POLICY "anon_delete_trades" ON trades FOR DELETE TO anon USING (true);
