import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

// Retroactive cleanup for daily-limit phantoms created BEFORE commit
// 0a98636 shipped. Those rows are:
//   status='open' AND wallet_tag NOT LIKE '%[LIVE]%' AND entry_sol_cost IS NULL
// They accumulated because the executor's daily-limit check used to
// `continue` without flipping status=failed, and the webhook kept
// inserting while bot_state.is_running=true.
//
// Without this cleanup, midnight UTC reset would wake the executor
// up to dozens of stale signals and buy into likely-dead tokens
// (age filter doesn't catch them — first-signal-time only grows).
//
// Pure status flip: open → failed. No on-chain activity. Reversible
// via the JSON backup this script writes.

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

  // 1. Find the phantom rows
  const { data: phantoms, error } = await sb
    .from("trades")
    .select("id, coin_name, coin_address, wallet_tag, entry_time, status, exit_reason")
    .eq("status", "open")
    .not("wallet_tag", "like", "%[LIVE]%")
    .is("entry_sol_cost", null);

  if (error) { console.error("query error:", error); process.exit(1); }
  if (!phantoms || phantoms.length === 0) {
    console.log("no phantoms to clean. exit.");
    return;
  }

  console.log(`\n=== ${phantoms.length} daily-limit phantoms to clean ===\n`);
  for (const p of phantoms.slice(0, 20)) {
    console.log(`  ${(p.coin_name || "?").padEnd(34)} ${p.wallet_tag.padEnd(28)} ${p.entry_time}`);
  }
  if (phantoms.length > 20) console.log(`  ... +${phantoms.length - 20} more`);

  // 2. Backup current state to JSON
  const backupPath = join(process.cwd(), `phantom-cleanup-backup-${Date.now()}.json`);
  writeFileSync(
    backupPath,
    JSON.stringify(
      phantoms.map((p) => ({
        id: p.id,
        coin_name: p.coin_name,
        status_before: "open",
        exit_reason_before: p.exit_reason ?? null,
        cleaned_at: new Date().toISOString(),
      })),
      null,
      2
    )
  );
  console.log(`\n📦 backup saved: ${backupPath}`);

  // 3. Flip status → failed. Gated on the exact same predicate as the
  //    query above (status=open + no [LIVE] tag + no entry_sol_cost)
  //    so we never clobber a row that's transitioning legitimately.
  let updated = 0;
  let failed = 0;
  for (const p of phantoms) {
    const { error: updErr } = await sb
      .from("trades")
      .update({ status: "failed", exit_reason: "filter_daily_limit_retro" })
      .eq("id", p.id)
      .eq("status", "open")
      .is("entry_sol_cost", null);
    if (updErr) { console.log(`  ✗ ${p.coin_name}: ${updErr.message}`); failed++; }
    else { updated++; }
  }
  console.log(`\n✓ updated: ${updated}   ✗ failed: ${failed}`);

  // 4. Sanity: re-count
  const { count } = await sb
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("status", "open")
    .not("wallet_tag", "like", "%[LIVE]%")
    .is("entry_sol_cost", null);
  console.log(`phantoms remaining: ${count ?? 0}`);
  console.log(`\nrollback via: npx tsx src/scripts/phantom-cleanup-rollback.ts ${backupPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
