# Sprint 5 — Live Trading Launch

**Date**: April 15, 2026
**Status**: LIVE AND PROFITABLE

## First Live Trades

| # | Coin | Entry | Exit | PnL | Reason | Jupiter |
|---|------|-------|------|-----|--------|---------|
| 1 | dawg | $0.0000323 | $0.0000279 | -13.83% | SL | Buy confirmed, sell skipped (no tokens) |
| 2 | Shit And Piss 500 | $0.0000134 | $0.0000288 | +42.50% | TP L3 | Buy confirmed, auto sell failed (2% slippage), manual sell recovered SOL |
| 3 | #dog | $0.0000131 | $0.0000306 | +50.69% | L2 | Buy landed |
| 4 | illustrator | $0.0000417 | $0.0000559 | +24.49% | L1 | Buy confirmed, manual sell recovered SOL |
| 5 | Yes chad | $0.0000100 | $0.0000235 | +42.50% | TP L3 | Buy confirmed |

**Result: 4/5 wins (80% WR), +0.0224 SOL (+$1.90)**

## What Went Wrong During Transition

The paper-to-live transition was painful. Multiple issues cascaded:

1. **Webhook disabled** — I disabled the webhook's evaluateAndEnter() to route through the swarm. But the swarm depended on Supabase Realtime which silently dropped. No trades entered for hours.

2. **Jupiter V6 API dead** — quote-api.jup.ag domain doesn't resolve. All live buys silently failed. Discovered by running a real test buy.

3. **Rug storm deadlock** — Old losses stayed in the "last 5" forever because no new trades could enter. Created a permanent block on all entries.

4. **Daily loss limit counted paper losses** — $772 in paper losses exceeded the 0.2 SOL limit, blocking all live buys.

5. **Sell slippage too low** — 2% slippage caused error 6001 on pump.fun token sells. Increased to 5%.

6. **Multiple CF edge incompatibilities** — cache: "no-store" not supported, Jupiter/CoinGecko price APIs blocked from CF Workers.

## What Fixed It

**Restored the proven path:**
- Webhook evaluateAndEnter() re-enabled (the code that made money on paper)
- Trade executor simplified to poll for new trades and fire Jupiter buy
- Watcher switched from Realtime to 3s polling
- Rug storm limited to 2-hour window
- Slippage increased to 5%
- Jupiter API updated to V1

**Key lesson:** Never disable working code. Just add the live buy layer on top.

## Current Configuration

- Position size: 0.05 SOL (~$4.25)
- Slippage: 500 bps (5%)
- Daily loss limit: 0.2 SOL (LIVE trades only)
- T1 solo buy: enabled (no confirmer needed)
- Wallet: ESK3r8n5jhaLn9Few59QKNJ5UMeD9iqZ5p1rbU9euvey
- Starting balance: 3.6705 SOL ($310)

## Architecture (Final)

```
Helius push → Cloudflare webhook → inserts coin_signals + evaluateAndEnter()
                                          ↓
                                    paper_trades (open)
                                          ↓
                              Trade Executor (polls 3s)
                              Detects new trade → Jupiter buy → [LIVE] tag
                                          ↓
                              Risk Guard (polls 5s)
                              Exit triggered → Jupiter sell → SOL returned
```

## Next Steps

- [ ] Monitor 20-30 more trades at 0.05 SOL
- [ ] If WR > 55% on live trades → increase to 0.10 SOL
- [ ] Automate sell retry for failed Jupiter sells
- [ ] Cloudflare Workers migration for 24/7 uptime
- [ ] Telegram alerts for trade notifications
