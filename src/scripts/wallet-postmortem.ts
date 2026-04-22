// Primary-wallet-only attribution postmortem.
//
// Splits wallet_tag on "+" to get the primary (first) signaler, strips
// the " [LIVE]" suffix, then aggregates real_pnl_sol by primary wallet.
// Only counts rows that passed through the LIVE entry path (tagged LIVE)
// and closed with a resolved real_pnl_sol.
//
// Prints a ranked table, then a keep/cut recommendation based on:
//   - trades >= 5     (sample size minimum)
//   - WR >= 35%       (just above the 26.7% baseline)
//   - total_sol >= 0  (net profitable / flat)
//
// Wallets with < 5 trades are flagged "insufficient data" — keep them
// in provisionally. Wallets failing any threshold are flagged CUT.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";

type Row = {
  wallet_tag: string | null;
  real_pnl_sol: number | null;
  entry_sol_cost: number | null;
  entry_time: string;
  exit_reason: string | null;
  coin_name: string | null;
};

type Stat = {
  wallet: string;
  trades: number;
  wins: number;
  losses: number;
  totalSol: number;
  avgSol: number;
  wrPct: number;
  biggestWin: number;
  biggestLoss: number;
};

function parsePrimary(tag: string): string {
  // Strip trailing " [LIVE]" or " [...]" suffix first
  const noSuffix = tag.replace(/\s*\[[^\]]*\]\s*$/, "");
  // Split on "+" and take first
  return noSuffix.split("+")[0].trim();
}

