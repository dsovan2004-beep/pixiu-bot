/**
 * Daily post-mortem — 5 read-only analytical cuts on closed trades.
 *
 * Usage:   npx tsx src/scripts/daily-postmortem.ts
 *
 * Cuts:
 *   1. Wallet-tag WR:       trades, WR, total/avg real_pnl_sol per tag
 *   2. Grid-level WR:       L0..L3 x exit_reason breakdown
 *   3. Token age at entry:  <5m / 5-30m / 30m-2h / 2-6h / 6-24h / >24h
 *   4. 24h vs 24-48h diff:  which wallet_tags flipped net-positive → negative
 *   5. Fat-tail isolation:  agent +238% and Asteroid +101% — co-buyers,
 *                           token age, entry mcap (best-effort), vs median loser
 *
 * Read-only. Does not write to DB. Does not touch swap/runtime code.
 */

import "../lib/supabase-server";
import supabase from "../lib/supabase-server";

// ─── Formatters ─────────────────────────────────────────────

const fmt = (n: number, decimals = 4) =>
  (n >= 0 ? "+" : "") + n.toFixed(decimals);
const pct = (n: number, decimals = 2) => n.toFixed(decimals) + "%";

function table(
  rows: Array<Record<string, string | number>>,
  cols: string[]
): void {
  if (rows.length === 0) {
    console.log("  (no rows)");
    return;
  }
  // Column widths: max of header length and longest stringified value.
  const widths: Record<string, number> = {};
  for (const c of cols) widths[c] = c.length;
  for (const r of rows) {
    for (const c of cols) {
      const v = String(r[c] ?? "");
      if (v.length > widths[c]) widths[c] = v.length;
    }
  }
  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
  console.log("  " + cols.map((c) => pad(c, widths[c])).join("  "));
  console.log("  " + cols.map((c) => "-".repeat(widths[c])).join("  "));
  for (const r of rows) {
    console.log(
      "  " + cols.map((c) => pad(String(r[c] ?? ""), widths[c])).join("  ")
    );
  }
}

// ─── Data fetch ─────────────────────────────────────────────

type Trade = {
  id: string;
  coin_address: string;
  coin_name: string | null;
  wallet_tag: string | null;
  entry_price: number | null;
  exit_price: number | null;
  entry_sol_cost: number | null;
  real_pnl_sol: number | null;
  partial_pnl: number | null;
  grid_level: number | null;
  exit_reason: string | null;
  entry_time: string;
  exit_time: string | null;
  status: string;
};

async function fetchClosedTrades(sinceISO: string): Promise<Trade[]> {
  // Only `closed` rows with real_pnl_sol populated are ground-truth outcomes.
  // Excludes failed, unsellable_6024, or closing rows.
  const { data, error } = await supabase
    .from("trades")
    .select(
      "id,coin_address,coin_name,wallet_tag,entry_price,exit_price,entry_sol_cost,real_pnl_sol,partial_pnl,grid_level,exit_reason,entry_time,exit_time,status"
    )
    .eq("status", "closed")
    .not("real_pnl_sol", "is", null)
    .gte("exit_time", sinceISO)
    .order("exit_time", { ascending: true });

  if (error) throw new Error(`trades fetch failed: ${error.message}`);
  return (data ?? []) as Trade[];
}

// ─── Cut 1: Wallet-tag WR ───────────────────────────────────

