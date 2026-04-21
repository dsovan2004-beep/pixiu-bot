/**
 * PixiuBot — Jupiter Swap Integration
 *
 * Real on-chain swaps via Jupiter V6 aggregator.
 * Supports both mainnet (Helius RPC) and devnet.
 *
 * LIVE_TRADING must be true in .env.local to execute.
 * PHANTOM_PRIVATE_KEY must be set (base58 encoded).
 * SOLANA_NETWORK = 'devnet' | 'mainnet-beta' (default: mainnet-beta)
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_QUOTE_URL = "https://api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_URL = "https://api.jup.ag/swap/v1/swap";

// P0b: when sellToken() bails on Jupiter 6024 (token has transfer fee /
// un-sellable), record the mint here so callers can distinguish a
// "Jupiter truly cannot route this" failure from a transient
// rate-limit / network / slippage failure. Risk-guard reads this to
// decide between mark-to-zero (unsellable) vs revert-and-retry (other).
const unsellableMints = new Set<string>();

export function wasLastSellUnsellable(mint: string): boolean {
  const was = unsellableMints.has(mint);
  unsellableMints.delete(mint); // read-once
  return was;
}
const BUY_SLIPPAGE_BPS = 1000; // 10% for buys — pump.fun tokens need higher
const SELL_SLIPPAGE_BPS = [500, 1000, 2000, 3000]; // Grid TP ladder: 5→10→20→30% on retry

// Sprint 10 Phase 6 — rescue-class exits start at aggressive slippage.
// hehehe (Apr 21 9pm UTC): holder_rug triggered at +87% mark with 67%
// sim recovery. skipJito submit was fast (~2s), but the 5% slippage
// first attempt timed out on confirmation. While cycling 5→10→20→30%
// (each ~60-120s of confirmation wait + retries), price crashed −38%
// from the trigger point. We NEED the sell to land on first attempt,
// not cycle through ladder rungs that are likely to expire on a
// pool already flagged as thin by the trigger itself.
//
// Rescue classes (CB, SL, trailing_stop, holder_rug, pool_drain,
// timeout, whale_exit) all fire when we have strong reason to believe
// the pool is in trouble. Starting at 20% slippage + retrying at 30%
// trades 1-3% of theoretical fill for much higher probability of
// landing on the first attempt. The sim gate at 30% floor still
// catches genuine catastrophic-drain cases separately.
const SELL_SLIPPAGE_BPS_RESCUE = [2000, 3000]; // 20% → 30%
const RESCUE_EXIT_REASONS = new Set([
  "whale_exit",
  "circuit_breaker",
  "stop_loss",
  "trailing_stop",
  "timeout",
  "holder_rug",
  "pool_drain",
]);

// Sprint 10 Phase 1 (Apr 18 PM) — Jito tip on every swap.
// 0.001 SOL flat tip routed to Jito validators via prioritizationFeeLamports.
// Addresses sandwich MEV and lands us in the same block as the tx we depend
// on. Every dominant pump.fun bot (Axiom, BullX, Photon, Trojan, Banana Gun,
// BonkBot) ships tips; running without one means our txs get front-run and
// back-run during drainage windows — which is exactly what happened on
// BASED/Nintondo/Dicknald (mark diverged from real fill by 40-95pp).
// Apr 22 bump 0.001 → 0.002 SOL. Overnight run showed 100% of buys
// falling back to RPC via 429 storms across global/ny/frankfurt/
// amsterdam/tokyo. Tip was too low to compete with dominant pump.fun
// bots and bundles were getting dropped. 0.002 matches the median tip
// of the top bundlers (block-engine sampling), which should restore
// inclusion rate and eliminate the 60-180s Jito-to-RPC fallback
// timeout that ate ItsAngelCirce entirely.
const JITO_TIP_LAMPORTS = 2_000_000; // 0.002 SOL

// Jito block engine bundle endpoint (public, no auth required).
// sendBundle atomically lands the tx with the tip; getBundleStatuses
// polls landing. Falls back to public RPC on any Jito failure — we
// never want a Jito outage to block a sell.
//
// Apr 21 2026: Jito removed the API key gate — block-engine access is
// ungated for everyone. The 429s we were eating (observed on ~40-60%
// of sells under the McDino slippage ladder) are free-tier per-endpoint
// rate limits, not auth. Fix: rotate across regional endpoints so a
// 429 on one region doesn't block the submit; on the first 429 we pick
// a different region and try once more before letting the caller fall
// through to public RPC. getBundleStatuses polls the SAME endpoint that
// accepted the bundle (bundleIds are per-region).
const JITO_BUNDLE_ENDPOINTS = [
  "https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
];
let jitoEndpointCursor = 0;
function nextJitoEndpoint(): string {
  const url = JITO_BUNDLE_ENDPOINTS[jitoEndpointCursor % JITO_BUNDLE_ENDPOINTS.length];
  jitoEndpointCursor++;
  return url;
}
function jitoRegionLabel(url: string): string {
  const m = url.match(/^https:\/\/([^.]+)\./);
  if (!m) return "?";
  return m[1] === "mainnet" ? "global" : m[1];
}
const JITO_POLL_INTERVAL_MS = 2_000;
const JITO_POLL_TIMEOUT_MS = 60_000;

// Sprint 10 Phase 1 — Pre-flight simulation recovery floor.
// Before signing a sell, we simulate the tx and compare the quoted SOL
// out against the original entry cost. If recovery is below this floor
// AND the exit reason is "catastrophic loss" (whale_exit / CB / SL /
// trailing), we abort — the pool is drained and selling into it just
// realizes the dust. Grid take_profit exits bypass the floor (they're
// voluntary partial fills, not rescues).
//
// Intentionally narrow at 0.30 — catches the Dicknald-class tail
// (2.5% recovery) while letting normal −40 to −70% losses through.
// Tune after 30+ trades of real sim data.
const SELL_MIN_RECOVERY_FLOOR = 0.30;

// In-memory sim-abort tracker: mint → timestamp of last abort.
// Caller polls `wasSellSimAborted(mint)` (read-once) to distinguish a
// pool-drained abort from a transient failure. Risk-guard's existing
// closingPositions 60s lock already prevents re-fire within the same
// cycle; this just surfaces the reason for better logging / future
// cooldown decisions.
const sellSimAborts = new Map<string, number>();
export function wasSellSimAborted(mint: string): boolean {
  const t = sellSimAborts.get(mint);
  if (t == null) return false;
  sellSimAborts.delete(mint); // read-once
  return Date.now() - t < 60_000;
}

/**
 * Submit a signed VersionedTransaction via Jito block engine bundle.
 * Returns { signature, landed } on success, null on Jito-side failure
 * (the caller should fall back to public RPC in that case).
 *
 * Landing is confirmed by polling getBundleStatuses every 2s up to 60s.
 */
