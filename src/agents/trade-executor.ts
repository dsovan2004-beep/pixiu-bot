/**
 * PixiuBot Agent 4 — Trade Executor (Live Buy)
 *
 * Polls trades every 3s for new open positions.
 * If live mode ON → fires Jupiter buy → tags [LIVE].
 * Webhook handles all entry logic (evaluateAndEnter).
 * This agent ONLY handles the live Jupiter buy layer.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import supabase from "../lib/supabase-server";
import { buyToken, hasTokenBalance, parseSwapSolDelta, simulateRoundTripRecovery } from "../lib/jupiter-swap";

// RPC connection for mint-account introspection (freeze-authority check).
// Separate from Jupiter's connection inside jupiter-swap.ts — reads only.
const HELIUS_KEY = process.env.HELIUS_API_KEY || "";
const introspectConn = new Connection(
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`,
  "confirmed"
);
import {
  LIVE_BUY_SOL,
  DAILY_LOSS_LIMIT_SOL,
  BUY_RESCUE_DELAY_MS,
  MIN_TOKEN_AGE_MINUTES,
  MAX_CO_BUYERS_5MIN,
  MIN_ROUND_TRIP_RECOVERY,
  WALLET_BLACKLIST_TAGS,
  DUMP_PATTERN_MIN_SIGNALS,
  DUMP_PATTERN_WINDOW_MS,
  ELITE_WALLET_TAGS,
  ELITE_BUY_SOL,
  getBuySolForWalletTag,
  getPrimaryWalletTag,
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
          // Mark the row as failed so it doesn't accumulate in the open
          // set. Previously we just `continue`d — each subsequent executor
          // poll would re-evaluate and skip the same row, leaving it at
          // status='open' indefinitely. Observed in the Apr 21 daily-limit
          // window: 43+ phantom open rows piled up because the webhook
          // kept inserting signals (bot_state.is_running=true) while the
          // per-buy counter blocked every entry. After midnight UTC the
          // counter resets and those stale signals (hours old, token
          // likely dead) would start getting bought — the age filter
          // doesn't save us because `ageMin` is "first signal time",
          // which only grows with age.
          await supabase
            .from("trades")
            .update({ status: "failed", exit_reason: "filter_daily_limit" })
            .eq("id", trade.id)
            .eq("status", "open");
          continue;
        }

        // ── Entry filters: compute metrics once, log pass/skip ──
        // Both filters query coin_signals; we run them together so the
        // PASS log can report both dimensions (age + co-buyer count).
        let ageMin = 0;
        let coBuyerCount = 0;
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
          ageMin = (Date.now() - firstSeenMs) / 60_000;

          const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
          const { data: recentBuys } = await supabase
            .from("coin_signals")
            .select("wallet_tag")
            .eq("coin_address", trade.coin_address)
            .eq("transaction_type", "BUY")
            .gte("signal_time", fiveMinAgo);
          coBuyerCount = new Set(
            (recentBuys ?? []).map((r) => r.wallet_tag)
          ).size;
        }

        // ── Filter: freeze authority pre-buy check ──
        // SolRugDetector (ArXiv 2603.24625) validated rule: if mint has
        // a freeze authority set, creator can freeze any holder's
        // account at will — classic rug vector. Legit pump.fun tokens
        // have freeze_authority = null (revoked at mint). Only 2 of 117
        // confirmed rugs in the SolRugDetector study used this mechanism,
        // so this filter catches a small but clean class with near-zero
        // false positives.
        try {
          const info = await introspectConn.getParsedAccountInfo(
            new PublicKey(trade.coin_address)
          );
          const parsed = (info.value?.data as any)?.parsed?.info;
          const freezeAuth = parsed?.freezeAuthority;
          if (freezeAuth != null && freezeAuth !== "") {
            console.log(
              `  [FILTER] SKIP ${coin} — freeze authority present: ${freezeAuth.slice(0, 8)}...`
            );
            await supabase
              .from("trades")
              .update({ status: "failed", exit_reason: "filter_freeze_auth" })
              .eq("id", trade.id)
              .eq("status", "open");
            continue;
          }
        } catch (err: any) {
          // RPC failure → don't block trade, just log. Next filter may still skip.
          console.log(`  [FILTER] freeze auth check failed for ${coin}: ${err.message} — proceeding`);
        }

        if (ageMin < MIN_TOKEN_AGE_MINUTES) {
          console.log(
            `  [FILTER] SKIP ${coin} — age ${ageMin.toFixed(1)}min < ${MIN_TOKEN_AGE_MINUTES}min threshold`
          );
          // Mark row so guard doesn't adopt it as a phantom position
          // after the 2-min pre-confirmation window. Uses status='failed'
          // so dashboard filters it out of WR/PnL stats.
          await supabase
            .from("trades")
            .update({ status: "failed", exit_reason: "filter_age" })
            .eq("id", trade.id)
            .eq("status", "open");
          continue;
        }
        if (coBuyerCount > MAX_CO_BUYERS_5MIN) {
          console.log(
            `  [FILTER] SKIP ${coin} — ${coBuyerCount} co-buyers in last 5min > ${MAX_CO_BUYERS_5MIN}`
          );
          await supabase
            .from("trades")
            .update({ status: "failed", exit_reason: "filter_cobuyers" })
            .eq("id", trade.id)
            .eq("status", "open");
          continue;
        }

        // ── Filter: dump-pattern (blacklist-tag signal density) ──
        // chloe (Apr 24) lost -0.005 SOL because GMGN_SM_4+Trenchman+
        // jamessmith spam-cycled BUY/SELL 40+ times in the hour before
        // GMGN_T1_1 (legit) signaled. Co-buyer filter only looked at 5min
        // BUYs and missed the broader dump pattern. This filter counts any
        // signal (BUY or SELL) from blacklisted wallet tags in a wider
        // 15min window. ≥ 3 blacklisted-wallet touches = this coin is
        // being actively pumped+dumped, skip regardless of primary
        // signaler legitimacy.
        const dumpWindowStart = new Date(
          Date.now() - DUMP_PATTERN_WINDOW_MS
        ).toISOString();
        const { data: recentSignals } = await supabase
          .from("coin_signals")
          .select("wallet_tag")
          .eq("coin_address", trade.coin_address)
          .gte("signal_time", dumpWindowStart);
        let blacklistSignalCount = 0;
        const offendingTags = new Set<string>();
        for (const s of recentSignals ?? []) {
          if (s.wallet_tag && WALLET_BLACKLIST_TAGS.has(s.wallet_tag)) {
            blacklistSignalCount++;
            offendingTags.add(s.wallet_tag);
          }
        }
        if (blacklistSignalCount >= DUMP_PATTERN_MIN_SIGNALS) {
          console.log(
            `  [FILTER] SKIP ${coin} — 🩸 DUMP PATTERN: ${blacklistSignalCount} blacklist-wallet signals in last 15min from [${[...offendingTags].join(", ")}]`
          );
          await supabase
            .from("trades")
            .update({ status: "failed", exit_reason: "filter_dump_pattern" })
            .eq("id", trade.id)
            .eq("status", "open");
          continue;
        }

        console.log(
          `  [FILTER] PASS ${coin} — age ${ageMin.toFixed(1)}min, co-buyers ${coBuyerCount}, dump-pattern signals ${blacklistSignalCount}`
        );

        // ── Elite-wallet dynamic sizing (Apr 24) ──
        // theo pump sad and daniww are net-positive proven wallets. Their
        // signals get 2x size (0.05 vs 0.025). All other wallets stay at
        // 0.025 baseline. Sim-recovery and buy amount must match so we
        // validate the actual trade size we're about to execute.
        const primaryTag = getPrimaryWalletTag(trade.wallet_tag);
        const buySol = getBuySolForWalletTag(trade.wallet_tag);
        const isEliteSignal = ELITE_WALLET_TAGS.has(primaryTag);
        if (isEliteSignal) {
          console.log(
            `  [EXECUTOR] ⭐ ELITE SIGNAL — ${primaryTag} → upgrading buy size ${LIVE_BUY_SOL} → ${buySol} SOL`
          );
        }

        // ── Filter: pre-buy round-trip recovery (liquidity trap) ──
        // Quote SOL→TOKEN→SOL at the ACTUAL buy size. If recovery < floor,
        // the pool is too thin to exit cleanly and the trade is a
        // near-guaranteed loser (KICAU MANIA class). Postmortem on
        // 67 trades: 0/14 winners below 90%, 41/53 losers below 90%.
        // Fail-open on Jupiter errors: a null recovery means we
        // couldn't get a quote, which is different from a bad quote,
        // so we proceed rather than miss the entry.
        const rtRecovery = await simulateRoundTripRecovery(trade.coin_address, buySol);
        if (rtRecovery !== null && rtRecovery < MIN_ROUND_TRIP_RECOVERY) {
          console.log(
            `  [FILTER] SKIP ${coin} — liquidity trap: round-trip recovery ${(rtRecovery * 100).toFixed(1)}% < ${(MIN_ROUND_TRIP_RECOVERY * 100).toFixed(0)}% floor`
          );
          await supabase
            .from("trades")
            .update({ status: "failed", exit_reason: "filter_liquidity" })
            .eq("id", trade.id)
            .eq("status", "open");
          continue;
        }
        if (rtRecovery !== null) {
          console.log(
            `  [FILTER] PASS ${coin} — round-trip recovery ${(rtRecovery * 100).toFixed(1)}%`
          );
        } else {
          console.log(
            `  [FILTER] round-trip recovery unavailable for ${coin} (Jupiter quote failed) — proceeding`
          );
        }

        activeBuys.add(trade.coin_address);
        try {
          const sig = await buyToken(trade.coin_address, buySol);
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
