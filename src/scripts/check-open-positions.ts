import "../lib/supabase-server";
import supabase from "../lib/supabase-server";

(async () => {
  const { data } = await supabase
    .from("trades")
    .select("coin_name, wallet_tag, status, entry_time, entry_price, grid_level, remaining_pct")
    .eq("status", "open")
    .order("entry_time", { ascending: false });
  console.log(`Open positions: ${data?.length ?? 0}\n`);
  for (const t of data || []) {
    const live = t.wallet_tag?.includes("[LIVE]") ? "🔴LIVE" : "📝paper";
    const ageMin = ((Date.now() - new Date(t.entry_time).getTime()) / 60000).toFixed(0);
    console.log(`${live} ${t.coin_name?.padEnd(25)} L${t.grid_level ?? 0} ${t.remaining_pct ?? 100}% age=${ageMin}min  tag=${t.wallet_tag}`);
  }
})();
