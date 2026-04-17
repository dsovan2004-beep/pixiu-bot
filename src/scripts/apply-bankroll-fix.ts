/**
 * Q1 — subtract phantom $91.77 from bankroll (Day 2 stuck-sell over-credit).
 */
import "../lib/supabase-server";
import supabase from "../lib/supabase-server";

const PHANTOM_CREDIT = 91.77;

async function main() {
  const { data: bk } = await supabase
    .from("paper_bankroll")
    .select("id, current_balance, starting_balance")
    .limit(1)
    .single();
  if (!bk) throw new Error("no bankroll row");

  const before = Number(bk.current_balance);
  const after = before - PHANTOM_CREDIT;
  const newPnl = after - Number(bk.starting_balance || 10000);

  await supabase
    .from("paper_bankroll")
    .update({
      current_balance: after,
      total_pnl_usd: newPnl,
      updated_at: new Date().toISOString(),
    })
    .eq("id", bk.id);

  console.log(`✅ Bankroll: $${before.toFixed(2)} → $${after.toFixed(2)} (-$${PHANTOM_CREDIT})`);
}

main().catch(console.error);
