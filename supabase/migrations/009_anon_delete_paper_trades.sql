-- Allow anon to delete paper_trades (for reset script)
CREATE POLICY "anon_delete_paper_trades" ON paper_trades FOR DELETE TO anon USING (true);
