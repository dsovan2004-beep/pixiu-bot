/**
 * PixiuBot Agent 4 — Trade Executor
 *
 * Subscribes to pixiubot:confirmed channel.
 * Opens paper positions in Supabase paper_trades table.
 * Position size: $100 paper.
 *
 * TODO: Sprint 4 — add Jupiter live swap for real SOL execution.
 */

import supabase from "../lib/supabase-server";

const POSITION_SIZE_USD = 100;

interface ConfirmedEntry {
  coin_address: string;
  coin_name: string;
  wallet_label: string;
  smart_money_count: number;
  price: number;
  price_source: string;
}

export async function startTradeExecutor(): Promise<void> {
  console.log("  [EXECUTOR] Starting trade executor...");

  // Subscribe to pixiubot:confirmed channel
  const confirmedChannel = supabase.channel("pixiubot:confirmed");

  confirmedChannel
    .on("broadcast", { event: "confirmed_entry" }, async ({ payload }) => {
      const entry = payload as ConfirmedEntry;
      const coin =
        entry.coin_name || entry.coin_address.slice(0, 8) + "...";

      // Double-check no open position (race condition guard)
      const { count: openCount } = await supabase
        .from("paper_trades")
        .select("id", { count: "exact", head: true })
        .eq("coin_address", entry.coin_address)
        .eq("status", "open");

      if ((openCount || 0) > 0) {
        console.log(`  [EXECUTOR] ${coin} — position already open, skipping`);
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

      if (error) {
        console.error(`  [EXECUTOR] DB error for ${coin}: ${error.message}`);
        return;
      }

      console.log(
        `  [EXECUTOR] Opened ${coin} @ $${entry.price.toFixed(10)} | $${POSITION_SIZE_USD} paper position [${entry.price_source}]`
      );

      // TODO: Sprint 4 — Jupiter live swap hook
      // import { swap } from "../lib/jupiter";
      // await swap(entry.coin_address, POSITION_SIZE_SOL);
    })
    .subscribe();

  console.log("  [EXECUTOR] Listening on pixiubot:confirmed channel");
}
