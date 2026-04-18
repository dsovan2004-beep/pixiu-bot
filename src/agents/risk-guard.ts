/**
 * PixiuBot Agent 5 — Risk Guard
 *
 * Polls open positions every 5s from trades table.
 * Manages all exits with priority order:
 *   1. Circuit breaker: -25% emergency exit
 *   2. Whale exit: T1 wallet SELL detected
 *   3. Stop loss: -10% full exit
 *   4. Timeout: 20min full exit
 *   5. Grid levels: L1 +15% (50%) | L2 +40% (25%) | L3 +100% (25%)
 */

import supabase from "../lib/supabase-server";
import {
  LIVE_BUY_SOL,
  DAILY_LOSS_LIMIT_SOL,
} from "../config/smart-money";
import { sellToken, hasTokenBalance, wasLastSellUnsellable, parseSwapSolDelta } from "../lib/jupiter-swap";
import { sendAlert } from "../lib/telegram";

// Poll cadence split by grid level (Sprint 10 P2a, Apr 18).
// L0 positions have no grid cushion — a fast rug crosses -15% CB
// threshold in under 5s and we'd catch it too late. Poll L0 every 2s.
// L1+ positions have locked partials so 5s is plenty.
const POSITION_CHECK_MS_L0 = 2_000;
const POSITION_CHECK_MS_L1_PLUS = 5_000;
// Used in log banner for backward-compat
const POSITION_CHECK_MS = POSITION_CHECK_MS_L0;

async function isLiveTrading(): Promise<boolean> {
  // SAFETY: default to false (no trading) on ANY failure — never fire buys
  // when the DB can't tell us our mode. Live mode is the only non-safe state.
  try {
    const { data, error } = await supabase
      .from("bot_state")
      .select("mode")
      .limit(1)
      .single();
    if (error || !data) {
      console.error("  [GUARD] ⚠️ Failed to read bot_state — holding trades (no new entries)");
      return false;
    }
    return data.mode === "live";
  } catch {
    console.error("  [GUARD] ⚠️ bot_state query crashed — holding trades (no new entries)");
    return false;
  }
}

// Daily loss limit imported from config/smart-money.ts (single source of truth).
// Real exposure per trade is LIVE_BUY_SOL; daily limit is total LIVE loss in SOL.
let dailyLossLimitHit = false;
let lastLossCheckDate = "";

async function checkDailyLossLimit(): Promise<void> {
  const todayUTC = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Reset at midnight UTC
  if (todayUTC !== lastLossCheckDate) {
    if (dailyLossLimitHit) {
      console.log(`  [GUARD] Daily loss limit reset for ${todayUTC}`);
    }
    dailyLossLimitHit = false;
    lastLossCheckDate = todayUTC;
  }

  if (dailyLossLimitHit) return;

  // Sum REAL SOL lost across losing LIVE trades since midnight UTC.
  // Real ground truth = real_pnl_sol column (on-chain tx delta). Sum only
  // the negative values; abs of that sum is total SOL bled today.
  const todayStart = `${todayUTC}T00:00:00Z`;
  const { data: losses } = await supabase
    .from("trades")
    .select("real_pnl_sol")
    .eq("status", "closed")
    .gte("exit_time", todayStart)
    .lt("real_pnl_sol", 0)
    .like("wallet_tag", "%[LIVE]%");

  if (!losses || losses.length === 0) return;

  const totalLossSol = losses.reduce((sum, t) => {
    const r = t.real_pnl_sol !== null && t.real_pnl_sol !== undefined ? Number(t.real_pnl_sol) : 0;
    return sum + Math.abs(r);
  }, 0);
  const lossCount = losses.length;

  if (totalLossSol >= DAILY_LOSS_LIMIT_SOL) {
    dailyLossLimitHit = true;
    console.log(
      `  [GUARD] 🛑 Daily loss limit hit — ${lossCount} losing trades, real SOL lost: ${totalLossSol.toFixed(3)}`
    );
    void sendAlert(
      "daily_limit",
      `Daily loss limit hit: ${lossCount} losses = ${totalLossSol.toFixed(3)} SOL real. Bot stopped.`
    );
    // Stop the bot via Supabase — executor checks is_running on every poll
    try {
      await supabase
        .from("bot_state")
        .update({ is_running: false })
        .eq("is_running", true);
      console.log(
        `  [GUARD] Daily loss limit reached — setting bot to STOPPED.`
      );
    } catch (err: any) {
      console.error(`  [GUARD] Failed to stop bot: ${err.message}`);
    }
  }
}

