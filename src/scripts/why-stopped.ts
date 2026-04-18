import "../lib/supabase-server";
import supabase from "../lib/supabase-server";
import { LIVE_BUY_SOL, DAILY_LOSS_LIMIT_SOL } from "../config/smart-money";

(async () => {
  // bot_state
  const { data: bs } = await supabase.from("bot_state").select("*").limit(1).single();
  console.log("bot_state:");
  console.log(`  is_running: ${bs?.is_running}`);
  console.log(`  mode: ${bs?.mode}`);
  console.log(`  last_updated: ${bs?.last_updated}`);
  console.log(`  minutes since updated: ${((Date.now() - new Date(bs?.last_updated).getTime())/60_000).toFixed(1)}`);

  // Check daily loss limit math (this is what guard uses to auto-stop)
  const todayUTC = new Date().toISOString().slice(0, 10);
  const todayStart = `${todayUTC}T00:00:00Z`;
  const { data: losses } = await supabase
    .from("trades")
    .select("coin_name, pnl_pct, exit_time")
    .eq("status", "closed")
    .gte("exit_time", todayStart)
    .lt("pnl_pct", 0)
    .like("wallet_tag", "%[LIVE]%")
    .order("exit_time", { ascending: false });

  const totalLossSol = (losses ?? []).reduce(
    (s, t) => s + (LIVE_BUY_SOL * Math.abs(Number(t.pnl_pct))) / 100, 0
  );
  console.log(`\nDaily loss limit check (LIVE losses since UTC midnight):`);
  console.log(`  Limit: ${DAILY_LOSS_LIMIT_SOL} SOL`);
  console.log(`  Today's LIVE losses: ${totalLossSol.toFixed(4)} SOL across ${losses?.length ?? 0} trades`);
  console.log(`  Would trigger auto-stop? ${totalLossSol >= DAILY_LOSS_LIMIT_SOL ? "YES" : "no"}`);
  console.log(`  Losing LIVE trades today:`);
  for (const t of losses ?? []) {
    const solLoss = (LIVE_BUY_SOL * Math.abs(Number(t.pnl_pct))) / 100;
    console.log(`    ${t.exit_time}  ${t.coin_name?.slice(0,25).padEnd(25)}  ${Number(t.pnl_pct).toFixed(1)}%  (${solLoss.toFixed(4)} SOL)`);
  }
})();
