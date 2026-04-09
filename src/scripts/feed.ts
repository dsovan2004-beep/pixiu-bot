/**
 * PixiuBot — Passive Wallet Observer (Sprint 1)
 * Usage: npx ts-node src/scripts/feed.ts
 *
 * Uses Helius Enhanced Transactions API to monitor tracked wallets.
 * Filters for Pump.fun and Raydium DEX swaps (meme coins only).
 * Validates via RugCheck.xyz before logging signals.
 * Does NOT execute any trades.
 */

import supabase from "../lib/supabase-server";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_API_KEY) {
  throw new Error("Missing HELIUS_API_KEY in .env.local");
}

const HELIUS_API_URL = `https://api.helius.xyz/v0`;
const POLL_INTERVAL_MS = 5_000;

// Known DEX program IDs for meme coin filtering
const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAYDIUM_CPMM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

// Native SOL and common stablecoins to ignore
const IGNORE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // Wrapped SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

// Track last seen signature per wallet to avoid duplicates
const lastSeenSignature = new Map<string, string>();

// ─── Helius Enhanced Transactions API ────────────────────

interface HeliusTransaction {
  signature: string;
  timestamp: number;
  type: string;
  source: string;
  description: string;
  tokenTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    fromTokenAccount: string;
    toTokenAccount: string;
    tokenAmount: number;
    mint: string;
    tokenStandard: string;
  }>;
  nativeTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  accountData: Array<{
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: Array<{
      userAccount: string;
      tokenAccount: string;
      rawTokenAmount: {
        tokenAmount: string;
        decimals: number;
      };
      mint: string;
    }>;
  }>;
}

