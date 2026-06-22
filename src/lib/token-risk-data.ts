/**
 * TR-v1 input extractor. Edge-safe (fetch + AbortSignal.timeout only).
 * Fetches RugCheck /report (one call) + DexScreener, maps to TokenRiskInputs.
 * Field names verified against a live RugCheck /report (2026-06-21).
 * Missing/failed data → null fields → evaluator fails closed on criticals.
 * All values are entry-time observations; no outcome data.
 */
import type { TokenRiskInputs } from "./token-risk-v1";

export type TokenRiskFetch = {
  inputs: TokenRiskInputs;
  priceUsd: number | null; // entry price at decision (DexScreener), for paper-sim
  provider: string;
  providerConfidence: number; // 0..1 — fraction of source calls that succeeded with usable data
  rugcheckOk: boolean;
  dexOk: boolean;
};

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function fetchTokenRiskInputs(mint: string, nowMs: number): Promise<TokenRiskFetch> {
  let rc: any = null, dex: any = null;
  try {
    const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { signal: AbortSignal.timeout(6000) });
    if (r.ok) rc = await r.json();
  } catch { /* leave null → fail-closed */ }
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(6000) });
    if (r.ok) dex = await r.json();
  } catch { /* leave null */ }

  const rugcheckOk = rc !== null;
  const dexOk = dex !== null && Array.isArray(dex.pairs) && dex.pairs.length > 0;
  const pair = dexOk ? dex.pairs[0] : null;

  // ── RugCheck-derived ──
  let honeypot: boolean | null = null;
  let mintRenounced: boolean | null = null;
  let freezeRenounced: boolean | null = null;
  let lpLockedPct: number | null = null;
  let liquidityUsd: number | null = null;
  let top10Pct: number | null = null;
  let devHoldingsPct: number | null = null;
  let insiderRatio: number | null = null;

  if (rugcheckOk) {
    const risks: Array<{ name?: string }> = Array.isArray(rc.risks) ? rc.risks : [];
    honeypot = (rc.rugged === true) || risks.some((x) => (x.name || "").toLowerCase().includes("honeypot"));
    // mint/freeze authority: null/empty string = renounced
    mintRenounced = rc.mintAuthority === undefined ? null : (rc.mintAuthority === null || rc.mintAuthority === "");
    freezeRenounced = rc.freezeAuthority === undefined ? null : (rc.freezeAuthority === null || rc.freezeAuthority === "");
    // LP lock %: from primary market
    const markets: any[] = Array.isArray(rc.markets) ? rc.markets : [];
    if (markets.length > 0 && markets[0]?.lp) lpLockedPct = num(markets[0].lp.lpLockedPct);
    // liquidity USD
    liquidityUsd = num(rc.totalMarketLiquidity);
    // top-10 holder concentration (sum of first 10 topHolders pct)
    const th: any[] = Array.isArray(rc.topHolders) ? rc.topHolders : [];
    if (th.length > 0) {
      top10Pct = th.slice(0, 10).reduce((s, h) => s + (num(h?.pct) ?? 0), 0);
      // insider ratio: fraction of supply held by flagged-insider top holders
      insiderRatio = th.filter((h) => h?.insider === true).reduce((s, h) => s + (num(h?.pct) ?? 0), 0) / 100;
    }
    // dev/creator holdings %: creatorBalance / token.supply
    const supply = num(rc.token?.supply);
    const creatorBal = num(rc.creatorBalance);
    if (supply !== null && supply > 0 && creatorBal !== null) devHoldingsPct = (creatorBal / supply) * 100;
  }

  // ── DexScreener-derived ──
  let fdvUsd: number | null = dexOk ? num(pair?.fdv) : null;
  let priceChange5m: number | null = dexOk ? num(pair?.priceChange?.m5) : null;
  if (liquidityUsd === null && dexOk) liquidityUsd = num(pair?.liquidity?.usd); // fallback
  // token age: prefer RugCheck detectedAt, else DexScreener pairCreatedAt
  let ageMin: number | null = null;
  if (rugcheckOk && rc.detectedAt) { const t = Date.parse(rc.detectedAt); if (Number.isFinite(t)) ageMin = (nowMs - t) / 60000; }
  if (ageMin === null && dexOk && pair?.pairCreatedAt) { const t = Number(pair.pairCreatedAt); if (Number.isFinite(t)) ageMin = (nowMs - t) / 60000; }

  const inputs: TokenRiskInputs = {
    honeypot,
    mintAuthorityRenounced: mintRenounced,
    freezeAuthorityRenounced: freezeRenounced,
    lpBurnedOrLockedPct: lpLockedPct,
    liquidityUsd,
    top10HoldersPct: top10Pct,
    fdvUsd,
    tokenAgeMinutes: ageMin,
    priceChange5mPct: priceChange5m,
    devHoldingsPct,
    insiderRatio,
    bundleRatio: null, // RugCheck /report exposes no direct bundle ratio → missing (soft penalty). Future: dedicated provider.
  };

  const priceUsd = dexOk ? num(pair?.priceUsd) : null;
  // provider confidence: weight RugCheck (criticals) heavily; both up = 1.0
  const providerConfidence = (rugcheckOk ? 0.7 : 0) + (dexOk ? 0.3 : 0);
  return { inputs, priceUsd, provider: "rugcheck+dexscreener", providerConfidence, rugcheckOk, dexOk };
}
