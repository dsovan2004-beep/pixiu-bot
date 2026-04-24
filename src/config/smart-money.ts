/**
 * PixiuBot — Smart Money Configuration
 * Shared between webhook (entry) and risk-guard (exits).
 */

// Wallet blacklist — primary signalers permanently banned from entry
// based on postmortem data (2026-04-21). These wallets had ≥5 trades
// with WR < 35% AND/OR net negative SOL contribution on the bot's live
// entries. Blacklist overrides tier-manager auto-promotion: even if
// these wallets hit a 65% WR in a 7-day window and get auto-promoted
// to T1, guard #10a still rejects their primary-signal entries.
// Individual lines can be commented out to unban one wallet without
// disturbing the rest (rollback path).
//
// Sample: 114 closed LIVE trades, 27.2% WR, -0.59 SOL net.
// Removing these 9 wallets would have swung the sample to 29.2% WR,
// -0.13 SOL net — i.e. +0.46 SOL of loss contribution eliminated.
//
// Re-run `src/scripts/wallet-postmortem.ts` every ~30 new closed
// trades or when session PnL crosses -0.20 SOL to catch new bleeders.
export const WALLET_BLACKLIST = new Set([
  "6Dt9J7TXM3eqyQBAZMbGJCV6VsP13WVStwPJnLPFtw2Y", // GMGN_SM_5 — 12 trades, 25% WR, -0.076 SOL
  "4sAUSQFdvWRBxR8UoLBYbw8CcXuwXWxnN8pXa4mtm5nU", // Scharo — 7 trades, 14% WR, -0.073 SOL
  "CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o", // cented — 8 trades, 25% WR, -0.070 SOL (overrides TOP_ELITE)
  "6TAHDM5Tod7dBTZdYQxzgJZKxxPfiNV9udPHMiUNumyK", // Bluey — 6 trades, 0% WR, -0.066 SOL
  "8GrjsuPip1xVDMjyVcVrG1wnM9Rutv7fdoxqtRBaymHc", // bandit (addr 1) — 8 trades, 38% WR, -0.063 SOL
  "5B79fMkcFeRTiwm7ehsZsFiKsC7m7n1Bgv9yLxPp9q2X", // bandit (addr 2) — DB duplicate entry, blacklist both
  "4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9", // decu — 7 trades, 29% WR, -0.031 SOL
  "Be24Gbf5KisDk1LcWWZsBn8dvB816By7YzYF5zWZnRR6", // chair — 5 trades, 40% WR, -0.028 SOL
  "A3W8psibkTUvjxs4LRscbnjux6TFDXdvD4m4GsGpQ2KJ", // Numer0 — 5 trades, 40% WR, -0.016 SOL
  // RE-BLACKLISTED Apr 22 (3h after unblacklist): Cupsey post-unblacklist
  // went 0/3 (Heroic Warrior -0.003, boobcoin #1 -0.008, boobcoin #2 -0.003
  // = -0.014 SOL). Lifetime now 11 trades, NET NEGATIVE. The +0.149 Claude
  // Spritzer win was survivorship, not reproducible edge. Re-blacklisting
  // per the current rule (net-negative = CUT).
  "2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f", // Cupsey
  "EQaxqKT3N981QBmdSUGNzAGK5S26zUwAdRHhBCgn87zD", // jamessmith — 6 trades, 50% WR, -0.015 SOL. CLEAR DUMP PATTERN: signals BUY → sells → copy-traders bagholder. Observed Apr 22: Surprised Pikachu -0.015, CloudCoin -0.006 both within minutes of his SELL.
  // ─── Apr 22 PM postmortem (140-trade sample, reconciled): ───
  "Hw5UKBU5k3YudnGwaykj5E8cYUidNMPuEewRRar5Xoc7", // Trenchman — 5 trades, 0% WR, -0.092 SOL (worst remaining)
  "J9TYAsWWidbrcZybmLSfrLzryANf4CgJBLdvwdGuC8MB", // Johnson — 5 trades, 20% WR, -0.019 SOL
  "PMJA8UQDyWTFw2Smhyp9jGA6aTaP7jKHR7BPudrgyYN",  // chester (addr 1) — 3 trades, 0% WR, -0.072 SOL (preemptive at 3-trade sample, 0% signal is unambiguous)
  "8NJ7Ujpji8uMF2675mqaTSEm2DCbfJA7fiRKtiaqkaLN", // chester (addr 2) — DB duplicate
  "5t9xBNuDdGTGpjaPTx6hKd7sdRJbvtKS8Mhq6qVbo8Qz", // SmokezXBT — 3 trades, 0% WR, -0.042 SOL (preemptive, same reason)
  "sAdNbe1cKNMDqDsa4npB3TfL62T14uAo2MsUQfLvzLT",  // pr6spr — 1 trade, -0.052 SOL (single massive loss — preemptive ban vs risk another -0.05)
  // ─── Apr 24 postmortem (167 closed trades): stale TOP_ELITE labels didn't ───
  // ─── match real performance. Net-negative wallets with ≥5 trades cut. ───
  "4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk", // Jijo — 7 trades, 28.6% WR, -0.041 SOL (labeled "55% WR" in old TOP_ELITE — real WR half that; also REMOVED from TOP_ELITE below)
  "78N177fzNJpp8pG49xDv1efYcTMSzo9tPTKEA9mAVkh2", // Sheep — 5 trades, 20% WR, -0.008 SOL (labeled "64% WR" GMGN#2; real WR 20%; also REMOVED from TOP_ELITE below)
  "4uCT4g7YHH4xxfmfNfKUDenwGrRNGoZ9Ay1XFxfUGhQG", // pump sad esee — 6 trades, 50% WR, -0.010 SOL (net-negative even at 50% WR: losers are 1.5x bigger than winners)
]);

