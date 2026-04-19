/**
 * PixiuBot — Smart Money Configuration
 * Shared between webhook (entry) and risk-guard (exits).
 */

// Tier 1 Smart Money wallet ADDRESSES — entry requires 1 of these
export const TOP_ELITE_ADDRESSES = new Set([
  "CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o", // Cented
  "8deJ9xeUvXSJwicYptA9mHsU2rN2pDx37KWzkDkEXhU6", // Cooker
  "J3Ez1WjZMpcnMua4xA9nirZwWTurAxY7wqhm4vPeJ8k5", // GMGN_SM_2 90% WR
  "4gyFNL92hgMZUb87Nv4BgfasYTZ247M2GSf8d2LS1Q99", // GMGN_FW_1 95% WR
  "5BGiLEfrrrAHPdjomZXhXk8mu36xgSdoV38BPxwkB3mz", // GMGN_FW_2 100% WR
  "4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk", // Jijo 55% WR
  "G45wKGBuuHbfh2tkkNhWchfFquLM1DQ7xKs3VfygXQ5F", // GMGN_FW_3 93% WR
  "Hrk1f2nEMme9tDY5yro4itW9cN7P8K7PKyReGatf5zRb", // GMGN_FW_4 85% WR
  "78N177fzNJpp8pG49xDv1efYcTMSzo9tPTKEA9mAVkh2", // Sheep 64% WR (GMGN #2)
  "DjM7Tu7whh6P3pGVBfDzwXAx2zaw51GJWrJE3PwtuN7s", // LUKEY 94% WR (Kolscan #28)
  "2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f", // Cupsey 56% WR (GMGN #3)
  "J7GR6XoJfCPwZumW9xZ1nbWkyaq1oYSQuSVmCdBTx6Nf", // GMGN_T1_1
  "JESUSL2s5BsffGNNn6wQtHART2iXVGjtGhKAwGw44bL", // GMGN_T1_2
  "8hfoNZCd2bK9aqCBkhg8f2L1AoL7qfHwd9tMv7x64qui", // GMGN_T1_3
]);

// Entry filters
export const MAX_GAP_MINUTES = 30;
export const MAX_ENTRY_MC = 100_000;
export const RECENTLY_TRADED_COOLDOWN_MS = 120 * 60_000; // 120 min — same coin_address
// Same-name cooldown is shorter because a different mint sharing a name is
// often a fresh launch (not the same rug). 30min prevents immediate re-buy
// of an obvious clone while still letting legitimate launches through.
export const RECENT_NAME_COOLDOWN_MS = 30 * 60_000; // 30 min — same coin_name
export const POSITION_SIZE_PCT = 0.01; // 1% of bankroll

// ─── Live trading sizing & risk caps ───────────────────
// SINGLE SOURCE OF TRUTH — do not redeclare in agents.
// Real exposure per trade is LIVE_BUY_SOL.
// DAILY_LOSS_LIMIT_SOL is the cap on REAL SOL lost (not trade count × size).
// The counter in risk-guard.ts / trade-executor.ts sums
//   LIVE_BUY_SOL × |pnl_pct| / 100
// across losing LIVE trades since midnight UTC. pnl_pct reflects the blended
// outcome across grid partials, so locked L1/L2 profits correctly reduce
// the contribution to the daily loss total.
export const LIVE_BUY_SOL = 0.05;
// Tightened Apr 18 PM — wallet down to ~0.82 SOL, 2.0 cap was wider than
// the bag. 0.25 SOL caps overnight bleed at ~5 losing trades worth.
export const DAILY_LOSS_LIMIT_SOL = 0.50;

// Sprint 10 Phase 2 — entry filter: token age at entry.
// Postmortem 2026-04-19 showed <5min-old tokens had 31.8% WR / -0.20 SOL,
// while >6h-old had 50% WR / +0.075 SOL. Skipping freshest tokens should
// tilt the distribution away from the biggest loss bucket.
export const MIN_TOKEN_AGE_MINUTES = 30;

// Sprint 10 Phase 2 — entry filter: co-buyer ceiling.
// Postmortem 2026-04-19 fat-tail isolation: both big winners (agent +238%,
// Asteroid +101%) had exactly 1 distinct co-buyer within ±5min — LONE WOLF
// entries. Clustered multi-wallet buys were anti-selecting; those tokens
// get pumped then dumped as the cluster exits together. If >1 distinct
// wallet has signaled BUY on the same mint within the last 5min, skip.
// Loosened 1 → 2 on 2026-04-19 after 40+ min drought with zero FILTER PASS.
// Original (≤1) meant only "lone wolf" — just the followed wallet, no cluster.
// On pump.fun most signals have at least one other followed wallet co-buying
// within seconds, so ≤1 filtered ~everything. ≤2 still blocks the 3+ wallet
// pump clusters that anti-selected fat-tail winners in postmortem.
export const MAX_CO_BUYERS_5MIN = 2;

// Late-confirm window for Jupiter buys (Bug P1).
// After a buy is marked "failed", check on-chain again after this delay —
// if the wallet now holds the token, the buy actually landed late.
export const BUY_RESCUE_DELAY_MS = 3 * 60_000; // 3 min
