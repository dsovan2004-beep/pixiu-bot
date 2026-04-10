/**
 * PixiuBot — Paper Trading Engine (Sprint 2)
 * Usage: npx tsx src/scripts/paper-trader.ts
 *
 * Runs alongside feed.ts (separate process).
 * Polls coin_signals for fresh signals, opens paper positions,
 * monitors open positions, and auto-exits on TP/SL/timeout.
 * NO real SOL is spent. Paper only.
 */

import supabase from "../lib/supabase-server";

// ─── Config ──────────────────────────────────────────────

const SIGNAL_POLL_MS = 30_000; // Check for new signals every 30s
const POSITION_CHECK_MS = 60_000; // Check open positions every 60s

// Entry filters
const MAX_GAP_MINUTES = 15;
const MAX_ENTRY_MC = 20_000;
const MULTI_WALLET_WINDOW_MIN = 10; // 2+ wallets buying same coin within 10 min

// Exit rules
const TAKE_PROFIT_PCT = 0.20; // +20%
const STOP_LOSS_PCT = 0.10; // -10%
const TIMEOUT_MINUTES = 30;

// Kill switch
const KILL_SWITCH_MIN_TRADES = 50;
const KILL_SWITCH_MIN_WR = 0.55; // 55%

// Track which signals we've already processed
const processedSignalIds = new Set<string>();
let killSwitchActive = false;

// ─── Jupiter Price API ───────────────────────────────────

async function getPrice(mint: string): Promise<number | null> {
  try {
    const url = `https://price.jup.ag/v6/price?ids=${mint}`;
    const response = await fetch(url);

    if (!response.ok) return null;

    const data = await response.json();
    const price = data.data?.[mint]?.price;
    return typeof price === "number" && price > 0 ? price : null;
  } catch {
    return null;
  }
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
  // Look back 60 minutes for signals (wider window to catch more)
  const cutoff = new Date(now.getTime() - 60 * 60_000).toISOString();

  console.log(`  [SCAN] Looking for signals since ${cutoff} (now: ${now.toISOString()})`);

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
    .gte("exit_time", new Date(now.getTime() - 60 * 60_000).toISOString());

  const recentlyTradedCoins = new Set(recentClosed?.map((p) => p.coin_address) || []);

  for (const [coinAddress, sigs] of coinGroups) {
    if (openCoins.has(coinAddress)) {
      skipAlreadyOpen++;
      continue;
    }

    if (recentlyTradedCoins.has(coinAddress)) {
      console.log(`    [SKIP] ${sigs[0].coin_name || coinAddress.slice(0, 8)}... recently traded`);
      continue;
    }

    const uniqueWallets = new Set(sigs.map((s) => s.wallet_tag));
    const isMultiWallet = uniqueWallets.size >= 2;

    const bestSig = sigs[0];
    for (const s of sigs) processedSignalIds.add(s.id);

    qualified.push({
      id: bestSig.id,
      coin_address: coinAddress,
      coin_name: bestSig.coin_name,
      wallet_tag: isMultiWallet
        ? `${Array.from(uniqueWallets).slice(0, 3).join("+")}${uniqueWallets.size > 3 ? `+${uniqueWallets.size - 3}more` : ""}`
        : bestSig.wallet_tag,
      entry_mc: bestSig.entry_mc,
      signal_time: bestSig.signal_time,
      price_gap_minutes: bestSig.price_gap_minutes,
      priority: isMultiWallet ? "HIGH" : "normal",
    });
  }

  console.log(
    `  [SCAN] Results: ${passedFilters} passed filters, ${qualified.length} qualified | Skipped: ${skipAlreadyProcessed} processed, ${skipGapTooOld} gap>${MAX_GAP_MINUTES}m, ${skipMcTooHigh} MC>$${MAX_ENTRY_MC}, ${skipAlreadyOpen} already open`
  );

  return qualified;
}

// ─── Open Paper Position ─────────────────────────────────