async function submitViaJito(
  tx: VersionedTransaction,
  label: string
): Promise<{ signature: string; landed: boolean } | null> {
  // Extract the base58 signature BEFORE any submission — we need it to
  // poll landing status regardless of which path lands the tx.
  const sigBytes = tx.signatures[0];
  if (!sigBytes || sigBytes.length === 0) {
    console.error(`  [JITO] ${label}: tx has no signature, cannot submit`);
    return null;
  }
  const signature = bs58.encode(sigBytes);

  const serialized = Buffer.from(tx.serialize()).toString("base64");

  // Submit phase: try primary endpoint; on 429, rotate to a different
  // region and retry once. Second 429 → return null (caller falls
  // through to public RPC). Non-429 non-ok, error response, or crash
  // → return null immediately.
  let endpoint = nextJitoEndpoint();
  let region = jitoRegionLabel(endpoint);
  let bundleId: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendBundle",
          params: [[serialized], { encoding: "base64" }],
        }),
      });
      if (res.status === 429) {
        console.log(`  [JITO] ${label}: sendBundle HTTP 429 via ${region}`);
        if (attempt === 0) {
          // Rotate to a different region for one retry before giving up.
          // If the round-robin cursor happens to hand us the same region,
          // bump once (array has 5 entries so we only loop once max).
          const prev = endpoint;
          endpoint = nextJitoEndpoint();
          if (endpoint === prev && JITO_BUNDLE_ENDPOINTS.length > 1) {
            endpoint = nextJitoEndpoint();
          }
          region = jitoRegionLabel(endpoint);
          console.log(`  [JITO] ${label}: retrying on ${region}`);
          continue;
        }
        return null;
      }
      if (!res.ok) {
        console.error(`  [JITO] ${label}: sendBundle HTTP ${res.status} via ${region}`);
        return null;
      }
      const json: any = await res.json();
      if (json.error) {
        console.error(`  [JITO] ${label}: sendBundle error ${JSON.stringify(json.error)} via ${region}`);
        return null;
      }
      bundleId = json.result as string;
      console.log(`  [JITO] Bundle submitted via ${region}: ${label} bundleId=${bundleId} sig=${signature.slice(0, 16)}...`);
      break;
    } catch (err: any) {
      console.error(`  [JITO] ${label}: submission crashed via ${region} ${err.message}`);
      return null;
    }
  }

  if (!bundleId) return null;

  // Poll phase: use the same endpoint that accepted the bundle —
  // Jito bundleIds are per-region and getBundleStatuses must hit the
  // origin block engine. Behavior and timeouts unchanged from before.
  const deadline = Date.now() + JITO_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, JITO_POLL_INTERVAL_MS));
    try {
      const sres = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getBundleStatuses",
          params: [[bundleId]],
        }),
      });
      if (!sres.ok) continue;
      const sjson: any = await sres.json();
      const statuses = sjson.result?.value ?? [];
      const entry = statuses[0];
      if (!entry) continue; // not found yet
      const cs = entry.confirmation_status;
      if (cs === "confirmed" || cs === "finalized") {
        if (entry.err) {
          console.error(`  [JITO] Bundle failed on-chain via ${region}: ${label} err=${JSON.stringify(entry.err)}`);
          return { signature, landed: false };
        }
        console.log(`  [JITO] Bundle landed via ${region}: ${label} ${cs} sig=${signature.slice(0, 16)}...`);
        return { signature, landed: true };
      }
    } catch {
      // transient poll failure — keep trying until deadline
    }
  }
  console.log(`  [JITO] Bundle poll timeout after ${JITO_POLL_TIMEOUT_MS / 1000}s via ${region}: ${label} — falling back to RPC check`);
  return { signature, landed: false };
}

function isDevnet(): boolean {
  return process.env.SOLANA_NETWORK === "devnet";
}

/**
 * Fetch wrapper with exponential backoff on HTTP 429 (rate limit).
 * Other errors (4xx non-429, 5xx, network) are returned immediately —
 * retry does not help those.
 *
 * Backoff schedule: 1s → 3s → 10s (max 3 retries).
 * Total worst-case added latency on pure 429s: ~14s before giving up.
 *
 * Applied to both buyToken() and sellToken() quote+swap fetches (P0a).
 * Stuck sells are worse than missed buys: a buy-side 429 costs $0 of
 * alpha; a sell-side 429 rides a dying position down with no exit.
 */
async function jupiterFetchWithBackoff(
  url: string,
  init?: RequestInit,
  label = "jupiter"
): Promise<Response> {
  const delays = [1_000, 3_000, 10_000]; // ms between retries
  let res = await fetch(url, init);

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (res.status !== 429) return res;
    const wait = delays[attempt];
    console.log(
      `  [JUPITER] 429 ${label} — retry ${attempt + 1}/${delays.length} in ${wait}ms`
    );
    await new Promise((r) => setTimeout(r, wait));
    res = await fetch(url, init);
  }

  // Exhausted retries — return the last response (still 429 here).
  // Caller handles the non-ok path unchanged.
  return res;
}

