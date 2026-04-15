"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";

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

interface PaperTrade {
  id: string;
  coin_address: string;
  coin_name: string | null;
  wallet_tag: string;
  entry_price: number;
  entry_mc: number | null;
  exit_price: number | null;
  pnl_pct: number | null;
  pnl_usd: number | null;
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
  const [openTrades, setOpenTrades] = useState<PaperTrade[]>([]);
  const [closedTrades, setClosedTrades] = useState<PaperTrade[]>([]);
  const [walletCount, setWalletCount] = useState(0);
  const [allClosedStats, setAllClosedStats] = useState<Array<{ pnl_pct: number | null; pnl_usd: number | null; exit_reason: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const [bankroll, setBankroll] = useState<{
    starting_balance: number;
    current_balance: number;
    total_pnl_usd: number;
  } | null>(null);
  const [liveTrading, setLiveTrading] = useState(false);
  const [togglingLive, setTogglingLive] = useState(false);
  const [phantomBalance, setPhantomBalance] = useState<{ sol: number; usd: number } | null>(null);
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [whaleSells, setWhaleSells] = useState<
    Record<string, Array<{ wallet_tag: string; signal_time: string }>>
  >({});

  const fetchData = useCallback(async () => {
    const [stateRes, signalsRes, walletsRes, openRes, closedRes, allClosedRes, bankrollRes] =
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
          .from("paper_trades")
          .select("*")
          .eq("status", "open")
          .order("entry_time", { ascending: false }),
        supabase
          .from("paper_trades")
          .select("*")
          .eq("status", "closed")
          .order("exit_time", { ascending: false })
          .limit(50),
        // Fetch ALL closed trades for accurate stats (just pnl fields, not full rows)
        supabase
          .from("paper_trades")
          .select("pnl_pct, pnl_usd, exit_reason")
          .eq("status", "closed"),
        supabase
          .from("paper_bankroll")
          .select("*")
          .limit(1)
          .single(),
      ]);

    if (stateRes.data && stateRes.data.length > 0) {
      setBotState(stateRes.data[0]);
      setLiveTrading(stateRes.data[0].mode === "live");
    }
    setSignals(signalsRes.data || []);
    setWalletCount(walletsRes.count || 0);
    setOpenTrades(openRes.data || []);
    setClosedTrades(closedRes.data || []);
    setAllClosedStats(allClosedRes.data || []);
    if (bankrollRes.data) setBankroll(bankrollRes.data);

    // Fetch live prices and whale sells for open positions
    const opens = openRes.data || [];
    if (opens.length > 0) {
      // Fetch prices from DexScreener
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

      // Fetch whale SELL signals for each open position
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

    // Fetch Phantom wallet balance when live trading
    if (stateRes.data?.[0]?.mode === "live") {
      try {
        const balRes = await fetch("/api/phantom-balance");
        if (balRes.ok) {
          const bal = await balRes.json();
          setPhantomBalance(bal);
        }
      } catch {}
    } else {
      setPhantomBalance(null);
    }

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

  async function toggleLiveTrading() {
    if (!botState) return;
    setTogglingLive(true);
    const newLive = !liveTrading;
    const newMode = newLive ? "live" : "paper";
    await supabase
      .from("bot_state")
      .update({ mode: newMode, last_updated: new Date().toISOString() })
      .eq("id", botState.id);
    setLiveTrading(newLive);
    setBotState({ ...botState, mode: newMode });
    setTogglingLive(false);
  }

  // ─── Paper Trade Stats (from ALL closed trades, not just display limit) ──

  const totalClosed = allClosedStats.length;
  const wins = allClosedStats.filter((t) => Number(t.pnl_pct) > 0);
  const losses = allClosedStats.filter((t) => Number(t.pnl_pct) <= 0);
  const winRate = totalClosed > 0 ? ((wins.length / totalClosed) * 100).toFixed(1) : "0";
  const avgGain =
    wins.length > 0
      ? (wins.reduce((s, t) => s + Number(t.pnl_pct), 0) / wins.length).toFixed(2)
      : "0";
  const avgLoss =
    losses.length > 0
      ? (losses.reduce((s, t) => s + Number(t.pnl_pct), 0) / losses.length).toFixed(2)
      : "0";

  // ─── Recovery Tracker ──────────────────────────────────
  const RECOVERY_GOAL = 3325;
  const totalWinUsd = wins.reduce((s, t) => s + Math.max(0, Number(t.pnl_usd || 0)), 0);
  const recoveryPct = Math.min((totalWinUsd / RECOVERY_GOAL) * 100, 100);
  const avgWinUsd = wins.length > 0 ? totalWinUsd / wins.length : 0;
  const tradesNeeded = avgWinUsd > 0 ? Math.ceil((RECOVERY_GOAL - totalWinUsd) / avgWinUsd) : 999;

  if (loading) {
    return <div className="text-zinc-500 text-center mt-20">Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-amber-500">PixiuBot</h1>
          <span className="text-xs text-zinc-600">Sprint 3 — Paper Trading</span>
        </div>

        {/* Phantom Wallet Balance (live mode only) */}
        {liveTrading && phantomBalance && (
          <div className="bg-red-900/30 border border-red-600 rounded-lg p-4 flex items-center justify-between">
            <div>
              <span className="text-red-400 font-bold text-sm font-mono">LIVE TRADING ACTIVE</span>
              <span className="text-zinc-500 text-xs ml-2">0.05 SOL/trade</span>
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
        )}

        {/* Bankroll */}
        {bankroll && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card label="Starting" value={`$${Number(bankroll.starting_balance).toLocaleString()}`} />
            <Card
              label="Current"
              value={`$${Number(bankroll.current_balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              color={Number(bankroll.current_balance) >= Number(bankroll.starting_balance) ? "text-green-500" : "text-red-500"}
            />
            <Card
              label="Total PnL"
              value={`${Number(bankroll.total_pnl_usd) >= 0 ? "+" : ""}$${Number(bankroll.total_pnl_usd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              color={Number(bankroll.total_pnl_usd) >= 0 ? "text-green-500" : "text-red-500"}
            />
            <Card
              label="Return"
              value={`${Number(bankroll.total_pnl_usd) >= 0 ? "+" : ""}${((Number(bankroll.total_pnl_usd) / Number(bankroll.starting_balance)) * 100).toFixed(2)}%`}
              color={Number(bankroll.total_pnl_usd) >= 0 ? "text-green-500" : "text-red-500"}
            />
          </div>
        )}

        {/* Recovery Tracker */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-bold text-amber-500">
              Recovery Goal: ${RECOVERY_GOAL.toLocaleString()}
            </span>
            <span className="text-sm font-mono text-zinc-400">
              ${totalWinUsd.toFixed(2)} / ${RECOVERY_GOAL.toLocaleString()}
            </span>
          </div>
          <div className="w-full bg-zinc-800 rounded-full h-4 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${Math.max(recoveryPct, 1)}%`,
                background: recoveryPct >= 100
                  ? "linear-gradient(90deg, #22c55e, #16a34a)"
                  : "linear-gradient(90deg, #f59e0b, #ef4444)",
              }}
            />
          </div>
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-zinc-500">
              {recoveryPct >= 100
                ? "GOAL REACHED"
                : `${recoveryPct.toFixed(1)}% there`}
            </span>
            <span className="text-xs text-zinc-500">
              {wins.length > 0 && recoveryPct < 100
                ? `~${tradesNeeded} winning trades to go (avg $${avgWinUsd.toFixed(2)}/win)`
                : recoveryPct >= 100
                  ? "Dustin's back"
                  : "Waiting for first win..."}
            </span>
          </div>
        </div>

        {/* Status Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card
            label="Status"
            value={botState?.is_running ? "RUNNING" : "STOPPED"}
            color={botState?.is_running ? "text-green-500" : "text-red-500"}
          />
          <Card label="Mode" value="PAPER" />
          <Card label="Tracked Wallets" value={String(walletCount)} />
          <Card label="Signals" value={String(signals.length)} />
        </div>

        {/* Start/Stop + Live Trading Toggle */}
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
          <button
            onClick={toggleLiveTrading}
            disabled={togglingLive}
            className={`px-6 py-2 rounded-lg font-mono font-bold text-sm transition-colors ${
              liveTrading
                ? "bg-red-600 hover:bg-red-700 text-white border-2 border-red-400"
                : "bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border-2 border-zinc-700"
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {togglingLive
              ? "..."
              : liveTrading
                ? "LIVE TRADING"
                : "PAPER ONLY"}
          </button>
          {lastFetch && (
            <span className="text-zinc-600 text-xs">
              Last fetched: {lastFetch.toLocaleTimeString()}
            </span>
          )}
        </div>

        {/* ─── Paper Trading Stats ────────────────────────── */}
        <section>
          <h2 className="text-lg font-semibold text-zinc-300 mb-3">
            Paper Trading
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card label="Total Trades" value={String(totalClosed)} />
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
              label="Avg Gain"
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
                const pnlPct =
                  entryPrice > 0 && currentPrice > 0
                    ? ((currentPrice - entryPrice) / entryPrice) * 100
                    : null;
                const entryTime = new Date(t.entry_time).getTime();
                const minutesOpen = (Date.now() - entryTime) / 60_000;
                const timeoutMin = 20;
                const timeRemaining = Math.max(0, timeoutMin - minutesOpen);
                const sells = whaleSells[t.coin_address] || [];
                const coinLabel =
                  t.coin_name || t.coin_address.slice(0, 8) + "...";

                return (
                  <div
                    key={t.id}
                    className="bg-zinc-900 border border-zinc-800 rounded-lg p-4"
                  >
                    {/* Row 1: Coin name, PnL, timeout */}
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
                        {/* Live PnL */}
                        {pnlPct !== null ? (
                          <span
                            className={`text-lg font-bold font-mono ${
                              pnlPct >= 0 ? "text-green-500" : "text-red-500"
                            }`}
                          >
                            {pnlPct >= 0 ? "+" : ""}
                            {pnlPct.toFixed(2)}%
                          </span>
                        ) : (
                          <span className="text-lg font-mono text-zinc-600">
                            —
                          </span>
                        )}
                        {/* Timeout countdown */}
                        <span
                          className={`text-xs font-mono px-2 py-1 rounded ${
                            timeRemaining <= 5
                              ? "bg-red-900/50 text-red-400"
                              : timeRemaining <= 10
                                ? "bg-amber-900/50 text-amber-400"
                                : "bg-zinc-800 text-zinc-400"
                          }`}
                        >
                          {timeRemaining <= 0
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
                      {t.partial_pnl > 0 && (
                        <span className="text-green-600">
                          Locked: +{t.partial_pnl.toFixed(2)}%
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
                            ? "TP 100%"
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
                    <th className="text-right py-2 px-3">PnL</th>
                    <th className="text-center py-2 px-3">Grid</th>
                    <th className="text-left py-2 px-3">Reason</th>
                    <th className="text-left py-2 px-3">Closed</th>
                  </tr>
                </thead>
                <tbody>
                  {closedTrades.map((t) => {
                    const pnl = Number(t.pnl_pct);
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
                        <td
                          className={`py-2 px-3 text-right font-bold ${
                            pnl >= 0 ? "text-green-500" : "text-red-500"
                          }`}
                        >
                          {pnl >= 0 ? "+" : ""}
                          {pnl.toFixed(2)}%
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
                                : t.exit_reason === "stop_loss"
                                  ? "text-red-500"
                                  : "text-zinc-500"
                            }
                          >
                            {t.exit_reason === "take_profit"
                              ? "TP"
                              : t.exit_reason === "stop_loss"
                                ? "SL"
                                : t.exit_reason === "timeout"
                                  ? "TO"
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
