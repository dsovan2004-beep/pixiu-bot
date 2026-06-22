/**
 * Shadow report (read-only). Evaluates TR-v1 forward evidence against the
 * pre-registered success criteria: net sim PnL of would_enter, avoided loss
 * (would_block), discrimination, trailing preservation, FP/FN, coverage, and a
 * walk-forward split. No SOL. Requires migration 020 + collected/resolved rows.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";

function env() {
  const text = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  const m: Record<string, string> = {};
  for (const l of text.split("\n")) { const x = l.match(/^([A-Z_0-9]+)=(.*)$/); if (x) m[x[1]] = x[2].replace(/^["']|["']$/g, ""); }
  return m;
}
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
function grp(rows: any[]) {
  const p = rows.map((r) => Number(r.sim_pnl_pct));
  const w = p.filter((x) => x > 0).length;
  const trail = rows.filter((r) => r.sim_exit_reason === "trailing_stop");
  return { n: rows.length, meanPct: mean(p), sumPct: p.reduce((s, v) => s + v, 0), win: rows.length ? (100 * w / rows.length) : 0, trailN: trail.length, trailMean: mean(trail.map((r) => Number(r.sim_pnl_pct))) };
}
function line(label: string, g: ReturnType<typeof grp>) {
  console.log(`  ${label}: n=${g.n} meanPnl%=${g.meanPct.toFixed(2)} sum%=${g.sumPct.toFixed(1)} win%=${g.win.toFixed(1)} trailing=${g.trailN}`);
}

async function main() {
  const m = env();
  const sb = createClient(m.NEXT_PUBLIC_SUPABASE_URL!, m.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data, error } = await sb.from("stacked_filter_shadow").select("*").order("decision_time", { ascending: true });
  if (error) { console.error(error.message); process.exit(1); }
  const all = data || [];
  const resolved = all.filter((r) => r.outcome_resolved_at);
  const enter = resolved.filter((r) => r.would_enter);
  const block = resolved.filter((r) => r.would_block);

  console.log(`=== TR-v1 forward shadow report ===`);
  console.log(`decisions=${all.length} resolved=${resolved.length} (enter=${enter.length} block=${block.length}) unresolved=${all.length - resolved.length}`);
  // coverage
  const critMissing = all.filter((r) => (r.missing_metrics || []).some((x: string) => x.startsWith("C"))).length;
  const lowConf = all.filter((r) => Number(r.provider_confidence) < 0.7).length;
  console.log(`coverage: critical-missing=${critMissing}/${all.length} low-provider-confidence=${lowConf}/${all.length}`);

  console.log(`\n=== outcomes (sim PnL %) ===`);
  const gE = grp(enter), gB = grp(block);
  line("would_ENTER", gE);
  line("would_BLOCK", gB);
  console.log(`  discrimination (enter mean − block mean) = ${(gE.meanPct - gB.meanPct).toFixed(2)} pct  (want > 0)`);
  console.log(`  avoided loss (block sum%) = ${gB.sumPct.toFixed(1)}  (want negative)`);

  // FP / FN
  const fp = enter.filter((r) => Number(r.sim_pnl_pct) < 0).length;
  const fn = block.filter((r) => Number(r.sim_pnl_pct) > 0).length;
  console.log(`  false positives (enter & lost) = ${fp}/${enter.length}; false negatives (block & won) = ${fn}/${block.length}`);

  // walk-forward split (by decision_time)
  if (resolved.length >= 4) {
    const half = Math.floor(resolved.length / 2);
    const w1 = resolved.slice(0, half), w2 = resolved.slice(half);
    console.log(`\n=== walk-forward (would_ENTER per window) ===`);
    line("window-1 enter", grp(w1.filter((r) => r.would_enter)));
    line("window-2 enter", grp(w2.filter((r) => r.would_enter)));
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
