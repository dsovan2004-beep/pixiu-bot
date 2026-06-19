// One-shot cleanup of phantom 'open' rows that never confirmed a buy.
//
// A phantom = status='open' AND entry_sol_cost IS NULL AND wallet_tag NOT
// LIKE '%[LIVE]%'. These are webhook-inserted pre-confirm rows the executor
// never resolved (bot was stopped, or signals arrived faster than the
// executor's live-only processing). 2107 accumulated May 6 -> Jun 19 2026
// and were making the risk-guard's unbounded status='open' query pull 1000
// rows every 2s.
//
// Safety: only touches rows with entry_sol_cost IS NULL (never bought) and
// NOT [LIVE]-tagged. Backs up ids+key fields to JSON before flipping status
// to 'failed' with exit_reason='phantom_cleanup'. Same pattern as c8fcd6a.
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
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

  // Page through ALL phantom rows (Supabase caps at 1000/req).
  const all: any[] = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb
      .from("trades")
      .select("id, coin_name, wallet_tag, entry_time, status")
      .eq("status", "open")
      .is("entry_sol_cost", null)
      .not("wallet_tag", "like", "%[LIVE]%")
      .order("entry_time", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error("query error:", error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log(`Found ${all.length} phantom open rows to clean.`);
  if (all.length === 0) { console.log("Nothing to do."); return; }

  // Backup
  const stamp = process.argv[2] || "manual";
  const backupPath = join(process.cwd(), `phantom-cleanup-backup-${stamp}.json`);
  writeFileSync(backupPath, JSON.stringify(all, null, 2));
  console.log(`Backed up ${all.length} rows to ${backupPath}`);

  // Flip to failed in batches of 500 ids
  const ids = all.map((r) => r.id);
  let updated = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const { error } = await sb
      .from("trades")
      .update({ status: "failed", exit_reason: "phantom_cleanup" })
      .in("id", batch)
      .eq("status", "open")            // guard: only flip rows still open
      .is("entry_sol_cost", null);     // guard: never touch a confirmed buy
    if (error) { console.error(`batch ${i} error:`, error.message); process.exit(1); }
    updated += batch.length;
    console.log(`  flipped ${updated}/${ids.length}`);
  }

  // Verify remaining open count
  const { count: remaining } = await sb
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("status", "open");
  console.log(`\nDone. status='open' rows remaining: ${remaining}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
