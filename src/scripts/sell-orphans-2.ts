import "../lib/supabase-server";
import { sellToken } from "../lib/jupiter-swap";

const ORPHANED_MINTS = [
  "2dtacbcSnd9x4Sm2DsqCejWMMHfJTJRhbSmRBMdWmDER",   // doge meme
  "4TSi7kVohcpKMcxHjArskKYj7v3xZAhgepxQGK2kpump",   // דנג יהודי
];

async function main() {
  console.log(`\nRetrying ${ORPHANED_MINTS.length} failed sells...\n`);
  for (const mint of ORPHANED_MINTS) {
    console.log(`--- Selling ${mint.slice(0,8)}... ---`);
    try {
      const sig = await sellToken(mint);
      if (sig) { console.log(`  ✅ Sold: ${sig}\n`); }
      else { console.log(`  ❌ Failed\n`); }
    } catch (err: any) { console.log(`  ❌ Error: ${err.message}\n`); }
    await new Promise(r => setTimeout(r, 5000));
  }
}
main().catch(console.error);