function cutWalletTag(trades: Trade[]): void {
  console.log("\n═══ 1. WALLET-TAG WR ═══\n");

  const byTag = new Map<
    string,
    { trades: number; wins: number; total: number }
  >();
  for (const t of trades) {
    const tag = t.wallet_tag ?? "(null)";
    const pnl = Number(t.real_pnl_sol ?? 0);
    const row = byTag.get(tag) ?? { trades: 0, wins: 0, total: 0 };
    row.trades += 1;
    if (pnl > 0) row.wins += 1;
    row.total += pnl;
    byTag.set(tag, row);
  }

  const rows = [...byTag.entries()]
    .map(([tag, v]) => ({
      wallet_tag: tag.length > 40 ? tag.slice(0, 37) + "..." : tag,
      trades: v.trades,
      wins: v.wins,
      WR: pct((v.wins / v.trades) * 100, 1),
      total_pnl: fmt(v.total, 4),
      avg_pnl: fmt(v.total / v.trades, 4),
    }))
    .sort(
      (a, b) => Number(b.total_pnl.replace("+", "")) - Number(a.total_pnl.replace("+", ""))
    );

  table(rows, ["wallet_tag", "trades", "wins", "WR", "total_pnl", "avg_pnl"]);
}

// ─── Cut 2: Grid-level WR ───────────────────────────────────

function cutGridLevel(trades: Trade[]): void {
  console.log("\n═══ 2. GRID-LEVEL WR ═══\n");

  type Bucket = { trades: number; wins: number; total: number; sumExitPct: number };
  const byGrid = new Map<number, Bucket>();
  const byGridReason = new Map<string, Bucket>();

  for (const t of trades) {
    const grid = t.grid_level ?? 0;
    const pnl = Number(t.real_pnl_sol ?? 0);
    const entryCost = Number(t.entry_sol_cost ?? 0);
    const exitPct = entryCost > 0 ? (pnl / entryCost) * 100 : 0;

    const g = byGrid.get(grid) ?? { trades: 0, wins: 0, total: 0, sumExitPct: 0 };
    g.trades += 1;
    if (pnl > 0) g.wins += 1;
    g.total += pnl;
    g.sumExitPct += exitPct;
    byGrid.set(grid, g);

    const key = `L${grid}/${t.exit_reason ?? "none"}`;
    const gr = byGridReason.get(key) ?? { trades: 0, wins: 0, total: 0, sumExitPct: 0 };
    gr.trades += 1;
    if (pnl > 0) gr.wins += 1;
    gr.total += pnl;
    gr.sumExitPct += exitPct;
    byGridReason.set(key, gr);
  }

  const rows = [...byGrid.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([grid, v]) => ({
      grid: `L${grid}`,
      trades: v.trades,
      wins: v.wins,
      WR: pct((v.wins / v.trades) * 100, 1),
      total_pnl: fmt(v.total, 4),
      avg_pnl: fmt(v.total / v.trades, 4),
      avg_exit_pct: pct(v.sumExitPct / v.trades, 1),
    }));
  table(rows, ["grid", "trades", "wins", "WR", "total_pnl", "avg_pnl", "avg_exit_pct"]);

  console.log("\n  Grid × exit_reason breakdown:\n");
  const subRows = [...byGridReason.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, v]) => ({
      bucket: key,
      trades: v.trades,
      wins: v.wins,
      WR: pct((v.wins / v.trades) * 100, 1),
      total_pnl: fmt(v.total, 4),
      avg_pnl: fmt(v.total / v.trades, 4),
    }));
  table(subRows, ["bucket", "trades", "wins", "WR", "total_pnl", "avg_pnl"]);
}

// ─── Cut 3: Token age at entry ──────────────────────────────

