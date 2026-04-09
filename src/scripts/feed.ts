/**
 * PixiuBot — Passive Wallet Observer (Sprint 0)
 * Usage: npx ts-node src/scripts/feed.ts
 *
 * Monitors tracked wallets via Helius RPC for new buy transactions.
 * Logs detected signals to coin_signals table.
 * Does NOT execute any trades.
 */

import supabase from "../lib/supabase-server";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "YOUR_HELIUS_API_KEY";
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const POLL_INTERVAL_MS = 5_000;

// Track last seen signature per wallet to avoid duplicate processing
const lastSeenSignature = new Map<string, string>();

// ─── Helius RPC Helpers ──────────────────────────────────

async function getRecentTransactions(
  walletAddress: string,
  limit = 10
): Promise<any[]> {
  const response = await fetch(HELIUS_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: [walletAddress, { limit }],
    }),
  });

  const data = await response.json();
  return data.result || [];
}

async function getTransactionDetails(signature: string): Promise<any | null> {
  const response = await fetch(HELIUS_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
    }),
  });

  const data = await response.json();
  return data.result || null;
}

// ─── Signal Detection ────────────────────────────────────

interface DetectedSignal {
  coin_address: string;
  coin_name: string | null;
  wallet_tag: string;
  entry_mc: number | null;
  rug_check_passed: boolean | null;
  price_gap_minutes: number | null;
}

function extractBuySignals(tx: any, walletTag: string): DetectedSignal[] {
  const signals: DetectedSignal[] = [];

  if (!tx?.meta?.postTokenBalances || !tx?.meta?.preTokenBalances) {
    return signals;
  }

  const preBalances = tx.meta.preTokenBalances;
  const postBalances = tx.meta.postTokenBalances;

  // Detect token balance increases (buy signals)
  for (const post of postBalances) {
    const pre = preBalances.find(
      (p: any) =>
        p.accountIndex === post.accountIndex && p.mint === post.mint
    );

    const preAmount = pre?.uiTokenAmount?.uiAmount || 0;
    const postAmount = post?.uiTokenAmount?.uiAmount || 0;

    if (postAmount > preAmount && post.mint) {
      signals.push({
        coin_address: post.mint,
        coin_name: null, // Would resolve via Jupiter metadata in future sprint
        wallet_tag: walletTag,
        entry_mc: null, // Would fetch from Jupiter/DexScreener in future sprint
        rug_check_passed: null, // Would run rug check in future sprint
        price_gap_minutes: null,
      });
    }
  }

  return signals;
}

// ─── Wallet Polling ──────────────────────────────────────

async function pollWallet(
  walletAddress: string,
  tag: string
): Promise<DetectedSignal[]> {
  const txs = await getRecentTransactions(walletAddress, 5);

  if (txs.length === 0) return [];

  const lastSeen = lastSeenSignature.get(walletAddress);
  const newTxs = lastSeen
    ? txs.filter((tx: any) => tx.signature !== lastSeen)
    : txs.slice(0, 1); // On first run, only check most recent

  if (txs.length > 0) {
    lastSeenSignature.set(walletAddress, txs[0].signature);
  }

  const allSignals: DetectedSignal[] = [];

  for (const txInfo of newTxs) {
    if (txInfo.err) continue; // skip failed transactions

    const details = await getTransactionDetails(txInfo.signature);
    if (!details) continue;

    const signals = extractBuySignals(details, tag);
    allSignals.push(...signals);
  }

  return allSignals;
}

// ─── Main Loop ───────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Passive Wallet Observer (Sprint 0)");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Mode:     OBSERVE ONLY — zero trades executed`);
  console.log(`  RPC:      Helius Mainnet`);
  console.log(`  Polling:  Every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`  Started:  ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Update bot state to running
  await supabase
    .from("bot_state")
    .update({ is_running: true, last_updated: new Date().toISOString() })
    .eq("mode", "observe");

  async function tick(): Promise<void> {
    // Fetch active wallets
    const { data: wallets, error } = await supabase
      .from("tracked_wallets")
      .select("*")
      .eq("active", true);

    if (error) {
      console.error("  [ERROR] Failed to fetch wallets:", error.message);
      return;
    }

    if (!wallets || wallets.length === 0) {
      console.log("  [INFO] No active wallets to monitor.");
      return;
    }

    for (const wallet of wallets) {
      try {
        const signals = await pollWallet(wallet.wallet_address, wallet.tag);

        for (const signal of signals) {
          // Log to coin_signals table
          const { error: insertError } = await supabase
            .from("coin_signals")
            .insert({
              coin_address: signal.coin_address,
              coin_name: signal.coin_name,
              wallet_tag: signal.wallet_tag,
              entry_mc: signal.entry_mc,
              rug_check_passed: signal.rug_check_passed,
              price_gap_minutes: signal.price_gap_minutes,
            });

          if (insertError) {
            console.error("  [ERROR] Insert signal:", insertError.message);
          } else {
            console.log(
              `  [SIGNAL] ${signal.wallet_tag} bought ${signal.coin_address.slice(0, 8)}...`
            );
          }
        }
      } catch (err: any) {
        console.error(
          `  [ERROR] Polling ${wallet.tag} (${wallet.wallet_address.slice(0, 8)}...):`,
          err.message
        );
      }
    }
  }

  // Run immediately, then on interval
  await tick();
  setInterval(tick, POLL_INTERVAL_MS);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n  [SHUTDOWN] Stopping observer...");
    await supabase
      .from("bot_state")
      .update({ is_running: false, last_updated: new Date().toISOString() })
      .eq("mode", "observe");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Feed observer failed:", err);
  process.exit(1);
});
