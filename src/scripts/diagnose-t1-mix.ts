import "../lib/supabase-server";
import supabase from "../lib/supabase-server";

const HOURS = 3;
const since = new Date(Date.now() - HOURS * 3600_000).toISOString();

(async () => {
  const { data: signals } = await supabase
    .from("coin_signals")
    .select("wallet_tag, coin_address")
    .eq("transaction_type", "BUY")
    .eq("rug_check_passed", true)
    .gte("signal_time", since);

  const { data: wallets } = await supabase
    .from("tracked_wallets")
    .select("tag, tier")
    .eq("active", true);

  const tagToTier = new Map<string, number>();
  for (const w of wallets || []) tagToTier.set(w.tag, w.tier ?? 0);

  let t1Signals = 0, t2Signals = 0, untieredSignals = 0;
  const coinToTags = new Map<string, Set<string>>();

  for (const s of signals || []) {
    const tier = tagToTier.get(s.wallet_tag);
    if (tier === 1) t1Signals++;
    else if (tier === 2) t2Signals++;
    else untieredSignals++;

    if (!coinToTags.has(s.coin_address)) coinToTags.set(s.coin_address, new Set());
    coinToTags.get(s.coin_address)!.add(s.wallet_tag);
  }

  // Count coins that had at least 1 T1 signal vs coins with only T2/untiered
  let coinsWithT1 = 0, coinsT2Only = 0, coinsSoloBuyEligible = 0;
  for (const [_coin, tags] of coinToTags) {
    let hasT1 = false;
    for (const t of tags) if (tagToTier.get(t) === 1) { hasT1 = true; break; }
    if (hasT1) coinsWithT1++;
    else coinsT2Only++;
  }

  console.log(`\n=== T1/T2 signal mix (last ${HOURS}h) ===\n`);
  console.log(`Total valid BUY signals:           ${signals?.length ?? 0}`);
  console.log(`  from T1 wallets:                 ${t1Signals}`);
  console.log(`  from T2 wallets:                 ${t2Signals}`);
  console.log(`  from untiered wallets:           ${untieredSignals}\n`);

  console.log(`Unique coin_addresses signaled:    ${coinToTags.size}`);
  console.log(`  coins with ≥1 T1 signal:         ${coinsWithT1}  (entry-eligible)`);
  console.log(`  coins with only T2/untiered:     ${coinsT2Only}  (BLOCKED by T1 gate)\n`);

  console.log(`Theoretical entry ceiling (coins with T1): ${coinsWithT1}`);
  console.log(`Actual entries last ${HOURS}h:               22`);
  console.log(`Headroom from T1 pool alone:       ${coinsWithT1 - 22} more/period`);
  console.log(`Unlock if T2 allowed solo:         +${coinsT2Only} more/period`);
})();
