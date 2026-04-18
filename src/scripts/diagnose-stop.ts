import "../lib/supabase-server";
import supabase from "../lib/supabase-server";

(async () => {
  const todayUTC = new Date().toISOString().slice(0, 10);
  const todayStart = `${todayUTC}T00:00:00Z`;
  const now = new Date().toISOString();

  console.log(`\n=== Daily Loss Audit (UTC window) ===\n`);
  console.log(`Today UTC: ${todayUTC}`);
  console.log(`Window:    ${todayStart}  →  ${now}\n`);

  // LIVE losing trades since midnight UTC
  const { data: livelosses, error } = await supabase
    .from("trades")
    .select("coin_name, pnl_pct, pnl_usd, exit_time, exit_reason")
    .eq("status", "closed")
    .gte("exit_time", todayStart)
    .lt("pnl_pct", 0)
    .like("wallet_tag", "%[LIVE]%")
    .order("exit_time", { ascending: false });

  if (error) { console.error(error); return; }

  console.log(`LIVE losing trades since midnight UTC: ${livelosses?.length ?? 0}`);
  console.log(`At 0.05 SOL per trade → real SOL loss: ${((livelosses?.length ?? 0) * 0.05).toFixed(2)} SOL`);
  console.log(`Limit threshold: 2.0 SOL (40 losses)\n`);

  if (livelosses && livelosses.length > 0) {
    console.log(`First 20 losses (newest first):`);
    for (const t of livelosses.slice(0, 20)) {
      const timeStr = new Date(t.exit_time).toISOString().replace("T", " ").slice(0, 19);
      console.log(`  ${timeStr} UTC  ${t.coin_name?.slice(0, 25).padEnd(25)} ${t.pnl_pct?.toFixed(1)}%  ${t.exit_reason}`);
    }

    if (livelosses.length >= 40) {
      console.log(`\n>>> THRESHOLD EXCEEDED — bot should have auto-stopped`);
      console.log(`>>> 40th-to-last loss timestamp: ${livelosses[39].exit_time}`);
    } else {
      console.log(`\n>>> Not at threshold yet (${livelosses.length}/40).`);
    }
  }

  // bot_state
  const { data: state } = await supabase.from("bot_state").select("*").limit(1).single();
  console.log(`\nbot_state:`, state);
})();
