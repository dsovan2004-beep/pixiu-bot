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
import { sellToken, hasTokenBalance, wasLastSellUnsellable, wasSellSimAborted, parseSwapSolDelta, simulateSellRecovery } from "../lib/jupiter-swap";
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

// Sprint 10 Phase 4 — liquidity drainage monitor during hold.
// Openhuman (Apr 21) root-caused: pool went from ~97% round-trip
// recovery at entry to fully drained (Jupiter 6024 across all 4
// slippage levels) ~11 minutes later. Bot had no way to see the
// drainage until it tried to sell at L1 and ate a -100% real loss.
// Fix: periodic simulateSellRecovery() on the current bag. If quoted
// recovery drops below the floor, exit now before it hits zero.
// Threshold 0.40 is conservative — only triggers on real drainage, not
// pool noise. Interval 60s per position keeps Helius/Jupiter load
// bounded to ~1 quote call per open position per minute.
const LIQUIDITY_CHECK_INTERVAL_MS = 60_000;
// Apr 22 PM: raised 0.40 → 0.60. The old 40% floor was calibrated pre-
// 07822a1 when sim recovery was a buggy halved metric. Post-fix, healthy
// pools quote ~100% of slice cost basis, drained pools quote 50-60%,
// dead pools < 30%. A 40% floor only fires AFTER the rug is complete.
// Asteroid (Apr 22) crashed from 99% → 48.6% sim recovery in one poll;
// by the next poll mark was -39% and we ate -0.020 SOL. A 60% floor
// would have fired at the 48.6% reading when mark was still -5%,
// saving ~0.035 SOL per rug-class trade.
//
// Apr 23 PM: raised 0.60 → 0.85. Shoebill (today) entered with post-buy
// sim at 66.2% IMMEDIATELY (pre-buy was 97.6% — our own 0.025 drained 31
// points of liquidity = structurally broken pool). Mark peaked at +29.5%
// but phantom peak gate correctly blocked L1 partials all through the
// pump. Drain eventually fired at 54.5% after mark crashed to -8%, real
// loss -0.016 SOL.
//
// A 0.85 floor would have fired on the FIRST liquidity check at 66.2%,
// exiting at entry-time slippage only (~-0.010 SOL). That's a 38% loss
// cut per broken-pool entry. Healthy pools quote 88-105% post-buy (e.g.
// Enrique 90.6%, Ben Pasterneck 87.8%) so 0.85 still preserves legit
// positions — it only catches the structurally broken ones.
//
// Tradeoff: some borderline pools (85-88%) might get dumped that would
// otherwise recover. Acceptable cost to prevent shoebill-class -0.016
// losses that compound fast at 25% WR.
const LIQUIDITY_DROP_THRESHOLD = 0.85;
const liquiditySnapshots = new Map<string, { lastCheckMs: number }>();
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
// Apr 21 PM: tightened 20 → 10 after hehehe round-trip catastrophe.
// +100% pumps on pump.fun tokens reverse in 60-180s. A 20% trail meant
// we waited for a ~20pp peak drop before even triggering sellToken —
// then sellToken's confirmation + ladder (even with rescue-mode fix)
// needs another 60-120s. By the time we actually land, the bag is
// often at +30-50% mark instead of the +80-90% we could have captured
// firing earlier. -10% trail means trailing triggers roughly when the
// reversal starts, not after it's well underway. Tradeoff: on sustained
// uptrends (Soltards-class +285%), we exit slightly earlier, but still
// catch the bulk of the move since peak updates ratchet upward with
// every new high.
const TRAILING_STOP_PCT = 10;       // exit when price drops this % from peak (L3 mode)

