/**
 * PixiuBot Agent 1 — Wallet Watcher
 *
 * Polls coin_signals table every 3s for new inserts.
 * Publishes events to the shared pixiubot:signals broadcast channel.
 *
 * Previously used Supabase Realtime but it silently drops connections.
 * Polling is more reliable for production with real money.
 */

import supabase from "../lib/supabase-server";

const POLL_MS = 3_000; // Check for new signals every 3s
const HEARTBEAT_MS = 30_000;

interface SignalRow {
  id: string;
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

  // Track last seen signal to avoid duplicates
  let lastSeenTime = new Date().toISOString();

  // Poll for new signals every 3s
  setInterval(async () => {
    try {
      const { data: newSignals } = await supabase
        .from("coin_signals")
        .select("id, coin_address, coin_name, wallet_tag, transaction_type, signal_time, rug_check_passed")
        .gt("signal_time", lastSeenTime)
        .order("signal_time", { ascending: true })
        .limit(20);

      if (!newSignals || newSignals.length === 0) return;

      // Update last seen time to latest signal
      lastSeenTime = newSignals[newSignals.length - 1].signal_time;

      for (const row of newSignals) {
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
    } catch (err: any) {
      console.error("  [WATCHER] Poll error:", err.message);
    }
  }, POLL_MS);

  // Heartbeat
  setInterval(async () => {
    const { count } = await supabase
      .from("tracked_wallets")
      .select("id", { count: "exact", head: true })
      .eq("active", true);

    console.log(`  [WATCHER] alive | tracking ${count || trackedCount} wallets`);
  }, HEARTBEAT_MS);

  console.log(`  [WATCHER] Polling coin_signals every ${POLL_MS / 1000}s | ${trackedCount} wallets tracked`);
}
