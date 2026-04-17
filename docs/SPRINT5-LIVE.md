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

## Day 2 Update (April 16, 2026)

Bot ran autonomously through a full session. Highlights:
- Wins: Broke Company +129.06% (whale exit), Airdrop +204.76% (whale exit)
- Losses: coin.ai -52.2% (CB fired correctly)
- Daily loss limit triggered mid-session, blocked further entries (working as designed)
- Surfaced 4 latent bugs — see [SPRINT5-DAY2-RECAP.md](./SPRINT5-DAY2-RECAP.md)

## Day 3 Update (April 17, 2026)

Overnight autonomous session surfaced two more P0-class bugs + shipped
infra. Real wallet down −1.63 SOL on the day (paper showed 64.2% WR but
many [LIVE]-tagged buys never actually landed). All fixed.

Headlines:
- 🐛 Phantom infinite-loop: 15 positions stuck `open`, guard polling
  "sell → 0 balance → revert to open" forever. Fixed in `risk-guard.ts` —
  zero balance now closes with locked PnL.
- 🐛 Jupiter 6024: sell retried 4 slippage levels uselessly (~4 min waste).
  Now bails immediately.
- 🛡️ Token-2022 extension filter at entry: blocks TransferFee/Hook/
  NonTransferable/PermanentDelegate mints before buying.
- 🛟 `sell-pumpfun.ts` — direct bonding-curve sell rescue script when
  Jupiter can't route.
- 📈 Missed a 140x on `airdropper` due to grid cap at +42.5% + buy
  never landing. Trailing-stop mode is the fix (not yet shipped).

See [SPRINT5-DAY3-RECAP.md](./SPRINT5-DAY3-RECAP.md) for full detail.

## Backlog (updated April 17)

**Done Day 2–3:**
- ✅ Atomic-claim + sell-then-credit in `risk-guard.ts`
- ✅ Recovered 8 stuck token bags, burned 2 orphans
- ✅ Bankroll reconciled (Day 2 −$91.77, Day 3 −$125.96)
- ✅ Late-confirm Jupiter buy rescue path
- ✅ Constants consolidation (`config/smart-money.ts`)
- ✅ Telegram alerts (code ready, setup pending)
- ✅ Phantom infinite-loop fix (zero-balance → close with locked PnL)
- ✅ Jupiter 6024 immediate bail
- ✅ Token-2022 extension filter at entry
- ✅ `sell-pumpfun.ts` direct bonding-curve rescue

**Still open:**

**P1 — reliability**
- [ ] Cosmetic log bug: SL/CB/TO log fires after `closeTrade()` returns
  early. Behavior correct, log is misleading.
- [ ] Jupiter 429 retry backoff (buy path)

**P2 — capture upside**
- [ ] Trailing stop after L3 (biggest alpha ask — airdropper 140x miss)
- [ ] Telegram setup in `.env.local` (TELEGRAM_BOT_TOKEN + CHAT_ID)
- [ ] Cloudflare Workers 24/7 uptime

**P3 — scaling**
- [ ] 0.10 SOL position size — only after one clean session:
  zero phantoms, zero stuck sells, WR > 55% on ≥20 real LIVE trades.