// Blacklisted wallet TAGS (for cross-referencing coin_signals which stores
// wallet_tag, not wallet_address). Keep in sync with WALLET_BLACKLIST above.
// Used by the dump-pattern filter in trade-executor.ts: if a coin has recent
// signal activity from these tags, the coin is being pumped+dumped and we
// skip even if primary signaler is legit. chloe (Apr 24) lost -0.005 SOL
// because GMGN_SM_4+Trenchman+jamessmith spam-traded it 40+ times in the
// hour before GMGN_T1_1 (legit) signaled buy; our co-buyer filter only
// looked at a 5min window and missed the broader dump pattern.
export const WALLET_BLACKLIST_TAGS = new Set<string>([
  "GMGN_SM_5",
  "Scharo",
  "cented",
  "Bluey",
  "bandit",
  "decu",
  "chair",
  "Numer0",
  "Cupsey",
  "jamessmith",
  "Trenchman",
  "Johnson",
  "chester",
  "SmokezXBT",
  "pr6spr",
  "jijo",        // Apr 24 cut — stale "55% WR" label
  "Sheep",       // Apr 24 cut — stale "64% WR" label
  "pump sad esee", // Apr 24 cut — 50% WR but net-negative
  // GMGN_SM_4 is NOT explicitly blacklisted yet but spams dump patterns —
  // add here because its signal density in a coin is a strong negative signal
  // even if it's not a permanent primary-signaler ban.
  "GMGN_SM_4",
]);

// Dump-pattern filter: if ≥ this many signals (any BUY/SELL) from blacklisted
// wallet tags in the last DUMP_PATTERN_WINDOW_MS on the target coin, skip.
// Chloe had 40+ blacklist-tag signals; even a floor of 3 would block it.
export const DUMP_PATTERN_MIN_SIGNALS = 3;
export const DUMP_PATTERN_WINDOW_MS = 15 * 60_000; // 15 min

// ─── Elite wallet sizing (Apr 24) ───
// Wallets that have proven net-positive over ≥ 5 trades get 2x size. The
// ONLY way to scale profitable wallets without waiting weeks for compounding
// at 0.025 is to increase per-trade exposure on the signals that actually
// make money. Size 2x losses too, but at the observed edge (+0.014 SOL/trade
// for theo pump sad, +0.002 SOL/trade for daniww), EV scales linearly.
//
// Gate: primary wallet tag must match. Secondary/co-buyer signalers don't
// trigger the upgrade — only when the elite wallet is the FIRST signaler.
//
// Risk envelope: DAILY_LOSS_LIMIT_SOL = 0.50 still caps overnight bleed.
// At 0.05 size, ~10 losing trades worth = within cap.
export const ELITE_WALLET_TAGS = new Set<string>([
  "theo pump sad", // +0.0993 SOL / 7 trades / 42.9% WR — most consistent
  "daniww",        // +0.0376 SOL / 17 trades / biggest win +0.1241 fat tail
]);
export const ELITE_BUY_SOL = 0.05; // 2x LIVE_BUY_SOL

