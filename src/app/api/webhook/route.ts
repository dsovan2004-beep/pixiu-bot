/**
 * PixiuBot — Helius Webhook Receiver + Instant Entry
 * POST /api/webhook
 *
 * Receives Helius push → inserts signal → evaluates entry → opens paper trade.
 * Millisecond entry from webhook push. No polling delay.
 */

import { createClient } from "@supabase/supabase-js";
import {
  TOP_ELITE_ADDRESSES,
  MAX_GAP_MINUTES,
  MAX_ENTRY_MC,
  RECENTLY_TRADED_COOLDOWN_MS,
  POSITION_SIZE_PCT,
} from "@/config/smart-money";
import { isPriceTooHigh } from "@/lib/price-guards";

export const runtime = "edge";

// Stablecoin name filter — reject scam tokens using stablecoin names
const STABLECOIN_KEYWORDS = [
  "usd", "usdc", "usdt", "usds", "dai", "busd", "frax",
  "stable", "peg", "dollar", "euro", "eur",
];

function isStablecoinName(name: string): boolean {
  const lower = name.toLowerCase();
  return STABLECOIN_KEYWORDS.some((kw) => lower.includes(kw));
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const MIN_LIQUIDITY_USD = 10_000;

async function checkLiquidity(mint: string): Promise<{ liquidity: number | null; passed: boolean }> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (res.ok) {
      const data = await res.json();
      const liq = data.pairs?.[0]?.liquidity?.usd;
      if (typeof liq === "number") return { liquidity: liq, passed: liq >= MIN_LIQUIDITY_USD };
    }
  } catch {}
  return { liquidity: null, passed: true };
}

async function checkLpAndHolders(mint: string): Promise<{ lpSafe: boolean; holdersSafe: boolean }> {
  try {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
    if (res.ok) {
      const data = await res.json();
      const risks: Array<{ name: string; level: string }> = data.risks || [];
      const lpDanger = risks.some((r) => r.name?.toLowerCase().includes("lp") && r.level === "danger");
      const top10Pct: number = data.top10HoldersPercent ?? 0;
      if (lpDanger) return { lpSafe: false, holdersSafe: top10Pct <= 80 };
      if (top10Pct > 80) return { lpSafe: true, holdersSafe: false };
      return { lpSafe: true, holdersSafe: true };
    }
  } catch {}
  return { lpSafe: true, holdersSafe: true };
}

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
    const isHoneypot = data.risks?.some((r: any) => r.name?.toLowerCase().includes("honeypot")) ?? false;
    const lpUnlocked = data.risks?.some((r: any) =>
      r.name?.toLowerCase().includes("lp unlocked") || r.name?.toLowerCase().includes("liquidity unlocked")
    ) ?? false;
    const tokenName = data.tokenMeta?.name || data.tokenMeta?.symbol || null;
    return { passed: !isHoneypot && !lpUnlocked, tokenName };
  } catch {
    return { passed: false, tokenName: null };
  }
}

// ─── Token Name ──────────────────────────────────────────

async function getTokenName(mint: string): Promise<string> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (res.ok) {
      const data = await res.json();
      const name = data.pairs?.[0]?.baseToken?.name;
      if (name) return name;
    }
  } catch {}
  return mint.slice(0, 8) + "...";
}

// ─── Price ───────────────────────────────────────────────

async function getPrice(mint: string): Promise<{ price: number; source: string }> {
  try {
    const res = await fetch(`https://price.jup.ag/v6/price?ids=${mint}`);
    if (res.ok) {
      const data = await res.json();
      const price = data.data?.[mint]?.price;
      if (typeof price === "number" && price > 0) return { price, source: "jupiter" };
    }
  } catch {}
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (res.ok) {
      const data = await res.json();
      const p = data.pairs?.[0]?.priceUsd;
      if (p) { const price = parseFloat(p); if (price > 0) return { price, source: "dexscreener" }; }
    }
  } catch {}
  return { price: 0, source: "none" };
}

// ─── Wallet Helpers ──────────────────────────────────────

async function getWalletTag(address: string): Promise<string> {
  const { data } = await supabase
    .from("tracked_wallets")
    .select("tag")
    .eq("wallet_address", address)
    .limit(1)
    .single();
  return data?.tag || address.slice(0, 8);
}

// ─── Extract Swaps ───────────────────────────────────────

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

interface SwapSignal { mint: string; wallet: string; type: "BUY" | "SELL"; }