async function cutTokenAge(trades: Trade[]): Promise<void> {
  console.log("\n═══ 3. TOKEN AGE AT ENTRY ═══\n");

  // Proxy for "token first seen": earliest coin_signals row for that mint.
  // If we have no prior signal, treat as "age=0" (first-seen-at-entry).
  const mints = [...new Set(trades.map((t) => t.coin_address))];
  const firstSeen = new Map<string, number>(); // mint → epoch ms

  // Fetch in chunks to avoid query length limits.
  const CHUNK = 100;
  for (let i = 0; i < mints.length; i += CHUNK) {
    const chunk = mints.slice(i, i + CHUNK);
    const { data } = await supabase
      .from("coin_signals")
      .select("coin_address,signal_time")
      .in("coin_address", chunk)
      .order("signal_time", { ascending: true });
    for (const r of data ?? []) {
      const addr = (r as any).coin_address as string;
      const t = new Date((r as any).signal_time).getTime();
      const cur = firstSeen.get(addr);
      if (cur === undefined || t < cur) firstSeen.set(addr, t);
    }
  }

  type Bucket = { label: string; trades: number; wins: number; total: number };
  const buckets: Bucket[] = [
    { label: "<5m", trades: 0, wins: 0, total: 0 },
    { label: "5-30m", trades: 0, wins: 0, total: 0 },
    { label: "30m-2h", trades: 0, wins: 0, total: 0 },
    { label: "2-6h", trades: 0, wins: 0, total: 0 },
    { label: "6-24h", trades: 0, wins: 0, total: 0 },
    { label: ">24h", trades: 0, wins: 0, total: 0 },
    { label: "(unknown)", trades: 0, wins: 0, total: 0 },
  ];

  for (const t of trades) {
    const pnl = Number(t.real_pnl_sol ?? 0);
    const seen = firstSeen.get(t.coin_address);
    const entryMs = new Date(t.entry_time).getTime();
    if (seen === undefined) {
      buckets[6].trades += 1;
      if (pnl > 0) buckets[6].wins += 1;
      buckets[6].total += pnl;
      continue;
    }
    const ageMin = (entryMs - seen) / 60_000;
    let idx = 6;
    if (ageMin < 5) idx = 0;
    else if (ageMin < 30) idx = 1;
    else if (ageMin < 120) idx = 2;
    else if (ageMin < 360) idx = 3;
    else if (ageMin < 1440) idx = 4;
    else idx = 5;
    buckets[idx].trades += 1;
    if (pnl > 0) buckets[idx].wins += 1;
    buckets[idx].total += pnl;
  }

  const rows = buckets
    .filter((b) => b.trades > 0)
    .map((b) => ({
      age: b.label,
      trades: b.trades,
      wins: b.wins,
      WR: pct((b.wins / b.trades) * 100, 1),
      total_pnl: fmt(b.total, 4),
      avg_pnl: fmt(b.total / b.trades, 4),
    }));
  table(rows, ["age", "trades", "wins", "WR", "total_pnl", "avg_pnl"]);
  console.log(
    "\n  Note: age = entry_time − min(coin_signals.signal_time) for the mint."
  );
  console.log(
    "        '(unknown)' means no prior signal observed — webhook-on-entry."
  );
}

// ─── Cut 4: 24h vs 24-48h comparison ────────────────────────