// Sprint 10 Phase 6 — POST-L1 RETRACEMENT TRAIL.
// SCHIZO SIGNALS (Apr 21) killer pattern: L1 fired at mark +17%, peak
// settled at +17.6%, mark drifted back to +11.6% over 8min. TO eventually
// forced exit into mark-real divergence (mark +11.6%, Jupiter quote -20%)
// → net -0.004 SOL on a trade that banked +0.001 at L1.
// No rule existed to cover the "peak is gone but SL hasn't hit" window.
// Between L1 (+17%) and SL (-10%) there's a 27pt no-man's-land where we
// just waited for TO and paid the mark-real divergence tax at exit.
//
// Fix: post-L1 (levels 1 and 2), track peak-since-activation. If current
// retracement from peak exceeds POST_L1_TRAIL_PCT AND peak was at least
// POST_L1_MIN_PEAK_PCT above entry (so we don't trail on flat positions),
// exit via trailing_stop. Tighter than L3's -10% because we already have
// L1/L2 profit locked — goal is to protect the bank, not ride moonshots.
const POST_L1_TRAIL_PCT = 25;       // L1 → L2 walks need room for volatility
const POST_L2_TRAIL_PCT = 12;       // Apr 22: tighter trail post-L2. L2→L3 is rare moonshot path;
                                     // Buy The Gloves (Apr 22) L2 at +49% → drained to -44% real on slice.
                                     // 12% retrace floor would have caught it near +43% mark before pool drain.
const POST_L1_MIN_PEAK_PCT = 5;     // don't trail if peak never broke +5% mark
const POST_L2_SIM_RECOVERY_FLOOR = 0.85; // L2-level sim recovery auto-close. Catches pool drainage
                                          // directly (not mark-based). Buy The Gloves had recovery
                                          // collapse 105% → 57% between polls; this floor fires first.
// Apr 22 PM — GRID_SIM_RECOVERY_FLOOR. Guard L1/L2 partial-sell triggers
// against PHANTOM PEAKS: DexScreener mark shows +15% (L1) or +40% (L2)
// but the pool can't honor it at our sell size. Ben Pasterneck (Apr 22)
// fired L1 at +31.4% mark; the 50% partial actually executed at -36%
// real vs cost basis because snipers + other copy-traders had already
// drained the pool. The mark peak existed in mid-price only, not at our
// 0.025 SOL slice size.
//
// Floor of 1.0 = only fire partial if Jupiter sim quote says we'd
// receive ≥ cost basis (real breakeven+) on the partial. If sim < 1.0,
// the mark gain is phantom — skip the partial, release DB grid_level
// claim, let position continue to CB/SL/TO/liquidity-drain exit paths.
//
// Trade-off: we lose the "lock phantom profit" case when pools are
// temporarily mispriced in our favor (rare). Gain: we stop booking
// -36% real on slices that mark says are +31% winners.
const GRID_SIM_RECOVERY_FLOOR = 1.0;
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

