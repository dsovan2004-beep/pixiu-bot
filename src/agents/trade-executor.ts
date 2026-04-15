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
import { isRugStorm } from "../lib/entry-guards";

const POSITION_SIZE_USD = 100;
const LIVE_BUY_SOL = 0.05; // Amount of SOL per live trade

async function isLiveTrading(): Promise<boolean> {
  // Check DB first, then env var fallback
  try {
    const { data, error } = await supabase
      .from("bot_state")
      .select("mode")
      .limit(1)
      .single();
    if (error || !data) {
      console.error("  [EXECUTOR] ⚠️ Failed to read bot_state");
      // Fallback to env var
      return process.env.LIVE_TRADING === "true";
    }
    const dbLive = data.mode === "live";
    const envLive = process.env.LIVE_TRADING === "true";
    return dbLive || envLive;
  } catch {
    console.error("  [EXECUTOR] ⚠️ bot_state query crashed");
    return process.env.LIVE_TRADING === "true";
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

      // Entry guard — block new entries during rug storms
      if (await isRugStorm()) {
        pendingInserts.delete(entry.coin_address);
        console.log(`  [EXECUTOR] 🛑 ${coin} blocked — rug storm active`);
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

      // Hold the lock for 60s after insert — scout can take variable time
      setTimeout(() => pendingInserts.delete(entry.coin_address), 60_000);

      if (error) {
        pendingInserts.delete(entry.coin_address); // release immediately on error so retries work
        console.error(`  [EXECUTOR] DB error for ${coin}: ${error.message}`);
        return;
      }

      console.log(
        `  [EXECUTOR] Opened ${coin} @ $${entry.price.toFixed(10)} | $${POSITION_SIZE_USD} paper position [${entry.price_source}]`
      );

      // Jupiter live swap (if enabled via dashboard or env)
      console.log(`  [EXECUTOR] Checking live mode...`);
      const live = await isLiveTrading();
      console.log(`  [EXECUTOR] Live mode: ${live}`);
      if (live) {
        console.log(`  [EXECUTOR] Attempting LIVE BUY for ${coin} (${entry.coin_address.slice(0, 8)}...) at ${LIVE_BUY_SOL} SOL`);
        const sig = await buyToken(entry.coin_address, LIVE_BUY_SOL);
        console.log(`  [EXECUTOR] buyToken result: ${sig || "null"}`);
        if (sig) {
          console.log(`  [EXECUTOR] 🔴 LIVE BUY executed: ${sig}`);
          // Mark this trade as live in DB
          await supabase
            .from("paper_trades")
            .update({ wallet_tag: `${entry.wallet_label} [LIVE]` })
            .eq("coin_address", entry.coin_address)
            .eq("status", "open");
        } else {
          console.log(`  [EXECUTOR] ⚠️ LIVE BUY failed for ${coin} — paper trade still open`);
        }
      } else {
        console.log(`  [EXECUTOR] Paper only — live mode OFF`);
      }
    })
    .subscribe();

  console.log("  [EXECUTOR] Listening on pixiubot:confirmed channel");
}
