// Verify a trade's real_pnl_sol against on-chain tx data.
// Fetches the sell_tx_sig and re-computes the SOL delta to compare with
// what was booked. Detects parseSwapSolDelta misattributions.

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

  const coinName = process.argv[2] || "SchemingProfitLaunderingcrime";
  const { data: rows } = await sb
    .from("trades")
    .select("id, coin_name, coin_address, entry_sol_cost, real_pnl_sol, buy_tx_sig, sell_tx_sig, grid_level, remaining_pct, partial_pnl, exit_reason, entry_price, exit_price, entry_time, exit_time, wallet_tag, status")
    .eq("coin_name", coinName)
    .order("entry_time", { ascending: false })
    .limit(3);

  if (!rows || rows.length === 0) { console.log(`No rows for ${coinName}`); return; }

  for (const t of rows) {
    console.log(`\n=== ${t.coin_name} (${t.id}) ===`);
    console.log(`wallet_tag:      ${t.wallet_tag}`);
    console.log(`status:          ${t.status}`);
    console.log(`entry_price:     $${t.entry_price}`);
    console.log(`exit_price:      $${t.exit_price}`);
    console.log(`entry_sol_cost:  ${t.entry_sol_cost}`);
    console.log(`real_pnl_sol:    ${t.real_pnl_sol}  <-- what we booked`);
    console.log(`grid_level:      L${t.grid_level}, remaining_pct: ${t.remaining_pct}`);
    console.log(`partial_pnl:     ${t.partial_pnl}`);
    console.log(`exit_reason:     ${t.exit_reason}`);
    console.log(`buy_tx_sig:      ${t.buy_tx_sig}`);
    console.log(`sell_tx_sig:     ${t.sell_tx_sig}`);

    // Get the wallet's pubkey from the first tx (via fee payer)
    if (t.sell_tx_sig) {
      try {
        const tx = await conn.getTransaction(t.sell_tx_sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        if (!tx) { console.log(`  Sell tx not found on-chain`); continue; }

        const feePayer = tx.transaction.message.staticAccountKeys?.[0]?.toBase58() ?? "?";
        const pre = tx.meta?.preBalances ?? [];
        const post = tx.meta?.postBalances ?? [];
        const fee = tx.meta?.fee ?? 0;

        console.log(`  fee payer:       ${feePayer}`);
        console.log(`  tx fee:          ${fee / 1e9} SOL`);

        // Index 0 is always fee payer
        if (pre.length > 0 && post.length > 0) {
          const deltaLamports = post[0] - pre[0];
          const deltaSOL = deltaLamports / 1e9;
          // SOL received = delta + fee (since fee is deducted from pre)
          const solReceived = deltaSOL + fee / 1e9;
          console.log(`  wallet delta:    ${deltaSOL >= 0 ? "+" : ""}${deltaSOL.toFixed(6)} SOL`);
          console.log(`  SOL received:    ${solReceived.toFixed(6)} SOL (= delta + fee)`);

          const entryCost = t.entry_sol_cost ? Number(t.entry_sol_cost) : null;
          if (entryCost !== null) {
            const expectedPnl = solReceived - entryCost;
            console.log(`  expected PnL:    ${expectedPnl >= 0 ? "+" : ""}${expectedPnl.toFixed(6)} SOL (= received ${solReceived.toFixed(6)} - cost ${entryCost.toFixed(6)})`);
            console.log(`  booked PnL:      ${t.real_pnl_sol}`);
            const gap = Math.abs((Number(t.real_pnl_sol ?? 0)) - expectedPnl);
            console.log(`  gap:             ${gap.toFixed(6)} SOL ${gap > 0.005 ? "⚠️ MISMATCH" : "✓ matches"}`);
          }
        }
      } catch (err: any) {
        console.log(`  Tx fetch failed: ${err.message}`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
