// For a trade with null sell_tx_sig, search wallet signatures to find
// the actual sell and compute real_pnl_sol from it.
import { createClient } from "@supabase/supabase-js";
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
  const sb = createClient(
    map.NEXT_PUBLIC_SUPABASE_URL!,
    map.SUPABASE_SERVICE_ROLE_KEY || map.SUPABASE_ANON_KEY || map.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${map.HELIUS_API_KEY}`, "confirmed");

  const coinName = process.argv[2] || "IXCOIN";
  const { data: row } = await sb.from("trades").select("*").eq("coin_name", coinName).order("entry_time", { ascending: false }).limit(1).maybeSingle();
  if (!row) { console.log("No row"); return; }
  console.log(`\n=== ${coinName} (${row.id}) ===`);
  console.log(`coin_address: ${row.coin_address}`);
  console.log(`entry_sol_cost: ${row.entry_sol_cost}`);
  console.log(`entry_time: ${row.entry_time}`);
  console.log(`exit_time: ${row.exit_time}`);
  console.log(`buy_tx_sig: ${row.buy_tx_sig}`);
  console.log(`sell_tx_sig: ${row.sell_tx_sig}`);

  // Walk wallet signatures starting after buy_tx_sig to find sells on this mint
  const walletPubkey = new PublicKey("ESK3r8n5jhaLn9Few59QKNJ5UMeD9iqZ5p1rbU9euvey");
  console.log(`\nSearching wallet signatures for mint ${row.coin_address}...`);

  // Get signatures with entry_time as 'before' cursor
  const sigs = await conn.getSignaturesForAddress(walletPubkey, { limit: 200 });
  const entryMs = new Date(row.entry_time).getTime() / 1000;
  const exitMs = row.exit_time ? new Date(row.exit_time).getTime() / 1000 : Date.now() / 1000;

  console.log(`Entry at: ${new Date(entryMs * 1000).toISOString()}`);
  console.log(`Exit at:  ${new Date(exitMs * 1000).toISOString()}`);
  console.log(`Scanning ${sigs.length} recent signatures for this mint...\n`);

  for (const s of sigs) {
    if (!s.blockTime) continue;
    if (s.blockTime < entryMs - 60 || s.blockTime > exitMs + 300) continue; // window
    if (s.signature === row.buy_tx_sig) continue;

    try {
      const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      if (!tx) continue;
      const pre = tx.meta?.preTokenBalances ?? [];
      const post = tx.meta?.postTokenBalances ?? [];
      // Check if this tx moved our tokens of this mint
      const hasMint = [...pre, ...post].some((tb) => tb.mint === row.coin_address);
      if (!hasMint) continue;

      // Find fee payer (our wallet)
      const feePayer = tx.transaction.message.staticAccountKeys?.[0]?.toBase58();
      if (feePayer !== "ESK3r8n5jhaLn9Few59QKNJ5UMeD9iqZ5p1rbU9euvey") continue;

      // SOL delta
      const solDelta = ((tx.meta?.postBalances?.[0] ?? 0) - (tx.meta?.preBalances?.[0] ?? 0) + (tx.meta?.fee ?? 0)) / 1e9;
      // Token delta for this mint
      const ourPre = pre.find((tb) => tb.owner === feePayer && tb.mint === row.coin_address);
      const ourPost = post.find((tb) => tb.owner === feePayer && tb.mint === row.coin_address);
      const tokenDelta = Number(ourPost?.uiTokenAmount?.uiAmount ?? 0) - Number(ourPre?.uiTokenAmount?.uiAmount ?? 0);

      if (tokenDelta < 0 && solDelta > 0) {
        // This is a SELL tx
        console.log(`✅ Found SELL:`);
        console.log(`  Sig: ${s.signature}`);
        console.log(`  Block time: ${new Date(s.blockTime * 1000).toISOString()}`);
        console.log(`  Tokens sold: ${Math.abs(tokenDelta)}`);
        console.log(`  SOL received: ${solDelta.toFixed(6)}`);
        const entryCost = Number(row.entry_sol_cost);
        const realPnl = solDelta - entryCost;
        console.log(`  Entry cost: ${entryCost}`);
        console.log(`  REAL PnL: ${realPnl >= 0 ? "+" : ""}${realPnl.toFixed(6)} SOL`);
        console.log(`\n=== Backfilling DB ===`);

        const { error } = await sb
          .from("trades")
          .update({ sell_tx_sig: s.signature, real_pnl_sol: realPnl })
          .eq("id", row.id);
        if (error) console.log(`⚠️ Update failed: ${error.message}`);
        else console.log(`✅ DB updated.`);
        return;
      }
    } catch {}
  }
  console.log("No sell tx found in window.");
}
main().catch((e) => { console.error(e); process.exit(1); });
