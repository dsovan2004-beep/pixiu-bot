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
import { TOP_ELITE_ADDRESSES } from "../config/smart-money";
import { sellToken } from "../lib/jupiter-swap";

const POSITION_CHECK_MS = 5_000;

async function isLiveTrading(): Promise<boolean> {
  const { data } = await supabase
    .from("bot_state")
    .select("mode")
    .limit(1)
    .single();
  if (data?.mode === "live") return true;
  if (data?.mode === "paper") return false;
  return process.env.LIVE_TRADING === "true";
}

// Daily loss limit: stop live trades if losses exceed threshold
const DAILY_LOSS_LIMIT_SOL = 0.2; // ~$17 at current prices
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

  // Query today's closed trades with negative PnL
  const todayStart = `${todayUTC}T00:00:00Z`;
  const { data: losses } = await supabase
    .from("paper_trades")
    .select("pnl_usd")
    .eq("status", "closed")
    .gte("exit_time", todayStart)
    .lt("pnl_usd", 0);

  if (!losses || losses.length === 0) return;

  const totalLossUsd = losses.reduce((sum, t) => sum + Math.abs(Number(t.pnl_usd || 0)), 0);
  // Rough SOL conversion ($85/SOL approximate)
  const totalLossSol = totalLossUsd / 85;

  if (totalLossSol >= DAILY_LOSS_LIMIT_SOL) {
    dailyLossLimitHit = true;
    console.log(
      `  [GUARD] 🛑 Daily loss limit hit — ${totalLossSol.toFixed(3)} SOL ($${totalLossUsd.toFixed(2)}) lost today. Stopping live trades.`
    );
  }
}

const GRID_LEVELS = [
  { level: 1, pct: 15, sellPct: 50 },
  { level: 2, pct: 40, sellPct: 25 },
  { level: 3, pct: 100, sellPct: 25 },
];
const STOP_LOSS_PCT = 10;
const CIRCUIT_BREAKER_PCT = 25;
const TIMEOUT_MINUTES = 20;

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

// ─── Position Check Loop ────────────────────────────────

async function checkPositions(): Promise<void> {
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
    async function closeTrade(
      finalPnl: number,
      exitReason: string,
      gridLvl: number,
      exitPrice?: number
    ) {
      const ep = exitPrice ?? currentPrice;
      const pnlUsd = (finalPnl / 100) * posSize;
      await supabase
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
        .eq("id", pos.id);
      await updateBankroll(pnlUsd);

      // Jupiter live sell (if enabled via dashboard and daily limit not hit)
      if (liveMode && !dailyLossLimitHit) {
        const sig = await sellToken(pos.coin_address);
        if (sig) {
          console.log(`  [GUARD] 🔴 LIVE SELL executed: ${sig} (${exitReason})`);
        } else {
          console.log(`  [GUARD] ⚠️ LIVE SELL failed for ${coinLabel} — paper close still recorded`);
        }
      } else if (liveMode && dailyLossLimitHit) {
        console.log(`  [GUARD] 🛑 LIVE SELL skipped for ${coinLabel} — daily loss limit hit`);
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
      `  [GUARD CB CHECK] ${coinLabel} pnlPct=${pnlPct.toFixed(1)}% threshold=-${CIRCUIT_BREAKER_PCT}% (entry:$${entryPrice} now:$${currentPrice} src:${source})`
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

    // 2. Whale Exit — T1 wallet SELL detected
    const { data: smartWalletRows } = await supabase
      .from("tracked_wallets")
      .select("tag")
      .in("wallet_address", Array.from(TOP_ELITE_ADDRESSES));

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

    // 4. Timeout
    if (minutesOpen >= TIMEOUT_MINUTES) {
      const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
      await closeTrade(finalPnl, "timeout", currentLevel);
      console.log(
        `  [GUARD] ⏰ ${coinLabel} timeout ${minutesOpen.toFixed(0)}min | PnL: ${finalPnl >= 0 ? "+" : ""}${finalPnl.toFixed(2)}%`
      );
      continue;
    }

    // 5. Grid Levels
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

    if (remainingPct <= 0) {
      await closeTrade(partialPnl, "take_profit", newLevel);
      console.log(
        `  [GUARD] ✅ ${coinLabel} fully exited at L${newLevel} | PnL: +${partialPnl.toFixed(2)}%`
      );
      continue;
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
