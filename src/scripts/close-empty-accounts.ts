/**
 * One-time script: Close empty Token-2022 accounts to recover rent SOL.
 *
 * Each empty token account locks ~0.002 SOL in rent.
 * This script finds all zero-balance Token-2022 accounts and closes them,
 * returning the rent to the wallet.
 *
 * Uses raw TransactionInstruction (no @solana/spl-token dependency).
 *
 * Usage: cd ~/PixiuBot && npx tsx src/scripts/close-empty-accounts.ts
 */

import "../lib/supabase-server"; // loads dotenv

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";

const TOKEN_2022_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/**
 * Build a CloseAccount instruction for Token-2022 manually.
 * CloseAccount = instruction index 9 in the SPL Token program.
 * Keys: [account (writable), destination (writable), owner (signer)]
 */
function closeAccountInstruction(
  account: PublicKey,
  destination: PublicKey,
  owner: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_2022_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]), // 9 = CloseAccount instruction index
  });
}

function getConnection(): Connection {
  const heliusKey = process.env.HELIUS_API_KEY || "";
  return new Connection(
    `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
    "confirmed"
  );
}

function getKeypair(): Keypair {
  const privKey = process.env.PHANTOM_PRIVATE_KEY;
  if (!privKey) throw new Error("PHANTOM_PRIVATE_KEY not set");
  return Keypair.fromSecretKey(bs58.decode(privKey));
}

async function main() {
  const connection = getConnection();
  const keypair = getKeypair();
  const wallet = keypair.publicKey;

  console.log(`\n[CLEANUP] Wallet: ${wallet.toBase58()}`);
  console.log(`[CLEANUP] Scanning for empty Token-2022 accounts...\n`);

  // Get all Token-2022 accounts
  const accounts = await connection.getParsedTokenAccountsByOwner(wallet, {
    programId: TOKEN_2022_ID,
  });

  // Filter to zero-balance accounts
  const emptyAccounts = accounts.value.filter((a) => {
    const amount = parseInt(
      a.account.data.parsed?.info?.tokenAmount?.amount || "0"
    );
    return amount === 0;
  });

  console.log(
    `[CLEANUP] Found ${emptyAccounts.length} empty accounts (${accounts.value.length} total)\n`
  );

  if (emptyAccounts.length === 0) {
    console.log("[CLEANUP] Nothing to close. Done.");
    return;
  }

  // Get SOL balance before
  const balBefore = await connection.getBalance(wallet);

  let closed = 0;
  let failed = 0;

  // Batch close in groups of 10 (to fit in single tx)
  const BATCH_SIZE = 10;
  for (let i = 0; i < emptyAccounts.length; i += BATCH_SIZE) {
    const batch = emptyAccounts.slice(i, i + BATCH_SIZE);
    const tx = new Transaction();

    for (const acc of batch) {
      tx.add(closeAccountInstruction(acc.pubkey, wallet, wallet));
    }

    try {
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet;
      tx.sign(keypair);

      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });

      await connection.confirmTransaction(sig, "confirmed");

      for (const acc of batch) {
        const mint = acc.account.data.parsed?.info?.mint || "unknown";
        console.log(
          `  [CLEANUP] Closed account ${mint.slice(0, 12)}... — recovered ~0.002 SOL`
        );
        closed++;
      }
      console.log(`  [CLEANUP] Batch ${Math.floor(i / BATCH_SIZE) + 1} confirmed: ${sig}\n`);
    } catch (err: any) {
      console.error(
        `  [CLEANUP] Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${err.message}\n`
      );
      failed += batch.length;
    }

    // Small delay between batches
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Get SOL balance after
  const balAfter = await connection.getBalance(wallet);
  const recovered = (balAfter - balBefore) / 1e9;

  console.log(`\n[CLEANUP] Results:`);
  console.log(`  Closed: ${closed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  SOL recovered: ${recovered >= 0 ? "+" : ""}${recovered.toFixed(4)} SOL`);
  console.log(`  Balance: ${(balAfter / 1e9).toFixed(4)} SOL`);
}

main().catch(console.error);
