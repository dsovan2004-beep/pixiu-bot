# PixiuBot Backlog

Active work queue. Ordered by priority. Move to `docs/SPRINT*-RECAP.md`
when shipped, then delete from here.

---

## Sprint 10 — Day 1 shipped (Apr 18 PM)

Framework rebuild + safety rails. See `docs/JOURNAL.md` for the full
recap.

### Sprint 10 commits (chronological)

| Commit | What |
|---|---|
| `3d11157` | Partial unique index `one_open_per_mint_idx` (migration 013) — kills webhook-race duplicate rows |
| `e31b75b` | parseSwapSolDelta uses fee-payer index 0 — ALT decode fix |
| `a386ed2` | Reaper flip-flop fix + `closing_started_at` column (migration 014) |
| `c3153cc` | Dashboard stripped of paper framework (real-only stats) |
| `d5978bc` | Dashboard shows `status='closing'` rows under Open Positions |
| `071ace8` | `DAILY_LOSS_LIMIT_SOL` 2.0 → 0.25 SOL |
| `11d8c6a` | Migration 015: `paper_trades` → `trades`, wipe rows, drop `paper_bankroll` |
| `bf149dc` | L1+ CB tightened −25% → −15% |
| `be206c4` | Full scrub — zero 'paper' references left anywhere |
| `eba800a` | Kill hardcoded STARTING_SOL; deposit-safe dashboard cards |
| `5d68772` | Daily loss limit no longer writes `is_running=false` (auto-resumes at UTC rollover) |

### Day 1 results (22 LIVE trades post-rebuild)

| Exit | Trades | Net SOL | WR | Note |
|---|---|---|---|---|
| trailing_stop | 2 | +0.0572 | 100% | Asteroid +101%, PercyJackson +9% — **proven edge** |
| circuit_breaker | 9 | −0.1144 | 22% | biggest drain |
| whale_exit | 5 | −0.0725 | 20% | still underperforming L0-only |
| stop_loss | 3 | −0.042 | 0% | all L1/L2 give-backs |
| timeout | 2 | −0.019 | 50% | |

Total: 22 trades, 28.6% WR, **−0.1787 SOL** (−16.4% ROI on capital deployed).

---

## Sprint 10 — remaining candidates

### P0 — Measure new thresholds (48h observation)

Behavioral fixes shipped this session need data before declaring good
or rolling back:
- Real WR on L1+ CB at −15% (new trigger; 0/2 at −25% pre-fix)
- Real WR on L0 whale_exit after `6b3c2eb` gate
- Trailing_stop conversion rate unchanged (expect ~70%)

Target: ≥ 30 more trades. Re-run `live-stats.ts` at 48h.

### P0 — Phantom positions from webhook + stopped bot

When `is_running=false` (daily-limit halt, manual stop, etc), the
webhook still inserts `trades` rows on smart-money signals. Executor
skips the buy; row sits in 'open' state with no wallet balance. Guard
eventually CB-closes the phantom with `real_pnl_sol=null`.

Harmless today (dashboard filters out null-real rows from stats), but
clutters the `trades` table and triggers guard/Jupiter calls for rows
that aren't real positions.

**Fix:** webhook should check `bot_state.is_running` before inserting.
Requires adding that field to the webhook Edge query.

### P1 — L0 whale_exit safety net underperforming