/**
 * Sprint 9 P0 — parse real SOL delta for the wallet from a confirmed tx.
 *
 * Reads pre/post SOL balances of the wallet account from tx.meta and
 * returns the net delta (positive = received, negative = spent, includes
 * fees).
 *
 * Use after a swap confirms to get the ACTUAL economic outcome, not the
 * DexScreener mid-price estimate. Returns null on any parse failure —
 * callers must fall back to the legacy pnl_pct path.
 */
export async function parseSwapSolDelta(
  signature: string
): Promise<number | null> {
  try {
    const keypair = getKeypair();
    if (!keypair) return null;
    const connection = getConnection();

    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx || !tx.meta) return null;

    // Solana guarantees the fee payer is at account index 0 of every tx.
    // Since our wallet signed this swap, WE ARE the fee payer → index 0
    // is us. Skip account-key resolution entirely — avoids the "Address
    // lookup tables not resolved" error on Jupiter v0 txs that use ALTs.
    //
    // Previous implementation tried to resolve account keys and find the
    // wallet's index. That failed on ALT-using txs (all post-2024 Jupiter
    // swaps). Index 0 is always correct for txs our wallet sent.
    const idx = 0;

    const pre = tx.meta.preBalances?.[idx];
    const post = tx.meta.postBalances?.[idx];
    if (pre == null || post == null) return null;

    // Return in SOL (not lamports). Includes network fee burden on the
    // spending side — this IS the real economic delta from the swap.
    return (post - pre) / 1e9;
  } catch (err: any) {
    console.error(`  [JUPITER] parseSwapSolDelta(${signature.slice(0, 8)}...) failed: ${err.message}`);
    return null;
  }
}

/**
 * Sprint 10 Phase 4 — liquidity drainage monitor during hold.
 *
 * Fetches our current token balance on-chain and asks Jupiter to quote
 * a sell of the current bag (at the same slippage bracket we use for
 * live sells). Returns recovery as
 *   solBack / (entrySolCost × remainingPct / 100)
 * — i.e. "what fraction of the REMAINING slice's cost basis would the
 * pool return if we sold right now". A value < ~0.4 means the pool has
 * drained since entry — we should exit before it gets worse even if
 * the DexScreener mark still reads positive.
 *
 * Apr 21 bug fix: originally divided by the full entrySolCost, so the
 * metric mechanically halved after L1 (50% sold) and quartered after
 * L2 (75% sold) regardless of pool health. Post-L1, a healthy token
 * with flat mark would show ~50% "recovery" and trip a 40% floor on
 * even small pool dips. Now properly scaled by remainingPct so a
 * healthy token always quotes ~1.0 regardless of grid level.
 *
 * Openhuman (Apr 21) is the case that motivated this: at entry the
 * pre-buy round-trip showed ~97% recovery. Eleven minutes later, at L1
 * grid trigger, Jupiter returned 6024 (pool drained) for every slippage
 * level. Bot had no way to see the drainage until it tried to sell.
 *
 * Returns null on any quote / balance failure (fail-open — transient
 * Jupiter or Helius hiccups must not force an exit).
 */
export async function simulateSellRecovery(
  coinAddress: string,
  entrySolCost: number,
  remainingPct: number = 100
): Promise<number | null> {
  try {
    if (entrySolCost <= 0) return null;
    if (remainingPct <= 0) return null;
    const keypair = getKeypair();
    if (!keypair) return null;
    const connection = getConnection();
    const balance = await getTokenBalance(connection, keypair.publicKey, coinAddress);
    if (balance <= 0) return null;

    const url = `${JUPITER_QUOTE_URL}?inputMint=${coinAddress}&outputMint=${SOL_MINT}&amount=${balance}&slippageBps=${SELL_SLIPPAGE_BPS[0]}`;
    const res = await jupiterFetchWithBackoff(url, undefined, "simSell-liquidity");
    if (!res.ok) return null;
    const json: any = await res.json();
    const solBackLamports = Number(json?.outAmount ?? 0);
    if (!Number.isFinite(solBackLamports) || solBackLamports <= 0) return null;
    const proportionalCostBasis = entrySolCost * (remainingPct / 100);
    return solBackLamports / 1e9 / proportionalCostBasis;
  } catch {
    return null;
  }
}

