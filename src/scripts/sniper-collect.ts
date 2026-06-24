/**
 * SNIPER-v1 launch-sniper edge probe collector. Shadow-only: no SOL, no
 * broadcast, no bot_state/tracked_wallets writes. Detects new pump.fun launches
 * via Helius (type=CREATE), snapshots t0 price at detection, and paper-sims the
 * single entry forward with the hardened shadow-paper-sim exit model.
 *
 * Pre-registration: docs/ops/launch-sniper-probe-SNIPER-v1.md
 * BROAD CAPTURE ONLY — no filtering at capture. Cuts (detection_lag, liquidity,
 * etc.) are applied by sniper-report.ts from the launch_sniper_policy row, never
 * hardcoded here (LOCKED build rules: dynamic/policy-driven).
 *
 * v1 captures S1 (detection_lag) + price + forward outcome. S2-S8 features are
 * deferred (stored null) until the broad population shows life — no point paying
 * per-launch RugCheck/holder calls to filter a population that may be flatly -EV.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";
import {
  MISSING_PRICE_CONFIRM_MIN,
  RUG_AFTER_MIN,
  RUG_OR_MISSING_PNL_PCT,
  confirmedPrice,
  evaluatePaperSimExit,
} from "./shadow-paper-sim";

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const CREATE_FETCH_LIMIT = 100;
const MAX_NEW_PER_RUN = 40;
const MAX_OPEN_PER_RUN = 80;

function env() {
  const text = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  const m: Record<string, string> = {};
  for (const l of text.split("\n")) { const x = l.match(/^([A-Z_0-9]+)=(.*)$/); if (x) m[x[1]] = x[2].replace(/^["']|["']$/g, ""); }
  return m;
}

/** Pull the newly-created pump.fun mint out of a Helius parsed CREATE tx. */
function extractPumpMint(tx: any): string | null {
  const candidates: string[] = [];
  for (const tt of tx.tokenTransfers || []) if (tt.mint) candidates.push(tt.mint);
  for (const ad of tx.accountData || []) if (ad.account) candidates.push(ad.account);
  const pump = candidates.find((a) => typeof a === "string" && a.endsWith("pump"));
  return pump || null;
}

async function fetchNewLaunches(sb: any, key: string) {
  const url = `https://api.helius.xyz/v0/addresses/${PUMP_PROGRAM}/transactions?api-key=${key}&type=CREATE&limit=${CREATE_FETCH_LIMIT}`;
  let txs: any[] = [];
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) { console.error(`sniper helius CREATE fetch HTTP ${r.status}`); return; }
    txs = (await r.json()) as any[];
  } catch (e) {
    console.error("sniper helius fetch failed:", String(e).slice(0, 120));
    return;
  }

  // Build (mint, creation_time) candidates; creation_time = on-chain block time.
  const launches = txs
    .map((t) => {
      const mint = extractPumpMint(t);
      const ts = typeof t.timestamp === "number" ? t.timestamp : null; // unix secs
      return mint && ts ? { mint, creationTime: new Date(ts * 1000) } : null;
    })
    .filter(Boolean) as Array<{ mint: string; creationTime: Date }>;

  // Dedup vs already-captured (unique index on (mint, creation_time) also guards).
  const oldestIso = launches.length
    ? new Date(Math.min(...launches.map((l) => l.creationTime.getTime())) - 60_000).toISOString()
    : new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: existing } = await sb
    .from("launch_sniper_shadow")
    .select("mint,creation_time")
    .gte("creation_time", oldestIso);
  const seen = new Set((existing || []).map((r: any) => `${r.mint}|${new Date(r.creation_time).getTime()}`));
  const todo = launches
    .filter((l) => !seen.has(`${l.mint}|${l.creationTime.getTime()}`))
    .slice(0, MAX_NEW_PER_RUN);
  console.log(`sniper CREATE txs=${txs.length} launches=${launches.length} already=${seen.size} processing=${todo.length}`);

  let inserted = 0, skippedNoPrice = 0;
  for (const l of todo) {
    const firstSeen = new Date();
    const priceT0 = await confirmedPrice(l.mint);
    if (priceT0 === null || priceT0 <= 0) { skippedNoPrice++; continue; }
    const detectionLagSecs = Math.max(0, Math.round((firstSeen.getTime() - l.creationTime.getTime()) / 1000));
    const { error: insErr } = await sb.from("launch_sniper_shadow").insert({
      first_seen_at: firstSeen.toISOString(),
      mint: l.mint,
      coin_name: null, // v1: not extracted; verdict does not depend on it
      creation_time: l.creationTime.toISOString(),
      detection_lag_secs: detectionLagSecs, // S1
      guard_passing: null,
      price_t0: priceT0,
      peak_pct: 0,
      last_price: priceT0,
      last_polled_at: firstSeen.toISOString(),
    });
    if (insErr && !insErr.message.includes("duplicate")) console.error(`sniper insert ${l.mint.slice(0, 8)}:`, insErr.message);
    else inserted++;
  }
  console.log(`sniper inserted=${inserted} skipped_no_price=${skippedNoPrice}`);
}

