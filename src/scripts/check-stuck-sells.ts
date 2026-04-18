/**
 * Diagnostic — find stuck sells.
 *
 * Compares on-chain SPL token holdings (both Token + Token-2022 programs)
 * against open [LIVE] trades and recent failed sells. Reports:
 *   - Tokens held on-chain but DB says position is closed (orphans, recoverable SOL)
 *   - DB open positions where on-chain balance is 0 (already sold, DB stale)
 *   - DB open positions with non-zero balance still untracked by guard
 */

import "../lib/supabase-server"; // loads dotenv
import supabase from "../lib/supabase-server";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const WSOL_MINT = SOL_MINT;

function getConnection(): Connection {
  const heliusKey = process.env.HELIUS_API_KEY || "";
  return new Connection(
    `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
    "confirmed"
  );
}

function getKeypair(): Keypair {
  const sk = process.env.PHANTOM_PRIVATE_KEY || "";
  return Keypair.fromSecretKey(bs58.decode(sk));
}

interface Holding {
  mint: string;
  amount: number; // ui amount
  rawAmount: string;
  program: "spl" | "spl-2022";
}

async function getHoldings(): Promise<Holding[]> {
  const conn = getConnection();
  const owner = getKeypair().publicKey;

  const out: Holding[] = [];
  for (const [program, label] of [
    [TOKEN_PROGRAM, "spl"] as const,
    [TOKEN_2022_PROGRAM, "spl-2022"] as const,
  ]) {
    const res = await conn.getParsedTokenAccountsByOwner(owner, { programId: program });
    for (const { account } of res.value) {
      const info: any = account.data.parsed.info;
      const mint: string = info.mint;
      const ui: number = info.tokenAmount.uiAmount ?? 0;
      const raw: string = info.tokenAmount.amount;
      if (mint === WSOL_MINT) continue; // skip wrapped SOL
      if (ui > 0) out.push({ mint, amount: ui, rawAmount: raw, program: label });
    }
  }
  return out;
}

async function main() {
  console.log("\n=== Stuck Sell Diagnostic ===\n");

  const wallet = getKeypair().publicKey.toBase58();
  console.log(`Wallet: ${wallet}\n`);

  const holdings = await getHoldings();
  console.log(`On-chain non-zero token accounts: ${holdings.length}`);

  const { data: openLive } = await supabase
    .from("trades")
    .select("id, coin_address, coin_name, wallet_tag, entry_time, status, exit_reason")
    .eq("status", "open")
    .like("wallet_tag", "%[LIVE]%");

  const { data: recentClosed } = await supabase
    .from("trades")
    .select("id, coin_address, coin_name, exit_time, exit_reason")
    .eq("status", "closed")
    .like("wallet_tag", "%[LIVE]%")
    .gte("exit_time", new Date(Date.now() - 48 * 3600_000).toISOString());

  const openByMint = new Map((openLive || []).map((t) => [t.coin_address, t]));
  const closedByMint = new Map((recentClosed || []).map((t) => [t.coin_address, t]));

  const orphans: Holding[] = [];
  const tracked: Array<{ h: Holding; trade: any }> = [];
  const closedButHeld: Array<{ h: Holding; trade: any }> = [];

  for (const h of holdings) {
    if (openByMint.has(h.mint)) {
      tracked.push({ h, trade: openByMint.get(h.mint) });
    } else if (closedByMint.has(h.mint)) {
      closedButHeld.push({ h, trade: closedByMint.get(h.mint) });
    } else {
      orphans.push(h);
    }
  }

  // DB open but on-chain zero (stale rows)
  const heldMints = new Set(holdings.map((h) => h.mint));
  const staleOpen = (openLive || []).filter((t) => !heldMints.has(t.coin_address));

  console.log(`\nDB open [LIVE] positions: ${(openLive || []).length}`);
  console.log(`DB closed [LIVE] (last 48h): ${(recentClosed || []).length}\n`);

  console.log(`--- A. STUCK SELLS (closed in DB but tokens still in wallet) — ${closedButHeld.length} ---`);
  for (const { h, trade } of closedButHeld) {
    console.log(
      `  • ${trade.coin_name || h.mint.slice(0, 8)} | mint=${h.mint} | amount=${h.amount} | exit_reason=${trade.exit_reason} | exit=${trade.exit_time}`
    );
  }
  if (closedButHeld.length === 0) console.log("  (none)\n");
  else console.log();

  console.log(`--- B. ORPHANS (tokens in wallet, no matching trade row) — ${orphans.length} ---`);
  for (const h of orphans) {
    console.log(`  • mint=${h.mint} | amount=${h.amount} | program=${h.program}`);
  }
  if (orphans.length === 0) console.log("  (none)\n");
  else console.log();

  console.log(`--- C. OPEN POSITIONS (tracked, guard should be monitoring) — ${tracked.length} ---`);
  for (const { h, trade } of tracked) {
    console.log(
      `  • ${trade.coin_name || h.mint.slice(0, 8)} | mint=${h.mint} | amount=${h.amount} | entry=${trade.entry_time}`
    );
  }
  if (tracked.length === 0) console.log("  (none)\n");
  else console.log();

  console.log(`--- D. STALE DB OPEN ROWS (no on-chain balance, sell already happened) — ${staleOpen.length} ---`);
  for (const t of staleOpen) {
    console.log(`  • ${t.coin_name || t.coin_address.slice(0, 8)} | id=${t.id} | entry=${t.entry_time}`);
  }
  if (staleOpen.length === 0) console.log("  (none)\n");
  else console.log();

  const recoverable = closedButHeld.length + orphans.length;
  console.log(`\n=== SUMMARY ===`);
  console.log(`Recoverable SOL (run sell-all-orphans-style script on these): ${recoverable} mints`);
  console.log(`Stale DB rows (mark closed manually): ${staleOpen.length}`);

  if (recoverable > 0) {
    console.log(`\nMints to sell:`);
    [...closedButHeld.map((x) => x.h.mint), ...orphans.map((h) => h.mint)].forEach((m) =>
      console.log(`  "${m}",`)
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
