/**
 * Paper-sim worker (no SOL, no broadcast). Resolves outcomes for ALL shadow
 * decisions (both would_enter AND would_block — so the report can compare).
 * Tracks DexScreener price forward, applies the strategy's exit logic, and
 * writes sim_pnl_pct. Forward-time only (uses prices ≥ decision_time). Run on a
 * cron (e.g., every 2–5 min); each run advances open positions one step.
 * Requires migration 020.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";

// exit logic aligned with risk-guard
const STOP_LOSS_PCT = 10;
const CIRCUIT_BREAKER_L0_PCT = 15;
const TRAIL_ARM_PCT = 10;       // peak must reach +10% to arm trailing
const TRAIL_FROM_PEAK_PCT = 25; // POST_L1_TRAIL_PCT
const MAX_HOLD_MIN = 120;       // timeout
const RUG_AFTER_MIN = 10;       // no price + older than this → treat as rug (-100%)

function env() {
  const text = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  const m: Record<string, string> = {};
  for (const l of text.split("\n")) { const x = l.match(/^([A-Z_0-9]+)=(.*)$/); if (x) m[x[1]] = x[2].replace(/^["']|["']$/g, ""); }
  return m;
}

async function price(mint: string): Promise<number | null> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const d = await r.json();
    const p = Number(d.pairs?.[0]?.priceUsd);
    return Number.isFinite(p) ? p : null;
  } catch { return null; }
}

async function main() {
  const m = env();
  const sb = createClient(m.NEXT_PUBLIC_SUPABASE_URL!, m.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: open, error } = await sb
    .from("stacked_filter_shadow")
    .select("id,signal_coin_address,decision_time,entry_price_at_decision,peak_pct")
    .is("outcome_resolved_at", null)
    .not("entry_price_at_decision", "is", null)
    .order("decision_time", { ascending: true })
    .limit(60);
  if (error) { console.error(error.message); process.exit(1); }
  const rows = open || [];
  console.log(`open paper positions: ${rows.length}`);

  let resolved = 0, advanced = 0;
  for (const r of rows) {
    const entry = Number(r.entry_price_at_decision);
    const ageMin = (Date.now() - new Date(r.decision_time).getTime()) / 60_000;
    const cur = await price(r.signal_coin_address);

    let exitReason: string | null = null, pnlPct = 0, exitPrice = cur ?? 0;
    if (cur === null || cur <= 0) {
      if (ageMin >= RUG_AFTER_MIN) { exitReason = "rug_or_missing"; pnlPct = -100; exitPrice = 0; }
    } else {
      pnlPct = ((cur - entry) / entry) * 100;
      const peak = Math.max(Number(r.peak_pct ?? -Infinity), pnlPct);
      if (pnlPct <= -STOP_LOSS_PCT) exitReason = "stop_loss";
      else if (pnlPct <= -CIRCUIT_BREAKER_L0_PCT) exitReason = "circuit_breaker";
      else if (peak >= TRAIL_ARM_PCT && pnlPct <= peak - TRAIL_FROM_PEAK_PCT) exitReason = "trailing_stop";
      else if (ageMin >= MAX_HOLD_MIN) exitReason = "timeout";
      if (!exitReason) {
        // not resolved — advance peak/last price
        await sb.from("stacked_filter_shadow").update({ peak_pct: peak, last_price: cur, last_polled_at: new Date().toISOString() }).eq("id", r.id);
        advanced++; continue;
      }
    }
    if (!exitReason) continue; // no price yet, too young to call rug
    await sb.from("stacked_filter_shadow").update({
      sim_exit_price: exitPrice, sim_exit_reason: exitReason, sim_pnl_pct: pnlPct,
      sim_hold_secs: Math.round(ageMin * 60), outcome_resolved_at: new Date().toISOString(), last_price: cur ?? 0,
    }).eq("id", r.id);
    resolved++;
  }
  console.log(`resolved=${resolved} advanced=${advanced}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
