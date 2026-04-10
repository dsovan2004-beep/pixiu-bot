/**
 * PixiuBot — Update Wallet Tiers
 * Usage: npx tsx src/scripts/update-wallet-tiers.ts
 *
 * Reads wallet_quality.json and updates tracked_wallets table.
 * Deactivates Tier 3 wallets.
 * Run after analyze-wallets.ts.
 */

import fs from "fs";
import path from "path";
import supabase from "../lib/supabase-server";

interface WalletQuality {
  wallet_tag: string;
  tier: 1 | 2 | 3;
  tier_reason: string;
  total_signals: number;
}

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Update Wallet Tiers");
  console.log("═══════════════════════════════════════════════════════════\n");

  const filePath = path.resolve(__dirname, "../../wallet_quality.json");
  if (!fs.existsSync(filePath)) {
    console.error("  [ERROR] wallet_quality.json not found. Run analyze-wallets.ts first.");
    process.exit(1);
  }

  const data: WalletQuality[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  console.log(`  Loaded ${data.length} wallet ratings\n`);

  let updated = 0;
  let deactivated = 0;
  let errors = 0;

  // Batch by tier for efficiency
  for (const tier of [1, 2, 3] as const) {
    const wallets = data.filter((w) => w.tier === tier);
    const tags = wallets.map((w) => w.wallet_tag);

    if (tags.length === 0) continue;

    // Update tier
    const { error: tierErr } = await supabase
      .from("tracked_wallets")
      .update({ tier })
      .in("tag", tags);

    if (tierErr) {
      console.error(`  [ERROR] Tier ${tier} update:`, tierErr.message);
      errors++;
    } else {
      updated += tags.length;
      console.log(`  [OK] Tier ${tier}: ${tags.length} wallets updated`);
    }

    // Deactivate Tier 3
    if (tier === 3) {
      const { error: deactErr } = await supabase
        .from("tracked_wallets")
        .update({ active: false })
        .in("tag", tags);

      if (deactErr) {
        console.error("  [ERROR] Deactivate:", deactErr.message);
        errors++;
      } else {
        deactivated = tags.length;
        console.log(`  [DEACTIVATED] ${tags.length} Tier 3 wallets set active=false`);
      }
    }
  }

  // Get final active count
  const { count: activeCount } = await supabase
    .from("tracked_wallets")
    .select("id", { count: "exact", head: true })
    .eq("active", true);

  const { count: tier1Count } = await supabase
    .from("tracked_wallets")
    .select("id", { count: "exact", head: true })
    .eq("active", true)
    .eq("tier", 1);

  console.log(`\n  [UPDATE] Updated ${updated} wallets | Deactivated ${deactivated} Tier3`);
  console.log(`  [UPDATE] Active wallets: ${activeCount} (${tier1Count} Tier 1)`);
  if (errors > 0) console.log(`  [WARN] ${errors} errors occurred`);
  console.log("");
}

main().catch((err) => {
  console.error("Update failed:", err);
  process.exit(1);
});
