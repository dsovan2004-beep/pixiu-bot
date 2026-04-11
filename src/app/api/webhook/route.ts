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

interface SwapSignal {
  mint: string;
  wallet: string;
  type: "BUY" | "SELL";
}

function extractSwaps(
  tx: EnhancedTx,
  trackedAddresses: Set<string>
): SwapSignal[] {
  const signals: SwapSignal[] = [];

  for (const t of tx.tokenTransfers || []) {
    if (IGNORE_MINTS.has(t.mint)) continue;

    // BUY: tracked wallet received tokens
    if (trackedAddresses.has(t.toUserAccount) && t.tokenAmount > 0) {
      signals.push({ mint: t.mint, wallet: t.toUserAccount, type: "BUY" });
    }

    // SELL: tracked wallet sent tokens
    if (trackedAddresses.has(t.fromUserAccount) && t.tokenAmount > 0) {
      signals.push({ mint: t.mint, wallet: t.fromUserAccount, type: "SELL" });
    }
  }

  // Fallback: token balance changes
  if (signals.length === 0) {
    for (const acct of tx.accountData || []) {
      for (const change of acct.tokenBalanceChanges || []) {
        if (IGNORE_MINTS.has(change.mint)) continue;
        const amount = Number(change.rawTokenAmount?.tokenAmount || 0);
        if (!trackedAddresses.has(change.userAccount)) continue;

        if (amount > 0) {
          signals.push({ mint: change.mint, wallet: change.userAccount, type: "BUY" });
        } else if (amount < 0) {
          signals.push({ mint: change.mint, wallet: change.userAccount, type: "SELL" });
        }
      }
    }
  }

  // Dedupe by mint+wallet+type
  const seen = new Set<string>();
  return signals.filter((s) => {
    const key = `${s.mint}:${s.wallet}:${s.type}`;
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
      if (tx.type !== "SWAP") continue;

      const swaps = extractSwaps(tx, trackedSet);
      if (swaps.length === 0) continue;

      for (const { mint, wallet, type } of swaps) {
        const walletTag = await getWalletTag(wallet);
        const signalTime = new Date(tx.timestamp * 1000);
        const gapMinutes = Math.round(
          (Date.now() - signalTime.getTime()) / 60_000
        );

        if (type === "SELL") {
          // SELL signals: no rug check needed, just log
          const coinName = await getTokenName(mint);
          await supabase.from("coin_signals").insert({
            coin_address: mint,
            coin_name: coinName,
            wallet_tag: walletTag,
            entry_mc: null,
            rug_check_passed: true,
            price_gap_minutes: gapMinutes,
            bundle_suspected: false,
            transaction_type: "SELL",
          });
          signalCount++;
          continue;
        }

        // BUY signals: rug check + bundle detection
        const { passed, tokenName: rugName } = await checkRug(mint);
        if (!passed) continue;

        const coinName = rugName || (await getTokenName(mint));

        let bundleSuspected = false;
        const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
        const { count: recentCount } = await supabase
          .from("coin_signals")
          .select("id", { count: "exact", head: true })
          .eq("coin_address", mint)
          .eq("wallet_tag", walletTag)
          .eq("transaction_type", "BUY")
          .gte("signal_time", fiveMinAgo);

        if ((recentCount || 0) >= 2) {
          bundleSuspected = true;
        }

        await supabase.from("coin_signals").insert({
          coin_address: mint,
          coin_name: coinName,
          wallet_tag: walletTag,
          entry_mc: null,
          rug_check_passed: true,
          price_gap_minutes: gapMinutes,
          bundle_suspected: bundleSuspected,
          transaction_type: "BUY",
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
