"use client";

import { useEffect, useState } from "react";
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
}

export default function BotPage() {
  const [botState, setBotState] = useState<BotState | null>(null);
  const [signals, setSignals] = useState<CoinSignal[]>([]);
  const [walletCount, setWalletCount] = useState(0);
  const [loading, setLoading] = useState(true);

  async function fetchData() {
    const [stateRes, signalsRes, walletsRes] = await Promise.all([
      supabase
        .from("bot_state")
        .select("*")
        .order("last_updated", { ascending: false })
        .limit(1),
      supabase
        .from("coin_signals")
        .select("*")
        .order("signal_time", { ascending: false })
        .limit(20),
      supabase
        .from("tracked_wallets")
        .select("id", { count: "exact", head: true })
        .eq("active", true),
    ]);

    if (stateRes.data && stateRes.data.length > 0) {
      setBotState(stateRes.data[0]);
    }
    setSignals(signalsRes.data || []);
    setWalletCount(walletsRes.count || 0);
    setLoading(false);
  }

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10_000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return <div className="text-zinc-500 text-center mt-20">Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-amber-500">PixiuBot</h1>
          <span className="text-xs text-zinc-600">
            Sprint 0 — Observe Only
          </span>
        </div>

        {/* Status Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card
            label="Status"
            value={botState?.is_running ? "RUNNING" : "STOPPED"}
            color={botState?.is_running ? "text-green-500" : "text-red-500"}
          />
          <Card label="Mode" value={botState?.mode?.toUpperCase() || "N/A"} />
          <Card label="Tracked Wallets" value={String(walletCount)} />
          <Card label="Signals" value={String(signals.length)} />
        </div>

        {/* Last Updated */}
        {botState?.last_updated && (
          <div className="text-zinc-600 text-xs">
            Last updated:{" "}
            {new Date(botState.last_updated).toLocaleString()}
          </div>
        )}

        {/* Recent Signals */}
        <section>
          <h2 className="text-lg font-semibold text-zinc-300 mb-3">
            Recent Signals
          </h2>
          {signals.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm font-mono">
                <thead>
                  <tr className="text-zinc-500 border-b border-zinc-800">
                    <th className="text-left py-2 px-3">Coin</th>
                    <th className="text-left py-2 px-3">Wallet</th>
                    <th className="text-right py-2 px-3">Entry MC</th>
                    <th className="text-center py-2 px-3">Rug Check</th>
                    <th className="text-right py-2 px-3">Gap (min)</th>
                    <th className="text-left py-2 px-3">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.map((s) => (
                    <tr
                      key={s.id}
                      className="border-b border-zinc-900 hover:bg-zinc-900/50"
                    >
                      <td className="py-2 px-3 text-amber-500">
                        {s.coin_name || s.coin_address.slice(0, 8) + "..."}
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
                        {s.rug_check_passed === null
                          ? "-"
                          : s.rug_check_passed
                            ? "PASS"
                            : "FAIL"}
                      </td>
                      <td className="py-2 px-3 text-right">
                        {s.price_gap_minutes ?? "-"}
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
            <div className="text-zinc-600 text-sm">
              No signals yet. Start feed.ts and add wallets to begin
              monitoring.
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