// Apr 22: L2 activation timestamps for the 3-min hold cap.
// When grid_level transitions to 2 on a trade, record Date.now(). If
// still at L2 after POST_L2_MAX_HOLD_MS without L3 activating, force
// close. Captures the "L2 spike → 2-3 min drift → lose gains" pattern.
// In-memory only — on swarm restart, trail + sim-floor + TO still catch
// stale L2 positions.
const l2ActivationTimes = new Map<string, number>();
const POST_L2_MAX_HOLD_MS = 3 * 60_000; // 3 min

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

    // Skip phantom pre-confirm rows: webhook inserted status=open but
    // executor hasn't confirmed the buy yet. A row is "confirmed" when
    // EITHER it has the [LIVE] tag OR entry_sol_cost is populated (the
    // executor writes both after parseSwapSolDelta resolves, so during
    // the brief window between those two writes entry_sol_cost is the
    // stronger signal that the buy landed).
    //
    // Previously the skip was bounded by age < 120s. After 120s, guard
    // would process phantoms — hitting the virtual-grid branch on price
    // pumps and writing fake grid_level / remaining_pct / partial_pnl
    // to the DB. If the buy then rescued (tokens late-land), the
    // re-opened row would start at grid_level=2 / remaining=25 and
    // skip L1+L2 — silent 75% mis-sizing on a real position. It also
    // let CB/SL fire on phantoms, flipping status=open→closed with
    // fake exit metadata. Caught in the SMB phantom pump-dump, Apr 20.
    if (!pos.wallet_tag?.includes("[LIVE]") && pos.entry_sol_cost == null) {
      continue;
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

            // Divergence alert for CASE A — the sibling of the alert on
            // the normal Jupiter-sell close path (~line 510). Mark here
            // is `closedPnl` (the blended partial_pnl % from prior
            // partials); compare to accumulated real SOL. If they drift
            // > 25% of entry cost, something anomalous happened
            // mid-trade — likely a liquidity-trap partial that locked
            // mark gains but bled real SOL.
            if (entryCost !== null && entryCost > 0) {
              const markEquivSol = (closedPnl / 100) * entryCost;
              const divergenceSol = Math.abs(existingPnl - markEquivSol);
              const divergencePct = divergenceSol / entryCost;
              if (divergencePct > 0.25) {
                const markSign = markEquivSol >= 0 ? "+" : "";
                const realSign = existingPnl >= 0 ? "+" : "";
                void sendAlert(
                  "divergence_warning",
                  `${coinLabel} (zero-balance close) mark/real divergence ${(divergencePct * 100).toFixed(1)}% of entry — mark ${markSign}${markEquivSol.toFixed(4)} SOL vs real ${realSign}${existingPnl.toFixed(4)} SOL`
                );
              }
            }
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
        // skipJito=true: guard exits go direct RPC (auto priority) to
        // avoid the 60-90s Jito bundle poll that eats 20-50pp of fill
        // on memecoin exits during volatile pumps (Sprint 10 Phase 5).
        const entryCostForSim = pos.entry_sol_cost != null ? Number(pos.entry_sol_cost) : undefined;
        const sig = await sellToken(pos.coin_address, {
          entrySolCost: entryCostForSim,
          exitReason,
          skipJito: true,
          remainingPct, // Apr 21: sim-gate needs proportional cost basis
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
            // Apr 22 fix: write sell_tx_sig IMMEDIATELY, don't block on
            // parseSwapSolDelta. IXCOIN (Apr 22) was a phantom-closed row
            // because the RPC was flaky → parseSwapSolDelta returned null
            // → function exited before writing sell_tx_sig → row was
            // status='closed' / exit_reason='stop_loss' / sell_tx_sig=null.
            // Now sell_tx_sig is recorded first so we can always reconcile
            // real_pnl_sol later (via find-missing-sell.ts or a retry).
            try {
              await supabase
                .from("trades")
                .update({ sell_tx_sig: sig })
                .eq("id", pos.id);
            } catch (err: any) {
              console.error(`  [GUARD] sell_tx_sig write failed: ${err.message}`);
            }

            // Retry parseSwapSolDelta up to 3 times with backoff before
            // giving up on real_pnl_sol. Transient RPC failures shouldn't
            // lose accounting.
            let solReceived: number | null = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
              solReceived = await parseSwapSolDelta(sig);
              if (solReceived !== null) break;
              if (attempt < 3) {
                await new Promise((r) => setTimeout(r, 2_000 * attempt));
              }
            }
            if (solReceived === null) {
              console.warn(`  [GUARD] ⚠️ parseSwapSolDelta failed 3x for ${sig} — real_pnl_sol left null for reconcile`);
              return;
            }
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
                  ...(realPnlSol !== null ? { real_pnl_sol: realPnlSol } : {}),
                })
                .eq("id", pos.id);
              if (realPnlSol !== null) {
                console.log(
                  `  [GUARD] 📊 real PnL: ${realPnlSol >= 0 ? "+" : ""}${realPnlSol.toFixed(6)} SOL (final sell ${solReceived.toFixed(6)} − cost basis ${finalSellCostBasis!.toFixed(6)} = ${finalSellPnl! >= 0 ? "+" : ""}${finalSellPnl!.toFixed(6)}; prior partials: ${existingPnl >= 0 ? "+" : ""}${existingPnl.toFixed(6)})`
                );

                // Mark vs real divergence alert. finalPnl is the mark-
                // based percentage passed into closeTrade (partialPnl +
                // (pnlPct * remainingPct)/100). Convert to SOL via
                // entry_sol_cost and compare to on-chain real_pnl_sol.
                // If they differ by > 25% of entry cost, something is
                // off (liquidity drain, pool imbalance, AMM divergence
                // from DexScreener mid) — surface it in Telegram for
                // real-time pattern catching instead of log review.
                if (entryCost !== null && entryCost > 0) {
                  const markEquivSol = (finalPnl / 100) * entryCost;
                  const divergenceSol = Math.abs(realPnlSol - markEquivSol);
                  const divergencePct = divergenceSol / entryCost;
                  if (divergencePct > 0.25) {
                    const markSign = markEquivSol >= 0 ? "+" : "";
                    const realSign = realPnlSol >= 0 ? "+" : "";
                    void sendAlert(
                      "divergence_warning",
                      `${coinLabel} mark/real divergence ${(divergencePct * 100).toFixed(1)}% of entry — mark ${markSign}${markEquivSol.toFixed(4)} SOL vs real ${realSign}${realPnlSol.toFixed(4)} SOL (${exitReason})`
                    );
                  }
                }
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
            // Partial-size salvage (Apr 21): Openhuman + John Apple both
            // hit full-ladder 6024 because the pool had drained below
            // Jupiter's quoted min-out at our full-balance size. Thin
            // pools frequently take SMALLER orders even when full-size
            // 6024's. Try one last-ditch 25% chunk at rescue slippage;
            // any recovered SOL books to real_pnl_sol and reduces the
            // remainder that gets marked to zero.
            console.log(
              `  [GUARD] 🆘 ${coinLabel} full-size 6024 — trying 25% partial-size salvage at max slippage...`
            );
            const salvageSig = await sellToken(pos.coin_address, {
              entrySolCost: entryCostForSim,
              exitReason,
              skipJito: true,
              sellPercent: 25,
              remainingPct, // Apr 21: sim-gate needs proportional cost basis
            });
            if (salvageSig) {
              const rescuedSol = await parseSwapSolDelta(salvageSig);
              const { data: salvRow } = await supabase
                .from("trades")
                .select("entry_sol_cost, real_pnl_sol")
                .eq("id", pos.id)
                .maybeSingle();
              const salvEntryCost = salvRow?.entry_sol_cost ? Number(salvRow.entry_sol_cost) : null;
              const salvExisting = salvRow?.real_pnl_sol != null ? Number(salvRow.real_pnl_sol) : 0;
              if (rescuedSol !== null && salvEntryCost !== null) {
                // 25% of the CURRENT remainder was sold. Cost basis:
                //   entryCost × (remainingPct/100) × 0.25
                const salvCostBasis = salvEntryCost * (remainingPct / 100) * 0.25;
                const salvPnl = rescuedSol - salvCostBasis;
                const newRealPnl = salvExisting + salvPnl;
                const newRemainingPct = remainingPct * 0.75;
                console.log(
                  `  [GUARD] 🆘 salvage recovered ${rescuedSol.toFixed(6)} SOL on 25% slice (cost ${salvCostBasis.toFixed(6)}): ${salvPnl >= 0 ? "+" : ""}${salvPnl.toFixed(6)}. Remaining ${newRemainingPct.toFixed(1)}% → mark-to-zero.`
                );
                await supabase
                  .from("trades")
                  .update({
                    real_pnl_sol: newRealPnl,
                    remaining_pct: newRemainingPct,
                    sell_tx_sig: salvageSig,
                  })
                  .eq("id", pos.id);
                remainingPct = newRemainingPct;
              }
            } else {
              console.log(
                `  [GUARD] 🆘 ${coinLabel} 25% salvage also failed — mark-to-zero full remaining`
              );
            }

            // (a) mark-to-zero close (on remaining, possibly reduced by salvage)
            const zeroPnlPct = (pos.partial_pnl ?? 0) + (-100 * remainingPct) / 100;
            console.log(
              `  [GUARD] 🪦 ${coinLabel} un-sellable (Jupiter 6024) — marking remaining ${remainingPct.toFixed(1)}% to zero. Final mark ${zeroPnlPct.toFixed(2)}%`
            );

            // Unified accounting (Apr 21): book the loss on the
            // unsellable remainder regardless of gridLvl. existingPnl
            // covers both prior L1/L2 partials AND any salvage recovery
            // from the block above. Cost basis = entryCost × remainingPct / 100.
            // Old L0 branch blindly wrote -entryCost which would clobber
            // salvage credit.
            let realPnlSolUpdate: number | null = null;
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
                `  [GUARD] 📊 unsellable L${gridLvl} — booking loss on remaining ${remainingPct.toFixed(1)}% (cost ${remainingCostBasis.toFixed(6)}): ${existingPnl >= 0 ? "+" : ""}${existingPnl.toFixed(6)} − ${remainingCostBasis.toFixed(6)} = ${realPnlSolUpdate >= 0 ? "+" : ""}${realPnlSolUpdate.toFixed(6)} SOL`
              );
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
    // Only runs for [LIVE]-tagged positions (pre-confirm phantoms are
    // already filtered out upstream) and cooldowns to 60s per position
    // so we don't hammer RPC.
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

    // 0d. Liquidity drainage monitor — runs in parallel with the holder
    // exodus check but catches a different class of rug: whale pulling LP
    // without their address appearing in a top-20 holder diff. Fetches
    // current token balance + Jupiter quote for a full-bag sell at 5%
    // slippage. If the quoted SOL out divided by entry cost drops below
    // LIQUIDITY_DROP_THRESHOLD, the pool is effectively drained — exit
    // now even if the mark (DexScreener mid) still reads positive.
    //
    // Per-position 60s cooldown. Fail-open on any quote / balance null
    // result (transient Jupiter / Helius errors must not force exits).
    // Only runs for [LIVE]-tagged positions with entry_sol_cost set.
    if (pos.wallet_tag?.includes("[LIVE]") && pos.entry_sol_cost != null) {
      const liqSnap = liquiditySnapshots.get(pos.id);
      const nowMs = Date.now();
      if (!liqSnap || nowMs - liqSnap.lastCheckMs >= LIQUIDITY_CHECK_INTERVAL_MS) {
        const recovery = await simulateSellRecovery(pos.coin_address, Number(pos.entry_sol_cost), remainingPct);
        liquiditySnapshots.set(pos.id, { lastCheckMs: nowMs });
        if (recovery !== null) {
          console.log(
            `  [GUARD] [LIQUIDITY] ${coinLabel} sim sell recovery ${(recovery * 100).toFixed(1)}% of entry`
          );
          if (recovery < LIQUIDITY_DROP_THRESHOLD) {
            const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
            console.log(
              `  [GUARD] 🩸 ${coinLabel} liquidity drained — quoted full-bag sell recovers ${(recovery * 100).toFixed(1)}% of entry (< ${(LIQUIDITY_DROP_THRESHOLD * 100).toFixed(0)}% floor). Emergency exit before it hits zero.`
            );
            await closeTrade(finalPnl, "pool_drain", currentLevel);
            liquiditySnapshots.delete(pos.id);
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
        // Atomic DB claim BEFORE sellToken. Guards against the same-
        // session stale-read race: the two setIntervals (L0 2s / L1+ 5s)
        // can each read pos.grid_level=0 from DB before the first
        // partial's sync write commits. The in-memory gridSellingPositions
        // lock blocks CONCURRENT grid loops, but once poll A releases
        // (after its grid loop break), poll B — which had been running
        // its non-grid checks (CB/whale/SL/TO) in parallel with its own
        // stale pos — reaches the grid gate, sees the lock released,
        // and fires L1 again with its stale currentLevel=0.
        //
        // The .lt("grid_level", grid.level) clause means Postgres only
        // applies the update if the current value is less than our
        // intended level. If A already wrote grid_level=1, our claim
        // for L1 fails (0 rows), we abort before wasting a Jupiter sell.
        //
        // Caught in 'I saw this and created this' (Apr 20 overnight):
        // mark said +36% winner, book said -14% loser because L1 fired
        // twice and the second one ran the 50% cost-basis math against
        // a sell that was actually 25% of the original bag.
        const { data: claimed } = await supabase
          .from("trades")
          .update({ grid_level: grid.level })
          .eq("id", pos.id)
          .lt("grid_level", grid.level)
          .select("id")
          .maybeSingle();
        if (!claimed) {
          console.log(
            `  [GUARD] [GRID L${grid.level}] ${coinLabel} skip — DB grid_level already >= ${grid.level} (parallel poll claimed). Breaking loop.`
          );
          break;
        }

        // PHANTOM PEAK GATE — only fire grid partial if Jupiter sim says
        // real breakeven+ is actually available. If mark shows +15%/+40%
        // but sim shows we'd receive < cost basis on the slice, the mark
        // gain is phantom (pool drained by snipers/copy-traders before
        // we could exit). Skip the partial, release the DB claim, let
        // CB/SL/TO/liquidity-drain handle the exit. Ben Pasterneck (Apr
        // 22) fired L1 at +31.4% mark but executed at -36% real on the
        // 50% slice; this gate would have prevented that phantom lock-in.
        //
        // Apr 23 AM race-fix: Enrique L1 fired with NO sim check because
        // pos.entry_sol_cost was still null on the first guard poll after
        // entry (executor's DB write hadn't synced yet). L2 fired ~3 min
        // later with entry_sol_cost populated and sim check running fine.
        // Fallback: if null, use LIVE_BUY_SOL * 1.2 as a conservative
        // UPPER bound on real cost (typical slippage + fees is 8-20%).
        // Higher cost in the denominator → LOWER recovery ratio → STRICTER
        // gate. Better to occasionally over-reject than to fire L1 blind.
        const costBasisForSim = pos.entry_sol_cost != null
          ? Number(pos.entry_sol_cost)
          : LIVE_BUY_SOL * 1.2;
        const gridRecovery = await simulateSellRecovery(
          pos.coin_address,
          costBasisForSim,
          remainingPct
        );
        if (gridRecovery !== null && gridRecovery < GRID_SIM_RECOVERY_FLOOR) {
          console.log(
            `  [GUARD] [GRID L${grid.level}] ${coinLabel} 🧿 PHANTOM PEAK — mark +${pnlPct.toFixed(1)}% but sim recovery ${(gridRecovery * 100).toFixed(1)}% < ${(GRID_SIM_RECOVERY_FLOOR * 100).toFixed(0)}% floor. Pool can't honor mark at our size. Skipping partial, reverting DB claim.`
          );
          await supabase
            .from("trades")
            .update({ grid_level: currentLevel })
            .eq("id", pos.id);
          break;
        }
        console.log(
          `  [GUARD] [GRID L${grid.level}] ${coinLabel} sim recovery ${gridRecovery === null ? "NULL" : (gridRecovery * 100).toFixed(1) + "%"}${pos.entry_sol_cost == null ? " (fallback cost basis)" : ""} — proceeding with partial`
        );

        console.log(
          `  [GUARD] [GRID L${grid.level}] ${coinLabel} triggered at +${pnlPct.toFixed(1)}% — selling ${sellPctOfCurrent.toFixed(1)}% of current balance via Jupiter (slot claimed)`
        );
        const partialSig = await sellToken(pos.coin_address, {
          sellPercent: sellPctOfCurrent,
          // No entrySolCost/exitReason — grid is voluntary take-profit,
          // never hits the sim-abort floor.
          // skipJito=true: grid partials are the most time-critical
          // exits in the book (take-profit on pumps reverses fast).
          // 60-90s Jito poll cost is worth ~20-50pp of fill; MEV
          // sandwich on a sell is worth ~1-3%. Net win (Phase 5).
          skipJito: true,
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
            `  [GUARD] [GRID L${grid.level}] ${coinLabel} tokens still held — Jupiter issue, reverting grid_level claim, will retry next poll`
          );
          // Revert the atomic claim so the next poll can retry this level.
          // Gated on grid_level=grid.level so we don't clobber a parallel
          // successful advance (shouldn't happen given the lock, but defensive).
          await supabase
            .from("trades")
            .update({ grid_level: currentLevel })
            .eq("id", pos.id)
            .eq("grid_level", grid.level);
          break; // don't advance grid_level; next poll retries
        }

        console.log(
          `  [GUARD] [GRID L${grid.level}] ${coinLabel} partial sold: ${partialSig}`
        );

        // Apr 22: record L2 activation time for the 3-min hold cap.
        // When L2 fires, we start the clock. If position still at L2
        // after POST_L2_MAX_HOLD_MS, the time-limit check below force-
        // closes it (captures the "L2 spike → drift → lose gains"
        // pattern where L3 doesn't activate in time).
        if (grid.level === 2) {
          l2ActivationTimes.set(pos.id, Date.now());
        }

        // PERSIST remaining_pct + partial_pnl immediately after the sell
        // lands. grid_level was ALREADY committed by the atomic claim
        // above, which serves double duty: (a) prevents the same-session
        // stale-read duplicate-L1 race, and (b) closes the original
        // KICAU-class restart race (sync write before background
        // real_pnl_sol writer).
        const newPartialPnlAfter = partialPnl + (grid.pct * grid.sellPct) / 100;
        const newRemainingPctAfter = remainingPct - grid.sellPct;
        try {
          await supabase
            .from("trades")
            .update({
              remaining_pct: newRemainingPctAfter,
              partial_pnl: newPartialPnlAfter,
            })
            .eq("id", pos.id);
        } catch (err: any) {
          // A failure to persist grid state here is serious — the
          // sell landed but the DB doesn't know. Log loudly so the
          // operator can reconcile. Don't throw (would skip lock
          // release); let the loop continue and the post-loop write
          // try again.
          console.error(
            `  [GUARD] 🚨 L${grid.level} ${coinLabel} grid-state write failed: ${err.message}. Sig ${partialSig}. Will retry at end-of-loop.`
          );
        }

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

    // 5c. Post-L1 / Post-L2 retracement trail (Apr 21 + Apr 22 tightened).
    //     Protects L1/L2 partials from the mark-real divergence tax at
    //     TO close. Level-specific threshold:
    //       L1: 25% retrace (L1→L2 walks need volatility room)
    //       L2: 12% retrace (L2→L3 is moonshot-rare, protect gains fast)
    //     L3 has its own -10% trail (5b above), no overlap.
    if ((newLevel === 1 || newLevel === 2) && remainingPct > 0 && !priceFetchFailed && entryPrice > 0) {
      let peakL1 = trailingPeaks.get(pos.id);
      if (peakL1 === undefined || currentPrice > peakL1) {
        peakL1 = currentPrice;
        trailingPeaks.set(pos.id, peakL1);
      }
      const peakPnlPct = ((peakL1 - entryPrice) / entryPrice) * 100;
      const retracePct = ((currentPrice - peakL1) / peakL1) * 100;
      const trailPct = newLevel === 2 ? POST_L2_TRAIL_PCT : POST_L1_TRAIL_PCT;
      if (peakPnlPct >= POST_L1_MIN_PEAK_PCT && retracePct <= -trailPct) {
        const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
        console.log(
          `  [GUARD] [POST-L${newLevel} TRAIL] ${coinLabel} peak +${peakPnlPct.toFixed(1)}% → now +${pnlPct.toFixed(1)}% (retrace ${retracePct.toFixed(1)}% exceeds -${trailPct}%) — exit before TO divergence tax`
        );
        await closeTrade(finalPnl, "trailing_stop", newLevel);
        trailingPeaks.delete(pos.id);
        continue;
      }
    }

    // 5d.1. Post-L2 time cap (Apr 22, user-reported pattern).
    //     "L2 spike takes 2-3 min for L3 to trigger, then L2 goes down
    //     and we lose money." Hard cap on L2 holds. If 3 min pass since
    //     L2 fire and mark hasn't pushed past +80% (halfway to L3),
    //     force-close. Captures the drift scenario where the pump
    //     stalled out. L2-zone gains get locked before they evaporate.
    //
    //     Moonshot protection: if mark > +80%, we're clearly still in
    //     a strong move → let trail or L3 catch it.
    if (newLevel === 2 && remainingPct > 0 && !priceFetchFailed) {
      const l2ActiveAt = l2ActivationTimes.get(pos.id);
      if (l2ActiveAt !== undefined) {
        const elapsedMs = Date.now() - l2ActiveAt;
        if (elapsedMs >= POST_L2_MAX_HOLD_MS && pnlPct < 80) {
          const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
          console.log(
            `  [GUARD] [POST-L2 TIME CAP] ${coinLabel} ${(elapsedMs / 60000).toFixed(1)}min since L2 fired, mark +${pnlPct.toFixed(1)}% (< +80% moonshot threshold) — force close before L2 gains drift away`
          );
          await closeTrade(finalPnl, "trailing_stop", newLevel);
          l2ActivationTimes.delete(pos.id);
          trailingPeaks.delete(pos.id);
          continue;
        }
      }
    }

    // 5d. Post-L2 sim-recovery safety net (Apr 22, Buy The Gloves class).
    //     Even if mark is still green, if Jupiter's actual sell quote on
    //     the remaining slice drops below POST_L2_SIM_RECOVERY_FLOOR,
    //     pool is draining. Exit NOW on sim signal, not mark. Catches
    //     the exact scenario where liquidity collapsed 105% → 57%
    //     between polls on Buy The Gloves and we ate -44% real on the
    //     slice despite +29% mark.
    //
    //     Only at L2 (where the slice is small enough the floor makes
    //     sense). L1 still uses the 40% drain monitor (earlier block).
    if (newLevel === 2 && remainingPct > 0 && pos.wallet_tag?.includes("[LIVE]") && pos.entry_sol_cost != null) {
      const liqSnap = liquiditySnapshots.get(pos.id);
      const nowMs = Date.now();
      if (!liqSnap || nowMs - liqSnap.lastCheckMs >= LIQUIDITY_CHECK_INTERVAL_MS) {
        const l2Recovery = await simulateSellRecovery(pos.coin_address, Number(pos.entry_sol_cost), remainingPct);
        liquiditySnapshots.set(pos.id, { lastCheckMs: nowMs });
        if (l2Recovery !== null) {
          console.log(
            `  [GUARD] [L2 SIM-NET] ${coinLabel} sim recovery ${(l2Recovery * 100).toFixed(1)}% on remaining ${remainingPct}% slice`
          );
          if (l2Recovery < POST_L2_SIM_RECOVERY_FLOOR) {
            const finalPnl = partialPnl + (pnlPct * remainingPct) / 100;
            console.log(
              `  [GUARD] 🩸 ${coinLabel} POST-L2 sim recovery ${(l2Recovery * 100).toFixed(1)}% < ${(POST_L2_SIM_RECOVERY_FLOOR * 100).toFixed(0)}% floor — pool drain, exit now (mark +${pnlPct.toFixed(1)}%)`
            );
            await closeTrade(finalPnl, "pool_drain", newLevel);
            liquiditySnapshots.delete(pos.id);
            trailingPeaks.delete(pos.id);
            continue;
          }
        }
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
