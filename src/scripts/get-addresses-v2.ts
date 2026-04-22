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
  const names = ["Trenchman", "Johnson", "chester", "SmokezXBT", "pr6spr"];
  for (const n of names) {
    const { data } = await sb.from("tracked_wallets").select("wallet_address, tag, tier").ilike("tag", n);
    for (const r of data || []) {
      console.log(`${r.tag.padEnd(14)} ${r.wallet_address} T${r.tier}`);
    }
  }
}
main();
