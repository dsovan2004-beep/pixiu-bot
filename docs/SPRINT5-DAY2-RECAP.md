# Sprint 5 Day 2 Recap — April 16, 2026

## Summary
Second day of live trading. System ran autonomously through a full session — no manual intervention required for entries or exits. Surfaced three latent bugs (double-sell accounting, Jupiter confirmation noise, daily-limit drift) that need fixes before scaling position size.

## Session Snapshot

| Metric | Value |
|--------|-------|
| Mode | LIVE (dashboard toggle on) |
| Position size | 0.05 SOL per buy (code), 0.10 SOL (log math — see Bug 3) |
| Tracked wallets | 751 |
| Daily loss limit hit | Yes — blocked further LIVE BUYs mid-session |
| Bot restarts | 1 (Ctrl+C + relaunch) |

## Notable Trades

| Coin | Result | PnL | Notes |
|------|--------|-----|-------|
| Broke Company | Whale exit | +129.06% | **Double-credited bankroll** ($15,544 → $15,745 → $15,945). Sold once on-chain, guard fired second sell attempt that failed (`Token balance is 0`) but still wrote a duplicate close row. |
| coin.ai | Circuit breaker | -52.2% | CB fired correctly at -25% threshold, exit clean. |
| jonathan | Buy failed on-chain | — | `InstructionError [6, Custom 6001]`. Retry hit Jupiter 429 rate limit. Marked failed, no guard monitoring. |
| Airdrop (Run 2) | Whale exit | +204.76% | Clean auto-sell. Bankroll $16,315 → $16,649. |
| Fibs The Bagworker (Run 2) | Open at session end | -5% to +3% range | Still at L0 100% remaining. |
| Cult of Sunglasses | Skipped | — | Daily loss limit blocked entry. |
| ~6 others | "BUY status unknown — treating as FAILED" | — | Jupiter confirmation timeouts. Trades correctly marked failed and skipped guard. |

## Bugs Surfaced (Not Yet Fixed)

### 1. Double-sell + double-bankroll-credit on whale exit
**File**: `src/agents/risk-guard.ts` — `closeTrade()` + whale-exit branch
**Symptom**: Broke Company logged whale-exit close at +129.06%, then a second whale-exit fired ~1s later. Second sell to Jupiter returned "no tokens found" but the DB row was still updated and `updateBankroll(+200.63)` ran twice.
**Root cause**: `closingPositions` Set guards against double-close *within the same poll loop*, but the whale-exit branch can fire on two consecutive polls before the DB row flips to `status='closed'` (Supabase write latency + the executor's separate poll).
**Fix direction**: Make the close write conditional (`.eq('status', 'open')`) and only credit bankroll when the update affects a row.

### 2. Jupiter BUY confirmation timeout rate is high
**File**: `src/lib/jupiter-swap.ts`
**Symptom**: ~6 buys this session ended with `BUY confirmation timeout — verifying tx status` → `BUY status unknown — treating as FAILED`. Some of these likely *did* land on-chain.
**Risk**: If a tx silently lands but we mark it failed, we hold tokens with no guard monitoring → unmanaged loss exposure.
**Fix direction**: After timeout, poll `getSignatureStatus` for an additional 30-60s before declaring failed. If confirmed late, write the [LIVE] tag and let the guard pick it up.

### 3. Position size / daily-limit drift between docs and code
**Files**: `src/agents/trade-executor.ts` (`LIVE_BUY_SOL = 0.05`, `DAILY_LOSS_LIMIT_SOL = 5.0`), `src/agents/risk-guard.ts` (`DAILY_LOSS_LIMIT_SOL = 2.0`), `README.md` (says "0.2 SOL")
**Symptom**: Log line `21 losses × 0.10 = 2.10 SOL (max 5.0 SOL)` — math uses stale 0.10 value, wrong limit referenced. Three different numbers across the codebase.
**Fix direction**: Hoist to a single config constant in `src/config/smart-money.ts` and import everywhere.

### 4. Jupiter 429 rate limits on retry
**Symptom**: jonathan buy failed on-chain (6001), retry immediately hit `Swap tx failed: 429`.
**Fix direction**: Backoff between retries (already partially in place for sells via auto-slippage escalation). Apply same pattern to buy retries.

## Bankroll Reconciliation Needed

Before trusting the dashboard `current_balance`, manually subtract the duplicate Broke Company credit (~$200.63) and reconcile against actual on-chain SOL balance.

## Updated Backlog

Replaces "Next Steps" in `SPRINT5-LIVE.md`. Priority order:

- [x] **P0** — Fix double-sell / double-bankroll-credit (Bug 1). _Atomic-claim + sell-then-credit in `risk-guard.ts`._
- [x] **P0** — Reconcile bankroll vs on-chain SOL after Broke Company double-count. _-$91.77 applied._
- [x] **P0** — Recover SOL from 8 stuck token bags + burn 2 worthless orphans.
- [x] **P1** — Late-confirm Jupiter buy timeouts (Bug 2). _Rescue path in `trade-executor.ts`: 3min after a "failed" mark, re-checks on-chain holdings; if held → re-opens trade as [LIVE]._
- [x] **P1** — Consolidate position-size + daily-loss-limit constants (Bug 3). _All in `config/smart-money.ts`._
- [x] **P2** — Telegram alerts. _`src/lib/telegram.ts` — set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in .env.local; otherwise silent no-op._
- [ ] **P2** — Backoff on Jupiter 429 retries (Bug 4).
- [ ] **P2** — Cloudflare Workers migration for 24/7 uptime.
- [ ] **P3** — Re-enable scaling to 0.10 SOL only after 20+ clean trades at 0.05 with WR > 55%.

## Key Lessons (Day 2)

1. The minimum-hold guards prevented some bad early exits, but didn't catch back-to-back whale-exit fires on the same coin.
2. "Treat as failed" on Jupiter timeout is safe for capital but loses winners — needs a verify-late path.
3. Magic numbers drift fast. Single source of truth for sizing/limits is overdue.
4. Daily loss limit working as designed (blocked Cult of Sunglasses) — good.
