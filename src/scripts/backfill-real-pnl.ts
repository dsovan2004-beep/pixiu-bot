/**
 * Sprint 9 P0 — Historical real_pnl_sol backfill
 *
 * For each pre-Sprint-9 closed LIVE trade (no tx sigs stored), discover
 * Jupiter buy/sell txs via Helius getSignaturesForAddress in the
 * entry_time → exit_time window, parse each matching tx for wallet SOL
 * delta, and write real values to the row.
 *
 * Resumable: skips trades that already have real_pnl_sol set.
 * Progressive: writes each matched trade immediately so Ctrl+C is safe.
 *
 * Expected match rate: 70-85%. Unmatched trades stay with real_pnl_sol
 * null (caller can see mark vs null for "pre-accounting-era" trades).
 *
 * Usage:
 *   npx tsx src/scripts/backfill-real-pnl.ts           # all unprocessed
 *   npx tsx src/scripts/backfill-real-pnl.ts --limit 10 # sample run
 *   npx tsx src/scripts/backfill-real-pnl.ts --dry       # report only, no DB write
 */

import "../lib/supabase-server";
import supabase from "../lib/supabase-server";

const WALLET = "ESK3r8n5jhaLn9Few59QKNJ5UMeD9iqZ5p1rbU9euvey";
const HELIUS_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

// Rate-limit knob — free tier is ~50 req/s. Be conservative.
const SLEEP_MS_BETWEEN_CALLS = 2000;  // 2s conservative for final-pass unmatchables

