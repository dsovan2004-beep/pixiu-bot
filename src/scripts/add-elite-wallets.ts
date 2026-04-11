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
  // Batch 3
  { address: "8deJ9xeUvXSJwicYptA9mHsU2rN2pDx37KWzkDkEXhU6", tag: "Cooker" },
  { address: "F42jFMmnH5JhW5Qib7cGZX18Qc59bEQ1q2fcQRWopump", tag: "elite_1" },
  { address: "53GeYgJLaDVCbuRRwwztT51yQsS68u5aUKrUiaTxpump", tag: "elite_2" },
  { address: "DKQn3DfrmM7acJwWx8D5eDZ4mzmhGFyJ8DFjSAqMpump", tag: "elite_3" },
  { address: "HXGNWyeiMXNrW9zts8pe9NtcuHRCeTop2wHFXUJLpump", tag: "elite_4" },
  { address: "35zCVZqst3vKGc7b3RMkbBRbdSowo8UAuGMS9denpump", tag: "elite_5" },
  // Batch 4 — Kolscan weekly leaderboard
  { address: "EaVboaPxFCYanjoNWdkxTbPvt57nhXGu5i6m9m6ZS2kK", tag: "danny" },
  { address: "4PsbR8MrE4dxN11Jj4gf4rAntKss2Kd4BQbGv7uopump", tag: "elite_6" },
  { address: "EhM5Q8puFsAW692BaXrU9aTeKB6S4712DEXVee6Tpump", tag: "elite_7" },
  { address: "A3W8psibkTUvjxs4LRscbnjux6TFDXdvD4m4GsGpQ2KJ", tag: "Numer0" },
  { address: "2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f", tag: "Cupsey" },
  { address: "4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t", tag: "Mitch" },
  { address: "5RQEcWJZdhkxRMbwjSq32RaocgYPaWDhi3ztimWUcrwo", tag: "EvansOfWeb" },
  { address: "6EDaVsS6enYgJ81tmhEkiKFcb4HuzPUVFZeom6PHUqN3", tag: "Cowboy" },
  { address: "64ymeD9XTAkNJgHtXgrG6JCNZmBC9fSVcmgkL54pFikE", tag: "Phineas.SOL" },
  // Batch 5 — GMGN Smart Money
  { address: "5dd3zjBQQvQqtmWF67nR6XaRKe79cYu4fP6LFXZ1YRR9", tag: "GMGN_SM_1" },
  { address: "J3Ez1WjZMpcnMua4xA9nirZwWTurAxY7wqhm4vPeJ8k5", tag: "GMGN_SM_2" },
  { address: "B3b1rDyViWRbnnXWHytpVJNmMRgNRMvMaADmpbn3EMYx", tag: "GMGN_SM_3" },
  { address: "7q15WZ4iSUDvqfs5Kdh9bfptkQhs6qKUyCUq6GY6PGxg", tag: "GMGN_SM_4" },
  { address: "6Dt9J7TXM3eqyQBAZMbGJCV6VsP13WVStwPJnLPFtw2Y", tag: "GMGN_SM_5" },
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
