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
const BUY_SLIPPAGE_BPS = 1000; // 10% for buys — pump.fun tokens need higher
const SELL_SLIPPAGE_BPS = [500, 1000, 2000]; // Auto-escalate: 5% → 10% → 20% on retry

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
    const quoteUrl = `${JUPITER_QUOTE_URL}?inputMint=${SOL_MINT}&outputMint=${coinAddress}&amount=${amountLamports}&slippageBps=${BUY_SLIPPAGE_BPS}`;
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
      `  [JUPITER] BUY sent: ${coinAddress.slice(0, 8)}... ${amountSol} SOL → ${signature}`
    );

    // Non-blocking confirmation — don't wait 30s, just log result async
    connection.confirmTransaction(signature, "confirmed").then((conf) => {
      if (conf.value.err) {
        console.error(`  [JUPITER] BUY tx FAILED on-chain: ${signature} — ${JSON.stringify(conf.value.err)}`);
      } else {
        console.log(`  [JUPITER] BUY confirmed on-chain: ${signature}`);
      }
    }).catch(() => {
      console.error(`  [JUPITER] BUY confirmation timeout: ${signature} — check manually`);
    });

    return signature;
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

    // Auto-escalate slippage: try 5% → 10% → 20%
    for (const slippage of SELL_SLIPPAGE_BPS) {
      try {
        console.log(`  [JUPITER] Trying sell at ${slippage / 100}% slippage...`);

        // 1. Get quote
        const quoteUrl = `${JUPITER_QUOTE_URL}?inputMint=${coinAddress}&outputMint=${SOL_MINT}&amount=${tokenAmount}&slippageBps=${slippage}`;
        const quoteRes = await fetch(quoteUrl);
        if (!quoteRes.ok) {
          console.error(`  [JUPITER] Sell quote failed: ${quoteRes.status}`);
          continue;
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

        // Non-blocking confirmation
        connection.confirmTransaction(signature, "confirmed").then((conf) => {
          if (conf.value.err) {
            console.error(`  [JUPITER] SELL tx FAILED on-chain: ${signature} — ${JSON.stringify(conf.value.err)}`);
          } else {
            console.log(`  [JUPITER] SELL confirmed on-chain: ${signature}`);
          }
        }).catch(() => {
          console.error(`  [JUPITER] SELL confirmation timeout: ${signature} — check manually`);
        });

        return signature;
      } catch (err: any) {
        console.error(`  [JUPITER] SELL attempt at ${slippage / 100}% failed: ${err.message}`);
      }
    }

    console.error(`  [JUPITER] SELL failed after all slippage attempts for ${coinAddress.slice(0, 8)}...`);
    return null;
  } catch (err: any) {
    console.error(`  [JUPITER] SELL failed: ${err.message}`);
    return null;
  }
}