// Grid levels ending at L2. L3 (+100%) is no longer a sell — instead it
// activates trailing-stop mode on the remaining 25% so moonshot tokens
// can ride past the old +42.5% cap. See trailing logic below.
const GRID_LEVELS = [
  { level: 1, pct: 15, sellPct: 50 },
  { level: 2, pct: 40, sellPct: 25 },
];
const L3_THRESHOLD_PCT = 100;       // pnl % where trailing mode activates
const TRAILING_STOP_PCT = 20;       // exit when price drops this % from peak
const STOP_LOSS_PCT = 10;
// Circuit breaker thresholds split by grid level (Sprint 9 P2a, Apr 18).
// Real-PnL analysis showed circuit_breaker had 26% real WR / -0.96 SOL on
// 53 trades. Main leak: fast rugs during the 30s min-hold window where
// SL (-10%) is disabled and only CB can fire. Previous -25% threshold
// let positions crash too far before emergency exit. Post L1/L2 grid
// partials we've already locked ≥ +7.5%, so keep the looser -25% for
// those — more tolerance for volatility when downside is capped.
const CIRCUIT_BREAKER_L0_PCT = 15;  // no partials locked yet — exit earlier
const CIRCUIT_BREAKER_PCT = 25;     // L1+ with partials locked — original
const TIMEOUT_MINUTES = 20;

// In-memory peak tracker for trailing mode: tradeId → peak USD price.
// Resets on bot restart (trailing continues from "peak since restart"
// instead of absolute peak — minor degradation, no DB migration needed).
const trailingPeaks = new Map<string, number>();

// ─── Price ──────────────────────────────────────────────

