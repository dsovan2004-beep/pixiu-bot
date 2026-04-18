import "../lib/supabase-server"; // loads dotenv + env vars
import { sellToken } from "../lib/jupiter-swap";

const ORPHANED_MINTS = [
  "5k8p6ktAW5TGje14EABQ5BbJkPU1eW1uucy1hXZDpump",
  "CB6Ydr85PQLULgeV7MXTtSrsJfr7686qmAGQxBh2pump",
  "2dtacbcSnd9x4Sm2DsqCejWMMHfJTJRhbSmRBMdWmDER",
  "4TSi7kVohcpKMcxHjArskKYj7v3xZAhgepxQGK2kpump",
  "AnGmBBKnEihmqvDuDBNMmGB19XznwJc8ywnTD2rY7fYi",
];

async function main() {
  console.log(`\nSelling ${ORPHANED_MINTS.length} orphaned tokens...\n`);
  let sold = 0;
  let failed = 0;
  for (const mint of ORPHANED_MINTS) {
    console.log(`--- Selling ${mint.slice(0,8)}... ---`);
    try {
      const sig = await sellToken(mint);
      if (sig) {
        console.log(`  ✅ Sold: ${sig}\n`);
        sold++;
      } else {
        console.log(`  ❌ Failed to sell\n`);
        failed++;
      }
    } catch (err: any) {
      console.log(`  ❌ Error: ${err.message}\n`);
      failed++;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log(`\nDone: ${sold} sold, ${failed} failed`);
}

main().catch(console.error);
