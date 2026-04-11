/**
 * PixiuBot — Disable Ethan Wallets, Keep Kolscan Elite Only
 * Usage: npx tsx src/scripts/disable-ethan-wallets.ts
 */

import supabase from "../lib/supabase-server";

const KOLSCAN_ELITE = [
  "CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o",
  "Bi4rd5FH5bYEN8scZ7wevxNZyNmKHdaBcvewdPFxYdLt",
  "5B79fMkcFeRTiwm7ehsZsFiKsC7m7n1Bgv9yLxPp9q2X",
  "AuPp4YTMTyqxYXQnHc5KUc6pUuCSsHQpBJhgnD45yqrf",
  "5t9xBNuDdGTGpjaPTx6hKd7sdRJbvtKS8Mhq6qVbo8Qz",
  "78N177fzNJpp8pG49xDv1efYcTMSzo9tPTKEA9mAVkh2",
  "BTf4A2exGK9BCVDNzy65b9dUzXgMqB4weVkvTMFQsadd",
  "Be24Gbf5KisDk1LcWWZsBn8dvB816By7YzYF5zWZnRR6",
  "gangJEP5geDHjPVRhDS5dTF5e6GtRvtNogMEEVs91RV",
  "PMJA8UQDyWTFw2Smhyp9jGA6aTaP7jKHR7BPudrgyYN",
  "AGqjivJr1dSv73TVUvdtqAwogzmThzvYMVXjGWg2FYLm",
  "2e1w3Xo441Ytvwn54wCn8itAXwCKbiizc9ynGEv14Vis",
  "4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9",
  "4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk",
  "4cXnf2z85UiZ5cyKsPMEULq1yufAtpkatmX4j4DBZqj2",
  "Hw5UKBU5k3YudnGwaykj5E8cYUidNMPuEewRRar5Xoc7",
  "G6fUXjMKPJzCY1rveAE6Qm7wy5U3vZgKDJmN1VPAdiZC",
  "6TAHDM5Tod7dBTZdYQxzgJZKxxPfiNV9udPHMiUNumyK",
  "DEdEW3SMPU2dCfXEcgj2YppmX9H3bnMDJaU4ctn2BQDQ",
  "J9TYAsWWidbrcZybmLSfrLzryANf4CgJBLdvwdGuC8MB",
  "4fZFcK8ms3bFMpo1ACzEUz8bH741fQW4zhAMGd5yZMHu",
];

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Disable Ethan Wallets, Keep Kolscan Elite");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Count active wallets before
  const { count: beforeCount } = await supabase
    .from("tracked_wallets")
    .select("id", { count: "exact", head: true })
    .eq("active", true);

  // Disable all wallets NOT in the elite list
  // Supabase JS doesn't support NOT IN directly, so fetch all active non-elite and disable in batches
  const { data: allActive } = await supabase
    .from("tracked_wallets")
    .select("id, wallet_address, tag")
    .eq("active", true);

  if (!allActive) {
    console.error("  [ERROR] Failed to fetch wallets");
    process.exit(1);
  }

  const eliteSet = new Set(KOLSCAN_ELITE);
  const toDisable = allActive.filter((w) => !eliteSet.has(w.wallet_address));
  const toKeep = allActive.filter((w) => eliteSet.has(w.wallet_address));

  // Disable in batches of 100
  let disabled = 0;
  for (let i = 0; i < toDisable.length; i += 100) {
    const batch = toDisable.slice(i, i + 100);
    const ids = batch.map((w) => w.id);

    const { error } = await supabase
      .from("tracked_wallets")
      .update({ active: false })
      .in("id", ids);

    if (error) {
      console.error(`  [ERROR] Batch ${Math.floor(i / 100) + 1}: ${error.message}`);
    } else {
      disabled += batch.length;
    }
  }

  // Verify final count
  const { count: afterCount } = await supabase
    .from("tracked_wallets")
    .select("id", { count: "exact", head: true })
    .eq("active", true);

  console.log(`  [DISABLE] Disabled ${disabled} Ethan wallets`);
  console.log(`  [KEEP] Kept ${toKeep.length} Kolscan elite wallets active:`);
  for (const w of toKeep) {
    console.log(`    ${w.tag.padEnd(16)} ${w.wallet_address.slice(0, 12)}...`);
  }
  console.log(`  [TOTAL] Active wallets: ${beforeCount} → ${afterCount}\n`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
