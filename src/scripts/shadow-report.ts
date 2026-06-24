/**
 * Shadow report (read-only). Evaluates TR-v1 forward evidence against the
 * pre-registered success criteria: net sim PnL of would_enter, avoided loss
 * (would_block), discrimination, trailing preservation, FP/FN, coverage, and a
 * walk-forward split. No SOL. Requires migration 020 + collected/resolved rows.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";

const FAIR_RESOLUTION_WINDOW_MIN = 120;

function env() {
  const text = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  const m: Record<string, string> = {};
  for (const l of text.split("\n")) { const x = l.match(/^([A-Z_0-9]+)=(.*)$/); if (x) m[x[1]] = x[2].replace(/^["']|["']$/g, ""); }
  return m;
}
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
function grp(rows: any[]) {
  const p = rows.map((r) => Number(r.sim_pnl_pct)).filter((v) => Number.isFinite(v));
  const w = p.filter((x) => x > 0).length;
  const trail = rows.filter((r) => r.sim_exit_reason === "trailing_stop");
  return { n: rows.length, meanPct: mean(p), sumPct: p.reduce((s, v) => s + v, 0), win: rows.length ? (100 * w / rows.length) : 0, trailN: trail.length, trailMean: mean(trail.map((r) => Number(r.sim_pnl_pct))) };
}
function line(label: string, g: ReturnType<typeof grp>) {
  console.log(`  ${label}: n=${g.n} meanPnl%=${g.meanPct.toFixed(2)} sum%=${g.sumPct.toFixed(1)} win%=${g.win.toFixed(1)} trailing=${g.trailN}`);
}
function rowAgeMin(r: any) {
  return (Date.now() - new Date(r.decision_time).getTime()) / 60_000;
}
function matureRows(rows: any[]) {
  return rows.filter((r) => rowAgeMin(r) >= FAIR_RESOLUTION_WINDOW_MIN);
}
function componentsOf(r: any): Record<string, any> {
  if (!r.components) return {};
  if (typeof r.components === "string") {
    try { return JSON.parse(r.components); } catch { return {}; }
  }
  return r.components;
}
function guardPassingTagged(r: any) {
  const c = componentsOf(r);
  return r.guard_passing === true ||
    r.webhook_guards_passed === true ||
    c.guard_passing === true ||
    c.webhook_guards_passed === true ||
    c.webhook_guard_passing === true;
}
function reportPopulation(label: string, rows: any[]) {
  const enter = rows.filter((r) => r.would_enter);
  const block = rows.filter((r) => r.would_block);
  console.log(`\n=== ${label} outcomes (sim PnL %, mature resolved only) ===`);
  const gE = grp(enter), gB = grp(block);
  line("would_ENTER", gE);
  line("would_BLOCK", gB);
  console.log(`  discrimination (enter mean − block mean) = ${(gE.meanPct - gB.meanPct).toFixed(2)} pct  (want > 0)`);
  console.log(`  avoided loss (block sum%) = ${gB.sumPct.toFixed(1)}  (want negative)`);

  const fp = enter.filter((r) => Number(r.sim_pnl_pct) < 0).length;
  const fn = block.filter((r) => Number(r.sim_pnl_pct) > 0).length;
  console.log(`  false positives (enter & lost) = ${fp}/${enter.length}; false negatives (block & won) = ${fn}/${block.length}`);

  if (rows.length >= 4) {
    const half = Math.floor(rows.length / 2);
    const w1 = rows.slice(0, half), w2 = rows.slice(half);
    console.log(`\n=== ${label} walk-forward (would_ENTER per window) ===`);
    line("window-1 enter", grp(w1.filter((r) => r.would_enter)));
    line("window-2 enter", grp(w2.filter((r) => r.would_enter)));
  }

  return { enter, block, gE, gB };
}

async function main() {
  const m = env();
  const sb = createClient(m.NEXT_PUBLIC_SUPABASE_URL!, m.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  // paginate — PostgREST caps a single select at 1000 rows; read the FULL dataset
  // so the walk-forward / PnL aggregates reflect every decision, not a stale slice.
  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("stacked_filter_shadow")
      .select("*")
      .order("decision_time", { ascending: true })
      .range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  const resolved = all.filter((r) => r.outcome_resolved_at);
  const mature = matureRows(all);
  const matureResolved = mature.filter((r) => r.outcome_resolved_at);
  const immatureResolved = resolved.length - matureResolved.length;
  const matureEnterCount = matureResolved.filter((r) => r.would_enter).length;
  const matureBlockCount = matureResolved.filter((r) => r.would_block).length;

  console.log(`=== TR-v1 forward shadow report ===`);
  console.log(`decisions=${all.length} resolved=${resolved.length}; mature_resolved=${matureResolved.length} (enter=${matureEnterCount} block=${matureBlockCount}) unresolved=${all.length - resolved.length}`);
  console.log(`fair-window: ${FAIR_RESOLUTION_WINDOW_MIN}m; mature decisions=${mature.length}; mature resolved=${matureResolved.length}; immature resolved excluded=${immatureResolved}`);
  // coverage
  const critMissing = all.filter((r) => (r.missing_metrics || []).some((x: string) => x.startsWith("C"))).length;
  const lowConf = all.filter((r) => Number(r.provider_confidence) < 0.7).length;
  console.log(`coverage: critical-missing=${critMissing}/${all.length} low-provider-confidence=${lowConf}/${all.length}`);

  const { enter, gE, gB } = reportPopulation("broad population", matureResolved);

  const guardTagged = matureResolved.filter(guardPassingTagged);
  console.log(`\n=== guard-passing-only view ===`);
  if (guardTagged.length === 0) {
    console.log("  BLOCKED: no guard_passing/webhook_guards_passed metadata found in stacked_filter_shadow rows.");
    console.log("  Not inferring 15-webhook-guard pass from TR-v1 would_enter/would_block.");
  } else {
    reportPopulation("guard-passing-only population", guardTagged);
  }

  // verdict hint vs pre-registered criteria (TR-v1 §7/§8)
  const enough = enter.length >= 50;
  const positive = gE.sumPct > 0 && gE.meanPct > 0;
  const discriminates = gE.meanPct - gB.meanPct > 0;
  const trailKept = gE.trailN > 0;
  console.log(`\n=== pre-registered gate check (TR-v1) ===`);
  console.log(`  N≥50 would_enter: ${enough} (${enter.length})`);
  console.log(`  net positive: ${positive}`);
  console.log(`  discriminates (enter>block): ${discriminates}`);
  console.log(`  trailing preserved: ${trailKept}`);
  console.log(`  → EDGE PROVEN: ${enough && positive && discriminates && trailKept ? "candidate YES (confirm walk-forward)" : "NO / insufficient"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
