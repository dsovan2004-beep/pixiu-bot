# PixiuBot

Autonomous Solana memecoin trading bot. Copies Smart Money wallet trades with a 6-agent swarm architecture, 10-layer entry filter pipeline, and automated risk management.

Paper trading only. Zero real SOL spent.

## Agent Swarm Topology

6-agent pipeline connected via Supabase Realtime broadcast channels:

```
Helius Webhook → coin_signals table
                      │
              Agent 1: Wallet Watcher
              coin_signals INSERT → pixiubot:signals
              748 wallets tracked via Helius enhanced webhooks
                      │
              Agent 2: Signal Validator
              pixiubot:signals → pixiubot:entries
              10-layer filter pipeline (see below)
                      │
              Agent 3: Price Scout
              pixiubot:entries → pixiubot:confirmed
              Price fetch + liquidity check + LP burn check
                      │
              Agent 4: Trade Executor
              pixiubot:confirmed → paper_trades
              Opens position with in-memory duplicate lock
                      │
              Agent 5: Risk Guard
              paper_trades polling every 5s
              CB → Whale → SL → Timeout → Grid exits
                      │
              Agent 6: Tier Manager
              paper_trades changes → auto-demote/promote T1/T2
```

## 10-Layer Entry Filter Pipeline

Every signal must pass all 10 layers before a trade opens:

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

Risk Guard checks open positions every 5 seconds in this order:

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

Tier Manager auto-demotes T1 wallets with WR < 50% on 3+ trades in 24h, and auto-promotes T2 wallets with WR > 65% on 5+ trades in 7 days.

## Sprint 3 Key Discoveries (April 14, 2026)

- Whale exit protecting from large losses (avg loss -24% reduced to -22%)
- Small losses (-0.49%, -2.63%) = system working correctly
- Fast whale exit = saves ~$7 per bad trade vs waiting for SL
- Expected value per trade: +20.72% (WR 62.5%, avg gain +46.44%, avg loss -22.16%)
- commotitties +570%, fatfilms +178%, Gas Town +164% = whale second wave strategy validated
- Cupsey best T1 addition: triggered fatfilms, glep, commotitties all winners
- Name cooldown fix saved -$148 (Pepe By Matt Furie x3 bug)
- 0.00% exit bug fixed: 30s minimum hold + price echo guard

## Sprint 3 Performance (April 14, 2026)

| Metric | Value |
|--------|-------|
| Starting bankroll | $10,000 |
| Peak bankroll | $12,170 (+21.70%) |
| Win rate | 62.5% |
| Avg gain | +46.44% |
| Avg loss | -22.16% |
| Total trades | 96 |

## Tech Stack

- **Runtime**: Node.js + TypeScript (tsx)
- **Framework**: Next.js 16 (Cloudflare Pages)
- **Database**: Supabase (PostgreSQL + Realtime)
- **Blockchain**: Helius enhanced webhooks (Solana)
- **Price feeds**: Jupiter Price API, DexScreener REST API
- **Rug detection**: RugCheck API
- **Dashboard**: React + Tailwind CSS at /bot

## Restart Command

```bash
cd ~/PixiuBot && caffeinate -i npx tsx src/agents/run-all.ts
```

## Dashboard

Live at `https://pixiu-bot.pages.dev/bot` — shows bankroll, win rate, open positions with live PnL, whale status, grid progress, timeout countdown, and signal feed.
