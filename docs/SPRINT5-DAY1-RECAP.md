# Sprint 5 Day 1 Recap — April 15, 2026

## Summary
First day of live trading with real SOL. Rough start with multiple bugs during simulation-to-live transition, but ended with a working end-to-end system: buy → grid exits → auto-sell → SOL returned.

## Live Trade Results

| # | Coin | PnL | Buy | Sell | Notes |
|---|------|-----|-----|------|-------|
| 1 | dawg | -13.83% | ✅ | ❌ (no tokens) | Buy dropped by Solana |
| 2 | Shit And Piss 500 | +42.50% | ✅ | ✅ (manual) | First confirmed win |
| 3 | #dog | +50.69% | ✅ | ✅ (manual) | Sell failed, manual recovery |
| 4 | illustrator | +24.49% | ✅ | ✅ (manual) | Manual sell recovered SOL |
| 5 | Yes chad | +42.50% | ✅ | ✅ | Auto-sell worked |
| 6 | The Shoe | -48.16% | ✅ | ❌ (rugged) | Rug in <30s, CB fired |
| 7 | Marvin Beak | +42.50% | ✅ | ❌ (no tokens) | Buy may not have landed |
| 8 | The Paw Pilots | +30.98% | ✅ | ✅ | Token 2022 fix — auto-sell worked! |
| 9 | Edward Warchocki | +397.47% | ✅ | ✅ | Best trade — auto-sell confirmed |
| 10 | Edward Warchocki #2 | +42.50% | ❌ (6001) | ❌ | Buy tx failed on-chain |
| 11 | House Republicans | +42.50% | ✅ | ✅ | L3 TP |
| 12 | Transhumanist | +2.52% | ✅ | ❌ | L0 sell bug (pre-fix) |
| 13 | The Happy Merchant | -6.80% | ✅ | ❌ | L0 sell bug (pre-fix) |
| 14 | loser | -48.49% | ✅ | ❌ | Rugged |
| 15 | PandaCoin | -11.44% | ✅ | ❓ | SL fired |
| 16 | trust me bro | -28.77% | ✅ | ✅ | CB fired, sell sent (timeout) |
| 17 | uncool | -17.32% | ❌ | ❌ | Buy didn't land, no tokens |
| 18 | Vibeshift | -10.26% | ✅ | ❌ (6001) | Sell slippage too low |

## Bugs Fixed During Day 1

1. **Jupiter V6 API dead** → updated to V1 (api.jup.ag/swap/v1)
2. **Webhook bypassing swarm** → restored webhook entry path
3. **Supabase Realtime dropping** → replaced with 3s polling
4. **Rug storm deadlock** → 2-hour window
5. **Daily loss limit USD** → counts trades × 0.05 SOL
6. **Daily loss limit lockout** → raised to 2.0 SOL
7. **Sell slippage too low** → 5% (now auto-escalating 5→10→20%)
8. **Token 2022 sell failure** → checks both SPL Token programs
9. **TX confirmation blocking** → non-blocking async
10. **Phantom balance API** → DexScreener SOL price
11. **STOP BOT not stopping** → checks is_running every poll
12. **Duplicate exits** → closingPositions Set
13. **L0 trades not selling** → sell fires for all [LIVE] trades
14. **T1 confirmer too restrictive** → solo T1 buy = enter
15. **Startup overrides STOP** → preserves existing bot_state
16. **Auto-slippage for sells** → escalates 5% → 10% → 20%

## SOL Balance

| Time | SOL | Event |
|------|-----|-------|
| Start | 3.6705 | Funded wallet |
| 9:52 AM | 3.6149 | dawg buy (-0.05) |
| 9:53 AM | 3.6929 | Shit And Piss 500 manual sell (+0.08) |
| 10:01 AM | ~3.64 | Multiple buys |
| 10:12 AM | ~3.58 | The Shoe rug (-0.05) |
| Daily limit lockout | Blocked | 10am-4pm — missed ~20 winning trades |
| 4:07 PM | ~3.58 | Paw Pilots sell (Token 2022 fix) |
| 4:56 PM | ~3.52 | Edward Warchocki +397% sell |
| End of day | 3.3633 | Multiple buys, some failed sells |

**Final: 3.3633 SOL (-0.3072 SOL / -$26)**
**Unsold tokens: ~$21 in wallet**
**Adjusted P&L: ~-$5**

## Key Lessons

1. Never disable working code — just add live buy on top
2. Daily loss limit must use actual SOL, not USD
3. pump.fun tokens use Token 2022 — need both program checks
4. Sell slippage needs to be higher than buy slippage
5. Solana drops transactions — non-blocking confirmation is essential
6. STOP BOT must actually stop all agents, not just the UI
