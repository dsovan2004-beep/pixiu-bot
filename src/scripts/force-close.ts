// Manual emergency close — sells the remaining balance of an open
// position via Jupiter (skipJito, rescue-mode slippage) and books the
// real PnL to the trades row.
//
// Usage: npx tsx src/scripts/force-close.ts [trade_id]
//   - If trade_id omitted, closes the single open position (errors if 0
//     or >1 open).
//
// Uses exitReason='manual_close' which is in RESCUE_EXIT_REASONS so the
// sell runs the 20%/30% slip ladder with 30s confirm timeout — same as
// CB/SL/TO exits.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";
import { sellToken, parseSwapSolDelta } from "../lib/jupiter-swap";

async function main() {
  const env = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  const map: Record<string, string> = {};
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  // Set env vars so jupiter-swap picks them up
  for (const [k, v] of Object.entries(map)) {
    if (!process.env[k]) process.env[k] = v;
  }

  const sb = createClient(
    map.NEXT_PUBLIC_SUPABASE_URL!,
    map.SUPABASE_SERVICE_ROLE_KEY || map.SUPABASE_ANON_KEY || map.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const argId = process.argv[2];
  let row: any;
  if (argId) {
    const { data, error } = await sb.from("trades").select("*").eq("id", argId).single();
    if (error) { console.error(error.message); process.exit(1); }
    row = data;
  } else {
    const { data, error } = await sb
      .from("trades")
      .select("*")
      .in("status", ["open", "closing"]);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data || data.length === 0) { console.error("No open positions."); process.exit(1); }
    if (data.length > 1) {
      console.error(`${data.length} open positions — pass trade_id:`);
      for (const r of data) console.error(`  ${r.id} ${r.coin_name}`);
      process.exit(1);
    }
    row = data[0];
  }

  console.log(`\n=== Force-closing ${row.coin_name} (${row.id}) ===`);
  console.log(`status: ${row.status}`);
  console.log(`grid_level: L${row.grid_level}, remaining_pct: ${row.remaining_pct}%`);
  console.log(`entry_sol_cost: ${row.entry_sol_cost}`);
  console.log(`real_pnl_sol (banked): ${row.real_pnl_sol}`);

  // Flip to 'closing' (atomic — refuses if status already changed)
  const { data: claim } = await sb
    .from("trades")
    .update({ status: "closing", closing_started_at: new Date().toISOString() })
    .eq("id", row.id)
    .in("status", ["open"])
    .select("id")
    .maybeSingle();

  if (!claim) {
    console.log("Row already in 'closing' or 'closed' state. Proceeding anyway to sell.");
  } else {
    console.log("✅ Claimed for close (status → closing)");
  }

  // Sell everything remaining
  console.log(`\nCalling sellToken() with skipJito + manual_close rescue mode...`);
  // Use 'trailing_stop' (in RESCUE_EXIT_REASONS) to route through rescue
  // mode: 20%→30% slip, 30s confirm timeout. Semantically fits "lock
  // gains before peak is fully gone". DB exit_reason will be 'manual_close'.
  const sig = await sellToken(row.coin_address, {
    entrySolCost: row.entry_sol_cost ? Number(row.entry_sol_cost) : undefined,
    exitReason: "trailing_stop",
    skipJito: true,
    remainingPct: row.remaining_pct,
  });

  if (!sig) {
    console.error(`❌ Sell failed. Reverting status to 'open' for risk-guard retry.`);
    await sb.from("trades").update({ status: "open", closing_started_at: null }).eq("id", row.id).eq("status", "closing");
    process.exit(1);
  }

  console.log(`\n✅ SELL confirmed: ${sig}`);

  // Parse real SOL received
  const solReceived = await parseSwapSolDelta(sig);
  console.log(`SOL received: ${solReceived}`);

  const entryCost = row.entry_sol_cost ? Number(row.entry_sol_cost) : null;
  const existingPnl = row.real_pnl_sol != null ? Number(row.real_pnl_sol) : 0;
  const remainingPct = Number(row.remaining_pct);
  const finalSellCostBasis = entryCost !== null ? (entryCost * remainingPct) / 100 : null;
  const finalSellPnl = (finalSellCostBasis !== null && solReceived !== null) ? solReceived - finalSellCostBasis : null;
  const realPnlSol = finalSellPnl !== null ? existingPnl + finalSellPnl : null;

  // Finalize close
  const { error: updErr } = await sb
    .from("trades")
    .update({
      status: "closed",
      exit_time: new Date().toISOString(),
      exit_reason: "manual_close",
      remaining_pct: 0,
      sell_tx_sig: sig,
      ...(realPnlSol !== null ? { real_pnl_sol: realPnlSol } : {}),
    })
    .eq("id", row.id);

  if (updErr) {
    console.error(`⚠️ DB update failed: ${updErr.message}`);
    console.error(`Sell DID land on-chain: ${sig}`);
    process.exit(1);
  }

  console.log(`\n=== DONE ===`);
  if (realPnlSol !== null) {
    console.log(`Final real_pnl_sol: ${realPnlSol >= 0 ? "+" : ""}${realPnlSol.toFixed(6)} SOL`);
    console.log(`  = prior partials (${existingPnl.toFixed(6)}) + final sell (${finalSellPnl!.toFixed(6)})`);
    console.log(`  = received ${solReceived!.toFixed(6)} - cost basis ${finalSellCostBasis!.toFixed(6)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
