import "../lib/supabase-server";
import { sellToken } from "../lib/jupiter-swap";

const MINT = process.argv[2];
if (!MINT) { console.error("Usage: npx tsx retry-stuck-sell.ts <mint>"); process.exit(1); }

(async () => {
  const sig = await sellToken(MINT);
  console.log(sig ? `✅ ${sig}` : `❌ failed`);
})();
