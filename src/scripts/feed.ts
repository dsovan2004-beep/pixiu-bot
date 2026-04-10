/**
 * PixiuBot — Passive Wallet Observer (Sprint 1.1)
 * Usage: npx tsx src/scripts/feed.ts
 *
 * Uses Helius Enhanced Transactions API to monitor tracked wallets.
 * Filters for Pump.fun and Raydium DEX swaps (meme coins only).
 * Validates via RugCheck.xyz before logging signals.
 * Rate-limited: batches of 5, 200ms between batches, exponential backoff on 429.
 * Does NOT execute any trades.
 */

import supabase from "../lib/supabase-server";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_API_KEY) {
  throw new Error("Missing HELIUS_API_KEY in .env.local");
}

const HELIUS_API_URL = `https://api.helius.xyz/v0`;
const POLL_INTERVAL_MS = 15_000; // 15s between full cycles (718 wallets takes ~30s)
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 200;
const MAX_RETRIES = 3;
const MAX_REQUESTS_PER_SEC = 8;

// Native SOL and common stablecoins to ignore
const IGNORE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

// Track last seen signature per wallet
const lastSeenSignature = new Map<string, string>();

// ─── Rate Limiter ────────────────────────────────────────

class RateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRate: number; // tokens per ms
  private lastRefill: number;

  constructor(maxPerSecond: number) {
    this.maxTokens = maxPerSecond;
    this.tokens = maxPerSecond;
    this.refillRate = maxPerSecond / 1000;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
      await sleep(waitMs);
      this.refill();
    }
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

const rateLimiter = new RateLimiter(MAX_REQUESTS_PER_SEC);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  await rateLimiter.acquire();

  const url = `${HELIUS_API_URL}/addresses/${walletAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=${limit}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url);

    if (response.ok) {
      return response.json();
    }

    if (response.status === 429) {
      const backoffMs = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs);
        await rateLimiter.acquire();
        continue;
      }
    }

    throw new Error(`Helius API error: ${response.status} ${response.statusText}`);
  }

  throw new Error("Helius API: max retries exceeded");
}

// ─── RugCheck.xyz Validation ─────────────────────────────

interface RugCheckResult {
  passed: boolean;
  tokenName: string | null;
  risks: string[];
}

async function checkRug(mint: string): Promise<RugCheckResult> {
  try {
    await rateLimiter.acquire();
    const url = `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`;
    const response = await fetch(url);

    if (!response.ok) {
      return { passed: false, tokenName: null, risks: ["API error"] };
    }

    const data = await response.json();

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
  const dexSources = ["PUMP_FUN", "RAYDIUM", "JUPITER"];
  if (dexSources.some((s) => tx.source?.toUpperCase().includes(s))) {
    return true;
  }
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

  for (const transfer of tx.tokenTransfers || []) {
    if (
      transfer.toUserAccount === walletAddress &&
      transfer.tokenAmount > 0 &&
      !IGNORE_MINTS.has(transfer.mint)
    ) {
      mints.push(transfer.mint);
    }
  }

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

  return [...new Set(mints)];
}

// ─── Wallet Polling ──────────────────────────────────────

async function pollWallet(
  walletAddress: string,
  tag: string
): Promise<DetectedSignal[]> {
  const txs = await getEnhancedTransactions(walletAddress, 5);

  if (txs.length === 0) return [];

  const lastSeen = lastSeenSignature.get(walletAddress);

  let newTxs: HeliusTransaction[];
  if (lastSeen) {
    const lastIdx = txs.findIndex((tx) => tx.signature === lastSeen);
    newTxs = lastIdx > 0 ? txs.slice(0, lastIdx) : [];
  } else {
    newTxs = txs.slice(0, 1);
  }

  if (txs.length > 0) {
    lastSeenSignature.set(walletAddress, txs[0].signature);
  }

  if (newTxs.length === 0) return [];

  const allSignals: DetectedSignal[] = [];

  for (const tx of newTxs) {
    if (!isMemeSwap(tx)) continue;

    const buyMints = extractBuyMints(tx, walletAddress);
    if (buyMints.length === 0) continue;

    for (const mint of buyMints) {
      const rugResult = await checkRug(mint);

      if (!rugResult.passed) {
        console.log(
          `  [SKIP] ${tag} bought ${mint.slice(0, 8)}... — failed rug check: ${rugResult.risks.join(", ")}`
        );
        continue;
      }

      const signalTime = new Date(tx.timestamp * 1000);
      const now = new Date();
      const gapMinutes = Math.round(
        (now.getTime() - signalTime.getTime()) / 60_000
      );

      allSignals.push({
        coin_address: mint,
        coin_name: rugResult.tokenName,
        wallet_tag: tag,
        entry_mc: null,
        rug_check_passed: true,
        price_gap_minutes: gapMinutes,
      });
    }
  }

  return allSignals;
}

// ─── Batched Tick ────────────────────────────────────────

async function tick(): Promise<void> {
  const { data: wallets, error } = await supabase
    .from("tracked_wallets")
    .select("*")
    .eq("active", true);

  if (error) {
    console.error("  [ERROR] Failed to fetch wallets:", error.message);
    return;
  }

  if (!wallets || wallets.length === 0) return;

  const totalBatches = Math.ceil(wallets.length / BATCH_SIZE);
  const startTime = Date.now();
  let signalCount = 0;
  let errorCount = 0;

  console.log(`  [CYCLE] Polling ${wallets.length} wallets in ${totalBatches} batches...`);

  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batch = wallets.slice(i, i + BATCH_SIZE);

    // Log progress every 50 wallets
    if (i > 0 && i % 50 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `  [INFO] Batch ${batchNum}/${totalBatches} (${i}/${wallets.length} wallets, ${elapsed}s elapsed, ${signalCount} signals, ${errorCount} errors)`
      );
    }

    // Process batch concurrently
    const results = await Promise.allSettled(
      batch.map(async (wallet) => {
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
            signalCount++;
            console.log(
              `  [SIGNAL] ${signal.wallet_tag} bought ${signal.coin_name || signal.coin_address.slice(0, 8) + "..."} ✓ (gap: ${signal.price_gap_minutes}min)`
            );
          }
        }
      })
    );

    // Count errors
    for (const r of results) {
      if (r.status === "rejected") errorCount++;
    }

    // Delay between batches
    if (i + BATCH_SIZE < wallets.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `  [CYCLE] Done in ${totalTime}s — ${signalCount} signals, ${errorCount} errors`
  );
}

// ─── Main Loop ───────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Passive Wallet Observer (Sprint 1.1)");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Mode:       OBSERVE ONLY — zero trades executed`);
  console.log(`  RPC:        Helius Enhanced Transactions API`);
  console.log(`  Filter:     Pump.fun + Raydium + Jupiter swaps only`);
  console.log(`  Validate:   RugCheck.xyz (LP locked, no honeypot)`);
  console.log(`  Rate limit: ${MAX_REQUESTS_PER_SEC} req/s, batches of ${BATCH_SIZE}, ${BATCH_DELAY_MS}ms delay`);
  console.log(`  Polling:    Every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`  Started:    ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Update bot state to running
  await supabase
    .from("bot_state")
    .update({ is_running: true, last_updated: new Date().toISOString() })
    .eq("mode", "observe");

  // Run immediately
  await tick();

  // Then on interval
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
