# PixiuBot

Autonomous Solana memecoin trading bot. Copies Smart Money wallet trades with a 6-agent swarm architecture, 10-layer entry filter pipeline, Jupiter V6 live swaps, and automated risk management.

## Current Status

| Sprint | Status | Summary |
|--------|--------|---------|
| Sprint 1-2 | COMPLETE | Webhook + paper trader monolith |
| Sprint 3 | COMPLETE | 6-agent swarm, 114 trades, 58.8% WR, $12,195 (+21.95%) |
| Sprint 4 | COMPLETE | Jupiter live swaps, dashboard toggle, safety audit passed |
| Sprint 5 | READY TO LAUNCH | Fund wallet + flip toggle |
| Recovery Goal | $3,325 — REACHED | $3,415 gross wins from $10K start |

## Architecture

6-agent swarm connected via Supabase Realtime broadcast channels:

```
Helius Webhook → coin_signals table
                      |
              Agent 1: Wallet Watcher
              coin_signals INSERT → pixiubot:signals
              748 wallets tracked (11 T1 + 698 T2)
                      |
              Agent 2: Signal Validator
              pixiubot:signals → pixiubot:entries
              10-layer filter pipeline
                      |
              Agent 3: Price Scout
              pixiubot:entries → pixiubot:confirmed
              Price + liquidity + LP burn + holder checks
                      |
              Agent 4: Trade Executor
              pixiubot:confirmed → paper_trades + Jupiter buy
              In-memory dedup lock + 60s DB guard
                      |
              Agent 5: Risk Guard
              paper_trades polling every 5s + Jupiter sell
              CB > Whale > SL > Timeout > Grid exits
                      |
              Agent 6: Tier Manager
              paper_trades changes → auto-demote/promote T1/T2
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

Demoted: Scharo (T1 → T2). Tier Manager auto-demotes at WR < 50% on 3+ trades in 24h, auto-promotes at WR > 65% on 5+ trades in 7d.

## 10-Layer Entry Filter Pipeline

| Layer | Filter | Location |
|-------|--------|----------|
| 1 | T1 Smart Money wallet required | Signal Validator |
| 2 | Confirming wallet required (any tier) | Signal Validator |
| 3 | Bundle detection (>80% from 1 wallet = skip) | Signal Validator |
| 4 | 2-min rug hold filter (buy+sell within 2min = skip) | Signal Validator |
| 5 | Stablecoin name filter (usd, dai, stable, etc.) | Signal Validator |
| 6 | Name-based cooldown 120min (same name, any address) | Signal Validator |
| 7 | Address-based cooldown 120min (same contract) | Signal Validator |
| 8 | Price fetch > 0 (Jupiter then DexScreener) | Price Scout |
| 9 | Liquidity > $10,000 USD (DexScreener) | Price Scout |
| 10 | LP burned + top10 holders < 80% (RugCheck) | Price Scout |

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

## Sprint 4 Features

- **Jupiter V6 swap integration** — real buy/sell via Jupiter aggregator
- **TX confirmation** — every swap confirmed on-chain before returning
- **Token balance fetch** — sellToken() queries real on-chain balance before selling
- **Daily loss limit** — 0.2 SOL ($17) cap, stops all live trades when hit
- **Dashboard toggle** — PAPER ONLY / LIVE TRADING button at pixiu-bot.pages.dev/bot
- **Safe defaults** — isLiveTrading() returns false on any DB failure
- **Per-position live check** — re-reads mode before each sell (no stale state)

## Sprint 4 Performance (April 14-15, 2026)

| Metric | Value |
|--------|-------|
| Starting bankroll | $10,000 |
| Current bankroll | $12,195 (+21.95%) |
| Win rate | 58.8% |
| Avg gain | +46.93% |
| Avg loss | -24.30% |
| Total trades | 114 |
| Recovery goal | $3,325 — REACHED |

## Sprint 5 Launch Steps

1. Fund Phantom wallet with $500 SOL to `ESK3r8n5jhaLn9Few59QKNJ5UMeD9iqZ5p1rbU9euvey`
2. Go to `https://pixiu-bot.pages.dev/bot`
3. Tap **PAPER ONLY** → **LIVE TRADING**
4. Monitor first 50 trades at 0.05 SOL/trade (~$4.25 each)
5. Daily loss limit auto-stops at 0.2 SOL ($17)

## Remaining Backlog

- Cloudflare Workers migration (24/7 uptime, no caffeinate)
- WebSocket price streaming (instant rug detection vs 5s polling)
- Telegram alerts (trade notifications)
- Grid partial live sells (currently only full close sells live)
- SOL price oracle for daily loss limit (currently hardcoded $85)

## Tech Stack

- **Runtime**: Node.js + TypeScript (tsx)
- **Framework**: Next.js 16 (Cloudflare Pages)
- **Database**: Supabase (PostgreSQL + Realtime)
- **Blockchain**: Helius enhanced webhooks (Solana)
- **Swaps**: Jupiter V6 aggregator + Helius RPC
- **Price feeds**: Jupiter Price API, DexScreener REST API
- **Rug detection**: RugCheck API
- **Dashboard**: React + Tailwind CSS at /bot
- **Wallet**: Solana Keypair (bs58, @solana/web3.js)

## Restart Command

```bash
cd ~/PixiuBot && caffeinate -i npx tsx src/agents/run-all.ts
```

## Dashboard

Live at `https://pixiu-bot.pages.dev/bot` — bankroll, win rate, open positions with live PnL, whale status, grid progress, timeout countdown, signal feed, and LIVE TRADING toggle.
