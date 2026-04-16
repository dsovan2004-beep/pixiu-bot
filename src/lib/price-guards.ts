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
  // Nazi / fascism
  "nazi", "reich", "hitler", "fuhrer", "fuehrer", "heil", "swastika",
  "thirdreich", "ss ", " ss", "gestapo", "holocaust",
  // Racial slurs (variations)
  "nigger", "nigga", "n1gger", "n1gga", "niggr",
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