async function rpc<T = any>(method: string, params: any[]): Promise<T | null> {
  // Retry on rate-limit. Backoff: 1s → 3s → 10s → 20s, then give up.
  const backoffs = [1000, 3000, 10_000, 20_000];
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      });
      if (res.status === 429) {
        if (attempt < backoffs.length) {
          await new Promise((r) => setTimeout(r, backoffs[attempt]));
          continue;
        }
        return null;
      }
      const j = await res.json();
      if (j.error) {
        const msg = String(j.error.message || "");
        if (msg.toLowerCase().includes("rate limited") && attempt < backoffs.length) {
          await new Promise((r) => setTimeout(r, backoffs[attempt]));
          continue;
        }
        return null;
      }
      return j.result ?? null;
    } catch (err: any) {
      if (attempt < backoffs.length) {
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
        continue;
      }
      return null;
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Paginate getSignaturesForAddress backwards from exit_time until we cross entry_time.
async function sigsInTimeWindow(
  entryUnix: number,
  exitUnix: number
): Promise<string[]> {
  const windowStart = entryUnix - 1800; // 30min grace before entry — for stubborn unmatchables
  const windowEnd = exitUnix + 1800;    // 30min grace after exit
  const sigs: string[] = [];
  let before: string | undefined = undefined;

  for (let page = 0; page < 20; page++) {
    const params: any[] = [
      WALLET,
      { limit: 200, ...(before ? { before } : {}) },
    ];
    const batch: any[] | null = await rpc("getSignaturesForAddress", params);
    if (!batch || batch.length === 0) break;

    let crossedEntry = false;
    for (const entry of batch) {
      const t = entry.blockTime ?? 0;
      if (t > windowEnd) continue;        // future of our window; skip
      if (t < windowStart) { crossedEntry = true; break; }  // past our window; stop
      if (entry.err) continue;             // failed tx — skip
      sigs.push(entry.signature);
    }
    if (crossedEntry) break;
    before = batch[batch.length - 1].signature;
    await sleep(SLEEP_MS_BETWEEN_CALLS);
  }

  return sigs;
}

interface TxMatch {
  sig: string;
  solDelta: number;      // wallet's SOL change (negative = spent, positive = received)
  involvesMint: boolean;
  tokenBalanceChange: number; // wallet's change in the target mint's balance
}

async function analyzeTx(sig: string, mint: string): Promise<TxMatch | null> {
  const tx: any = await rpc("getTransaction", [
    sig,
    { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
  ]);
  if (!tx || !tx.meta || tx.meta.err) return null;

  const accountKeys: string[] = (tx.transaction?.message?.accountKeys ?? []).map((k: any) =>
    typeof k === "string" ? k : k.pubkey ?? String(k)
  );
  const walletIdx = accountKeys.indexOf(WALLET);
  if (walletIdx < 0) return null;

  const pre = tx.meta.preBalances?.[walletIdx];
  const post = tx.meta.postBalances?.[walletIdx];
  if (pre == null || post == null) return null;
  const solDelta = (post - pre) / 1e9;

  // Sum wallet's token balance change for the target mint across pre/post.
  // Precedence fix: mint must match AND (accountIndex === wallet OR owner === wallet)
  const walletOwnsEntry = (b: any) =>
    b.mint === mint &&
    (b.owner === WALLET || accountKeys[b.accountIndex] === WALLET);
  const preTok = (tx.meta.preTokenBalances ?? []).filter(walletOwnsEntry);
  const postTok = (tx.meta.postTokenBalances ?? []).filter(walletOwnsEntry);
  const preAmount = preTok.reduce((s: number, b: any) => s + Number(b.uiTokenAmount?.uiAmount ?? 0), 0);
  const postAmount = postTok.reduce((s: number, b: any) => s + Number(b.uiTokenAmount?.uiAmount ?? 0), 0);
  const tokenBalanceChange = postAmount - preAmount;

  const involvesMint = tokenBalanceChange !== 0 ||
    (tx.meta.preTokenBalances ?? []).some((b: any) => b.mint === mint) ||
    (tx.meta.postTokenBalances ?? []).some((b: any) => b.mint === mint);

  return { sig, solDelta, involvesMint, tokenBalanceChange };
}

async function processTrade(trade: any, dry: boolean): Promise<string> {
  const entryUnix = Math.floor(new Date(trade.entry_time).getTime() / 1000);
  const exitUnix = Math.floor(new Date(trade.exit_time).getTime() / 1000);
  const sigs = await sigsInTimeWindow(entryUnix, exitUnix);

  const buys: TxMatch[] = [];
  const sells: TxMatch[] = [];
  for (const sig of sigs) {
    const m = await analyzeTx(sig, trade.coin_address);
    await sleep(SLEEP_MS_BETWEEN_CALLS);
    if (!m || !m.involvesMint) continue;
    // Jupiter can route through intermediate WSOL accounts, making the
    // wallet's direct SOL delta small or noisy. Rely primarily on token
    // delta sign + use solDelta magnitude as the economic measure.
    // Buy: wallet gained the target token (regardless of SOL delta sign — could be tiny from fees only)
    if (m.tokenBalanceChange > 0) buys.push(m);
    // Sell: wallet lost the target token
    else if (m.tokenBalanceChange < 0) sells.push(m);
  }

  if (buys.length === 0) {
    // Buy never landed on-chain. Bot marked [LIVE] but the tx expired/failed.
    // Zero economic outcome — no real SOL moved for this trade.
    if (!dry) {
      await supabase.from("trades").update({
        buy_tx_sig: "NEVER_LANDED",
        entry_sol_cost: 0,
        real_pnl_sol: 0,
      }).eq("id", trade.id);
    }
    return `never_landed → 0 SOL (buy tx never found in ±30min window)`;
  }
  const buy = buys[0];
  const entryCost = Math.abs(buy.solDelta);
  if (sells.length === 0) {
    // Bought but never sold on-chain — full loss of entry cost
    const realPnl = -entryCost;
    if (!dry) {
      await supabase.from("trades").update({
        buy_tx_sig: buy.sig,
        entry_sol_cost: entryCost,
        sell_tx_sig: "SELL_NEVER_LANDED",
        real_pnl_sol: realPnl,
      }).eq("id", trade.id);
    }
    return `no_sell → real ${realPnl.toFixed(4)} SOL (buy landed, sell never did)`;
  }
  const sellReceived = sells.reduce((s, x) => s + x.solDelta, 0);
  const realPnl = sellReceived - entryCost;
  const lastSell = sells[sells.length - 1];

  if (!dry) {
    await supabase.from("trades").update({
      buy_tx_sig: buy.sig,
      entry_sol_cost: entryCost,
      sell_tx_sig: lastSell.sig,
      real_pnl_sol: realPnl,
    }).eq("id", trade.id);
  }

  const markPct = Number(trade.pnl_pct);
  const realPct = (realPnl / entryCost) * 100;
  const divergence = markPct - realPct;
  return `entry ${entryCost.toFixed(4)} → sells ${sellReceived.toFixed(4)} = ${realPnl.toFixed(4)} SOL (real ${realPct.toFixed(1)}%, mark ${markPct.toFixed(1)}%, div ${divergence.toFixed(1)}pp)`;
}

(async () => {
  const args = process.argv.slice(2);
  const limitArg = args.indexOf("--limit");
  const limit = limitArg >= 0 ? parseInt(args[limitArg + 1]) : 0;
  const dry = args.includes("--dry");

  if (!HELIUS_KEY) {
    console.error("HELIUS_API_KEY not set");
    process.exit(1);
  }

  console.log(`Backfill starting. dry=${dry}, limit=${limit || "all"}, wallet=${WALLET.slice(0,8)}...`);

  // Find LIVE closed trades with real_pnl_sol still null
  let q = supabase
    .from("trades")
    .select("id, coin_name, coin_address, entry_time, exit_time, pnl_pct")
    .eq("status", "closed")
    .like("wallet_tag", "%[LIVE]%")
    .is("real_pnl_sol", null)
    .order("entry_time", { ascending: true });
  if (limit > 0) q = q.limit(limit);
  const { data: pending } = await q;
  const trades = pending ?? [];
  console.log(`${trades.length} trades to backfill.\n`);

  let matched = 0;
  let unmatched = 0;
  let idx = 0;
  for (const t of trades) {
    idx++;
    const label = `${String(idx).padStart(3)}/${trades.length}  ${String(t.coin_name || "").slice(0, 22).padEnd(22)}`;
    try {
      const result = await processTrade(t, dry);
      if (result.startsWith("no_buy")) {
        unmatched++;
        console.log(`  ${label}  ❌ ${result}`);
      } else {
        matched++;
        console.log(`  ${label}  ✅ ${result}`);
      }
    } catch (err: any) {
      unmatched++;
      console.log(`  ${label}  ⚠️  ERROR: ${err.message}`);
    }
  }

  console.log(`\nDone. matched=${matched} unmatched=${unmatched} total=${trades.length}`);
  console.log(`Match rate: ${trades.length ? (matched / trades.length * 100).toFixed(1) : 0}%`);
  if (dry) console.log("(--dry mode: no DB writes performed)");
})();
