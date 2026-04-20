/**
 * PixiuBot Agent 5 — Risk Guard
 *
 * Polls open positions every 5s from trades table.
 * Manages all exits with priority order:
 *   1. Circuit breaker: -25% emergency exit
 *   2. Whale exit: T1 wallet SELL detected
 *   3. Stop loss: -10% full exit
 *   4. Timeout: 20min full exit
 *   5. Grid levels: L1 +15% (50%) | L2 +40% (25%) | L3 +100% (25%)
 */

import { Connection, PublicKey } from "@solana/web3.js";
import supabase from "../lib/supabase-server";
import {
  LIVE_BUY_SOL,
  DAILY_LOSS_LIMIT_SOL,
} from "../config/smart-money";
import { sellToken, hasTokenBalance, wasLastSellUnsellable, wasSellSimAborted, parseSwapSolDelta } from "../lib/jupiter-swap";
import { sendAlert } from "../lib/telegram";

// Read-only RPC for holder-distribution checks (SolRugDetector 73% rule).
const HELIUS_KEY = process.env.HELIUS_API_KEY || "";
const introspectConn = new Connection(
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`,
  "confirmed"
);

// Per-position holder snapshot: tradeId → { entryTop20Addresses, entryTop20SumBalance, lastCheckMs }.
// Top-20 is the ceiling of getTokenLargestAccounts (RPC-native). We track
// the SET of addresses at entry + their summed balance, then compare on
// periodic re-check. Drop in intersection+balance > 73% = holder exodus,
// the SolRugDetector Pump-and-Dump trigger.
const HOLDER_CHECK_INTERVAL_MS = 60_000; // 1 per minute per open position
const HOLDER_DROP_THRESHOLD = 0.73;
type HolderSnapshot = {
  topAddresses: Set<string>;
  sumBalance: number;
  lastCheckMs: number;
};
const holderSnapshots = new Map<string, HolderSnapshot>();

async function snapshotTopHolders(mint: string): Promise<{ addresses: Set<string>; sumBalance: number } | null> {
  try {
    const res = await introspectConn.getTokenLargestAccounts(new PublicKey(mint));
    if (!res.value || res.value.length === 0) return null;
    // Exclude #1 — typically the bonding curve account (holds unsold
    // supply pre-graduation) or LP account post-graduation. Either way
    // not a "holder" in the rug-signal sense.
    const relevant = res.value.slice(1);
    const addresses = new Set<string>(relevant.map((a) => a.address.toBase58()));
    const sumBalance = relevant.reduce((s, a) => s + Number(a.uiAmount || 0), 0);
    return { addresses, sumBalance };
  } catch {
    return null;
  }
}

// Poll cadence split by grid level (Sprint 10 P2a, Apr 18).
// L0 positions have no grid cushion — a fast rug crosses -15% CB
// threshold in under 5s and we'd catch it too late. Poll L0 every 2s.
// L1+ positions have locked partials so 5s is plenty.
const POSITION_CHECK_MS_L0 = 2_000;
const POSITION_CHECK_MS_L1_PLUS = 5_000;
// Used in log banner for backward-compat
const POSITION_CHECK_MS = POSITION_CHECK_MS_L0;

async function isLiveTrading(): Promise<boolean> {
  // SAFETY: default to false (no trading) on ANY failure — never fire buys
  // when the DB can't tell us our mode. Live mode is the only non-safe state.
  try {
    const { data, error } = await supabase
      .from("bot_state")
      .select("mode")
      .limit(1)
      .single();
    if (error || !data) {
      console.error("  [GUARD] ⚠️ Failed to read bot_state — holding trades (no new entries)");
      return false;
    }
    return data.mode === "live";
  } catch {
    console.error("  [GUARD] ⚠️ bot_state query crashed — holding trades (no new entries)");
    return false;
  }
}

// Daily loss limit imported from config/smart-money.ts (single source of truth).
// Real exposure per trade is LIVE_BUY_SOL; daily limit is total LIVE loss in SOL.
let dailyLossLimitHit = false;
let lastLossCheckDate = "";

async function checkDailyLossLimit(): Promise<void> {
  const todayUTC = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Reset at midnight UTC
  if (todayUTC !== lastLossCheckDate) {
    if (dailyLossLimitHit) {
      console.log(`  [GUARD] Daily loss limit reset for ${todayUTC}`);
    }
    dailyLossLimitHit = false;
    lastLossCheckDate = todayUTC;
  }

  if (dailyLossLimitHit) return;

  // Sum REAL SOL lost across losing LIVE trades since midnight UTC.
  // Real ground truth = real_pnl_sol column (on-chain tx delta). Sum only
  // the negative values; abs of that sum is total SOL bled today.
  const todayStart = `${todayUTC}T00:00:00Z`;
  const { data: losses } = await supabase
    .from("trades")
    .select("real_pnl_sol")
    .eq("status", "closed")
    .gte("exit_time", todayStart)
    .lt("real_pnl_sol", 0)
    .like("wallet_tag", "%[LIVE]%");

  if (!losses || losses.length === 0) return;

  const totalLossSol = losses.reduce((sum, t) => {
    const r = t.real_pnl_sol !== null && t.real_pnl_sol !== undefined ? Number(t.real_pnl_sol) : 0;
    return sum + Math.abs(r);
  }, 0);
  const lossCount = losses.length;

  if (totalLossSol >= DAILY_LOSS_LIMIT_SOL) {
    dailyLossLimitHit = true;
    console.log(
      `  [GUARD] 🛑 Daily loss limit hit — ${lossCount} losing trades, real SOL lost: ${totalLossSol.toFixed(3)} (cap ${DAILY_LOSS_LIMIT_SOL} SOL, auto-resumes at midnight UTC)`
    );
    void sendAlert(
      "daily_limit",
      `Daily loss limit hit: ${lossCount} losses = ${totalLossSol.toFixed(3)} SOL real. Entries paused until midnight UTC.`
    );
    // Do NOT flip is_running=false. The per-buy daily_limit check in
    // trade-executor.ts already blocks new entries while the limit is
    // active, and it auto-clears at midnight UTC when the date flips.
    // Setting is_running=false would require a manual restart every day.
  }
}

// Grid levels ending at L2. L3 (+100%) is no longer a sell — instead it
// activates trailing-stop mode on the remaining 25% so moonshot tokens
// can ride past the old +42.5% cap. See trailing logic below.
const GRID_LEVELS = [
  { level: 1, pct: 15, sellPct: 50 },
  { level: 2, pct: 40, sellPct: 25 },
];
const L3_THRESHOLD_PCT = 100;       // pnl % where trailing mode activates
const TRAILING_STOP_PCT = 20;       // exit when price drops this % from peak
const STOP_LOSS_PCT = 10;
// Circuit breaker thresholds split by grid level (Sprint 9 P2a, Apr 18).
// Real-PnL analysis showed circuit_breaker had 26% real WR / -0.96 SOL on
// 53 trades. Main leak: fast rugs during the 30s min-hold window where
// SL (-10%) is disabled and only CB can fire. Previous -25% threshold
// let positions crash too far before emergency exit. Post L1/L2 grid
// partials we've already locked ≥ +7.5%, so keep the looser -25% for
// those — more tolerance for volatility when downside is capped.
const CIRCUIT_BREAKER_L0_PCT = 15;  // no partials locked yet — exit earlier
// Sprint 10 P0 (Apr 18 PM) — tightened L1+ CB from -25% to -15%.
// Evidence: 2 L1+ CB trades this session (Moo Noom L1 -38%, AHHHH L2 -48%),
// 0W/2L. Both locked partial profit, then rode all the way back past entry.
// At -15%, L1 still exits at >=0% final, L2 at >=+13.75% — banked profit
// protected. Matches L0 threshold for consistency. Wider than -10% to
// tolerate normal volatility before trailing kicks in.
const CIRCUIT_BREAKER_PCT = 15;     // L1+ with partials locked — protect the bank
// Sprint 10 Phase 2 (Apr 19 PM) — tightened 20 → 10 min.
// Pump.fun tokens pump within 5-8 min of entry or not at all; 20min
// let stale losers bleed for another 12min after the window closed.
// Trailing mode (L3) still bypasses timeout — moonshots can ride.
const TIMEOUT_MINUTES = 10;

// Sprint 10 Day 1 (Apr 18 PM) — WHALE_EXIT DISABLED.
//
// Post-mortem on Dicknald Trump (sell sig
// 65KGwpFd74vo5MBgi1JYTV2yok5vohmaVFmhZZybLYR1x5QdgPeJZ24HySGju1npFUpiEbs1iRePYS7iVE3ffFrn):
// 51.6B tokens bought for 0.050005 SOL at slot 414148529; sold 287
// slots (~2min) later for 0.001260 SOL — 2.52% recovery. DexScreener
// mark said -9.5% but Jupiter's quote (pump.fun AMM) said -97% at
// sell time. Sell succeeded at first 5% slippage try, no cascade.
// Root cause: AMM depth depletion in the 2-min window between our
// buy and the followed whale's sell. By the time whale_exit fires,
// the whale's tx has already landed and the pool is drained. Mark
// sources (DexScreener) lag AMM state by 5-30s so a "require mark
// confirmation" gate wouldn't help.
//
// 6 live L0 WE trades, 1W/5L, net ~-0.14 SOL. The one winner (Chud
// +22%) was whale-into-momentum, not a repeatable edge.
//
// Logic is kept (not deleted) so we can re-enable if we find a
// predictive signal (e.g. exit BEFORE the whale, not after).
const WHALE_EXIT_ENABLED = false;

// In-memory peak tracker for trailing mode: tradeId → peak USD price.
// Resets on bot restart (trailing continues from "peak since restart"
// instead of absolute peak — minor degradation, no DB migration needed).
const trailingPeaks = new Map<string, number>();

// ─── Price ──────────────────────────────────────────────

async function getPrice(
  mint: string
): Promise<{ price: number; source: string }> {
  try {
    const res = await fetch(`https://price.jup.ag/v6/price?ids=${mint}`);
    if (res.ok) {
      const data = await res.json();
      const price = data.data?.[mint]?.price;
      if (typeof price === "number" && price > 0)
        return { price, source: "jupiter" };
    }
  } catch {}
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`
    );
    if (res.ok) {
      const data = await res.json();
      const p = data.pairs?.[0]?.priceUsd;
      if (p) {
        const price = parseFloat(p);
        if (price > 0) return { price, source: "dexscreener" };
      }
    }
  } catch {}
  return { price: 0, source: "none" };
}

// Track positions already being closed to prevent duplicate exits
const closingPositions = new Set<string>();

// Phase 3 concurrency guard: prevents parallel grid-sell attempts on the
// same position. setInterval fires checkPositions every 2-5s regardless
// of whether the prior run finished. Without this lock, multiple poll
// iterations read stale grid_level from DB (before the partial sell's
// update commits) and all try to fire L1 simultaneously → Jupiter API
// rate-limit storm (HTTP 429 on every request). Lock entry → drop out
// of current poll's grid loop until the active sell finishes.
const gridSellingPositions = new Set<string>();

// ─── Position Check Loop ────────────────────────────────

async function checkPositions(levelFilter?: "L0" | "L1_PLUS"): Promise<void> {
  // Guard ALWAYS runs — even when bot is stopped
  // STOP BOT only blocks new entries (executor), never exits
  // Open positions must always be monitored for SL/CB/whale protection

  // Reaper: revert any 'closing' rows that have been stuck >5 min back to 'open'.
  // This recovers from bot crashes mid-sell (sell never landed AND status stuck).
  //
  // IMPORTANT: we check `closing_started_at`, not `entry_time`. entry_time
  // is fixed at buy and has nothing to do with how long the row has been
  // in closing state. Using entry_time caused a flip-flop race where an
  // in-flight close (awaiting Jupiter balance check) got reverted by the
  // other cadence's reaper, causing Yoshi to loop on stop_loss forever
  // (Apr 18 2026 bug).
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  await supabase
    .from("trades")
    .update({ status: "open", closing_started_at: null })
    .eq("status", "closing")
    .lt("closing_started_at", fiveMinAgo);

  const { data: allPositions, error } = await supabase
    .from("trades")
    .select("*")
    .eq("status", "open");

  if (error || !allPositions || allPositions.length === 0) return;

  // Split cadence: L0 polls every 2s, L1+ polls every 5s. Each interval
  // processes only its own grid_level bucket.
  const positions = levelFilter
    ? allPositions.filter((p) => {
        const lvl = p.grid_level || 0;
        return levelFilter === "L0" ? lvl === 0 : lvl > 0;
      })
    : allPositions;
  if (positions.length === 0) return;

  // Check daily loss limit (for live trading)
  const liveMode = await isLiveTrading();
  if (liveMode) await checkDailyLossLimit();

  console.log(`  [GUARD] Checking ${positions.length} open position(s)...`);

  for (const pos of positions) {
    // Skip if this position is already being closed
    if (closingPositions.has(pos.id)) continue;

    // Skip pre-confirmation positions in live mode
    // If live mode + no [LIVE] tag + less than 2min old → buy is still confirming
    // Avoids running grid/SL on positions that may never actually land on-chain
    if (liveMode && !pos.wallet_tag?.includes("[LIVE]")) {
      const ageMs = Date.now() - new Date(pos.entry_time).getTime();
      if (ageMs < 120_000) {
        continue; // Buy still confirming, don't track yet
      }
    }

    const { price: currentPrice, source } = await getPrice(pos.coin_address);
    const entryPrice = Number(pos.entry_price);
    const coinLabel = pos.coin_name || pos.coin_address.slice(0, 8) + "...";
    const currentLevel = pos.grid_level || 0;
    let remainingPct = pos.remaining_pct ?? 100;
    let partialPnl = pos.partial_pnl ?? 0;
    const posSize = Number(pos.position_size_usd) || 100;
    const entryTime = new Date(pos.entry_time).getTime();
    const minutesOpen = (Date.now() - entryTime) / 60_000;

    const priceFetchFailed = source === "none" || currentPrice <= 0;
    const pnlPct =
      entryPrice > 0 && currentPrice > 0
        ? ((currentPrice - entryPrice) / entryPrice) * 100
        : 0;

    // Helper: close trade
    // ORDER: in-memory lock → atomic DB claim → sell on-chain → credit bankroll
    // This prevents the "DB closed + bankroll credited but tokens never sold" bug.
    async function closeTrade(
      finalPnl: number,
      exitReason: string,
      gridLvl: number,
      exitPrice?: number
    ) {
      // 1. In-memory lock — block duplicate fires within same poll cycle
      if (closingPositions.has(pos.id)) return;
      closingPositions.add(pos.id);
      setTimeout(() => closingPositions.delete(pos.id), 60_000);

      const isLiveTrade = pos.wallet_tag?.includes("[LIVE]");

      // 2. Atomic DB claim — flip status='open' → 'closing' (only one writer wins).
      //    If another guard instance already claimed it, abort.
      const { data: claimed, error: claimErr } = await supabase
        .from("trades")
        .update({ status: "closing", closing_started_at: new Date().toISOString() })
        .eq("id", pos.id)
        .eq("status", "open")
        .select("id")
        .single();

      if (claimErr || !claimed) {
        console.log(`  [GUARD] ${coinLabel} close skipped — already claimed by another fire`);
        return;
      }

      // 3. Sell on-chain FIRST (live only). Only proceed to DB close + bankroll
      //    credit if the sell actually lands.
      //
      //    If the wallet has ZERO tokens for this mint, the token is gone —
      //    either already sold (grid partials filled earlier) or rugged to $0.
      //    In both cases, do NOT revert status (that causes infinite retry).
      //    Instead, close the position with locked PnL:
      //      - grid_level > 0: use partial_pnl (locked from earlier L1/L2 sells)
      //      - grid_level = 0: use current pnlPct (likely a rug loss)
      let sellLanded = true;
      if (isLiveTrade) {
        const held = await hasTokenBalance(pos.coin_address);
        if (!held) {
          const closedPnl = gridLvl > 0 ? (pos.partial_pnl ?? finalPnl) : pnlPct;
          console.log(`  [GUARD] Token balance 0 — marking ${coinLabel} as closed (mark ${closedPnl.toFixed(2)}%)`);
          const ep = exitPrice ?? currentPrice;

          // Phase 3 fix v2 (apr 20): two different cases to handle.
          //
          // CASE A — partials fired successfully (real_pnl_sol non-null,
          // grid_level > 0, tokens=0): the storm / sequential grid sells
          // already dumped the full bag on-chain. The SOL is in the
          // wallet. Accumulated real_pnl_sol IS the truth. Do NOT
          // subtract another "remaining cost basis" — those tokens are
          // not gone-to-zero, they were SOLD.
          //
          // CASE B — no partials tracked (real_pnl_sol null) but tokens
          // are gone: this is a genuine rug. Book -entry_cost as full loss.
          //
          // CASE C — grid_level > 0 but real_pnl_sol is null: partials
          // fired on the dashboard ledger but parseSwapSolDelta failed
          // to record them (RPC issue). We can't know the received SOL
          // without manual reconciliation. Leave real_pnl_sol null and
          // log loudly.
          let realPnlSolUpdate: number | null = null;
          const { data: row } = await supabase
            .from("trades")
            .select("entry_sol_cost, real_pnl_sol")
            .eq("id", pos.id)
            .maybeSingle();
          const entryCost = row?.entry_sol_cost ? Number(row.entry_sol_cost) : null;
          const existingPnl = row?.real_pnl_sol != null ? Number(row.real_pnl_sol) : null;

          if (existingPnl !== null) {
            // CASE A — trust accumulated partials as the truth.
            realPnlSolUpdate = existingPnl;
            console.log(
              `  [GUARD] 📊 tokens gone after partials; trusting accumulated real_pnl_sol = ${existingPnl >= 0 ? "+" : ""}${existingPnl.toFixed(6)} SOL (no extra cost-basis subtraction — SOL is in the wallet)`
            );
          } else if (gridLvl === 0 && entryCost !== null) {
            // CASE B — no partials, tokens gone: full loss.
            realPnlSolUpdate = -entryCost;
            console.log(
              `  [GUARD] 📊 tokens gone without any partial tracking (grid=0) — booking full entry cost as loss: -${entryCost.toFixed(6)} SOL`
            );
          } else {
            // CASE C — partials fired on ledger but none were SOL-delta-
            // recorded. Manual reconciliation needed.
            console.log(
              `  [GUARD] 🚨 ${coinLabel} tokens gone, grid=${gridLvl}, real_pnl_sol null — partials fired but SOL deltas were never recorded. Manual reconcile from on-chain data.`
            );
          }

          // IDEMPOTENT close: only transition 'closing' → 'closed'. If the
          // row is already closed (by any prior path), update matches 0 rows
          // and we return without error.
          const { data: flipped } = await supabase
            .from("trades")
            .update({
              exit_price: ep,
              status: "closed",
              exit_time: new Date().toISOString(),
              exit_reason: gridLvl > 0 ? "take_profit" : "rug_or_missing",
              grid_level: gridLvl,
              remaining_pct: 0,
              partial_pnl: closedPnl,
              ...(realPnlSolUpdate !== null ? { real_pnl_sol: realPnlSolUpdate } : {}),
            })
            .eq("id", pos.id)
            .eq("status", "closing")
            .is("exit_time", null)
            .select("id")
            .maybeSingle();
          if (!flipped) {
            console.log(`  [GUARD] ⚠️ ${coinLabel} already closed by another path — skipping`);
            return;
          }
          void sendAlert(
            gridLvl > 0 ? "take_profit" : "stop_loss",
            `${coinLabel} closed (token balance 0): ${closedPnl >= 0 ? "+" : ""}${closedPnl.toFixed(2)}%`
          );
          return;
        }

        console.log(`  [GUARD] [LIVE SELL] ${coinLabel} grid_level=${gridLvl} remaining=${remainingPct}% — selling via Jupiter`);
        // Pass entry cost + exit reason so jupiter-swap can run the
        // pre-flight recovery gate on rescue exits (Sprint 10 Phase 1).
        const entryCostForSim = pos.entry_sol_cost != null ? Number(pos.entry_sol_cost) : undefined;
        const sig = await sellToken(pos.coin_address, {
          entrySolCost: entryCostForSim,
          exitReason,
        });
        if (sig) {
          console.log(`  [GUARD] 🔴 LIVE SELL executed: ${sig} (${exitReason})`);

          // Compute + store REAL PnL from on-chain tx delta.
          //
          // Phase 3: real_pnl_sol may already contain accumulated PnL
          // from L1/L2 grid partials. At final close we ADD this sell's
          // contribution (received SOL - proportional cost basis) to
          // the existing value, never overwrite.
          //
          // Cost basis for this final sell = entryCost × remainingPct / 100
          // (we only sold that fraction of the original position just now).
          // If no partials fired: existing=0, remainingPct=100 → formula
          // reduces to solReceived - entryCost (the old behavior).
          //
          // Captured at call-time since remainingPct is mutated after
          // closeTrade in the grid loop on some paths.
          const remainingPctAtClose = remainingPct;
          (async () => {
            const solReceived = await parseSwapSolDelta(sig);
            if (solReceived === null) return;
            const { data: row } = await supabase
              .from("trades")
              .select("entry_sol_cost, real_pnl_sol")
              .eq("id", pos.id)
              .maybeSingle();
            const entryCost = row?.entry_sol_cost ? Number(row.entry_sol_cost) : null;
            const existingPnl = row?.real_pnl_sol != null ? Number(row.real_pnl_sol) : 0;
            const finalSellCostBasis = entryCost !== null ? (entryCost * remainingPctAtClose) / 100 : null;
            const finalSellPnl = finalSellCostBasis !== null ? solReceived - finalSellCostBasis : null;
            const realPnlSol = finalSellPnl !== null ? existingPnl + finalSellPnl : null;
            try {
              await supabase
                .from("trades")
                .update({
                  sell_tx_sig: sig,
                  ...(realPnlSol !== null ? { real_pnl_sol: realPnlSol } : {}),
                })
                .eq("id", pos.id);
              if (realPnlSol !== null) {
                console.log(
                  `  [GUARD] 📊 real PnL: ${realPnlSol >= 0 ? "+" : ""}${realPnlSol.toFixed(6)} SOL (final sell ${solReceived.toFixed(6)} − cost basis ${finalSellCostBasis!.toFixed(6)} = ${finalSellPnl! >= 0 ? "+" : ""}${finalSellPnl!.toFixed(6)}; prior partials: ${existingPnl >= 0 ? "+" : ""}${existingPnl.toFixed(6)})`
                );
              } else {
                console.log(`  [GUARD] 📊 sell_tx_sig recorded, real_pnl_sol skipped (no entry_sol_cost)`);
              }
            } catch (err: any) {
              console.error(`  [GUARD] real_pnl_sol write failed: ${err.message}`);
            }
          })().catch(() => {});
        } else {
          // Sell failed. Two failure classes:
          //   (a) Jupiter 6024 — un-sellable forever (transfer fee / TLV
          //       blocker). Mark-to-zero the remaining bag instead of
          //       retrying; otherwise the position loops forever. [P0b]
          //   (b) Any other transient failure (429 / network / slippage).
          //       Revert status → open and let next poll retry. The
          //       revert is GATED on status='closing' so we do not
          //       clobber a row that's already been closed by another
          //       path (was the root cause of the double-credit bug).
          // Sprint 10 Phase 1 — sim-gate abort: pool drained, selling would
          // realize dust. Revert to 'open' and let the 60s in-memory
          // closingPositions lock keep us from re-firing this cycle.
          // Next poll cycle will re-evaluate with fresh quote/sim.
          if (wasSellSimAborted(pos.coin_address)) {
            sellLanded = false;
            console.log(
              `  [GUARD] 🛑 ${coinLabel} sell aborted by sim gate (${exitReason}) — reverting to open, will re-check next cycle`
            );
            await supabase
              .from("trades")
              .update({ status: "open", closing_started_at: null })
              .eq("id", pos.id)
              .eq("status", "closing");
            void sendAlert(
              "sell_failed",
              `${coinLabel} sell sim-aborted (${exitReason}) — pool drained, held for re-check`
            );
            return;
          }
          if (wasLastSellUnsellable(pos.coin_address)) {
            // (a) mark-to-zero close
            const zeroPnlPct = (pos.partial_pnl ?? 0) + (-100 * remainingPct) / 100;
            console.log(
              `  [GUARD] 🪦 ${coinLabel} un-sellable (Jupiter 6024) — marking remaining ${remainingPct}% to zero. Final mark ${zeroPnlPct.toFixed(2)}%`
            );

            // Phase 3 fix: if real partials previously fired (grid_level > 0),
            // real_pnl_sol has banked L1/L2 gains. Remaining is now
            // unsellable (worthless). Subtract remaining cost basis so
            // real_pnl_sol reflects true wallet delta. Same pattern as
            // the rug_or_missing path above.
            let realPnlSolUpdate: number | null = null;
            if (gridLvl > 0) {
              const { data: row } = await supabase
                .from("trades")
                .select("entry_sol_cost, real_pnl_sol")
                .eq("id", pos.id)
                .maybeSingle();
              const entryCost = row?.entry_sol_cost ? Number(row.entry_sol_cost) : null;
              const existingPnl = row?.real_pnl_sol != null ? Number(row.real_pnl_sol) : 0;
              if (entryCost !== null) {
                const remainingCostBasis = (entryCost * remainingPct) / 100;
                realPnlSolUpdate = existingPnl - remainingCostBasis;
                console.log(
                  `  [GUARD] 📊 unsellable after partials — booking loss on remaining ${remainingPct}% (cost ${remainingCostBasis.toFixed(6)}): ${existingPnl >= 0 ? "+" : ""}${existingPnl.toFixed(6)} − ${remainingCostBasis.toFixed(6)} = ${realPnlSolUpdate >= 0 ? "+" : ""}${realPnlSolUpdate.toFixed(6)} SOL`
                );
              }
            } else {
              // No partials fired; the entire position is a loss. Book it.
              const { data: row } = await supabase
                .from("trades")
                .select("entry_sol_cost")
                .eq("id", pos.id)
                .maybeSingle();
              const entryCost = row?.entry_sol_cost ? Number(row.entry_sol_cost) : null;
              if (entryCost !== null) {
                realPnlSolUpdate = -entryCost;
                console.log(
                  `  [GUARD] 📊 unsellable from L0 — booking full loss: -${entryCost.toFixed(6)} SOL`
                );
              }
            }

            const { data: flipped } = await supabase
              .from("trades")
              .update({
                exit_price: 0,
                status: "closed",
                exit_time: new Date().toISOString(),
                exit_reason: "unsellable_6024",
                grid_level: gridLvl,
                remaining_pct: 0,
                partial_pnl: zeroPnlPct,
                ...(realPnlSolUpdate !== null ? { real_pnl_sol: realPnlSolUpdate } : {}),
              })
              .eq("id", pos.id)
              .eq("status", "closing")
              .is("exit_time", null)
              .select("id")
              .maybeSingle();
            if (!flipped) {
              console.log(`  [GUARD] ⚠️ ${coinLabel} already closed — skipping`);
              return;
            }
            void sendAlert("sell_failed", `${coinLabel} un-sellable (6024) — marked to zero. Mark ${zeroPnlPct.toFixed(2)}%`);
            return;
          }
          // (b) transient — revert closing → open for retry
          sellLanded = false;
          console.log(`  [GUARD] ⚠️ LIVE SELL failed for ${coinLabel} (held tokens but Jupiter rejected) — reverting status to 'open' for retry`);
          await supabase
            .from("trades")
            .update({ status: "open", closing_started_at: null })
            .eq("id", pos.id)
            .eq("status", "closing");          // P0b: only revert rows still in closing state
          void sendAlert(
            "sell_failed",
            `SELL failed: ${coinLabel} (${exitReason}). Position re-opened, will retry next poll.`
          );
          return;
        }
      }

      // 4. Sell landed — finalize close. IDEMPOTENT: only 'closing' → 'closed'.
      const ep = exitPrice ?? currentPrice;
      const { data: flipped } = await supabase
        .from("trades")
        .update({
          exit_price: ep,
          status: "closed",
          exit_time: new Date().toISOString(),
          exit_reason: exitReason,
          grid_level: gridLvl,
          remaining_pct: 0,
          partial_pnl: finalPnl,
        })
        .eq("id", pos.id)
        .eq("status", "closing")
        .is("exit_time", null)
        .select("id")
        .maybeSingle();
      if (!flipped) {
        console.log(`  [GUARD] ⚠️ ${coinLabel} already closed by another path — skipping`);
        return;
      }

      // Telegram alert — only for meaningful exits on LIVE trades
      if (isLiveTrade) {
        const sign = finalPnl >= 0 ? "+" : "";
        const kind: "whale_exit" | "circuit_breaker" | "stop_loss" | "take_profit" =
          exitReason === "whale_exit" ? "whale_exit"
          : exitReason === "circuit_breaker" ? "circuit_breaker"
          : exitReason === "stop_loss" ? "stop_loss"
          : "take_profit";
        void sendAlert(
          kind,
          `${coinLabel} exit (${exitReason}): ${sign}${finalPnl.toFixed(2)}%`
        );
      }
    }

    // 0a. Minimum hold time — skip all checks except CB if trade is < 30s old
    // Prevents immediate exits from stale signals or price echo
    const MIN_HOLD_SECONDS = 30;
    const secondsOpen = minutesOpen * 60;
    // Use tightened L0 threshold (-15%) when no grid has locked yet;
    // revert to normal -25% once L1+ partials are booked.
    const cbThreshold = currentLevel === 0 ? CIRCUIT_BREAKER_L0_PCT : CIRCUIT_BREAKER_PCT;
    if (secondsOpen < MIN_HOLD_SECONDS) {
      // Only allow circuit breaker through during hold period
      if (!priceFetchFailed && pnlPct <= -cbThreshold) {
        const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
        await closeTrade(finalPnl, "circuit_breaker", currentLevel);
        console.log(
          `  [GUARD] 🚨 ${coinLabel} crashed ${pnlPct.toFixed(1)}% during hold period (L${currentLevel} threshold -${cbThreshold}%) — emergency exit`
        );
      }
      continue;
    }

    // 0b. Rug Detection — price=0 means coin is dead, exit immediately
    if (priceFetchFailed && minutesOpen >= 2) {
      // Give new positions 2min grace period (DexScreener may not have data yet)
      const rugPnl = -100; // assume total loss
      const finalPnl = partialPnl + (rugPnl * remainingPct) / 100;
      await closeTrade(finalPnl, "circuit_breaker", currentLevel, 0);
      console.log(
        `  [GUARD] 🚨 ${coinLabel} price=0 detected — treating as rug, exiting now | PnL: ${finalPnl.toFixed(2)}%`
      );
      continue;
    }

    // 0c. Holder-exodus check — SolRugDetector (ArXiv 2603.24625) τ_down=0.73.
    // At entry, we snapshot top-20 holder addresses + their summed balance
    // (excluding #1 which is the bonding curve / LP). On cooldown we re-check.
    // If >73% of the entry-time holder set has exited OR the summed balance
    // has dropped >73%, that's a pump-and-dump rug signature. Emergency CB.
    // Only runs for live trades (no point checking paper positions) and
    // cooldowns to 60s per position so we don't hammer RPC.
    if (pos.wallet_tag?.includes("[LIVE]")) {
      const snap = holderSnapshots.get(pos.id);
      const nowMs = Date.now();
      if (!snap) {
        // First observation — take the snapshot and don't check this cycle.
        const s = await snapshotTopHolders(pos.coin_address);
        if (s) {
          holderSnapshots.set(pos.id, {
            topAddresses: s.addresses,
            sumBalance: s.sumBalance,
            lastCheckMs: nowMs,
          });
          console.log(
            `  [GUARD] [HOLDER] ${coinLabel} entry snapshot — ${s.addresses.size} top holders, sum balance ${s.sumBalance.toFixed(0)}`
          );
        }
      } else if (nowMs - snap.lastCheckMs >= HOLDER_CHECK_INTERVAL_MS) {
        const current = await snapshotTopHolders(pos.coin_address);
        if (current) {
          snap.lastCheckMs = nowMs;
          // How many entry-time top holders are still in the current top 20?
          let stillPresent = 0;
          for (const addr of snap.topAddresses) if (current.addresses.has(addr)) stillPresent++;
          const holderRetention = snap.topAddresses.size > 0 ? stillPresent / snap.topAddresses.size : 1;
          const balanceRetention = snap.sumBalance > 0 ? current.sumBalance / snap.sumBalance : 1;
          console.log(
            `  [GUARD] [HOLDER] ${coinLabel} retention — holders ${(holderRetention * 100).toFixed(0)}%, balance ${(balanceRetention * 100).toFixed(0)}%`
          );
          if (holderRetention < (1 - HOLDER_DROP_THRESHOLD) || balanceRetention < (1 - HOLDER_DROP_THRESHOLD)) {
            const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
            console.log(
              `  [GUARD] 🚨 ${coinLabel} holder exodus >${(HOLDER_DROP_THRESHOLD * 100).toFixed(0)}% (retention holders=${(holderRetention * 100).toFixed(0)}%, balance=${(balanceRetention * 100).toFixed(0)}%) — emergency exit | PnL: ${finalPnl.toFixed(2)}%`
            );
            await closeTrade(finalPnl, "holder_rug", currentLevel);
            holderSnapshots.delete(pos.id);
            continue;
          }
        }
      }
    }

    // 1. Circuit Breaker — ABSOLUTE FIRST CHECK
    // Threshold split by grid level: L0 = -15%, L1+ = -25% (see constants above).
    console.log(
      `  [GUARD CB CHECK] ${coinLabel} pnlPct=${pnlPct.toFixed(1)}% L${currentLevel} ${remainingPct}% remaining (entry:$${entryPrice} now:$${currentPrice} src:${source})`
    );

    if (!priceFetchFailed && pnlPct <= -cbThreshold) {
      const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
      await closeTrade(finalPnl, "circuit_breaker", currentLevel);
      console.log(
        `  [GUARD] 🚨 ${coinLabel} crashed ${pnlPct.toFixed(1)}% (L${currentLevel} threshold -${cbThreshold}%) — emergency exit | PnL: ${finalPnl.toFixed(2)}%`
      );
      continue;
    }

    // 1b. Skip non-timeout exits if pnlPct is exactly 0% (price echo / stale data)
    if (pnlPct === 0 && !priceFetchFailed && minutesOpen < TIMEOUT_MINUTES) {
      console.log(
        `  [GUARD] ${coinLabel} pnlPct=0.0% (price echo) — skipping exit checks, waiting for real price movement`
      );
      continue;
    }

    // 2. Whale Exit — T1 wallet SELL detected.
    // Uses DB tier=1 active=true (not the hardcoded config set). The webhook
    // already uses DB tier (commit 027fa83); risk-guard was missed during
    // that migration — only 14/63 T1 wallets were covered until this fix.
    // Sprint 8 Bug-1 fix.
    const { data: smartWalletRows } = await supabase
      .from("tracked_wallets")
      .select("tag")
      .eq("tier", 1)
      .eq("active", true);

    const smartMoneyTags = new Set(
      smartWalletRows?.map((w) => w.tag) || []
    );

    const { data: sellSignals } = await supabase
      .from("coin_signals")
      .select("wallet_tag")
      .eq("coin_address", pos.coin_address)
      .eq("transaction_type", "SELL")
      .gte("signal_time", new Date(entryTime).toISOString())
      .limit(10);

    if (sellSignals && sellSignals.length > 0) {
      const whaleExits = sellSignals.filter((s) =>
        smartMoneyTags.has(s.wallet_tag)
      );
      // Kept for observability + future predictive re-enable. Gated by
      // WHALE_EXIT_ENABLED (Sprint 10 Day 1: disabled after Dicknald
      // Trump post-mortem — pool drainage race, not recoverable via
      // mark-confirmation). See constant comment above for full reasoning.
      if (whaleExits.length > 0 && WHALE_EXIT_ENABLED && currentLevel === 0) {
        const whaleTag = whaleExits[0].wallet_tag;
        const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
        await closeTrade(finalPnl, "whale_exit", currentLevel);
        console.log(
          `  [GUARD] 🐳 ${whaleTag} sold ${coinLabel} — exiting with whale | PnL: ${finalPnl >= 0 ? "+" : ""}${finalPnl.toFixed(2)}%`
        );
        continue;
      }
      if (whaleExits.length > 0 && !WHALE_EXIT_ENABLED) {
        const whaleTag = whaleExits[0].wallet_tag;
        console.log(
          `  [GUARD] whale_exit disabled — ignoring ${whaleTag} SELL on ${coinLabel}, letting SL/CB/TO handle`
        );
      }
      if (whaleExits.length > 0 && WHALE_EXIT_ENABLED && currentLevel > 0) {
        console.log(
          `  [GUARD] whale_exit skipped on ${coinLabel} — already at grid L${currentLevel}, letting grid/trailing handle exit`
        );
      }
    }

    // 3. Stop Loss
    if (pnlPct <= -STOP_LOSS_PCT) {
      const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
      await closeTrade(finalPnl, "stop_loss", currentLevel);
      console.log(
        `  [GUARD] ❌ ${coinLabel} stop loss | PnL: ${finalPnl >= 0 ? "+" : ""}${finalPnl.toFixed(2)}%`
      );
      continue;
    }

    // 4. Timeout — skipped while in trailing-stop mode so moonshot runs
    //    can ride past the 20-min window (airdropper-style +14000% plays).
    const trailingActive = currentLevel === 3 && remainingPct > 0;
    if (!trailingActive && minutesOpen >= TIMEOUT_MINUTES) {
      const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
      await closeTrade(finalPnl, "timeout", currentLevel);
      console.log(
        `  [GUARD] ⏰ ${coinLabel} timeout ${minutesOpen.toFixed(0)}min | PnL: ${finalPnl >= 0 ? "+" : ""}${finalPnl.toFixed(2)}%`
      );
      continue;
    }

    // 5. Grid Levels — REAL partial sells (Phase 3, Apr 19 PM).
    //
    // Before today these were virtual-only: we updated grid_level and
    // remaining_pct in the DB but no tokens were actually sold. Full
    // position rode until a final exit event (CB/SL/TO/trailing_stop)
    // dumped everything. That meant L1/L2 "banked" gains were fiction,
    // and positions that hit +40% then crashed booked the whole crash.
    //
    // Now: each grid threshold crosses triggers a real sellToken call
    // for the proportional slice of current wallet balance. SOL received
    // accumulates into real_pnl_sol. L3 still activates trailing mode
    // (no sell — remaining 25% rides peak).
    let newLevel = currentLevel;
    let updated = false;
    const isLiveTradeForGrid = pos.wallet_tag?.includes("[LIVE]");

    // Concurrency guard: if a grid-sell is already running on this
    // position from a prior poll iteration, skip the grid loop
    // entirely. Stale DB reads across parallel polls would otherwise
    // fire duplicate L1 sells → Jupiter 429 storm.
    if (isLiveTradeForGrid && gridSellingPositions.has(pos.id)) {
      // fall through to trailing/close logic; skip grid evaluation
    } else {
      const releaseLock = isLiveTradeForGrid
        ? () => gridSellingPositions.delete(pos.id)
        : () => {};
      if (isLiveTradeForGrid) gridSellingPositions.add(pos.id);
      try {

    for (const grid of GRID_LEVELS) {
      if (grid.level <= currentLevel) continue;
      if (pnlPct < grid.pct) break;

      // Fraction of CURRENT wallet balance to sell = grid.sellPct /
      // remainingPct × 100. If remainingPct=100%, L1 sellPct=50 → 50% of
      // current. After L1, remainingPct=50%; L2 sellPct=25 → 50% of
      // what's left (= 25% of original). Math stays consistent as grid
      // levels cascade in a single poll cycle.
      const sellPctOfCurrent = (grid.sellPct / remainingPct) * 100;

      if (isLiveTradeForGrid) {
        console.log(
          `  [GUARD] [GRID L${grid.level}] ${coinLabel} triggered at +${pnlPct.toFixed(1)}% — selling ${sellPctOfCurrent.toFixed(1)}% of current balance via Jupiter`
        );
        const partialSig = await sellToken(pos.coin_address, {
          sellPercent: sellPctOfCurrent,
          // No entrySolCost/exitReason — grid is voluntary take-profit,
          // never hits the sim-abort floor.
        });
        if (!partialSig) {
          console.log(
            `  [GUARD] [GRID L${grid.level}] ${coinLabel} PARTIAL SELL FAILED — checking if tokens are gone`
          );
          // Detect the "balance already 0" case — means prior partials
          // already sold everything (typically from the pre-mutex 429
          // storm). If no tokens in wallet, short-circuit to closeTrade
          // which marks the trade closed with take_profit (grid>0) and
          // reconciles real_pnl_sol against accumulated partials. Avoids
          // infinite retry loop.
          const held = await hasTokenBalance(pos.coin_address);
          if (!held) {
            console.log(
              `  [GUARD] [GRID L${grid.level}] ${coinLabel} wallet has 0 tokens — short-circuiting to closeTrade (take_profit) to reconcile state`
            );
            await closeTrade(partialPnl, "take_profit", grid.level);
            break;
          }
          console.log(
            `  [GUARD] [GRID L${grid.level}] ${coinLabel} tokens still held — Jupiter issue, will retry next poll`
          );
          break; // don't advance grid_level; next poll retries
        }

        console.log(
          `  [GUARD] [GRID L${grid.level}] ${coinLabel} partial sold: ${partialSig}`
        );

        // Accumulate real_pnl_sol additively: each partial's (received
        // - proportional cost basis). Background so it doesn't block.
        //
        // Phase 3 robustness: parseSwapSolDelta can return null if RPC
        // hasn't indexed the tx yet. We retry with backoff (1s, 3s, 10s)
        // so partial gains are never silently lost. Worst case: all
        // retries fail, we LOUDLY log the sig so it can be reconciled
        // manually from the on-chain data.
        const partialSigCaptured = partialSig;
        const gridLevelCaptured = grid.level;
        const sellPctCaptured = grid.sellPct;
        (async () => {
          try {
            let partialReceived: number | null = null;
            const retryDelays = [1_000, 3_000, 10_000];
            for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
              if (attempt > 0) {
                await new Promise((r) => setTimeout(r, retryDelays[attempt - 1]));
              }
              partialReceived = await parseSwapSolDelta(partialSigCaptured);
              if (partialReceived !== null) break;
            }
            if (partialReceived === null) {
              console.error(
                `  [GUARD] 🚨 L${gridLevelCaptured} REAL PARTIAL LANDED BUT SOL DELTA COULD NOT BE PARSED AFTER RETRIES. Sig: ${partialSigCaptured}. real_pnl_sol NOT UPDATED. Manually reconcile from on-chain tx.`
              );
              void sendAlert(
                "sell_failed",
                `${coinLabel} L${gridLevelCaptured} partial landed but SOL delta unparseable. Manual reconcile needed. Sig: ${partialSigCaptured.slice(0, 16)}...`
              );
              return;
            }
            const { data: row } = await supabase
              .from("trades")
              .select("entry_sol_cost, real_pnl_sol")
              .eq("id", pos.id)
              .maybeSingle();
            const entryCost = row?.entry_sol_cost ? Number(row.entry_sol_cost) : null;
            const existingPnl = row?.real_pnl_sol != null ? Number(row.real_pnl_sol) : 0;
            if (entryCost === null) {
              console.error(
                `  [GUARD] 🚨 L${gridLevelCaptured} partial landed but entry_sol_cost missing. Sig: ${partialSigCaptured}. real_pnl_sol NOT UPDATED.`
              );
              return;
            }
            const costBasisThisPartial = (entryCost * sellPctCaptured) / 100;
            const partialPnlSol = partialReceived - costBasisThisPartial;
            const newRealPnl = existingPnl + partialPnlSol;
            await supabase
              .from("trades")
              .update({ real_pnl_sol: newRealPnl })
              .eq("id", pos.id);
            console.log(
              `  [GUARD] 📊 L${gridLevelCaptured} real partial PnL: ${partialPnlSol >= 0 ? "+" : ""}${partialPnlSol.toFixed(6)} SOL (received ${partialReceived.toFixed(6)} - cost basis ${costBasisThisPartial.toFixed(6)}) | cumulative ${newRealPnl >= 0 ? "+" : ""}${newRealPnl.toFixed(6)}`
            );
          } catch (err: any) {
            console.error(`  [GUARD] partial PnL write failed: ${err.message}`);
          }
        })().catch(() => {});
      } else {
        console.log(
          `  [GUARD] [GRID L${grid.level}] ${coinLabel} → virtual (not [LIVE]) at +${grid.pct}%`
        );
      }

      // Advance virtual state (same as before)
      const portionPnl = (grid.pct * grid.sellPct) / 100;
      partialPnl += portionPnl;
      remainingPct -= grid.sellPct;
      newLevel = grid.level;
      updated = true;

      console.log(
        `  [GUARD] [GRID L${grid.level}] ${coinLabel} now at ${remainingPct}% remaining (partial_pnl mark +${partialPnl.toFixed(2)}%)`
      );
    }

      } finally {
        releaseLock();
      }
    }

    // 5a. L3 activation: instead of selling the last 25% at +100%, flip to
    //     trailing-stop mode so the position can ride indefinitely until
    //     the peak drops by TRAILING_STOP_PCT.
    if (!priceFetchFailed && newLevel < 3 && pnlPct >= L3_THRESHOLD_PCT) {
      newLevel = 3;
      updated = true;
      trailingPeaks.set(pos.id, currentPrice);
      console.log(
        `  [GUARD] [TRAILING ACTIVATED] ${coinLabel} at +${pnlPct.toFixed(1)}% — trailing stop engaged (peak $${currentPrice.toFixed(10)}, trail -${TRAILING_STOP_PCT}%)`
      );
    }

    if (remainingPct <= 0) {
      await closeTrade(partialPnl, "take_profit", newLevel);
      console.log(
        `  [GUARD] ✅ ${coinLabel} fully exited at L${newLevel} | PnL: +${partialPnl.toFixed(2)}%`
      );
      continue;
    }

    // 5b. Trailing tick — runs every poll while in L3 trailing state.
    //     Ratchets peak upward; exits if price falls TRAILING_STOP_PCT from peak.
    if (newLevel === 3 && remainingPct > 0 && !priceFetchFailed) {
      let peak = trailingPeaks.get(pos.id);
      if (peak === undefined || currentPrice > peak) {
        peak = currentPrice;
        trailingPeaks.set(pos.id, peak);
      }
      const dropPct = ((currentPrice - peak) / peak) * 100;
      console.log(
        `  [GUARD] [TRAILING] ${coinLabel} at +${pnlPct.toFixed(1)}% — peak $${peak.toFixed(10)}, current $${currentPrice.toFixed(10)}, trail ${dropPct.toFixed(1)}%`
      );
      if (dropPct <= -TRAILING_STOP_PCT) {
        const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
        await closeTrade(finalPnl, "trailing_stop", newLevel);
        trailingPeaks.delete(pos.id);
        console.log(
          `  [GUARD] [TRAILING EXIT] ${coinLabel} sold at +${pnlPct.toFixed(1)}% from ${dropPct.toFixed(1)}% peak drop | PnL: +${finalPnl.toFixed(2)}%`
        );
        continue;
      }
    }

    if (updated) {
      await supabase
        .from("trades")
        .update({
          grid_level: newLevel,
          remaining_pct: remainingPct,
          partial_pnl: partialPnl,
        })
        .eq("id", pos.id);
    }
  }
}

export async function startRiskGuard(): Promise<void> {
  const startLive = await isLiveTrading();
  console.log(`  [GUARD] Starting risk guard... (LIVE: ${startLive ? "🔴 ON" : "⚪ OFF"} — dashboard controlled)`);
  console.log(
    `  [GUARD] Exit priority: CB(L0 -${CIRCUIT_BREAKER_L0_PCT}% / L1+ -${CIRCUIT_BREAKER_PCT}%) > Whale(${WHALE_EXIT_ENABLED ? "L0 only" : "DISABLED"}) > SL(-${STOP_LOSS_PCT}%) > TO(${TIMEOUT_MINUTES}min) > Grid | Poll: L0 ${POSITION_CHECK_MS_L0 / 1000}s / L1+ ${POSITION_CHECK_MS_L1_PLUS / 1000}s`
  );

  // Run immediately across all positions
  await checkPositions();

  // Split cadence: L0 polls every 2s (fast-rug protection), L1+ every 5s
  // (partials locked, downside capped).
  setInterval(() => checkPositions("L0"), POSITION_CHECK_MS_L0);
  setInterval(() => checkPositions("L1_PLUS"), POSITION_CHECK_MS_L1_PLUS);

  console.log(`  [GUARD] Polling L0 every ${POSITION_CHECK_MS_L0 / 1000}s, L1+ every ${POSITION_CHECK_MS_L1_PLUS / 1000}s`);
}
