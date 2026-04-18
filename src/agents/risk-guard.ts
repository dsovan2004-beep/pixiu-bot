/**
 * PixiuBot Agent 5 — Risk Guard
 *
 * Polls open positions every 5s from paper_trades table.
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
import { sellToken, hasTokenBalance, wasLastSellUnsellable } from "../lib/jupiter-swap";
import { sendAlert } from "../lib/telegram";

const POSITION_CHECK_MS = 5_000;

async function isLiveTrading(): Promise<boolean> {
  // SAFETY: default to false (paper) on ANY failure — never accidentally go live
  try {
    const { data, error } = await supabase
      .from("bot_state")
      .select("mode")
      .limit(1)
      .single();
    if (error || !data) {
      console.error("  [GUARD] ⚠️ Failed to read bot_state — defaulting to PAPER");
      return false;
    }
    return data.mode === "live";
  } catch {
    console.error("  [GUARD] ⚠️ bot_state query crashed — defaulting to PAPER");
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
  // Each trade's real SOL loss = LIVE_BUY_SOL × |pnl_pct| / 100.
  // pnl_pct is already the blended outcome across grid partials, so this
  // correctly accounts for L1/L2 locked profits reducing net loss.
  const todayStart = `${todayUTC}T00:00:00Z`;
  const { data: losses } = await supabase
    .from("paper_trades")
    .select("pnl_pct")
    .eq("status", "closed")
    .gte("exit_time", todayStart)
    .lt("pnl_pct", 0)
    .like("wallet_tag", "%[LIVE]%");

  if (!losses || losses.length === 0) return;

  const totalLossSol = losses.reduce((sum, t) => {
    const pct = Number(t.pnl_pct);
    return sum + (LIVE_BUY_SOL * Math.abs(pct)) / 100;
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
const CIRCUIT_BREAKER_PCT = 25;
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

// ─── Bankroll ───────────────────────────────────────────

async function updateBankroll(pnlUsd: number): Promise<void> {
  const { data: bankroll } = await supabase
    .from("paper_bankroll")
    .select("id, current_balance, starting_balance")
    .limit(1)
    .single();

  if (!bankroll) return;

  const newBalance = Number(bankroll.current_balance) + pnlUsd;
  const startBal = Number(bankroll.starting_balance || 10000);
  const totalPnl = newBalance - startBal;

  await supabase
    .from("paper_bankroll")
    .update({
      current_balance: newBalance,
      total_pnl_usd: totalPnl,
      updated_at: new Date().toISOString(),
    })
    .eq("id", bankroll.id);

  const sign = pnlUsd >= 0 ? "+" : "";
  console.log(
    `  [GUARD] Bankroll: $${Number(bankroll.current_balance).toFixed(2)} → $${newBalance.toFixed(2)} (${sign}$${pnlUsd.toFixed(2)})`
  );
}

// Track positions already being closed to prevent duplicate exits
const closingPositions = new Set<string>();

// ─── Position Check Loop ────────────────────────────────

async function checkPositions(): Promise<void> {
  // Guard ALWAYS runs — even when bot is stopped
  // STOP BOT only blocks new entries (executor), never exits
  // Open positions must always be monitored for SL/CB/whale protection

  // Reaper: revert any 'closing' rows older than 5 minutes back to 'open'.
  // This recovers from bot crashes mid-sell (sell never landed AND status stuck).
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  await supabase
    .from("paper_trades")
    .update({ status: "open" })
    .eq("status", "closing")
    .lt("entry_time", fiveMinAgo);

  const { data: positions, error } = await supabase
    .from("paper_trades")
    .select("*")
    .eq("status", "open");

  if (error || !positions || positions.length === 0) return;

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
        .from("paper_trades")
        .update({ status: "closing" })
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
          console.log(`  [GUARD] Token balance 0 — marking ${coinLabel} as closed (locked PnL: ${closedPnl.toFixed(2)}%)`);
          const ep = exitPrice ?? currentPrice;
          const closedPnlUsd = (closedPnl / 100) * posSize;
          // IDEMPOTENT close: only transition 'closing' → 'closed'. If the row
          // is already closed (by any prior path), the update matches 0 rows
          // and we skip the bankroll credit — prevents the double-credit bug
          // observed on Deep Fucking Value.
          const { data: flipped } = await supabase
            .from("paper_trades")
            .update({
              exit_price: ep,
              pnl_pct: closedPnl,
              pnl_usd: closedPnlUsd,
              status: "closed",
              exit_time: new Date().toISOString(),
              exit_reason: gridLvl > 0 ? "take_profit" : "rug_or_missing",
              grid_level: gridLvl,
              remaining_pct: 0,
              partial_pnl: closedPnl,
            })
            .eq("id", pos.id)
            .eq("status", "closing")
            .is("pnl_usd", null)               // P0b: bankroll-credit latch
            .select("id")
            .maybeSingle();
          if (!flipped) {
            console.log(`  [GUARD] ⚠️ ${coinLabel} already closed/credited by another path — skipping bankroll credit`);
            return;
          }
          await updateBankroll(closedPnlUsd);
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
            const zeroPnlUsd = (zeroPnlPct / 100) * posSize;
            console.log(
              `  [GUARD] 🪦 ${coinLabel} un-sellable (Jupiter 6024) — marking remaining ${remainingPct}% to zero. Final PnL ${zeroPnlPct.toFixed(2)}%`
            );
            const { data: flipped } = await supabase
              .from("paper_trades")
              .update({
                exit_price: 0,
                pnl_pct: zeroPnlPct,
                pnl_usd: zeroPnlUsd,
                status: "closed",
                exit_time: new Date().toISOString(),
                exit_reason: "unsellable_6024",
                grid_level: gridLvl,
                remaining_pct: 0,
                partial_pnl: zeroPnlPct,
              })
              .eq("id", pos.id)
              .eq("status", "closing")
              .is("pnl_usd", null)              // P0b: bankroll-credit latch
              .select("id")
              .maybeSingle();
            if (!flipped) {
              console.log(`  [GUARD] ⚠️ ${coinLabel} already closed/credited — skipping bankroll credit`);
              return;
            }
            await updateBankroll(zeroPnlUsd);
            void sendAlert("sell_failed", `${coinLabel} un-sellable (6024) — marked to zero. PnL ${zeroPnlPct.toFixed(2)}%`);
            return;
          }
          // (b) transient — revert closing → open for retry
          sellLanded = false;
          console.log(`  [GUARD] ⚠️ LIVE SELL failed for ${coinLabel} (held tokens but Jupiter rejected) — reverting status to 'open' for retry`);
          await supabase
            .from("paper_trades")
            .update({ status: "open" })
            .eq("id", pos.id)
            .eq("status", "closing");          // P0b: only revert rows still in closing state
          void sendAlert(
            "sell_failed",
            `SELL failed: ${coinLabel} (${exitReason}). Position re-opened, will retry next poll.`
          );
          return;
        }
      }

      // 4. Sell landed (or paper trade) — finalize close + credit bankroll exactly once.
      // IDEMPOTENT close: only transition 'closing' → 'closed'. If another path
      // already closed the row, the update matches 0 rows and we skip the
      // bankroll credit + the Telegram alert. Same pattern as the !held branch
      // above — prevents the double-credit bug observed on Deep Fucking Value.
      const ep = exitPrice ?? currentPrice;
      const pnlUsd = (finalPnl / 100) * posSize;
      const { data: flipped } = await supabase
        .from("paper_trades")
        .update({
          exit_price: ep,
          pnl_pct: finalPnl,
          pnl_usd: pnlUsd,
          status: "closed",
          exit_time: new Date().toISOString(),
          exit_reason: exitReason,
          grid_level: gridLvl,
          remaining_pct: 0,
          partial_pnl: finalPnl,
        })
        .eq("id", pos.id)
        .eq("status", "closing")
        .is("pnl_usd", null)                     // P0b: bankroll-credit latch
        .select("id")
        .maybeSingle();
      if (!flipped) {
        console.log(`  [GUARD] ⚠️ ${coinLabel} already closed/credited by another path — skipping bankroll credit`);
        return;
      }
      await updateBankroll(pnlUsd);

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
          `${coinLabel} exit (${exitReason}): ${sign}${finalPnl.toFixed(2)}% / ${sign}$${pnlUsd.toFixed(2)}`
        );
      }
    }

    // 0a. Minimum hold time — skip all checks except CB if trade is < 30s old
    // Prevents immediate exits from stale signals or price echo
    const MIN_HOLD_SECONDS = 30;
    const secondsOpen = minutesOpen * 60;
    if (secondsOpen < MIN_HOLD_SECONDS) {
      // Only allow circuit breaker through during hold period
      if (!priceFetchFailed && pnlPct <= -CIRCUIT_BREAKER_PCT) {
        const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
        await closeTrade(finalPnl, "circuit_breaker", currentLevel);
        console.log(
          `  [GUARD] 🚨 ${coinLabel} crashed ${pnlPct.toFixed(1)}% during hold period — emergency exit`
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
    console.log(
      `  [GUARD CB CHECK] ${coinLabel} pnlPct=${pnlPct.toFixed(1)}% L${currentLevel} ${remainingPct}% remaining (entry:$${entryPrice} now:$${currentPrice} src:${source})`
    );

    if (!priceFetchFailed && pnlPct <= -CIRCUIT_BREAKER_PCT) {
      const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
      await closeTrade(finalPnl, "circuit_breaker", currentLevel);
      console.log(
        `  [GUARD] 🚨 ${coinLabel} crashed ${pnlPct.toFixed(1)}% — emergency exit | PnL: ${finalPnl.toFixed(2)}%`
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
      if (whaleExits.length > 0) {
        const whaleTag = whaleExits[0].wallet_tag;
        const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
        await closeTrade(finalPnl, "whale_exit", currentLevel);
        console.log(
          `  [GUARD] 🐳 ${whaleTag} sold ${coinLabel} — exiting with whale | PnL: ${finalPnl >= 0 ? "+" : ""}${finalPnl.toFixed(2)}%`
        );
        continue;
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
        .from("paper_trades")
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
    `  [GUARD] Exit priority: CB(-${CIRCUIT_BREAKER_PCT}%) > Whale > SL(-${STOP_LOSS_PCT}%) > TO(${TIMEOUT_MINUTES}min) > Grid | Poll: ${POSITION_CHECK_MS / 1000}s`
  );

  // Run immediately
  await checkPositions();

  // Poll every 15s
  setInterval(checkPositions, POSITION_CHECK_MS);

  console.log(`  [GUARD] Polling open positions every ${POSITION_CHECK_MS / 1000}s`);
}
