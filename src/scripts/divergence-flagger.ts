/**
 * Sprint 9 P0 — Divergence flagger
 *
 * Scans all closed LIVE trades that have both pnl_pct (paper) and
 * real_pnl_sol populated. Flags rows where |paper_pct − real_pct| > 20pp
 * as accounting anomalies and groups by exit_reason.
 *
 * This is the observability companion to the Sprint 9 P0 fix. The
 * SQL-editor query you ran on Apr 18 got the answer once manually;
 * this script repeats it on demand so new trades can be spot-checked.
 *
 * Usage:
 *   npx tsx src/scripts/divergence-flagger.ts                 # summary + top anomalies
 *   npx tsx src/scripts/divergence-flagger.ts --threshold 50  # only flag >50pp
 *   npx tsx src/scripts/divergence-flagger.ts --all           # print every row
 *
 * Read-only. Never writes to DB.
 */

import "../lib/supabase-server";
import supabase from "../lib/supabase-server";

interface Row {
  coin_name: string | null;
  pnl_pct: number;
  real_pnl_sol: number;
  entry_sol_cost: number;
  exit_reason: string | null;
  exit_time: string;
  buy_tx_sig: string | null;
  sell_tx_sig: string | null;
}

(async () => {
  const args = process.argv.slice(2);
  const threshold = Number(args[args.indexOf("--threshold") + 1]) || 20;
  const printAll = args.includes("--all");

  console.log(`Divergence threshold: ${threshold}pp  |  mode: ${printAll ? "all rows" : "flagged only"}\n`);

  const { data, error } = await supabase
    .from("paper_trades")
    .select("coin_name, pnl_pct, real_pnl_sol, entry_sol_cost, exit_reason, exit_time, buy_tx_sig, sell_tx_sig")
    .eq("status", "closed")
    .like("wallet_tag", "%[LIVE]%")
    .not("real_pnl_sol", "is", null)
    .not("entry_sol_cost", "is", null);
  if (error) { console.error("Query error:", error.message); process.exit(1); }

  const rows = (data ?? []).filter((r: any) => Number(r.entry_sol_cost) > 0) as Row[];
  if (rows.length === 0) { console.log("No rows to analyse."); return; }

  // Per-row divergence
  interface Enriched extends Row { realPct: number; divergence: number; }
  const enriched: Enriched[] = rows.map(r => {
    const realPct = (Number(r.real_pnl_sol) / Number(r.entry_sol_cost)) * 100;
    const divergence = Number(r.pnl_pct) - realPct;
    return { ...r, realPct, divergence };
  });

  const flagged = enriched.filter(r => Math.abs(r.divergence) > threshold);

  // ─── Summary ────────────────────────────────────────────
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Overall");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Trades analysed:         ${rows.length}`);
  console.log(`  Flagged (>${threshold}pp divergence): ${flagged.length} (${(100 * flagged.length / rows.length).toFixed(1)}%)`);

  const paperOver = flagged.filter(r => r.divergence > 0);
  const paperUnder = flagged.filter(r => r.divergence < 0);
  console.log(`    Paper OVER-claimed (paper > real): ${paperOver.length}`);
  console.log(`    Paper UNDER-claimed (real > paper): ${paperUnder.length}`);

  const sumPaperSol = rows.reduce((s, r) => s + 0.05 * Number(r.pnl_pct) / 100, 0);
  const sumReal = rows.reduce((s, r) => s + Number(r.real_pnl_sol), 0);
  console.log(`  Sum paper (pnl_pct × 0.05):  ${sumPaperSol >= 0 ? "+" : ""}${sumPaperSol.toFixed(4)} SOL`);
  console.log(`  Sum real:                    ${sumReal >= 0 ? "+" : ""}${sumReal.toFixed(4)} SOL`);
  console.log(`  Net paper inflation:         ${(sumPaperSol - sumReal).toFixed(4)} SOL`);

  // ─── By exit_reason ─────────────────────────────────────
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  By exit_reason");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const byReason: Record<string, { count: number; flagged: number; paperSum: number; realSum: number; wins: number; total: number }> = {};
  for (const r of enriched) {
    const reason = r.exit_reason || "none";
    if (!byReason[reason]) byReason[reason] = { count: 0, flagged: 0, paperSum: 0, realSum: 0, wins: 0, total: 0 };
    byReason[reason].count++;
    if (Math.abs(r.divergence) > threshold) byReason[reason].flagged++;
    byReason[reason].paperSum += Number(r.pnl_pct);
    byReason[reason].realSum += r.realPct;
    byReason[reason].total += Number(r.real_pnl_sol);
    if (Number(r.real_pnl_sol) > 0) byReason[reason].wins++;
  }
  console.log(`  ${"reason".padEnd(18)} ${"n".padStart(4)} ${"flag%".padStart(6)} ${"paper avg%".padStart(11)} ${"real avg%".padStart(10)} ${"realWR%".padStart(8)} ${"totalSOL".padStart(10)}`);
  const sorted = Object.entries(byReason).sort((a, b) => b[1].total - a[1].total);
  for (const [reason, v] of sorted) {
    const flagPct = v.count ? (100 * v.flagged / v.count).toFixed(1) : "0";
    const realWr = v.count ? (100 * v.wins / v.count).toFixed(1) : "0";
    console.log(`  ${reason.padEnd(18)} ${String(v.count).padStart(4)} ${flagPct.padStart(6)} ${(v.paperSum / v.count).toFixed(1).padStart(10)}% ${(v.realSum / v.count).toFixed(1).padStart(9)}% ${realWr.padStart(7)}% ${(v.total >= 0 ? "+" : "") + v.total.toFixed(3).padStart(9)}`);
  }

  // ─── Top anomalies ──────────────────────────────────────
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Top 10 phantom wins (paper OVER real)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const sortedOver = [...paperOver].sort((a, b) => b.divergence - a.divergence);
  for (const r of sortedOver.slice(0, 10)) {
    const coin = (r.coin_name || "").slice(0, 26).padEnd(26);
    console.log(`  ${String(r.exit_time).slice(0, 16)}  ${coin}  paper ${r.pnl_pct.toFixed(1).padStart(7)}%  real ${r.realPct.toFixed(1).padStart(7)}%  div +${r.divergence.toFixed(1).padStart(6)}pp  [${r.exit_reason}]`);
  }
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Top 10 paper under-claims (real OVER paper — we made more than tracked)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const sortedUnder = [...paperUnder].sort((a, b) => a.divergence - b.divergence);
  for (const r of sortedUnder.slice(0, 10)) {
    const coin = (r.coin_name || "").slice(0, 26).padEnd(26);
    console.log(`  ${String(r.exit_time).slice(0, 16)}  ${coin}  paper ${r.pnl_pct.toFixed(1).padStart(7)}%  real ${r.realPct.toFixed(1).padStart(7)}%  div ${r.divergence.toFixed(1).padStart(7)}pp  [${r.exit_reason}]`);
  }

  if (printAll) {
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  All rows (--all)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    const all = [...enriched].sort((a, b) => Math.abs(b.divergence) - Math.abs(a.divergence));
    for (const r of all) {
      const coin = (r.coin_name || "").slice(0, 22).padEnd(22);
      const flag = Math.abs(r.divergence) > threshold ? " ⚠️" : "  ";
      console.log(`  ${flag} ${String(r.exit_time).slice(0, 16)}  ${coin}  paper ${Number(r.pnl_pct).toFixed(1).padStart(7)}%  real ${r.realPct.toFixed(1).padStart(7)}%  div ${r.divergence.toFixed(1).padStart(8)}pp`);
    }
  }

  // ─── Dupe detection (Broke Company class) ─────────────
  const dupeKey = new Map<string, Enriched[]>();
  for (const r of enriched) {
    const k = `${r.coin_name}|${r.pnl_pct.toFixed(2)}|${Number(r.real_pnl_sol).toFixed(4)}`;
    if (!dupeKey.has(k)) dupeKey.set(k, []);
    dupeKey.get(k)!.push(r);
  }
  const dupes = [...dupeKey.values()].filter(g => g.length > 1);
  if (dupes.length > 0) {
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  Suspected duplicate rows (same coin_name + pnl_pct + real_pnl_sol)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    for (const group of dupes.slice(0, 10)) {
      console.log(`  ${(group[0].coin_name || "").slice(0, 26)} — ${group.length} rows with identical outcome:`);
      for (const r of group) console.log(`    ${String(r.exit_time).slice(0, 16)}  paper ${Number(r.pnl_pct).toFixed(1)}%  real SOL ${Number(r.real_pnl_sol).toFixed(4)}  [${r.exit_reason}]`);
    }
  }
})();
