/**
 * Q2 — burn worthless rugged tokens then close their accounts to recover rent.
 * Two specific SPL (not Token-2022) mints with no Jupiter route.
 */
import "../lib/supabase-server";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";

const SPL_TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const ORPHAN_MINTS = [
  "CWiBLktjXbTV1LBacHxKHNvCdnwnxq6DE83y4m62UzJG",
  "Ahuh89D2cBxfmYAE2sjgDQzc7VfmjypH8MV6GHAUL38X",
];

function getConnection(): Connection {
  return new Connection(
    `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
    "confirmed"
  );
}
function getKeypair(): Keypair {
  return Keypair.fromSecretKey(bs58.decode(process.env.PHANTOM_PRIVATE_KEY!));
}

// SPL Token instruction 8 = Burn. Data: [8, amount_u64_LE]
function burnIx(account: PublicKey, mint: PublicKey, owner: PublicKey, amountRaw: bigint): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(8, 0);
  data.writeBigUInt64LE(amountRaw, 1);
  return new TransactionInstruction({
    programId: SPL_TOKEN,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}
// SPL Token instruction 9 = CloseAccount.
function closeIx(account: PublicKey, dest: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: SPL_TOKEN,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

async function main() {
  const conn = getConnection();
  const kp = getKeypair();
  const owner = kp.publicKey;

  const balBefore = await conn.getBalance(owner);
  console.log(`SOL before: ${(balBefore / 1e9).toFixed(6)}\n`);

  for (const mintStr of ORPHAN_MINTS) {
    const mint = new PublicKey(mintStr);
    const accs = await conn.getParsedTokenAccountsByOwner(owner, { mint });
    if (accs.value.length === 0) {
      console.log(`  ${mintStr.slice(0, 8)} — no account, skip`);
      continue;
    }
    const acc = accs.value[0];
    const accountPk = acc.pubkey;
    const rawAmount = BigInt(acc.account.data.parsed.info.tokenAmount.amount);

    console.log(`  ${mintStr.slice(0, 8)} — burning ${rawAmount}, then closing account`);

    const tx = new Transaction()
      .add(burnIx(accountPk, mint, owner, rawAmount))
      .add(closeIx(accountPk, owner, owner));

    try {
      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = owner;
      tx.sign(kp);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await conn.confirmTransaction(sig, "confirmed");
      console.log(`    ✅ ${sig}\n`);
    } catch (e: any) {
      console.error(`    ❌ ${e.message}\n`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  const balAfter = await conn.getBalance(owner);
  const recovered = (balAfter - balBefore) / 1e9;
  console.log(`SOL after: ${(balAfter / 1e9).toFixed(6)} (${recovered >= 0 ? "+" : ""}${recovered.toFixed(6)})`);
}

main().catch(console.error);
