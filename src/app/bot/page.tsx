"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { LIVE_BUY_SOL } from "@/config/smart-money";

interface BotState {
  id: string;
  is_running: boolean;
  mode: string;
  broadcast_tx: boolean;
  last_updated: string;
}

interface CoinSignal {
  id: string;
  coin_address: string;
  coin_name: string | null;
  wallet_tag: string;
  entry_mc: number | null;
  signal_time: string;
  rug_check_passed: boolean | null;
  price_gap_minutes: number | null;
  bundle_suspected: boolean;
  transaction_type: string;
}

interface Trade {
  id: string;
  coin_address: string;
  coin_name: string | null;
  wallet_tag: string;
  entry_price: number;
  entry_mc: number | null;
  exit_price: number | null;
  real_pnl_sol: number | null;       // authoritative real-SOL outcome
  entry_sol_cost: number | null;     // real SOL spent on entry
  position_size_usd: number | null;
  status: string;
  priority: string;
  entry_time: string;
  exit_time: string | null;
  exit_reason: string | null;
  grid_level: number;
  remaining_pct: number;
  partial_pnl: number;
  mode: string;
}

type ShadowResolvedRow = {
  decision_time: string | null;
  would_enter: boolean;
  would_block: boolean;
  sim_pnl_pct: number | null;
  sim_exit_reason: string | null;
};

type WalkForwardBucket = {
  label: string;
  enterCount: number;
  enterMean: number | null;
  blockCount: number;
  blockMean: number | null;
};

type ExitReasonBucket = {
  reason: string;
  count: number;
  mean: number | null;
};