// Extract the primary (first) wallet tag from "wallet_tag" which may look
// like "daniww+Zrool [LIVE]" or just "theo pump sad".
export function getPrimaryWalletTag(walletTag: string | null | undefined): string {
  if (!walletTag) return "";
  const noSuffix = walletTag.replace(/\s*\[[^\]]*\]\s*$/, "");
  return noSuffix.split("+")[0].trim();
}

// Resolve the correct buy size for a given signaler.
export function getBuySolForWalletTag(walletTag: string | null | undefined): number {
  const primary = getPrimaryWalletTag(walletTag);
  return ELITE_WALLET_TAGS.has(primary) ? ELITE_BUY_SOL : LIVE_BUY_SOL;
}

// Tier 1 Smart Money wallet ADDRESSES — entry requires 1 of these.
// WR labels on external names (GMGN/Kolscan) are STALE — do not trust them
// as entry justification. Only live-trade real_pnl_sol matters. Apr 24
// postmortem cut Jijo (real 28.6% WR, -0.041) and Sheep (real 20% WR,
// -0.008) despite their "55% WR" and "64% WR" external labels.
export const TOP_ELITE_ADDRESSES = new Set([
  "CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o", // Cented (note: also blacklisted — TOP_ELITE membership preserved for historical clarity but guard #10a rejects)
  "8deJ9xeUvXSJwicYptA9mHsU2rN2pDx37KWzkDkEXhU6", // Cooker
  "J3Ez1WjZMpcnMua4xA9nirZwWTurAxY7wqhm4vPeJ8k5", // GMGN_SM_2
  "4gyFNL92hgMZUb87Nv4BgfasYTZ247M2GSf8d2LS1Q99", // GMGN_FW_1
  "5BGiLEfrrrAHPdjomZXhXk8mu36xgSdoV38BPxwkB3mz", // GMGN_FW_2
  "G45wKGBuuHbfh2tkkNhWchfFquLM1DQ7xKs3VfygXQ5F", // GMGN_FW_3
  "Hrk1f2nEMme9tDY5yro4itW9cN7P8K7PKyReGatf5zRb", // GMGN_FW_4
  "DjM7Tu7whh6P3pGVBfDzwXAx2zaw51GJWrJE3PwtuN7s", // LUKEY
  "2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f", // Cupsey (note: also blacklisted)
  "J7GR6XoJfCPwZumW9xZ1nbWkyaq1oYSQuSVmCdBTx6Nf", // GMGN_T1_1
  "JESUSL2s5BsffGNNn6wQtHART2iXVGjtGhKAwGw44bL", // GMGN_T1_2
  "8hfoNZCd2bK9aqCBkhg8f2L1AoL7qfHwd9tMv7x64qui", // GMGN_T1_3
  // ─── Apr 24 PROMOTIONS — real live-trade winners ───
  // theo pump sad: 7 trades, 42.9% WR, +0.0993 SOL net, biggest win +0.0815.
  // MOST CONSISTENT PROFITABLE SIGNAL SOURCE in the book. Permanent T1
  // to prevent tier-manager from demoting on a temporary losing streak.
  "Bi4rd5FH5bYEN8scZ7wevxNZyNmKHdaBcvewdPFxYdLt", // theo pump sad — +0.0993 SOL, 42.9% WR
  // daniww: 17 trades, 23.5% WR, +0.0376 SOL net, biggest win +0.1241 (!!!).
  // FAT-TAIL PATTERN: low WR but huge rare winners pay for everything. The
  // +0.1241 SOL trade was ~500% real on a 0.025 slice. Multiple wallet
  // addresses — add all 7 so ANY daniww tx triggers the pattern we want.
  "3v8mNVUrKsyRs2PUcoFfEY5of4zzRscahpkstGLgmGLS", // daniww (addr 1)
  "BKWFf5zmw7PLmBZPUaHk8YXgZbZX5HHf7DT3LV6ViAJy", // daniww (addr 2)
  "HLaRgbo8YrVfTh4Nn9MUU2o786RsJ86b4YSAbgjEfV9q", // daniww (addr 3)
  "F1FE8k8cguYdzv3UeHgwao2AUgE8zPJzQvQKPiTfT14r", // daniww (addr 4)
  "8NgSPEZcJBg78z78n4FejqtQZ4HzpWNXMMV7yJiU7PWf", // daniww (addr 5)
  "G7mfcf5GbZezcBKqcDo5u16TSLARTVxTRSjXxDYbVnaq", // daniww (addr 6)
  "AuPp4YTMTyqxYXQnHc5KUc6pUuCSsHQpBJhgnD45yqrf", // daniww (addr 7)
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
// Apr 22 PM: halved 0.05 → 0.025. Session bleed at 0.05 size was
// unsustainable (-0.73 SOL across ~50 trades, 27% WR). Until we can
// prove post-fix expectancy is positive over 30+ trades, cut the
// per-trade loss magnitude in half. Expectancy (WR × avg_win − LR × avg_loss)
// scales linearly with size, so halving size halves both winning upside
// AND losing downside — but protects bankroll while the new L2 protection
// stack, drain-threshold recal, and blacklist expansions get validated.
// Revert to 0.05 only after 30 trades show net-positive expectancy.
export const LIVE_BUY_SOL = 0.025;
// Tightened Apr 18 PM — wallet down to ~0.82 SOL, 2.0 cap was wider than
// the bag. 0.25 SOL caps overnight bleed at ~5 losing trades worth.
// Apr 19 PM: temporary bump to 0.50 for Phase 1 sim-gate validation
// (commit 9327b3e). Apr 20 AM: reverted to 0.25 per BACKLOG P0.
// Apr 20 PM: user-requested bump back to 0.50. Current loss 0.257 SOL
// tripped the 0.25 cap ~2.5h before midnight UTC rollover; user wants
// trading to resume with the newly-shipped fixes (atomic claim, Jito
// rotation, liquidity monitor) live. 0.50 gives ~0.24 SOL headroom
// for the rest of today before re-halting. Revisit after midnight.
export const DAILY_LOSS_LIMIT_SOL = 0.50;

// Sprint 10 Phase 2 — entry filter: token age at entry.
// Postmortem 2026-04-19 showed <5min-old tokens had 31.8% WR / -0.20 SOL,
// while >6h-old had 50% WR / +0.075 SOL. Skipping freshest tokens should
// tilt the distribution away from the biggest loss bucket.
//
// Apr 21 PM test: loosened 30 → 15. The 30-min threshold was blocking
// ~all daytime flow including daniww's signals. 15 is a compromise —
// still past the sub-5min "death zone" but captures the 15-30min
// bucket we had no data on. Revert to 30 if the loosened window
// produces WR < 25% over ≥10 new trades.
export const MIN_TOKEN_AGE_MINUTES = 15;

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

// Sprint 10 Phase 3 — pre-buy liquidity trap filter.
// Before placing a buy, simulate a SOL→TOKEN→SOL round-trip at
// LIVE_BUY_SOL via Jupiter quote API. If quoted recovery is below this
// floor, the pool is too thin to exit without major slippage — skip the
// buy.
//
// Validated against 67 closed LIVE trades (Apr 20 postmortem):
//   - 100% of winners (14) had post-trade recovery ≥ 1.00
//   - 41 of 53 losers had post-trade recovery < 0.90
//   - A 0.90 floor would have blocked 41 losses and 0 winners
//   - Net SOL saved if enforced historically: +0.7736 SOL
// Pre-buy sim recovery is slightly HIGHER than post-trade (our entry
// drains some liquidity), so this floor is mildly more strict in
// practice than the backtest — but the bimodal separation between
// winners/losers is clean enough that 0.90 is a safe starting point.
//
// Apr 22 PM tightening: 0.90 → 0.95. Ben Pasterneck trade showed
// pre-buy sim at 97.7% → post-buy monitor at 87.8% — our own 0.025
// SOL buy drained 10 points of liquidity. The 0.90 floor meant any
// pool 90-99% pre-buy could still collapse into the 80s on our own
// impact. 0.95 leaves only 5% headroom for our buy's own drag,
// rejecting pools that are structurally too thin even if the
// pre-buy quote looks OK. Revert if entry throughput drops below
// 1 trade/hour (we lose signal-to-noise).
export const MIN_ROUND_TRIP_RECOVERY = 0.95;
