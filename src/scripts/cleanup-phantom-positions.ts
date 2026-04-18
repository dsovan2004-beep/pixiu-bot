/**
 * One-time cleanup: close all open [LIVE] positions where wallet has zero
 * tokens for that mint. Uses the same "locked PnL" logic as the patched guard:
 *   - grid_level > 0 → close at partial_pnl (profits already banked)
 *   - grid_level = 0 → close at current pnl (rug loss)
 */
import "../lib/supabase-server";
import supabase from "../lib/supabase-server";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

function conn() {
  return new Connection(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, "confirmed");
}
function kp() { return Keypair.fromSecretKey(bs58.decode(process.env.PHANTOM_PRIVATE_KEY!)); }

async function held(c: Connection, owner: PublicKey, mint: string): Promise<boolean> {
  const m = new PublicKey(mint);
  for (const p of [TOKEN, TOKEN_2022]) {
    try {
      const accs = await c.getParsedTokenAccountsByOwner(owner, { mint: m, programId: p });
      for (const a of accs.value) {
        if (Number(a.account.data.parsed?.info?.tokenAmount?.amount || 0) > 0) return true;
      }
    } catch {}
  }
  return false;
}

async function getCurrentPrice(mint: string): Promise<number> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (r.ok) {
      const d = await r.json();
      const p = d.pairs?.[0]?.priceUsd;
      if (p) return parseFloat(p);
    }
  } catch {}
  return 0;
}

(async () => {
  const c = conn();
  const owner = kp().publicKey;

  const { data: openLive } = await supabase
    .from("trades")
    .select("id, coin_name, coin_address, wallet_tag, entry_price, entry_time, grid_level, remaining_pct, partial_pnl, position_size_usd")
    .eq("status", "open")
    .like("wallet_tag", "%[LIVE]%");

  console.log(`Checking ${openLive?.length ?? 0} open [LIVE] positions...\n`);

  let closed = 0, kept = 0;
  let bankrollDelta = 0;

  for (const t of openLive || []) {
    const onchain = await held(c, owner, t.coin_address);
    if (onchain) {
      console.log(`  ✅ ${t.coin_name?.padEnd(28)} — tokens on-chain, leaving alone`);
      kept++;
      continue;
    }

    const gridLvl = t.grid_level ?? 0;
    const partialPnl = Number(t.partial_pnl ?? 0);
    const entryPrice = Number(t.entry_price);
    const posSize = Number(t.position_size_usd) || 100;

    let closedPnl: number;
    if (gridLvl > 0) {
      closedPnl = partialPnl;
    } else {
      const nowPrice = await getCurrentPrice(t.coin_address);
      closedPnl = entryPrice > 0 && nowPrice > 0
        ? ((nowPrice - entryPrice) / entryPrice) * 100
        : -100; // no price → assume total rug
    }
    const closedPnlUsd = (closedPnl / 100) * posSize;

    console.log(`  ${gridLvl > 0 ? "💰" : "🪦"} ${t.coin_name?.padEnd(28)} L${gridLvl} → close at ${closedPnl >= 0 ? "+" : ""}${closedPnl.toFixed(2)}% ($${closedPnlUsd.toFixed(2)})`);

    await supabase
      .from("trades")
      .update({
        pnl_pct: closedPnl,
        pnl_usd: closedPnlUsd,
        status: "closed",
        exit_time: new Date().toISOString(),
        exit_reason: gridLvl > 0 ? "take_profit" : "rug_or_missing",
        remaining_pct: 0,
        partial_pnl: closedPnl,
      })
      .eq("id", t.id);

    bankrollDelta += closedPnlUsd;
    closed++;
  }

  // Apply bankroll delta once
  if (bankrollDelta !== 0) {
    const { data: bk } = await supabase
      .from("DEPRECATED_DEPRECATED_bankroll")
      .select("id, current_balance, starting_balance")
      .limit(1)
      .single();
    if (bk) {
      const newBal = Number(bk.current_balance) + bankrollDelta;
      const newPnl = newBal - Number(bk.starting_balance || 10000);
      await supabase
        .from("DEPRECATED_DEPRECATED_bankroll")
        .update({
          current_balance: newBal,
          total_pnl_usd: newPnl,
          updated_at: new Date().toISOString(),
        })
        .eq("id", bk.id);
      console.log(`\nBankroll: $${Number(bk.current_balance).toFixed(2)} → $${newBal.toFixed(2)} (${bankrollDelta >= 0 ? "+" : ""}$${bankrollDelta.toFixed(2)})`);
    }
  }

  console.log(`\nDone: ${closed} closed, ${kept} real positions preserved`);
})();
