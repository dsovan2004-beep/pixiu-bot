/**
 * Diagnostic — entry frequency funnel analysis.
 * Read-only: reports signal volume + rejection reasons over the last 3 hours.
 */
import "../lib/supabase-server";
import supabase from "../lib/supabase-server";
import { readFileSync } from "fs";

const HOURS = 3;
const since = new Date(Date.now() - HOURS * 3600_000).toISOString();

async function main() {
  console.log(`\n=== Entry-frequency diagnostic (last ${HOURS}h) ===\n`);

  // 1. Raw signals from watcher
  const { count: allSignals } = await supabase
    .from("coin_signals")
    .select("id", { count: "exact", head: true })
    .gte("signal_time", since);

  const { count: buySignals } = await supabase
    .from("coin_signals")
    .select("id", { count: "exact", head: true })
    .eq("transaction_type", "BUY")
    .gte("signal_time", since);

  const { count: buyRugPassed } = await supabase
    .from("coin_signals")
    .select("id", { count: "exact", head: true })
    .eq("transaction_type", "BUY")
    .eq("rug_check_passed", true)
    .gte("signal_time", since);

  const { count: uniqueCoins } = await supabase
    .from("coin_signals")
    .select("coin_address", { count: "exact", head: true })
    .eq("transaction_type", "BUY")
    .gte("signal_time", since);

  // 2. Entries (trades rows created)
  const { count: trades } = await supabase
    .from("trades")
    .select("id", { count: "exact", head: true })
    .gte("entry_time", since);

  const { count: liveTrades } = await supabase
    .from("trades")
    .select("id", { count: "exact", head: true })
    .gte("entry_time", since)
    .like("wallet_tag", "%[LIVE]%");

  const { count: failedTrades } = await supabase
    .from("trades")
    .select("id", { count: "exact", head: true })
    .gte("entry_time", since)
    .eq("status", "failed");

  // 3. Wallet tier breakdown
  const { count: t1Count } = await supabase
    .from("tracked_wallets")
    .select("id", { count: "exact", head: true })
    .eq("active", true)
    .eq("tier", 1);

  const { count: t2Count } = await supabase
    .from("tracked_wallets")
    .select("id", { count: "exact", head: true })
    .eq("active", true)
    .eq("tier", 2);

  const { count: totalActive } = await supabase
    .from("tracked_wallets")
    .select("id", { count: "exact", head: true })
    .eq("active", true);

  console.log(`─── RAW SIGNALS ───`);
  console.log(`  All signals (BUY+SELL):          ${allSignals}`);
  console.log(`  BUY signals:                     ${buySignals}`);
  console.log(`  BUY + rug_check_passed:          ${buyRugPassed}`);
  console.log(`  Rate:                            ${((buyRugPassed || 0) / HOURS).toFixed(1)} valid BUY signals/hour\n`);

  console.log(`─── ENTRIES (trades) ───`);
  console.log(`  Total trades opened:             ${trades}`);
  console.log(`  [LIVE]-tagged (buy landed):      ${liveTrades}`);
  console.log(`  status=failed (buy missed):      ${failedTrades}`);
  console.log(`  Rate:                            ${((trades || 0) / HOURS).toFixed(1)} entries/hour\n`);

  console.log(`─── FUNNEL CONVERSION ───`);
  const signalToEntry = buyRugPassed && (trades || 0) > 0
    ? (((trades || 0) / buyRugPassed) * 100).toFixed(1)
    : "0";
  console.log(`  BUY signal → entry:              ${signalToEntry}%`);
  console.log(`  Entry → LIVE:                    ${trades && (liveTrades || 0) > 0 ? (((liveTrades || 0) / trades) * 100).toFixed(1) : "0"}%`);

  console.log(`\n─── WALLET POOL ───`);
  console.log(`  Total active wallets:            ${totalActive}`);
  console.log(`  T1 (solo-buy trigger):           ${t1Count}`);
  console.log(`  T2 (needs T1 confirmer):         ${t2Count}`);
  console.log(`  Other (not tiered):              ${(totalActive ?? 0) - (t1Count ?? 0) - (t2Count ?? 0)}`);

  // 4. Rejection reason breakdown from log
  try {
    const log = readFileSync("/tmp/pixiubot.log", "utf8");
    const lines = log.split("\n");
    const validatorRejects = new Map<string, number>();
    const scoutRejects = new Map<string, number>();
    const executorSkips = new Map<string, number>();
    const rugStormBlocks = lines.filter(l => l.includes("rug storm active")).length;

    for (const line of lines) {
      if (line.includes("[VALIDATOR]") && line.includes("❌")) {
        const m = line.match(/❌ .+? — (.+)$/);
        if (m) {
          const reason = m[1].trim().split(" (")[0];
          validatorRejects.set(reason, (validatorRejects.get(reason) || 0) + 1);
        }
      } else if (line.includes("[SCOUT]") && line.includes("❌")) {
        const m = line.match(/❌ .+? — (.+)$/);
        if (m) {
          const reason = m[1].trim().split(" (")[0];
          scoutRejects.set(reason, (scoutRejects.get(reason) || 0) + 1);
        }
      } else if (line.includes("[FILTER]") && line.includes("Blocked")) {
        const m = line.match(/Blocked (.+?):/);
        if (m) {
          scoutRejects.set(m[1], (scoutRejects.get(m[1]) || 0) + 1);
        }
      }
    }

    console.log(`\n─── REJECTIONS (from current /tmp/pixiubot.log) ───`);
    console.log(`  Rug storm blocks (total):        ${rugStormBlocks}`);
    console.log(`\n  Validator rejects by reason:`);
    const vSorted = [...validatorRejects.entries()].sort((a, b) => b[1] - a[1]);
    for (const [r, n] of vSorted.slice(0, 10)) console.log(`    ${n.toString().padStart(4)} × ${r}`);
    console.log(`\n  Scout/filter rejects by reason:`);
    const sSorted = [...scoutRejects.entries()].sort((a, b) => b[1] - a[1]);
    for (const [r, n] of sSorted.slice(0, 10)) console.log(`    ${n.toString().padStart(4)} × ${r}`);
  } catch (e: any) {
    console.log(`\n(log file unavailable: ${e.message})`);
  }

  // 5. Current thresholds
  console.log(`\n─── CURRENT THRESHOLDS ───`);
  console.log(`  Min wallet confirmation:         1 × T1 (solo-buy enabled since Sprint 5)`);
  console.log(`  Address cooldown:                120 min`);
  console.log(`  Name cooldown:                   120 min`);
  console.log(`  Bundle threshold:                80% from 1 wallet (min 3 sigs)`);
  console.log(`  Signal window for bundle:        30 min`);
  console.log(`  Max gap (signal age):            30 min`);
  console.log(`  Rug storm trigger:               3/5 losses in 2h`);
  console.log(`  Rug storm pause:                 30 min`);
}

main().catch(console.error);
