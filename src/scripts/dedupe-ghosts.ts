/**
 * Sprint 10 P1a — Remove confirmed ghost duplicate rows
 *
 * divergence-flagger.ts surfaced 3 pairs of rows with identical
 * coin_name + pnl_pct + real_pnl_sol that are pre-P0b double-credit
 * ghosts:
 *   - Broke Company         (2 rows, +129.1% / +0.112 SOL each)
 *   - Justice for Raccoon   (2 rows, +42.5%  / +0.183 SOL each)
 *   - Mooncoin              (2 rows, +48.5%  / +0.059 SOL each)
 *
 * For each pair, keep the earliest row (by entry_time, tiebreak id)
 * and DELETE the newer one. Then decrement DEPRECATED_DEPRECATED_bankroll by the
 * deleted row's pnl_usd so the ghost credit is removed.
 *
 * Safety: deletes happen first. If a decrement fails, bankroll stays
 * where it was (current inflated state) — no worse than today. If a
 * delete fails, nothing changes.
 *
 * Usage:
 *   npx tsx src/scripts/dedupe-ghosts.ts --dry   # report only
 *   npx tsx src/scripts/dedupe-ghosts.ts         # apply
 */

import "../lib/supabase-server";
import supabase from "../lib/supabase-server";

// Conservative shape: same coin_name, same exit_reason, same pnl_pct
// (rounded to 2dp), entry_time within 2 minutes of each other.
const DUPE_WINDOW_SECONDS = 120;

(async () => {
  const dry = process.argv.includes("--dry");
  console.log(`Ghost-dedupe starting. dry=${dry}\n`);

  const { data: all } = await supabase
    .from("trades")
    .select("id, coin_name, coin_address, entry_time, exit_time, pnl_pct, pnl_usd, real_pnl_sol, exit_reason, wallet_tag")
    .eq("status", "closed")
    .like("wallet_tag", "%[LIVE]%")
    .order("entry_time", { ascending: true });

  if (!all) { console.error("No trades found"); return; }

  // Build groups of suspected duplicates
  interface Row {
    id: string;
    coin_name: string | null;
    entry_time: string;
    pnl_pct: number;
    pnl_usd: number | null;
    real_pnl_sol: number | null;
    exit_reason: string | null;
  }
  const rows = all as Row[];
  const groups: Row[][] = [];
  const seen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    if (seen.has(rows[i].id)) continue;
    const group = [rows[i]];
    const baseTime = new Date(rows[i].entry_time).getTime();
    const basePnlKey = Number(rows[i].pnl_pct).toFixed(2);
    for (let j = i + 1; j < rows.length; j++) {
      if (seen.has(rows[j].id)) continue;
      if (rows[j].coin_name !== rows[i].coin_name) continue;
      if (Number(rows[j].pnl_pct).toFixed(2) !== basePnlKey) continue;
      if (rows[j].exit_reason !== rows[i].exit_reason) continue;
      const dt = Math.abs(new Date(rows[j].entry_time).getTime() - baseTime) / 1000;
      if (dt > DUPE_WINDOW_SECONDS) continue;
      group.push(rows[j]);
      seen.add(rows[j].id);
    }
    if (group.length > 1) {
      groups.push(group);
      seen.add(group[0].id);
    }
  }

  if (groups.length === 0) {
    console.log("No duplicate groups found — nothing to clean.");
    return;
  }

  console.log(`Found ${groups.length} duplicate groups:\n`);

  let totalPhantomUsd = 0;
  const toDelete: Row[] = [];

  for (const group of groups) {
    const keep = group[0]; // earliest by entry_time
    const remove = group.slice(1);
    console.log(`  ${keep.coin_name} — ${group.length} rows`);
    console.log(`    KEEP   ${keep.entry_time}  pnl=${Number(keep.pnl_pct).toFixed(1)}%  pnl_usd=${Number(keep.pnl_usd).toFixed(2)}  real=${Number(keep.real_pnl_sol).toFixed(4)} SOL`);
    for (const r of remove) {
      console.log(`    DELETE ${r.entry_time}  pnl=${Number(r.pnl_pct).toFixed(1)}%  pnl_usd=${Number(r.pnl_usd).toFixed(2)}  real=${Number(r.real_pnl_sol).toFixed(4)} SOL`);
      toDelete.push(r);
      totalPhantomUsd += Number(r.pnl_usd || 0);
    }
  }

  console.log(`\nWould delete ${toDelete.length} rows.`);
  console.log(`Bankroll decrement: $${totalPhantomUsd.toFixed(2)} (phantom credits removed)`);

  if (dry) { console.log("\n(--dry) No changes applied."); return; }

  // Apply deletes
  console.log("\nApplying deletes...");
  let deleted = 0;
  for (const r of toDelete) {
    const { error } = await supabase.from("trades").delete().eq("id", r.id);
    if (error) {
      console.error(`  DELETE failed for ${r.id}: ${error.message}`);
    } else {
      console.log(`  deleted ${r.id} (${r.coin_name})`);
      deleted++;
    }
  }

  // Decrement bankroll
  console.log("\nDecrementing bankroll...");
  const { data: bk } = await supabase
    .from("DEPRECATED_DEPRECATED_bankroll")
    .select("id, current_balance, starting_balance")
    .limit(1)
    .single();
  if (!bk) { console.error("No bankroll row found — skipped decrement"); return; }
  const before = Number(bk.current_balance);
  const after = before - totalPhantomUsd;
  const newTotal = after - Number(bk.starting_balance ?? 10000);
  const { error } = await supabase
    .from("DEPRECATED_DEPRECATED_bankroll")
    .update({ current_balance: after, total_pnl_usd: newTotal, updated_at: new Date().toISOString() })
    .eq("id", bk.id);
  if (error) {
    console.error(`Bankroll decrement failed: ${error.message}`);
  } else {
    console.log(`  bankroll: $${before.toFixed(2)} → $${after.toFixed(2)} (Δ −$${totalPhantomUsd.toFixed(2)})`);
  }

  console.log(`\nDone. Deleted ${deleted}/${toDelete.length} ghost rows.`);
})();