async function main() {
  const env = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  const map: Record<string, string> = {};
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const sb = createClient(
    map.NEXT_PUBLIC_SUPABASE_URL!,
    map.SUPABASE_SERVICE_ROLE_KEY || map.SUPABASE_ANON_KEY || map.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  // Pull all closed LIVE trades with real_pnl_sol populated.
  const { data: rows, error } = await sb
    .from("trades")
    .select("wallet_tag, real_pnl_sol, entry_sol_cost, entry_time, exit_reason, coin_name")
    .eq("status", "closed")
    .like("wallet_tag", "%[LIVE]%")
    .not("real_pnl_sol", "is", null)
    .order("entry_time", { ascending: true });

  if (error) {
    console.error("DB error:", error.message);
    process.exit(1);
  }
  if (!rows || rows.length === 0) {
    console.log("No closed LIVE trades with real_pnl_sol. Exiting.");
    return;
  }

  const typedRows = rows as Row[];
  console.log(`\n=== Wallet Postmortem (primary-wallet attribution) ===`);
  console.log(`Sample: ${typedRows.length} closed LIVE trades with real_pnl_sol`);
  console.log(`Range: ${typedRows[0].entry_time.slice(0, 16)} → ${typedRows[typedRows.length - 1].entry_time.slice(0, 16)}\n`);

  // Aggregate by primary wallet
  const byWallet = new Map<string, Stat>();
  let totalNet = 0;
  let grandTrades = 0;
  let grandWins = 0;
  for (const r of typedRows) {
    if (!r.wallet_tag || r.real_pnl_sol == null) continue;
    const primary = parsePrimary(r.wallet_tag);
    const pnl = Number(r.real_pnl_sol);
    totalNet += pnl;
    grandTrades++;
    const isWin = pnl > 0;
    if (isWin) grandWins++;

    let s = byWallet.get(primary);
    if (!s) {
      s = {
        wallet: primary,
        trades: 0,
        wins: 0,
        losses: 0,
        totalSol: 0,
        avgSol: 0,
        wrPct: 0,
        biggestWin: 0,
        biggestLoss: 0,
      };
      byWallet.set(primary, s);
    }
    s.trades++;
    if (isWin) {
      s.wins++;
      if (pnl > s.biggestWin) s.biggestWin = pnl;
    } else {
      s.losses++;
      if (pnl < s.biggestLoss) s.biggestLoss = pnl;
    }
    s.totalSol += pnl;
  }
  for (const s of byWallet.values()) {
    s.avgSol = s.totalSol / s.trades;
    s.wrPct = (s.wins / s.trades) * 100;
  }

  // Sort by total SOL descending
  const sorted = Array.from(byWallet.values()).sort((a, b) => b.totalSol - a.totalSol);

  // Print table
  console.log("primary_wallet              trades  wins  wr%    avg_sol      total_sol   biggest_win   biggest_loss");
  console.log("─".repeat(108));
  for (const s of sorted) {
    const nameCol = s.wallet.padEnd(26);
    const tradesCol = s.trades.toString().padStart(6);
    const winsCol = s.wins.toString().padStart(5);
    const wrCol = s.wrPct.toFixed(1).padStart(5);
    const avgCol = (s.avgSol >= 0 ? "+" : "") + s.avgSol.toFixed(6);
    const totalCol = (s.totalSol >= 0 ? "+" : "") + s.totalSol.toFixed(4);
    const bwCol = "+" + s.biggestWin.toFixed(4);
    const blCol = s.biggestLoss.toFixed(4);
    console.log(`${nameCol}  ${tradesCol}  ${winsCol}  ${wrCol}  ${avgCol.padStart(11)}  ${totalCol.padStart(9)}  ${bwCol.padStart(11)}  ${blCol.padStart(11)}`);
  }
  console.log("─".repeat(108));
  console.log(`TOTAL                       ${grandTrades.toString().padStart(6)}  ${grandWins.toString().padStart(5)}  ${((grandWins / grandTrades) * 100).toFixed(1).padStart(5)}  ${(totalNet / grandTrades >= 0 ? "+" : "") + (totalNet / grandTrades).toFixed(6)}  ${(totalNet >= 0 ? "+" : "") + totalNet.toFixed(4)}\n`);

  // Recommendations
  const MIN_TRADES = 5;
  const MIN_WR = 35;
  console.log("=== Recommendation ===");
  console.log(`Rules: trades >= ${MIN_TRADES}, WR >= ${MIN_WR}%, total_sol >= 0\n`);

  // Decision rule (Apr 22 revision):
  //   KEEP = net positive SOL contribution (regardless of WR)
  //   CUT  = net negative AND (WR < threshold OR already multi-trade sample)
  // Rationale: the old rule cut daniww (+0.087 SOL, 30% WR) and theo
  // pump sad (+0.087 SOL, 33% WR) for being below the 35% WR line even
  // though they were the only net-profitable wallets in the book. A
  // wallet that makes us money — even on a coin-flip WR — must not be
  // cut. What matters is expectancy (net SOL), not win rate alone.
  const keep: string[] = [];
  const cut: string[] = [];
  const insufficient: string[] = [];
  for (const s of sorted) {
    if (s.trades < MIN_TRADES) {
      insufficient.push(`${s.wallet} (${s.trades} trades, ${s.totalSol >= 0 ? "+" : ""}${s.totalSol.toFixed(4)} SOL)`);
      continue;
    }
    // Any net-positive wallet with ≥ MIN_TRADES = KEEP
    if (s.totalSol >= 0) {
      keep.push(`${s.wallet} (WR ${s.wrPct.toFixed(1)}%, ${s.totalSol >= 0 ? "+" : ""}${s.totalSol.toFixed(4)} SOL, ${s.trades} trades)`);
    } else {
      const reasons: string[] = [`net ${s.totalSol.toFixed(4)} SOL`];
      if (s.wrPct < MIN_WR) reasons.push(`WR ${s.wrPct.toFixed(1)}% < ${MIN_WR}%`);
      cut.push(`${s.wallet} (${reasons.join(", ")}, ${s.trades} trades)`);
    }
  }

  console.log(`✅ KEEP (${keep.length}):`);
  keep.forEach((k) => console.log(`   ${k}`));
  console.log(`\n❌ CUT (${cut.length}):`);
  cut.forEach((c) => console.log(`   ${c}`));
  console.log(`\n⚠️  INSUFFICIENT DATA (${insufficient.length}, keep provisionally):`);
  insufficient.forEach((i) => console.log(`   ${i}`));
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
