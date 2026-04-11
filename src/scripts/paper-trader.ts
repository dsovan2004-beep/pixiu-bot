/**
 * PixiuBot — Position Monitor (Sprint 2)
 * Usage: npx tsx src/scripts/paper-trader.ts
 *
 * Manages open positions: grid exits, stop loss, circuit breaker, whale exit.
 * Entries handled by /api/webhook (instant, event-driven).
 * NO real SOL is spent. Paper only.
 */

import supabase from "../lib/supabase-server";
import { TOP_ELITE_ADDRESSES, PLACEHOLDER_PRICE } from "../config/smart-money";

// ─── Config ──────────────────────────────────────────────

const POSITION_CHECK_MS = 15_000; // Check open positions every 15s — catch fast crashes

// Grid exit levels
const GRID_LEVELS = [
  { level: 1, pct: 15, sellPct: 50 },  // +15% → sell 50% (break-even lock)
  { level: 2, pct: 40, sellPct: 25 },  // +40% → sell 25%
  { level: 3, pct: 100, sellPct: 25 }, // +100% → sell final 25%, close
];
const STOP_LOSS_PCT = 10; // -10% on remaining → close all
const TIMEOUT_MINUTES = 20; // Was 30 — exit dead coins faster

// Kill switch
const KILL_SWITCH_MIN_TRADES = 100; // Raised for Round 2 — need more data
const KILL_SWITCH_MIN_WR = 0.55; // 55%

let killSwitchActive = false;

// ─── Price Resolution (multi-source) ─────────────────────

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
// PLACEHOLDER_PRICE imported from config/smart-money.ts

interface PriceResult {
  price: number;
  source: string;
}

async function getPrice(mint: string): Promise<PriceResult> {
  // Source 1: Jupiter Price API
  try {
    const url = `https://price.jup.ag/v6/price?ids=${mint}`;
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      const price = data.data?.[mint]?.price;
      if (typeof price === "number" && price > 0) {
        return { price, source: "jupiter" };
      }
    }
  } catch {}

  // Source 2: DexScreener API
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      const pair = data.pairs?.[0];
      if (pair?.priceUsd) {
        const price = parseFloat(pair.priceUsd);
        if (price > 0) return { price, source: "dexscreener" };
      }
    }
  } catch {}

  // Source 3: Placeholder — still enter trade for signal validation
  return { price: PLACEHOLDER_PRICE, source: "placeholder" };
}

// ─── Bankroll ────────────────────────────────────────────

async function getBankroll(): Promise<{ id: string; current_balance: number }> {
  const { data } = await supabase
    .from("paper_bankroll")
    .select("id, current_balance")
    .limit(1)
    .single();
  return data || { id: "", current_balance: 10000 };
}

async function updateBankroll(pnlUsd: number): Promise<void> {
  const bankroll = await getBankroll();
  const newBalance = Number(bankroll.current_balance) + pnlUsd;
  const { data: startRow } = await supabase
    .from("paper_bankroll")
    .select("starting_balance")
    .limit(1)
    .single();
  const startBal = Number(startRow?.starting_balance || 10000);
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
    `  [BANKROLL] $${Number(bankroll.current_balance).toFixed(2)} → $${newBalance.toFixed(2)} (${sign}$${pnlUsd.toFixed(2)})`
  );
}

// Entry handled by /api/webhook — openPosition removed.

// ─── Check Open Positions (Grid Exit) ────────────────────

