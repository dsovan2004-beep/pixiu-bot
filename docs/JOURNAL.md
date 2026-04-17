# PixiuBot Journal

Append-only log of material decisions, bugs shipped, architectural pivots.
Newest first.

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
