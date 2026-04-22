"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { LIVE_BUY_SOL } from "@/config/smart-money";

interface BotState {
  id: string;
  is_running: boolean;
  mode: string;
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
}

export default function BotPage() {
  const [botState, setBotState] = useState<BotState | null>(null);
  const [signals, setSignals] = useState<CoinSignal[]>([]);
  const [openTrades, setOpenTrades] = useState<Trade[]>([]);
  const [closedTrades, setClosedTrades] = useState<Trade[]>([]);
  const [walletCount, setWalletCount] = useState(0);
  const [allClosedStats, setAllClosedStats] = useState<
    Array<{ real_pnl_sol: number | null; entry_sol_cost: number | null; exit_reason: string | null; wallet_tag?: string }>
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
          .like("wallet_tag", "%[LIVE]%")
          .order("entry_time", { ascending: false }),
        supabase
          .from("trades")
          .select("*")
          .eq("status", "closed")
          .like("wallet_tag", "%[LIVE]%")
          .order("exit_time", { ascending: false })
          .limit(50),
        supabase
          .from("trades")
          .select("real_pnl_sol, entry_sol_cost, exit_reason, wallet_tag")
          .eq("status", "closed")
          .like("wallet_tag", "%[LIVE]%"),
      ]);

    if (stateRes.data && stateRes.data.length > 0) {
      setBotState(stateRes.data[0]);
    }
    setSignals(signalsRes.data || []);
    setWalletCount(walletsRes.count || 0);
    setOpenTrades(openRes.data || []);
    setClosedTrades(closedRes.data || []);
    setAllClosedStats(allClosedRes.data || []);

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

  if (loading) {
    return <div className="text-zinc-500 text-center mt-20">Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-amber-500">PixiuBot</h1>
          <span className="text-xs text-zinc-600">Live Trading</span>
        </div>

        {/* Wallet Balance — live, no baseline. Deposits/withdrawals are
            invisible to trade accounting below. */}
        {phantomBalance && (
          <div className="bg-red-900/30 border border-red-600 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="text-red-400 font-bold text-sm font-mono">LIVE TRADING ACTIVE</span>
                <span className="text-zinc-500 text-xs ml-2">{LIVE_BUY_SOL} SOL/trade</span>
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
              <div className="flex items-center justify-between text-xs font-mono pt-1 border-t border-zinc-800">
                <span className="text-zinc-500">
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
              color={totalClosed > 0 ? (realPnlSol >= 0 ? "text-green-500" : "text-red-500") : undefined}
            />
            <Card
              label="Trade ROI"
              value={totalDeployedSol > 0
                ? `${tradeROI >= 0 ? "+" : ""}${tradeROI.toFixed(2)}%`
                : "—"}
              color={totalDeployedSol > 0 ? (tradeROI >= 0 ? "text-green-500" : "text-red-500") : undefined}
            />
          </div>
        )}

        {/* Status Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <Card
            label="Status"
            value={botState?.is_running ? "RUNNING" : "STOPPED"}
            color={botState?.is_running ? "text-green-500" : "text-red-500"}
          />
          <Card label="Tracked Wallets" value={String(walletCount)} />
          <Card label="Signals" value={String(signals.length)} />
        </div>

        {/* Start/Stop */}
        <div className="flex items-center gap-4">
          <button
            onClick={toggleBot}
            disabled={toggling}
            className={`px-6 py-2 rounded-lg font-mono font-bold text-sm transition-colors ${
              botState?.is_running
                ? "bg-red-600 hover:bg-red-700 text-white"
                : "bg-green-600 hover:bg-green-700 text-white"
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {toggling ? "..." : botState?.is_running ? "STOP BOT" : "START BOT"}
          </button>
          {lastFetch && (
            <span className="text-zinc-600 text-xs">
              Last fetched: {lastFetch.toLocaleTimeString()}
            </span>
          )}
        </div>

        {/* ─── Performance ─────────────────────────────────── */}
        <section>
          <h2 className="text-lg font-semibold text-zinc-300 mb-3">
            Performance
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card label="Closed Trades" value={String(totalClosed)} />
            <Card
              label="Win Rate"
              value={`${winRate}%`}
              color={Number(winRate) >= 55 ? "text-green-500" : "text-red-500"}
            />
            <Card label="Wins" value={String(wins.length)} color="text-green-500" />
            <Card label="Losses" value={String(losses.length)} color="text-red-500" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4">
            <Card
              label="Avg Win"
              value={`+${avgGain}%`}
              color="text-green-500"
            />
            <Card
              label="Avg Loss"
              value={`${avgLoss}%`}
              color="text-red-500"
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
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <div className="text-zinc-500 text-xs uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className={`text-lg font-mono font-bold ${color || "text-white"}`}>
        {value}
      </div>
    </div>
  );
}