async function checkPositions(): Promise<void> {
  const { data: positions, error } = await supabase
    .from("paper_trades")
    .select("*")
    .eq("status", "open");

  if (error || !positions || positions.length === 0) return;

  console.log(`  [CHECK] ${positions.length} open position(s)...`);

  for (const pos of positions) {
    const { price: currentPrice, source } = await getPrice(pos.coin_address);

    if (source === "placeholder" && Number(pos.entry_price) === PLACEHOLDER_PRICE) {
      continue;
    }

    const entryPrice = Number(pos.entry_price);
    const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    const entryTime = new Date(pos.entry_time).getTime();
    const minutesOpen = (Date.now() - entryTime) / 60_000;
    const coinLabel = pos.coin_name || pos.coin_address.slice(0, 8) + "...";
    const currentLevel = pos.grid_level || 0;
    let remainingPct = pos.remaining_pct ?? 100;
    let partialPnl = pos.partial_pnl ?? 0;

    const posSize = Number(pos.position_size_usd) || 100;

    // Helper: close trade and update bankroll
    async function closeTrade(finalPnl: number, exitReason: string, gridLvl: number) {
      const pnlUsd = (finalPnl / 100) * posSize;
      await supabase
        .from("paper_trades")
        .update({
          exit_price: currentPrice,
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
    }

    // ── Circuit Breaker: FIRST CHECK — hard exit on crash (>25% drop) ──
    const CIRCUIT_BREAKER_PCT = 25;

    // Log significant drops for debugging
    if (pnlPct <= -15) {
      console.log(
        `  [WARN] ${coinLabel} at ${pnlPct.toFixed(1)}% (entry: $${entryPrice}, now: $${currentPrice}, src: ${source})`
      );
    }

    if (pnlPct <= -CIRCUIT_BREAKER_PCT) {
      // Use raw pnlPct for the full remaining position — no weighted calc
      const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
      const pnlUsd = (finalPnl / 100) * posSize;
      await closeTrade(finalPnl, "circuit_breaker", currentLevel);
      console.log(
        `  [CIRCUIT BREAKER] 🚨 ${coinLabel} crashed ${pnlPct.toFixed(1)}% — emergency exit | PnL: ${finalPnl.toFixed(2)}% (-$${Math.abs(pnlUsd).toFixed(2)}) | grid L${currentLevel} | price: $${currentPrice}`
      );
      continue;
    }

    // ── Whale Exit: exit WITH the whale ──
    // Look up Smart Money tags from DB addresses (not hardcoded)
    const { data: smartWalletRows } = await supabase
      .from("tracked_wallets")
      .select("tag")
      .in("wallet_address", Array.from(TOP_ELITE_ADDRESSES));

    const smartMoneyTagsLive = new Set(
      smartWalletRows?.map((w) => w.tag) || []
    );

    const { data: sellSignals } = await supabase
      .from("coin_signals")
      .select("wallet_tag, signal_time")
      .eq("coin_address", pos.coin_address)
      .eq("transaction_type", "SELL")
      .gte("signal_time", new Date(entryTime).toISOString())
      .limit(10);

    if (sellSignals && sellSignals.length > 0) {
      // Check if ANY sell signal is from a Smart Money wallet
      const whaleExits = sellSignals.filter((s) => smartMoneyTagsLive.has(s.wallet_tag));
      if (whaleExits.length > 0) {
        const whaleTag = whaleExits[0].wallet_tag;
        const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
        const pnlUsd = (finalPnl / 100) * posSize;
        await closeTrade(finalPnl, "whale_exit", currentLevel);
        console.log(
          `  [WHALE EXIT] 🐳 ${whaleTag} sold ${coinLabel} — exiting with whale | PnL: ${finalPnl >= 0 ? "+" : ""}${finalPnl.toFixed(2)}% ($${pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(2)})`
        );
        continue;
      }
    }

    // ── Stop Loss: close everything immediately ──
    if (pnlPct <= -STOP_LOSS_PCT) {
      const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
      await closeTrade(finalPnl, "stop_loss", currentLevel);
      const pnlUsd = (finalPnl / 100) * posSize;
      console.log(
        `  [STOP LOSS] ❌ ${coinLabel} | PnL: ${finalPnl >= 0 ? "+" : ""}${finalPnl.toFixed(2)}% ($${pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(2)}) | grid L${currentLevel}`
      );
      continue;
    }

    // ── Timeout: close whatever remains ──
    if (minutesOpen >= TIMEOUT_MINUTES) {
      const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
      await closeTrade(finalPnl, "timeout", currentLevel);
      const pnlUsd = (finalPnl / 100) * posSize;
      console.log(
        `  [TIMEOUT] ⏰ ${coinLabel} | PnL: ${finalPnl >= 0 ? "+" : ""}${finalPnl.toFixed(2)}% ($${pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(2)}) | grid L${currentLevel} | ${minutesOpen.toFixed(0)}min`
      );
      continue;
    }

    // ── Grid Levels: check if we hit the next level ──
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

      const lockedUsd = (partialPnl / 100) * posSize;
      console.log(
        `  [GRID L${grid.level}] ${coinLabel} → sold ${grid.sellPct}% at +${grid.pct}% | locked: +${partialPnl.toFixed(2)}% (+$${lockedUsd.toFixed(2)}) | ${remainingPct}% remaining`
      );
    }

    // If we hit level 4 (or remaining is 0), close the trade
    if (remainingPct <= 0) {
      await closeTrade(partialPnl, "take_profit", newLevel);
      const pnlUsd = (partialPnl / 100) * posSize;
      console.log(
        `  [GRID COMPLETE] ✅ ${coinLabel} fully exited at L${newLevel} | PnL: +${partialPnl.toFixed(2)}% (+$${pnlUsd.toFixed(2)})`
      );
      continue;
    }

    // Update partial exit progress if any grid level was hit
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

// ─── Kill Switch Check ───────────────────────────────────

async function checkKillSwitch(): Promise<void> {
  const { data: closed } = await supabase
    .from("paper_trades")
    .select("pnl_pct")
    .eq("status", "closed");

  if (!closed || closed.length < KILL_SWITCH_MIN_TRADES) return;

  const wins = closed.filter((t) => Number(t.pnl_pct) > 0).length;
  const wr = wins / closed.length;

  if (wr < KILL_SWITCH_MIN_WR) {
    if (!killSwitchActive) {
      killSwitchActive = true;
      console.log(
        `\n  ⚠️  [KILL SWITCH] Win rate ${(wr * 100).toFixed(1)}% < ${KILL_SWITCH_MIN_WR * 100}% after ${closed.length} trades. PAUSING new entries.\n`
      );
    }
  } else {
    if (killSwitchActive) {
      killSwitchActive = false;
      console.log(`  [KILL SWITCH] Win rate recovered to ${(wr * 100).toFixed(1)}%. Resuming.`);
    }
  }
}

// ─── Stats ───────────────────────────────────────────────

async function printStats(): Promise<void> {
  const { data: closed } = await supabase
    .from("paper_trades")
    .select("pnl_pct, exit_reason")
    .eq("status", "closed");

  const { count: openCount } = await supabase
    .from("paper_trades")
    .select("id", { count: "exact", head: true })
    .eq("status", "open");

  if (!closed || closed.length === 0) {
    console.log(`  [STATS] Open: ${openCount || 0} | Closed: 0`);
    return;
  }

  const wins = closed.filter((t) => Number(t.pnl_pct) > 0);
  const losses = closed.filter((t) => Number(t.pnl_pct) <= 0);
  const wr = ((wins.length / closed.length) * 100).toFixed(1);
  const avgWin =
    wins.length > 0
      ? (wins.reduce((s, t) => s + Number(t.pnl_pct), 0) / wins.length).toFixed(2)
      : "0";
  const avgLoss =
    losses.length > 0
      ? (losses.reduce((s, t) => s + Number(t.pnl_pct), 0) / losses.length).toFixed(2)
      : "0";

  const tpCount = closed.filter((t) => t.exit_reason === "take_profit").length;
  const slCount = closed.filter((t) => t.exit_reason === "stop_loss").length;
  const toCount = closed.filter((t) => t.exit_reason === "timeout").length;

  console.log(
    `  [STATS] Open: ${openCount || 0} | Closed: ${closed.length} | WR: ${wr}% | Avg Win: +${avgWin}% | Avg Loss: ${avgLoss}% | TP: ${tpCount} SL: ${slCount} TO: ${toCount}`
  );
}

// ─── Main Loop ───────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Position Monitor (Sprint 2)");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Mode:         PAPER ONLY — zero real SOL spent`);
  console.log(`  Entry:        Event-driven (webhook instant entry)`);
  console.log(`  Exit grid:    L1 +15% (50%) | L2 +40% (25%) | L3 +100% (25%)`);
  console.log(`  Stop loss:    -${STOP_LOSS_PCT}% | Circuit breaker: -25%`);
  console.log(`  Timeout:      ${TIMEOUT_MINUTES}min | Whale exit: T1 SELL detection`);
  console.log(`  Position chk: Every ${POSITION_CHECK_MS / 1000}s`);
  console.log(`  Kill switch:  WR < ${KILL_SWITCH_MIN_WR * 100}% after ${KILL_SWITCH_MIN_TRADES} trades`);
  console.log(`  Started:      ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // ── Startup: backfill and sync bankroll ──
  async function syncBankroll(): Promise<void> {
    const DEFAULT_POS_SIZE = 100;

    // Backfill trades missing pnl_usd or position_size_usd
    const { data: needsBackfill } = await supabase
      .from("paper_trades")
      .select("id, pnl_pct, pnl_usd, position_size_usd")
      .eq("status", "closed");

    if (needsBackfill) {
      let backfilled = 0;
      for (const t of needsBackfill) {
        const posSize = Number(t.position_size_usd) || DEFAULT_POS_SIZE;
        const existingUsd = Number(t.pnl_usd);
        if (existingUsd === 0 && t.pnl_pct !== null) {
          const pnlUsd = (Number(t.pnl_pct) / 100) * posSize;
          await supabase
            .from("paper_trades")
            .update({ pnl_usd: pnlUsd, position_size_usd: posSize })
            .eq("id", t.id);
          backfilled++;
        }
      }
      if (backfilled > 0) {
        console.log(`  [BANKROLL SYNC] Backfilled pnl_usd for ${backfilled} trade(s)`);
      }
    }

    // Recalculate bankroll from all closed trades
    const { data: allClosed } = await supabase
      .from("paper_trades")
      .select("pnl_pct, pnl_usd, position_size_usd")
      .eq("status", "closed");

    let totalPnlUsd = 0;
    for (const t of allClosed || []) {
      const posSize = Number(t.position_size_usd) || DEFAULT_POS_SIZE;
      const pnlUsd = Number(t.pnl_usd) || (Number(t.pnl_pct) / 100) * posSize;
      totalPnlUsd += pnlUsd;
    }

    const bankroll = await getBankroll();
    const { data: startRow } = await supabase
      .from("paper_bankroll")
      .select("starting_balance")
      .limit(1)
      .single();
    const startBal = Number(startRow?.starting_balance || 10000);
    const newBalance = startBal + totalPnlUsd;

    await supabase
      .from("paper_bankroll")
      .update({
        current_balance: newBalance,
        total_pnl_usd: totalPnlUsd,
        updated_at: new Date().toISOString(),
      })
      .eq("id", bankroll.id);

    console.log(
      `  [BANKROLL SYNC] Synced from ${allClosed?.length || 0} closed trades | Total PnL: ${totalPnlUsd >= 0 ? "+" : ""}$${totalPnlUsd.toFixed(2)} | Balance: $${newBalance.toFixed(2)}`
    );
  }

  await syncBankroll();

  // Position check loop — exits only, entries handled by webhook
  async function positionTick(): Promise<void> {
    await checkPositions();
    await checkKillSwitch();
    await printStats();
  }

  // Run immediately
  await positionTick();

  // Set up interval — exits every 15s
  setInterval(positionTick, POSITION_CHECK_MS);

  console.log("  [POSITION MONITOR] Running — entries handled by /api/webhook\n");

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n  [SHUTDOWN] Paper trader stopped.");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Paper trader failed:", err);
  process.exit(1);
});
