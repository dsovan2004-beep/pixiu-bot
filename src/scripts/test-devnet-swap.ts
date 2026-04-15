/**
 * PixiuBot — Devnet Swap Test
 * Usage: SOLANA_NETWORK=devnet npx tsx src/scripts/test-devnet-swap.ts
 *
 * Tests the full Jupiter swap flow on Solana devnet:
 * 1. Airdrops free SOL
 * 2. Buys a devnet token
 * 3. Sells the token back
 */

import { airdropDevnet, buyToken, sellToken } from "../lib/jupiter-swap";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env.local") });

// Force devnet for this test
process.env.SOLANA_NETWORK = "devnet";

// Devnet USDC mint
const DEVNET_USDC = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Devnet Swap Test");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Network:  DEVNET`);
  console.log(`  Token:    ${DEVNET_USDC} (devnet USDC)`);
  console.log(`  Started:  ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Check wallet
  const privKey = process.env.PHANTOM_PRIVATE_KEY;
  if (!privKey) {
    console.error("  [ERROR] PHANTOM_PRIVATE_KEY not set in .env.local");
    process.exit(1);
  }

  const keypair = Keypair.fromSecretKey(bs58.decode(privKey));
  const walletPubkey = keypair.publicKey.toBase58();
  console.log(`  Wallet: ${walletPubkey}\n`);

  // Step 1: Check balance first
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const balanceBefore = await connection.getBalance(keypair.publicKey);
  console.log(`  [1/5] Current balance: ${(balanceBefore / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  // Step 2: Airdrop if needed
  if (balanceBefore < 0.5 * LAMPORTS_PER_SOL) {
    console.log("  [2/5] Balance low — requesting airdrop...");
    try {
      await airdropDevnet(1);
      await sleep(2000); // Wait for confirmation to propagate
      const balanceAfter = await connection.getBalance(keypair.publicKey);
      console.log(`  [2/5] Balance after airdrop: ${(balanceAfter / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);
    } catch (err: any) {
      console.error(`  [2/5] Airdrop failed: ${err.message}`);
      console.log("  Continuing with existing balance...\n");
    }
  } else {
    console.log("  [2/5] Balance sufficient — skipping airdrop\n");
  }

  // Step 3: Buy devnet USDC
  console.log("  [3/5] Buying devnet USDC with 0.01 SOL...");
  const buySig = await buyToken(DEVNET_USDC, 0.01);

  if (buySig) {
    console.log(`  [3/5] ✅ BUY successful!`);
    console.log(`  TX: https://explorer.solana.com/tx/${buySig}?cluster=devnet\n`);
  } else {
    console.log("  [3/5] ❌ BUY failed — Jupiter may not support this token on devnet");
    console.log("  This is expected if the devnet token has no liquidity pool\n");
  }

  // Step 4: Wait for confirmation
  console.log("  [4/5] Waiting 5 seconds for confirmation...");
  await sleep(5000);

  // Step 5: Sell back
  if (buySig) {
    console.log("  [5/5] Selling devnet USDC back to SOL...");
    const sellSig = await sellToken(DEVNET_USDC);

    if (sellSig) {
      console.log(`  [5/5] ✅ SELL successful!`);
      console.log(`  TX: https://explorer.solana.com/tx/${sellSig}?cluster=devnet\n`);
    } else {
      console.log("  [5/5] ❌ SELL failed — may have no token balance or no liquidity\n");
    }
  } else {
    console.log("  [5/5] Skipped — no buy to reverse\n");
  }

  // Final balance
  const balanceFinal = await connection.getBalance(keypair.publicKey);
  console.log(`  Final balance: ${(balanceFinal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log("\n  ─── Test Complete ───");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
