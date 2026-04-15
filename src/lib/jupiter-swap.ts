/**
 * PixiuBot — Jupiter Swap Integration
 *
 * Real on-chain swaps via Jupiter V6 aggregator.
 * Uses Helius RPC for transaction submission.
 *
 * LIVE_TRADING must be true in .env.local to execute.
 * PHANTOM_PRIVATE_KEY must be set (base58 encoded).
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_URL = "https://quote-api.jup.ag/v6/swap";
const SLIPPAGE_BPS = 200; // 2% slippage

function getConnection(): Connection {
  const heliusKey = process.env.HELIUS_API_KEY || "";
  return new Connection(
    `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
    "confirmed"
  );
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
    const keypair = getKeypair();
    if (!keypair) return null;

    const amountLamports = Math.floor(amountSol * 1e9);
    const walletPubkey = keypair.publicKey.toBase58();

    // 1. Get quote
    const quoteUrl = `${JUPITER_QUOTE_URL}?inputMint=${SOL_MINT}&outputMint=${coinAddress}&amount=${amountLamports}&slippageBps=${SLIPPAGE_BPS}`;
    const quoteRes = await fetch(quoteUrl);
    if (!quoteRes.ok) {
      console.error(`  [JUPITER] Quote failed: ${quoteRes.status}`);
      return null;
    }
    const quoteResponse = await quoteRes.json();

    // 2. Get swap transaction
    const swapRes = await fetch(JUPITER_SWAP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: walletPubkey,
        wrapAndUnwrapSol: true,
      }),
    });
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
      `  [JUPITER] BUY ${coinAddress.slice(0, 8)}... ${amountSol} SOL → ${signature}`
    );
    return signature;
  } catch (err: any) {
    console.error(`  [JUPITER] BUY failed: ${err.message}`);
    return null;
  }
}

/**
 * Sell a token for SOL via Jupiter.
 * @param coinAddress - Token mint address to sell
 * @param tokenAmount - Raw token amount (in smallest unit)
 * @returns Transaction signature or null on failure
 */
export async function sellToken(
  coinAddress: string,
  tokenAmount: number
): Promise<string | null> {
  try {
    const keypair = getKeypair();
    if (!keypair) return null;

    const walletPubkey = keypair.publicKey.toBase58();

    // 1. Get quote (token → SOL)
    const quoteUrl = `${JUPITER_QUOTE_URL}?inputMint=${coinAddress}&outputMint=${SOL_MINT}&amount=${Math.floor(tokenAmount)}&slippageBps=${SLIPPAGE_BPS}`;
    const quoteRes = await fetch(quoteUrl);
    if (!quoteRes.ok) {
      console.error(`  [JUPITER] Sell quote failed: ${quoteRes.status}`);
      return null;
    }
    const quoteResponse = await quoteRes.json();

    // 2. Get swap transaction
    const swapRes = await fetch(JUPITER_SWAP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: walletPubkey,
        wrapAndUnwrapSol: true,
      }),
    });
    if (!swapRes.ok) {
      console.error(`  [JUPITER] Sell swap tx failed: ${swapRes.status}`);
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
      `  [JUPITER] SELL ${coinAddress.slice(0, 8)}... ${tokenAmount} → ${signature}`
    );
    return signature;
  } catch (err: any) {
    console.error(`  [JUPITER] SELL failed: ${err.message}`);
    return null;
  }
}
