import "../lib/supabase-server";
import supabase from "../lib/supabase-server";
import { LIVE_BUY_SOL, DAILY_LOSS_LIMIT_SOL } from "../config/smart-money";

(async () => {
  const todayUTC = new Date().toISOString().slice(0, 10);
  const todayStart = `${todayUTC}T00:00:00Z`;

  const { data: losses } = await supabase
    .from("trades")
    .select("coin_name, pnl_pct")
    .eq("status", "closed")
    .gte("exit_time", todayStart)
    .lt("pnl_pct", 0)
    .like("wallet_tag", "%[LIVE]%")
    .order("pnl_pct", { ascending: true });

  const oldLogic = (losses?.length ?? 0) * LIVE_BUY_SOL;
  const newLogic = (losses ?? []).reduce((sum, t) => {
    const pct = Number(t.pnl_pct);
    return sum + (LIVE_BUY_SOL * Math.abs(pct)) / 100;
  }, 0);

  console.log(`\n=== Daily Loss Comparison (UTC ${todayUTC}) ===\n`);
  console.log(`Losing LIVE trades today: ${losses?.length ?? 0}\n`);
  console.log(`OLD logic (count × 0.05):       ${oldLogic.toFixed(3)} SOL`);
  console.log(`NEW logic (SUM 0.05 × |pnl|/100): ${newLogic.toFixed(3)} SOL`);
  console.log(`Overstatement ratio: ${(oldLogic / Math.max(newLogic, 0.0001)).toFixed(2)}×\n`);
  console.log(`Threshold (DAILY_LOSS_LIMIT_SOL): ${DAILY_LOSS_LIMIT_SOL} SOL`);
  console.log(`OLD trips? ${oldLogic >= DAILY_LOSS_LIMIT_SOL ? "YES" : "no"}`);
  console.log(`NEW trips? ${newLogic >= DAILY_LOSS_LIMIT_SOL ? "YES" : "no"}\n`);

  console.log(`Top 5 biggest losses by real SOL:`);
  const sorted = [...(losses ?? [])].map(t => ({
    ...t,
    sol: (LIVE_BUY_SOL * Math.abs(Number(t.pnl_pct))) / 100,
  })).sort((a, b) => b.sol - a.sol);
  for (const t of sorted.slice(0, 5)) {
    console.log(`  ${t.coin_name?.slice(0, 30).padEnd(30)} ${Number(t.pnl_pct).toFixed(1)}%  ${t.sol.toFixed(4)} SOL`);
  }
})();
