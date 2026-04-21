// Emergency stop — sets bot_state.is_running = false in Supabase.
// Effects:
//   - Webhook guard #1 (webhookIsBotRunning) rejects ALL new entries
//   - Trade executor won't process pending buys
//   - Risk guard STILL runs, still exits open positions cleanly
//   - Wallet watcher keeps accumulating coin_signals data for later analysis
//
// To resume: run start-bot.ts OR flip the dashboard toggle.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";

async function main() {
  const env = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  const map: Record<string, string> = {};
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const sb = createClient(
    map.NEXT_PUBLIC_SUPABASE_URL!,
    map.SUPABASE_SERVICE_ROLE_KEY || map.SUPABASE_ANON_KEY || map.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  // Read current state
  const { data: before } = await sb
    .from("bot_state")
    .select("*")
    .limit(1)
    .single();
  console.log("Before:", JSON.stringify(before, null, 2));

  // Flip to stopped
  const { data: updated, error } = await sb
    .from("bot_state")
    .update({ is_running: false })
    .eq("id", before?.id ?? 1)
    .select("*")
    .single();

  if (error) {
    console.error("Update failed:", error.message);
    process.exit(1);
  }
  console.log("\nAfter:", JSON.stringify(updated, null, 2));

  if (updated?.is_running === false) {
    console.log("\n✅ Bot stopped. Webhook will reject new entries.");
    console.log("   Open positions still monitored by risk-guard.");
    console.log("   To resume: npx tsx src/scripts/start-bot.ts (or flip dashboard toggle)");
  } else {
    console.log("\n⚠️  Unexpected state — is_running is not false:", updated?.is_running);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
