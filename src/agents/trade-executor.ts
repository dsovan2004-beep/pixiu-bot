/**
 * PixiuBot Agent 4 — Trade Executor (Live Buy)
 *
 * Polls trades every 3s for new open positions.
 * If live mode ON → fires Jupiter buy → tags [LIVE].
 * Webhook handles all entry logic (evaluateAndEnter).
 * This agent ONLY handles the live Jupiter buy layer.
 */

import supabase from "../lib/supabase-server";
import { buyToken, hasTokenBalance, parseSwapSolDelta } from "../lib/jupiter-swap";
import {
  LIVE_BUY_SOL,
  DAILY_LOSS_LIMIT_SOL,
  BUY_RESCUE_DELAY_MS,
  MIN_TOKEN_AGE_MINUTES,
  MAX_CO_BUYERS_5MIN,
} from "../config/smart-money";
import { sendAlert } from "../lib/telegram";

const POLL_MS = 3_000;

async function isLiveTrading(): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("bot_state")
      .select("mode")
      .limit(1)
      .single();
    if (error || !data) return false;
    const dbLive = data.mode === "live";
    const envLive = process.env.LIVE_TRADING === "true";
    return dbLive || envLive;
  } catch {
    return false;
  }
}

// Track which trades we've already tried to buy
const processedTrades = new Set<string>();
// In-memory lock: coin addresses with a buy currently in-flight (confirming)
const activeBuys = new Set<string>();
// Rescue checks already scheduled (mint → true), prevents duplicate timers
const rescueScheduled = new Set<string>();

/**
 * Schedule an on-chain check BUY_RESCUE_DELAY_MS from now. If the wallet now
 * holds the token, the supposedly-failed Jupiter buy actually landed — revert
 * the trade row from 'failed' back to 'open' and tag [LIVE] so the risk guard
 * takes over. Estimates entry_price from current DexScreener price (best effort).
 */
function scheduleBuyRescue(
  tradeId: string,
  coinAddress: string,
  walletTag: string,
  coinLabel: string
): void {
  if (rescueScheduled.has(tradeId)) return;
  rescueScheduled.add(tradeId);

  setTimeout(async () => {
    try {
      const held = await hasTokenBalance(coinAddress);
      if (!held) {
        console.log(`  [EXECUTOR] [RESCUE] ${coinLabel} not held on-chain — buy truly failed, no action`);
        return;
      }

      // Token IS in wallet — the buy landed. Re-open the trade so guard tracks it.
      console.log(`  [EXECUTOR] 🛟 [RESCUE] ${coinLabel} found on-chain — buy landed late, re-opening trade`);

      const { data: row } = await supabase
        .from("trades")
        .select("id, status, wallet_tag")
        .eq("id", tradeId)
        .single();

      // Only rescue if still 'failed' — if user/script already touched the row, leave alone
      if (!row || row.status !== "failed") {
        console.log(`  [EXECUTOR] [RESCUE] ${coinLabel} status is now '${row?.status}' — skipping rescue`);
        return;
      }

      await supabase
        .from("trades")
        .update({
          status: "open",
          exit_reason: null,
          wallet_tag: row.wallet_tag.includes("[LIVE]")
            ? row.wallet_tag
            : `${walletTag} [LIVE]`,
          entry_time: new Date().toISOString(), // restart guards from now (30s min hold, etc.)
        })
        .eq("id", tradeId);

      void sendAlert(
        "buy_rescued",
        `BUY rescued: ${coinLabel} landed late — guard now tracking`
      );
    } catch (err: any) {
      console.error(`  [EXECUTOR] [RESCUE] ${coinLabel} check error:`, err.message);
    } finally {
      rescueScheduled.delete(tradeId);
    }
  }, BUY_RESCUE_DELAY_MS);
}

