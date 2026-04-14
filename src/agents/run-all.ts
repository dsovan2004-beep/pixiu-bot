/**
 * PixiuBot — Sprint 3 Swarm Runner
 * Usage: npx tsx src/agents/run-all.ts
 *
 * Starts all 5 agents in parallel.
 * Runs alongside existing webhook + paper-trader until validated.
 */

import { startWalletWatcher } from "./wallet-watcher";
import { startSignalValidator } from "./signal-validator";
import { startPriceScout } from "./price-scout";
import { startTradeExecutor } from "./trade-executor";
import { startRiskGuard } from "./risk-guard";
import { startTierManager } from "./tier-manager";

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Sprint 3 Agent Swarm");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Agent 1: Wallet Watcher   — coin_signals → pixiubot:signals");
  console.log("  Agent 2: Signal Validator — pixiubot:signals → pixiubot:entries");
  console.log("  Agent 3: Price Scout      — pixiubot:entries → pixiubot:confirmed");
  console.log("  Agent 4: Trade Executor   — pixiubot:confirmed → paper_trades");
  console.log("  Agent 5: Risk Guard       — paper_trades polling (5s)");
  console.log("  Agent 6: Tier Manager     — auto-demote/promote T1↔T2");
  console.log("  Bus:     Supabase Realtime broadcast channels");
  console.log("  Mode:    PAPER ONLY — parallel with Sprint 2");
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Start all 6 agents in parallel
  await Promise.all([
    startWalletWatcher(),
    startSignalValidator(),
    startPriceScout(),
    startTradeExecutor(),
    startRiskGuard(),
    startTierManager(),
  ]);

  console.log("\n  [SWARM] All 6 agents running. Ctrl+C to stop.\n");

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n  [SWARM] Shutting down all agents...");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Swarm startup failed:", err);
  process.exit(1);
});