function getConnection(): Connection {
  if (isDevnet()) {
    return new Connection("https://api.devnet.solana.com", "confirmed");
  }
  const heliusKey = process.env.HELIUS_API_KEY || "";
  return new Connection(
    `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
    "confirmed"
  );
}

/**
 * Airdrop free SOL on devnet for testing.
 */
export async function airdropDevnet(amountSol: number): Promise<void> {
  if (!isDevnet()) {
    console.error("  [JUPITER] Airdrop only available on devnet");
    return;
  }
  const keypair = getKeypair();
  if (!keypair) return;

  const connection = getConnection();
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

  console.log(`  [JUPITER] Requesting airdrop of ${amountSol} SOL on devnet...`);
  const sig = await connection.requestAirdrop(keypair.publicKey, lamports);
  await connection.confirmTransaction(sig, "confirmed");
  console.log(`  [JUPITER] Airdrop ${amountSol} SOL on devnet ✅ (${sig})`);
}

function getKeypair(): Keypair | null {
  const privKey = process.env.PHANTOM_PRIVATE_KEY;
  if (!privKey) {
    console.error("  [JUPITER] PHANTOM_PRIVATE_KEY not set");
    return null;
  }
  try {
    return Keypair.fromSecretKey(bs58.decode(privKey));
  } catch (err: any) {
    console.error("  [JUPITER] Invalid private key:", err.message);
    return null;
  }
}

/**
 * Sprint 10 Phase 3 — pre-buy liquidity trap filter.
 *
 * Quote SOL → TOKEN → SOL round-trip at the intended entry size. Returns
 * recovery as `solBack / solAmount`. Returns null on any quote failure
 * (fail-open: transient Jupiter issues should not block entries).
 *
 * Uses the same slippage profile as the live trading path (BUY_SLIPPAGE_BPS
 * inbound, first SELL_SLIPPAGE_BPS bracket outbound) so the recovery
 * estimate reflects what we'd actually realize on a clean exit. Costs
 * 2 /quote calls per invocation — well under the 600/min free-tier cap.
 */
export async function simulateRoundTripRecovery(
  coinAddress: string,
  solAmount: number
): Promise<number | null> {
  try {
    const lamports = Math.floor(solAmount * 1e9);
    if (lamports <= 0) return null;

    const buyUrl = `${JUPITER_QUOTE_URL}?inputMint=${SOL_MINT}&outputMint=${coinAddress}&amount=${lamports}&slippageBps=${BUY_SLIPPAGE_BPS}`;
    const buyRes = await jupiterFetchWithBackoff(buyUrl, undefined, "simRT-buy");
    if (!buyRes.ok) return null;
    const buyJson: any = await buyRes.json();
    const tokensOut = Number(buyJson?.outAmount ?? 0);
    if (!Number.isFinite(tokensOut) || tokensOut <= 0) return null;

    const sellUrl = `${JUPITER_QUOTE_URL}?inputMint=${coinAddress}&outputMint=${SOL_MINT}&amount=${tokensOut}&slippageBps=${SELL_SLIPPAGE_BPS[0]}`;
    const sellRes = await jupiterFetchWithBackoff(sellUrl, undefined, "simRT-sell");
    if (!sellRes.ok) return null;
    const sellJson: any = await sellRes.json();
    const solBackLamports = Number(sellJson?.outAmount ?? 0);
    if (!Number.isFinite(solBackLamports) || solBackLamports <= 0) return null;

    return solBackLamports / 1e9 / solAmount;
  } catch {
    return null;
  }
}

/**
 * Buy a token with SOL via Jupiter.
 * @param coinAddress - Token mint address to buy
 * @param amountSol - Amount of SOL to spend
 * @returns Transaction signature or null on failure
 */
export async function buyToken(
  coinAddress: string,
  amountSol: number
): Promise<string | null> {
  try {
    const network = isDevnet() ? "DEVNET" : "MAINNET";
    const keypair = getKeypair();
    if (!keypair) return null;

    const amountLamports = Math.floor(amountSol * 1e9);
    const walletPubkey = keypair.publicKey.toBase58();
    console.log(`  [JUPITER] BUY on ${network}: ${coinAddress.slice(0, 8)}... for ${amountSol} SOL`);

    // 1. Get quote
    const quoteUrl = `${JUPITER_QUOTE_URL}?inputMint=${SOL_MINT}&outputMint=${coinAddress}&amount=${amountLamports}&slippageBps=${BUY_SLIPPAGE_BPS}`;
    const quoteRes = await jupiterFetchWithBackoff(quoteUrl, undefined, "buy-quote");
    if (!quoteRes.ok) {
      console.error(`  [JUPITER] Quote failed: ${quoteRes.status}`);
      return null;
    }
    const quoteResponse = await quoteRes.json();

    // 2. Get swap transaction with priority fee
    const swapRes = await jupiterFetchWithBackoff(
      JUPITER_SWAP_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: walletPubkey,
          wrapAndUnwrapSol: true,
          prioritizationFeeLamports: { jitoTipLamports: JITO_TIP_LAMPORTS },
        }),
      },
      "buy-swap"
    );
    if (!swapRes.ok) {
      console.error(`  [JUPITER] Swap tx failed: ${swapRes.status}`);
      return null;
    }
    const { swapTransaction } = await swapRes.json();

    // 3. Deserialize, sign, and send via Jito bundle (fallback to public RPC)
    const connection = getConnection();
    const txBuf = Buffer.from(swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    let signature: string;
    const jitoResult = await submitViaJito(tx, `BUY ${coinAddress.slice(0, 8)}`);
    if (jitoResult && jitoResult.landed) {
      // Jito confirmed landing — no need for further RPC confirmation
      console.log(
        `  [JUPITER] BUY sent via Jito: ${coinAddress.slice(0, 8)}... ${amountSol} SOL → ${jitoResult.signature}`
      );
      return jitoResult.signature;
    }

    // Jito either (a) rejected submission outright (429 / network fail)
    // or (b) accepted but the bundle didn't land within the 60s poll
    // window. In both cases, the only tx we have signed carries
    // jitoTipLamports but NO standard compute-unit-price, so non-Jito
    // validators drop it. Fix: re-request the swap from Jupiter with
    // prioritizationFeeLamports:"auto" so the tx carries a real priority
    // fee, then submit via public RPC.
    //
    // For path (b) we do one RPC sig check first to avoid a double-
    // submit if Jito ends up landing after the poll timeout (rare but
    // possible — tokens would land 2x otherwise). If the Jito sig is
    // already confirmed we use it; if "not found" (the typical case),
    // we proceed with re-quote.
    if (jitoResult && !jitoResult.landed) {
      try {
        const preCheck = await connection.getSignatureStatus(jitoResult.signature);
        const cs = preCheck.value?.confirmationStatus;
        if (cs === "confirmed" || cs === "finalized") {
          if (preCheck.value!.err) {
            console.error(`  [JUPITER] BUY Jito sig confirmed but failed on-chain: ${preCheck.value!.err}`);
            return null;
          }
          console.log(`  [JUPITER] BUY Jito sig already confirmed (late-land): ${jitoResult.signature}`);
          return jitoResult.signature;
        }
      } catch {
        /* treat as not-found, proceed with re-quote */
      }
      console.log(`  [JUPITER] BUY Jito poll inconclusive, sig not on-chain — re-requesting swap with auto priority for RPC fallback`);
    } else {
      console.log(`  [JUPITER] BUY Jito failed — re-requesting swap with auto priority for RPC fallback`);
    }

    const fallbackSwapRes = await jupiterFetchWithBackoff(
      JUPITER_SWAP_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: walletPubkey,
          wrapAndUnwrapSol: true,
          prioritizationFeeLamports: "auto",
        }),
      },
      "buy-swap-fallback"
    );
    if (!fallbackSwapRes.ok) {
      console.error(`  [JUPITER] BUY fallback swap tx failed: ${fallbackSwapRes.status}`);
      return null;
    }
    const { swapTransaction: fallbackSwapTx } = await fallbackSwapRes.json();
    const fallbackTx = VersionedTransaction.deserialize(Buffer.from(fallbackSwapTx, "base64"));
    fallbackTx.sign([keypair]);
    signature = await connection.sendRawTransaction(fallbackTx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    console.log(
      `  [JUPITER] BUY sent via RPC (auto priority): ${coinAddress.slice(0, 8)}... ${amountSol} SOL → ${signature}`
    );

    // Wait for confirmation — must know if buy landed before tagging [LIVE]
    // Retry up to 6 times with 10s intervals (total ~60s) to handle slow RPC
    console.log(`  [JUPITER] Waiting for confirmation (up to 60s)...`);
    try {
      const conf = await connection.confirmTransaction(signature, "confirmed");
      if (conf.value.err) {
        console.error(`  [JUPITER] BUY tx FAILED on-chain: ${signature} — ${JSON.stringify(conf.value.err)}`);
        return null; // Buy failed — don't tag [LIVE]
      }
      console.log(`  [JUPITER] BUY confirmed on-chain: ${signature}`);
      return signature;
    } catch {
      // Timeout — poll tx status with retries
      console.log(`  [JUPITER] BUY confirmation timeout — polling tx status (6 retries, 10s intervals)...`);
      for (let attempt = 1; attempt <= 6; attempt++) {
        await new Promise((r) => setTimeout(r, 10_000)); // 10s between retries
        try {
          const status = await connection.getSignatureStatus(signature);
          const cs = status.value?.confirmationStatus;
          if (cs === "confirmed" || cs === "finalized") {
            if (status.value!.err) {
              console.error(`  [JUPITER] BUY verified FAILED (attempt ${attempt}): ${signature}`);
              return null;
            }
            console.log(`  [JUPITER] BUY verified SUCCESS (attempt ${attempt}, late confirm): ${signature}`);
            return signature;
          }
          console.log(`  [JUPITER] BUY status check ${attempt}/6: ${cs || "not found yet"}`);
        } catch {
          console.log(`  [JUPITER] BUY status check ${attempt}/6: RPC error, retrying...`);
        }
      }
      console.error(`  [JUPITER] BUY status unknown after 60s — treating as FAILED: ${signature}`);
      return null; // Unknown after all retries = don't tag [LIVE]
    }
  } catch (err: any) {
    console.error(`  [JUPITER] BUY failed: ${err.message}`);
    return null;
  }
}

// Standard SPL Token and Token 2022 program IDs
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/**
 * Fetch on-chain token balance for a given mint.
 * Checks both SPL Token and Token 2022 programs.
 * Returns raw amount (smallest unit) or 0 if not found.
 */
async function getTokenBalance(
  connection: Connection,
  walletPubkey: PublicKey,
  mintAddress: string
): Promise<number> {
  const mintPubkey = new PublicKey(mintAddress);

  // Try standard SPL Token program first
  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(
      walletPubkey,
      { mint: mintPubkey, programId: TOKEN_PROGRAM_ID }
    );
    if (accounts.value.length > 0) {
      const rawAmount = accounts.value[0].account.data.parsed?.info?.tokenAmount?.amount;
      if (rawAmount && Number(rawAmount) > 0) return Number(rawAmount);
    }
  } catch {}

  // Try Token 2022 program (pump.fun tokens use this)
  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(
      walletPubkey,
      { mint: mintPubkey, programId: TOKEN_2022_PROGRAM_ID }
    );
    if (accounts.value.length > 0) {
      const rawAmount = accounts.value[0].account.data.parsed?.info?.tokenAmount?.amount;
      if (rawAmount && Number(rawAmount) > 0) return Number(rawAmount);
    }
  } catch {}

  // Retry once after 2s (account may not be indexed yet)
  await new Promise((r) => setTimeout(r, 2000));

  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(
      walletPubkey,
      { mint: mintPubkey, programId: TOKEN_2022_PROGRAM_ID }
    );
    if (accounts.value.length > 0) {
      const rawAmount = accounts.value[0].account.data.parsed?.info?.tokenAmount?.amount;
      if (rawAmount && Number(rawAmount) > 0) return Number(rawAmount);
    }
  } catch (err: any) {
    console.error(`  [JUPITER] Token balance fetch failed after retry: ${err.message}`);
  }

  console.log(`  [JUPITER] Token balance is 0 — already sold or rugged`);
  return 0;
}

/**
 * Check if wallet currently holds any of the given token.
 * Used by trade-executor's late-confirm rescue path: if a buy was marked
 * "failed" but tokens later appear on-chain, we know the buy actually landed.
 */
export async function hasTokenBalance(coinAddress: string): Promise<boolean> {
  const keypair = getKeypair();
  if (!keypair) return false;
  const connection = getConnection();
  const amount = await getTokenBalance(connection, keypair.publicKey, coinAddress);
  return amount > 0;
}

/**
 * Sell a token for SOL via Jupiter.
 * Automatically fetches on-chain token balance.
 *
 * Sprint 10 Phase 1: when `opts.entrySolCost` + `opts.exitReason` are
 * provided AND the reason is a rescue exit (whale_exit/circuit_breaker/
 * stop_loss/trailing_stop), runs a pre-flight simulation. If the
 * simulated SOL out divided by entry cost is below SELL_MIN_RECOVERY_FLOOR,
 * the sell aborts with a sim-abort flag — the pool is likely drained and
 * crystallizing the dust doesn't help. Grid take_profit always executes.
 *
 * Sprint 10 Phase 3 (Apr 19 PM): `opts.sellPercent` (0-100, default 100)
 * sells only that % of the CURRENT wallet balance. Used for real L1/L2
 * grid partials (sell 50% or 25% of current holdings, not the full bag).
 *
 * Sprint 10 Phase 5 (Apr 21 PM): `opts.skipJito` (default false) bypasses
 * the Jito bundle submit entirely and sends the tx directly via public
 * RPC with auto priority fees. Guard-initiated exits (L1/L2/L3, SL, CB,
 * trailing, timeout, unsellable recovery) should always pass
 * `skipJito: true` because:
 *   - Memecoin exits are time-critical. Losing 60-90s to a Jito bundle
 *     poll (and another 60s to the re-quote fallback) routinely costs
 *     20-50pp on the fill during volatile pumps (McDino +39% → -12%,
 *     AI Coach Rudi +17% → timeout, KICAU +24% → liquidity-drain fills).
 *   - Sandwich protection on SELLS is worth ~1-3% slippage; losing 60s
 *     on a volatile exit is worth ~20pp. Net win by 10-20x.
 * BUYS still route through Jito (in buyToken) because entry sandwich is
 * a real cost and buy timing is less pump-sensitive.
 *
 * @param coinAddress - Token mint address to sell
 * @param opts.entrySolCost - SOL spent on entry (for recovery math)
 * @param opts.exitReason - Why we're selling (determines sim-gate behavior)
 * @param opts.sellPercent - Percent of current balance to sell (1-100, default 100)
 * @param opts.skipJito - Bypass Jito bundle, go direct RPC with auto priority
 * @returns Transaction signature or null on failure / sim abort
 */
export async function sellToken(
  coinAddress: string,
  opts?: { entrySolCost?: number; exitReason?: string; sellPercent?: number; skipJito?: boolean; remainingPct?: number }
): Promise<string | null> {
  try {
    const keypair = getKeypair();
    if (!keypair) return null;

    const walletPubkey = keypair.publicKey.toBase58();
    const connection = getConnection();

    // Fetch actual token balance from chain
    const tokenAmount = await getTokenBalance(
      connection,
      keypair.publicKey,
      coinAddress
    );

    if (tokenAmount <= 0) {
      console.log(`  [JUPITER] No token balance found for ${coinAddress.slice(0, 8)}..., skipping sell`);
      return null;
    }

    // Phase 3: compute portion to sell. Default 100% for full exits;
    // L1/L2 grid partials pass sellPercent to sell a slice of current balance.
    const sellPct = Math.max(1, Math.min(100, opts?.sellPercent ?? 100));
    const sellAmount = Math.floor((tokenAmount * sellPct) / 100);
    if (sellAmount <= 0) {
      console.log(`  [JUPITER] Computed sellAmount=0 from balance ${tokenAmount} × ${sellPct}% — skipping`);
      return null;
    }

    console.log(
      `  [JUPITER] Token balance: ${tokenAmount} | selling ${sellPct}% = ${sellAmount} for ${coinAddress.slice(0, 8)}...`
    );

    // Rescue mode: for exits where the pool is already flagged as in
    // trouble (CB/SL/trailing_stop/timeout/holder_rug/pool_drain/whale),
    // use the shorter, more aggressive slippage ladder and a tighter
    // confirmation window. The goal is to land the sell on the FIRST
    // attempt before price drops further, not cycle through levels.
    const isRescueExit =
      opts?.exitReason != null && RESCUE_EXIT_REASONS.has(opts.exitReason);
    const slippageLadder = isRescueExit
      ? SELL_SLIPPAGE_BPS_RESCUE
      : SELL_SLIPPAGE_BPS;
    const confirmTimeoutMs = isRescueExit ? 30_000 : 60_000;
    const statusRetryCount = isRescueExit ? 3 : 6;
    if (isRescueExit) {
      console.log(
        `  [JUPITER] Rescue-mode slippage ladder for ${coinAddress.slice(0, 8)}... (${opts!.exitReason}): starting at ${slippageLadder[0] / 100}%, confirm timeout ${confirmTimeoutMs / 1000}s`
      );
    }

    // Auto-escalate slippage (normal: 5% → 10% → 20% → 30%; rescue: 20% → 30%)
    // On-chain 6001 failures (slippage exceeded) trigger next level.
    // 6024 (min-out violation) also retries through the ladder — if
    // every level fails with 6024, we mark unsellable after the loop.
    let sawUnsellable6024 = false;
    for (const slippage of slippageLadder) {
      try {
        console.log(`  [JUPITER] Trying sell at ${slippage / 100}% slippage...`);

        // 1. Get quote
        const quoteUrl = `${JUPITER_QUOTE_URL}?inputMint=${coinAddress}&outputMint=${SOL_MINT}&amount=${sellAmount}&slippageBps=${slippage}`;
        const quoteRes = await jupiterFetchWithBackoff(quoteUrl, undefined, "sell-quote");
        if (!quoteRes.ok) {
          console.error(`  [JUPITER] Sell quote failed: ${quoteRes.status}`);
          continue;
        }
        const quoteResponse = await quoteRes.json();

        // 2. Get swap transaction.
        // skipJito=true (guard exits): request auto-priority fees from
        // the start — no Jito tip, no bundle submit, no 60s poll.
        // skipJito=false (default, rescue scripts / buys): request with
        // Jito tip for MEV protection, submit via bundle + poll.
        const useJito = !opts?.skipJito;
        const swapRes = await jupiterFetchWithBackoff(
          JUPITER_SWAP_URL,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              quoteResponse,
              userPublicKey: walletPubkey,
              wrapAndUnwrapSol: true,
              prioritizationFeeLamports: useJito
                ? { jitoTipLamports: JITO_TIP_LAMPORTS }
                : "auto",
            }),
          },
          useJito ? "sell-swap" : "sell-swap-direct"
        );
        if (!swapRes.ok) {
          console.error(`  [JUPITER] Sell swap tx failed: ${swapRes.status}`);
          continue;
        }
        const { swapTransaction } = await swapRes.json();

        // 3. Deserialize (don't sign yet — need to simulate first)
        const txBuf = Buffer.from(swapTransaction, "base64");
        const tx = VersionedTransaction.deserialize(txBuf);

        // 3a. Pre-flight sim gate (rescue exits only).
        // We always log the sim-implied recovery % for distribution
        // analysis, but only ABORT on rescue exits when recovery is
        // below SELL_MIN_RECOVERY_FLOOR.
        const gatedReasons = new Set([
          "whale_exit",
          "circuit_breaker",
          "stop_loss",
          "trailing_stop",
        ]);
        const shouldGate =
          opts?.entrySolCost != null &&
          opts.entrySolCost > 0 &&
          opts.exitReason != null &&
          gatedReasons.has(opts.exitReason);

        // Quote's outAmount is the authoritative expected SOL out
        // (Jupiter already simulated against pool depth). Use it as
        // the primary recovery signal; the on-chain simulate call
        // below is a tx-will-execute sanity check.
        //
        // Apr 21 bug fix: recovery MUST divide by the proportional
        // cost basis of the SLICE we're selling, not the full entry.
        // Old formula broke post-grid exits: at L2 (remaining_pct=25)
        // selling 100% of remaining at mark -10% produced
        //   recovery = 0.225 × entry / entry = 22.5%
        // which was below the 30% floor — SL/CB/trailing would be
        // aborted on a legitimate exit. Correct formula:
        //   costBasis = entry × (remainingPct/100) × (sellPercent/100)
        //   recovery = expectedSolOut / costBasis
        // With remainingPct=100 + sellPercent=100 (L0 full exit) this
        // reduces to the old formula — backward compatible.
        const quoteOutLamports = Number(quoteResponse?.outAmount ?? 0);
        const expectedSolOut = quoteOutLamports / 1e9;
        const remainingPctForCostBasis = opts?.remainingPct ?? 100;
        const sliceCostBasis =
          opts?.entrySolCost && opts.entrySolCost > 0
            ? opts.entrySolCost * (remainingPctForCostBasis / 100) * (sellPct / 100)
            : null;
        const recovery =
          sliceCostBasis && sliceCostBasis > 0
            ? expectedSolOut / sliceCostBasis
            : null;

        if (recovery !== null) {
          console.log(
            `  [GUARD] Sim recovery: ${(recovery * 100).toFixed(2)}% on ${coinAddress.slice(0, 8)}... (${opts?.exitReason ?? "?"}) | entry ${opts!.entrySolCost!.toFixed(6)} → quoted ${expectedSolOut.toFixed(6)} SOL`
          );
        }

        if (shouldGate && recovery !== null && recovery < SELL_MIN_RECOVERY_FLOOR) {
          // Belt-and-suspenders: also try a chain simulation so we have
          // two independent signals in logs before aborting.
          let simErr: any = null;
          try {
            const simRes = await connection.simulateTransaction(tx, {
              commitment: "processed",
              replaceRecentBlockhash: true,
            });
            simErr = simRes.value.err;
          } catch (e: any) {
            console.log(`  [GUARD] simulateTransaction crashed: ${e.message} (ignoring, using quote recovery)`);
          }
          console.log(
            `  [GUARD] SELL ABORTED — sim shows recovery ${(recovery * 100).toFixed(2)}% < ${(SELL_MIN_RECOVERY_FLOOR * 100).toFixed(0)}% floor. Pool likely drained. (${opts?.exitReason}, chain sim err=${JSON.stringify(simErr) || "none"})`
          );
          sellSimAborts.set(coinAddress, Date.now());
          return null;
        }

        // 3b. Sign
        tx.sign([keypair]);

        let signature: string = "";
        let confirmed = false;
        let onChainError: any = null;

        if (!useJito) {
          // skipJito fast path: send directly via public RPC. Tx was
          // requested with "auto" priority fees so validators will
          // include it without needing the Jito bundle route. Saves
          // ~60s of bundle poll + ~60s of re-quote fallback that the
          // Jito-first path eats on memecoin exits. The standard
          // confirmation-wait block below handles the landing check.
          signature = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
            maxRetries: 3,
          });
          console.log(
            `  [JUPITER] SELL sent direct RPC (skipJito, auto priority) at ${slippage / 100}%: ${coinAddress.slice(0, 8)}... → ${signature}`
          );
        } else {
        const jitoResult = await submitViaJito(
          tx,
          `SELL ${coinAddress.slice(0, 8)} ${slippage / 100}%`
        );
        if (jitoResult && jitoResult.landed) {
          signature = jitoResult.signature;
          confirmed = true;
          console.log(
            `  [JUPITER] SELL sent via Jito at ${slippage / 100}%: ${coinAddress.slice(0, 8)}... → ${signature}`
          );
        } else {
          // Jito either failed submission outright (429 / network) or
          // accepted but bundle didn't land in 60s. In both cases the
          // signed tx has jitoTipLamports (no standard priority fee) so
          // non-Jito validators drop it. Re-quote with "auto" priority
          // and submit via public RPC.
          //
          // For the poll-timeout case we do one RPC sig check first to
          // avoid double-submit if Jito late-lands. Rare but possible;
          // double-submit would credit us with 2x tokens at 2x SOL cost.
          let alreadyConfirmed = false;
          if (jitoResult && !jitoResult.landed) {
            try {
              const preCheck = await connection.getSignatureStatus(jitoResult.signature);
              const cs = preCheck.value?.confirmationStatus;
              if (cs === "confirmed" || cs === "finalized") {
                if (preCheck.value!.err) {
                  onChainError = preCheck.value!.err;
                  signature = jitoResult.signature;
                  console.error(`  [JUPITER] SELL Jito sig confirmed but failed on-chain at ${slippage / 100}%: ${JSON.stringify(preCheck.value!.err)}`);
                } else {
                  signature = jitoResult.signature;
                  confirmed = true;
                  alreadyConfirmed = true;
                  console.log(`  [JUPITER] SELL Jito sig already confirmed (late-land) at ${slippage / 100}%: ${signature}`);
                }
              }
            } catch {
              /* treat as not-found, proceed with re-quote */
            }
            if (!alreadyConfirmed && !onChainError) {
              console.log(`  [JUPITER] SELL Jito poll inconclusive at ${slippage / 100}%, sig not on-chain — re-requesting swap with auto priority for RPC fallback`);
            }
          } else {
            console.log(`  [JUPITER] SELL Jito failed at ${slippage / 100}% — re-requesting swap with auto priority for RPC fallback`);
          }

          if (!alreadyConfirmed && !onChainError) {
            const fallbackSwapRes = await jupiterFetchWithBackoff(
              JUPITER_SWAP_URL,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  quoteResponse,
                  userPublicKey: walletPubkey,
                  wrapAndUnwrapSol: true,
                  prioritizationFeeLamports: "auto",
                }),
              },
              "sell-swap-fallback"
            );
            if (!fallbackSwapRes.ok) {
              console.error(`  [JUPITER] SELL fallback swap tx failed at ${slippage / 100}%: ${fallbackSwapRes.status}`);
              continue;
            }
            const { swapTransaction: fallbackSwapTx } = await fallbackSwapRes.json();
            const fallbackTx = VersionedTransaction.deserialize(Buffer.from(fallbackSwapTx, "base64"));
            fallbackTx.sign([keypair]);
            signature = await connection.sendRawTransaction(fallbackTx.serialize(), {
              skipPreflight: true,
              maxRetries: 3,
            });
            console.log(
              `  [JUPITER] SELL sent via RPC (auto priority) at ${slippage / 100}%: ${coinAddress.slice(0, 8)}... → ${signature}`
            );
          }
        }
        }  // end `else` of `if (!useJito)`

        if (!confirmed && !onChainError) {
          // Blocking confirmation — must know result before returning.
          // Skip if onChainError already set (Jito sig confirmed with err).
          // Rescue exits use a shorter 30s wait + 3 retries (total ~60s) to
          // bail out and retry at 30% slippage faster instead of burning
          // 120s per ladder rung while the price keeps crashing.
          console.log(`  [JUPITER] SELL waiting for confirmation (up to ${confirmTimeoutMs / 1000}s)...`);

        try {
          // Wrap confirmTransaction in Promise.race with our own timeout —
          // web3.js's internal timeout is blockhash-based and can hang
          // significantly longer than the confirm strategy name suggests.
          const conf: any = await Promise.race([
            connection.confirmTransaction(signature, "confirmed"),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("confirm-timeout")), confirmTimeoutMs)
            ),
          ]);
          if (conf?.value?.err) {
            onChainError = conf.value.err;
          } else {
            confirmed = true;
          }
        } catch {
          // Timeout — poll status with retries
          console.log(`  [JUPITER] SELL confirmation timeout — polling tx status (${statusRetryCount} retries, 10s intervals)...`);
          for (let attempt = 1; attempt <= statusRetryCount; attempt++) {
            await new Promise((r) => setTimeout(r, 10_000));
            try {
              const status = await connection.getSignatureStatus(signature);
              const cs = status.value?.confirmationStatus;
              if (cs === "confirmed" || cs === "finalized") {
                if (status.value!.err) {
                  onChainError = status.value!.err;
                } else {
                  confirmed = true;
                }
                break;
              }
              console.log(`  [JUPITER] SELL status check ${attempt}/${statusRetryCount}: ${cs || "not found yet"}`);
            } catch {
              console.log(`  [JUPITER] SELL status check ${attempt}/${statusRetryCount}: RPC error, retrying...`);
            }
          }
        }
        } // end if (!confirmed)

        if (confirmed) {
          console.log(`  [JUPITER] SELL confirmed on-chain: ${signature}`);
          return signature;
        }

        if (onChainError) {
          const errStr = JSON.stringify(onChainError);
          // Jupiter aggregator error codes (v6):
          //   6001 = slippage tolerance exceeded
          //   6024 = minimum-out violation (pool drained below quote OR
          //          token has a transfer fee)
          //
          // The old code bailed immediately on 6024 assuming transfer-
          // tax. But Openhuman + John Apple (Apr 21) both 6024'd on
          // benign metadata-only Token-2022 mints — the real cause was
          // pool drainage making minimum-out unreachable at the quoted
          // slippage. Higher slippage (and smaller sell size, handled
          // in risk-guard) can recover these. Retry through the rest of
          // the ladder; only mark unsellable if every level fails.
          if (errStr.includes("6001") || errStr.includes("6024")) {
            const code = errStr.includes("6001") ? "6001 slippage" : "6024 min-out";
            if (errStr.includes("6024")) sawUnsellable6024 = true;
            console.log(`  [JUPITER] SELL failed (${code}) at ${slippage / 100}% — retrying at higher slippage...`);
            continue; // Try next slippage level
          }
          console.error(`  [JUPITER] SELL tx FAILED on-chain: ${signature} — ${errStr}`);
          continue; // Try next slippage level for any on-chain error
        }

        // Unknown status after all retries — tx likely expired, retry at next slippage
        console.error(`  [JUPITER] SELL status unknown after ${(confirmTimeoutMs + statusRetryCount * 10_000) / 1000}s — tx likely expired, retrying at higher slippage...`);
        continue; // Try next slippage level with fresh tx
      } catch (err: any) {
        console.error(`  [JUPITER] SELL attempt at ${slippage / 100}% failed: ${err.message}`);
      }
    }

    const ladderStr = slippageLadder.map((s) => `${s / 100}%`).join("→");
    console.error(`  [JUPITER] SELL failed all slippage levels (${ladderStr}) — manual intervention needed: ${coinAddress}`);
    // If every rung hit 6024, signal the guard to mark-to-zero after
    // it has exhausted its partial-size fallback. Prevents the position
    // from bouncing between 'closing' and 'open' in an infinite loop.
    if (sawUnsellable6024) unsellableMints.add(coinAddress);
    return null;
  } catch (err: any) {
    console.error(`  [JUPITER] SELL failed: ${err.message}`);
    return null;
  }
}
