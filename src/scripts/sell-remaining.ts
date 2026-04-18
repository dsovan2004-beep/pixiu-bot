import "../lib/supabase-server";
import { sellToken } from "../lib/jupiter-swap";

const REMAINING = [
  "7voyyzYZVgZSmpzVqVZekmyZMtz1u7Cn29b84bVpump",
  "zkYoahVVSFnpDsVQE9BM5PSftL52shV7hmXRcdbpump",
  "J3qDQp144QeX7twY1s8WNUYuryhcPdAq6GufrksaRaHQ",
  "9rHabU29b5wAZcVJ9FYWg7HnTvNRRpniWbbPcbkppump",
  "98oXBs8bwb5b7L2k8thZDr3S2ub4H5vDNjLm7uvpump",
  "5aoXBDkHpGoWPy6eeLRcLSYAbtBZpruCbCCKkVGipump",
  "3auQupLiRs4RCa4MAWUYvGvq1Ei9tMHcdCX1DUAypump",
  "5Zp8PQ4ur9uUaC2vxbQyvYDhqkWLjpjsB988bbqFpump",
  "66FDidvGz4V9MPNWpKrKJRtuwiRNt243VUg9TSKxpump",
];

async function main() {
  console.log(`\nSelling ${REMAINING.length} remaining tokens...\n`);
  let sold = 0, failed = 0;
  for (const mint of REMAINING) {
    console.log(`[${sold+failed+1}/${REMAINING.length}] ${mint.slice(0,8)}...`);
    try {
      const sig = await sellToken(mint);
      if (sig) { console.log(`  ✅ Sold\n`); sold++; }
      else { console.log(`  ❌ Failed\n`); failed++; }
    } catch (err: any) { console.log(`  ❌ ${err.message}\n`); failed++; }
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log(`\nDone: ${sold} sold, ${failed} failed`);
}
main().catch(console.error);
