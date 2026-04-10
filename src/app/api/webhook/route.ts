/**
 * PixiuBot — Helius Webhook Receiver
 * POST /api/webhook
 *
 * Receives enhanced transaction data from Helius when tracked wallets swap.
 * Validates via RugCheck, resolves token name, inserts into coin_signals.
 */

import { createClient } from "@supabase/supabase-js";

export const runtime = "edge";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

// Mints to ignore
const IGNORE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

// ─── RugCheck ────────────────────────────────────────────

async function checkRug(
  mint: string
): Promise<{ passed: boolean; tokenName: string | null }> {
  try {
    const res = await fetch(
      `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`
    );
    if (!res.ok) return { passed: false, tokenName: null };

    const data = await res.json();

    const isHoneypot =
      data.risks?.some((r: any) =>
        r.name?.toLowerCase().includes("honeypot")
      ) ?? false;

    const lpUnlocked =
      data.risks?.some(
        (r: any) =>
          r.name?.toLowerCase().includes("lp unlocked") ||
          r.name?.toLowerCase().includes("liquidity unlocked")
      ) ?? false;

    const tokenName =
      data.tokenMeta?.name || data.tokenMeta?.symbol || null;

    return { passed: !isHoneypot && !lpUnlocked, tokenName };
  } catch {
    return { passed: false, tokenName: null };
  }
}

// ─── Token Name via DexScreener (no Helius RPC needed) ───

async function getTokenName(mint: string): Promise<string> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`
    );
    if (res.ok) {
      const data = await res.json();
      const name = data.pairs?.[0]?.baseToken?.name;
      if (name) return name;
    }
  } catch {}
  return mint.slice(0, 8) + "...";
}

// ─── Wallet Tag Lookup ───────────────────────────────────

async function getWalletTag(address: string): Promise<string> {
  const { data } = await supabase
    .from("tracked_wallets")
    .select("tag")
    .eq("wallet_address", address)
    .limit(1)
    .single();
  return data?.tag || address.slice(0, 8);
}

// ─── Extract Buy Mints from Enhanced TX ──────────────────

interface EnhancedTx {
  signature: string;
  timestamp: number;
  type: string;
  source: string;
  feePayer: string;
  tokenTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    tokenAmount: number;
    mint: string;
  }>;
  accountData?: Array<{
    account: string;
    tokenBalanceChanges?: Array<{
      userAccount: string;
      mint: string;
      rawTokenAmount: { tokenAmount: string };
    }>;
  }>;
}

function extractBuys(
  tx: EnhancedTx,
  trackedAddresses: Set<string>
): Array<{ mint: string; wallet: string }> {
  const buys: Array<{ mint: string; wallet: string }> = [];

  // Check token transfers
  for (const t of tx.tokenTransfers || []) {
    if (
      trackedAddresses.has(t.toUserAccount) &&
      t.tokenAmount > 0 &&
      !IGNORE_MINTS.has(t.mint)
    ) {
      buys.push({ mint: t.mint, wallet: t.toUserAccount });
    }
  }

  // Fallback: token balance changes
  if (buys.length === 0) {
    for (const acct of tx.accountData || []) {
      for (const change of acct.tokenBalanceChanges || []) {
        const amount = Number(change.rawTokenAmount?.tokenAmount || 0);
        if (
          trackedAddresses.has(change.userAccount) &&
          amount > 0 &&
          !IGNORE_MINTS.has(change.mint)
        ) {
          buys.push({ mint: change.mint, wallet: change.userAccount });
        }
      }
    }
  }

  // Dedupe by mint+wallet
  const seen = new Set<string>();
  return buys.filter((b) => {
    const key = `${b.mint}:${b.wallet}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── POST Handler ────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();

    // Helius sends an array of enhanced transactions
    const transactions: EnhancedTx[] = Array.isArray(body) ? body : [body];

    // Load tracked wallet addresses for lookup
    const { data: wallets } = await supabase
      .from("tracked_wallets")
      .select("wallet_address")
      .eq("active", true);

    const trackedSet = new Set(
      wallets?.map((w) => w.wallet_address) || []
    );

    let signalCount = 0;

    for (const tx of transactions) {
      // Only process swaps
      if (tx.type !== "SWAP") continue;

      const buys = extractBuys(tx, trackedSet);
      if (buys.length === 0) continue;

      for (const { mint, wallet } of buys) {
        // Rug check
        const { passed, tokenName: rugName } = await checkRug(mint);
        if (!passed) continue;

        // Resolve name
        const coinName = rugName || (await getTokenName(mint));

        // Wallet tag
        const walletTag = await getWalletTag(wallet);

        // Time gap
        const signalTime = new Date(tx.timestamp * 1000);
        const gapMinutes = Math.round(
          (Date.now() - signalTime.getTime()) / 60_000
        );

        // Insert signal
        await supabase.from("coin_signals").insert({
          coin_address: mint,
          coin_name: coinName,
          wallet_tag: walletTag,
          entry_mc: null,
          rug_check_passed: true,
          price_gap_minutes: gapMinutes,
        });

        signalCount++;
      }
    }

    return new Response(
      JSON.stringify({ ok: true, signals: signalCount }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("Webhook error:", err.message);
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Health check
export async function GET(): Promise<Response> {
  return new Response(
    JSON.stringify({ status: "ok", service: "pixiu-bot-webhook" }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