async function getEnhancedTransactions(
  walletAddress: string,
  limit = 10
): Promise<HeliusTransaction[]> {
  const url = `${HELIUS_API_URL}/addresses/${walletAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=${limit}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Helius API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

// ─── RugCheck.xyz Validation ─────────────────────────────

interface RugCheckResult {
  passed: boolean;
  tokenName: string | null;
  risks: string[];
}

async function checkRug(mint: string): Promise<RugCheckResult> {
  try {
    const url = `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`;
    const response = await fetch(url);

    if (!response.ok) {
      return { passed: false, tokenName: null, risks: ["API error"] };
    }

    const data = await response.json();

    // Check for honeypot and LP lock status
    const isHoneypot = data.risks?.some(
      (r: any) => r.name?.toLowerCase().includes("honeypot")
    ) ?? false;

    const lpUnlocked = data.risks?.some(
      (r: any) =>
        r.name?.toLowerCase().includes("lp unlocked") ||
        r.name?.toLowerCase().includes("liquidity unlocked")
    ) ?? false;

    const passed = !isHoneypot && !lpUnlocked;

    return {
      passed,
      tokenName: data.tokenMeta?.name || data.tokenMeta?.symbol || null,
      risks: data.risks?.map((r: any) => r.name) || [],
    };
  } catch (err: any) {
    console.error(`  [RUGCHECK] Error for ${mint.slice(0, 8)}...: ${err.message}`);
    return { passed: false, tokenName: null, risks: ["fetch error"] };
  }
}

// ─── DEX Buy Detection ──────────────────────────────────

interface DetectedSignal {
  coin_address: string;
  coin_name: string | null;
  wallet_tag: string;
  entry_mc: number | null;
  rug_check_passed: boolean;
  price_gap_minutes: number | null;
}

function isMemeSwap(tx: HeliusTransaction): boolean {
  // Check if transaction source is from known DEX programs
  const dexSources = ["PUMP_FUN", "RAYDIUM", "JUPITER"];
  if (dexSources.some((s) => tx.source?.toUpperCase().includes(s))) {
    return true;
  }

  // Check type — SWAP is the key indicator
  if (tx.type === "SWAP") {
    return true;
  }

  return false;
}

function extractBuyMints(
  tx: HeliusTransaction,
  walletAddress: string
): string[] {
  const mints: string[] = [];

  // From token transfers: wallet received tokens (buy)
  for (const transfer of tx.tokenTransfers || []) {
    if (
      transfer.toUserAccount === walletAddress &&
      transfer.tokenAmount > 0 &&
      !IGNORE_MINTS.has(transfer.mint)
    ) {
      mints.push(transfer.mint);
    }
  }

  // Fallback: check token balance changes
  if (mints.length === 0) {
    for (const account of tx.accountData || []) {
      for (const change of account.tokenBalanceChanges || []) {
        const amount = Number(change.rawTokenAmount?.tokenAmount || 0);
        if (
          change.userAccount === walletAddress &&
          amount > 0 &&
          !IGNORE_MINTS.has(change.mint)
        ) {
          mints.push(change.mint);
        }
      }
    }
  }

  // Deduplicate
  return [...new Set(mints)];
}

// ─── Wallet Polling ──────────────────────────────────────

async function pollWallet(
  walletAddress: string,
  tag: string
): Promise<DetectedSignal[]> {
  const txs = await getEnhancedTransactions(walletAddress, 10);

  if (txs.length === 0) return [];

  const lastSeen = lastSeenSignature.get(walletAddress);

  // Filter to new transactions only
  let newTxs: HeliusTransaction[];
  if (lastSeen) {
    const lastIdx = txs.findIndex((tx) => tx.signature === lastSeen);
    newTxs = lastIdx > 0 ? txs.slice(0, lastIdx) : [];
  } else {
    // First run: only check the most recent transaction
    newTxs = txs.slice(0, 1);
  }

  // Update last seen
  if (txs.length > 0) {
    lastSeenSignature.set(walletAddress, txs[0].signature);
  }

  if (newTxs.length === 0) return [];

  const allSignals: DetectedSignal[] = [];

  for (const tx of newTxs) {
    // Only process DEX swaps (Pump.fun, Raydium, Jupiter)
    if (!isMemeSwap(tx)) continue;

    // Extract bought token mints
    const buyMints = extractBuyMints(tx, walletAddress);
    if (buyMints.length === 0) continue;

    for (const mint of buyMints) {
      // Run rug check
      const rugResult = await checkRug(mint);

      // Only log signals that pass rug check
      if (!rugResult.passed) {
        console.log(
          `  [SKIP] ${tag} bought ${mint.slice(0, 8)}... — failed rug check: ${rugResult.risks.join(", ")}`
        );
        continue;
      }

      // Calculate time gap from signal detection
      const signalTime = new Date(tx.timestamp * 1000);
      const now = new Date();
      const gapMinutes = Math.round(
        (now.getTime() - signalTime.getTime()) / 60_000
      );

      allSignals.push({
        coin_address: mint,
        coin_name: rugResult.tokenName,
        wallet_tag: tag,
        entry_mc: null, // Would need DexScreener API for market cap
        rug_check_passed: true,
        price_gap_minutes: gapMinutes,
      });
    }
  }

  return allSignals;
}

// ─── Main Loop ───────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Passive Wallet Observer (Sprint 1)");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Mode:     OBSERVE ONLY — zero trades executed`);
  console.log(`  RPC:      Helius Enhanced Transactions API`);
  console.log(`  Filter:   Pump.fun + Raydium + Jupiter swaps only`);
  console.log(`  Validate: RugCheck.xyz (LP locked, no honeypot)`);
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
      return; // Silent — no spam when no wallets
    }

    for (const wallet of wallets) {
      try {
        const signals = await pollWallet(wallet.wallet_address, wallet.tag);

        for (const signal of signals) {
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
              `  [SIGNAL] ${signal.wallet_tag} bought ${signal.coin_name || signal.coin_address.slice(0, 8) + "..."} ✓ rug check passed (gap: ${signal.price_gap_minutes}min)`
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
