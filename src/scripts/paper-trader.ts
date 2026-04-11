/**
 * PixiuBot — Position Monitor (Sprint 2)
 * Usage: npx tsx src/scripts/paper-trader.ts
 *
 * Manages open positions: grid exits, stop loss, circuit breaker, whale exit.
 * Entries handled by /api/webhook (instant, event-driven).
 * NO real SOL is spent. Paper only.
 */

import supabase from "../lib/supabase-server";
import { TOP_ELITE_ADDRESSES, PLACEHOLDER_PRICE, POSITION_SIZE_PCT } from "../config/smart-money";

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

// Track which signals we've already processed
const processedSignalIds = new Set<string>();
let killSwitchActive = false;

// TOP_ELITE_ADDRESSES imported from config/smart-money.ts

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

// ─── Signal Processing ───────────────────────────────────

interface QualifiedSignal {
  id: string;
  coin_address: string;
  coin_name: string | null;
  wallet_tag: string;
  entry_mc: number | null;
  signal_time: string;
  price_gap_minutes: number | null;
  priority: "HIGH" | "normal";
}

async function findNewSignals(): Promise<QualifiedSignal[]> {
  const now = new Date();
  // Look back 120 minutes for signals — maximize volume
  const cutoff = new Date(now.getTime() - 120 * 60_000).toISOString();

  console.log(`  [SCAN] Looking for signals since ${cutoff} (now: ${now.toISOString()})`);

  // Load tag→address map for Smart Money check
  const { data: walletRows } = await supabase
    .from("tracked_wallets")
    .select("wallet_address, tag")
    .eq("active", true);

  const tagToAddress = new Map<string, string>();
  for (const w of walletRows || []) {
    tagToAddress.set(w.tag, w.wallet_address);
  }

  const { data: signals, error } = await supabase
    .from("coin_signals")
    .select("*")
    .eq("rug_check_passed", true)
    .gte("signal_time", cutoff)
    .order("signal_time", { ascending: false });

  if (error || !signals) {
    console.error("  [ERROR] Fetching signals:", error?.message);
    return [];
  }

  console.log(`  [SCAN] Found ${signals.length} rug-passed signals in window`);

  // Diagnostics
  let skipAlreadyProcessed = 0;
  let skipGapTooOld = 0;
  let skipMcTooHigh = 0;
  let skipAlreadyOpen = 0;
  let skipBundle = 0;
  let skipSingleWallet = 0;
  let passedFilters = 0;

  const qualified: QualifiedSignal[] = [];
  const coinGroups = new Map<string, typeof signals>();

  for (const sig of signals) {
    if (processedSignalIds.has(sig.id)) {
      skipAlreadyProcessed++;
      continue;
    }

    const gap = sig.price_gap_minutes ?? 999;
    if (gap > MAX_GAP_MINUTES) {
      skipGapTooOld++;
      if (skipGapTooOld <= 3) {
        console.log(
          `    [SKIP] ${sig.coin_name || sig.coin_address.slice(0, 8)}... gap=${gap}min > ${MAX_GAP_MINUTES}min`
        );
      }
      continue;
    }

    if (sig.entry_mc && Number(sig.entry_mc) > MAX_ENTRY_MC) {
      skipMcTooHigh++;
      continue;
    }

    passedFilters++;
    const group = coinGroups.get(sig.coin_address) || [];
    group.push(sig);
    coinGroups.set(sig.coin_address, group);
  }

  // Check open positions
  const { data: openPositions } = await supabase
    .from("paper_trades")
    .select("coin_address")
    .eq("status", "open");

  const openCoins = new Set(openPositions?.map((p) => p.coin_address) || []);

  // Also check recently closed to avoid re-entering same coin
  const { data: recentClosed } = await supabase
    .from("paper_trades")
    .select("coin_address")
    .eq("status", "closed")
    .gte("exit_time", new Date(now.getTime() - 120 * 60_000).toISOString());

  const recentlyTradedCoins = new Set(recentClosed?.map((p) => p.coin_address) || []);

  for (const [coinAddress, sigs] of coinGroups) {
    const coinLabel = sigs[0].coin_name || coinAddress.slice(0, 8) + "...";

    if (openCoins.has(coinAddress)) {
      skipAlreadyOpen++;
      continue;
    }

    if (recentlyTradedCoins.has(coinAddress)) {
      console.log(`    [SKIP] ${coinLabel} recently traded`);
      continue;
    }

    // ── Bundle Detection ──
    // Count signals per wallet for this coin
    const walletSignalCounts = new Map<string, number>();
    for (const s of sigs) {
      walletSignalCounts.set(s.wallet_tag, (walletSignalCounts.get(s.wallet_tag) || 0) + 1);
    }

    const uniqueWallets = new Set(sigs.map((s) => s.wallet_tag));
    const totalSignals = sigs.length;

    // Bundle check: skip only if 1 wallet = 80%+ of all signals
    let isBundle = false;
    for (const [wallet, count] of walletSignalCounts) {
      if (count / totalSignals >= 0.8 && totalSignals >= 3) {
        isBundle = true;
        console.log(
          `    [SKIP] ${coinLabel} bundle (${wallet} = ${count}/${totalSignals} = ${((count / totalSignals) * 100).toFixed(0)}%)`
        );
        break;
      }
    }

    if (isBundle) {
      skipBundle++;
      for (const s of sigs) processedSignalIds.add(s.id);
      continue;
    }

    // ── REQUIRE: 1 Smart Money wallet + 1 additional wallet ──
    // Find which wallet tags map to TOP_ELITE addresses
    const smartMoneyTags: string[] = [];
    const otherTags: string[] = [];
    for (const tag of uniqueWallets) {
      const addr = tagToAddress.get(tag);
      if (addr && TOP_ELITE_ADDRESSES.has(addr)) {
        smartMoneyTags.push(tag);
      } else {
        otherTags.push(tag);
      }
    }

    if (smartMoneyTags.length === 0) {
      skipSingleWallet++;
      if (skipSingleWallet <= 3) {
        console.log(
          `    [SKIP] ${coinLabel} — no Smart Money confirmed (0 T1 wallets, ${uniqueWallets.size} total)`
        );
      }
      for (const s of sigs) processedSignalIds.add(s.id);
      continue;
    }

    if (uniqueWallets.size < MIN_UNIQUE_WALLETS) {
      skipSingleWallet++;
      if (skipSingleWallet <= 3) {
        console.log(
          `    [SKIP] ${coinLabel} — Smart Money only, no confirmation (${smartMoneyTags[0]} alone)`
        );
      }
      for (const s of sigs) processedSignalIds.add(s.id);
      continue;
    }

    // We have 1+ Smart Money + 1+ other wallet = ENTER
    const confirmTag = otherTags.length > 0 ? otherTags[0] : smartMoneyTags[1] || smartMoneyTags[0];
    const bestSig = sigs[0];
    for (const s of sigs) processedSignalIds.add(s.id);

    console.log(
      `    [ENTRY SMART] ${coinLabel} — ${smartMoneyTags[0]}(T1) + ${confirmTag} confirmed`
    );

    qualified.push({
      id: bestSig.id,
      coin_address: coinAddress,
      coin_name: bestSig.coin_name,
      wallet_tag: `${smartMoneyTags[0]}+${confirmTag}${uniqueWallets.size > 2 ? `+${uniqueWallets.size - 2}more` : ""}`,
      entry_mc: bestSig.entry_mc,
      signal_time: bestSig.signal_time,
      price_gap_minutes: bestSig.price_gap_minutes,
      priority: smartMoneyTags.length >= 2 ? "HIGH" : "normal",
    });
  }

  console.log(
    `  [SCAN] Results: ${qualified.length} qualified | Skipped: ${skipGapTooOld} gap>${MAX_GAP_MINUTES}m, ${skipSingleWallet} single-wallet, ${skipMcTooHigh} MC>$${MAX_ENTRY_MC.toLocaleString()}, ${skipBundle} bundles, ${skipAlreadyOpen} open, ${skipAlreadyProcessed} processed`
  );

  return qualified;
}

