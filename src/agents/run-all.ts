/**
 * PixiuBot — Swarm Runner
 * Usage: npx tsx src/agents/run-all.ts
 *
 * Starts all 4 agents in parallel. Runs alongside the Next.js webhook.
 */

import supabase from "../lib/supabase-server";
import { startWalletWatcher } from "./wallet-watcher";
import { startTradeExecutor } from "./trade-executor";
import { startRiskGuard } from "./risk-guard";
import { startTierManager } from "./tier-manager";

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Agent Swarm");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Agent 1: Wallet Watcher   — polls coin_signals (3s)");
  console.log("  Agent 2: Trade Executor   — polls trades for buys (3s)");
  console.log("  Agent 3: Risk Guard       — polls open positions (L0 2s / L1+ 5s)");
  console.log("  Agent 4: Tier Manager     — auto-demote/promote T1↔T2");
  console.log("  Trading: 24/7 | Rug Storm Protection: ON");
  console.log("  Mode:    LIVE TRADING — real Jupiter swaps ON");
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Start all 4 agents in parallel.
  // Signal Validator + Price Scout removed — their guards now live
  // inline in src/app/api/webhook/route.ts evaluateAndEnter().
  await Promise.all([
    startWalletWatcher(),
    startTradeExecutor(),
    startRiskGuard(),
    startTierManager(),
  ]);

  // Preserve existing bot_state — don't override dashboard STOP
  const { data: currentState } = await supabase
    .from("bot_state")
    .select("is_running")
    .limit(1)
    .single();
  const isRunning = currentState?.is_running ?? true;
  console.log(`\n  [SWARM] All 4 agents running. bot_state preserved: ${isRunning ? "RUNNING" : "STOPPED"}. Ctrl+C to stop.\n`);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    // Do NOT write is_running=false on SIGINT. bot_state is user intent
    // (dashboard START/STOP button), not process state. Clobbering it on
    // Ctrl+C forces a manual START click on every swarm restart and
    // makes restart indistinguishable from a real stop.
    //
    // If the user wants to halt trading, they click STOP on the
    // dashboard. If they just want to restart the local swarm, their
    // intent (RUNNING) should survive.
    console.log("\n  [SWARM] Shutting down all agents... bot_state preserved.");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Swarm startup failed:", err);
  process.exit(1);
});
