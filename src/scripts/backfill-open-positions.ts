/**
 * One-off: backfill entry_sol_cost for any currently-OPEN LIVE position
 * whose buy happened under the pre-ALT-fix code path and left
 * entry_sol_cost null.
 *
 * Uses the same sig-discovery approach as backfill-real-pnl.ts but
 * scoped to status=open trades only. Safe — read-only except for the
 * narrow UPDATE to buy_tx_sig + entry_sol_cost on matched rows.
 */

import "../lib/supabase-server";
import supabase from "../lib/supabase-server";

const WALLET = "ESK3r8n5jhaLn9Few59QKNJ5UMeD9iqZ5p1rbU9euvey";
const HELIUS_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

async function rpc<T = any>(method: string, params: any[]): Promise<T | null> {
  const backoffs = [500, 2000, 5000];
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      });
      if (res.status === 429 && attempt < backoffs.length) {
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
        continue;
      }
      const j = await res.json();
      if (j.error) return null;
      return j.result ?? null;
    } catch {
      if (attempt < backoffs.length) {
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
        continue;
      }
      return null;
    }
  }
  return null;
}

(async () => {
  const { data: opens } = await supabase
    .from("trades")
    .select("id, coin_name, coin_address, entry_time, buy_tx_sig, entry_sol_cost")
    .eq("status", "open")
    .like("wallet_tag", "%[LIVE]%")
    .or("entry_sol_cost.is.null,buy_tx_sig.is.null");

  const rows = opens ?? [];
  if (rows.length === 0) {
    console.log("No open LIVE positions missing entry_sol_cost.");
    return;
  }

  console.log(`Found ${rows.length} open LIVE position(s) to backfill:\n`);

  for (const r of rows) {
    console.log(`  ${r.coin_name} (${r.coin_address.slice(0, 8)}...)`);
    const entryUnix = Math.floor(new Date(r.entry_time).getTime() / 1000);
    const windowStart = entryUnix - 60;   // 1min before
    const windowEnd = entryUnix + 300;    // 5min after

    // Paginate sigs in window
    const sigs: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const params: any[] = [WALLET, { limit: 100, ...(before ? { before } : {}) }];
      const batch: any[] | null = await rpc("getSignaturesForAddress", params);
      if (!batch || batch.length === 0) break;
      let crossed = false;
      for (const entry of batch) {
        const t = entry.blockTime ?? 0;
        if (t > windowEnd) continue;
        if (t < windowStart) { crossed = true; break; }
        if (entry.err) continue;
        sigs.push(entry.signature);
      }
      if (crossed) break;
      before = batch[batch.length - 1].signature;
      await new Promise((r) => setTimeout(r, 100));
    }

    // Find the buy tx: wallet's SOL delta negative AND wallet gained the mint
    let matchedSig: string | null = null;
    let solDelta: number | null = null;
    for (const sig of sigs) {
      const tx: any = await rpc("getTransaction", [sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      await new Promise((r) => setTimeout(r, 100));
      if (!tx || !tx.meta || tx.meta.err) continue;
      const pre = tx.meta.preBalances?.[0];
      const post = tx.meta.postBalances?.[0];
      if (pre == null || post == null) continue;
      const delta = (post - pre) / 1e9;
      if (delta >= 0) continue; // not a spend
      // check mint involvement
      const preTok = tx.meta.preTokenBalances ?? [];
      const postTok = tx.meta.postTokenBalances ?? [];
      const walletHasMint = (bal: any[]) =>
        bal.some((b: any) => b.mint === r.coin_address && (b.owner === WALLET));
      if (walletHasMint(postTok) && !walletHasMint(preTok)) {
        matchedSig = sig;
        solDelta = delta;
        break;
      }
      // Also handle case where wallet already had the ATA (ownership pre+post)
      const postBal = postTok.find((b: any) => b.mint === r.coin_address && b.owner === WALLET);
      const preBal = preTok.find((b: any) => b.mint === r.coin_address && b.owner === WALLET);
      const preAmt = preBal ? Number(preBal.uiTokenAmount?.uiAmount ?? 0) : 0;
      const postAmt = postBal ? Number(postBal.uiTokenAmount?.uiAmount ?? 0) : 0;
      if (postAmt > preAmt) {
        matchedSig = sig;
        solDelta = delta;
        break;
      }
    }

    if (!matchedSig || solDelta === null) {
      console.log(`    ❌ no buy tx found in window`);
      continue;
    }
    const cost = Math.abs(solDelta);
    console.log(`    ✅ ${matchedSig.slice(0, 16)}...  entry cost ${cost.toFixed(6)} SOL`);
    const { error } = await supabase
      .from("trades")
      .update({ buy_tx_sig: matchedSig, entry_sol_cost: cost })
      .eq("id", r.id);
    if (error) console.log(`    WRITE failed: ${error.message}`);
    else console.log(`    written to DB`);
  }
})();
