# PixiuBot

Autonomous Solana memecoin trading bot. Copies Smart Money wallet trades with a 4-agent swarm, a single webhook-side entry path enforcing 15 guards, Jupiter V1 live swaps, and automated risk management.

**Now trading LIVE with real SOL.**

See `PLAYBOOK.md` for operational details, `ROADMAP.md` for what's next, `DATA_MODEL.md` for table ownership, `SPRINT.md` for history.

## Current Status

| Sprint | Status | Summary |
|--------|--------|---------|
| Sprint 1-2 | COMPLETE | Webhook + paper trader monolith |
| Sprint 3 | COMPLETE | 6-agent swarm, 131 trades, 56.5% WR, $11,325 (+13.26%) |
| Sprint 4 | COMPLETE | Jupiter live swaps, dashboard toggle, safety audit |
| Sprint 5 Day 1 | COMPLETE | 4/5 wins (80% WR), +0.0224 SOL gross — 16 transition bugs fixed |
| Sprint 5 Day 2 | COMPLETE | Double-credit race fixed, 8 stuck bags recovered, rescue paths shipped |
| Sprint 5 Day 3 | COMPLETE | Phantom-loop + 6024 bail + Token-2022 filter + pump.fun rescue script |
| Sprint 6 | COMPLETE (undocumented) | Trailing stop after L3, daily-loss counter fixed to real SOL, webhook `is_running` bypass fix — see `SPRINT.md` |
| Sprint 7 Day 3 | **LIVE** | Shared-guard consolidation — 5 commits, dual entry path removed, validator + scout deleted, `[WEBHOOK] ❌` logging normalized |
| Recovery Goal | $3,325 — REACHED | $3,971 gross wins from $10K paper start |

## Architecture

Single entry path (webhook on Cloudflare Edge) + 4-agent node swarm for execution, exits, watching, and tier management.

```
Helius push → Cloudflare webhook (evaluateAndEnter, 15 guards) → paper_trades
                                                                      |
                                                      Agent 2: Trade Executor
                                                      Polls paper_trades every 3s
                                                      New trade → Jupiter buy → [LIVE] tag
                                                                      |
                                                      Agent 3: Risk Guard
                                                      Polls positions every 5s
                                                      CB > Whale > SL > TO > Grid (L3 = trailing) → Jupiter sell
                                                                      |
                                                      Agent 1: Wallet Watcher
                                                      Polls tracked wallets every 3s → coin_signals
                                                                      |
                                                      Agent 4: Tier Manager
                                                      Auto-demote/promote T1↔T2 wallets
```

**As of Sprint 7 Day 3**, `signal-validator.ts` and `price-scout.ts` have been removed (−577 lines). All entry guards live in `src/app/api/webhook/route.ts evaluateAndEnter()`. Full guard list and ordering: `PLAYBOOK.md`.

## T1 Smart Money Wallets (11)

| Wallet | Address | Source |
|--------|---------|--------|
| Cented | CyaE1V...ga54o | Kolscan |
| Cooker | 8deJ9x...XhU6 | Kolscan |
| GMGN_SM_2 | J3Ez1W...eJ8k5 | GMGN.ai 90% WR |
| GMGN_FW_1 | 4gyFNL...1Q99 | GMGN.ai 95% WR |
| GMGN_FW_2 | 5BGiLE...B3mz | GMGN.ai 100% WR |
| Jijo | 4BdKax...EFUk | Kolscan 55% WR |
| GMGN_FW_3 | G45wKG...gXQ5F | GMGN.ai 93% WR |
| GMGN_FW_4 | Hrk1f2...f5zRb | GMGN.ai 85% WR |
| Sheep | 78N177...kh2 | GMGN.ai #2 64% WR |
| LUKEY | DjM7Tu...uN7s | Kolscan #28 94% WR |
| Cupsey | 2fg5QD...rx6f | GMGN.ai #3 56% WR |

Demoted: Scharo (T1 to T2). Tier Manager auto-demotes at WR < 50% on 3+ trades in 24h, auto-promotes at WR > 65% on 5+ trades in 7d.

## Entry Guards

15 guards inline in `src/app/api/webhook/route.ts evaluateAndEnter()`. Ordered cheap → expensive; cheap string checks before DB reads before network calls.

