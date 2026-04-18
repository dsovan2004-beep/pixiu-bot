import "../lib/supabase-server"; // loads dotenv
import { sellToken } from "../lib/jupiter-swap";

const ORPHANED_MINTS = [
  "7voyyzYZVgZSmpzVqVZekmyZMtz1u7Cn29b84bVpump",
  "zkYoahVVSFnpDsVQE9BM5PSftL52shV7hmXRcdbpump",
  "2XTTR6X34kJPnxjqsmdPvHEsxrnxdbMgkCvr7WbHpump",
  "2dtacbcSnd9x4Sm2DsqCejWMMHfJTJRhbSmRBMdWmDER",
  "J3qDQp144QeX7twY1s8WNUYuryhcPdAq6GufrksaRaHQ",
  "CAjtTHvC878f8cZ4zEwdvgjkjFM7rbYN8Mb1go1cpump",
  "CPVREa4FszLRsefCB23iJGRFpPkHNvUZDusF53FDpump",
  "2nP9yKQNSGQy851iyawDvBkzkK2R2aqKArQCKc2gpump",
  "9rHabU29b5wAZcVJ9FYWg7HnTvNRRpniWbbPcbkppump",
  "98oXBs8bwb5b7L2k8thZDr3S2ub4H5vDNjLm7uvpump",
  "5aoXBDkHpGoWPy6eeLRcLSYAbtBZpruCbCCKkVGipump",
  "2srNqf7i8xQHgS6EepmATfRKkzhY1cEsUkk9cReCpump",
  "FYRrPQyL63bZSuXLZLsshpKkpSnvC6Mpoyw58Fhqpump",
  "3auQupLiRs4RCa4MAWUYvGvq1Ei9tMHcdCX1DUAypump",
  "5Zp8PQ4ur9uUaC2vxbQyvYDhqkWLjpjsB988bbqFpump",
  "5g6qFHdVUB3TLY9PUjpvTahr7tnWRwd8NWtMKaBcpump",
  "66FDidvGz4V9MPNWpKrKJRtuwiRNt243VUg9TSKxpump",
  "8M7fgnMn5eYnSGaM2V1EFrH3WeMHJbNWyGN7qKtspump",
];

async function main() {
  console.log(`\nSelling ${ORPHANED_MINTS.length} remaining orphaned tokens...\n`);
  let sold = 0;
  let failed = 0;
  for (const mint of ORPHANED_MINTS) {
    console.log(`[${sold + failed + 1}/${ORPHANED_MINTS.length}] Selling ${mint.slice(0, 8)}...`);
    try {
      const sig = await sellToken(mint);
      if (sig) {
        console.log(`  ✅ Sold\n`);
        sold++;
      } else {
        console.log(`  ❌ Failed\n`);
        failed++;
      }
    } catch (err: any) {
      console.log(`  ❌ Error: ${err.message}\n`);
      failed++;
    }
    // 3s between sells to avoid rate limits
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`\nDone: ${sold} sold, ${failed} failed`);
}

main().catch(console.error);
