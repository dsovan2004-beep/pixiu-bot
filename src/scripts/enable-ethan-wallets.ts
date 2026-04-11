/**
 * PixiuBot — Re-enable Ethan Wallets as Tier 2
 * Usage: npx tsx src/scripts/enable-ethan-wallets.ts
 */

import supabase from "../lib/supabase-server";

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Re-enable Ethan Wallets");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Count currently disabled tier 2 wallets
  const { data: disabled } = await supabase
    .from("tracked_wallets")
    .select("id")
    .eq("active", false)
    .eq("tier", 2);

  if (!disabled || disabled.length === 0) {
    console.log("  No disabled Tier 2 wallets found.\n");
    return;
  }

  // Re-activate in batches of 100
  let enabled = 0;
  for (let i = 0; i < disabled.length; i += 100) {
    const batch = disabled.slice(i, i + 100);
    const ids = batch.map((w) => w.id);

    const { error } = await supabase
      .from("tracked_wallets")
      .update({ active: true })
      .in("id", ids);

    if (error) {
      console.error(`  [ERROR] Batch ${Math.floor(i / 100) + 1}: ${error.message}`);
    } else {
      enabled += batch.length;
    }
  }

  const { count: totalActive } = await supabase
    .from("tracked_wallets")
    .select("id", { count: "exact", head: true })
    .eq("active", true);

  console.log(`  [ENABLE] Re-activated ${enabled} Ethan wallets as Tier 2`);
  console.log(`  [ENABLE] Total active: ${totalActive}\n`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