function extractSwaps(tx: EnhancedTx, tracked: Set<string>): SwapSignal[] {
  const signals: SwapSignal[] = [];
  for (const t of tx.tokenTransfers || []) {
    if (IGNORE_MINTS.has(t.mint)) continue;
    if (tracked.has(t.toUserAccount) && t.tokenAmount > 0)
      signals.push({ mint: t.mint, wallet: t.toUserAccount, type: "BUY" });
    if (tracked.has(t.fromUserAccount) && t.tokenAmount > 0)
      signals.push({ mint: t.mint, wallet: t.fromUserAccount, type: "SELL" });
  }
  if (signals.length === 0) {
    for (const acct of tx.accountData || []) {
      for (const change of acct.tokenBalanceChanges || []) {
        if (IGNORE_MINTS.has(change.mint) || !tracked.has(change.userAccount)) continue;
        const amount = Number(change.rawTokenAmount?.tokenAmount || 0);
        if (amount > 0) signals.push({ mint: change.mint, wallet: change.userAccount, type: "BUY" });
        else if (amount < 0) signals.push({ mint: change.mint, wallet: change.userAccount, type: "SELL" });
      }
    }
  }
  const seen = new Set<string>();
  return signals.filter((s) => { const k = `${s.mint}:${s.wallet}:${s.type}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ─── Evaluate Signal for Instant Entry ───────────────────

async function evaluateAndEnter(
  mint: string,
  walletAddress: string,
  walletTag: string,
  coinName: string,
  gapMinutes: number
): Promise<{ entered: boolean; reason: string }> {
  const startMs = Date.now();

  // Stablecoin name filter — fastest rejection
  if (coinName && isStablecoinName(coinName)) {
    return { entered: false, reason: `stablecoin name filter: ${coinName}` };
  }

  // Gap filter
  if (gapMinutes > MAX_GAP_MINUTES) {
    return { entered: false, reason: `gap ${gapMinutes}m > ${MAX_GAP_MINUTES}m` };
  }

  // Check if position already open for this coin
  const { count: openCount } = await supabase
    .from("paper_trades")
    .select("id", { count: "exact", head: true })
    .eq("coin_address", mint)
    .eq("status", "open");

  if ((openCount || 0) > 0) {
    return { entered: false, reason: "position already open" };
  }

  // Check recently traded cooldown
  const cooldownCutoff = new Date(Date.now() - RECENTLY_TRADED_COOLDOWN_MS).toISOString();
  const { count: recentCount } = await supabase
    .from("paper_trades")
    .select("id", { count: "exact", head: true })
    .eq("coin_address", mint)
    .eq("status", "closed")
    .gte("exit_time", cooldownCutoff);

  if ((recentCount || 0) > 0) {
    return { entered: false, reason: "recently traded (120min cooldown, same address)" };
  }

  // Name-based cooldown — block same-name scam tokens (different addresses, same name)
  if (coinName) {
    const { count: nameCount } = await supabase
      .from("paper_trades")
      .select("id", { count: "exact", head: true })
      .eq("coin_name", coinName)
      .eq("status", "closed")
      .gte("exit_time", cooldownCutoff);

    if ((nameCount || 0) > 0) {
      return { entered: false, reason: `recently traded same name (120min cooldown): ${coinName}` };
    }
  }

  // Check if THIS wallet is Smart Money
  const isSmartMoney = TOP_ELITE_ADDRESSES.has(walletAddress);

  // Get all BUY signals for this coin in last 30 min
  const signalCutoff = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: recentSignals } = await supabase
    .from("coin_signals")
    .select("wallet_tag, coin_address")
    .eq("coin_address", mint)
    .eq("transaction_type", "BUY")
    .eq("rug_check_passed", true)
    .gte("signal_time", signalCutoff);

  const allTags = new Set((recentSignals || []).map((s) => s.wallet_tag));
  allTags.add(walletTag); // Include current signal

  // Get wallet addresses for all tags to check Smart Money
  const { data: walletRows } = await supabase
    .from("tracked_wallets")
    .select("wallet_address, tag")
    .in("tag", Array.from(allTags));

  const tagToAddr = new Map<string, string>();
  for (const w of walletRows || []) tagToAddr.set(w.tag, w.wallet_address);

  // Count Smart Money wallets and total unique wallets
  let smartMoneyCount = 0;
  const smartMoneyNames: string[] = [];
  const otherNames: string[] = [];

  for (const tag of allTags) {
    const addr = tagToAddr.get(tag);
    if (addr && TOP_ELITE_ADDRESSES.has(addr)) {
      smartMoneyCount++;
      smartMoneyNames.push(tag);
    } else {
      otherNames.push(tag);
    }
  }

  // REQUIRE: at least 1 T1 Smart Money — solo T1 buy is enough
  if (smartMoneyCount === 0) {
    return { entered: false, reason: `no Smart Money (${allTags.size} wallets, 0 T1)` };
  }

  // Bundle check: any wallet = 80%+ of signals
  const signalsByWallet = new Map<string, number>();
  for (const s of recentSignals || []) {
    signalsByWallet.set(s.wallet_tag, (signalsByWallet.get(s.wallet_tag) || 0) + 1);
  }
  signalsByWallet.set(walletTag, (signalsByWallet.get(walletTag) || 0) + 1);
  const totalSigs = (recentSignals?.length || 0) + 1;
  for (const [tag, count] of signalsByWallet) {
    if (count / totalSigs >= 0.8 && totalSigs >= 3) {
      return { entered: false, reason: `bundle (${tag} = ${count}/${totalSigs})` };
    }
  }

  // ── ENTER TRADE ──
  const { price, source } = await getPrice(mint);

  if (!price || price <= 0) {
    console.log(`  [SKIP] ${coinName} — could not fetch price, skipping entry`);
    return { entered: false, reason: `price fetch failed (source: ${source})` };
  }

  // Max entry price filter — reject high-priced stable tokens
  if (isPriceTooHigh(price)) {
    console.log(`  [VALIDATOR] Rejected — price too high: $${price.toFixed(10)} (max $0.001)`);
    return { entered: false, reason: `price too high: $${price}` };
  }

  // Liquidity check
  const { liquidity, passed: liqPassed } = await checkLiquidity(mint);
  if (!liqPassed) {
    return { entered: false, reason: `liquidity too low ($${liquidity?.toLocaleString() ?? "?"})` };
  }

  // LP burn & holder check
  const { lpSafe, holdersSafe } = await checkLpAndHolders(mint);
  if (!lpSafe) {
    return { entered: false, reason: "LP not burned (rug risk)" };
  }
  if (!holdersSafe) {
    return { entered: false, reason: "top10 holders >80% (developer cluster)" };
  }

  // Get bankroll for position sizing
  const { data: bankrollRow } = await supabase
    .from("paper_bankroll")
    .select("current_balance")
    .limit(1)
    .single();
  const bankrollBalance = Number(bankrollRow?.current_balance || 10000);
  const positionSize = bankrollBalance * POSITION_SIZE_PCT;

  const confirmTag = otherNames.length > 0 ? otherNames[0] : smartMoneyNames[1] || smartMoneyNames[0];
  const walletLabel = `${smartMoneyNames[0]}+${confirmTag}${allTags.size > 2 ? `+${allTags.size - 2}more` : ""}`;

  const { error } = await supabase.from("paper_trades").insert({
    coin_address: mint,
    coin_name: coinName,
    wallet_tag: walletLabel,
    entry_price: price,
    entry_mc: null,
    status: "open",
    priority: smartMoneyCount >= 2 ? "HIGH" : "normal",
    entry_time: new Date().toISOString(),
    position_size_usd: positionSize,
  });

  if (error) {
    return { entered: false, reason: `db error: ${error.message}` };
  }

  const elapsed = Date.now() - startMs;
  return {
    entered: true,
    reason: `[INSTANT ENTRY] ${coinName} @ $${price.toFixed(10)} | ${walletLabel} | ${elapsed}ms from webhook [${source}]`,
  };
}

// ─── POST Handler ────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const transactions: EnhancedTx[] = Array.isArray(body) ? body : [body];

    const { data: wallets } = await supabase
      .from("tracked_wallets")
      .select("wallet_address")
      .eq("active", true);

    const trackedSet = new Set(wallets?.map((w) => w.wallet_address) || []);

    let signalCount = 0;
    let entryCount = 0;

    for (const tx of transactions) {
      if (tx.type !== "SWAP") continue;

      const swaps = extractSwaps(tx, trackedSet);
      if (swaps.length === 0) continue;

      for (const { mint, wallet, type } of swaps) {
        const walletTag = await getWalletTag(wallet);
        const signalTime = new Date(tx.timestamp * 1000);
        const gapMinutes = Math.round((Date.now() - signalTime.getTime()) / 60_000);

        if (type === "SELL") {
          const coinName = await getTokenName(mint);
          await supabase.from("coin_signals").insert({
            coin_address: mint, coin_name: coinName, wallet_tag: walletTag,
            entry_mc: null, rug_check_passed: true,
            price_gap_minutes: gapMinutes, bundle_suspected: false,
            transaction_type: "SELL",
          });
          signalCount++;
          continue;
        }

        // BUY: rug check
        const { passed, tokenName: rugName } = await checkRug(mint);
        if (!passed) continue;

        const coinName = rugName || (await getTokenName(mint));

        // Bundle detection for signal logging
        let bundleSuspected = false;
        const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
        const { count: recentBundleCount } = await supabase
          .from("coin_signals")
          .select("id", { count: "exact", head: true })
          .eq("coin_address", mint)
          .eq("wallet_tag", walletTag)
          .eq("transaction_type", "BUY")
          .gte("signal_time", fiveMinAgo);

        if ((recentBundleCount || 0) >= 2) bundleSuspected = true;

        // Insert signal
        await supabase.from("coin_signals").insert({
          coin_address: mint, coin_name: coinName, wallet_tag: walletTag,
          entry_mc: null, rug_check_passed: true,
          price_gap_minutes: gapMinutes, bundle_suspected: bundleSuspected,
          transaction_type: "BUY",
        });
        signalCount++;

        // ── INSTANT ENTRY EVALUATION ──
        const result = await evaluateAndEnter(mint, wallet, walletTag, coinName, gapMinutes);
        if (result.entered) {
          entryCount++;
          console.log(`  ${result.reason}`);
        }
      }
    }

    return new Response(
      JSON.stringify({ ok: true, signals: signalCount, entries: entryCount }),
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

export async function GET(): Promise<Response> {
  return new Response(
    JSON.stringify({ status: "ok", service: "pixiu-bot-webhook", mode: "instant-entry" }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