export async function startTradeExecutor(): Promise<void> {
  const startLive = await isLiveTrading();
  console.log(`  [EXECUTOR] Starting trade executor... (LIVE: ${startLive ? "🔴 ON" : "⚪ OFF"} — dashboard controlled)`);

  // Poll for new open positions every 3s
  setInterval(async () => {
    try {
      // Check if bot is stopped via dashboard — MUST be first check
      const { data: botState } = await supabase.from("bot_state").select("is_running").limit(1).single();
      if (!botState || !botState.is_running) {
        console.log(`  [EXECUTOR] Bot stopped via dashboard — skipping all trades`);
        return; // Bot stopped or DB error — do nothing
      }

      const live = await isLiveTrading();
      if (!live) return;

      // Find open positions NOT yet tagged [LIVE] and not already processed
      const { data: newTrades } = await supabase
        .from("trades")
        .select("id, coin_address, coin_name, wallet_tag")
        .eq("status", "open")
        .not("wallet_tag", "like", "%[LIVE]%");

      if (!newTrades || newTrades.length === 0) return;

      for (const trade of newTrades) {
        // Skip if we already tried this one
        if (processedTrades.has(trade.id)) continue;
        processedTrades.add(trade.id);

        const coin = trade.coin_name || trade.coin_address.slice(0, 8) + "...";

        // In-memory lock — block duplicate buys while confirmation is in-flight
        if (activeBuys.has(trade.coin_address)) {
          console.log(`  [EXECUTOR] Skipping — buy already in progress for ${coin}`);
          continue;
        }

        // DB-level duplicate check — skip if another open LIVE trade exists for same mint
        const { count: liveOpenCount } = await supabase
          .from("trades")
          .select("id", { count: "exact", head: true })
          .eq("coin_address", trade.coin_address)
          .eq("status", "open")
          .like("wallet_tag", "%[LIVE]%");

        if ((liveOpenCount || 0) > 0) {
          console.log(`  [EXECUTOR] Skipping duplicate — already have open LIVE position for ${coin}`);
          continue;
        }

        // Re-check is_running before each buy — user may have pressed STOP mid-loop
        const { data: stopCheck } = await supabase.from("bot_state").select("is_running").limit(1).single();
        if (!stopCheck || !stopCheck.is_running) {
          console.log(`  [EXECUTOR] Bot stopped via dashboard — skipping all trades`);
          break;
        }

        console.log(`  [EXECUTOR] New trade detected: ${coin} — attempting LIVE BUY...`);

        // Check daily loss limit — sum REAL SOL lost (real_pnl_sol < 0)
        // across LIVE trades since midnight UTC.
        const todayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
        const { data: losses } = await supabase
          .from("trades")
          .select("real_pnl_sol")
          .eq("status", "closed")
          .gte("exit_time", todayStart)
          .lt("real_pnl_sol", 0)
          .like("wallet_tag", "%[LIVE]%");
        const todayLosses = losses?.length ?? 0;
        const totalLossSol = (losses ?? []).reduce((sum, t) => {
          const r = t.real_pnl_sol !== null && t.real_pnl_sol !== undefined ? Number(t.real_pnl_sol) : 0;
          return sum + Math.abs(r);
        }, 0);

        if (totalLossSol >= DAILY_LOSS_LIMIT_SOL) {
          console.log(`  [EXECUTOR] 🛑 LIVE BUY skipped — daily loss limit: ${todayLosses} losses, real SOL lost: ${totalLossSol.toFixed(3)} (max ${DAILY_LOSS_LIMIT_SOL} SOL, resets midnight UTC)`);
          continue;
        }

        // ── Entry filter: token age ≥ MIN_TOKEN_AGE_MINUTES ──
        // Uses min(coin_signals.signal_time) as proxy for first-seen. If
        // no prior signal exists for this mint, we consider it age=0 (we
        // are the first observation) and skip — that's the freshest
        // bucket and the worst-performing in today's postmortem.
        {
          const { data: firstSignal } = await supabase
            .from("coin_signals")
            .select("signal_time")
            .eq("coin_address", trade.coin_address)
            .order("signal_time", { ascending: true })
            .limit(1);
          const firstSeenMs = firstSignal?.[0]
            ? new Date(firstSignal[0].signal_time).getTime()
            : Date.now();
          const ageMin = (Date.now() - firstSeenMs) / 60_000;
          if (ageMin < MIN_TOKEN_AGE_MINUTES) {
            console.log(
              `  [FILTER] SKIP ${coin} — age ${ageMin.toFixed(1)}min < ${MIN_TOKEN_AGE_MINUTES}min threshold`
            );
            continue;
          }
        }

        // ── Entry filter: co-buyer ceiling ≤ MAX_CO_BUYERS_5MIN ──
        // Count distinct wallet_tag values with a BUY signal on this mint
        // in the last 5 minutes. If > threshold, skip — cluster buys
        // anti-selected fat-tail winners in today's postmortem.
        {
          const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
          const { data: recentBuys } = await supabase
            .from("coin_signals")
            .select("wallet_tag")
            .eq("coin_address", trade.coin_address)
            .eq("transaction_type", "BUY")
            .gte("signal_time", fiveMinAgo);
          const distinctTags = new Set(
            (recentBuys ?? []).map((r) => r.wallet_tag)
          );
          if (distinctTags.size > MAX_CO_BUYERS_5MIN) {
            console.log(
              `  [FILTER] SKIP ${coin} — ${distinctTags.size} co-buyers in last 5min > ${MAX_CO_BUYERS_5MIN}`
            );
            continue;
          }
        }

        activeBuys.add(trade.coin_address);
        try {
          const sig = await buyToken(trade.coin_address, LIVE_BUY_SOL);
          if (sig) {
            console.log(`  [EXECUTOR] 🔴 LIVE BUY executed: ${sig}`);
            // Tag as [LIVE]
            await supabase
              .from("trades")
              .update({ wallet_tag: `${trade.wallet_tag} [LIVE]` })
              .eq("id", trade.id);

            // Sprint 9 P0 — record real SOL cost basis for accurate PnL.
            // Separate UPDATE so legacy schema (pre-migration 012) doesn't
            // break the main close path — the new columns are optional.
            (async () => {
              const delta = await parseSwapSolDelta(sig);
              if (delta !== null) {
                // For a buy, delta is negative (SOL leaving wallet). Store the
                // absolute cost (positive) in entry_sol_cost.
                const costSol = Math.abs(delta);
                try {
                  await supabase
                    .from("trades")
                    .update({ buy_tx_sig: sig, entry_sol_cost: costSol })
                    .eq("id", trade.id);
                  console.log(`  [EXECUTOR] 📊 real entry cost: ${costSol.toFixed(6)} SOL`);
                } catch (err: any) {
                  console.error(`  [EXECUTOR] entry_sol_cost write failed: ${err.message}`);
                }
              }
            })().catch(() => {});
          } else {
            console.log(`  [EXECUTOR] ⚠️ Buy failed — marking failed; will rescue-check in ${BUY_RESCUE_DELAY_MS / 60_000}min`);
            await supabase
              .from("trades")
              .update({ status: "failed", exit_reason: "buy_failed" })
              .eq("id", trade.id);

            void sendAlert(
              "buy_failed",
              `BUY failed: ${coin} — will verify on-chain in ${BUY_RESCUE_DELAY_MS / 60_000}min`
            );

            // ─── Rescue path: late-confirm the buy ───
            // Solana sometimes lands txs after our 60s confirm window. If the
            // wallet ends up holding the token, the buy actually succeeded —
            // re-open the trade and tag [LIVE] so the guard takes over.
            scheduleBuyRescue(trade.id, trade.coin_address, trade.wallet_tag, coin);
          }
        } finally {
          activeBuys.delete(trade.coin_address);
        }
      }
    } catch (err: any) {
      console.error("  [EXECUTOR] Poll error:", err.message);
    }
  }, POLL_MS);

  console.log("  [EXECUTOR] Polling for new trades every 3s");
}
