/**
 * PixiuBot Agent 1 — Wallet Watcher
 *
 * Subscribes to Supabase Realtime on coin_signals table.
 * Detects new BUY and SELL rows being inserted.
 * Publishes events to the shared pixiubot:signals broadcast channel.
 */

import supabase from "../lib/supabase-server";

const HEARTBEAT_MS = 30_000;

interface SignalPayload {
  coin_address: string;
  coin_name: string;
  wallet_tag: string;
  transaction_type: "BUY" | "SELL";
  signal_time: string;
  rug_check_passed: boolean;
}

export async function startWalletWatcher(): Promise<void> {
  console.log("  [WATCHER] Starting wallet watcher...");

  // Get tracked wallet count for heartbeat
  const { count: walletCount } = await supabase
    .from("tracked_wallets")
    .select("id", { count: "exact", head: true })
    .eq("active", true);

  const trackedCount = walletCount || 0;

  // Create broadcast channel for publishing signals
  const signalChannel = supabase.channel("pixiubot:signals");
  await signalChannel.subscribe();

  // Subscribe to INSERT events on coin_signals table
  const subscription = supabase
    .channel("watcher:coin_signals")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "coin_signals" },
      (payload) => {
        const row = payload.new as SignalPayload;
        const type = row.transaction_type;
        const tag = row.wallet_tag;
        const coin = row.coin_name || row.coin_address?.slice(0, 8) + "...";

        console.log(`  [WATCHER] ${tag} ${type} ${coin}`);

        // Broadcast to pixiubot:signals channel
        signalChannel.send({
          type: "broadcast",
          event: "signal",
          payload: {
            coin_address: row.coin_address,
            coin_name: row.coin_name,
            wallet_tag: row.wallet_tag,
            transaction_type: row.transaction_type,
            signal_time: row.signal_time,
            rug_check_passed: row.rug_check_passed,
          },
        });
      }
    )
    .subscribe();

  // Heartbeat
  setInterval(async () => {
    const { count } = await supabase
      .from("tracked_wallets")
      .select("id", { count: "exact", head: true })
      .eq("active", true);

    console.log(`  [WATCHER] alive | tracking ${count || trackedCount} wallets`);
  }, HEARTBEAT_MS);

  console.log(`  [WATCHER] Listening for coin_signals inserts | ${trackedCount} wallets tracked`);
}
