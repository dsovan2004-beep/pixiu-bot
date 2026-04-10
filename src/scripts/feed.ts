/**
 * PixiuBot — Webhook Mode (Sprint 2)
 * Usage: npx tsx src/scripts/feed.ts
 *
 * In webhook mode, Helius pushes transactions to /api/webhook.
 * This script just updates bot_state and stays alive.
 * The actual signal processing happens in the API route.
 *
 * Run setup-webhook.ts first to register the Helius webhook.
 */

import supabase from "../lib/supabase-server";

const HEARTBEAT_MS = 60_000; // Update bot_state every 60s

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Webhook Mode (Sprint 2)");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Mode:      WEBHOOK — Helius pushes transactions to us`);
  console.log(`  Endpoint:  https://pixiu-bot.pages.dev/api/webhook`);
  console.log(`  Polling:   NONE — zero API calls, zero rate limits`);
  console.log(`  Heartbeat: Every ${HEARTBEAT_MS / 1000}s`);
  console.log(`  Started:   ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════════════════════════\n");
  console.log("  [WEBHOOK MODE] Listening for Helius push notifications");
  console.log("  Signals are processed at /api/webhook on Cloudflare Edge\n");

  // Set bot state to running
  await supabase
    .from("bot_state")
    .update({ is_running: true, mode: "webhook", last_updated: new Date().toISOString() })
    .eq("mode", "observe");

  // Also try matching webhook mode
  await supabase
    .from("bot_state")
    .update({ is_running: true, last_updated: new Date().toISOString() })
    .eq("mode", "webhook");

  // Heartbeat: keep bot_state fresh so dashboard knows we're alive
  setInterval(async () => {
    const now = new Date().toISOString();
    await supabase
      .from("bot_state")
      .update({ is_running: true, last_updated: now })
      .eq("is_running", true);

    // Print signal count for monitoring
    const { count } = await supabase
      .from("coin_signals")
      .select("id", { count: "exact", head: true });

    console.log(`  [HEARTBEAT] ${now} | Total signals: ${count}`);
  }, HEARTBEAT_MS);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n  [SHUTDOWN] Stopping...");
    await supabase
      .from("bot_state")
      .update({ is_running: false, last_updated: new Date().toISOString() })
      .eq("is_running", true);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Feed failed:", err);
  process.exit(1);
});
