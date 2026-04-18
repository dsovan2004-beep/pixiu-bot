import "../lib/supabase-server";
import supabase from "../lib/supabase-server";
import { LIVE_BUY_SOL } from "../config/smart-money";

// Pull SOL price once for USD conversion
async function getSolPrice(): Promise<number> {
  try {
    const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112");
    const j: any = await res.json();
    const p = j?.pairs?.find((x: any) => x.quoteToken?.symbol === "USDC" || x.quoteToken?.symbol === "USDT");
    return p ? parseFloat(p.priceUsd) : 89;
  } catch { return 89; }
}

(async () => {
  const solUsd = await getSolPrice();
  console.log(`SOL price: $${solUsd.toFixed(2)}`);

  // Pull ALL closed LIVE trades
  const { data: all } = await supabase
    .from("trades")
    .select("coin_name, entry_time, exit_time, pnl_pct, pnl_usd, exit_reason, grid_level, wallet_tag")
    .eq("status", "closed")
    .like("wallet_tag", "%[LIVE]%")
    .order("exit_time", { ascending: false });

  const trades = all ?? [];
  const wins = trades.filter(t => Number(t.pnl_pct) > 0);
  const losses = trades.filter(t => Number(t.pnl_pct) <= 0);
  const wr = trades.length ? (wins.length / trades.length * 100) : 0;
  const avgWin = wins.length ? wins.reduce((s,t)=>s+Number(t.pnl_pct),0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s,t)=>s+Number(t.pnl_pct),0) / losses.length : 0;

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  1. ALL-TIME LIVE STATS");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Total closed:  ${trades.length}`);
  console.log(`  Wins:          ${wins.length}`);
  console.log(`  Losses:        ${losses.length}`);
  console.log(`  Win rate:      ${wr.toFixed(1)}%`);
  console.log(`  Avg win:       +${avgWin.toFixed(2)}%`);
  console.log(`  Avg loss:      ${avgLoss.toFixed(2)}%`);
  const exp = (wins.length/trades.length)*avgWin + (losses.length/trades.length)*avgLoss;
  console.log(`  Expectancy:    ${exp >= 0 ? "+" : ""}${exp.toFixed(2)}%/trade`);

  // Real SOL P&L per trade: LIVE_BUY_SOL × pnl_pct / 100
  const totalSolPnl = trades.reduce((s,t) => s + LIVE_BUY_SOL * Number(t.pnl_pct) / 100, 0);
  console.log(`  Real SOL P&L:  ${totalSolPnl >= 0 ? "+" : ""}${totalSolPnl.toFixed(4)} SOL (${totalSolPnl >= 0 ? "+" : ""}$${(totalSolPnl * solUsd).toFixed(2)})`);
  const totalMarkPnl = trades.reduce((s,t) => s + Number(t.pnl_usd || 0), 0);
  console.log(`  Mark P&L:     ${totalMarkPnl >= 0 ? "+" : ""}$${totalMarkPnl.toFixed(2)}`);

  // 2. Per-day breakdown
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  2. LIVE P&L BY DAY (UTC)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const byDay: Record<string, { count: number; wins: number; sumPct: number; solPnl: number }> = {};
  for (const t of trades) {
    const day = String(t.exit_time).slice(0, 10);
    if (!byDay[day]) byDay[day] = { count: 0, wins: 0, sumPct: 0, solPnl: 0 };
    byDay[day].count++;
    if (Number(t.pnl_pct) > 0) byDay[day].wins++;
    byDay[day].sumPct += Number(t.pnl_pct);
    byDay[day].solPnl += LIVE_BUY_SOL * Number(t.pnl_pct) / 100;
  }
  console.log(`  Day        Trades   Wins   WR%     Avg%     Real SOL   Real USD`);
  for (const d of Object.keys(byDay).sort().reverse()) {
    const b = byDay[d];
    const wr = b.count ? (b.wins / b.count * 100) : 0;
    const avgPct = b.count ? b.sumPct / b.count : 0;
    console.log(`  ${d}  ${String(b.count).padStart(6)}   ${String(b.wins).padStart(4)}   ${wr.toFixed(1).padStart(5)}   ${(avgPct >= 0 ? "+" : "") + avgPct.toFixed(2).padStart(6)}   ${(b.solPnl >= 0 ? "+" : "") + b.solPnl.toFixed(4)}   ${(b.solPnl >= 0 ? "+" : "") + "$" + (b.solPnl * solUsd).toFixed(2)}`);
  }

  // 3. Worst 10
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  3. WORST 10 LIVE TRADES");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const sorted = [...trades].sort((a,b) => Number(a.pnl_pct) - Number(b.pnl_pct));
  for (const t of sorted.slice(0, 10)) {
    const solLoss = LIVE_BUY_SOL * Number(t.pnl_pct) / 100;
    console.log(`  ${String(t.exit_time).slice(0,16)}  ${String(t.coin_name || "").slice(0,25).padEnd(25)}  ${Number(t.pnl_pct).toFixed(1).padStart(7)}%  L${t.grid_level}  ${(t.exit_reason || "").slice(0,18).padEnd(18)}  ${solLoss.toFixed(4)} SOL`);
  }

  // 4. Best 10
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  4. BEST 10 LIVE TRADES");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  for (const t of sorted.slice(-10).reverse()) {
    const solGain = LIVE_BUY_SOL * Number(t.pnl_pct) / 100;
    console.log(`  ${String(t.exit_time).slice(0,16)}  ${String(t.coin_name || "").slice(0,25).padEnd(25)}  +${Number(t.pnl_pct).toFixed(1).padStart(6)}%  L${t.grid_level}  ${(t.exit_reason || "").slice(0,18).padEnd(18)}  +${solGain.toFixed(4)} SOL`);
  }

  // 5. Exit breakdown
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  5. EXIT REASON BREAKDOWN");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const byReason: Record<string, { count: number; sum: number; wins: number }> = {};
  for (const t of trades) {
    const r = t.exit_reason || "none";
    if (!byReason[r]) byReason[r] = { count: 0, sum: 0, wins: 0 };
    byReason[r].count++;
    byReason[r].sum += Number(t.pnl_pct);
    if (Number(t.pnl_pct) > 0) byReason[r].wins++;
  }
  console.log(`  Reason              Count   WR%     Avg%`);
  const sortedReasons = Object.entries(byReason).sort((a,b) => b[1].count - a[1].count);
  for (const [r, v] of sortedReasons) {
    const avgPct = v.count ? v.sum / v.count : 0;
    const wr = v.count ? (v.wins / v.count * 100) : 0;
    console.log(`  ${r.padEnd(18)}  ${String(v.count).padStart(5)}   ${wr.toFixed(1).padStart(5)}   ${(avgPct >= 0 ? "+" : "") + avgPct.toFixed(2)}`);
  }

  // Grid level breakdown
  console.log("\n  Grid level at close (closed trades):");
  const byGrid: Record<number, { count: number; sum: number }> = {};
  for (const t of trades) {
    const g = t.grid_level ?? 0;
    if (!byGrid[g]) byGrid[g] = { count: 0, sum: 0 };
    byGrid[g].count++;
    byGrid[g].sum += Number(t.pnl_pct);
  }
  for (const g of Object.keys(byGrid).map(Number).sort()) {
    const v = byGrid[g];
    console.log(`  L${g}:   ${String(v.count).padStart(4)} trades   avg ${(v.sum/v.count >= 0 ? "+" : "") + (v.sum/v.count).toFixed(2)}%`);
  }

  // 6. Entry delay — entry_time → exit_time hold duration (proxy for "how long we held")
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  6. HOLD DURATION vs PnL");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Note: entry_time = trades row insert. True signal→confirm delay not tracked.");
  const buckets = { "<1min": [], "1-5min": [], "5-20min": [], "20min+": [] } as Record<string, number[]>;
  for (const t of trades) {
    const mins = (new Date(t.exit_time!).getTime() - new Date(t.entry_time!).getTime()) / 60_000;
    const pct = Number(t.pnl_pct);
    if (mins < 1) buckets["<1min"].push(pct);
    else if (mins < 5) buckets["1-5min"].push(pct);
    else if (mins < 20) buckets["5-20min"].push(pct);
    else buckets["20min+"].push(pct);
  }
  console.log(`  Hold duration    Count   Avg PnL%   WR%`);
  for (const [b, arr] of Object.entries(buckets)) {
    if (!arr.length) { console.log(`  ${b.padEnd(15)}  ${String(0).padStart(5)}   —`); continue; }
    const avg = arr.reduce((s,x)=>s+x,0) / arr.length;
    const wr = arr.filter(x => x > 0).length / arr.length * 100;
    console.log(`  ${b.padEnd(15)}  ${String(arr.length).padStart(5)}   ${(avg >= 0 ? "+" : "") + avg.toFixed(2).padStart(6)}   ${wr.toFixed(1)}%`);
  }
})();
