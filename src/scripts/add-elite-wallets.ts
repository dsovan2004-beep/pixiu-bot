/**
 * PixiuBot — Add Elite Wallets from Kolscan Leaderboard
 * Usage: npx tsx src/scripts/add-elite-wallets.ts
 */

import supabase from "../lib/supabase-server";

const ELITE_WALLETS = [
  { address: "CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o", tag: "Cented" },
  { address: "Bi4rd5FH5bYEN8scZ7wevxNZyNmKHdaBcvewdPFxYdLt", tag: "theo" },
  { address: "5B79fMkcFeRTiwm7ehsZsFiKsC7m7n1Bgv9yLxPp9q2X", tag: "bandit" },
  { address: "AuPp4YTMTyqxYXQnHc5KUc6pUuCSsHQpBJhgnD45yqrf", tag: "Dani" },
  { address: "5t9xBNuDdGTGpjaPTx6hKd7sdRJbvtKS8Mhq6qVbo8Qz", tag: "Smokez" },
  { address: "78N177fzNJpp8pG49xDv1efYcTMSzo9tPTKEA9mAVkh2", tag: "Sheep" },
  { address: "BTf4A2exGK9BCVDNzy65b9dUzXgMqB4weVkvTMFQsadd", tag: "Kev" },
  { address: "Be24Gbf5KisDk1LcWWZsBn8dvB816By7YzYF5zWZnRR6", tag: "Chairman" },
  { address: "gangJEP5geDHjPVRhDS5dTF5e6GtRvtNogMEEVs91RV", tag: "Qavec" },
  { address: "PMJA8UQDyWTFw2Smhyp9jGA6aTaP7jKHR7BPudrgyYN", tag: "chester" },
  { address: "AGqjivJr1dSv73TVUvdtqAwogzmThzvYMVXjGWg2FYLm", tag: "noob mini" },
  { address: "2e1w3Xo441Ytvwn54wCn8itAXwCKbiizc9ynGEv14Vis", tag: "prettyover" },
  { address: "4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9", tag: "decu" },
  // Batch 2
  { address: "4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk", tag: "Jijo" },
  { address: "4cXnf2z85UiZ5cyKsPMEULq1yufAtpkatmX4j4DBZqj2", tag: "WaiterG" },
  { address: "Hw5UKBU5k3YudnGwaykj5E8cYUidNMPuEewRRar5Xoc7", tag: "Trenchman" },
  { address: "G6fUXjMKPJzCY1rveAE6Qm7wy5U3vZgKDJmN1VPAdiZC", tag: "clukz" },
  { address: "6TAHDM5Tod7dBTZdYQxzgJZKxxPfiNV9udPHMiUNumyK", tag: "Bluey" },
  { address: "DEdEW3SMPU2dCfXEcgj2YppmX9H3bnMDJaU4ctn2BQDQ", tag: "King Solomon" },
  { address: "J9TYAsWWidbrcZybmLSfrLzryANf4CgJBLdvwdGuC8MB", tag: "Johnson" },
  { address: "4fZFcK8ms3bFMpo1ACzEUz8bH741fQW4zhAMGd5yZMHu", tag: "Rilsio" },
];

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Add Elite Wallets (Kolscan Top Traders)");
  console.log("═══════════════════════════════════════════════════════════\n");

  let added = 0;
  let updated = 0;
  let errors = 0;

  for (const wallet of ELITE_WALLETS) {
    // Check if wallet already exists
    const { data: existing } = await supabase
      .from("tracked_wallets")
      .select("id, tag, tier")
      .eq("wallet_address", wallet.address)
      .limit(1);

    if (existing && existing.length > 0) {
      // Update to tier 1
      const { error } = await supabase
        .from("tracked_wallets")
        .update({ tier: 1, active: true })
        .eq("wallet_address", wallet.address);

      if (error) {
        console.error(`  [ERROR] ${wallet.tag}: ${error.message}`);
        errors++;
      } else {
        const oldTier = existing[0].tier;
        console.log(`  [UPDATE] ${wallet.tag} (${wallet.address.slice(0, 8)}...) tier ${oldTier} → 1`);
        updated++;
      }
    } else {
      // Insert new
      const { error } = await supabase
        .from("tracked_wallets")
        .insert({
          wallet_address: wallet.address,
          tag: wallet.tag,
          active: true,
          tier: 1,
        });

      if (error) {
        console.error(`  [ERROR] ${wallet.tag}: ${error.message}`);
        errors++;
      } else {
        console.log(`  [NEW] ${wallet.tag} (${wallet.address.slice(0, 8)}...) added as Tier 1`);
        added++;
      }
    }
  }

  // Get final counts
  const { count: activeCount } = await supabase
    .from("tracked_wallets")
    .select("id", { count: "exact", head: true })
    .eq("active", true);

  const { count: tier1Count } = await supabase
    .from("tracked_wallets")
    .select("id", { count: "exact", head: true })
    .eq("active", true)
    .eq("tier", 1);

  console.log(`\n  [ELITE] Added ${added} new wallets | Updated ${updated} existing to Tier 1 | Errors: ${errors}`);
  console.log(`  [ELITE] Total active: ${activeCount} | Tier 1: ${tier1Count}\n`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