async function advanceOpenRows(sb: any) {
  const { data: rows, error } = await sb
    .from("launch_sniper_shadow")
    .select("*")
    .is("resolved_at", null)
    .not("price_t0", "is", null)
    .order("first_seen_at", { ascending: true })
    .limit(MAX_OPEN_PER_RUN);
  if (error) { console.error("launch_sniper_shadow read:", error.message); process.exit(1); }

  const counts: Record<string, number> = {};
  for (const row of rows || []) {
    const now = new Date();
    const entry = Number(row.price_t0);
    const firstSeen = new Date(row.first_seen_at);
    const ageMin = (now.getTime() - firstSeen.getTime()) / 60_000;

    const cur = await confirmedPrice(row.mint);
    if (cur === null || cur <= 0) {
      const priorMissingAt = row.last_price === null && row.last_polled_at ? new Date(row.last_polled_at).getTime() : null;
      const missingConfirmed = priorMissingAt !== null && (now.getTime() - priorMissingAt) / 60_000 >= MISSING_PRICE_CONFIRM_MIN;
      if (ageMin >= RUG_AFTER_MIN && missingConfirmed) {
        await sb.from("launch_sniper_shadow").update({
          sim_exit_price: 0, exit_reason: "rug_or_missing", sim_pnl_pct: RUG_OR_MISSING_PNL_PCT,
          sim_hold_secs: Math.round(ageMin * 60), resolved_at: now.toISOString(),
          last_price: 0, last_polled_at: now.toISOString(),
        }).eq("id", row.id);
        counts.resolved = (counts.resolved || 0) + 1;
      } else {
        await sb.from("launch_sniper_shadow").update({ last_price: null, last_polled_at: now.toISOString() }).eq("id", row.id);
        counts.missing_pending = (counts.missing_pending || 0) + 1;
      }
      continue;
    }

    const decision = evaluatePaperSimExit(entry, cur, Number(row.peak_pct) || 0, ageMin);
    if (!decision.exitReason) {
      await sb.from("launch_sniper_shadow").update({
        peak_pct: decision.peak, last_price: cur, last_polled_at: now.toISOString(),
      }).eq("id", row.id);
      counts.advanced = (counts.advanced || 0) + 1;
      continue;
    }
    await sb.from("launch_sniper_shadow").update({
      sim_exit_price: decision.exitPrice, exit_reason: decision.exitReason, sim_pnl_pct: decision.pnlPct,
      sim_hold_secs: Math.round(ageMin * 60), resolved_at: now.toISOString(),
      last_price: cur, last_polled_at: now.toISOString(),
    }).eq("id", row.id);
    counts.resolved = (counts.resolved || 0) + 1;
  }
  console.log(`sniper advance open=${rows?.length || 0}`, counts);
}

async function main() {
  const m = env();
  const key = m.HELIUS_API_KEY || m.HELIUS_KEY;
  if (!key) { console.error("BLOCKED: no Helius key in env"); process.exit(1); }
  const sb = createClient(m.NEXT_PUBLIC_SUPABASE_URL!, m.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  await fetchNewLaunches(sb, key);
  await advanceOpenRows(sb);
}

main().catch((e) => { console.error(e); process.exit(1); });