async function openPosition(signal: QualifiedSignal): Promise<void> {
  const price = await getPrice(signal.coin_address);

  if (!price) {
    console.log(
      `  [SKIP] ${signal.coin_name || signal.coin_address.slice(0, 8)}... — no price available`
    );
    return;
  }

  const { error } = await supabase.from("paper_trades").insert({
    coin_address: signal.coin_address,
    coin_name: signal.coin_name,
    wallet_tag: signal.wallet_tag,
    entry_price: price,
    entry_mc: signal.entry_mc,
    status: "open",
    priority: signal.priority,
    entry_time: new Date().toISOString(),
  });

  if (error) {
    console.error("  [ERROR] Opening position:", error.message);
    return;
  }

  const prioTag = signal.priority === "HIGH" ? " [MULTI-WALLET]" : "";
  console.log(
    `  [PAPER BUY] ${signal.coin_name || signal.coin_address.slice(0, 8)}... @ $${price.toFixed(10)} (gap: ${signal.price_gap_minutes}min, via: ${signal.wallet_tag})${prioTag}`
  );
}

// ─── Check Open Positions ────────────────────────────────

async function checkPositions(): Promise<void> {
  const { data: positions, error } = await supabase
    .from("paper_trades")
    .select("*")
    .eq("status", "open");

  if (error || !positions || positions.length === 0) return;

  console.log(`  [CHECK] ${positions.length} open position(s)...`);

  for (const pos of positions) {
    const currentPrice = await getPrice(pos.coin_address);

    if (!currentPrice) continue;

    const entryPrice = Number(pos.entry_price);
    const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    const entryTime = new Date(pos.entry_time).getTime();
    const minutesOpen = (Date.now() - entryTime) / 60_000;

    let exitReason: string | null = null;

    if (pnlPct >= TAKE_PROFIT_PCT * 100) {
      exitReason = "take_profit";
    } else if (pnlPct <= -(STOP_LOSS_PCT * 100)) {
      exitReason = "stop_loss";
    } else if (minutesOpen >= TIMEOUT_MINUTES) {
      exitReason = "timeout";
    }

    if (exitReason) {
      await supabase
        .from("paper_trades")
        .update({
          exit_price: currentPrice,
          pnl_pct: pnlPct,
          status: "closed",
          exit_time: new Date().toISOString(),
          exit_reason: exitReason,
        })
        .eq("id", pos.id);

      const emoji =
        exitReason === "take_profit" ? "✅" : exitReason === "stop_loss" ? "❌" : "⏰";
      console.log(
        `  [PAPER EXIT] ${emoji} ${pos.coin_name || pos.coin_address.slice(0, 8)}... ${exitReason} @ $${currentPrice.toFixed(10)} (PnL: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`
      );
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
  console.log("  PIXIU BOT — Paper Trading Engine (Sprint 2)");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Mode:         PAPER ONLY — zero real SOL spent`);
  console.log(`  Entry filter: gap < ${MAX_GAP_MINUTES}min, MC < $${MAX_ENTRY_MC.toLocaleString()}, rug pass`);
  console.log(`  Exit rules:   TP +${TAKE_PROFIT_PCT * 100}% | SL -${STOP_LOSS_PCT * 100}% | Timeout ${TIMEOUT_MINUTES}min`);
  console.log(`  Multi-wallet: 2+ wallets within ${MULTI_WALLET_WINDOW_MIN}min = HIGH priority`);
  console.log(`  Kill switch:  WR < ${KILL_SWITCH_MIN_WR * 100}% after ${KILL_SWITCH_MIN_TRADES} trades`);
  console.log(`  Signal poll:  Every ${SIGNAL_POLL_MS / 1000}s`);
  console.log(`  Position chk: Every ${POSITION_CHECK_MS / 1000}s`);
  console.log(`  Started:      ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Signal poll loop
  async function signalTick(): Promise<void> {
    if (killSwitchActive) {
      console.log("  [SCAN] Kill switch active — skipping signal scan");
      return;
    }

    const signals = await findNewSignals();
    if (signals.length === 0) {
      console.log("  [SCAN] No new qualified signals this tick");
    }
    for (const sig of signals) {
      await openPosition(sig);
    }
  }

  // Position check loop
  async function positionTick(): Promise<void> {
    await checkPositions();
    await checkKillSwitch();
    await printStats();
  }

  // Run immediately
  await signalTick();
  await positionTick();

  // Set up intervals
  setInterval(signalTick, SIGNAL_POLL_MS);
  setInterval(positionTick, POSITION_CHECK_MS);

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
