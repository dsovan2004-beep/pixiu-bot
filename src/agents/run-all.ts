/**
 * PixiuBot — Sprint 3 Swarm Runner
 * Usage: npx tsx src/agents/run-all.ts
 *
 * Starts all 5 agents in parallel.
 * Runs alongside existing webhook + paper-trader until validated.
 */

import supabase from "../lib/supabase-server";
import { startWalletWatcher } from "./wallet-watcher";
import { startTradeExecutor } from "./trade-executor";
import { startRiskGuard } from "./risk-guard";
import { startTierManager } from "./tier-manager";

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Sprint 3 Agent Swarm");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Agent 1: Wallet Watcher   — coin_signals → pixiubot:signals");
  console.log("  Agent 2: Trade Executor   — paper_trades polling (3s)");
  console.log("  Agent 3: Risk Guard       — paper_trades polling (5s)");
  console.log("  Agent 4: Tier Manager     — auto-demote/promote T1↔T2");
  console.log("  Bus:     Supabase Realtime broadcast channels");
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
