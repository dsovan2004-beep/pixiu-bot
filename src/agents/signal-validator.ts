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
  RECENTLY_TRADED_COOLDOWN_MS,
} from "../config/smart-money";
import { isRugStorm } from "../lib/entry-guards";

// ─── DB-backed T1 tier check with 60s cache ────────────
// Replaces hardcoded TOP_ELITE_ADDRESSES — tier changes in DB take effect immediately
const tierCache = new Map<string, { tier: number; cachedAt: number }>();
const TIER_CACHE_MS = 60_000; // 60s cache per wallet address

async function isT1Wallet(walletAddress: string): Promise<boolean> {
  const cached = tierCache.get(walletAddress);
  if (cached && Date.now() - cached.cachedAt < TIER_CACHE_MS) {
    return cached.tier === 1;
  }

  const { data } = await supabase
    .from("tracked_wallets")
    .select("tier")
    .eq("wallet_address", walletAddress)
    .eq("active", true)
    .limit(1)
    .single();

  const tier = data?.tier ?? 0;
  tierCache.set(walletAddress, { tier, cachedAt: Date.now() });
  return tier === 1;
}

// Stablecoin name filter — reject scam tokens using stablecoin names
const STABLECOIN_KEYWORDS = [
  "usd", "usdc", "usdt", "usds", "dai", "busd", "frax",
  "stable", "peg", "dollar", "euro", "eur",
];

function isStablecoinName(name: string): boolean {
  const lower = name.toLowerCase();
  return STABLECOIN_KEYWORDS.some((kw) => lower.includes(kw));
}

// In-memory dedup: prevent same coin from being validated twice within 60s
const recentlyValidated = new Map<string, number>(); // coin_address → timestamp
const VALIDATION_COOLDOWN_MS = 60_000;

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

      // 0a. Rug storm detection — 3+ losses in last 5 trades → pause 30min
      if (await isRugStorm()) {
        console.log(`  [VALIDATOR] 🛑 ${coin} blocked — rug storm active`);
        return;
      }

      // 0c. Stablecoin name filter — fastest rejection
      if (signal.coin_name && isStablecoinName(signal.coin_name)) {
        console.log(`  [VALIDATOR] ❌ ${coin} — stablecoin name filter (skipping)`);
        return;
      }

      // 0d. In-memory dedup — block same coin_address within 60s
      const lastValidated = recentlyValidated.get(signal.coin_address);
      if (lastValidated && Date.now() - lastValidated < VALIDATION_COOLDOWN_MS) {
        return; // silently skip — already validated recently
      }

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
        console.log(`  [VALIDATOR] ❌ ${coin} — 120min cooldown active (same address)`);
        return;
      }

      // 2b. Name-based cooldown — block same-name scam tokens (different addresses, same name)
      if (signal.coin_name) {
        const { count: nameCount } = await supabase
          .from("paper_trades")
          .select("id", { count: "exact", head: true })
          .eq("coin_name", signal.coin_name)
          .eq("status", "closed")
          .gte("exit_time", cooldownCutoff);

        if ((nameCount || 0) > 0) {
          console.log(`  [VALIDATOR] ❌ ${coin} — 120min cooldown active (same name, different address)`);
          return;
        }
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
        if (addr && (await isT1Wallet(addr))) {
          smartMoneyCount++;
          smartMoneyNames.push(tag);
        } else {
          if (addr) {
            // Check if this is a known T2 wallet (demoted but still tracked)
            const cached = tierCache.get(addr);
            if (cached && cached.tier === 2) {
              console.log(`  [VALIDATOR] T2 wallet — needs T1 confirmation: ${tag}`);
            }
          }
          otherNames.push(tag);
        }
      }

      // REQUIRE: at least 1 T1 Smart Money — solo T1 buy is enough
      if (smartMoneyCount === 0) {
        console.log(
          `  [VALIDATOR] ❌ ${coin} — no T1 Smart Money (${allTags.size} wallets, 0 T1)`
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

      // 6. Whale hold time filter: if any confirming wallet sold same coin within 2min of buying = rug/test
      const twoMinAgo = new Date(Date.now() - 2 * 60_000).toISOString();
      const { data: quickSells } = await supabase
        .from("coin_signals")
        .select("wallet_tag")
        .eq("coin_address", signal.coin_address)
        .eq("transaction_type", "SELL")
        .gte("signal_time", twoMinAgo);

      if (quickSells && quickSells.length > 0) {
        // Check if any of the selling wallets also bought this coin recently
        const sellerTags = new Set(quickSells.map((s) => s.wallet_tag));
        const overlap = Array.from(allTags).filter((t) => sellerTags.has(t));
        if (overlap.length > 0) {
          console.log(
            `  [VALIDATOR] ❌ ${coin} — ${overlap[0]} sold within 2min (likely rug)`
          );
          return;
        }
      }

      // ALL CHECKS PASSED — mark as validated to prevent duplicates
      recentlyValidated.set(signal.coin_address, Date.now());

      // Publish ENTER event
      const confirmTag =
        otherNames.length > 0
          ? otherNames[0]
          : smartMoneyNames[1] || null;
      const walletLabel = confirmTag
        ? `${smartMoneyNames[0]}+${confirmTag}${allTags.size > 2 ? `+${allTags.size - 2}more` : ""}`
        : smartMoneyNames[0];

      console.log(
        confirmTag
          ? `  [VALIDATOR] ✅ ${coin} — ${smartMoneyNames[0]}(T1) + ${confirmTag} confirmed`
          : `  [VALIDATOR] ✅ ${coin} — ${smartMoneyNames[0]}(T1) solo entry`
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
