/**
 * PixiuBot — Helius Webhook Receiver + Instant Entry
 * POST /api/webhook
 *
 * Receives Helius push → inserts signal → evaluates entry → opens trade.
 * Millisecond entry from webhook push. No polling delay.
 */

import { createClient } from "@supabase/supabase-js";
import {
  MAX_GAP_MINUTES,
  MAX_ENTRY_MC,
  RECENTLY_TRADED_COOLDOWN_MS,
  RECENT_NAME_COOLDOWN_MS,
  POSITION_SIZE_PCT,
  WALLET_BLACKLIST,
} from "@/config/smart-money";
import { isPriceTooHigh, isOffensiveName, checkTokenSafety } from "@/lib/price-guards";

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

// ─── Rug Storm Check (Edge-runtime safe, inline) ─────────
// Duplicated from src/lib/entry-guards.ts because that file imports
// supabase-server.ts which pulls Node.js 'path' — not supported in CF
// Edge runtime. Logic must stay in sync with entry-guards.ts.
// Stateless (no module cache) — each webhook invocation queries fresh.
const RUG_STORM_THRESHOLD = 3; // 3/5 losses → rug storm
const RUG_STORM_WINDOW = 5;

async function webhookIsRugStorm(): Promise<boolean> {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const { data: recentTrades } = await supabase
    .from("trades")
    .select("pnl_pct")
    .eq("status", "closed")
    .gte("exit_time", twoHoursAgo)
    .order("exit_time", { ascending: false })
    .limit(RUG_STORM_WINDOW);
  if (!recentTrades || recentTrades.length < RUG_STORM_WINDOW) return false;
  const losses = recentTrades.filter((t) => Number(t.pnl_pct) < 0).length;
  return losses >= RUG_STORM_THRESHOLD;
}

// ─── Bot Running Check (Edge-runtime safe, inline) ─────────
// Reads `is_running` from bot_state. If false (dashboard STOP), the
// webhook must NOT insert trades or executor will fire a Jupiter
// buy during STOP state. Observed: The Bull -60.61%, 千鳥 -44.66%,
// dogwifbeanie -37.71% all opened while bot was STOPPED.
// SAFETY: on any error, default to FALSE (not running) — never trade
// if we can't confirm running state.
async function webhookIsBotRunning(): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("bot_state")
      .select("is_running")
      .limit(1)
      .single();
    if (error || !data) return false;
    return data.is_running === true;
  } catch {
    return false;
  }
}

// ─── Token-2022 Extension Check (Edge-runtime safe, inline) ─────
// Blocks pump.fun tokens with extensions that make them un-sellable via
// Jupiter (error 6024) or let the mint authority drain holders.
// Migrated from src/agents/price-scout.ts. Uses plain fetch to Helius
// RPC — no @solana/web3.js import (that would break CF Edge build the
// same way path/dotenv did in commit 0ac8725).
//
// Mint layout: 0-165 = base SPL Mint, byte 165 = account type,
// 166+ = TLV extensions [u16 type][u16 length][data...].
// Blocking types:
//   1  TransferFeeConfig — built-in transfer tax
//   9  NonTransferable   — transfers disabled
//  12  PermanentDelegate — mint authority can drain holders' tokens
//  14  TransferHook      — pump.fun anti-bot (causes sell error 6024)
//
// SAFETY: on any RPC error, returns null (fail-open). Never false-reject
// a token on network failure — downstream guards will still catch issues.

const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const BLOCKING_T22_EXTENSIONS: Record<number, string> = {
  1: "TransferFeeConfig",
  9: "NonTransferable",
  12: "PermanentDelegate",
  14: "TransferHook",
};