export default function BotPage() {
  const [botState, setBotState] = useState<BotState | null>(null);
  const [signals, setSignals] = useState<CoinSignal[]>([]);
  const [openTrades, setOpenTrades] = useState<Trade[]>([]);
  const [closedTrades, setClosedTrades] = useState<Trade[]>([]);
  const [walletCount, setWalletCount] = useState(0);
  const [allClosedStats, setAllClosedStats] = useState<
    Array<{ real_pnl_sol: number | null; entry_sol_cost: number | null; exit_reason: string | null; wallet_tag?: string; mode?: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const [phantomBalance, setPhantomBalance] = useState<{
    sol: number; usd: number; solPrice?: number;
  } | null>(null);
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [whaleSells, setWhaleSells] = useState<
    Record<string, Array<{ wallet_tag: string; signal_time: string }>>
  >({});
  // TR-v1 forward shadow validation (read-only; separate from trade PnL)
  const [shadow, setShadow] = useState<{
    policyActive: boolean; ruleVersion: string | null;
    total: number; enter: number; block: number; resolved: number;
    enterSum: number; enterMean: number; enterN: number;
    blockSum: number; blockMean: number; blockN: number;
    trailingN: number; latest: string | null;
    walkForward: WalkForwardBucket[];
    exitReasons: ExitReasonBucket[];
  } | null>(null);

  const fetchData = useCallback(async () => {
    const [stateRes, signalsRes, walletsRes, openRes, closedRes, allClosedRes] =
      await Promise.all([
        supabase
          .from("bot_state")
          .select("*")
          .order("last_updated", { ascending: false })
          .limit(1),
        supabase
          .from("coin_signals")
          .select("*")
          .order("signal_time", { ascending: false })
          .limit(50),
        supabase
          .from("tracked_wallets")
          .select("id", { count: "exact", head: true })
          .eq("active", true),
        supabase
          .from("trades")
          .select("*")
          .in("status", ["open", "closing"])       // include in-flight closes so positions don't vanish during sell-confirm
          .in("mode", ["measure_live", "live"])
          .like("wallet_tag", "%[LIVE]%")
          .order("entry_time", { ascending: false }),
        supabase
          .from("trades")
          .select("*")
          .eq("status", "closed")
          .in("mode", ["measure_live", "live"])
          .order("exit_time", { ascending: false })
          .limit(50),
        supabase
          .from("trades")
          .select("real_pnl_sol, entry_sol_cost, exit_reason, wallet_tag, mode")
          .eq("status", "closed")
          .in("mode", ["measure_live", "live"]),
      ]);

    if (stateRes.data && stateRes.data.length > 0) {
      setBotState(stateRes.data[0]);
    }
    setSignals(signalsRes.data || []);
    setWalletCount(walletsRes.count || 0);
    setOpenTrades(openRes.data || []);
    setClosedTrades(closedRes.data || []);
    setAllClosedStats(allClosedRes.data || []);

    // ── TR-v1 shadow validation (read-only; never gates entries) ──
    try {
      const [pol, total, enterC, blockC, resolvedC, latest] = await Promise.all([
        supabase.from("token_risk_policy").select("rule_version,active").eq("active", true).limit(1),
        supabase.from("stacked_filter_shadow").select("id", { count: "exact", head: true }),
        supabase.from("stacked_filter_shadow").select("id", { count: "exact", head: true }).eq("would_enter", true),
        supabase.from("stacked_filter_shadow").select("id", { count: "exact", head: true }).eq("would_block", true),
        supabase.from("stacked_filter_shadow").select("id", { count: "exact", head: true }).not("outcome_resolved_at", "is", null),
        supabase.from("stacked_filter_shadow").select("decision_time").order("decision_time", { ascending: false }).limit(1),
      ]);
      const rows: ShadowResolvedRow[] = [];
      const resolvedTotal = resolvedC.count || 0;
      for (let from = 0; from < resolvedTotal; from += 1000) {
        const to = Math.min(from + 999, resolvedTotal - 1);
        const { data, error } = await supabase
          .from("stacked_filter_shadow")
          .select("decision_time,would_enter,would_block,sim_pnl_pct,sim_exit_reason")
          .not("outcome_resolved_at", "is", null)
          .order("decision_time", { ascending: true })
          .range(from, to);
        if (error) throw error;
        rows.push(...((data || []) as ShadowResolvedRow[]));
      }
      const er = rows.filter((r) => r.would_enter);
      const br = rows.filter((r) => r.would_block);
      const sum = (a: ShadowResolvedRow[]) => a.reduce((s, r) => s + (Number(r.sim_pnl_pct) || 0), 0);
      const mean = (a: ShadowResolvedRow[]) => a.length ? sum(a) / a.length : null;
      const ordered = [...rows].sort((a, b) => {
        const at = a.decision_time ? new Date(a.decision_time).getTime() : 0;
        const bt = b.decision_time ? new Date(b.decision_time).getTime() : 0;
        return at - bt;
      });
      const midpoint = Math.ceil(ordered.length / 2);
      const windows = [
        { label: "Window 1", rows: ordered.slice(0, midpoint) },
        { label: "Window 2", rows: ordered.slice(midpoint) },
      ];
      const walkForward = windows.map(({ label, rows: bucketRows }) => {
        const enters = bucketRows.filter((r) => r.would_enter);
        const blocks = bucketRows.filter((r) => r.would_block);
        return {
          label,
          enterCount: enters.length,
          enterMean: mean(enters),
          blockCount: blocks.length,
          blockMean: mean(blocks),
        };
      });
      const exitReasonMap = new Map<string, ShadowResolvedRow[]>();
      for (const row of rows) {
        const reason = row.sim_exit_reason || "unknown";
        const list = exitReasonMap.get(reason) || [];
        list.push(row);
        exitReasonMap.set(reason, list);
      }
      const exitReasons = Array.from(exitReasonMap.entries())
        .map(([reason, reasonRows]) => ({
          reason,
          count: reasonRows.length,
          mean: mean(reasonRows),
        }))
        .sort((a, b) => b.count - a.count);
      setShadow({
        policyActive: !!(pol.data && pol.data.length > 0 && pol.data[0].active),
        ruleVersion: pol.data && pol.data[0] ? pol.data[0].rule_version : null,
        total: total.count || 0, enter: enterC.count || 0, block: blockC.count || 0, resolved: resolvedC.count || 0,
        enterSum: sum(er), enterMean: er.length ? sum(er) / er.length : 0, enterN: er.length,
        blockSum: sum(br), blockMean: br.length ? sum(br) / br.length : 0, blockN: br.length,
        trailingN: er.filter((r) => r.sim_exit_reason === "trailing_stop").length,
        latest: latest.data && latest.data[0] ? latest.data[0].decision_time : null,
        walkForward,
        exitReasons,
      });
    } catch { /* shadow tables not readable by anon yet (RLS) → panel shows access-pending */ }

    // Fetch live prices and whale sells for open positions
    const opens = openRes.data || [];
    if (opens.length > 0) {
      const uniqueMints = [...new Set(opens.map((t) => t.coin_address))];
      const priceMap: Record<string, number> = {};
      await Promise.all(
        uniqueMints.map(async (mint) => {
          try {
            const res = await fetch(
              `https://api.dexscreener.com/latest/dex/tokens/${mint}`
            );
            if (res.ok) {
              const data = await res.json();
              const p = data.pairs?.[0]?.priceUsd;
              if (p) {
                const price = parseFloat(p);
                if (price > 0) priceMap[mint] = price;
              }
            }
          } catch {}
        })
      );
      setLivePrices(priceMap);

      const sellMap: Record<
        string,
        Array<{ wallet_tag: string; signal_time: string }>
      > = {};
      await Promise.all(
        opens.map(async (t) => {
          const { data: sells } = await supabase
            .from("coin_signals")
            .select("wallet_tag, signal_time")
            .eq("coin_address", t.coin_address)
            .eq("transaction_type", "SELL")
            .gte("signal_time", t.entry_time)
            .order("signal_time", { ascending: false })
            .limit(5);
          if (sells && sells.length > 0) {
            sellMap[t.coin_address] = sells;
          }
        })
      );
      setWhaleSells(sellMap);
    }

    // Always live — fetch wallet balance
    try {
      const balRes = await fetch("/api/phantom-balance", { cache: "no-store" });
      if (balRes.ok) {
        const bal = await balRes.json();
        setPhantomBalance(bal);
      }
    } catch {}

    setLastFetch(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  async function toggleBot() {
    if (!botState) return;
    setToggling(true);
    const newState = !botState.is_running;
    await supabase
      .from("bot_state")
      .update({ is_running: newState, last_updated: new Date().toISOString() })
      .eq("id", botState.id);
    setBotState({ ...botState, is_running: newState });
    setToggling(false);
  }

  // ─── Stats — 100% real (real_pnl_sol / entry_sol_cost) ──
  const statsWithPct = allClosedStats
    .map((t: any) => {
      const realPnl = t.real_pnl_sol !== null && t.real_pnl_sol !== undefined ? Number(t.real_pnl_sol) : null;
      const entryCost = t.entry_sol_cost !== null && t.entry_sol_cost !== undefined ? Number(t.entry_sol_cost) : null;
      if (realPnl === null) return null;
      const pct = entryCost && entryCost > 0 ? (realPnl / entryCost) * 100 : null;
      return { ...t, _pnlSol: realPnl, _pct: pct };
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);

  const totalClosed = statsWithPct.length;
  const wins = statsWithPct.filter((t) => t._pnlSol > 0);
  const losses = statsWithPct.filter((t) => t._pnlSol <= 0);
  const winRate = totalClosed > 0 ? ((wins.length / totalClosed) * 100).toFixed(1) : "0";

  const winsWithPct = wins.filter((t) => t._pct !== null);
  const lossesWithPct = losses.filter((t) => t._pct !== null);
  const avgGain =
    winsWithPct.length > 0
      ? (winsWithPct.reduce((s, t) => s + (t._pct as number), 0) / winsWithPct.length).toFixed(2)
      : "0";
  const avgLoss =
    lossesWithPct.length > 0
      ? (lossesWithPct.reduce((s, t) => s + (t._pct as number), 0) / lossesWithPct.length).toFixed(2)
      : "0";

  const realPnlSol = statsWithPct.reduce((s, t) => s + t._pnlSol, 0);
  // Total capital deployed across all closed trades with known entry cost.
  // Used for Trade ROI so the % is stable across wallet deposits/withdrawals.
  const totalDeployedSol = statsWithPct.reduce(
    (s: number, t: any) =>
      s + (t.entry_sol_cost !== null && t.entry_sol_cost !== undefined
        ? Number(t.entry_sol_cost)
        : 0),
    0
  );
  const tradeROI = totalDeployedSol > 0 ? (realPnlSol / totalDeployedSol) * 100 : 0;
  const executionMode = botState?.mode || "stopped";
  const broadcastEnabled = botState?.broadcast_tx === true;
  const liveActive = executionMode === "live" && botState?.is_running === true && broadcastEnabled;
  const measureActive = executionMode === "measure_live" && botState?.is_running === true && broadcastEnabled;
  const dryRunActive = executionMode === "dry_run" && botState?.is_running === true;
  const isStopped = !botState?.is_running || executionMode === "stopped";
  const statusLabel = !botState?.is_running || executionMode === "stopped"
    ? "STOPPED"
    : dryRunActive
      ? "DRY RUN"
      : measureActive
        ? "MEASURE LIVE"
        : liveActive
          ? "LIVE"
          : "CONFLICT";
  const statusColor = statusLabel === "LIVE"
    ? "text-red-400"
    : statusLabel === "MEASURE LIVE"
      ? "text-amber-400"
      : statusLabel === "DRY RUN"
        ? "text-blue-400"
        : statusLabel === "CONFLICT"
          ? "text-orange-400"
          : "text-zinc-400";
  const profitReadiness = realPnlSol > 0 && Number(winRate) >= 50 ? "EVIDENCE POSITIVE" : "NEGATIVE EV";
  const restartGate = liveActive
    ? "LIVE ACTIVE"
    : measureActive
      ? "MEASURE LIVE"
      : broadcastEnabled
        ? "BROADCAST ON"
        : "LIVE LOCKED";
  const nextMilestone = realPnlSol < 0
    ? "Improve entry quality before restart"
    : "Validate edge before size-up";
  const startButtonLabel = toggling
    ? "..."
    : botState?.is_running
      ? "STOP BOT"
      : executionMode === "dry_run"
        ? "START DRY RUN"
        : executionMode === "measure_live"
          ? "START MEASURE"
          : executionMode === "live"
            ? "START LIVE"
            : "START BOT";

  // TR-v1 edge status (mirrors shadow-report pre-registered gate)
  const edgeStatus = !shadow || shadow.total === 0
    ? "INSUFFICIENT DATA"
    : shadow.enterN >= 50 && shadow.enterSum > 0 && shadow.enterMean > shadow.blockMean && shadow.trailingN > 0
      ? "POSITIVE EDGE CANDIDATE"
      : shadow.enterN < 50
        ? "INSUFFICIENT DATA"
        : "NOT PROVEN";
  const edgeColor = edgeStatus === "POSITIVE EDGE CANDIDATE" ? "text-green-400" : edgeStatus === "NOT PROVEN" ? "text-red-400" : "text-zinc-400";
  const harnessStatus = shadow?.latest && (Date.now() - new Date(shadow.latest).getTime() < 30 * 60_000) ? "RUNNING" : "UNKNOWN";
  const shadowAccessPending = !shadow || shadow.total === 0;
  const shadowTotal = shadow?.total ?? 0;
  const shadowEnter = shadow?.enter ?? 0;
  const shadowBlock = shadow?.block ?? 0;
  const shadowResolved = shadow?.resolved ?? 0;
  const shadowEnterN = shadow?.enterN ?? 0;
  const shadowBlockN = shadow?.blockN ?? 0;
  const shadowEnterMean = shadow?.enterMean ?? 0;
  const shadowBlockMean = shadow?.blockMean ?? 0;
  const shadowEnterSum = shadow?.enterSum ?? 0;
  const shadowBlockSum = shadow?.blockSum ?? 0;
  const shadowTrailingN = shadow?.trailingN ?? 0;
  const unresolvedShadow = Math.max(0, shadowTotal - shadowResolved);
  const enterPct = shadowTotal > 0 ? (shadowEnter / shadowTotal) * 100 : 0;
  const blockPct = shadowTotal > 0 ? (shadowBlock / shadowTotal) * 100 : 0;
  const resolvedPct = shadowTotal > 0 ? (shadowResolved / shadowTotal) * 100 : 0;
  const unresolvedPct = shadowTotal > 0 ? (unresolvedShadow / shadowTotal) * 100 : 0;
  const latestDecision = shadow?.latest ? new Date(shadow.latest).toLocaleString() : "—";
  const measureLiveStatus = measureActive ? "ACTIVE" : "OFF";
  const startMuted = !botState?.is_running && edgeStatus !== "POSITIVE EDGE CANDIDATE";
  const walkForwardBuckets = shadow?.walkForward ?? [];
  const exitReasonBuckets = shadow?.exitReasons ?? [];
  const formatShadowMean = (value: number | null) => value === null ? "—" : `${value.toFixed(2)}%`;
  const shadowMeanTone = (value: number | null) =>
    value === null ? "text-zinc-500" : value >= 0 ? "text-emerald-300" : "text-red-300";

  if (loading) {
    return <div className="text-zinc-500 text-center mt-20">Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-amber-400">PixiuBot</h1>
            <p className="mt-1 text-sm text-zinc-500">
              Real PnL dashboard. Dry-run rows are excluded from trade PnL.
            </p>
          </div>
          <span className={`rounded-full border px-3 py-1 text-xs font-mono font-bold ${
            statusLabel === "LIVE"
              ? "border-red-500/70 bg-red-950/60 text-red-300"
              : statusLabel === "MEASURE LIVE"
                ? "border-amber-500/60 bg-amber-950/50 text-amber-300"
                : statusLabel === "DRY RUN"
                  ? "border-sky-500/60 bg-sky-950/50 text-sky-300"
                  : statusLabel === "CONFLICT"
                    ? "border-orange-500/70 bg-orange-950/60 text-orange-300"
                    : "border-zinc-700 bg-zinc-900 text-zinc-300"
          }`}>
            {statusLabel}
          </span>
        </div>

        <div className="rounded-lg border border-amber-600/60 bg-amber-950/30 p-4 text-sm text-amber-100">
          <span className="font-semibold">Old strategy is negative EV.</span>{" "}
          Shadow validation is testing TR-v1. No real SOL is being used.
        </div>

        {/* Current experiment */}
        <section className="rounded-lg border border-sky-700/70 bg-sky-950/20 p-5">
          <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-sky-200">
                Current Experiment — TR-v1 Shadow Validation
              </h2>
              <p className="mt-1 text-sm text-zinc-400">
                Pre-registered token-risk rule. Shadow-only, non-enforcing, no SOL.
              </p>
            </div>
            <span className={`rounded-full border px-3 py-1 text-xs font-mono font-bold ${
              edgeStatus === "POSITIVE EDGE CANDIDATE"
                ? "border-green-500/70 bg-green-950/50 text-green-300"
                : edgeStatus === "NOT PROVEN"
                  ? "border-red-500/70 bg-red-950/50 text-red-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-300"
            }`}>
              {edgeStatus}
            </span>
          </div>

          {shadowAccessPending && (
            <div className="mb-4 rounded-md border border-zinc-700 bg-zinc-950/80 p-3 text-sm text-zinc-300">
              Access pending (RLS) — harness running via service-role. Dashboard anon reads may show zero rows until the operator applies read policies.
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Metric label="TR-v1 Policy" value={shadow?.policyActive ? shadow.ruleVersion || "ACTIVE" : "MISSING / PENDING"} tone={shadow?.policyActive ? "info" : "muted"} />
            <Metric label="Harness" value={shadowAccessPending ? "RUNNING VIA SERVICE" : harnessStatus} tone={harnessStatus === "RUNNING" || shadowAccessPending ? "info" : "muted"} />
            <Metric label="Total Decisions" value={shadowAccessPending ? "ACCESS PENDING" : String(shadowTotal)} tone={shadowAccessPending ? "muted" : "neutral"} />
            <Metric label="Latest Decision" value={shadowAccessPending ? "ACCESS PENDING" : latestDecision} tone="muted" />
          </div>

          <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
            <Metric label="Would Enter" value={shadowAccessPending ? "—" : `${shadowEnter} (${enterPct.toFixed(1)}%)`} tone="safe" />
            <Metric label="Would Block" value={shadowAccessPending ? "—" : `${shadowBlock} (${blockPct.toFixed(1)}%)`} tone="danger" />
            <Metric label="Resolved" value={shadowAccessPending ? "—" : `${shadowResolved} (${resolvedPct.toFixed(1)}%)`} tone="neutral" />
            <Metric label="Unresolved" value={shadowAccessPending ? "—" : `${unresolvedShadow} (${unresolvedPct.toFixed(1)}%)`} tone="muted" />
          </div>

          <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
            <Metric
              label="Enter Sim PnL"
              value={shadowAccessPending || shadowEnterN === 0 ? "—" : `${shadowEnterSum.toFixed(2)}% total / ${shadowEnterMean.toFixed(2)}% mean`}
              tone={!shadowAccessPending && shadowEnterMean > 0 ? "safe" : !shadowAccessPending && shadowEnterN > 0 ? "danger" : "muted"}
            />
            <Metric
              label="Block Sim PnL"
              value={shadowAccessPending || shadowBlockN === 0 ? "—" : `${shadowBlockSum.toFixed(2)}% total / ${shadowBlockMean.toFixed(2)}% mean`}
              tone={!shadowAccessPending && shadowBlockMean > 0 ? "safe" : !shadowAccessPending && shadowBlockN > 0 ? "danger" : "muted"}
            />
            <Metric label="Trailing Preserved" value={shadowAccessPending ? "—" : String(shadowTrailingN)} tone={shadowTrailingN > 0 ? "safe" : "muted"} />
            <Metric label="Edge Status" value={edgeStatus} tone={edgeStatus === "POSITIVE EDGE CANDIDATE" ? "safe" : edgeStatus === "NOT PROVEN" ? "danger" : "muted"} />
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div className="rounded-md border border-zinc-800 bg-zinc-950/70 p-4">
              <div className="mb-3">
                <h3 className="text-sm font-semibold text-zinc-200">
                  Walk-forward Stability
                </h3>
                <p className="mt-1 text-xs text-zinc-500">
                  Resolved decisions split by decision time into two equal windows.
                </p>
              </div>
              {shadowAccessPending ? (
                <div className="rounded-md border border-zinc-800 bg-zinc-900/70 p-3 text-sm text-zinc-500">
                  Access pending (RLS) — no anon-visible resolved rows yet.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm font-mono">
                    <thead>
                      <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                        <th className="py-2 pr-3 text-left">Window</th>
                        <th className="px-3 py-2 text-right">Enter Count</th>
                        <th className="px-3 py-2 text-right">Enter Mean</th>
                        <th className="px-3 py-2 text-right">Block Count</th>
                        <th className="py-2 pl-3 text-right">Block Mean</th>
                      </tr>
                    </thead>
                    <tbody>
                      {walkForwardBuckets.map((bucket) => (
                        <tr key={bucket.label} className="border-b border-zinc-900 last:border-0">
                          <td className="py-2 pr-3 text-zinc-300">{bucket.label}</td>
                          <td className="px-3 py-2 text-right text-zinc-300">{bucket.enterCount}</td>
                          <td className={`px-3 py-2 text-right font-bold ${shadowMeanTone(bucket.enterMean)}`}>
                            {formatShadowMean(bucket.enterMean)}
                          </td>
                          <td className="px-3 py-2 text-right text-zinc-300">{bucket.blockCount}</td>
                          <td className={`py-2 pl-3 text-right font-bold ${shadowMeanTone(bucket.blockMean)}`}>
                            {formatShadowMean(bucket.blockMean)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="rounded-md border border-zinc-800 bg-zinc-950/70 p-4">
              <div className="mb-3">
                <h3 className="text-sm font-semibold text-zinc-200">
                  Exit Reason Breakdown
                </h3>
                <p className="mt-1 text-xs text-zinc-500">
                  Resolved shadow outcomes grouped by simulated exit reason.
                </p>
              </div>
              {shadowAccessPending ? (
                <div className="rounded-md border border-zinc-800 bg-zinc-900/70 p-3 text-sm text-zinc-500">
                  Access pending (RLS) — no anon-visible resolved rows yet.
                </div>
              ) : exitReasonBuckets.length === 0 ? (
                <div className="rounded-md border border-zinc-800 bg-zinc-900/70 p-3 text-sm text-zinc-500">
                  No resolved shadow exit reasons available.
                </div>
              ) : (
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-sm font-mono">
                    <thead>
                      <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                        <th className="py-2 pr-3 text-left">Reason</th>
                        <th className="px-3 py-2 text-right">Count</th>
                        <th className="py-2 pl-3 text-right">Mean PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {exitReasonBuckets.map((bucket) => (
                        <tr key={bucket.reason} className="border-b border-zinc-900 last:border-0">
                          <td className="py-2 pr-3 text-zinc-300">{bucket.reason}</td>
                          <td className="px-3 py-2 text-right text-zinc-300">{bucket.count}</td>
                          <td className={`py-2 pl-3 text-right font-bold ${shadowMeanTone(bucket.mean)}`}>
                            {formatShadowMean(bucket.mean)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Safety state */}
        <section className={`rounded-lg border p-4 ${
          liveActive
            ? "border-red-500 bg-red-950/40"
            : measureActive
              ? "border-amber-500/70 bg-amber-950/30"
              : "border-zinc-800 bg-zinc-900/70"
        }`}>
          <div className="grid gap-4 md:grid-cols-6">
            <TruthItem label="Trading State" value={statusLabel} tone={statusLabel === "LIVE" ? "danger" : statusLabel === "DRY RUN" ? "info" : "muted"} />
            <TruthItem label="Mode" value={executionMode} tone={executionMode === "live" ? "danger" : executionMode === "dry_run" ? "info" : "muted"} />
            <TruthItem label="Broadcast Gate" value={broadcastEnabled ? "ON" : "OFF"} tone={broadcastEnabled ? "danger" : "safe"} />
            <TruthItem label="Open Positions" value={String(openTrades.length)} tone={openTrades.length > 0 ? "danger" : "safe"} />
            <TruthItem label="Measure Live" value={measureLiveStatus} tone={measureActive ? "danger" : "safe"} />
            <TruthItem label="Restart Gate" value={restartGate} tone={restartGate === "LIVE LOCKED" ? "safe" : "danger"} />
          </div>
          <div className="mt-4 border-t border-zinc-800 pt-3 text-sm text-zinc-400">
            <span className="font-semibold text-zinc-200">Profit readiness:</span>{" "}
            <span className={profitReadiness === "NEGATIVE EV" ? "text-red-300" : "text-emerald-300"}>{profitReadiness}</span>
            <span className="mx-2 text-zinc-700">|</span>
            <span className="font-semibold text-zinc-200">Next:</span>{" "}
            {nextMilestone}
          </div>
        </section>

        {/* Wallet Balance — live, no baseline. Deposits/withdrawals are
            invisible to trade accounting below. */}
        {phantomBalance && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className={`${statusColor} font-bold text-sm font-mono uppercase`}>
                  {statusLabel}
                </span>
                <span className="text-zinc-500 text-xs ml-2">{LIVE_BUY_SOL} SOL/trade configured</span>
              </div>
              <div className="text-right">
                <span className="text-white font-bold font-mono text-lg">
                  {phantomBalance.sol.toFixed(4)} SOL
                </span>
                <span className="text-zinc-400 text-sm ml-2">
                  (${phantomBalance.usd.toFixed(2)})
                </span>
              </div>
            </div>
            {totalClosed > 0 && (
              <div className="flex items-center justify-between text-xs font-mono pt-3 mt-3 border-t border-zinc-800">
                <span className="text-zinc-400">
                  Trade PnL across {totalClosed} trades
                </span>
                <span className={realPnlSol >= 0 ? "text-green-400" : "text-red-400"}>
                  {realPnlSol >= 0 ? "+" : ""}{realPnlSol.toFixed(4)} SOL
                  {phantomBalance.solPrice ? ` (${realPnlSol >= 0 ? "+" : ""}$${(realPnlSol * phantomBalance.solPrice).toFixed(2)})` : ""}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Top-line metrics — all derived from on-chain data; no baseline.
            Wallet = live RPC balance.
            Trade PnL = Σ real_pnl_sol on closed trades (deposit-safe).
            Trade ROI = Trade PnL / Σ entry_sol_cost (return on capital deployed). */}
        {phantomBalance && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card
              label="Wallet"
              value={`${phantomBalance.sol.toFixed(4)} SOL`}
            />
            <Card
              label="Wallet USD"
              value={`$${phantomBalance.usd.toFixed(2)}`}
            />
            <Card
              label={`Trade PnL${totalClosed > 0 ? ` (${totalClosed})` : ""}`}
              value={totalClosed > 0
                ? `${realPnlSol >= 0 ? "+" : ""}${realPnlSol.toFixed(4)} SOL`
                : "—"}
              color={totalClosed > 0 ? (realPnlSol >= 0 ? "text-green-400" : "text-red-400") : undefined}
            />
            <Card
              label="Trade ROI"
              value={totalDeployedSol > 0
                ? `${tradeROI >= 0 ? "+" : ""}${tradeROI.toFixed(2)}%`
                : "—"}
              color={totalDeployedSol > 0 ? (tradeROI >= 0 ? "text-green-400" : "text-red-400") : undefined}
            />
          </div>
        )}

        {/* Status Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <Card
            label="Status"
            value={statusLabel}
            color={statusColor}
          />
          <Card label="Mode" value={executionMode} color={statusColor} />
          <Card label="Broadcast Gate" value={broadcastEnabled ? "ON" : "OFF"} color={broadcastEnabled ? "text-red-400" : "text-emerald-400"} />
          <Card label="Tracked Wallets" value={String(walletCount)} />
          <Card label="Signals" value={String(signals.length)} />
        </div>

        {/* Start/Stop */}
        <div className="flex flex-wrap items-center gap-4">
          <button
            onClick={toggleBot}
            disabled={toggling}
            className={`px-6 py-2 rounded-lg font-mono font-bold text-sm transition-colors ${
              botState?.is_running
                ? "bg-red-600 hover:bg-red-700 text-white"
                : startMuted
                  ? "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                  : isStopped && executionMode === "dry_run"
                    ? "bg-sky-600 hover:bg-sky-700 text-white"
                    : "bg-zinc-700 hover:bg-zinc-600 text-white"
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {startButtonLabel}
          </button>
          {!botState?.is_running && edgeStatus !== "POSITIVE EDGE CANDIDATE" && (
            <span className="text-xs text-zinc-500">
              dry-run only - edge not proven
            </span>
          )}
          {lastFetch && (
            <span className="text-zinc-600 text-xs">
              Last fetched: {lastFetch.toLocaleTimeString()}
            </span>
          )}
        </div>

        {/* ─── Historical Old Strategy Performance ─────────── */}
        <section>
          <h2 className="text-lg font-semibold text-zinc-300 mb-3">
            Historical Old Strategy Performance
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card label="Closed Trades" value={String(totalClosed)} />
            <Card
              label="Win Rate"
              value={`${winRate}%`}
              color={Number(winRate) >= 55 ? "text-green-400" : "text-red-400"}
            />
            <Card label="Wins" value={String(wins.length)} color="text-green-400" />
            <Card label="Losses" value={String(losses.length)} color="text-red-400" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4">
            <Card
              label="Avg Win"
              value={`+${avgGain}%`}
              color="text-green-400"
            />
            <Card
              label="Avg Loss"
              value={`${avgLoss}%`}
              color="text-red-400"
            />
            <Card label="Open Positions" value={String(openTrades.length)} />
          </div>
        </section>

        {/* ─── Open Positions (Live Tracker) ──────────────── */}
        {openTrades.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold text-zinc-300 mb-3">
              Open Positions
              <span className="ml-2 text-xs text-zinc-600 font-normal">
                live every 10s
              </span>
            </h2>
            <div className="space-y-3">
              {openTrades.map((t) => {
                const entryPrice = Number(t.entry_price);
                const currentPrice = livePrices[t.coin_address] || 0;
                const markPct =
                  entryPrice > 0 && currentPrice > 0
                    ? ((currentPrice - entryPrice) / entryPrice) * 100
                    : null;
                const entryTime = new Date(t.entry_time).getTime();
                const minutesOpen = (Date.now() - entryTime) / 60_000;
                const timeoutMin = 10; // matches risk-guard TIMEOUT_MINUTES
                const timeRemaining = Math.max(0, timeoutMin - minutesOpen);
                const isTrailing = (t.grid_level ?? 0) === 3 && (t.remaining_pct ?? 100) > 0;
                const sells = whaleSells[t.coin_address] || [];
                const coinLabel =
                  t.coin_name || t.coin_address.slice(0, 8) + "...";

                return (
                  <div
                    key={t.id}
                    className="bg-zinc-900 border border-zinc-800 rounded-lg p-4"
                  >
                    {/* Row 1: Coin name, mark, timeout */}
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <span className="text-amber-500 font-bold font-mono text-base">
                          {coinLabel}
                        </span>
                        <span className="text-xs text-zinc-500">
                          {t.wallet_tag}
                        </span>
                        {t.priority === "HIGH" && (
                          <span className="text-xs bg-amber-900/50 text-amber-400 px-1.5 py-0.5 rounded">
                            HIGH
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-4">
                        {/* Mark-to-market % (not an outcome — just live quote vs entry) */}
                        {markPct !== null ? (
                          <span
                            className={`text-lg font-bold font-mono ${
                              markPct >= 0 ? "text-green-500" : "text-red-500"
                            }`}
                          >
                            {markPct >= 0 ? "+" : ""}
                            {markPct.toFixed(2)}%
                          </span>
                        ) : (
                          <span className="text-lg font-mono text-zinc-600">
                            —
                          </span>
                        )}
                        <span
                          className={`text-xs font-mono px-2 py-1 rounded ${
                            isTrailing
                              ? "bg-purple-900/50 text-purple-400"
                              : timeRemaining <= 5
                                ? "bg-red-900/50 text-red-400"
                                : timeRemaining <= 10
                                  ? "bg-amber-900/50 text-amber-400"
                                  : "bg-zinc-800 text-zinc-400"
                          }`}
                        >
                          {isTrailing
                            ? "TRAILING"
                            : timeRemaining <= 0
                              ? "TIMEOUT"
                              : `${timeRemaining.toFixed(0)}m left`}
                        </span>
                      </div>
                    </div>

                    {/* Row 2: Prices */}
                    <div className="flex items-center gap-6 mb-3 text-xs font-mono">
                      <span className="text-zinc-500">
                        Entry: ${entryPrice.toFixed(10)}
                      </span>
                      {currentPrice > 0 && (
                        <span className="text-zinc-400">
                          Now: ${currentPrice.toFixed(10)}
                        </span>
                      )}
                      {t.entry_sol_cost && Number(t.entry_sol_cost) > 0 && (
                        <span className="text-zinc-500">
                          Cost: {Number(t.entry_sol_cost).toFixed(4)} SOL
                        </span>
                      )}
                      <span className="text-zinc-600">
                        {t.remaining_pct}% remaining
                      </span>
                    </div>

                    {/* Row 3: Grid Progress Bar */}
                    <div className="mb-3">
                      <div className="flex items-center gap-1 mb-1">
                        {[0, 1, 2, 3].map((level) => (
                          <div key={level} className="flex items-center">
                            <div
                              className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border-2 ${
                                t.grid_level >= level
                                  ? level === 3
                                    ? "bg-green-500 border-green-400 text-white"
                                    : level > 0
                                      ? "bg-amber-500 border-amber-400 text-white"
                                      : "bg-zinc-600 border-zinc-500 text-white"
                                  : "bg-zinc-900 border-zinc-700 text-zinc-600"
                              }`}
                            >
                              {level === 0
                                ? "E"
                                : level}
                            </div>
                            {level < 3 && (
                              <div
                                className={`w-8 h-0.5 ${
                                  t.grid_level > level
                                    ? "bg-amber-500"
                                    : "bg-zinc-800"
                                }`}
                              />
                            )}
                          </div>
                        ))}
                        <span className="ml-2 text-xs text-zinc-500">
                          {t.grid_level >= 3
                            ? "Trailing"
                            : t.grid_level === 2
                              ? "+40% (25% left)"
                              : t.grid_level === 1
                                ? "+15% (50% left)"
                                : "Watching"}
                        </span>
                      </div>
                    </div>

                    {/* Row 4: Whale Status */}
                    <div className="text-xs font-mono">
                      {sells.length === 0 ? (
                        <span className="text-zinc-500">
                          No whale exit yet
                        </span>
                      ) : (
                        <div className="space-y-0.5">
                          {sells.map((s, i) => (
                            <div key={i} className="text-amber-400">
                              {s.wallet_tag} sold at{" "}
                              {new Date(s.signal_time).toLocaleTimeString()}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ─── Closed Trades ──────────────────────────────── */}
        {closedTrades.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold text-zinc-300 mb-3">
              Closed Trades
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm font-mono">
                <thead>
                  <tr className="text-zinc-500 border-b border-zinc-800">
                    <th className="text-left py-2 px-3">Coin</th>
                    <th className="text-right py-2 px-3">Entry</th>
                    <th className="text-right py-2 px-3">Exit</th>
                    <th className="text-right py-2 px-3">Real SOL</th>
                    <th className="text-right py-2 px-3">Real %</th>
                    <th className="text-center py-2 px-3">Grid</th>
                    <th className="text-left py-2 px-3">Reason</th>
                    <th className="text-left py-2 px-3">Closed</th>
                  </tr>
                </thead>
                <tbody>
                  {closedTrades.map((t) => {
                    const realPnl = t.real_pnl_sol !== null && t.real_pnl_sol !== undefined ? Number(t.real_pnl_sol) : null;
                    const entryCost = t.entry_sol_cost !== null && t.entry_sol_cost !== undefined ? Number(t.entry_sol_cost) : null;
                    const realPct = realPnl !== null && entryCost && entryCost > 0 ? (realPnl / entryCost) * 100 : null;
                    return (
                      <tr
                        key={t.id}
                        className="border-b border-zinc-900 hover:bg-zinc-900/50"
                      >
                        <td className="py-2 px-3 text-amber-500 font-bold">
                          {t.coin_name || t.coin_address.slice(0, 8) + "..."}
                        </td>
                        <td className="py-2 px-3 text-right">
                          ${Number(t.entry_price).toFixed(10)}
                        </td>
                        <td className="py-2 px-3 text-right">
                          {t.exit_price
                            ? `$${Number(t.exit_price).toFixed(10)}`
                            : "-"}
                        </td>
                        <td className="py-2 px-3 text-right font-mono">
                          {realPnl !== null ? (
                            <span className={realPnl >= 0 ? "text-green-400" : "text-red-400"}>
                              {realPnl >= 0 ? "+" : ""}
                              {realPnl.toFixed(4)}
                            </span>
                          ) : (
                            <span className="text-zinc-700">—</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-xs">
                          {realPct !== null ? (
                            <span className={realPct >= 0 ? "text-green-400" : "text-red-400"}>
                              {realPct >= 0 ? "+" : ""}
                              {realPct.toFixed(2)}%
                            </span>
                          ) : (
                            <span className="text-zinc-700">—</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-center">
                          <span className={t.grid_level >= 3 ? "text-green-400" : t.grid_level > 0 ? "text-amber-400" : "text-zinc-600"}>
                            L{t.grid_level}
                          </span>
                        </td>
                        <td className="py-2 px-3">
                          <span
                            className={
                              t.exit_reason === "take_profit"
                                ? "text-green-500"
                                : t.exit_reason === "stop_loss" ||
                                    t.exit_reason === "unsellable_6024" ||
                                    t.exit_reason === "holder_rug"
                                  ? "text-red-500"
                                  : t.exit_reason === "pool_drain"
                                    ? "text-amber-500"
                                    : "text-zinc-500"
                            }
                          >
                            {t.exit_reason === "take_profit"
                              ? "TP"
                              : t.exit_reason === "stop_loss"
                                ? "SL"
                                : t.exit_reason === "timeout"
                                  ? "TO"
                                  : t.exit_reason === "trailing_stop"
                                    ? "TR"
                                    : t.exit_reason === "whale_exit"
                                      ? "WE"
                                      : t.exit_reason === "circuit_breaker"
                                        ? "CB"
                                        : t.exit_reason === "pool_drain"
                                          ? "PD"
                                          : t.exit_reason === "holder_rug"
                                            ? "HR"
                                            : t.exit_reason === "unsellable_6024"
                                              ? "XS"
                                              : "-"}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-zinc-600">
                          {t.exit_time
                            ? new Date(t.exit_time).toLocaleTimeString()
                            : "-"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* ─── Live Signal Feed ───────────────────────────── */}
        <section>
          <h2 className="text-lg font-semibold text-zinc-300 mb-3">
            Live Signal Feed
          </h2>
          {signals.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm font-mono">
                <thead>
                  <tr className="text-zinc-500 border-b border-zinc-800">
                    <th className="text-left py-2 px-3">Coin</th>
                    <th className="text-left py-2 px-3">Address</th>
                    <th className="text-left py-2 px-3">Wallet</th>
                    <th className="text-right py-2 px-3">Entry MC</th>
                    <th className="text-center py-2 px-3">Rug Check</th>
                    <th className="text-right py-2 px-3">Gap</th>
                    <th className="text-left py-2 px-3">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.map((s) => (
                    <tr
                      key={s.id}
                      className="border-b border-zinc-900 hover:bg-zinc-900/50"
                    >
                      <td className={`py-2 px-3 font-bold ${s.transaction_type === "SELL" ? "text-red-400" : "text-amber-500"}`}>
                        {s.transaction_type === "SELL" && "🐳 "}
                        {s.coin_name || "???"}
                        {s.transaction_type === "SELL" && (
                          <span className="ml-2 text-xs bg-red-900 text-red-400 px-1.5 py-0.5 rounded font-mono">
                            SELL
                          </span>
                        )}
                        {s.bundle_suspected && s.transaction_type !== "SELL" && (
                          <span className="ml-2 text-xs bg-red-900 text-red-400 px-1.5 py-0.5 rounded font-mono">
                            BUNDLE
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-zinc-500">
                        <a
                          href={`https://solscan.io/token/${s.coin_address}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-amber-400 transition-colors"
                        >
                          {s.coin_address.slice(0, 6)}...
                          {s.coin_address.slice(-4)}
                        </a>
                      </td>
                      <td className="py-2 px-3 text-zinc-400">
                        {s.wallet_tag}
                      </td>
                      <td className="py-2 px-3 text-right">
                        {s.entry_mc
                          ? `$${Number(s.entry_mc).toLocaleString()}`
                          : "-"}
                      </td>
                      <td className="py-2 px-3 text-center">
                        <span
                          className={
                            s.rug_check_passed === null
                              ? "text-zinc-600"
                              : s.rug_check_passed
                                ? "text-green-500"
                                : "text-red-500"
                          }
                        >
                          {s.rug_check_passed === null
                            ? "-"
                            : s.rug_check_passed
                              ? "PASS"
                              : "FAIL"}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right text-zinc-400">
                        {s.price_gap_minutes !== null
                          ? `${s.price_gap_minutes}m`
                          : "-"}
                      </td>
                      <td className="py-2 px-3 text-zinc-600">
                        {new Date(s.signal_time).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-zinc-600 text-sm bg-zinc-900 border border-zinc-800 rounded-lg p-6 text-center">
              No signals yet.
            </div>
          )}
        </section>

        <div className="text-zinc-700 text-xs text-center">
          Auto-refreshes every 10 seconds
        </div>
      </div>
    </div>
  );
}

function Card({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 shadow-sm shadow-black/20">
      <div className="text-zinc-500 text-xs uppercase tracking-wide mb-2">
        {label}
      </div>
      <div className={`text-lg font-mono font-bold ${color || "text-white"}`}>
        {value}
      </div>
    </div>
  );
}

function TruthItem({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "safe" | "danger" | "info" | "muted";
}) {
  const toneClass =
    tone === "safe"
      ? "text-emerald-300"
      : tone === "danger"
        ? "text-red-300"
        : tone === "info"
          ? "text-sky-300"
          : "text-zinc-300";

  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className={`mt-1 font-mono text-base font-bold ${toneClass}`}>
        {value}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "safe" | "danger" | "info" | "neutral" | "muted";
}) {
  const toneClass =
    tone === "safe"
      ? "text-emerald-300"
      : tone === "danger"
        ? "text-red-300"
        : tone === "info"
          ? "text-sky-300"
          : tone === "neutral"
            ? "text-zinc-100"
            : "text-zinc-500";

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className={`mt-1 break-words font-mono text-sm font-bold ${toneClass}`}>
        {value}
      </div>
    </div>
  );
}
