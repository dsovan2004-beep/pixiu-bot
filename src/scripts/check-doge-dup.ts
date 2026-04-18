import "../lib/supabase-server";
import supabase from "../lib/supabase-server";

(async () => {
  const { data } = await supabase
    .from("trades")
    .select("id, coin_name, wallet_tag, exit_reason, pnl_usd, exit_time")
    .eq("coin_name", "Doge Memes")
    .eq("status", "closed")
    .order("exit_time", { ascending: false })
    .limit(5);
  for (const t of data || []) {
    console.log(`${t.exit_time}  id=${t.id}  ${t.exit_reason}  $${(t.pnl_usd ?? 0).toFixed(2)}  tag=${t.wallet_tag}`);
  }
})();
