/**
 * LP-v1 latency edge report. Read-only; no SOL, no broadcast. Paginates the
 * full latency_probe_shadow dataset and compares paper outcomes for t0,
 * +60s, +180s, +300s after the fair max-hold window.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";
import { MAX_HOLD_MIN } from "./shadow-paper-sim";

type Timing = {
  label: "t0" | "60" | "180" | "300";
  display: string;
};

const TIMINGS: Timing[] = [
  { label: "t0", display: "t0" },
  { label: "60", display: "+60s" },
  { label: "180", display: "+180s" },
  { label: "300", display: "+300s" },
];

function env() {
  const text = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  const m: Record<string, string> = {};
  for (const l of text.split("\n")) { const x = l.match(/^([A-Z_0-9]+)=(.*)$/); if (x) m[x[1]] = x[2].replace(/^["']|["']$/g, ""); }
  return m;
}

function key(timing: Timing, name: string) {
  return `${name}_${timing.label}`;
}

const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

function rowAgeMature(row: any) {
  const finalEntryTime = row.entry_time_300 ? new Date(row.entry_time_300).getTime() : 0;
  return Date.now() - finalEntryTime >= MAX_HOLD_MIN * 60_000;
}

function timingRows(rows: any[], timing: Timing) {
  return rows
    .map((row) => ({
      row,
      pnl: Number(row[key(timing, "sim_pnl")]),
      reason: row[key(timing, "exit_reason")] || "unknown",
    }))
    .filter((r) => Number.isFinite(r.pnl) && r.row[key(timing, "resolved_at")]);
}

function timingStats(rows: any[], timing: Timing) {
  const values = timingRows(rows, timing).map((r) => r.pnl);
  const wins = values.filter((v) => v > 0).length;
  return {
    n: values.length,
    meanPct: mean(values),
    sumPct: values.reduce((s, v) => s + v, 0),
    winPct: values.length ? (wins / values.length) * 100 : 0,
  };
}

function printTimingLine(label: string, rows: any[], timing: Timing) {
  const s = timingStats(rows, timing);
  console.log(`  ${label} ${timing.display}: n=${s.n} meanPnl%=${s.meanPct.toFixed(2)} sum%=${s.sumPct.toFixed(1)} win%=${s.winPct.toFixed(1)}`);
}

function printExitReasons(rows: any[], timing: Timing) {
  const grouped = new Map<string, number[]>();
  for (const r of timingRows(rows, timing)) {
    const list = grouped.get(r.reason) || [];
    list.push(r.pnl);
    grouped.set(r.reason, list);
  }
  console.log(`\n  exit reasons ${timing.display}:`);
  for (const [reason, values] of Array.from(grouped.entries()).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${reason}: n=${values.length} meanPnl%=${mean(values).toFixed(2)}`);
  }
}

function reportPopulation(label: string, rows: any[]) {
  console.log(`\n=== ${label} timing comparison (mature rows only) ===`);
  for (const timing of TIMINGS) printTimingLine(label, rows, timing);

  for (const timing of TIMINGS) printExitReasons(rows, timing);

  if (rows.length >= 4) {
    const ordered = [...rows].sort((a, b) => new Date(a.first_seen_at).getTime() - new Date(b.first_seen_at).getTime());
    const half = Math.floor(ordered.length / 2);
    const windows = [
      { label: "window-1", rows: ordered.slice(0, half) },
      { label: "window-2", rows: ordered.slice(half) },
    ];
    console.log(`\n=== ${label} walk-forward ===`);
    for (const w of windows) {
      for (const timing of TIMINGS) printTimingLine(w.label, w.rows, timing);
    }
  }
}

async function main() {
  const m = env();
  const sb = createClient(m.NEXT_PUBLIC_SUPABASE_URL!, m.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("latency_probe_shadow")
      .select("*")
      .order("first_seen_at", { ascending: true })
      .range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
  }

  const mature = all.filter(rowAgeMature);
  const complete = mature.filter((row) => TIMINGS.every((timing) => row[key(timing, "resolved_at")]));
  console.log("=== LP-v1 latency edge probe ===");
  console.log(`rows=${all.length} mature=${mature.length} complete=${complete.length} unresolved_or_immature=${all.length - complete.length}`);

  reportPopulation("broad population", complete);

  const guardKnown = complete.filter((row) => row.guard_passing !== null && row.guard_passing !== undefined);
  const guardPassing = guardKnown.filter((row) => row.guard_passing === true);
  console.log(`\n=== guard-passing-only view ===`);
  if (guardKnown.length === 0) {
    console.log("  BLOCKED: no guard_passing metadata has been recorded yet.");
    console.log("  Not inferring 15-webhook-guard pass from token-risk or LP-v1 outcomes.");
  } else {
    console.log(`  guard_known=${guardKnown.length} guard_passing=${guardPassing.length}`);
    reportPopulation("guard-passing-only population", guardPassing);
  }

  console.log(`\n=== LP-v1 decision hint ===`);
  const t0 = timingStats(complete, TIMINGS[0]);
  const t180 = timingStats(complete, TIMINGS[2]);
  const t300 = timingStats(complete, TIMINGS[3]);
  console.log(`  N>=100 resolved complete: ${complete.length >= 100} (${complete.length})`);
  console.log(`  t0 net positive: ${t0.sumPct > 0 && t0.meanPct > 0}`);
  console.log(`  t0 beats +180/+300: ${t0.meanPct > t180.meanPct && t0.meanPct > t300.meanPct}`);
  console.log(`  → SPEED EDGE CANDIDATE: ${complete.length >= 100 && t0.sumPct > 0 && t0.meanPct > t180.meanPct && t0.meanPct > t300.meanPct ? "YES (confirm walk-forward)" : "NO / insufficient"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

