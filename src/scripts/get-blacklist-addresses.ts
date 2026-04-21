// One-off: resolve blacklist wallet names to on-chain addresses.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";

const BLACKLIST_NAMES = [
  "GMGN_SM_5",
  "Scharo",
  "cented",
  "Bluey",
  "bandit",
  "decu",
  "chair",
  "Numer0",
  "Cupsey",
];

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

  for (const name of BLACKLIST_NAMES) {
    const { data, error } = await sb
      .from("tracked_wallets")
      .select("wallet_address, tag, tier")
      .ilike("tag", name)
      .limit(5);
    if (error) {
      console.log(`${name.padEnd(14)} ERROR ${error.message}`);
      continue;
    }
    if (!data || data.length === 0) {
      console.log(`${name.padEnd(14)} NOT FOUND — trying fuzzy match...`);
      const fuzzy = await sb
        .from("tracked_wallets")
        .select("wallet_address, tag, tier")
        .ilike("tag", `%${name}%`)
        .limit(5);
      if (fuzzy.data && fuzzy.data.length > 0) {
        for (const r of fuzzy.data) {
          console.log(`${name.padEnd(14)} FUZZY: ${r.wallet_address} "${r.tag}" T${r.tier}`);
        }
      } else {
        console.log(`${name.padEnd(14)} NO FUZZY MATCH EITHER`);
      }
      continue;
    }
    for (const r of data) {
      console.log(`${name.padEnd(14)} ${r.wallet_address} "${r.tag}" T${r.tier}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
