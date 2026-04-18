# PixiuBot Journal

Append-only log of material decisions, bugs shipped, architectural pivots.
Newest first.

---

## 2026-04-18 (evening) — Sprint 8 gate closed; 2 new bug fixes + P0b regression caught

Bot resumed live trading after the P0 gate shipped this morning.
Tonight: 2 new bugs found in sanity check + a regression in my own
P0b fix surfaced live.

### Commits tonight

| Commit | What |
|---|---|
| `7adf4f0` | Sanity-check fixes: whale-exit now uses DB `tier=1` (not stale hardcoded 14-wallet set — DB has 63 active T1); bundle-detect no longer double-counts the current walletTag |
| `2fcea6f` | **P0b-regression fix**: idempotent-close latch switched from `.is("pnl_usd", null)` → `.is("exit_time", null)`. The pnl_usd column defaults to 0 (not NULL), so the original latch matched zero rows on every close attempt — positions stayed stuck in 'closing' until the reaper reverted them. 4 positions were stuck mid-evening; all flushed when the fix shipped. |

### Trade results tonight (after P0b-regression fix)

| Coin | PnL | Grid | Reason |
|---|---|---|---|
| X CEO Flōki | +7.50% | L1 | TP |
| Moon Dog | +17.50% | L2 | TP (whale_exit later confirmed after L2 locked) |
| Tung Tung Tung Sahur | −42.15% | L0 | CB |
| hold if your not gay. | −88.67% | L0 | CB (price collapsed faster than 5s guard poll; whales buy+dumped within one window) |
| Retail Coin | +7.50% | L1 | TP (afternoon) |

Real SOL: 1.0043 → 0.9811 tonight (net ~−$2 after recovery of locked L1/L2 partials).
Cumulative real P&L today: −$238.74 (majority from the −88% and the Moon Dog-style recoveries).

### Lessons captured (added to PLAYBOOK follow-up)

- **Supabase column defaults matter.** `pnl_usd` has a 0 default, not NULL. Any `.is(column, null)` idempotency latch must pick a column that's actually nullable. `exit_time` is the right choice.
- **A 5s guard poll is sometimes too slow.** `hold if your not gay.` went +37% → −88% between polls. Worth considering either a tighter CB threshold (−15% on L0) or a 2s poll for L0-only positions.
- **Tier-manager has promoted a lot of wallets.** DB has 63 tier=1 active vs 14 hardcoded in config. The hardcoded list is effectively stale and should probably be removed entirely as a follow-up.

### State at sign-off

- Bot: RUNNING
- Open positions: 0
- Real SOL: 0.9811
- All bankroll credits flowing correctly
- No stale `closing` rows, no drift

---

## 2026-04-18 (morning) — Sprint 8 P0a/P0b/P0c shipped; bankroll reconciled

Sprint 8 pre-trading gate — 3 of 4 items complete. P2a still pending.

| Commit | What |
|---|---|
| `1e1a6e2` | **P0a** — Jupiter 429 retry backoff (1s/3s/10s, buy + sell paths) |
| `1b808a7` | **P0b** — Idempotent bankroll credit (`.is("pnl_usd", null)` latch on close UPDATEs) + gated sell-failed revert + mark-to-zero on Jupiter 6024 un-sellable tokens |
| *(post-deploy run)* | **P0c** — `src/scripts/reconcile-bankroll-p0c.ts` executed |

### P0c reconcile result

```
Starting balance:    $10,000.00
Current balance:     $29,004.40   ← before reconcile
Σ pnl_usd (ledger):  $18,094.93
Expected balance:    $28,094.93
Drift:               +$909.47     ← phantom credits from P0b bug
Closed trades:       646
Real on-chain SOL:   1.0043
```

Bankroll adjusted $29,004.40 → $28,094.93. Drift of $909.47 was
larger than the $165 estimated from Retail Coin alone, indicating a
longer tail of historical double-credits from the same code path.
P0b fix in `1b808a7` prevents recurrence.

Authoritative source going forward: `SUM(paper_trades.pnl_usd)` for
`status='closed'`. Any future drift > $0.01 indicates a regression.

### Bot state

- Status: STOPPED (per pre-trading gate rule).
- P2a dashboard relabel still pending — ships next, then trading
  can resume.

---

## 2026-04-17 — Sprint 7 Day 3: Shared-Guard Consolidation COMPLETE

**5 commits shipped.** Webhook is now the single entry path. Swarm down
to 4 agents. All 15 guards normalized with `[WEBHOOK] ❌` rejection
logging.

| Commit | What |
|---|---|
| `add1a4d` | Token-2022 extension filter → webhook |
| `e87f6a0` | Whale hold time (2min sell-after-buy) → webhook |
| `4bdc377` | Full `checkTokenSafety` (liq + fdv + m5); `MIN_LIQUIDITY_USD` $5k → $10k |
| `2e41899` | `[WEBHOOK] ❌` normalized rejection logging across all 15 guards |
| `7dbe342` | Deleted `signal-validator.ts` + `price-scout.ts` (−577 lines); `run-all.ts` 6→4 agents |

**Architecture delta:**
- Entry: webhook `evaluateAndEnter()` is now the **only** place
  `paper_trades` inserts happen.
- Swarm agents: `wallet-watcher`, `trade-executor`, `risk-guard`,
  `tier-manager`. Validator + scout deleted.
- Dead code confirmed: validator/scout were producing log lines with
  zero enforcement — `pixiubot:confirmed` channel had no subscribers.

**Current state:**
- Balance: 1.0248 SOL (start 3.6705, day P&L −2.6457 SOL / −$235.81)
- Win rate 62.4% (189W / 114L)
- Avg gain +42.93%, avg loss −23.77% → expectancy +17.8%/trade
- Bot RUNNING, LIVE, 0 open positions

Day-negative P&L = pre-fix bypass losses (Asteroid, TROLL, jek duvel,
dogwifbeanie window). Now architecturally impossible going forward.

Full recap: `docs/SPRINT7-DAY3-RECAP.md`. Backlog: `docs/BACKLOG.md`.

---

## 2026-04-17 — Sprint 5 Day 3 (earlier)

Phantom infinite-loop + Jupiter 6024 fixes, Token-2022 filter added
(initially to scout). Commits `2bb9246`, `1c0eeea`, `10db69c`.

Full recap: `docs/SPRINT5-DAY3-RECAP.md`.
