/**
 * PixiuBot Agent 2 — Signal Validator
 *
 * Subscribes to pixiubot:signals channel.
 * Validates BUY signals against entry criteria:
 *   1. T1 Smart Money wallet present
 *   2. Confirming wallet (any tier)
 *   3. Bundle detection (>80% from 1 wallet = skip)
 *   4. 120 min same-coin cooldown
 *   5. No open position on this coin
 * Publishes validated ENTER events to pixiubot:entries channel.
 */

import supabase from "../lib/supabase-server";
import {
  TOP_ELITE_ADDRESSES,
  RECENTLY_TRADED_COOLDOWN_MS,
} from "../config/smart-money";

interface SignalEvent {
  coin_address: string;
  coin_name: string;
  wallet_tag: string;
  transaction_type: "BUY" | "SELL";
  signal_time: string;
  rug_check_passed: boolean;
}

export async function startSignalValidator(): Promise<void> {
  console.log("  [VALIDATOR] Starting signal validator...");

  // Create broadcast channel for publishing validated entries
  const entryChannel = supabase.channel("pixiubot:entries");
  await entryChannel.subscribe();

  // Subscribe to pixiubot:signals channel
  const signalChannel = supabase.channel("pixiubot:signals");

  signalChannel
    .on("broadcast", { event: "signal" }, async ({ payload }) => {
      const signal = payload as SignalEvent;

      // Only process BUY signals
      if (signal.transaction_type !== "BUY") return;

      const coin = signal.coin_name || signal.coin_address.slice(0, 8) + "...";

      // 1. Check if position already open for this coin
      const { count: openCount } = await supabase
        .from("paper_trades")
        .select("id", { count: "exact", head: true })
        .eq("coin_address", signal.coin_address)
        .eq("status", "open");

      if ((openCount || 0) > 0) {
        return; // silently skip — already tracking
      }

      // 2. Check 120min cooldown
      const cooldownCutoff = new Date(
        Date.now() - RECENTLY_TRADED_COOLDOWN_MS
      ).toISOString();
      const { count: recentCount } = await supabase
        .from("paper_trades")
        .select("id", { count: "exact", head: true })
        .eq("coin_address", signal.coin_address)
        .eq("status", "closed")
        .gte("exit_time", cooldownCutoff);

      if ((recentCount || 0) > 0) {
        console.log(`  [VALIDATOR] ❌ ${coin} — 120min cooldown active`);
        return;
      }

      // 3. Get all BUY signals for this coin in last 30min
      const signalCutoff = new Date(Date.now() - 30 * 60_000).toISOString();
      const { data: recentSignals } = await supabase
        .from("coin_signals")
        .select("wallet_tag")
        .eq("coin_address", signal.coin_address)
        .eq("transaction_type", "BUY")
        .eq("rug_check_passed", true)
        .gte("signal_time", signalCutoff);

      const allTags = new Set(
        (recentSignals || []).map((s) => s.wallet_tag)
      );
      allTags.add(signal.wallet_tag);

      // 4. Resolve tags to addresses for T1 check
      const { data: walletRows } = await supabase
        .from("tracked_wallets")
        .select("wallet_address, tag")
        .in("tag", Array.from(allTags));

      const tagToAddr = new Map<string, string>();
      for (const w of walletRows || []) tagToAddr.set(w.tag, w.wallet_address);

      let smartMoneyCount = 0;
      const smartMoneyNames: string[] = [];
      const otherNames: string[] = [];

      for (const tag of allTags) {
        const addr = tagToAddr.get(tag);
        if (addr && TOP_ELITE_ADDRESSES.has(addr)) {
          smartMoneyCount++;
          smartMoneyNames.push(tag);
        } else {
          otherNames.push(tag);
        }
      }

      // REQUIRE: at least 1 T1 Smart Money
      if (smartMoneyCount === 0) {
        console.log(
          `  [VALIDATOR] ❌ ${coin} — no T1 Smart Money (${allTags.size} wallets, 0 T1)`
        );
        return;
      }

      // REQUIRE: at least 1 confirming wallet
      if (allTags.size < 2) {
        console.log(
          `  [VALIDATOR] ❌ ${coin} — no confirmation (${smartMoneyNames[0]} alone)`
        );
        return;
      }

      // 5. Bundle detection: any wallet > 80% of signals = skip
      const signalsByWallet = new Map<string, number>();
      for (const s of recentSignals || []) {
        signalsByWallet.set(
          s.wallet_tag,
          (signalsByWallet.get(s.wallet_tag) || 0) + 1
        );
      }
      signalsByWallet.set(
        signal.wallet_tag,
        (signalsByWallet.get(signal.wallet_tag) || 0) + 1
      );
      const totalSigs = (recentSignals?.length || 0) + 1;

      for (const [tag, count] of signalsByWallet) {
        if (count / totalSigs >= 0.8 && totalSigs >= 3) {
          console.log(
            `  [VALIDATOR] ❌ ${coin} — bundle suspected (${tag} = ${count}/${totalSigs})`
          );
          return;
        }
      }

      // ALL CHECKS PASSED — publish ENTER event
      const confirmTag =
        otherNames.length > 0
          ? otherNames[0]
          : smartMoneyNames[1] || smartMoneyNames[0];
      const walletLabel = `${smartMoneyNames[0]}+${confirmTag}${allTags.size > 2 ? `+${allTags.size - 2}more` : ""}`;

      console.log(
        `  [VALIDATOR] ✅ ${coin} — ${smartMoneyNames[0]}(T1) + ${confirmTag} confirmed`
      );

      entryChannel.send({
        type: "broadcast",
        event: "enter",
        payload: {
          coin_address: signal.coin_address,
          coin_name: signal.coin_name,
          wallet_label: walletLabel,
          smart_money_count: smartMoneyCount,
        },
      });
    })
    .subscribe();

  console.log("  [VALIDATOR] Listening on pixiubot:signals channel");
}
