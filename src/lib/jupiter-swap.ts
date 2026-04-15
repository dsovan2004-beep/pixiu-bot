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
const SLIPPAGE_BPS = 200; // 2% slippage

function isDevnet(): boolean {
  return process.env.SOLANA_NETWORK === "devnet";
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

    // Confirm transaction landed on-chain
    console.log(`  [JUPITER] BUY sent: ${signature} — confirming...`);
    const confirmation = await connection.confirmTransaction(signature, "confirmed");
    if (confirmation.value.err) {
      console.error(`  [JUPITER] BUY tx failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      return null;
    }

    console.log(
      `  [JUPITER] BUY confirmed: ${coinAddress.slice(0, 8)}... ${amountSol} SOL → ${signature}`
    );
    return signature;
  } catch (err: any) {
    console.error(`  [JUPITER] BUY failed: ${err.message}`);
    return null;
  }
}

/**
 * Fetch on-chain token balance for a given mint.
 * Returns raw amount (smallest unit) or 0 if not found.
 */
async function getTokenBalance(
  connection: Connection,
  walletPubkey: PublicKey,
  mintAddress: string
): Promise<number> {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const accounts = await connection.getParsedTokenAccountsByOwner(
      walletPubkey,
      { mint: mintPubkey }
    );

    if (accounts.value.length === 0) return 0;

    const info = accounts.value[0].account.data.parsed?.info;
    const rawAmount = info?.tokenAmount?.amount;
    return rawAmount ? Number(rawAmount) : 0;
  } catch (err: any) {
    console.error(`  [JUPITER] Token balance fetch failed: ${err.message}`);
    return 0;
  }
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

    // 1. Get quote (token → SOL)
    const quoteUrl = `${JUPITER_QUOTE_URL}?inputMint=${coinAddress}&outputMint=${SOL_MINT}&amount=${tokenAmount}&slippageBps=${SLIPPAGE_BPS}`;
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
    const txBuf = Buffer.from(swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    // Confirm transaction landed on-chain
    console.log(`  [JUPITER] SELL sent: ${signature} — confirming...`);
    const confirmation = await connection.confirmTransaction(signature, "confirmed");
    if (confirmation.value.err) {
      console.error(`  [JUPITER] SELL tx failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      return null;
    }

    console.log(
      `  [JUPITER] SELL confirmed: ${coinAddress.slice(0, 8)}... ${tokenAmount} → ${signature}`
    );
    return signature;
  } catch (err: any) {
    console.error(`  [JUPITER] SELL failed: ${err.message}`);
    return null;
  }
}
