import "../lib/supabase-server";
import supabase from "../lib/supabase-server";

(async () => {
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data } = await supabase
    .from("paper_trades")
    .select("coin_name, wallet_tag, status, exit_reason, pnl_pct, pnl_usd, exit_time")
    .gte("exit_time", since)
    .order("exit_time", { ascending: false });
  for (const t of data || []) {
    const live = t.wallet_tag?.includes("[LIVE]") ? "🔴LIVE" : "📝paper";
    console.log(`${live} ${t.coin_name?.padEnd(20)} ${t.exit_reason?.padEnd(15)} ${(t.pnl_pct ?? 0).toFixed(2).padStart(7)}%  $${(t.pnl_usd ?? 0).toFixed(2)}`);
  }
})();
