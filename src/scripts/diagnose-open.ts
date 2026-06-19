import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";

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

  // Total count of status='open' (head request for exact count)
  const { count: openCount } = await sb
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("status", "open");
  console.log(`\nTotal status='open' rows: ${openCount}`);

  // Confirmed open (has entry_sol_cost — real live positions)
  const { count: confirmedCount } = await sb
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("status", "open")
    .not("entry_sol_cost", "is", null);
  console.log(`  ├─ confirmed (entry_sol_cost set, REAL positions): ${confirmedCount}`);

  // Phantom open (no entry_sol_cost — buy never confirmed)
  const { count: phantomCount } = await sb
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("status", "open")
    .is("entry_sol_cost", null);
  console.log(`  └─ phantom (entry_sol_cost NULL, never bought): ${phantomCount}`);

  // [LIVE] tagged open
  const { count: liveCount } = await sb
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("status", "open")
    .like("wallet_tag", "%[LIVE]%");
  console.log(`\n  [LIVE]-tagged open rows: ${liveCount}`);

  // Sample a few confirmed-open rows to see if any are genuinely live
  const { data: confirmed } = await sb
    .from("trades")
    .select("id, coin_name, wallet_tag, entry_sol_cost, entry_time, grid_level, buy_tx_sig")
    .eq("status", "open")
    .not("entry_sol_cost", "is", null)
    .order("entry_time", { ascending: false })
    .limit(15);
  console.log(`\n=== Confirmed-open sample (newest 15) ===`);
  for (const r of confirmed || []) {
    console.log(`  ${(r.coin_name || "?").slice(0, 24).padEnd(24)} ${r.entry_time?.slice(0, 16)} cost=${r.entry_sol_cost} grid=${r.grid_level} buy=${r.buy_tx_sig ? "yes" : "NULL"}`);
  }

  // Oldest phantom + newest phantom to see the time range
  const { data: phantomOldest } = await sb
    .from("trades")
    .select("entry_time")
    .eq("status", "open")
    .is("entry_sol_cost", null)
    .order("entry_time", { ascending: true })
    .limit(1)
    .maybeSingle();
  const { data: phantomNewest } = await sb
    .from("trades")
    .select("entry_time")
    .eq("status", "open")
    .is("entry_sol_cost", null)
    .order("entry_time", { ascending: false })
    .limit(1)
    .maybeSingle();
  console.log(`\nPhantom time range: ${phantomOldest?.entry_time?.slice(0, 16)} → ${phantomNewest?.entry_time?.slice(0, 16)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
