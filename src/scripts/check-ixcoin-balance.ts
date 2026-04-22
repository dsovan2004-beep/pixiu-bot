import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "fs";
import { join } from "path";

async function main() {
  const env = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  const map: Record<string, string> = {};
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${map.HELIUS_API_KEY}`, "confirmed");

  // Derive our wallet's ATA for IXCOIN
  const mint = "AcJACDC1DeFQLrJnjr62uxmt7UZuTDE4yngYF6pnpump"; // need to get this
  console.log("Check the buy_tx_sig to find IXCOIN mint address...");
  console.log("BUY sig: 4Zr9rmKWzGg6rXkKtywQf2VCjS6M3vVnA8dEwpVXvbKzJNAH1XoQjsuTzeFFuM5JCY85PL5DzLKkuhwxC3xd8er5");
  const tx = await conn.getTransaction("4Zr9rmKWzGg6rXkKtywQf2VCjS6M3vVnA8dEwpVXvbKzJNAH1XoQjsuTzeFFuM5JCY85PL5DzLKkuhwxC3xd8er5", { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) { console.log("Buy tx not found"); return; }

  // Find token balance changes
  const postTokenBalances = tx.meta?.postTokenBalances ?? [];
  const feePayer = tx.transaction.message.staticAccountKeys?.[0]?.toBase58();
  console.log(`Fee payer (our wallet): ${feePayer}`);
  for (const tb of postTokenBalances) {
    if (tb.owner === feePayer) {
      console.log(`  Token: ${tb.mint}`);
      console.log(`  Balance after buy: ${tb.uiTokenAmount?.uiAmountString}`);
      // Now check current balance
      const ata = await conn.getTokenAccountsByOwner(new PublicKey(feePayer!), { mint: new PublicKey(tb.mint) });
      if (ata.value.length > 0) {
        const bal = await conn.getTokenAccountBalance(ata.value[0].pubkey);
        console.log(`  Current balance: ${bal.value.uiAmountString}`);
        if (Number(bal.value.uiAmountString || 0) > 0) {
          console.log(`  ⚠️ STILL HOLDING TOKENS — phantom closed row (real_pnl_sol=null but we own the bag)`);
        } else {
          console.log(`  ✓ Balance is 0 — tokens were sold somewhere (just not recorded in DB)`);
        }
      } else {
        console.log(`  ✓ No ATA — tokens already closed`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
