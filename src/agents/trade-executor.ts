/**
 * PixiuBot Agent 4 — Trade Executor (Live Buy)
 *
 * Polls paper_trades every 3s for new open positions.
 * If live mode ON → fires Jupiter buy → tags [LIVE].
 * Webhook handles all entry logic (evaluateAndEnter).
 * This agent ONLY handles the live Jupiter buy layer.
 */

import supabase from "../lib/supabase-server";
import { buyToken } from "../lib/jupiter-swap";

const POLL_MS = 3_000;
const LIVE_BUY_SOL = 0.10;

async function isLiveTrading(): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("bot_state")
      .select("mode")
      .limit(1)
      .single();
    if (error || !data) return false;
    const dbLive = data.mode === "live";
    const envLive = process.env.LIVE_TRADING === "true";
    return dbLive || envLive;
  } catch {
    return false;
  }
}

// Track which trades we've already tried to buy
const processedTrades = new Set<string>();

export async function startTradeExecutor(): Promise<void> {
  const startLive = await isLiveTrading();
  console.log(`  [EXECUTOR] Starting trade executor... (LIVE: ${startLive ? "🔴 ON" : "⚪ OFF"} — dashboard controlled)`);

  // Poll for new open positions every 3s
  setInterval(async () => {
    try {
      // Check if bot is stopped via dashboard — MUST be first check
      const { data: botState } = await supabase.from("bot_state").select("is_running").limit(1).single();
      if (!botState || !botState.is_running) {
        return; // Bot stopped or DB error — do nothing
      }

      const live = await isLiveTrading();
      if (!live) return;

      // Find open positions NOT yet tagged [LIVE] and not already processed
      const { data: newTrades } = await supabase
        .from("paper_trades")
        .select("id, coin_address, coin_name, wallet_tag")
        .eq("status", "open")
        .not("wallet_tag", "like", "%[LIVE]%");

      if (!newTrades || newTrades.length === 0) return;

      for (const trade of newTrades) {
        // Skip if we already tried this one
        if (processedTrades.has(trade.id)) continue;
        processedTrades.add(trade.id);

        const coin = trade.coin_name || trade.coin_address.slice(0, 8) + "...";
        console.log(`  [EXECUTOR] New trade detected: ${coin} — attempting LIVE BUY...`);

        // Check daily loss limit — count losing LIVE trades × 0.10 SOL
        const todayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
        const { count: lossCount } = await supabase
          .from("paper_trades")
          .select("id", { count: "exact", head: true })
          .eq("status", "closed")
          .gte("exit_time", todayStart)
          .lt("pnl_pct", 0)
          .like("wallet_tag", "%[LIVE]%");
        const totalLossSol = (lossCount || 0) * 0.10;

        if (totalLossSol >= 2.0) {
          console.log(`  [EXECUTOR] 🛑 LIVE BUY skipped — daily loss limit: ${lossCount} losses × 0.10 = ${totalLossSol.toFixed(2)} SOL`);
          continue;
        }

        const sig = await buyToken(trade.coin_address, LIVE_BUY_SOL);
        if (sig) {
          console.log(`  [EXECUTOR] 🔴 LIVE BUY executed: ${sig}`);
          // Tag as [LIVE]
          await supabase
            .from("paper_trades")
            .update({ wallet_tag: `${trade.wallet_tag} [LIVE]` })
            .eq("id", trade.id);
        } else {
          console.log(`  [EXECUTOR] ⚠️ Buy failed — marking trade as failed, skipping guard monitoring`);
          await supabase
            .from("paper_trades")
            .update({ status: "failed", exit_reason: "buy_failed" })
            .eq("id", trade.id);
        }
      }
    } catch (err: any) {
      console.error("  [EXECUTOR] Poll error:", err.message);
    }
  }, POLL_MS);

  console.log("  [EXECUTOR] Polling for new trades every 3s");
}
