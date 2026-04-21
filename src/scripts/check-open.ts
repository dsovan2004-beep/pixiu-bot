// Quick read of current open positions with real_pnl_sol and mark state.
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

  const { data, error } = await sb
    .from("trades")
    .select("id, coin_name, coin_address, wallet_tag, entry_price, entry_sol_cost, grid_level, remaining_pct, partial_pnl, real_pnl_sol, entry_time, status")
    .in("status", ["open", "closing"])
    .order("entry_time", { ascending: false });

  if (error) {
    console.error("Query failed:", error.message);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.log("No open positions.");
    return;
  }

  for (const t of data) {
    const ageMin = (Date.now() - new Date(t.entry_time).getTime()) / 60000;

    // Fetch current mark from DexScreener
    let currentPrice: number | null = null;
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${t.coin_address}`);
      if (res.ok) {
        const json: any = await res.json();
        const pairs = json?.pairs ?? [];
        if (pairs.length > 0) {
          currentPrice = Number(pairs[0].priceUsd ?? 0);
        }
      }
    } catch {}

    console.log(`\n=== ${t.coin_name} ===`);
    console.log(`status:          ${t.status}`);
    console.log(`wallet_tag:      ${t.wallet_tag}`);
    console.log(`entry_price:     $${t.entry_price}`);
    if (currentPrice) {
      const pnlPct = ((currentPrice - Number(t.entry_price)) / Number(t.entry_price)) * 100;
      console.log(`current_price:   $${currentPrice.toFixed(10)}`);
      console.log(`mark_pnl:        ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`);
    }
    console.log(`entry_sol_cost:  ${t.entry_sol_cost ?? "null"} SOL`);
    console.log(`grid_level:      L${t.grid_level}`);
    console.log(`remaining_pct:   ${t.remaining_pct}%`);
    console.log(`partial_pnl:     ${t.partial_pnl}% (mark-based)`);
    console.log(`real_pnl_sol:    ${t.real_pnl_sol ?? "null"} (banked from partials)`);
    console.log(`age:             ${ageMin.toFixed(1)} min`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
