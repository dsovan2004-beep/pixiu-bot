/**
 * PixiuBot — Price Guards
 *
 * Edge-safe price filters. No Node.js or Supabase imports.
 * Safe to use in webhook/route.ts (Edge Runtime) and price-scout.ts.
 */

// ─── Max Entry Price Filter ────────────────────────────
// Reject tokens priced above $0.001 — the strategy only works
// on micro-cap pump.fun meme coins that can 2-5x quickly.
// Higher-priced stable tokens (Drift, unc, Normie) barely move
// and net-lose after ~2% fees/slippage.

export const MAX_ENTRY_PRICE = 0.001; // $0.001 USD

export function isPriceTooHigh(priceUsd: number): boolean {
  return priceUsd > MAX_ENTRY_PRICE;
}

// ─── Offensive Name Filter ────────────────────────────
// Block coins with hate speech, slurs, nazi/genocide references.
// These are reputational/liability risks regardless of signal quality.
// Case-insensitive substring match on normalized name (spaces/punct stripped).

const OFFENSIVE_TERMS = [
  // Nazi / fascism (with leet-speak variants to catch evasion attempts)
  "nazi", "n4zi", "naz1",
  "reich", "r3ich", "re1ch",
  "thirdreich", "thirdr3ich", "3rdreich", "3rdr3ich",
  "hitler", "h1tler", "hitl3r",
  "fuhrer", "fuehrer", "fuhr3r",
  "heil", "h3il",
  "swastika",
  "ss ", " ss", "gestapo", "holocaust",
  // Racial slurs (variations)
  "nigger", "nigga", "n1gger", "n1gga", "niggr", "n1ggr",
  "chink", "gook", "spic", "kike", "wetback", "raghead",
  "tranny", "faggot", "f4ggot", "fagg0t",
  "retard", "retrd",
  // Hate groups / ideologies
  "kkk", "whitepower", "white power", "14words", "14 words",
  "aryan", "zionist", "antisemit", "anti semit", "anti-semit",
  // Violence / genocide
  "genocide", "lynching", "lynch ",
  // Other hate
  "slur",
];

export function isOffensiveName(coinName: string | null | undefined): boolean {
  if (!coinName) return false;
  // Normalize: lowercase, remove all non-alphanumeric to catch variations
  // like "N-word", "N_word", "N.word", "N word" all collapse to "nword"
  const normalized = coinName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const spaced = coinName.toLowerCase(); // keep spaces for "ss " boundary matches

  return OFFENSIVE_TERMS.some((term) => {
    const normTerm = term.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normTerm && normalized.includes(normTerm)) return true;
    // Also check original (with spaces) for boundary-sensitive terms
    if (spaced.includes(term.toLowerCase())) return true;
    return false;
  });
}

// ─── Token Safety Check (DexScreener) ────────────────
// Block low-liquidity / rugging tokens BEFORE entry.
// These are the worst losses — owkd -91%, World War 3 -80%, 1 SOL -76%.
// Pump.fun tokens with <$5K liquidity dump within seconds.

export const MIN_LIQUIDITY_USD = 5000;     // < $5K liquidity = rug risk
export const MIN_FDV_USD = 10000;          // < $10K market cap = micro-rug
export const MAX_5M_DROP_PCT = -20;        // < -20% in 5min = already rugging

interface SafetyCache {
  result: { safe: boolean; reason: string };
  cachedAt: number;
}
const safetyCache = new Map<string, SafetyCache>();
const SAFETY_CACHE_MS = 30_000; // 30s per mint

export async function checkTokenSafety(
  mintAddress: string
): Promise<{ safe: boolean; reason: string }> {
  // Cache check
  const cached = safetyCache.get(mintAddress);
  if (cached && Date.now() - cached.cachedAt < SAFETY_CACHE_MS) {
    return cached.result;
  }

  let result: { safe: boolean; reason: string };

  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
      { signal: AbortSignal.timeout(5000) } // 5s timeout — don't hang on slow API
    );

    if (!res.ok) {
      // API failure → allow entry (don't block on transient errors)
      result = { safe: true, reason: "dexscreener_api_unavailable" };
    } else {
      const data = await res.json();
      const pairs = data.pairs;

      if (!pairs || pairs.length === 0) {
        result = { safe: false, reason: "no DexScreener pairs found" };
      } else {
        // Use the first (highest-liquidity) pair
        const pair = pairs[0];
        const liquidity = pair?.liquidity?.usd;
        const fdv = pair?.fdv;
        const m5Change = pair?.priceChange?.m5;

        if (typeof liquidity === "number" && liquidity < MIN_LIQUIDITY_USD) {
          result = {
            safe: false,
            reason: `liquidity too low: $${liquidity.toFixed(0)} (min $${MIN_LIQUIDITY_USD})`,
          };
        } else if (typeof fdv === "number" && fdv < MIN_FDV_USD) {
          result = {
            safe: false,
            reason: `market cap too low: $${fdv.toFixed(0)} (min $${MIN_FDV_USD})`,
          };
        } else if (typeof m5Change === "number" && m5Change < MAX_5M_DROP_PCT) {
          result = {
            safe: false,
            reason: `already rugging: ${m5Change.toFixed(1)}% in 5min`,
          };
        } else {
          result = {
            safe: true,
            reason: `liq=$${(liquidity ?? 0).toFixed(0)} fdv=$${(fdv ?? 0).toFixed(0)} m5=${(m5Change ?? 0).toFixed(1)}%`,
          };
        }
      }
    }
  } catch (err: any) {
    // Timeout or network error → allow (don't block on transient errors)
    result = { safe: true, reason: `dexscreener_error: ${err.message}` };
  }

  safetyCache.set(mintAddress, { result, cachedAt: Date.now() });
  return result;
}
