/**
 * P0c — Bankroll Reconcile (Sprint 8)
 *
 * Aligns paper_bankroll.current_balance with the authoritative per-trade
 * ledger (SUM of paper_trades.pnl_usd for status=closed). Drift between
 * the two indicates phantom credits from the Apr 17 P0b double-credit
 * bug (and any other accumulated noise).
 *
 * Separate from the Sprint 5 D2 reconcile-bankroll.ts which handled a
 * specific stuck-sell scenario — kept as historical record.
 *
 * Runs AFTER P0b (commit 1b808a7) deploys so the reconciled state holds.
 */

import "../lib/supabase-server";
import supabase from "../lib/supabase-server";

const WALLET = "ESK3r8n5jhaLn9Few59QKNJ5UMeD9iqZ5p1rbU9euvey";

async function getOnChainSol(): Promise<number | null> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [WALLET] }),
    });
    const js: any = await res.json();
    const lamports = js?.result?.value ?? 0;
    return lamports / 1e9;
  } catch {
    return null;
  }
}

(async () => {
  // 1. Current paper_bankroll state
  const { data: bankroll } = await supabase
    .from("paper_bankroll")
    .select("*")
    .limit(1)
    .single();
  if (!bankroll) {
    console.error("No paper_bankroll row found — aborting");
    process.exit(1);
  }
  const currentBalance = Number(bankroll.current_balance);
  const startingBalance = Number(bankroll.starting_balance ?? 10000);

  // 2. Authoritative PnL — sum of pnl_usd for all closed trades
  const { data: closed } = await supabase
    .from("paper_trades")
    .select("pnl_usd")
    .eq("status", "closed");
  const sumPnlUsd = (closed ?? []).reduce(
    (s, t) => s + (Number(t.pnl_usd) || 0),
    0
  );
  const expectedBalance = startingBalance + sumPnlUsd;

  // 3. Drift
  const drift = currentBalance - expectedBalance;

  // 4. Real on-chain SOL (reference)
  const realSol = await getOnChainSol();

  console.log("=== P0c Bankroll Reconcile ===");
  console.log(`  Starting balance:    $${startingBalance.toFixed(2)}`);
  console.log(`  Current balance:     $${currentBalance.toFixed(2)}`);
  console.log(`  Σ pnl_usd (ledger):  $${sumPnlUsd.toFixed(2)}`);
  console.log(`  Expected:            $${expectedBalance.toFixed(2)}`);
  console.log(`  Drift (curr−exp):    ${drift >= 0 ? "+" : ""}$${drift.toFixed(2)}`);
  console.log(`  Closed trades:       ${closed?.length ?? 0}`);
  console.log(`  Real on-chain SOL:   ${realSol !== null ? realSol.toFixed(4) : "(unavailable)"}`);
  console.log("");

  if (Math.abs(drift) < 0.01) {
    console.log("✅ Drift < $0.01 — no reconcile needed.");
    return;
  }

  const note = `P0c reconcile ${new Date().toISOString().slice(0, 10)}: ${drift >= 0 ? "removed" : "added"} $${Math.abs(drift).toFixed(2)} drift (P0b phantom credits). Before=$${currentBalance.toFixed(2)} → After=$${expectedBalance.toFixed(2)}. Authoritative: SUM(paper_trades.pnl_usd, status=closed).`;

  const { error } = await supabase
    .from("paper_bankroll")
    .update({
      current_balance: expectedBalance,
      total_pnl_usd: sumPnlUsd,
      updated_at: new Date().toISOString(),
    })
    .eq("id", bankroll.id);

  if (error) {
    console.error("Reconcile UPDATE failed:", error);
    process.exit(1);
  }

  console.log(`🪙 Reconciled. ${note}`);
})();
