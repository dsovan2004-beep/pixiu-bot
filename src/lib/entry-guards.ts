/**
 * PixiuBot — Entry Guards
 *
 * Shared guards for signal-validator and trade-executor.
 * These only block NEW entries, never exits.
 *
 * Rug storm: 4+ losses in last 5 trades (2h window) → pause 30min.
 * Raised from 3/5 to 4/5 after diagnostic showed the 3/5 threshold
 * tripped too often and cost entry frequency with neutral WR impact.
 */

import supabase from "./supabase-server";

// ─── Rug Storm Detection ────────────────────────────────

let rugStormCache: { active: boolean; checkedAt: number; pauseUntil: number } = {
  active: false,
  checkedAt: 0,
  pauseUntil: 0,
};

const RUG_STORM_CACHE_MS = 5 * 60_000; // Cache for 5 minutes
const RUG_STORM_PAUSE_MS = 30 * 60_000; // Pause entries for 30 minutes
const RUG_STORM_THRESHOLD = 4; // 4 out of 5 losses = rug storm (was 3)
const RUG_STORM_WINDOW = 5; // Look at last 5 trades

export async function isRugStorm(): Promise<boolean> {
  const now = Date.now();

  // If we're in an active pause period, check if it's expired
  if (rugStormCache.pauseUntil > now) {
    return true; // Still paused
  }

  // If pause expired and was active, log the clear
  if (rugStormCache.active && rugStormCache.pauseUntil <= now) {
    rugStormCache.active = false;
    console.log("  [GUARD] ✅ Rug storm cleared — resuming entries");
  }

  // Use cached result if fresh enough
  if (now - rugStormCache.checkedAt < RUG_STORM_CACHE_MS) {
    return rugStormCache.active;
  }

  // Query last 5 closed trades within the last 2 hours only
  // Old losses (>2h ago) should not block entries forever
  const twoHoursAgo = new Date(now - 2 * 60 * 60_000).toISOString();
  const { data: recentTrades } = await supabase
    .from("paper_trades")
    .select("pnl_pct")
    .eq("status", "closed")
    .gte("exit_time", twoHoursAgo)
    .order("exit_time", { ascending: false })
    .limit(RUG_STORM_WINDOW);

  rugStormCache.checkedAt = now;

  if (!recentTrades || recentTrades.length < RUG_STORM_WINDOW) {
    rugStormCache.active = false;
    return false;
  }

  const losses = recentTrades.filter((t) => Number(t.pnl_pct) < 0).length;

  if (losses >= RUG_STORM_THRESHOLD) {
    if (!rugStormCache.active) {
      // New rug storm detected
      rugStormCache.active = true;
      rugStormCache.pauseUntil = now + RUG_STORM_PAUSE_MS;
      console.log(
        `  [GUARD] 🛑 Rug storm detected (${losses}/${RUG_STORM_WINDOW} recent losses) — pausing entries 30min`
      );
    }
    return true;
  }

  rugStormCache.active = false;
  return false;
}

