import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";

// Rollback companion for cleanup-daily-limit-phantoms.ts. Takes a
// backup JSON (one object per row with { id, status_before,
// exit_reason_before }) and restores those fields. Only touches rows
// currently at status='failed' with exit_reason='filter_daily_limit_retro'
// — a safety gate so we don't clobber rows that moved on after the
// cleanup.

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

  const backupFile = process.argv[2];
  if (!backupFile) { console.error("usage: phantom-cleanup-rollback.ts <backup.json>"); process.exit(1); }

  const backup = JSON.parse(readFileSync(backupFile, "utf8"));
  console.log(`\n=== rollback ${backup.length} phantom rows from ${backupFile} ===\n`);

  let restored = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of backup) {
    const { data, error } = await sb
      .from("trades")
      .update({
        status: row.status_before,
        exit_reason: row.exit_reason_before,
      })
      .eq("id", row.id)
      .eq("status", "failed")
      .eq("exit_reason", "filter_daily_limit_retro")
      .select("id")
      .maybeSingle();
    if (error) { console.log(`  ✗ ${row.coin_name}: ${error.message}`); failed++; }
    else if (!data) { skipped++; } // row no longer matches predicate — leave alone
    else { restored++; }
  }
  console.log(`restored: ${restored}  skipped (state changed): ${skipped}  failed: ${failed}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
