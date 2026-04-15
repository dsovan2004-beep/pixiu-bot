/**
 * PixiuBot Agent 4 — Trade Executor
 *
 * Subscribes to pixiubot:confirmed channel.
 * Opens paper positions in Supabase paper_trades table.
 * Position size: $100 paper.
 *
 * Sprint 4: Jupiter live swap integration (LIVE_TRADING toggle).
 */

import supabase from "../lib/supabase-server";
import { buyToken } from "../lib/jupiter-swap";

const POSITION_SIZE_USD = 100;
const LIVE_BUY_SOL = 0.05; // Amount of SOL per live trade

async function isLiveTrading(): Promise<boolean> {
  // Check DB setting first (dashboard toggle)
  // SAFETY: default to false (paper) on ANY failure — never accidentally go live
  try {
    const { data, error } = await supabase
      .from("bot_state")
      .select("mode")
      .limit(1)
      .single();
    if (error || !data) {
      console.error("  [EXECUTOR] ⚠️ Failed to read bot_state — defaulting to PAPER");
      return false;
    }
    return data.mode === "live";
  } catch {
    console.error("  [EXECUTOR] ⚠️ bot_state query crashed — defaulting to PAPER");
    return false;
  }
}

// In-memory dedup: track coins being inserted to prevent race condition duplicates
const pendingInserts = new Set<string>();

interface ConfirmedEntry {
  coin_address: string;
  coin_name: string;
  wallet_label: string;
  smart_money_count: number;
  price: number;
  price_source: string;
}

export async function startTradeExecutor(): Promise<void> {
  const startLive = await isLiveTrading();
  console.log(`  [EXECUTOR] Starting trade executor... (LIVE: ${startLive ? "🔴 ON" : "⚪ OFF"} — dashboard controlled)`);

  // Subscribe to pixiubot:confirmed channel
  const confirmedChannel = supabase.channel("pixiubot:confirmed");

  confirmedChannel
    .on("broadcast", { event: "confirmed_entry" }, async ({ payload }) => {
      const entry = payload as ConfirmedEntry;
      const coin =
        entry.coin_name || entry.coin_address.slice(0, 8) + "...";

      // In-memory dedup: if another event for this coin is already being processed, skip
      if (pendingInserts.has(entry.coin_address)) {
        console.log(`  [EXECUTOR] ❌ ${coin} — duplicate entry in progress, skipping`);
        return;
      }
      pendingInserts.add(entry.coin_address);

      // Double-check no open position (race condition guard)
      const { count: openCount } = await supabase
        .from("paper_trades")
        .select("id", { count: "exact", head: true })
        .eq("coin_address", entry.coin_address)
        .eq("status", "open");

      if ((openCount || 0) > 0) {
        pendingInserts.delete(entry.coin_address);
        console.log(`  [EXECUTOR] ❌ ${coin} — duplicate entry blocked (already open)`);
        return;
      }

      // Also check for any trade opened in the last 60s on same address (catches recently inserted dupes)
      const recentCutoff = new Date(Date.now() - 60_000).toISOString();
      const { count: recentOpenCount } = await supabase
        .from("paper_trades")
        .select("id", { count: "exact", head: true })
        .eq("coin_address", entry.coin_address)
        .gte("entry_time", recentCutoff);

      if ((recentOpenCount || 0) > 0) {
        pendingInserts.delete(entry.coin_address);
        console.log(`  [EXECUTOR] ❌ ${coin} — duplicate entry blocked (opened in last 60s)`);
        return;
      }

      const { error } = await supabase.from("paper_trades").insert({
        coin_address: entry.coin_address,
        coin_name: entry.coin_name,
        wallet_tag: entry.wallet_label,
        entry_price: entry.price,
        entry_mc: null,
        status: "open",
        priority: entry.smart_money_count >= 2 ? "HIGH" : "normal",
        entry_time: new Date().toISOString(),
        position_size_usd: POSITION_SIZE_USD,
      });

      // Hold the lock for 10s after insert to prevent race condition duplicates
      // The DB row is now visible but a near-simultaneous event could still slip through
      setTimeout(() => pendingInserts.delete(entry.coin_address), 10_000);

      if (error) {
        pendingInserts.delete(entry.coin_address); // release immediately on error so retries work
        console.error(`  [EXECUTOR] DB error for ${coin}: ${error.message}`);
        return;
      }

      console.log(
        `  [EXECUTOR] Opened ${coin} @ $${entry.price.toFixed(10)} | $${POSITION_SIZE_USD} paper position [${entry.price_source}]`
      );

      // Jupiter live swap (if enabled via dashboard or env)
      const live = await isLiveTrading();
      if (live) {
        // Check daily loss limit before buying
        const todayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
        const { data: losses } = await supabase
          .from("paper_trades")
          .select("pnl_usd")
          .eq("status", "closed")
          .gte("exit_time", todayStart)
          .lt("pnl_usd", 0);
        const totalLossUsd = (losses || []).reduce((s, t) => s + Math.abs(Number(t.pnl_usd || 0)), 0);
        const totalLossSol = totalLossUsd / 85;

        if (totalLossSol >= 0.2) {
          console.log(`  [EXECUTOR] 🛑 LIVE BUY skipped — daily loss limit hit (${totalLossSol.toFixed(3)} SOL)`);
        } else {
          const sig = await buyToken(entry.coin_address, LIVE_BUY_SOL);
          if (sig) {
            console.log(`  [EXECUTOR] 🔴 LIVE BUY executed: ${sig}`);
          } else {
            console.log(`  [EXECUTOR] ⚠️ LIVE BUY failed for ${coin} — paper trade still open`);
          }
        }
      }
    })
    .subscribe();

  console.log("  [EXECUTOR] Listening on pixiubot:confirmed channel");
}