// ─── Bankroll ────────────────────────────────────────────

// POSITION_SIZE_PCT imported from config/smart-money.ts

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

// ─── Open Paper Position ─────────────────────────────────

async function openPosition(signal: QualifiedSignal): Promise<void> {
  const coinLabel = signal.coin_name || signal.coin_address.slice(0, 8) + "...";

  console.log(
    `  [DEBUG] Evaluating ${coinLabel}: gap=${signal.price_gap_minutes}min, MC=${signal.entry_mc ?? "unknown"}, mint=${signal.coin_address.slice(0, 12)}...`
  );

  const { price, source } = await getPrice(signal.coin_address);

  console.log(
    `  [DEBUG] Price for ${coinLabel}: $${price} (source: ${source})`
  );

  // Calculate position size: 1% of current bankroll
  const bankroll = await getBankroll();
  const positionSize = Number(bankroll.current_balance) * POSITION_SIZE_PCT;

  const { error } = await supabase.from("paper_trades").insert({
    coin_address: signal.coin_address,
    coin_name: signal.coin_name,
    wallet_tag: signal.wallet_tag,
    entry_price: price,
    entry_mc: signal.entry_mc,
    status: "open",
    priority: signal.priority,
    entry_time: new Date().toISOString(),
    position_size_usd: positionSize,
  });

  if (error) {
    console.error("  [ERROR] Opening position:", error.message);
    return;
  }

  const prioTag = signal.priority === "HIGH" ? " [MULTI-WALLET]" : "";
  const srcTag = source !== "jupiter" ? ` [${source}]` : "";
  console.log(
    `  [ENTRY] ${coinLabel} @ $${price.toFixed(10)} | $${positionSize.toFixed(2)} position | gap: ${signal.price_gap_minutes}min | via: ${signal.wallet_tag}${prioTag}${srcTag}`
  );
}

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