async function checkTokenExtensions(mint: string): Promise<string | null> {
  const heliusKey = process.env.HELIUS_API_KEY;
  if (!heliusKey) return null; // fail-open if not configured

  try {
    const res = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [mint, { encoding: "base64" }],
        }),
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!res.ok) return null;
    const j = await res.json();
    const value = j.result?.value;
    if (!value) return null;

    // Standard SPL Token → no extensions possible
    if (value.owner !== TOKEN_2022_PROGRAM_ID) return null;

    // Decode base64 → Uint8Array (edge-compatible, no Buffer needed)
    const b64: string = value.data?.[0];
    if (!b64) return null;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    // Base Mint is 165 bytes + 1 byte account type; TLV starts at 166.
    if (bytes.length < 166 + 4) return null;

    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 166;
    while (offset + 4 <= bytes.length) {
      const extType = dv.getUint16(offset, true);
      const extLen = dv.getUint16(offset + 2, true);
      const name = BLOCKING_T22_EXTENSIONS[extType];
      if (name) return name;
      offset += 4 + extLen;
      // Stop on Uninitialized extension (type=0, len=0)
      if (extLen === 0 && extType === 0) break;
    }
    return null;
  } catch {
    // Network timeout, parse error, or any other failure → fail-open.
    return null;
  }
}

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

  // Bot-running check — HIGHEST PRIORITY. If dashboard shows STOPPED,
  // no new entries via any path. Without this, webhook bypasses the
  // dashboard STOP button and opens positions the user didn't approve.
  if (!(await webhookIsBotRunning())) {
    console.log(`  [WEBHOOK] ❌ ${coinName || mint.slice(0, 8)} — bot_stopped`);
    return { entered: false, reason: "bot_stopped" };
  }

  // Stablecoin name filter — fastest rejection
  if (coinName && isStablecoinName(coinName)) {
    console.log(`  [WEBHOOK] ❌ ${coinName} — stablecoin name filter`);
    return { entered: false, reason: `stablecoin name filter: ${coinName}` };
  }

  // Offensive name filter — block hate speech / slurs
  if (isOffensiveName(coinName)) {
    console.log(`  [WEBHOOK] ❌ ${coinName} — offensive name filter`);
    return { entered: false, reason: `offensive name filter: ${coinName}` };
  }

  // Rug storm protection — must match signal-validator.ts behavior.
  // Without this, webhook entries bypass the market-wide rug-storm pause
  // (observed: Asteroid bypass caused -45.96% loss during an active storm).
  // Uses inline webhookIsRugStorm() because entry-guards.ts pulls Node.js
  // deps that CF Edge runtime rejects.
  if (await webhookIsRugStorm()) {
    console.log(`  [WEBHOOK] ❌ ${coinName || mint.slice(0, 8)} — rug_storm_active`);
    return { entered: false, reason: "rug_storm_active" };
  }

  // Token-2022 extension check — fail fast on un-sellable mints BEFORE
  // any expensive network calls (price fetch, RugCheck, etc.). Migrated
  // from price-scout.ts. RPC errors fail-open (return null).
  const badExt = await checkTokenExtensions(mint);
  if (badExt) {
    console.log(`  [WEBHOOK] ❌ ${coinName || mint.slice(0, 8)} — Token-2022 ${badExt} (un-sellable)`);
    return { entered: false, reason: `token_2022_${badExt.toLowerCase()}` };
  }

  // Gap filter
  if (gapMinutes > MAX_GAP_MINUTES) {
    console.log(`  [WEBHOOK] ❌ ${coinName || mint.slice(0, 8)} — gap ${gapMinutes}m > ${MAX_GAP_MINUTES}m`);
    return { entered: false, reason: `gap ${gapMinutes}m > ${MAX_GAP_MINUTES}m` };
  }

  // Check if position already open for this coin
  const { count: openCount } = await supabase
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("coin_address", mint)
    .eq("status", "open");

  if ((openCount || 0) > 0) {
    console.log(`  [WEBHOOK] ❌ ${coinName || mint.slice(0, 8)} — position already open`);
    return { entered: false, reason: "position already open" };
  }

  // Check recently traded cooldown
  const cooldownCutoff = new Date(Date.now() - RECENTLY_TRADED_COOLDOWN_MS).toISOString();
  const { count: recentCount } = await supabase
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("coin_address", mint)
    .eq("status", "closed")
    .gte("exit_time", cooldownCutoff);

  if ((recentCount || 0) > 0) {
    console.log(`  [WEBHOOK] ❌ ${coinName || mint.slice(0, 8)} — 120min cooldown (address)`);
    return { entered: false, reason: "recently traded (120min cooldown, same address)" };
  }

  // Name-based cooldown — shorter (30min) than address cooldown. Same name on a
  // different mint is often a fresh meme launch, not the same rug.
  if (coinName) {
    const nameCooldownCutoff = new Date(Date.now() - RECENT_NAME_COOLDOWN_MS).toISOString();
    const { count: nameCount } = await supabase
      .from("trades")
      .select("id", { count: "exact", head: true })
      .eq("coin_name", coinName)
      .eq("status", "closed")
      .gte("exit_time", nameCooldownCutoff);

    if ((nameCount || 0) > 0) {
      console.log(`  [WEBHOOK] ❌ ${coinName} — 30min cooldown (name)`);
      return { entered: false, reason: `recently traded same name (30min cooldown): ${coinName}` };
    }
  }

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

  // Guard #10a — WALLET_BLACKLIST (Apr 21 postmortem).
  // Permanently banned primary signalers regardless of current tier.
  // Runs BEFORE the tier check so blacklisted wallets cannot slip
  // through via tier-manager auto-promotion. Only the PRIMARY address
  // (the one that fired this webhook invocation) is checked — co-
  // signers appearing in allTags are noise that doesn't drive entry.
  // See src/config/smart-money.ts WALLET_BLACKLIST for rationale.
  if (WALLET_BLACKLIST.has(walletAddress)) {
    console.log(`  [WEBHOOK] ❌ ${coinName || mint.slice(0, 8)} — wallet blacklisted (${walletTag})`);
    return { entered: false, reason: `wallet blacklisted: ${walletTag}` };
  }

  // DB-backed T1 check — tier=1 can trigger solo, tier=2 needs T1 confirmation
  // Replaces hardcoded TOP_ELITE_ADDRESSES so demotions in DB take effect instantly
  const { data: walletRows } = await supabase
    .from("tracked_wallets")
    .select("tag, tier, active")
    .in("tag", Array.from(allTags))
    .eq("active", true);

  const tagToTier = new Map<string, number>();
  for (const w of walletRows || []) {
    tagToTier.set(w.tag, w.tier ?? 0);
  }

  // Count T1 wallets via DB tier (not hardcoded Set)
  let smartMoneyCount = 0;
  const smartMoneyNames: string[] = [];
  const otherNames: string[] = [];

  for (const tag of allTags) {
    const tier = tagToTier.get(tag);
    if (tier === 1) {
      smartMoneyCount++;
      smartMoneyNames.push(tag);
    } else {
      otherNames.push(tag);
    }
  }

  // REQUIRE: at least 1 T1 Smart Money — solo T1 buy is enough
  if (smartMoneyCount === 0) {
    const t2Names = Array.from(allTags).filter((t) => tagToTier.get(t) === 2);
    const reason = t2Names.length > 0
      ? `no T1 Smart Money — ${t2Names.length} T2 wallet(s) need T1 confirmation: ${t2Names.join(",")}`
      : `no T1 Smart Money (${allTags.size} wallets, 0 T1)`;
    console.log(`  [WEBHOOK] ❌ ${coinName || mint.slice(0, 8)} — ${reason}`);
    return { entered: false, reason };
  }

  // Whale hold time — if any confirming wallet sold this coin within 2min
  // of buying, it's a rug/test pattern. Migrated from signal-validator.ts.
  // Catches the exact case where a whale buys then dumps to trigger followers
  // into a rug.
  const twoMinAgo = new Date(Date.now() - 2 * 60_000).toISOString();
  const { data: quickSells } = await supabase
    .from("coin_signals")
    .select("wallet_tag")
    .eq("coin_address", mint)
    .eq("transaction_type", "SELL")
    .gte("signal_time", twoMinAgo);

  if (quickSells && quickSells.length > 0) {
    const sellerTags = new Set(quickSells.map((s) => s.wallet_tag));
    const overlap = Array.from(allTags).filter((t) => sellerTags.has(t));
    if (overlap.length > 0) {
      console.log(`  [WEBHOOK] ❌ ${coinName || mint.slice(0, 8)} — ${overlap[0]} sold within 2min (likely rug)`);
      return { entered: false, reason: `quick_sell_${overlap[0]}` };
    }
  }

  // Bundle check: any wallet = 80%+ of signals.
  // The current signal is already INSERTed into coin_signals (line 632 in the
  // POST handler) before evaluateAndEnter runs, so it's already in the
  // recentSignals query result. Do NOT manually +1 — that was the pre-fix
  // behavior and caused the current walletTag to be double-counted,
  // falsely rejecting legitimate re-buys as bundle.  Sprint 8 Bug-2 fix.
  const signalsByWallet = new Map<string, number>();
  for (const s of recentSignals || []) {
    signalsByWallet.set(s.wallet_tag, (signalsByWallet.get(s.wallet_tag) || 0) + 1);
  }
  const totalSigs = recentSignals?.length || 0;
  if (totalSigs >= 3) {
    for (const [tag, count] of signalsByWallet) {
      if (count / totalSigs >= 0.8) {
        console.log(`  [WEBHOOK] ❌ ${coinName || mint.slice(0, 8)} — bundle (${tag} = ${count}/${totalSigs})`);
        return { entered: false, reason: `bundle (${tag} = ${count}/${totalSigs})` };
      }
    }
  }

  // ── ENTER TRADE ──
  const { price, source } = await getPrice(mint);

  if (!price || price <= 0) {
    console.log(`  [WEBHOOK] ❌ ${coinName || mint.slice(0, 8)} — price fetch failed (source: ${source})`);
    return { entered: false, reason: `price fetch failed (source: ${source})` };
  }

  // Max entry price filter — reject high-priced stable tokens
  if (isPriceTooHigh(price)) {
    console.log(`  [WEBHOOK] ❌ ${coinName || mint.slice(0, 8)} — price too high: $${price.toFixed(10)} (max $0.001)`);
    return { entered: false, reason: `price too high: $${price}` };
  }

  // Full token safety check — replaces inline checkLiquidity().
  // Covers 3 rug signals in one DexScreener call:
  //   1. liquidity < $10k      — thin liquidity / sell-back risk
  //   2. fdv < $10k            — micro-cap rug
  //   3. priceChange.m5 < -20% — token already rugging in last 5min
  const safety = await checkTokenSafety(mint);
  if (!safety.safe) {
    console.log(`  [WEBHOOK] ❌ ${coinName || mint.slice(0, 8)} — ${safety.reason}`);
    return { entered: false, reason: `token_unsafe: ${safety.reason}` };
  }

  // LP burn & holder check
  const { lpSafe, holdersSafe } = await checkLpAndHolders(mint);
  if (!lpSafe) {
    console.log(`  [WEBHOOK] ❌ ${coinName || mint.slice(0, 8)} — LP not burned`);
    return { entered: false, reason: "LP not burned (rug risk)" };
  }
  if (!holdersSafe) {
    console.log(`  [WEBHOOK] ❌ ${coinName || mint.slice(0, 8)} — top10 holders >80%`);
    return { entered: false, reason: "top10 holders >80% (developer cluster)" };
  }

  // Sprint 10: position sizing is fixed at LIVE_BUY_SOL from config.
  // Legacy position_size_usd column left at 0 — unused.
  const positionSize = 0;

  const confirmTag = otherNames.length > 0 ? otherNames[0] : smartMoneyNames[1] || smartMoneyNames[0];
  const walletLabel = `${smartMoneyNames[0]}+${confirmTag}${allTags.size > 2 ? `+${allTags.size - 2}more` : ""}`;

  const { error } = await supabase.from("trades").insert({
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
    // Sprint 10 P0: partial unique index `one_open_per_mint_idx` on
    // (coin_address) WHERE status='open' rejects duplicate open rows
    // from race conditions (multiple webhook signals for same mint in
    // same ms). Recognize + log cleanly instead of the raw Postgres err.
    const isDuplicateOpen =
      error.code === "23505" /* unique_violation */ ||
      /one_open_per_mint|duplicate key/.test(error.message);
    if (isDuplicateOpen) {
      console.log(`  [WEBHOOK] ❌ ${coinName || mint.slice(0, 8)} — duplicate (another open row already exists for this mint, race)`);
      return { entered: false, reason: "duplicate open row (race)" };
    }
    console.log(`  [WEBHOOK] ❌ ${coinName || mint.slice(0, 8)} — db error: ${error.message}`);
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
