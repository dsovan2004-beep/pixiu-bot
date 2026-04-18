import "../lib/supabase-server";
import supabase from "../lib/supabase-server";

(async () => {
  // Retail Coin stuck-closing row — full detail
  const { data: stuck } = await supabase
    .from("trades")
    .select("*")
    .eq("status", "closing")
    .order("entry_time", { ascending: false });
  console.log("\n=== Rows with status=closing ===");
  console.log(JSON.stringify(stuck, null, 2));

  // What does dashboard /api/settings read? Check the status breakdown for today
  const { data: todayBreakdown } = await supabase
    .from("trades")
    .select("status")
    .gte("entry_time", "2026-04-17T00:00:00Z");
  const counts: Record<string, number> = {};
  for (const r of todayBreakdown ?? []) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log(`\n=== Today's status breakdown (by entry_time) ===`);
  console.log(counts);

  // LIVE-tagged open / closing — this is what dashboard "Open Positions" shows
  const { data: liveOpen } = await supabase
    .from("trades")
    .select("id, coin_name, status, wallet_tag, pnl_pct, grid_level, remaining_pct")
    .in("status", ["open", "closing"])
    .like("wallet_tag", "%[LIVE]%");
  console.log(`\n=== Open+closing with [LIVE] tag (dashboard "Open Positions") ===`);
  for (const r of liveOpen ?? []) {
    console.log(`  ${r.coin_name} — status=${r.status} grid=L${r.grid_level ?? 0} rem=${r.remaining_pct ?? "?"}% pnl=${r.pnl_pct ?? "-"}`);
  }

  // Retail Coin mint — check on-chain balance via Helius
  const retailCoinMint = stuck?.[0]?.coin_address;
  if (retailCoinMint) {
    const wallet = "ESK3r8n5jhaLn9Few59QKNJ5UMeD9iqZ5p1rbU9euvey";
    const rpc = process.env.HELIUS_RPC_URL;
    if (rpc) {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenAccountsByOwner",
          params: [wallet, { mint: retailCoinMint }, { encoding: "jsonParsed" }],
        }),
      });
      const js: any = await res.json();
      const acct = js?.result?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount;
      console.log(`\n=== On-chain balance for ${retailCoinMint.slice(0, 10)}... (Retail Coin) ===`);
      console.log(`  Wallet holds: ${acct?.uiAmount ?? 0} tokens (decimals=${acct?.decimals ?? "?"})`);
      console.log(`  → ${acct?.uiAmount > 0 ? "POSITION IS REAL on-chain" : "ZERO BALANCE — phantom"}`);
    } else {
      console.log("\nHELIUS_RPC_URL not set; skipping on-chain check");
    }
  }

  // Are there any 'failed' rows blocking future entries via address cooldown?
  const { data: failedToday } = await supabase
    .from("trades")
    .select("coin_address, coin_name, entry_time, status")
    .eq("status", "failed")
    .gte("entry_time", "2026-04-17T20:00:00Z")
    .order("entry_time", { ascending: false });
  console.log(`\n=== status=failed rows from last 2h (cooldown implications) ===`);
  for (const r of failedToday ?? []) {
    console.log(`  ${r.entry_time}  ${r.coin_name}  ${r.coin_address.slice(0, 10)}...`);
  }
})();
