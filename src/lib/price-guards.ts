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
