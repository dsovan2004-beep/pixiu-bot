import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";

// Rollback the bad reconcile: restore real_pnl_sol from the backup JSON.

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
  if (!backupFile) { console.error("usage: reconcile-rollback.ts <backup.json>"); process.exit(1); }

  const backup = JSON.parse(readFileSync(backupFile, "utf8"));
  console.log(`\n=== rollback ${backup.length} rows from ${backupFile} ===\n`);

  let restored = 0;
  let failed = 0;
  for (const row of backup) {
    console.log(`  ${row.coin_name.padEnd(30)} → restoring real_pnl_sol = ${row.real_pnl_sol_before}`);
    const { error } = await sb
      .from("trades")
      .update({ real_pnl_sol: row.real_pnl_sol_before })
      .eq("id", row.id);
    if (error) { console.log(`    ✗ ${error.message}`); failed++; }
    else { restored++; }
  }

  console.log(`\nRestored: ${restored}  Failed: ${failed}`);

  const { data: allClosed } = await sb
    .from("trades")
    .select("real_pnl_sol")
    .eq("status", "closed")
    .like("wallet_tag", "%[LIVE]%")
    .not("real_pnl_sol", "is", null);
  const dashSum = (allClosed ?? []).reduce((s, r) => s + Number(r.real_pnl_sol), 0);
  console.log(`Dashboard sum after rollback: ${dashSum.toFixed(4)} SOL`);
}
main().catch((e) => { console.error(e); process.exit(1); });
