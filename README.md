# PixiuBot

Autonomous Solana memecoin trading bot. Copies Smart Money wallet trades with a 6-agent swarm architecture, 9-layer entry filter pipeline, Jupiter V1 live swaps, and automated risk management.

**Now trading LIVE with real SOL.**

## Current Status

| Sprint | Status | Summary |
|--------|--------|---------|
| Sprint 1-2 | COMPLETE | Webhook + paper trader monolith |
| Sprint 3 | COMPLETE | 6-agent swarm, 131 trades, 56.5% WR, $11,325 (+13.26%) |
| Sprint 4 | COMPLETE | Jupiter live swaps, dashboard toggle, safety audit |
| Sprint 5 Day 1 | COMPLETE | 4/5 wins (80% WR), +0.0224 SOL gross — 16 transition bugs fixed |
| Sprint 5 Day 2 | **LIVE** | Autonomous run, +129% / +205% whale exits; 4 latent bugs logged |
| Recovery Goal | $3,325 — REACHED | $3,971 gross wins from $10K paper start |

## Architecture

Hybrid architecture: webhook handles entries (proven path), swarm handles live buys + exits.

```
Helius Webhook → coin_signals table → evaluateAndEnter() → paper_trades
                                                                |
                                              Agent 4: Trade Executor
                                              Polls paper_trades every 3s
                                              New trade found → Jupiter buy → [LIVE] tag
                                                                |
                                              Agent 5: Risk Guard
                                              Polls positions every 5s
                                              CB > Whale > SL > TO > Grid → Jupiter sell
                                                                |
                                              Agent 1: Wallet Watcher
                                              Polls coin_signals every 3s (backup)
                                                                |
                                              Agent 6: Tier Manager
                                              Auto-demote/promote T1/T2 wallets
```

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

## 9-Layer Entry Filter Pipeline

T1 solo buy = enter (no confirmer required since Sprint 5).

| Layer | Filter | Location |
|-------|--------|----------|
| 1 | T1 Smart Money wallet required | Webhook + Validator |
| 2 | Rug storm detection (3/5 losses in 2h = pause 30min) | Entry Guards |
| 3 | Stablecoin name filter (usd, dai, stable, etc.) | Webhook + Validator |
| 4 | Address-based cooldown 120min | Webhook + Validator |
| 5 | Name-based cooldown 120min (blocks same-name scams) | Webhook + Validator |
| 6 | Bundle detection (>80% from 1 wallet = skip) | Webhook + Validator |
| 7 | 2-min rug hold filter (buy+sell within 2min = skip) | Webhook + Validator |
| 8 | Price fetch > 0 (Jupiter then DexScreener) | Webhook |
| 9 | Liquidity > $10,000 USD + LP burned + top10 holders < 80% | Webhook |

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

## Open Backlog (April 16, 2026)

See [docs/SPRINT5-DAY2-RECAP.md](docs/SPRINT5-DAY2-RECAP.md) for full context.

**Done today:**
- ✅ Atomic-claim + sell-then-credit in `risk-guard.ts` (no more double-sell / double-credit)
- ✅ Recovered 8 stuck token bags + bankroll reconciled (-$91.77)
- ✅ Late-confirm rescue path for Jupiter buy timeouts (`trade-executor.ts`)
- ✅ Single source of truth for sizing/limit constants (`config/smart-money.ts`)
- ✅ Telegram alerts (`src/lib/telegram.ts`) — set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` to enable

**Remaining:**
- **P2** Jupiter 429 retry backoff (buy path)
- **P2** Cloudflare Workers migration for 24/7 uptime
- **P3** Scale to 0.10 SOL after 20 clean trades at 0.05 with WR > 55%

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
