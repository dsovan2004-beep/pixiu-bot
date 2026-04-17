/**
 * Recover SOL from stuck sells discovered by check-stuck-sells.ts (Day 2).
 * Sells each mint via Jupiter, 3s delay between to avoid 429.
 */
import "../lib/supabase-server";
import { sellToken } from "../lib/jupiter-swap";

const STUCK_MINTS = [
  // closed-but-held (DB says sold, on-chain still holding)
  "3TYgKwkE2Y3rxdw9osLRSpxpXmSC1C1oo19W9KHspump", // Bull
  "DSZeB6pCzZsM43gTz7jakiYeCafinsNMKcpeB1FApump", // Wasabi Cheese
  "5M8iwnvwZVAAHq1qtYmrgYCzXzDjjCpFnrUYA3Vupump", // LOL Guy
  "98KnbbkmtvZ9duCYVZpvpYoBMnTEuZFhsVKXr5YF6Jjx", // jensoncore
  "98oXBs8bwb5b7L2k8thZDr3S2ub4H5vDNjLm7uvpump", // Sigmoid Markets
  "7Lbe787dJ4bxpPiEWLb9R9VnQsMiET6Gbacxedm3pump", // meowtakeover
  "9rPoaV7XE1uCYYGrFmzEX8Fa8kEVP3xDsdwypC5qpump", // yn
  "7mNWyQYJfvf5gJDVwXL8aw8m9Qmo4MDKrLHNaESdpump", // unt
  // pure orphans (no DB row)
  "CWiBLktjXbTV1LBacHxKHNvCdnwnxq6DE83y4m62UzJG",
  "Ahuh89D2cBxfmYAE2sjgDQzc7VfmjypH8MV6GHAUL38X",
];

async function main() {
  console.log(`\nRecovering ${STUCK_MINTS.length} stuck sells...\n`);
  let sold = 0;
  let failed = 0;
  const failedMints: string[] = [];

  for (let i = 0; i < STUCK_MINTS.length; i++) {
    const mint = STUCK_MINTS[i];
    console.log(`[${i + 1}/${STUCK_MINTS.length}] Selling ${mint.slice(0, 8)}...`);
    try {
      const sig = await sellToken(mint);
      if (sig) {
        console.log(`  ✅ Sold — ${sig}\n`);
        sold++;
      } else {
        console.log(`  ❌ Failed (no sig returned)\n`);
        failed++;
        failedMints.push(mint);
      }
    } catch (err: any) {
      console.log(`  ❌ Error: ${err.message}\n`);
      failed++;
      failedMints.push(mint);
    }
    if (i < STUCK_MINTS.length - 1) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  console.log(`\n=== DONE ===`);
  console.log(`Sold: ${sold}`);
  console.log(`Failed: ${failed}`);
  if (failedMints.length > 0) {
    console.log(`\nFailed mints (retry manually or via auto-slippage):`);
    failedMints.forEach((m) => console.log(`  ${m}`));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