5 L0 WE trades on Sprint 10 Day 1: 1W (Chud +22%), 4L (−68%, −26%,
−21%, −8%). Net −0.0725 SOL.
Hypothesis: by the time the bot's Jupiter sell lands, the whale dump
is already priced in.
Options (DON'T ship yet, need 15+ sample):
- require 2+ whales selling within N seconds
- only fire if mark already dropped >X% during the window
- disable WE entirely on L0, rely on SL + CB

### P1 — Stop loss on L1+ positions is bleeding banked profit

3 SL exits Sprint 10 Day 1 on L1/L2 positions, all losers. Same
dynamic as the CB-on-L1+ issue we fixed. SL −10% threshold AFTER a
grid partial triggered = giving back the bank.

**Proposal:** scale SL threshold by grid_level:
- L0: −10% (current)
- L1: −7% (after +15% lock)
- L2: −5% (after +40% lock)
- L3: trailing-stop only, no SL

Don't ship until ≥ 30 SL-exit trades at current baseline for A/B
comparison.

### P2 — Consider lowering L3 trailing activation +100% → +50%

Trailing_stop is the only consistently profitable exit type (100% WR
on 2 trades so far, 70.6% WR across 17 in the pre-rebuild dataset).
Lowering activation threshold would catch more moonshots that pump
+50–99% then dump without ever hitting +100%.

Risk: trailing prematurely activates on noise, converts L2+40%
winners into smaller trails. Measure trigger rate + per-trade PnL
delta before/after.

### P2 — DATA_MODEL.md schema update

Current schema diverged from the doc:
- Table renamed: `paper_trades` → `trades`
- Dropped: `paper_bankroll` (migration 015)
- New cols: `entry_sol_cost`, `real_pnl_sol`, `buy_tx_sig`,
  `sell_tx_sig`, `closing_started_at`

### P3 — Position size bump 0.05 → 0.10 SOL

**Gate:**
- Real WR > 55% on 20+ LIVE trades
- Real expectancy > +10% / trade
- 48h no accounting regressions

Current real WR on the 22-trade post-rebuild window is 28.6% — gate
locked until behavior changes deliver sustained improvement.

### P3 cluster — leftover reliability items

- `src/lib/price-guards.ts:5` — stale comment mentioning deleted `price-scout.ts`
- `src/agents/wallet-watcher.ts` — still broadcasts to `pixiubot:signals` channel with zero subscribers
- Remove hardcoded `TOP_ELITE_ADDRESSES` set — webhook/risk-guard both query DB tier now; only tier-manager mutates in-memory
- Cloud migration Mac → DO (move swarm off local laptop)
- `bot_state` startup retry hardening (3× retry with 500ms backoff)
- Empty `catch {}` blocks in ~12 places — add minimal error logging

### P4 — $1K capital injection

Gate: 1 week clean at 0.10 SOL position size (after P3 ships and holds).
Re-spec the "clean week" definition against real expectancy post-P0
observation window.

---

## Parking lot (no timeline)

- Edge-safe shared guards (webhook inlined duplication)
- On-chain pool reader replacing DexScreener for liquidity signal
- Tier-4 frontrunner detector (wallets buying before top T1 wallets)
- Regression harness (would have caught the `exit_time` latch bug)
- Replace DexScreener dependency entirely (outages cause false `token_unsafe` rejects)

---

## Sprint 9 — COMPLETE (Apr 18 morning)

Shipped the real-only accounting framework + two hot-path exit-strategy
fixes.

### Sprint 9 commits

| Commit | What |
|---|---|
| `e264000` | Go-forward real_pnl_sol accounting (migration 012 + parseSwapSolDelta + executor/guard writes) |
| `d690937` | Historical backfill — 310/310 LIVE trades populated |
| `8372d64` | Dashboard LIVE stats from `real_pnl_sol` |
| `6b3c2eb` | whale_exit gated to L0 only (was #1 drain: 94 trades, 23% WR, −1.24 SOL) |
| `ee2514e` | CB threshold split: L0 −15% / L1+ −25% (superseded by `bf149dc` to L1+ −15%) |
| `375b18b` | `divergence-flagger.ts` observability script |

### Real performance by exit_reason (301 pre-rebuild matched trades)

| exit | trades | WR | avg | SOL |
|---|---|---|---|---|
| take_profit | 57 | 66.7% | +67.1% | +2.13 |
| trailing_stop | 17 | 70.6% | +84.6% | +0.72 |
| stop_loss | 53 | 50.9% | +12.2% | +0.20 |
| timeout | 20 | 40.0% | +7.2% | +0.07 |
| rug_or_missing | 7 | 28.6% | −35.4% | −0.13 |
| circuit_breaker | 53 | 26.4% | −29.2% | −0.96 |
| whale_exit | 94 | 23.4% | −17.6% | −1.24 |
