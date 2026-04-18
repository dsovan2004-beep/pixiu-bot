/**
 * PixiuBot Agent 6 — Tier Manager
 *
 * Auto-demotion: when a trade closes, checks if the triggering T1 wallet
 * has WR < 50% on 3+ trades in last 24h → demotes to T2.
 *
 * Auto-promotion: daily check at midnight — if a T2 wallet has WR > 65%
 * on 5+ trades in last 7 days → promotes to T1.
 *
 * Modifies TOP_ELITE_ADDRESSES in memory and tracked_wallets in DB.
 */

import supabase from "../lib/supabase-server";
import { TOP_ELITE_ADDRESSES } from "../config/smart-money";

// ─── Demotion: T1 → T2 ─────────────────────────────────

const DEMOTION_MIN_TRADES = 3;
const DEMOTION_MAX_WR = 0.50; // 50%
const DEMOTION_WINDOW_MS = 24 * 60 * 60_000; // 24 hours

async function checkDemotion(walletTag: string): Promise<void> {
  const cutoff = new Date(Date.now() - DEMOTION_WINDOW_MS).toISOString();

  // Get all closed trades triggered by this wallet in last 24h
  // wallet_tag format is "T1+confirmer" — check if tag appears in wallet_tag
  const { data: trades } = await supabase
    .from("trades")
    .select("real_pnl_sol, wallet_tag")
    .eq("status", "closed")
    .gte("exit_time", cutoff)
    .like("wallet_tag", `%${walletTag}%`);

  if (!trades || trades.length < DEMOTION_MIN_TRADES) return;

  const wins = trades.filter((t) => Number(t.real_pnl_sol) > 0).length;
  const wr = wins / trades.length;

  if (wr >= DEMOTION_MAX_WR) return;

  // Resolve tag to address
  const { data: walletRow } = await supabase
    .from("tracked_wallets")
    .select("wallet_address, tier")
    .eq("tag", walletTag)
    .limit(1)
    .single();

  if (!walletRow || walletRow.tier !== 1) return;

  // Demote in DB
  await supabase
    .from("tracked_wallets")
    .update({ tier: 2 })
    .eq("wallet_address", walletRow.wallet_address);

  // Demote in memory
  TOP_ELITE_ADDRESSES.delete(walletRow.wallet_address);

  console.log(
    `  [TIER] ⚠️ ${walletTag} auto-demoted T1→T2 (WR ${(wr * 100).toFixed(1)}% on ${trades.length} trades in 24h)`
  );
}

// ─── Promotion: T2 → T1 ────────────────────────────────

const PROMOTION_MIN_TRADES = 5;
const PROMOTION_MIN_WR = 0.65; // 65%
const PROMOTION_WINDOW_MS = 7 * 24 * 60 * 60_000; // 7 days
const PROMOTION_CHECK_MS = 60 * 60_000; // Check every hour (catches midnight window)

async function checkPromotions(): Promise<void> {
  // Get all T2 wallets
  const { data: t2Wallets } = await supabase
    .from("tracked_wallets")
    .select("wallet_address, tag")
    .eq("tier", 2)
    .eq("active", true);

  if (!t2Wallets || t2Wallets.length === 0) return;

  const cutoff = new Date(Date.now() - PROMOTION_WINDOW_MS).toISOString();

  for (const wallet of t2Wallets) {
    // Get trades where this wallet was involved (as confirmer or trigger)
    const { data: trades } = await supabase
      .from("trades")
      .select("real_pnl_sol")
      .eq("status", "closed")
      .gte("exit_time", cutoff)
      .like("wallet_tag", `%${wallet.tag}%`);

    if (!trades || trades.length < PROMOTION_MIN_TRADES) continue;

    const wins = trades.filter((t) => Number(t.real_pnl_sol) > 0).length;
    const wr = wins / trades.length;

    if (wr < PROMOTION_MIN_WR) continue;

    // Already T1 in memory? Skip
    if (TOP_ELITE_ADDRESSES.has(wallet.wallet_address)) continue;

    // Promote in DB
    await supabase
      .from("tracked_wallets")
      .update({ tier: 1 })
      .eq("wallet_address", wallet.wallet_address);

    // Promote in memory
    TOP_ELITE_ADDRESSES.add(wallet.wallet_address);

    console.log(
      `  [TIER] ✅ ${wallet.tag} auto-promoted T2→T1 (WR ${(wr * 100).toFixed(1)}% on ${trades.length} trades in 7d)`
    );
  }
}

// ─── Start ──────────────────────────────────────────────

export async function startTierManager(): Promise<void> {
  console.log("  [TIER] Starting tier manager...");
  console.log(
    `  [TIER] Demotion: WR < ${DEMOTION_MAX_WR * 100}% on ${DEMOTION_MIN_TRADES}+ trades in 24h → T2`
  );
  console.log(
    `  [TIER] Promotion: WR > ${PROMOTION_MIN_WR * 100}% on ${PROMOTION_MIN_TRADES}+ trades in 7d → T1`
  );

  // Subscribe to trades changes (closed trades) for demotion checks
  supabase
    .channel("tier:trades")
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "trades",
        filter: "status=eq.closed",
      },
      async (payload) => {
        const row = payload.new as { wallet_tag: string; status: string };
        if (row.status !== "closed" || !row.wallet_tag) return;

        // Extract individual wallet tags from the combined label (e.g. "cented+bluey+2more")
        const tags = row.wallet_tag.split("+").map((t) => t.replace(/\d+more$/, "").trim()).filter(Boolean);

        for (const tag of tags) {
          await checkDemotion(tag);
        }
      }
    )
    .subscribe();

  // Run promotion check on startup
  await checkPromotions();

  // Run promotion check every hour
  setInterval(checkPromotions, PROMOTION_CHECK_MS);

  console.log(`  [TIER] Listening for trade closes (demotion) | Promotion check every ${PROMOTION_CHECK_MS / 60_000}min`);
}