Summary: `bot_running`, stablecoin filter, offensive name filter, rug storm, Token-2022 extensions, gap, position already open, 120min address cooldown, 30min name cooldown, T1 Smart Money required, whale hold time (2min sell-after-buy), bundle detection, price fetch, `isPriceTooHigh`, full `checkTokenSafety` (liquidity ≥ $10k + fdv ≥ $10k + m5 ≥ −20%), LP burned + top10 holders ≤ 80%.

Every reject logs `[WEBHOOK] ❌ ${coin} — ${reason}`. Full table with reject reason strings and cost classes: `PLAYBOOK.md`.

## Exit Priority

Risk Guard checks open positions every 5 seconds:

```
0a. Minimum hold time (30s) — skip all except CB
0b. Rug detection — price=0 after 2min = exit at -100%
 1. Circuit Breaker — pnlPct <= -25% → emergency exit
 1b. Price echo guard — pnlPct === 0% → skip (wait for real movement)
 2. Whale Exit — T1 wallet SELL detected → exit with whale
 3. Stop Loss — pnlPct <= -10% → full exit
 4. Timeout — 20 minutes → full exit
 5. Grid Levels:
    L1: +15% → sell 50% (break-even lock)
    L2: +40% → sell 25%
    L3: +100% → sell 25% (fully closed)
```

## Backlog

Active Sprint 8 queue: [docs/BACKLOG.md](docs/BACKLOG.md).
Forward roadmap incl. gated scale-up: [ROADMAP.md](ROADMAP.md).
History per sprint: [SPRINT.md](SPRINT.md).

## Sprint 5 Day 1 Live Trading Results (April 15, 2026)

| Trade | Coin | PnL | Result |
|-------|------|-----|--------|
| 1 | dawg | -13.83% | SL (stop loss) |
| 2 | Shit And Piss 500 | +42.50% | TP L3 (take profit) |
| 3 | #dog | +50.69% | L2 grid exit |
| 4 | illustrator | +24.49% | L1 grid exit |
| 5 | Yes chad | +42.50% | TP L3 (take profit) |

**Live WR: 80% (4/5) | SOL P&L: +0.0224 SOL (+$1.90)**

## Live Trading Configuration

| Setting | Value |
|---------|-------|
| Position size | 0.05 SOL (~$4.25/trade) |
| Slippage | 500 bps (5%) for pump.fun tokens |
| Daily loss limit | 0.2 SOL (LIVE trades only) |
| Wallet | ESK3r8n5jhaLn9Few59QKNJ5UMeD9iqZ5p1rbU9euvey |
| Starting balance | 3.6705 SOL |
| Jupiter API | api.jup.ag/swap/v1 (quote + swap) |
| RPC | Helius mainnet |
| TX confirmation | Non-blocking async |

## Key Bugs Fixed During Live Transition

1. Jupiter V6 API dead → updated to V1 (api.jup.ag/swap/v1)
2. Webhook bypassing swarm → restored webhook entry path (proven)
3. Supabase Realtime silently dropping → replaced with 3s polling
4. Rug storm deadlock → 2-hour window instead of all-time
5. Daily loss limit counting paper losses → LIVE-only filter
6. Sell slippage too low (2%) → increased to 5% for pump.fun
7. TX confirmation blocking 30s → non-blocking async
8. Phantom balance API failing on CF edge → DexScreener SOL price
9. T1 solo buy blocked → removed confirmer requirement

## Tech Stack

- **Runtime**: Node.js + TypeScript (tsx)
- **Framework**: Next.js 16 (Cloudflare Pages)
- **Database**: Supabase (PostgreSQL)
- **Blockchain**: Helius enhanced webhooks (Solana)
- **Swaps**: Jupiter V1 aggregator + Helius RPC
- **Price feeds**: Jupiter Price API, DexScreener REST API
- **Rug detection**: RugCheck API
- **SOL price**: DexScreener (CoinGecko/Jupiter fail on CF edge)
- **Dashboard**: React + Tailwind CSS at /bot
- **Wallet**: Solana Keypair (bs58, @solana/web3.js)

## Restart Command

```bash
cd ~/PixiuBot && caffeinate -i npx tsx src/agents/run-all.ts
```

## Dashboard

Live at `https://pixiu-bot.pages.dev/bot`

Shows: SOL balance, real P&L, live/paper mode toggle, trade history, open positions with live PnL, whale status, grid progress, timeout countdown, signal feed.