function cutTodayVsYesterday(
  todayTrades: Trade[],
  yesterdayTrades: Trade[]
): void {
  console.log("\n═══ 4. 24h vs 24-48h COMPARISON ═══\n");

  type Agg = { trades: number; wins: number; total: number };
  const agg = (rows: Trade[]) => {
    const m = new Map<string, Agg>();
    for (const t of rows) {
      const tag = t.wallet_tag ?? "(null)";
      const pnl = Number(t.real_pnl_sol ?? 0);
      const v = m.get(tag) ?? { trades: 0, wins: 0, total: 0 };
      v.trades += 1;
      if (pnl > 0) v.wins += 1;
      v.total += pnl;
      m.set(tag, v);
    }
    return m;
  };

  const today = agg(todayTrades);
  const yest = agg(yesterdayTrades);

  const summary = (label: string, rows: Trade[]) => {
    const tr = rows.length;
    const wn = rows.filter((r) => Number(r.real_pnl_sol ?? 0) > 0).length;
    const tot = rows.reduce(
      (s, r) => s + Number(r.real_pnl_sol ?? 0),
      0
    );
    console.log(
      `  ${label}: ${tr} trades, ${wn}W, WR ${pct((wn / Math.max(tr, 1)) * 100, 1)}, net ${fmt(tot, 4)} SOL`
    );
  };
  summary("last 24h", todayTrades);
  summary("24-48h ago", yesterdayTrades);

  // Tags that flipped direction
  console.log("\n  Per-tag delta (yesterday → today):\n");
  const allTags = new Set<string>([...today.keys(), ...yest.keys()]);
  const deltaRows: Array<{
    tag: string;
    y_trades: number | string;
    y_pnl: string;
    t_trades: number | string;
    t_pnl: string;
    flipped: string;
  }> = [];
  for (const tag of allTags) {
    const y = yest.get(tag);
    const t = today.get(tag);
    const yPnl = y?.total ?? 0;
    const tPnl = t?.total ?? 0;
    const flipped =
      y && t && yPnl > 0 && tPnl < 0
        ? "YES (+→−)"
        : y && t && yPnl < 0 && tPnl > 0
        ? "yes (−→+)"
        : "";
    deltaRows.push({
      tag: tag.length > 30 ? tag.slice(0, 27) + "..." : tag,
      y_trades: y?.trades ?? "-",
      y_pnl: y ? fmt(yPnl, 4) : "-",
      t_trades: t?.trades ?? "-",
      t_pnl: t ? fmt(tPnl, 4) : "-",
      flipped,
    });
  }
  deltaRows.sort((a, b) => {
    // Flipped first, then by today's PnL ascending (worst today first)
    if (a.flipped && !b.flipped) return -1;
    if (!a.flipped && b.flipped) return 1;
    const aPnl = Number(String(a.t_pnl).replace("+", "")) || 0;
    const bPnl = Number(String(b.t_pnl).replace("+", "")) || 0;
    return aPnl - bPnl;
  });
  table(deltaRows, ["tag", "y_trades", "y_pnl", "t_trades", "t_pnl", "flipped"]);
}

// ─── Cut 5: Fat-tail winners isolation ──────────────────────

