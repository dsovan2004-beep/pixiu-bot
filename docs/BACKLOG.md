# PixiuBot Backlog

Active work queue. Ordered by priority. Move to `docs/SPRINT*-RECAP.md`
when shipped, then delete from here.

---

## Sprint 9 — COMPLETE (Apr 18)

Shipped the real-only accounting framework + two hot-path exit-strategy
fixes from the real-data findings. See `docs/JOURNAL.md` for the full
recap.

### Sprint 9 commits (chronological)

| Commit | What |
|---|---|
| `e264000` | Go-forward real_pnl_sol accounting (migration 012 + parseSwapSolDelta + executor/guard writes) |
| `d690937` | Historical backfill — 310/310 LIVE trades populated |
| `8372d64` | Dashboard LIVE stats from `real_pnl_sol` |
| `6b3c2eb` | whale_exit gated to L0 only (was #1 drain: 94 trades, 23% WR, −1.24 SOL) |
| `ee2514e` | CB threshold split: L0 −15% / L1+ −25% (was #2 drain: 53 trades, −0.96 SOL) |
| `375b18b` | `divergence-flagger.ts` observability script |
| `bc2a581` | Banner line updated |

### Real performance by exit_reason (301 matched trades)

| exit | trades | WR | avg | SOL |
|---|---|---|---|---|
| take_profit | 57 | 66.7% | +67.1% | +2.13 |
| trailing_stop | 17 | 70.6% | +84.6% | +0.72 |
| stop_loss | 53 | 50.9% | +12.2% | +0.20 |
| timeout | 20 | 40.0% | +7.2% | +0.07 |
| rug_or_missing | 7 | 28.6% | −35.4% | −0.13 |
| circuit_breaker | 53 | 26.4% | −29.2% | −0.96 |
| whale_exit | 94 | 23.4% | −17.6% | −1.24 |

Real expectancy per trade: +8.9%.

---

## Sprint 10 — candidates

### Post-Live-Session Findings (Apr 18)

**Session context:** 19 live trades since the fresh-data rebuild, real
PnL −0.1592 SOL (−$13.68), WR 31.6%, wallet 0.6888 SOL. Commit 6b3c2eb
(whale_exit L1+ skip) deployed and behaving as designed. Clean data.

#### Exit reason breakdown (19 trades)

| Reason | Trades | Net Real SOL | Real WR | Notes |
|---|---|---|---|---|
| circuit_breaker | 9 | −0.1144 | 22.2% (2W/7L) | Biggest drain; 47% of all trades |
| whale_exit | 5 | −0.0725 | 20% (1W/4L) | L0 safety net underperforming |
| trailing_stop | 2 | +0.0572 | 100% (2W/0L) | Asteroid +100.8%, PercyJackson +8.87% |
| stop_loss | 2 | −0.0280+ | 0% (0W/2L) | Both on L2 positions |
| timeout | 2 | −0.0194 | 50% (1W/1L) | |

#### P0 — CB threshold analysis (L0)

9 CB trades, net −$9.85, 22% WR. Biggest current bleed.
Run SQL on all 9 CB trades to see token outcome post-exit. Determine
if tightening CB from −25% to −15% on L0 would have cut losses or
preserved the 2 winners (nobrainer +10%, Snow Pump +1.23%).
**Do not ship a threshold change without this analysis.**

#### P0 — SHIPPED: L1+ CB tightened −25% → −15%

Commit `bf149dc`. Evidence: 2 L1+ CB trades (Moo Noom L1 −38%,
AHHHHHH L2 −48%), 0W/2L. Both locked partial profit then gave it
all back. Tightening to −15% protects the banked gains (L1 floor 0%,
L2 floor +13.75%). Matches L0 threshold for consistency.

#### P1 — L0 whale_exit safety net underperforming

5 L0 WE trades since fix. 1W (Chud +22%), 4L (Naruto −68%, Dicknald
−8%, Asteroid Shiba −26%, Walter −21%). Net −$6.25.
Hypothesis: WE fires when a T1 whale sells, but by the time the bot
executes its own sell the dump is already priced in — eating max
slippage on the way out.
Options: require 2+ whales selling within N seconds; only fire if
mark has dropped >X% in that window; disable WE entirely on L0.
**Do not ship without more data.** 5 trades is too small.

#### P1 — Stop loss on L2 positions is 0/2

Only 2 SL exits this session (Sob −53%, Peptides), both on L2, both
losses. Similar dynamic to the CB-L1+ issue we just fixed. SL −10%
threshold after grid partial taken = giving back profits AND entering
loss. Scale SL threshold by grid_level (e.g. L0 −10%, L1 −7%, L2 −5%).
**Sample too small to ship. Revisit at 30+ SL trades.**

#### P2 — Trailing stop is the proven edge

2 TR trades, both winners. Asteroid +100.8% (+0.0526 SOL), PercyJackson
+8.87% (+0.0046 SOL). Net +$4.92. **Only consistently profitable exit
type.**
Consider lowering L3 activation threshold from +100% to +50% to catch
more moonshots that don't fully send. Measure before/after TR trigger
rate and TR PnL.

#### P2 — Session bleed rate ~$0.70–$0.86 per trade

At current rate, wallet hits 0.50 SOL floor around trade 32–35 of a
target-50 sample. Daily loss limit is live at 0.25 SOL auto-halt.

#### P3 — Insufficient sample caveat

CB=9, WE=5, TR=2, SL=2, TO=2. Reliable fixes need ~30/type. Do not
ship aggressive threshold changes yet.

---

### P0 — Webhook race creates duplicate rows (shipped Apr 18, migration 013)

**Evidence:** WHERE IS THE AIRDROP created 5 rows within 230ms from a
single Cupsey BUNDLE signal storm. Webhook's "position already open"
check is non-atomic: N simultaneous requests all see count=0 before
any commit, all INSERT, → N duplicate rows.

Fixed with Postgres partial unique index:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS one_open_per_mint_idx
  ON trades(coin_address)
  WHERE status = 'open';
```

Webhook catches the duplicate-key error and skips entry cleanly.

### P0 — Measure CB / whale_exit fix effect (48h observation)

Both fixes (`6b3c2eb` L0-only whale_exit, `ee2514e` then `bf149dc`
L1+ CB tightening) are behavioral. Before declaring good or rolling
back, need 48h of live data with:
- ≥ 20 new LIVE trades
- ≥ 5 trades where whale_exit would have fired pre-fix (now skipped)
- ≥ 5 L0 crashes where the −15% CB fires (instead of −25%)
- ≥ 5 L1+ positions where the −15% CB fires (new trigger point)

Re-run `live-stats.ts` at 48h. Compare whale_exit + circuit_breaker
rows to pre-fix baseline. Expected:
- whale_exit count drops (only L0 now)
- whale_exit WR should improve
- CB count may rise on L0/L1+ (earlier trigger), but avg SOL lost
  per CB should decrease

If L0 whale_exit WR stays below 40%, consider disabling entirely.

### P1 — Top-line dashboard surfacing

Dashboard header shows `phantomBalance.pnlSol` (wallet delta, includes
fees + orphans) and `Trade PnL (N)` (sum real_pnl_sol). These are
intentionally separate — wallet Δ captures total bleed including
failed-buy fees, Trade PnL captures what successful trades actually
earned. Good as-is.

### P2 — Poll interval already split

L0 = 2s, L1+ = 5s. Shipped `bdc50d7`. No further action.

### P2 — Sprint 6 retro + DATA_MODEL.md schema update

- Sprint 6 has no recap file — reconstruct from git log
- `DATA_MODEL.md` needs current schema: `trades` table,
  `entry_sol_cost`, `real_pnl_sol`, `buy_tx_sig`, `sell_tx_sig`,
  `closing_started_at`. Drop references to the legacy bankroll
  table (removed in migration 015).

### P3 — Position size bump 0.05 → 0.10 SOL

**Gate:**
- Real WR > 55% on 20+ LIVE trades (measured via `real_pnl_sol`)
- Real expectancy > +10% / trade
- 48h no accounting regressions

Current real WR on the 19-trade post-rebuild window is 31.6%. Gate
locked until behavior changes deliver sustained improvement.

### P3 cluster — leftover reliability items

- `src/lib/price-guards.ts:5` — stale comment mentioning deleted
  `price-scout.ts`
- `src/agents/wallet-watcher.ts` — still broadcasts to
  `pixiubot:signals` channel with zero subscribers. Drop or keep
  as a future hook.
- `DATA_MODEL.md` schema correction (see P2 above)
- Remove hardcoded `TOP_ELITE_ADDRESSES` set — webhook/risk-guard
  both query DB tier now. Only tier-manager mutates in-memory.
  DB has 63 active tier=1 vs 14 in the config (stale).
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
- Replace DexScreener dependency entirely (outages cause false
  `token_unsafe` rejects)
