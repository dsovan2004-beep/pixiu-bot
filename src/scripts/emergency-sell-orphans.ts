/**
 * Emergency: the trailing exit closes on Yoshi + WHERE IS THE AIRDROP
 * booked as "token balance 0" closes (skipping Jupiter sell entirely)
 * because hasTokenBalance returned a false 0 (flaky RPC).
 *
 * If the tokens are actually still in the wallet, we have orphans.
 * This script checks and sells them.
 */

import "../lib/supabase-server";
import supabase from "../lib/supabase-server";
import { sellToken } from "../lib/jupiter-swap";

(async () => {
  // Pull the two mints from the most recent closed trades
  const { data } = await supabase
    .from("trades")
    .select("coin_name, coin_address, exit_time, pnl_pct")
    .in("coin_name", ["WHERE IS THE AIRDROP", "Yoshi"])
    .order("exit_time", { ascending: false })
    .limit(4);

  const seen = new Set<string>();
  const mints: { name: string; addr: string }[] = [];
  for (const r of data ?? []) {
    if (seen.has(r.coin_address)) continue;
    seen.add(r.coin_address);
    mints.push({ name: r.coin_name, addr: r.coin_address });
    if (mints.length >= 2) break;
  }

  console.log(`Checking ${mints.length} recently-closed mints for orphaned balances...\n`);

  for (const m of mints) {
    console.log(`\n== ${m.name} (${m.addr}) ==`);
    try {
      const sig = await sellToken(m.addr);
      if (sig) {
        console.log(`  ✅ Sold orphan. Sig: ${sig}`);
      } else {
        console.log(`  ℹ️  Nothing to sell (truly zero balance).`);
      }
    } catch (err: any) {
      console.log(`  ❌ Error: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
})();
