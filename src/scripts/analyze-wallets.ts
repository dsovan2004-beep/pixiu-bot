/**
 * PixiuBot — Wallet Quality Analyzer
 * Usage: npx tsx src/scripts/analyze-wallets.ts
 *
 * Analyzes coin_signals data to rank wallet quality.
 * Outputs wallet_quality.json with tier assignments.
 */

import fs from "fs";
import path from "path";
import supabase from "../lib/supabase-server";

interface WalletStats {
  wallet_tag: string;
  total_signals: number;
  unique_coins: number;
  bundle_rate: number;
  avg_gap: number;
  rapid_buy_rate: number;
  tier: 1 | 2 | 3;
  tier_reason: string;
}

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Wallet Quality Analyzer");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Fetch all signals
  const { data: signals, error } = await supabase
    .from("coin_signals")
    .select("wallet_tag, coin_address, bundle_suspected, price_gap_minutes, signal_time")
    .order("signal_time", { ascending: false });

  if (error || !signals) {
    console.error("  [ERROR]", error?.message);
    process.exit(1);
  }

  console.log(`  Total signals: ${signals.length}\n`);

  // Group by wallet_tag
  const walletMap = new Map<string, typeof signals>();
  for (const sig of signals) {
    const group = walletMap.get(sig.wallet_tag) || [];
    group.push(sig);
    walletMap.set(sig.wallet_tag, group);
  }

  // Also fetch all tracked wallets (some may have 0 signals)
  const { data: allWallets } = await supabase
    .from("tracked_wallets")
    .select("tag")
    .eq("active", true);

  // Ensure wallets with 0 signals are included
  for (const w of allWallets || []) {
    if (!walletMap.has(w.tag)) {
      walletMap.set(w.tag, []);
    }
  }

  const results: WalletStats[] = [];

  for (const [walletTag, sigs] of walletMap) {
    const totalSignals = sigs.length;
    const uniqueCoins = new Set(sigs.map((s) => s.coin_address)).size;

    // Bundle rate
    const bundled = sigs.filter((s) => s.bundle_suspected === true).length;
    const bundleRate = totalSignals > 0 ? (bundled / totalSignals) * 100 : 0;

    // Avg gap
    const gaps = sigs
      .map((s) => s.price_gap_minutes)
      .filter((g): g is number => g !== null && g !== undefined);
    const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 999;

    // Rapid buy rate: how often this wallet bought same coin 3+ times in 5 min
    let rapidBuyInstances = 0;
    let totalCoinBuys = 0;

    const coinBuys = new Map<string, Date[]>();
    for (const s of sigs) {
      const times = coinBuys.get(s.coin_address) || [];
      times.push(new Date(s.signal_time));
      coinBuys.set(s.coin_address, times);
    }

    for (const [, times] of coinBuys) {
      totalCoinBuys++;
      if (times.length >= 3) {
        times.sort((a, b) => a.getTime() - b.getTime());
        // Check any 5-min window has 3+ buys
        for (let i = 0; i <= times.length - 3; i++) {
          const spread = (times[i + 2].getTime() - times[i].getTime()) / 60_000;
          if (spread <= 5) {
            rapidBuyInstances++;
            break;
          }
        }
      }
    }

    const rapidBuyRate = totalCoinBuys > 0 ? (rapidBuyInstances / totalCoinBuys) * 100 : 0;

    // Tier assignment
    let tier: 1 | 2 | 3;
    let tierReason: string;

    if (bundleRate > 30 || rapidBuyRate > 50) {
      tier = 3;
      tierReason = bundleRate > 30
        ? `bundle_rate=${bundleRate.toFixed(0)}%`
        : `rapid_buy=${rapidBuyRate.toFixed(0)}%`;
    } else if (bundleRate > 10 || avgGap > 30 || (totalSignals < 2 && totalSignals > 0)) {
      tier = 2;
      tierReason =
        bundleRate > 10
          ? `bundle_rate=${bundleRate.toFixed(0)}%`
          : avgGap > 30
            ? `avg_gap=${avgGap.toFixed(0)}min`
            : `low_signals=${totalSignals}`;
    } else if (totalSignals >= 2 && avgGap < 10 && bundleRate <= 10) {
      tier = 1;
      tierReason = `clean: ${totalSignals} sigs, ${avgGap.toFixed(0)}min avg gap, ${bundleRate.toFixed(0)}% bundle`;
    } else {
      // 0 signals = tier 2 (unproven)
      tier = 2;
      tierReason = totalSignals === 0 ? "no_signals" : `unclassified`;
    }

    results.push({
      wallet_tag: walletTag,
      total_signals: totalSignals,
      unique_coins: uniqueCoins,
      bundle_rate: Math.round(bundleRate * 10) / 10,
      avg_gap: Math.round(avgGap * 10) / 10,
      rapid_buy_rate: Math.round(rapidBuyRate * 10) / 10,
      tier,
      tier_reason: tierReason,
    });
  }

  // Sort: Tier 1 first, then by total_signals desc
  results.sort((a, b) => a.tier - b.tier || b.total_signals - a.total_signals);

  // Stats
  const tier1 = results.filter((r) => r.tier === 1);
  const tier2 = results.filter((r) => r.tier === 2);
  const tier3 = results.filter((r) => r.tier === 3);

  console.log(`  [ANALYSIS] ${results.length} wallets analyzed:`);
  console.log(`    Tier 1 (KEEP):    ${tier1.length}`);
  console.log(`    Tier 2 (MONITOR): ${tier2.length}`);
  console.log(`    Tier 3 (REMOVE):  ${tier3.length}`);
  console.log("");

  // Print top Tier 1 wallets
  if (tier1.length > 0) {
    console.log("  ─── Top Tier 1 Wallets ───");
    for (const w of tier1.slice(0, 20)) {
      console.log(
        `    ${w.wallet_tag.padEnd(20)} sigs=${String(w.total_signals).padEnd(4)} coins=${String(w.unique_coins).padEnd(4)} gap=${w.avg_gap.toFixed(0).padEnd(4)}min bundle=${w.bundle_rate}%`
      );
    }
    console.log("");
  }

  // Print Tier 3 wallets to remove
  if (tier3.length > 0) {
    console.log("  ─── Tier 3 Wallets (TO REMOVE) ───");
    for (const w of tier3.slice(0, 20)) {
      console.log(
        `    ${w.wallet_tag.padEnd(20)} reason=${w.tier_reason}`
      );
    }
    console.log("");
  }

  // Save to file
  const outPath = path.resolve(__dirname, "../../wallet_quality.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`  Saved to ${outPath}\n`);
}

main().catch((err) => {
  console.error("Analysis failed:", err);
  process.exit(1);
});
