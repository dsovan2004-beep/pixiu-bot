import "../lib/supabase-server";
import supabase from "../lib/supabase-server";

(async () => {
  // Find Psyche 16 / FuLdQtFS row
  const { data } = await supabase
    .from("trades")
    .select("id, coin_name, coin_address, entry_time, wallet_tag, status, exit_time, exit_reason, pnl_pct")
    .or("coin_name.eq.Psyche 16,coin_address.like.FuLdQtFS%")
    .order("entry_time", { ascending: false })
    .limit(3);
  console.log("Psyche 16 rows:");
  for (const t of data || []) {
    console.log(JSON.stringify(t, null, 2));
  }

  // Also: last 5 closed trades (what webhookIsRugStorm would see)
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  const { data: recent } = await supabase
    .from("trades")
    .select("coin_name, pnl_pct, exit_time")
    .eq("status", "closed")
    .gte("exit_time", twoHoursAgo)
    .order("exit_time", { ascending: false })
    .limit(5);
  console.log("\nLast 5 closed trades (webhookIsRugStorm view):");
  for (const t of recent || []) {
    console.log(`  ${t.exit_time}  ${t.coin_name?.slice(0,25).padEnd(25)}  ${Number(t.pnl_pct).toFixed(1)}%`);
  }
  const losses = (recent ?? []).filter(t => Number(t.pnl_pct) < 0).length;
  console.log(`  → ${losses}/${recent?.length ?? 0} losses. Rug storm? ${(recent?.length ?? 0) >= 5 && losses >= 3 ? "YES" : "NO"}`);
})();
