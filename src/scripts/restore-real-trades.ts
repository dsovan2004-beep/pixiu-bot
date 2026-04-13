/**
 * PixiuBot — Restore Real Trades
 * One-time script to re-insert confirmed real trades that were
 * accidentally deleted during the placeholder-price bug reset.
 *
 * Usage: npx tsx src/scripts/restore-real-trades.ts
 */

import supabase from "../lib/supabase-server";

const POSITION_SIZE_USD = 100;

interface TradeRecord {
  coin_name: string;
  entry_price: number;
  exit_price: number;
  pnl_pct: number;
  exit_reason: string;
  exit_date: string; // YYYY-MM-DD
}

const REAL_TRADES: TradeRecord[] = [
  { coin_name: "Adamity", entry_price: 0.00003553, exit_price: 0.0001025, pnl_pct: 42.50, exit_reason: "grid_tp", exit_date: "2026-04-11" },
  { coin_name: "for all mankind", entry_price: 0.000007752, exit_price: 0.000008730, pnl_pct: 12.62, exit_reason: "manual", exit_date: "2026-04-11" },
  { coin_name: "FRIES IN THE BAG", entry_price: 0.0000179, exit_price: 0.00003951, pnl_pct: 42.50, exit_reason: "grid_tp", exit_date: "2026-04-13" },
  { coin_name: "引きこもり", entry_price: 0.00003028, exit_price: 0.00006412, pnl_pct: 42.50, exit_reason: "grid_tp", exit_date: "2026-04-13" },
  { coin_name: "realDonaldTrump", entry_price: 0.000006011, exit_price: 0.00001913, pnl_pct: 42.50, exit_reason: "grid_tp", exit_date: "2026-04-13" },
  { coin_name: "Garlicoin", entry_price: 0.00001905, exit_price: 0.00002483, pnl_pct: 25.09, exit_reason: "grid_l2", exit_date: "2026-04-13" },
  { coin_name: "Garlicoin", entry_price: 0.00001905, exit_price: 0.00002483, pnl_pct: 25.09, exit_reason: "grid_l2", exit_date: "2026-04-13" },
  { coin_name: "Swinu", entry_price: 0.00002387, exit_price: 0.00004797, pnl_pct: 42.50, exit_reason: "grid_tp", exit_date: "2026-04-13" },
  { coin_name: "NeitherLabourForceEducationTrain", entry_price: 0.000003345, exit_price: 0.000009186, pnl_pct: 42.50, exit_reason: "grid_tp", exit_date: "2026-04-13" },
  { coin_name: "d[o_0]b", entry_price: 0.00003765, exit_price: 0.00005740, pnl_pct: 30.61, exit_reason: "grid_l2", exit_date: "2026-04-13" },
  { coin_name: "Firehawk", entry_price: 0.000002392, exit_price: 0.000005107, pnl_pct: 42.50, exit_reason: "grid_tp", exit_date: "2026-04-13" },
  { coin_name: "Neucoin", entry_price: 0.00004105, exit_price: 0.00004031, pnl_pct: 6.60, exit_reason: "grid_l1", exit_date: "2026-04-13" },
  { coin_name: "Kracking", entry_price: 0.000004614, exit_price: 0.000005474, pnl_pct: 16.82, exit_reason: "grid_l1", exit_date: "2026-04-13" },
  { coin_name: "wUSDC", entry_price: 0.00001031, exit_price: 0.00001282, pnl_pct: 19.67, exit_reason: "grid_l1", exit_date: "2026-04-13" },
  { coin_name: "Catzilla", entry_price: 0.000009701, exit_price: 0.00001137, pnl_pct: 16.10, exit_reason: "grid_l1", exit_date: "2026-04-13" },
  { coin_name: "猫齐拉", entry_price: 0.000003557, exit_price: 0.00001406, pnl_pct: 42.50, exit_reason: "grid_tp", exit_date: "2026-04-13" },
  { coin_name: "Marscoin", entry_price: 0.00001677, exit_price: 0.00001454, pnl_pct: 0.85, exit_reason: "stop_loss", exit_date: "2026-04-13" },
  { coin_name: "Digital Crude OIL", entry_price: 0.000001338, exit_price: 0.000005576, pnl_pct: 42.50, exit_reason: "grid_tp", exit_date: "2026-04-13" },
  { coin_name: "XFanalyzer", entry_price: 0.000006440, exit_price: 0.000006525, pnl_pct: 1.32, exit_reason: "timeout", exit_date: "2026-04-13" },
  { coin_name: "ok", entry_price: 0.000007836, exit_price: 0.000006769, pnl_pct: -13.62, exit_reason: "stop_loss", exit_date: "2026-04-13" },
  { coin_name: "Luckycoin", entry_price: 0.00001579, exit_price: 0.00001388, pnl_pct: -12.10, exit_reason: "stop_loss", exit_date: "2026-04-13" },
  { coin_name: "The Great Divergence", entry_price: 0.000006749, exit_price: 0.000003341, pnl_pct: -50.50, exit_reason: "manual", exit_date: "2026-04-13" },
  { coin_name: "The Green Alien", entry_price: 0.000008962, exit_price: 0.000002842, pnl_pct: -68.29, exit_reason: "manual", exit_date: "2026-04-13" },
  { coin_name: "Merit Of The Game Is", entry_price: 0.00003584, exit_price: 0.00003169, pnl_pct: -11.58, exit_reason: "manual", exit_date: "2026-04-13" },
  { coin_name: "Flying Parachute Capybara", entry_price: 0.000003999, exit_price: 0.000003920, pnl_pct: -1.98, exit_reason: "timeout", exit_date: "2026-04-13" },
  { coin_name: "My cat ❤️", entry_price: 0.00001212, exit_price: 0.000021830, pnl_pct: 37.53, exit_reason: "timeout", exit_date: "2026-04-12" },
  { coin_name: "My cat ❤️", entry_price: 0.000010620, exit_price: 0.000007255, pnl_pct: 9.58, exit_reason: "manual", exit_date: "2026-04-11" },
  { coin_name: "Cardboard King Strategy", entry_price: 0.00004209, exit_price: 0.00004780, pnl_pct: 14.28, exit_reason: "timeout", exit_date: "2026-04-11" },
  { coin_name: "Cat Saved by Grok", entry_price: 0.00007413, exit_price: 0.00005943, pnl_pct: -2.42, exit_reason: "stop_loss", exit_date: "2026-04-11" },
  { coin_name: "Cat Saved by Grok", entry_price: 0.00009273, exit_price: 0.00008317, pnl_pct: -10.31, exit_reason: "stop_loss", exit_date: "2026-04-11" },
  { coin_name: "My cat ❤️", entry_price: 0.0003789, exit_price: 0.0003264, pnl_pct: -13.86, exit_reason: "stop_loss", exit_date: "2026-04-12" },
  { coin_name: "My cat ❤️", entry_price: 0.0003186, exit_price: 0.0002844, pnl_pct: -10.73, exit_reason: "stop_loss", exit_date: "2026-04-12" },
  { coin_name: "FUCKALONCOHENFUCKDYLANKERLER", entry_price: 0.00002476, exit_price: 0.00001886, pnl_pct: -23.83, exit_reason: "stop_loss", exit_date: "2026-04-13" },
  { coin_name: "Child of God", entry_price: 0.00001168, exit_price: 0.000007438, pnl_pct: -36.32, exit_reason: "manual", exit_date: "2026-04-11" },
  { coin_name: "USD0", entry_price: 0.00001893, exit_price: 0.00001136, pnl_pct: -39.99, exit_reason: "manual", exit_date: "2026-04-11" },
  { coin_name: "Vellum", entry_price: 0.00001623, exit_price: 0.00001585, pnl_pct: -2.34, exit_reason: "timeout", exit_date: "2026-04-11" },
];

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Restore Real Trades");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Safety: verify no placeholder-priced trades sneak in
  for (const t of REAL_TRADES) {
    if (t.entry_price === 0.000001) {
      console.error(`  [ABORT] Found placeholder price in ${t.coin_name} — aborting`);
      process.exit(1);
    }
  }

  let inserted = 0;
  let totalPnlUsd = 0;

  for (const t of REAL_TRADES) {
    const pnlUsd = (t.pnl_pct / 100) * POSITION_SIZE_USD;
    totalPnlUsd += pnlUsd;

    // Entry time = exit date minus ~20 min (approximate)
    const exitTime = new Date(`${t.exit_date}T12:00:00Z`);
    const entryTime = new Date(exitTime.getTime() - 20 * 60_000);

    const { error } = await supabase.from("paper_trades").insert({
      coin_name: t.coin_name,
      coin_address: "restored_" + t.coin_name.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 30),
      wallet_tag: "restored",
      entry_price: t.entry_price,
      exit_price: t.exit_price,
      pnl_pct: t.pnl_pct,
      pnl_usd: pnlUsd,
      status: "closed",
      entry_time: entryTime.toISOString(),
      exit_time: exitTime.toISOString(),
      exit_reason: t.exit_reason,
      position_size_usd: POSITION_SIZE_USD,
      entry_mc: null,
      priority: "normal",
      grid_level: 0,
      remaining_pct: 0,
      partial_pnl: t.pnl_pct,
    });

    if (error) {
      console.error(`  [ERROR] ${t.coin_name}: ${error.message}`);
    } else {
      inserted++;
      const sign = t.pnl_pct >= 0 ? "+" : "";
      console.log(`  [OK] ${t.coin_name} | ${sign}${t.pnl_pct}% | $${sign}${pnlUsd.toFixed(2)}`);
    }
  }

  // Recalculate bankroll: $10,000 base + sum of all PnL
  const newBalance = 10000 + totalPnlUsd;

  const { error: bankrollErr } = await supabase
    .from("paper_bankroll")
    .update({
      current_balance: newBalance,
      total_pnl_usd: totalPnlUsd,
      updated_at: new Date().toISOString(),
    })
    .neq("id", "00000000-0000-0000-0000-000000000000");

  if (bankrollErr) {
    console.error(`  [ERROR] Bankroll update: ${bankrollErr.message}`);
  }

  console.log(`\n  ─── Summary ───`);
  console.log(`  Inserted: ${inserted}/${REAL_TRADES.length} trades`);
  console.log(`  Total PnL: $${totalPnlUsd >= 0 ? "+" : ""}${totalPnlUsd.toFixed(2)}`);
  console.log(`  Bankroll: $${newBalance.toFixed(2)}`);

  // Verify
  const { data: bankroll } = await supabase
    .from("paper_bankroll")
    .select("current_balance, total_pnl_usd")
    .limit(1)
    .single();

  const { count } = await supabase
    .from("paper_trades")
    .select("id", { count: "exact", head: true })
    .eq("status", "closed");

  console.log(`  Verified: ${count} closed trades | Balance: $${Number(bankroll?.current_balance || 0).toFixed(2)}\n`);
}

main().catch((err) => {
  console.error("Restore failed:", err);
  process.exit(1);
});