async function getPrice(
  mint: string
): Promise<{ price: number; source: string }> {
  try {
    const res = await fetch(`https://price.jup.ag/v6/price?ids=${mint}`);
    if (res.ok) {
      const data = await res.json();
      const price = data.data?.[mint]?.price;
      if (typeof price === "number" && price > 0)
        return { price, source: "jupiter" };
    }
  } catch {}
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`
    );
    if (res.ok) {
      const data = await res.json();
      const p = data.pairs?.[0]?.priceUsd;
      if (p) {
        const price = parseFloat(p);
        if (price > 0) return { price, source: "dexscreener" };
      }
    }
  } catch {}
  return { price: 0, source: "none" };
}

// Track positions already being closed to prevent duplicate exits
const closingPositions = new Set<string>();

// ─── Position Check Loop ────────────────────────────────

async function checkPositions(levelFilter?: "L0" | "L1_PLUS"): Promise<void> {
  // Guard ALWAYS runs — even when bot is stopped
  // STOP BOT only blocks new entries (executor), never exits
  // Open positions must always be monitored for SL/CB/whale protection

  // Reaper: revert any 'closing' rows that have been stuck >5 min back to 'open'.
  // This recovers from bot crashes mid-sell (sell never landed AND status stuck).
  //
  // IMPORTANT: we check `closing_started_at`, not `entry_time`. entry_time
  // is fixed at buy and has nothing to do with how long the row has been
  // in closing state. Using entry_time caused a flip-flop race where an
  // in-flight close (awaiting Jupiter balance check) got reverted by the
  // other cadence's reaper, causing Yoshi to loop on stop_loss forever
  // (Apr 18 2026 bug).
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  await supabase
    .from("trades")
    .update({ status: "open", closing_started_at: null })
    .eq("status", "closing")
    .lt("closing_started_at", fiveMinAgo);

  const { data: allPositions, error } = await supabase
    .from("trades")
    .select("*")
    .eq("status", "open");

  if (error || !allPositions || allPositions.length === 0) return;

  // Split cadence: L0 polls every 2s, L1+ polls every 5s. Each interval
  // processes only its own grid_level bucket.
  const positions = levelFilter
    ? allPositions.filter((p) => {
        const lvl = p.grid_level || 0;
        return levelFilter === "L0" ? lvl === 0 : lvl > 0;
      })
    : allPositions;
  if (positions.length === 0) return;

  // Check daily loss limit (for live trading)
  const liveMode = await isLiveTrading();
  if (liveMode) await checkDailyLossLimit();

  console.log(`  [GUARD] Checking ${positions.length} open position(s)...`);

  for (const pos of positions) {
    // Skip if this position is already being closed
    if (closingPositions.has(pos.id)) continue;

    // Skip pre-confirmation positions in live mode
    // If live mode + no [LIVE] tag + less than 2min old → buy is still confirming
    // Avoids running grid/SL on positions that may never actually land on-chain
    if (liveMode && !pos.wallet_tag?.includes("[LIVE]")) {
      const ageMs = Date.now() - new Date(pos.entry_time).getTime();
      if (ageMs < 120_000) {
        continue; // Buy still confirming, don't track yet
      }
    }

    const { price: currentPrice, source } = await getPrice(pos.coin_address);
    const entryPrice = Number(pos.entry_price);
    const coinLabel = pos.coin_name || pos.coin_address.slice(0, 8) + "...";
    const currentLevel = pos.grid_level || 0;
    let remainingPct = pos.remaining_pct ?? 100;
    let partialPnl = pos.partial_pnl ?? 0;
    const posSize = Number(pos.position_size_usd) || 100;
    const entryTime = new Date(pos.entry_time).getTime();
    const minutesOpen = (Date.now() - entryTime) / 60_000;

    const priceFetchFailed = source === "none" || currentPrice <= 0;
    const pnlPct =
      entryPrice > 0 && currentPrice > 0
        ? ((currentPrice - entryPrice) / entryPrice) * 100
        : 0;

    // Helper: close trade
    // ORDER: in-memory lock → atomic DB claim → sell on-chain → credit bankroll
    // This prevents the "DB closed + bankroll credited but tokens never sold" bug.
    async function closeTrade(
      finalPnl: number,
      exitReason: string,
      gridLvl: number,
      exitPrice?: number
    ) {
      // 1. In-memory lock — block duplicate fires within same poll cycle
      if (closingPositions.has(pos.id)) return;
      closingPositions.add(pos.id);
      setTimeout(() => closingPositions.delete(pos.id), 60_000);

      const isLiveTrade = pos.wallet_tag?.includes("[LIVE]");

      // 2. Atomic DB claim — flip status='open' → 'closing' (only one writer wins).
      //    If another guard instance already claimed it, abort.
      const { data: claimed, error: claimErr } = await supabase
        .from("trades")
        .update({ status: "closing", closing_started_at: new Date().toISOString() })
        .eq("id", pos.id)
        .eq("status", "open")
        .select("id")
        .single();

      if (claimErr || !claimed) {
        console.log(`  [GUARD] ${coinLabel} close skipped — already claimed by another fire`);
        return;
      }

      // 3. Sell on-chain FIRST (live only). Only proceed to DB close + bankroll
      //    credit if the sell actually lands.
      //
      //    If the wallet has ZERO tokens for this mint, the token is gone —
      //    either already sold (grid partials filled earlier) or rugged to $0.
      //    In both cases, do NOT revert status (that causes infinite retry).
      //    Instead, close the position with locked PnL:
      //      - grid_level > 0: use partial_pnl (locked from earlier L1/L2 sells)
      //      - grid_level = 0: use current pnlPct (likely a rug loss)
      let sellLanded = true;
      if (isLiveTrade) {
        const held = await hasTokenBalance(pos.coin_address);
        if (!held) {
          const closedPnl = gridLvl > 0 ? (pos.partial_pnl ?? finalPnl) : pnlPct;
          console.log(`  [GUARD] Token balance 0 — marking ${coinLabel} as closed (mark ${closedPnl.toFixed(2)}%)`);
          const ep = exitPrice ?? currentPrice;
          // IDEMPOTENT close: only transition 'closing' → 'closed'. If the
          // row is already closed (by any prior path), update matches 0 rows
          // and we return without error.
          const { data: flipped } = await supabase
            .from("trades")
            .update({
              exit_price: ep,
              status: "closed",
              exit_time: new Date().toISOString(),
              exit_reason: gridLvl > 0 ? "take_profit" : "rug_or_missing",
              grid_level: gridLvl,
              remaining_pct: 0,
              partial_pnl: closedPnl,
            })
            .eq("id", pos.id)
            .eq("status", "closing")
            .is("exit_time", null)
            .select("id")
            .maybeSingle();
          if (!flipped) {
            console.log(`  [GUARD] ⚠️ ${coinLabel} already closed by another path — skipping`);
            return;
          }
          void sendAlert(
            gridLvl > 0 ? "take_profit" : "stop_loss",
            `${coinLabel} closed (token balance 0): ${closedPnl >= 0 ? "+" : ""}${closedPnl.toFixed(2)}%`
          );
          return;
        }

        console.log(`  [GUARD] [LIVE SELL] ${coinLabel} grid_level=${gridLvl} remaining=${remainingPct}% — selling via Jupiter`);
        const sig = await sellToken(pos.coin_address);
        if (sig) {
          console.log(`  [GUARD] 🔴 LIVE SELL executed: ${sig} (${exitReason})`);

          // Compute + store REAL PnL from on-chain tx delta. This is the
          // single source of truth for trade outcomes.
          (async () => {
            const solReceived = await parseSwapSolDelta(sig);
            if (solReceived === null) return;
            const { data: row } = await supabase
              .from("trades")
              .select("entry_sol_cost")
              .eq("id", pos.id)
              .maybeSingle();
            const entryCost = row?.entry_sol_cost ? Number(row.entry_sol_cost) : null;
            const realPnlSol = entryCost !== null ? solReceived - entryCost : null;
            try {
              await supabase
                .from("trades")
                .update({
                  sell_tx_sig: sig,
                  ...(realPnlSol !== null ? { real_pnl_sol: realPnlSol } : {}),
                })
                .eq("id", pos.id);
              if (realPnlSol !== null) {
                console.log(`  [GUARD] 📊 real PnL: ${realPnlSol >= 0 ? "+" : ""}${realPnlSol.toFixed(6)} SOL (entry ${entryCost!.toFixed(6)} → received ${solReceived.toFixed(6)})`);
              } else {
                console.log(`  [GUARD] 📊 sell_tx_sig recorded, real_pnl_sol skipped (no entry_sol_cost)`);
              }
            } catch (err: any) {
              console.error(`  [GUARD] real_pnl_sol write failed: ${err.message}`);
            }
          })().catch(() => {});
        } else {
          // Sell failed. Two failure classes:
          //   (a) Jupiter 6024 — un-sellable forever (transfer fee / TLV
          //       blocker). Mark-to-zero the remaining bag instead of
          //       retrying; otherwise the position loops forever. [P0b]
          //   (b) Any other transient failure (429 / network / slippage).
          //       Revert status → open and let next poll retry. The
          //       revert is GATED on status='closing' so we do not
          //       clobber a row that's already been closed by another
          //       path (was the root cause of the double-credit bug).
          if (wasLastSellUnsellable(pos.coin_address)) {
            // (a) mark-to-zero close
            const zeroPnlPct = (pos.partial_pnl ?? 0) + (-100 * remainingPct) / 100;
            console.log(
              `  [GUARD] 🪦 ${coinLabel} un-sellable (Jupiter 6024) — marking remaining ${remainingPct}% to zero. Final mark ${zeroPnlPct.toFixed(2)}%`
            );
            const { data: flipped } = await supabase
              .from("trades")
              .update({
                exit_price: 0,
                status: "closed",
                exit_time: new Date().toISOString(),
                exit_reason: "unsellable_6024",
                grid_level: gridLvl,
                remaining_pct: 0,
                partial_pnl: zeroPnlPct,
              })
              .eq("id", pos.id)
              .eq("status", "closing")
              .is("exit_time", null)
              .select("id")
              .maybeSingle();
            if (!flipped) {
              console.log(`  [GUARD] ⚠️ ${coinLabel} already closed — skipping`);
              return;
            }
            void sendAlert("sell_failed", `${coinLabel} un-sellable (6024) — marked to zero. Mark ${zeroPnlPct.toFixed(2)}%`);
            return;
          }
          // (b) transient — revert closing → open for retry
          sellLanded = false;
          console.log(`  [GUARD] ⚠️ LIVE SELL failed for ${coinLabel} (held tokens but Jupiter rejected) — reverting status to 'open' for retry`);
          await supabase
            .from("trades")
            .update({ status: "open", closing_started_at: null })
            .eq("id", pos.id)
            .eq("status", "closing");          // P0b: only revert rows still in closing state
          void sendAlert(
            "sell_failed",
            `SELL failed: ${coinLabel} (${exitReason}). Position re-opened, will retry next poll.`
          );
          return;
        }
      }

      // 4. Sell landed — finalize close. IDEMPOTENT: only 'closing' → 'closed'.
      const ep = exitPrice ?? currentPrice;
      const { data: flipped } = await supabase
        .from("trades")
        .update({
          exit_price: ep,
          status: "closed",
          exit_time: new Date().toISOString(),
          exit_reason: exitReason,
          grid_level: gridLvl,
          remaining_pct: 0,
          partial_pnl: finalPnl,
        })
        .eq("id", pos.id)
        .eq("status", "closing")
        .is("exit_time", null)
        .select("id")
        .maybeSingle();
      if (!flipped) {
        console.log(`  [GUARD] ⚠️ ${coinLabel} already closed by another path — skipping`);
        return;
      }

      // Telegram alert — only for meaningful exits on LIVE trades
      if (isLiveTrade) {
        const sign = finalPnl >= 0 ? "+" : "";
        const kind: "whale_exit" | "circuit_breaker" | "stop_loss" | "take_profit" =
          exitReason === "whale_exit" ? "whale_exit"
          : exitReason === "circuit_breaker" ? "circuit_breaker"
          : exitReason === "stop_loss" ? "stop_loss"
          : "take_profit";
        void sendAlert(
          kind,
          `${coinLabel} exit (${exitReason}): ${sign}${finalPnl.toFixed(2)}%`
        );
      }
    }

    // 0a. Minimum hold time — skip all checks except CB if trade is < 30s old
    // Prevents immediate exits from stale signals or price echo
    const MIN_HOLD_SECONDS = 30;
    const secondsOpen = minutesOpen * 60;
    // Use tightened L0 threshold (-15%) when no grid has locked yet;
    // revert to normal -25% once L1+ partials are booked.
    const cbThreshold = currentLevel === 0 ? CIRCUIT_BREAKER_L0_PCT : CIRCUIT_BREAKER_PCT;
    if (secondsOpen < MIN_HOLD_SECONDS) {
      // Only allow circuit breaker through during hold period
      if (!priceFetchFailed && pnlPct <= -cbThreshold) {
        const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
        await closeTrade(finalPnl, "circuit_breaker", currentLevel);
        console.log(
          `  [GUARD] 🚨 ${coinLabel} crashed ${pnlPct.toFixed(1)}% during hold period (L${currentLevel} threshold -${cbThreshold}%) — emergency exit`
        );
      }
      continue;
    }

    // 0b. Rug Detection — price=0 means coin is dead, exit immediately
    if (priceFetchFailed && minutesOpen >= 2) {
      // Give new positions 2min grace period (DexScreener may not have data yet)
      const rugPnl = -100; // assume total loss
      const finalPnl = partialPnl + (rugPnl * remainingPct) / 100;
      await closeTrade(finalPnl, "circuit_breaker", currentLevel, 0);
      console.log(
        `  [GUARD] 🚨 ${coinLabel} price=0 detected — treating as rug, exiting now | PnL: ${finalPnl.toFixed(2)}%`
      );
      continue;
    }

    // 1. Circuit Breaker — ABSOLUTE FIRST CHECK
    // Threshold split by grid level: L0 = -15%, L1+ = -25% (see constants above).
    console.log(
      `  [GUARD CB CHECK] ${coinLabel} pnlPct=${pnlPct.toFixed(1)}% L${currentLevel} ${remainingPct}% remaining (entry:$${entryPrice} now:$${currentPrice} src:${source})`
    );

    if (!priceFetchFailed && pnlPct <= -cbThreshold) {
      const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
      await closeTrade(finalPnl, "circuit_breaker", currentLevel);
      console.log(
        `  [GUARD] 🚨 ${coinLabel} crashed ${pnlPct.toFixed(1)}% (L${currentLevel} threshold -${cbThreshold}%) — emergency exit | PnL: ${finalPnl.toFixed(2)}%`
      );
      continue;
    }

    // 1b. Skip non-timeout exits if pnlPct is exactly 0% (price echo / stale data)
    if (pnlPct === 0 && !priceFetchFailed && minutesOpen < TIMEOUT_MINUTES) {
      console.log(
        `  [GUARD] ${coinLabel} pnlPct=0.0% (price echo) — skipping exit checks, waiting for real price movement`
      );
      continue;
    }

    // 2. Whale Exit — T1 wallet SELL detected.
    // Uses DB tier=1 active=true (not the hardcoded config set). The webhook
    // already uses DB tier (commit 027fa83); risk-guard was missed during
    // that migration — only 14/63 T1 wallets were covered until this fix.
    // Sprint 8 Bug-1 fix.
    const { data: smartWalletRows } = await supabase
      .from("tracked_wallets")
      .select("tag")
      .eq("tier", 1)
      .eq("active", true);

    const smartMoneyTags = new Set(
      smartWalletRows?.map((w) => w.tag) || []
    );

    const { data: sellSignals } = await supabase
      .from("coin_signals")
      .select("wallet_tag")
      .eq("coin_address", pos.coin_address)
      .eq("transaction_type", "SELL")
      .gte("signal_time", new Date(entryTime).toISOString())
      .limit(10);

    if (sellSignals && sellSignals.length > 0) {
      const whaleExits = sellSignals.filter((s) =>
        smartMoneyTags.has(s.wallet_tag)
      );
      // Real-PnL analysis (Apr 18 2026) across 310 LIVE trades showed
      // whale_exit as the biggest drain at L0: 94 trades, 23% real WR,
      // net -1.24 SOL. Mid-price-based WR lagged real Jupiter fills.
      //
      // Fix: once L1+ has fired we've already locked ≥ +7.5% on 50% of the
      // position. Let remaining 50% be protected by SL / trailing / timeout
      // — don't panic-sell into the whale's dump. whale_exit stays as a
      // safety net for L0 positions only (where nothing is locked yet).
      if (whaleExits.length > 0 && currentLevel === 0) {
        const whaleTag = whaleExits[0].wallet_tag;
        const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
        await closeTrade(finalPnl, "whale_exit", currentLevel);
        console.log(
          `  [GUARD] 🐳 ${whaleTag} sold ${coinLabel} — exiting with whale | PnL: ${finalPnl >= 0 ? "+" : ""}${finalPnl.toFixed(2)}%`
        );
        continue;
      }
      if (whaleExits.length > 0 && currentLevel > 0) {
        console.log(
          `  [GUARD] whale_exit skipped on ${coinLabel} — already at grid L${currentLevel}, letting grid/trailing handle exit`
        );
      }
    }

    // 3. Stop Loss
    if (pnlPct <= -STOP_LOSS_PCT) {
      const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
      await closeTrade(finalPnl, "stop_loss", currentLevel);
      console.log(
        `  [GUARD] ❌ ${coinLabel} stop loss | PnL: ${finalPnl >= 0 ? "+" : ""}${finalPnl.toFixed(2)}%`
      );
      continue;
    }

    // 4. Timeout — skipped while in trailing-stop mode so moonshot runs
    //    can ride past the 20-min window (airdropper-style +14000% plays).
    const trailingActive = currentLevel === 3 && remainingPct > 0;
    if (!trailingActive && minutesOpen >= TIMEOUT_MINUTES) {
      const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
      await closeTrade(finalPnl, "timeout", currentLevel);
      console.log(
        `  [GUARD] ⏰ ${coinLabel} timeout ${minutesOpen.toFixed(0)}min | PnL: ${finalPnl >= 0 ? "+" : ""}${finalPnl.toFixed(2)}%`
      );
      continue;
    }

    // 5. Grid Levels (L1 & L2 sell as before; L3 activates trailing mode)
    let newLevel = currentLevel;
    let updated = false;

    for (const grid of GRID_LEVELS) {
      if (grid.level <= currentLevel) continue;
      if (pnlPct < grid.pct) break;

      const portionPnl = (grid.pct * grid.sellPct) / 100;
      partialPnl += portionPnl;
      remainingPct -= grid.sellPct;
      newLevel = grid.level;
      updated = true;

      console.log(
        `  [GUARD] [GRID L${grid.level}] ${coinLabel} → sold ${grid.sellPct}% at +${grid.pct}% | ${remainingPct}% remaining`
      );
    }

    // 5a. L3 activation: instead of selling the last 25% at +100%, flip to
    //     trailing-stop mode so the position can ride indefinitely until
    //     the peak drops by TRAILING_STOP_PCT.
    if (!priceFetchFailed && newLevel < 3 && pnlPct >= L3_THRESHOLD_PCT) {
      newLevel = 3;
      updated = true;
      trailingPeaks.set(pos.id, currentPrice);
      console.log(
        `  [GUARD] [TRAILING ACTIVATED] ${coinLabel} at +${pnlPct.toFixed(1)}% — trailing stop engaged (peak $${currentPrice.toFixed(10)}, trail -${TRAILING_STOP_PCT}%)`
      );
    }

    if (remainingPct <= 0) {
      await closeTrade(partialPnl, "take_profit", newLevel);
      console.log(
        `  [GUARD] ✅ ${coinLabel} fully exited at L${newLevel} | PnL: +${partialPnl.toFixed(2)}%`
      );
      continue;
    }

    // 5b. Trailing tick — runs every poll while in L3 trailing state.
    //     Ratchets peak upward; exits if price falls TRAILING_STOP_PCT from peak.
    if (newLevel === 3 && remainingPct > 0 && !priceFetchFailed) {
      let peak = trailingPeaks.get(pos.id);
      if (peak === undefined || currentPrice > peak) {
        peak = currentPrice;
        trailingPeaks.set(pos.id, peak);
      }
      const dropPct = ((currentPrice - peak) / peak) * 100;
      console.log(
        `  [GUARD] [TRAILING] ${coinLabel} at +${pnlPct.toFixed(1)}% — peak $${peak.toFixed(10)}, current $${currentPrice.toFixed(10)}, trail ${dropPct.toFixed(1)}%`
      );
      if (dropPct <= -TRAILING_STOP_PCT) {
        const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
        await closeTrade(finalPnl, "trailing_stop", newLevel);
        trailingPeaks.delete(pos.id);
        console.log(
          `  [GUARD] [TRAILING EXIT] ${coinLabel} sold at +${pnlPct.toFixed(1)}% from ${dropPct.toFixed(1)}% peak drop | PnL: +${finalPnl.toFixed(2)}%`
        );
        continue;
      }
    }

    if (updated) {
      await supabase
        .from("trades")
        .update({
          grid_level: newLevel,
          remaining_pct: remainingPct,
          partial_pnl: partialPnl,
        })
        .eq("id", pos.id);
    }
  }
}

export async function startRiskGuard(): Promise<void> {
  const startLive = await isLiveTrading();
  console.log(`  [GUARD] Starting risk guard... (LIVE: ${startLive ? "🔴 ON" : "⚪ OFF"} — dashboard controlled)`);
  console.log(
    `  [GUARD] Exit priority: CB(L0 -${CIRCUIT_BREAKER_L0_PCT}% / L1+ -${CIRCUIT_BREAKER_PCT}%) > Whale(L0 only) > SL(-${STOP_LOSS_PCT}%) > TO(${TIMEOUT_MINUTES}min) > Grid | Poll: L0 ${POSITION_CHECK_MS_L0 / 1000}s / L1+ ${POSITION_CHECK_MS_L1_PLUS / 1000}s`
  );

  // Run immediately across all positions
  await checkPositions();

  // Split cadence: L0 polls every 2s (fast-rug protection), L1+ every 5s
  // (partials locked, downside capped).
  setInterval(() => checkPositions("L0"), POSITION_CHECK_MS_L0);
  setInterval(() => checkPositions("L1_PLUS"), POSITION_CHECK_MS_L1_PLUS);

  console.log(`  [GUARD] Polling L0 every ${POSITION_CHECK_MS_L0 / 1000}s, L1+ every ${POSITION_CHECK_MS_L1_PLUS / 1000}s`);
}
