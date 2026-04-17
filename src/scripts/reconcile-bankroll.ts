/**
 * Reconcile paper_bankroll vs reality after the Day 2 stuck-sell bug.
 *
 * Problem: 8 trades had `status='closed'` + bankroll credited, but the on-chain
 * sell never landed. Today we recovered SOL by manually selling. The bankroll
 * therefore double-counts those 8 trades' PnL.
 *
 * This script: shows current bankroll, lists the 8 over-credited trades with
 * their pnl_usd, and prints the suggested correction. Does NOT auto-write.
 */
import "../lib/supabase-server";
import supabase from "../lib/supabase-server";

const STUCK_TRADE_MINTS = [
  "3TYgKwkE2Y3rxdw9osLRSpxpXmSC1C1oo19W9KHspump", // Bull
  "DSZeB6pCzZsM43gTz7jakiYeCafinsNMKcpeB1FApump", // Wasabi Cheese
  "5M8iwnvwZVAAHq1qtYmrgYCzXzDjjCpFnrUYA3Vupump", // LOL Guy
  "98KnbbkmtvZ9duCYVZpvpYoBMnTEuZFhsVKXr5YF6Jjx", // jensoncore
  "98oXBs8bwb5b7L2k8thZDr3S2ub4H5vDNjLm7uvpump", // Sigmoid Markets
  "7Lbe787dJ4bxpPiEWLb9R9VnQsMiET6Gbacxedm3pump", // meowtakeover
  "9rPoaV7XE1uCYYGrFmzEX8Fa8kEVP3xDsdwypC5qpump", // yn
  "7mNWyQYJfvf5gJDVwXL8aw8m9Qmo4MDKrLHNaESdpump", // unt
];

async function main() {
  const { data: bk } = await supabase
    .from("paper_bankroll")
    .select("id, current_balance, starting_balance, total_pnl_usd")
    .limit(1)
    .single();

  console.log(`\nCurrent bankroll: $${Number(bk?.current_balance || 0).toFixed(2)}`);
  console.log(`Starting balance: $${Number(bk?.starting_balance || 0).toFixed(2)}`);
  console.log(`Total PnL: $${Number(bk?.total_pnl_usd || 0).toFixed(2)}\n`);

  const { data: trades } = await supabase
    .from("paper_trades")
    .select("id, coin_name, coin_address, pnl_pct, pnl_usd, exit_reason, exit_time")
    .in("coin_address", STUCK_TRADE_MINTS)
    .like("wallet_tag", "%[LIVE]%")
    .eq("status", "closed");

  console.log(`Over-credited trades (recovered today via manual sell):`);
  let totalOverCredit = 0;
  for (const t of trades || []) {
    const pnl = Number(t.pnl_usd || 0);
    totalOverCredit += pnl;
    console.log(
      `  ${t.coin_name?.padEnd(20)} ${t.exit_reason?.padEnd(12)} pnl=${(t.pnl_pct ?? 0).toFixed(2)}%  $${pnl.toFixed(2)}`
    );
  }

  console.log(`\nTotal phantom PnL credited: $${totalOverCredit.toFixed(2)}`);
  console.log(`Note: actual recovered value from manual sells differs (tokens decayed).`);
  console.log(`\nRecommended action: subtract $${totalOverCredit.toFixed(2)} from bankroll, then`);
  console.log(`re-add the actual SOL value recovered (check wallet SOL delta).`);
  console.log(`\nTo apply blindly (assume recovered = 0):`);
  console.log(`  new_balance = $${(Number(bk?.current_balance || 0) - totalOverCredit).toFixed(2)}`);
}

main().catch(console.error);
