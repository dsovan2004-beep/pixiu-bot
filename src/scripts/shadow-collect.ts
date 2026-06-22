/**
 * Forward shadow collector (TR-v1). NODE, shadow-only, no SOL, no broadcast.
 * Polls the BROAD coin_signals population (not just guard-passers → beats entry
 * rarity), evaluates TR-v1 per signal, records entry price, writes one
 * stacked_filter_shadow row per (coin, signal_time). Idempotent (dedup index).
 * Run on a cron (e.g., every few minutes). Requires migration 020 applied.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";
import { fetchTokenRiskInputs } from "../lib/token-risk-data";
import { evaluateTokenRiskV1, TokenRiskPolicy } from "../lib/token-risk-v1";

const LOOKBACK_MIN = 120;
const COHORT_WINDOW_MS = 15 * 60_000;
const MAX_PER_RUN = 40; // bound RugCheck/DexScreener calls per run

function env() {
  const text = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  const m: Record<string, string> = {};
  for (const l of text.split("\n")) { const x = l.match(/^([A-Z_0-9]+)=(.*)$/); if (x) m[x[1]] = x[2].replace(/^["']|["']$/g, ""); }
  return m;
}

async function loadPolicy(sb: any): Promise<TokenRiskPolicy | null> {
  const { data, error } = await sb.from("token_risk_policy").select("*").eq("active", true).limit(1).maybeSingle();
  if (error || !data) { console.error("no active token_risk_policy:", error?.message); return null; }
  return {
    rule_version: data.rule_version, policy_id: data.id,
    min_liquidity_usd: Number(data.min_liquidity_usd), top10_max_pct: Number(data.top10_max_pct),
    min_fdv_usd: Number(data.min_fdv_usd), min_token_age_minutes: Number(data.min_token_age_minutes),
    max_5m_drop_pct: Number(data.max_5m_drop_pct), lp_lock_min_pct: Number(data.lp_lock_min_pct),
    dev_holdings_max_pct: Number(data.dev_holdings_max_pct), insider_ratio_max: Number(data.insider_ratio_max),
    bundle_ratio_max: Number(data.bundle_ratio_max), risk_score_block: Number(data.risk_score_block),
    soft_weights: typeof data.soft_weights === "string" ? JSON.parse(data.soft_weights) : data.soft_weights,
  };
}

async function main() {
  const m = env();
  const sb = createClient(m.NEXT_PUBLIC_SUPABASE_URL!, m.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const policy = await loadPolicy(sb);
  if (!policy) process.exit(1);

  const sinceIso = new Date(Date.now() - LOOKBACK_MIN * 60_000).toISOString();
  const { data: sigs, error } = await sb
    .from("coin_signals")
    .select("coin_address,coin_name,wallet_tag,signal_time,transaction_type")
    .eq("transaction_type", "BUY")
    .gte("signal_time", sinceIso)
    .order("signal_time", { ascending: false });
  if (error) { console.error("coin_signals read:", error.message); process.exit(1); }

  // dedup against existing shadow rows
  const { data: existing } = await sb.from("stacked_filter_shadow").select("signal_coin_address,signal_time").gte("signal_time", sinceIso);
  const seen = new Set((existing || []).map((r: any) => `${r.signal_coin_address}|${r.signal_time}`));
  const all = sigs || [];
  const todo = all.filter((s: any) => !seen.has(`${s.coin_address}|${s.signal_time}`)).slice(0, MAX_PER_RUN);
  console.log(`signals(${LOOKBACK_MIN}m)=${all.length} already=${seen.size} processing=${todo.length}`);

  let entered = 0, blocked = 0;
  for (const s of todo) {
    // cohort: distinct wallet tags on this coin within ±window
    const wStart = new Date(new Date(s.signal_time).getTime() - COHORT_WINDOW_MS).toISOString();
    const { data: co } = await sb.from("coin_signals").select("wallet_tag").eq("coin_address", s.coin_address).gte("signal_time", wStart).lte("signal_time", s.signal_time);
    const walletTags = Array.from(new Set([s.wallet_tag, ...((co || []).map((x: any) => x.wallet_tag))].filter(Boolean)));

    const f = await fetchTokenRiskInputs(s.coin_address, Date.now());
    const d = evaluateTokenRiskV1(f.inputs, policy);
    const { error: insErr } = await sb.from("stacked_filter_shadow").insert({
      decision_time: new Date().toISOString(),
      signal_coin_address: s.coin_address, coin_name: s.coin_name, signal_time: s.signal_time,
      wallet_tags: walletTags, primary_wallet: s.wallet_tag,
      token_risk_score: d.token_risk_score, risk_severity: d.risk_severity,
      would_enter: d.would_enter, would_block: d.would_block,
      block_reasons: d.block_reasons, missing_metrics: d.missing, components: d.components,
      provider: f.provider, provider_confidence: f.providerConfidence,
      rule_version: d.rule_version, policy_id: d.policy_id,
      entry_price_at_decision: f.priceUsd,
    });
    if (insErr && !insErr.message.includes("duplicate")) console.error(`insert ${s.coin_address.slice(0, 8)}:`, insErr.message);
    else { d.would_enter ? entered++ : blocked++; }
  }
  console.log(`done: would_enter=${entered} would_block=${blocked}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