async function cutFatTails(allTrades: Trade[]): Promise<void> {
  console.log("\n═══ 5. FAT-TAIL WINNERS ISOLATION ═══\n");

  // Isolate the two known big winners. Match by coin_name exactly; if
  // either coin_name has ever appeared multiple times, take the highest
  // real_pnl_sol row (that's the winning episode).
  const targets = ["agent", "Asteroid"];
  const winners: Trade[] = [];
  for (const name of targets) {
    const candidates = allTrades
      .filter((t) => (t.coin_name ?? "") === name)
      .sort(
        (a, b) =>
          Number(b.real_pnl_sol ?? 0) - Number(a.real_pnl_sol ?? 0)
      );
    if (candidates[0]) winners.push(candidates[0]);
  }

  if (winners.length === 0) {
    console.log("  No fat-tail winners matched by coin_name (agent, Asteroid).");
    return;
  }

  // Median loser for contrast
  const losers = allTrades
    .filter((t) => Number(t.real_pnl_sol ?? 0) < 0)
    .sort(
      (a, b) =>
        Number(a.real_pnl_sol ?? 0) - Number(b.real_pnl_sol ?? 0)
    );
  const medianLoser =
    losers.length > 0 ? losers[Math.floor(losers.length / 2)] : null;

  console.log("  Winners:\n");
  for (const w of winners) {
    const entryMs = new Date(w.entry_time).getTime();
    const windowStart = new Date(entryMs - 5 * 60_000).toISOString();
    const windowEnd = new Date(entryMs + 5 * 60_000).toISOString();

    // Co-buyers within ±5 min of entry
    const { data: coBuys } = await supabase
      .from("coin_signals")
      .select("wallet_tag,signal_time,transaction_type")
      .eq("coin_address", w.coin_address)
      .eq("transaction_type", "BUY")
      .gte("signal_time", windowStart)
      .lte("signal_time", windowEnd)
      .order("signal_time", { ascending: true });

    // First-seen for age calc
    const { data: firstSignal } = await supabase
      .from("coin_signals")
      .select("signal_time")
      .eq("coin_address", w.coin_address)
      .order("signal_time", { ascending: true })
      .limit(1);
    const firstSeenMs = firstSignal?.[0]
      ? new Date((firstSignal[0] as any).signal_time).getTime()
      : null;
    const ageMin =
      firstSeenMs != null ? (entryMs - firstSeenMs) / 60_000 : null;

    const pnl = Number(w.real_pnl_sol ?? 0);
    const entryCost = Number(w.entry_sol_cost ?? 0);
    const returnPct = entryCost > 0 ? (pnl / entryCost) * 100 : 0;

    console.log(`  ▸ ${w.coin_name} (${w.coin_address.slice(0, 8)}...)`);
    console.log(`      wallet_tag:     ${w.wallet_tag}`);
    console.log(`      entry_time:     ${w.entry_time}`);
    console.log(
      `      entry_sol_cost: ${entryCost.toFixed(6)}   real_pnl: ${fmt(pnl, 6)}   return: ${pct(returnPct, 1)}`
    );
    console.log(
      `      grid/exit:      L${w.grid_level}/${w.exit_reason}`
    );
    console.log(
      `      token_age_min:  ${ageMin != null ? ageMin.toFixed(2) : "(unknown)"}`
    );
    const coBuyTags = [
      ...new Set((coBuys ?? []).map((c) => (c as any).wallet_tag as string)),
    ];
    console.log(
      `      co-buyers ±5m:  ${coBuyTags.length} distinct [${coBuyTags.join(", ")}]`
    );
    console.log("");
  }

  if (medianLoser) {
    const ml = medianLoser;
    const mlPnl = Number(ml.real_pnl_sol ?? 0);
    const mlCost = Number(ml.entry_sol_cost ?? 0);
    const mlRet = mlCost > 0 ? (mlPnl / mlCost) * 100 : 0;
    console.log("  Median loser (for contrast):\n");
    console.log(
      `  ▸ ${ml.coin_name} (${ml.coin_address.slice(0, 8)}...)`
    );
    console.log(`      wallet_tag:     ${ml.wallet_tag}`);
    console.log(
      `      entry_sol_cost: ${mlCost.toFixed(6)}   real_pnl: ${fmt(mlPnl, 6)}   return: ${pct(mlRet, 1)}`
    );
    console.log(
      `      grid/exit:      L${ml.grid_level}/${ml.exit_reason}`
    );
  }

  console.log(
    "\n  Note: entry_mcap not stored on trades; not available in this cut."
  );
  console.log(
    "        If you want mcap-at-entry, we'd need to store it at buy time."
  );
}

// ─── Main ───────────────────────────────────────────────────

(async () => {
  const now = Date.now();
  const since48h = new Date(now - 48 * 60 * 60 * 1000).toISOString();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  console.log("\n═══ PixiuBot Daily Postmortem ═══");
  console.log(`  now:       ${new Date(now).toISOString()}`);
  console.log(`  window:    last 48h (closed, real_pnl_sol populated)\n`);

  const all48h = await fetchClosedTrades(since48h);
  const today = all48h.filter((t) => (t.exit_time ?? "") >= since24h);
  const yest = all48h.filter((t) => (t.exit_time ?? "") < since24h);

  console.log(
    `  trades: 48h=${all48h.length}  |  24h=${today.length}  |  24-48h=${yest.length}`
  );

  // Cuts 1 + 2 over last 24h (the "today" postmortem focus)
  cutWalletTag(today);
  cutGridLevel(today);

  // Cut 3: age buckets over last 24h
  await cutTokenAge(today);

  // Cut 4: today vs yesterday
  cutTodayVsYesterday(today, yest);

  // Cut 5: fat-tail isolation uses 48h window (agent/Asteroid may be >24h old)
  await cutFatTails(all48h);

  console.log("\n═══ end ═══\n");
})().catch((err) => {
  console.error("postmortem failed:", err);
  process.exit(1);
});
