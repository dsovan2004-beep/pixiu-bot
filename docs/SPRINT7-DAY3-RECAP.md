# Sprint 7 Day 3 Recap — April 17, 2026

## Summary
Shared-guard consolidation complete. The dual-entry architecture
(Cloudflare Edge webhook + Node.js swarm validator/scout) that caused
`is_running=false` bypass losses on The Bull, 千鳥, and dogwifbeanie is
gone. Every entry guard now lives in one place — `webhook/route.ts
evaluateAndEnter()` — and every reject logs `[WEBHOOK] ❌ ${coin} —
${reason}`. The swarm is down to 4 agents (watcher, executor, risk
guard, tier manager); entry logic is 100% webhook-driven.

## Headline Metrics

| Metric | Value |
|--------|-------|
| Session window | Apr 17 2026, ~21:00 UTC (shared-guard sprint) |
| Commits shipped | 5 (add1a4d, e87f6a0, 4bdc377, 2e41899, 7dbe342) |
| Net lines | −577 (2 agent files deleted, run-all.ts trimmed) |
| CF builds | 5 green, 0 failed |
| Real SOL wallet | 1.0248 (start 3.6705, day P&L −2.6457 SOL / −$235.81) |
| Dashboard (mark) | 303 trades, 62.4% WR (189W/114L), avg gain +42.93%, avg loss −23.77% |
| Bot status post-restart | RUNNING, LIVE, 0 open positions |

The day-negative P&L reflects pre-consolidation bypass losses (Asteroid
−45.96%, TROLL −74.41%, jek duvel −42.16%, dogwifbeanie window, etc.).
These entered while `is_running=false` via the edge webhook before
commit `8772d39` landed — the consolidation makes that class of bug
architecturally impossible going forward.

## Commits Shipped

### 1. `add1a4d` — Token-2022 extension filter → webhook
Migrated from `price-scout.ts`. Inline `checkTokenExtensions()` helper
uses plain fetch to Helius RPC (no `@solana/web3.js` — that package
was never imported by any edge route, contrary to earlier assumption
which was caught and corrected before commit). Blocks mints with
TransferFeeConfig, NonTransferable, PermanentDelegate, or TransferHook
extensions. RPC errors fail-open.

### 2. `e87f6a0` — Whale hold time (2min sell-after-buy)
Migrated from `signal-validator.ts`. If any confirming wallet also
SOLD within 2min, reject as `quick_sell_${wallet}` — catches the
rug pattern where a whale buys then dumps to trigger followers.

### 3. `4bdc377` — Full `checkTokenSafety` + `MIN_LIQUIDITY_USD` bump
Replaces inline `checkLiquidity()` with `checkTokenSafety()` from
`price-guards.ts`. One DexScreener call covers three rug signals:
liquidity < $10k, fdv < $10k, priceChange.m5 < −20%. Also raised
`MIN_LIQUIDITY_USD` in `price-guards.ts` from $5k → $10k so webhook
and price-guards share a single source of truth. Verified no
third-party consumer (only validator+scout used it, both dead).

### 4. `2e41899` — Normalized `[WEBHOOK] ❌` rejection logging
12 silent guards now log on reject. 3 stale prefixes (`[FILTER]`,
`[SKIP]`, `[VALIDATOR]`) normalized to `[WEBHOOK] ❌ ${coin} —
${reason}`. Pure observability commit — no guard logic touched.

### 5. `7dbe342` — Delete dead entry pipeline
`signal-validator.ts` (302 lines) and `price-scout.ts` (275 lines)
deleted. `run-all.ts` updated: 6 agents → 4 agents, banner corrected,
stale `pixiubot:confirmed → trades` label on Trade Executor
fixed (executor polls `trades` every 3s, never subscribed to
that channel — verified by grep).

## Architecture Change

**Before**
```
wallet-watcher → signals channel → signal-validator → entries channel
  → price-scout → confirmed channel → [NO SUBSCRIBERS]
                                      trade-executor (polls trades)
  ──────────────────────────────────────────
  webhook (Helius direct) → evaluateAndEnter → trades
```
Two entry paths with duplicated guards that drifted out of sync.
`pixiubot:confirmed` channel had zero subscribers — scout's output
landed nowhere. Webhook was the only path actually inserting
`trades` rows; scout was producing log lines with zero
enforcement.

**After**
```
wallet-watcher → coin_signals table (signals sidecar)
webhook (Helius direct) → evaluateAndEnter() → trades
trade-executor (polls trades every 3s) → Jupiter swap
risk-guard (polls open positions every 5s) → exits
tier-manager → demote/promote T1↔T2
```
Single entry path. Every reject visible in CF tail logs.

## Guards Now in `evaluateAndEnter()` (15 total)

1. `bot_running` (inline `webhookIsBotRunning()`)
2. Stablecoin name filter
3. Offensive name filter
4. Rug storm (inline `webhookIsRugStorm()` — 3/5 losses in 2h)
5. Token-2022 extension filter *(added commit 1)*
6. Gap filter (`MAX_GAP_MINUTES`)
7. Position already open
8. 120min address cooldown
9. 30min name cooldown
10. T1 smart money (tier=1 required)
11. Whale hold time (2min sell-after-buy) *(added commit 2)*
12. Bundle detection (≥80% from one wallet, ≥3 signals)
13. Price fetch success
14. `isPriceTooHigh` ($0.001 max)
15. Full `checkTokenSafety` — liq / fdv / m5 *(expanded commit 3)*
16. `checkLpAndHolders` (LP burn + top10 ≤ 80%)

Every reject path now logs `[WEBHOOK] ❌ ${coinName || mint.slice(0,8)}
— ${reason}` *(commit 4)*.

## Known Follow-Ups — Deferred to Sprint 8

See `docs/BACKLOG.md` for the full Sprint 8 queue.

Short version:
- **Commit 6 cleanup (P1):** `entry-guards.ts` orphaned; `checkLiquidity`
  helper + `MIN_LIQUIDITY_USD` local const dead in webhook; stale
  comment in `price-guards.ts:5`; `wallet-watcher` still broadcasts
  to `pixiubot:signals` with no subscribers.
- **Cloud migration (P2):** Mac → DigitalOcean.
- **Position size bump (P3):** 0.05 → 0.10 SOL, gated on 48h clean +
  WR > 55% on 20+ trades + buy-land > 90%.
- **$1K capital injection (P4):** after 1 week clean at 0.10 SOL.

## Verification

- CF edge deploy green on all 5 commits.
- Webhook bundle size: 490.12 → 491.11 KiB (+1 KB from log strings).
- Local swarm restarted cleanly: banner reads "All 4 agents running";
  executor correctly honoring `is_running` on every 3s poll; watcher
  ingesting 751-wallet firehose.
- `signal-validator.ts` and `price-scout.ts` grep-confirmed unused
  before delete (only importer was `run-all.ts` in both cases).
