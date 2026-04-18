import "../lib/supabase-server";
import supabase from "../lib/supabase-server";

(async () => {
  const now = new Date();
  console.log(`Now: ${now.toISOString()}\n`);

  // 1. bot_state
  const { data: bs } = await supabase.from("bot_state").select("*").limit(1).single();
  console.log("bot_state:");
  console.log(`  is_running: ${bs?.is_running}`);
  console.log(`  mode: ${bs?.mode}`);
  console.log(`  last_updated: ${bs?.last_updated}`);

  // 2. signals in last hour
  const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  const { count: recentSignals } = await supabase
    .from("coin_signals")
    .select("id", { count: "exact", head: true })
    .gte("signal_time", oneHourAgo);
  console.log(`\nSignals in last 1h: ${recentSignals}`);

  // most recent 3 signals
  const { data: latestSig } = await supabase
    .from("coin_signals")
    .select("signal_time, wallet_tag, coin_name, transaction_type")
    .order("signal_time", { ascending: false })
    .limit(3);
  console.log("Latest 3 signals:");
  for (const s of latestSig ?? []) console.log(`  ${s.signal_time}  ${s.wallet_tag}  ${s.transaction_type}  ${s.coin_name}`);

  // 3. trades today
  const todayStart = new Date().toISOString().slice(0, 10) + "T00:00:00Z";
  const { data: today } = await supabase
    .from("trades")
    .select("entry_time, status, coin_name, wallet_tag")
    .gte("entry_time", todayStart)
    .order("entry_time", { ascending: false })
    .limit(10);
  console.log(`\nLast ${today?.length ?? 0} trades today:`);
  for (const t of today ?? []) console.log(`  ${t.entry_time}  ${t.status}  ${t.coin_name}  ${t.wallet_tag}`);

  // 4. any open positions
  const { data: open } = await supabase
    .from("trades")
    .select("entry_time, coin_name, pnl_pct")
    .eq("status", "open");
  console.log(`\nOpen positions: ${open?.length ?? 0}`);
  for (const o of open ?? []) console.log(`  ${o.entry_time}  ${o.coin_name}`);
})();
