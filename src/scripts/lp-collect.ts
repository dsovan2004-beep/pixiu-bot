/**
 * LP-v1 latency edge probe collector. Shadow-only: no SOL, no broadcast, no
 * bot_state/tracked_wallets writes. Inserts BUY signals into
 * latency_probe_shadow, snapshots t0/+60/+180/+300 prices, and paper-sims each
 * entry timing with the hardened shadow-paper-sim exit model.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";
import {
  MAX_HOLD_MIN,
  MISSING_PRICE_CONFIRM_MIN,
  RUG_AFTER_MIN,
  RUG_OR_MISSING_PNL_PCT,
  confirmedPrice,
  evaluatePaperSimExit,
} from "./shadow-paper-sim";

const LOOKBACK_MIN = 120;
const MAX_NEW_PER_RUN = 40;
const MAX_OPEN_PER_RUN = 80;

type Timing = {
  label: "t0" | "60" | "180" | "300";
  offsetSec: number;
};

const TIMINGS: Timing[] = [
  { label: "t0", offsetSec: 0 },
  { label: "60", offsetSec: 60 },
  { label: "180", offsetSec: 180 },
  { label: "300", offsetSec: 300 },
];

function env() {
  const text = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  const m: Record<string, string> = {};
  for (const l of text.split("\n")) { const x = l.match(/^([A-Z_0-9]+)=(.*)$/); if (x) m[x[1]] = x[2].replace(/^["']|["']$/g, ""); }
  return m;
}

function addSeconds(d: Date, seconds: number) {
  return new Date(d.getTime() + seconds * 1000);
}

function rowKey(timing: Timing, name: string) {
  return `${name}_${timing.label}`;
}

async function insertFreshSignals(sb: any) {
  const sinceIso = new Date(Date.now() - LOOKBACK_MIN * 60_000).toISOString();
  const { data: sigs, error } = await sb
    .from("coin_signals")
    .select("coin_address,coin_name,wallet_tag,signal_time,transaction_type")
    .eq("transaction_type", "BUY")
    .gte("signal_time", sinceIso)
    .order("signal_time", { ascending: false });
  if (error) { console.error("coin_signals read:", error.message); process.exit(1); }

  const { data: existing } = await sb
    .from("latency_probe_shadow")
    .select("coin_address,signal_time")
    .gte("signal_time", sinceIso);
  const seen = new Set((existing || []).map((r: any) => `${r.coin_address}|${r.signal_time}`));
  const todo = (sigs || []).filter((s: any) => !seen.has(`${s.coin_address}|${s.signal_time}`)).slice(0, MAX_NEW_PER_RUN);
  console.log(`lp fresh signals(${LOOKBACK_MIN}m)=${sigs?.length || 0} already=${seen.size} processing=${todo.length}`);

  let inserted = 0, skippedNoPrice = 0;
  for (const s of todo) {
    const firstSeen = new Date();
    const priceT0 = await confirmedPrice(s.coin_address);
    if (priceT0 === null || priceT0 <= 0) {
      skippedNoPrice++;
      continue;
    }

    const { error: insErr } = await sb.from("latency_probe_shadow").insert({
      first_seen_at: firstSeen.toISOString(),
      coin_address: s.coin_address,
      coin_name: s.coin_name,
      signal_time: s.signal_time,
      primary_wallet: s.wallet_tag,
      wallet_tags: [s.wallet_tag].filter(Boolean),
      // Current shadow data has no verified 15-webhook-guard-pass flag. Keep
      // nullable and let lp-report fail closed for the guard-passing view.
      guard_passing: null,
      entry_time_t0: firstSeen.toISOString(),
      entry_time_60: addSeconds(firstSeen, 60).toISOString(),
      entry_time_180: addSeconds(firstSeen, 180).toISOString(),
      entry_time_300: addSeconds(firstSeen, 300).toISOString(),
      price_t0: priceT0,
      peak_pct_t0: 0,
      last_price_t0: priceT0,
      last_polled_at_t0: firstSeen.toISOString(),
    });
    if (insErr && !insErr.message.includes("duplicate")) console.error(`lp insert ${s.coin_address.slice(0, 8)}:`, insErr.message);
    else inserted++;
  }
  console.log(`lp inserted=${inserted} skipped_no_price=${skippedNoPrice}`);
}

async function maybeSnapshotEntryPrice(sb: any, row: any, timing: Timing, now: Date) {
  const priceCol = rowKey(timing, "price");
  if (row[priceCol] !== null && row[priceCol] !== undefined) return row[priceCol] === null ? null : Number(row[priceCol]);
  const entryTime = new Date(row[rowKey(timing, "entry_time")]);
  if (now < entryTime) return null;
  const p = await confirmedPrice(row.coin_address);
  if (p === null || p <= 0) return null;
  await sb.from("latency_probe_shadow").update({
    [priceCol]: p,
    [rowKey(timing, "peak_pct")]: 0,
    [rowKey(timing, "last_price")]: p,
    [rowKey(timing, "last_polled_at")]: now.toISOString(),
  }).eq("id", row.id);
  row[priceCol] = p;
  row[rowKey(timing, "peak_pct")] = 0;
  row[rowKey(timing, "last_price")] = p;
  row[rowKey(timing, "last_polled_at")] = now.toISOString();
  return p;
}

async function advanceTiming(sb: any, row: any, timing: Timing, now: Date) {
  if (row[rowKey(timing, "resolved_at")]) return "already_resolved";

  const entry = await maybeSnapshotEntryPrice(sb, row, timing, now);
  if (entry === null || entry <= 0) return "waiting_entry_price";

  const entryTime = new Date(row[rowKey(timing, "entry_time")]);
  const ageMin = (now.getTime() - entryTime.getTime()) / 60_000;
  if (ageMin < 0) return "waiting_entry_time";

  const cur = await confirmedPrice(row.coin_address);
  if (cur === null || cur <= 0) {
    const priorMissingAt = row[rowKey(timing, "last_price")] === null && row[rowKey(timing, "last_polled_at")]
      ? new Date(row[rowKey(timing, "last_polled_at")]).getTime()
      : null;
    const missingConfirmed = priorMissingAt !== null && (now.getTime() - priorMissingAt) / 60_000 >= MISSING_PRICE_CONFIRM_MIN;
    if (ageMin >= RUG_AFTER_MIN && missingConfirmed) {
      await sb.from("latency_probe_shadow").update({
        [rowKey(timing, "sim_exit_price")]: 0,
        [rowKey(timing, "exit_reason")]: "rug_or_missing",
        [rowKey(timing, "sim_pnl")]: RUG_OR_MISSING_PNL_PCT,
        [rowKey(timing, "sim_hold_secs")]: Math.round(ageMin * 60),
        [rowKey(timing, "resolved_at")]: now.toISOString(),
        [rowKey(timing, "last_price")]: 0,
        [rowKey(timing, "last_polled_at")]: now.toISOString(),
      }).eq("id", row.id);
      row[rowKey(timing, "resolved_at")] = now.toISOString();
      return "resolved";
    }
    await sb.from("latency_probe_shadow").update({
      [rowKey(timing, "last_price")]: null,
      [rowKey(timing, "last_polled_at")]: now.toISOString(),
    }).eq("id", row.id);
    row[rowKey(timing, "last_price")] = null;
    row[rowKey(timing, "last_polled_at")] = now.toISOString();
    return "missing_pending";
  }

  const decision = evaluatePaperSimExit(entry, cur, row[rowKey(timing, "peak_pct")], ageMin);
  if (!decision.exitReason) {
    await sb.from("latency_probe_shadow").update({
      [rowKey(timing, "peak_pct")]: decision.peak,
      [rowKey(timing, "last_price")]: cur,
      [rowKey(timing, "last_polled_at")]: now.toISOString(),
    }).eq("id", row.id);
    row[rowKey(timing, "peak_pct")] = decision.peak;
    row[rowKey(timing, "last_price")] = cur;
    row[rowKey(timing, "last_polled_at")] = now.toISOString();
    return "advanced";
  }

  await sb.from("latency_probe_shadow").update({
    [rowKey(timing, "sim_exit_price")]: decision.exitPrice,
    [rowKey(timing, "exit_reason")]: decision.exitReason,
    [rowKey(timing, "sim_pnl")]: decision.pnlPct,
    [rowKey(timing, "sim_hold_secs")]: Math.round(ageMin * 60),
    [rowKey(timing, "resolved_at")]: now.toISOString(),
    [rowKey(timing, "last_price")]: cur,
    [rowKey(timing, "last_polled_at")]: now.toISOString(),
  }).eq("id", row.id);
  row[rowKey(timing, "resolved_at")] = now.toISOString();
  return "resolved";
}

async function advanceOpenRows(sb: any) {
  const { data: rows, error } = await sb
    .from("latency_probe_shadow")
    .select("*")
    .is("resolved_at", null)
    .order("first_seen_at", { ascending: true })
    .limit(MAX_OPEN_PER_RUN);
  if (error) { console.error("latency_probe_shadow read:", error.message); process.exit(1); }

  const counts: Record<string, number> = {};
  for (const row of rows || []) {
    const now = new Date();
    for (const timing of TIMINGS) {
      const status = await advanceTiming(sb, row, timing, now);
      counts[status] = (counts[status] || 0) + 1;
    }
    const allResolved = TIMINGS.every((timing) => row[rowKey(timing, "resolved_at")]);
    if (allResolved) {
      await sb.from("latency_probe_shadow").update({ resolved_at: new Date().toISOString() }).eq("id", row.id);
      counts.rows_resolved = (counts.rows_resolved || 0) + 1;
    }
  }
  console.log(`lp advance open=${rows?.length || 0}`, counts);
}

async function main() {
  const m = env();
  const sb = createClient(m.NEXT_PUBLIC_SUPABASE_URL!, m.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  await insertFreshSignals(sb);
  await advanceOpenRows(sb);
}

main().catch((e) => { console.error(e); process.exit(1); });

