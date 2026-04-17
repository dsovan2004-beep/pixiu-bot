/**
 * sell-pumpfun.ts — direct pump.fun bonding-curve sell.
 *
 * Jupiter fails on some pump.fun tokens with error 6024 (bonding curve
 * state issues). This script bypasses Jupiter and calls pump.fun's sell
 * instruction directly on all held tokens for the given mint.
 *
 * Usage:
 *   npx tsx src/scripts/sell-pumpfun.ts <MINT_ADDRESS>
 *
 * Env required: HELIUS_API_KEY, PHANTOM_PRIVATE_KEY (both loaded from .env.local).
 *
 * If the bonding curve has already graduated to Raydium, the script
 * detects that and exits cleanly so the user can sell via Raydium/Jupiter.
 */

import "../lib/supabase-server"; // loads dotenv
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import bs58 from "bs58";

// ─── Program IDs ────────────────────────────────────────
const PUMPFUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMPFUN_GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const PUMPFUN_FEE_RECIPIENT = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM");
const PUMPFUN_EVENT_AUTHORITY = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// sell instruction discriminator (Anchor: first 8 bytes of SHA256("global:sell"))
const SELL_DISC = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);

// ─── Env / wallet ───────────────────────────────────────
function getConnection() {
  const k = process.env.HELIUS_API_KEY;
  if (!k) throw new Error("HELIUS_API_KEY not set");
  return new Connection(`https://mainnet.helius-rpc.com/?api-key=${k}`, "confirmed");
}
function getKeypair() {
  const sk = process.env.PHANTOM_PRIVATE_KEY;
  if (!sk) throw new Error("PHANTOM_PRIVATE_KEY not set");
  return Keypair.fromSecretKey(bs58.decode(sk));
}

// Associated token account derivation (works for both Token and Token-2022)
function getAta(owner: PublicKey, mint: PublicKey, program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), program.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM
  )[0];
}

// Bonding curve PDA: seeds = ["bonding-curve", mint]
function getBondingCurve(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMPFUN_PROGRAM
  )[0];
}

// ─── Main ───────────────────────────────────────────────
async function main() {
  const mintStr = process.argv[2];
  if (!mintStr) {
    console.error("Usage: npx tsx sell-pumpfun.ts <MINT_ADDRESS>");
    process.exit(1);
  }

  const conn = getConnection();
  const kp = getKeypair();
  const owner = kp.publicKey;
  const mint = new PublicKey(mintStr);

  console.log(`\n=== pump.fun direct sell ===`);
  console.log(`Wallet: ${owner.toBase58()}`);
  console.log(`Mint:   ${mintStr}\n`);

  // 1. Determine token program (pump.fun tokens use standard SPL, but some use Token-2022)
  const mintInfo = await conn.getAccountInfo(mint);
  if (!mintInfo) throw new Error("Mint account not found");
  const tokenProgram = mintInfo.owner.equals(TOKEN_2022_PROGRAM) ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
  console.log(`Token program: ${tokenProgram.equals(TOKEN_2022_PROGRAM) ? "Token-2022" : "Token"}`);

  // 2. Fetch token balance
  const userAta = getAta(owner, mint, tokenProgram);
  const balInfo = await conn.getTokenAccountBalance(userAta);
  const amount = BigInt(balInfo.value.amount);
  if (amount === BigInt(0)) {
    console.log("No tokens to sell. Exiting.");
    return;
  }
  console.log(`Holding: ${balInfo.value.uiAmountString} (raw: ${amount})`);

  // 3. Check bonding curve state — has it graduated?
  const bondingCurve = getBondingCurve(mint);
  const bcInfo = await conn.getAccountInfo(bondingCurve);
  if (!bcInfo) {
    console.error(`\n❌ Bonding curve account does not exist — token has graduated to Raydium.`);
    console.error(`   Use Jupiter/Raydium to sell instead (jup.ag).`);
    return;
  }
  // Bonding curve account: first 8 bytes discriminator, then virtual_token_reserves (u64),
  // virtual_sol_reserves (u64), real_token_reserves (u64), real_sol_reserves (u64),
  // token_total_supply (u64), complete (bool).
  // The "complete" flag at offset 8+5*8 = 48 indicates graduation.
  if (bcInfo.data.length >= 49) {
    const complete = bcInfo.data.readUInt8(48) === 1;
    if (complete) {
      console.error(`\n❌ Bonding curve marked complete — token graduated to Raydium.`);
      console.error(`   Use Jupiter/Raydium to sell instead (jup.ag).`);
      return;
    }
  }
  console.log(`Bonding curve: active ✓`);

  // 4. Build sell instruction
  //    Accounts (order matters — matches pump.fun IDL):
  //      0  global (read)
  //      1  fee_recipient (write)
  //      2  mint (read)
  //      3  bonding_curve (write)
  //      4  associated_bonding_curve (write) — ATA of bonding_curve for mint
  //      5  associated_user (write) — user's ATA
  //      6  user (write, signer)
  //      7  system_program (read)
  //      8  associated_token_program (read)
  //      9  token_program (read)
  //     10  event_authority (read)
  //     11  program (read)
  const associatedBondingCurve = getAta(bondingCurve, mint, tokenProgram);

  // Args: amount (u64 LE) + min_sol_output (u64 LE)
  // Accept total slippage — we just want out. min_sol_output=0 means accept any amount.
  const data = Buffer.alloc(8 + 8 + 8);
  SELL_DISC.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  data.writeBigUInt64LE(BigInt(0), 16); // min_sol_output = 0 (accept anything)

  const sellIx = new TransactionInstruction({
    programId: PUMPFUN_PROGRAM,
    keys: [
      { pubkey: PUMPFUN_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PUMPFUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: PUMPFUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMPFUN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data,
  });

  // Add priority fee + compute budget for reliability
  const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 });
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });

  const balBefore = await conn.getBalance(owner);
  console.log(`\nSOL before: ${(balBefore / 1e9).toFixed(6)}`);

  // 5. Send
  const tx = new Transaction().add(priorityIx).add(cuIx).add(sellIx);
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = owner;
  tx.sign(kp);

  console.log(`Sending sell tx...`);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  console.log(`Sig: ${sig}`);
  console.log(`Waiting for confirmation (up to 60s)...`);

  try {
    const conf = await conn.confirmTransaction(sig, "confirmed");
    if (conf.value.err) {
      console.error(`\n❌ Tx FAILED on-chain: ${JSON.stringify(conf.value.err)}`);
      console.error(`   View: https://solscan.io/tx/${sig}`);
      return;
    }
  } catch (e: any) {
    console.error(`\n⏳ Confirmation timeout — check manually: https://solscan.io/tx/${sig}`);
    return;
  }

  const balAfter = await conn.getBalance(owner);
  const received = (balAfter - balBefore) / 1e9;
  console.log(`\n✅ SELL SUCCESS`);
  console.log(`   Tx:          https://solscan.io/tx/${sig}`);
  console.log(`   SOL before:  ${(balBefore / 1e9).toFixed(6)}`);
  console.log(`   SOL after:   ${(balAfter / 1e9).toFixed(6)}`);
  console.log(`   SOL received: ${received >= 0 ? "+" : ""}${received.toFixed(6)} SOL`);
}

main().catch((e) => {
  console.error("\n❌ ERROR:", e.message || e);
  process.exit(1);
});
