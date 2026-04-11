/**
 * PixiuBot — Reset Paper Trades
 * Usage: npx tsx src/scripts/reset-paper-trades.ts
 *
 * Deletes all paper_trades and resets bankroll to $10,000.
 */

import supabase from "../lib/supabase-server";

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Reset Paper Trades");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Count existing trades
  const { count: tradeCount } = await supabase
    .from("paper_trades")
    .select("id", { count: "exact", head: true });

  // Delete all paper trades
  const { error: deleteErr } = await supabase
    .from("paper_trades")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000"); // delete all rows

  if (deleteErr) {
    console.error("  [ERROR] Delete trades:", deleteErr.message);
    process.exit(1);
  }

  // Reset bankroll
  const { error: bankrollErr } = await supabase
    .from("paper_bankroll")
    .update({
      current_balance: 10000,
      total_pnl_usd: 0,
      updated_at: new Date().toISOString(),
    })
    .neq("id", "00000000-0000-0000-0000-000000000000"); // update all rows

  if (bankrollErr) {
    console.error("  [ERROR] Reset bankroll:", bankrollErr.message);
    process.exit(1);
  }

  // Verify
  const { count: remaining } = await supabase
    .from("paper_trades")
    .select("id", { count: "exact", head: true });

  const { data: bankroll } = await supabase
    .from("paper_bankroll")
    .select("current_balance, total_pnl_usd")
    .limit(1)
    .single();

  console.log(`  [RESET] Deleted ${tradeCount || 0} paper trades (remaining: ${remaining || 0})`);
  console.log(`  [RESET] Bankroll reset to $${Number(bankroll?.current_balance || 10000).toFixed(2)} | PnL: $${Number(bankroll?.total_pnl_usd || 0).toFixed(2)}`);
  console.log(`  [RESET] Sprint 2 Round 2 ready\n`);
}

main().catch((err) => {
  console.error("Reset failed:", err);
  process.exit(1);
});
