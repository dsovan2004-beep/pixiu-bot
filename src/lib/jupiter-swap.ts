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
const SELL_SLIPPAGE_BPS = [500, 1000, 2000, 3000]; // Auto-escalate: 5% → 10% → 20% → 30% on retry

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
    const walletPubkey = keypair.publicKey.toBase58();

    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx || !tx.meta) return null;

    // Find the wallet's account index in the tx's account keys.
    const accountKeys = tx.transaction.message.getAccountKeys
      ? tx.transaction.message.getAccountKeys().staticAccountKeys
      : (tx.transaction.message as any).accountKeys;
    let idx = -1;
    for (let i = 0; i < accountKeys.length; i++) {
      const key = (accountKeys[i] as any).toBase58
        ? (accountKeys[i] as any).toBase58()
        : String(accountKeys[i]);
      if (key === walletPubkey) { idx = i; break; }
    }
    if (idx < 0) return null;

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
          prioritizationFeeLamports: "auto",
        }),
      },
      "buy-swap"
    );
    if (!swapRes.ok) {
      console.error(`  [JUPITER] Swap tx failed: ${swapRes.status}`);
      return null;
    }
    const { swapTransaction } = await swapRes.json();

    // 3. Deserialize, sign, and send
    const connection = getConnection();
    const txBuf = Buffer.from(swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    console.log(
      `  [JUPITER] BUY sent: ${coinAddress.slice(0, 8)}... ${amountSol} SOL → ${signature}`
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
 * @param coinAddress - Token mint address to sell
 * @returns Transaction signature or null on failure
 */
export async function sellToken(
  coinAddress: string
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

    console.log(`  [JUPITER] Token balance: ${tokenAmount} for ${coinAddress.slice(0, 8)}...`);

    // Auto-escalate slippage: try 5% → 10% → 20% → 30%
    // On-chain 6001 failures (slippage exceeded) trigger next level
    for (const slippage of SELL_SLIPPAGE_BPS) {
      try {
        console.log(`  [JUPITER] Trying sell at ${slippage / 100}% slippage...`);

        // 1. Get quote
        const quoteUrl = `${JUPITER_QUOTE_URL}?inputMint=${coinAddress}&outputMint=${SOL_MINT}&amount=${tokenAmount}&slippageBps=${slippage}`;
        const quoteRes = await jupiterFetchWithBackoff(quoteUrl, undefined, "sell-quote");
        if (!quoteRes.ok) {
          console.error(`  [JUPITER] Sell quote failed: ${quoteRes.status}`);
          continue;
        }
        const quoteResponse = await quoteRes.json();

        // 2. Get swap transaction
        const swapRes = await jupiterFetchWithBackoff(
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
          "sell-swap"
        );
        if (!swapRes.ok) {
          console.error(`  [JUPITER] Sell swap tx failed: ${swapRes.status}`);
          continue;
        }
        const { swapTransaction } = await swapRes.json();

        // 3. Deserialize, sign, and send
        const txBuf = Buffer.from(swapTransaction, "base64");
        const tx = VersionedTransaction.deserialize(txBuf);
        tx.sign([keypair]);

        const signature = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
          maxRetries: 3,
        });

        console.log(
          `  [JUPITER] SELL sent at ${slippage / 100}%: ${coinAddress.slice(0, 8)}... → ${signature}`
        );

        // Blocking confirmation — must know result before returning
        console.log(`  [JUPITER] SELL waiting for confirmation (up to 60s)...`);
        let confirmed = false;
        let onChainError: any = null;

        try {
          const conf = await connection.confirmTransaction(signature, "confirmed");
          if (conf.value.err) {
            onChainError = conf.value.err;
          } else {
            confirmed = true;
          }
        } catch {
          // Timeout — poll status with retries
          console.log(`  [JUPITER] SELL confirmation timeout — polling tx status (6 retries, 10s intervals)...`);
          for (let attempt = 1; attempt <= 6; attempt++) {
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
              console.log(`  [JUPITER] SELL status check ${attempt}/6: ${cs || "not found yet"}`);
            } catch {
              console.log(`  [JUPITER] SELL status check ${attempt}/6: RPC error, retrying...`);
            }
          }
        }

        if (confirmed) {
          console.log(`  [JUPITER] SELL confirmed on-chain: ${signature}`);
          return signature;
        }

        if (onChainError) {
          const errStr = JSON.stringify(onChainError);
          // 6024 = Token-2022 transfer fee / minimum-out violation.
          // Higher slippage does not help — the token has a built-in
          // transfer tax. Bail immediately so the guard can handle it.
          if (errStr.includes("6024")) {
            console.error(`  [JUPITER] Token has transfer fee (6024) — sell impossible, skipping retries: ${coinAddress}`);
            unsellableMints.add(coinAddress); // P0b: signal caller to mark-to-zero instead of retry
            return null;
          }
          const is6001 = errStr.includes("6001");
          if (is6001) {
            console.log(`  [JUPITER] SELL failed (6001 slippage exceeded) at ${slippage / 100}% — retrying at higher slippage...`);
            continue; // Try next slippage level
          }
          console.error(`  [JUPITER] SELL tx FAILED on-chain: ${signature} — ${errStr}`);
          continue; // Try next slippage level for any on-chain error
        }

        // Unknown status after all retries — tx likely expired, retry at next slippage
        console.error(`  [JUPITER] SELL status unknown after 60s — tx likely expired, retrying at higher slippage...`);
        continue; // Try next slippage level with fresh tx
      } catch (err: any) {
        console.error(`  [JUPITER] SELL attempt at ${slippage / 100}% failed: ${err.message}`);
      }
    }

    console.error(`  [JUPITER] SELL failed all slippage levels (5%→10%→20%→30%) — manual intervention needed: ${coinAddress}`);
    return null;
  } catch (err: any) {
    console.error(`  [JUPITER] SELL failed: ${err.message}`);
    return null;
  }
}
