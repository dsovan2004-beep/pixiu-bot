# Sprint 5 Day 3 Recap — April 17, 2026

## Summary
Long overnight session. Surfaced and fixed two P0-class bugs (phantom
infinite-loop + Jupiter 6024 futile retries), shipped a pump.fun direct-sell
rescue script, and added a Token-2022 extension filter to block sell-breaking
tokens at entry. Real wallet down on the day, mostly because of phantom
positions earlier in the run that never landed on-chain — now prevented
going forward.

## Headline Metrics

| Metric | Value |
|--------|-------|
| Session window | ~21:00 Apr 16 PDT → ~02:00 Apr 17 PDT (autonomous overnight) |
| Real SOL wallet | 3.6705 → 2.0434 (−1.6271 SOL, −$143) |
| Paper dashboard | 204 trades, 64.2% WR (131W/73L), avg gain +36.9%, avg loss −22.7% |
| On-chain stuck at end of session | 0 |
| Commits shipped | 3 (2bb9246, 1c0eeea, 10db69c) |

The paper vs real gap is because many [LIVE]-tagged buys never actually
landed on-chain — paper PnL piled up, real SOL did not. The Day 3 fixes
close that gap for future sessions.

## Bugs Fixed

### 1. Phantom infinite-loop (P0) — commit `2bb9246`
**Symptom:** 15 positions stuck `status=open` with `[LIVE]` tag. On every
5s guard poll, each fired its exit condition, tried to sell, Jupiter
returned "Token balance 0 — skipping sell", guard reverted status back to
`open` → repeat forever. Log filled with ~3 lines/sec per phantom; no SOL
lost but system was clogged.

**Root cause:** Day 2's "sell-then-credit" patch reverted status to `open`
whenever the sell returned null. It didn't distinguish between:
- Transient Jupiter failure (worth retrying) — tokens still held
- Token is GONE (rugged or already-sold partial) — retry is futile

**Fix (`src/agents/risk-guard.ts`):**
```
if (walletHolds(mint) === 0) {
  // Token is gone. Close with locked PnL; do NOT revert to 'open'.
  if (grid_level > 0) close at partial_pnl   // profits already banked
  else              close at current pnlPct  // rug loss
}
// Only revert to 'open' when tokens are actually held but Jupiter rejected.
```

Also shipped: one-time cleanup script (`cleanup-phantom-positions.ts`) that
closed the 15 phantoms with correct locked-PnL accounting. Bankroll delta:
−$125.96 (rug losses banked, L1/L2 profits preserved).

### 2. Jupiter error 6024 retries were useless (P1) — commit `1c0eeea`
**Symptom:** Jude Zero G Indicator sell failed at 5% / 10% / 20% / 30%
slippage, all with on-chain error 6024. Each attempt cost ~60s of
confirmation waiting, total ~4 min of wasted retries before giving up.

**Root cause:** `jupiter-swap.ts` treated only 6001 (slippage exceeded)
as "bail & retry higher" — every other on-chain error fell through to the
next slippage level anyway.

**Fix:** bail immediately on 6024. Log clear message, return null, let the
guard handle it.

### 3. Token-2022 sell-breaking extensions not filtered (P1) — commit `1c0eeea`
**Symptom:** pump.fun is seeing more tokens with transfer-fee / transfer-hook /
non-transferable / permanent-delegate extensions. These cannot be swapped
reliably via Jupiter.

**Fix (`src/agents/price-scout.ts`):** before price fetch, inspect the mint
account. If it's owned by the Token-2022 program AND its TLV extensions
include any of: TransferFeeConfig (1), NonTransferable (9), PermanentDelegate
(12), TransferHook (14) — block entry with log `[SCOUT] Blocked Token-2022
transfer fee token: X`.

**Caveat:** smoketest against Jude's mint shows only MetadataPointer (18) +
TokenMetadata (19) — both benign. So Jude's 6024 was NOT actually a
Token-2022 transfer fee. More likely a pump.fun bonding-curve state issue
(pool imbalance or mid-migration). The filter still helps — real
fee/hook tokens are growing on pump.fun — but it's not the cure for
Jude-style failures specifically.

### 4. pump.fun direct-sell rescue (P2) — commit `10db69c`
**Why:** When Jupiter truly can't route a pump.fun token (pre-graduation
bonding curve weirdness, 6024, etc.), we had no escape hatch.

**Ship:** `src/scripts/sell-pumpfun.ts`. Calls pump.fun's `sell` instruction
directly, bypassing Jupiter. Auto-detects Token vs Token-2022 program.
Checks the bonding curve `complete` flag; if already graduated to Raydium,
bails with a clear message pointing back to Jupiter.

**Tested today:**
- Jude (6024 case): Jupiter's later retries actually landed first, so
  `sell-pumpfun.ts` wasn't needed — wallet was already empty. Script
  correctly reported "No tokens to sell."
- 8NwtzwGm... (graduated orphan): script correctly detected
  graduation-to-Raydium and bailed. Ran Jupiter on it instead — sold on
  first try at 5%.

## Strategy Observation — Missed Airdropper 140x

`airdropper` went from $0.0000148 entry to roughly $0.002 peak
(~140x / +14,000%). Grid design captures at most **+42.5% weighted**:

| Level | Sell % | at PnL | Banked contribution |
|-------|--------|--------|----------------------|
| L1 | 50% | +15% | +7.5% |
| L2 | 25% | +40% | +10.0% |
| L3 | 25% | +100% | +25.0% |
| **Total** | 100% | — | **+42.5% (fully out)** |

Once L3 fires at +100%, 0% remaining — we can't ride further. A 140x token
pays for dozens of losing trades, but the current strategy caps us at
+42.5%.

Also: Day 3's phantom bug means even the +42.5% paper profit on airdropper
wasn't real — the buy never landed on-chain.

Proposal (not yet implemented — P2 in backlog):
```
L1 +15% → sell 25% (less aggressive)
L2 +40% → sell 25%
L3 +100% → sell 25%
REMAINING 25% → trailing stop at −30% from peak
```
On a 140x run: 75% grid-sold for ~+32% banked, last 25% rides to peak,
trails out at +98x. Net ~100x better on moonshots, near-zero worse on
standard trades.

## Updated Backlog

**Done this session:**
- ✅ Phantom infinite-loop fix (`risk-guard.ts` — zero-balance → close with locked PnL)
- ✅ One-time cleanup of 15 phantoms (bankroll: −$125.96 adjustment)
- ✅ Jupiter 6024 bail (no more 4-slippage futility)
- ✅ Token-2022 extension filter at entry (TransferFee/Hook/NonTransferable/PermanentDelegate)
- ✅ `sell-pumpfun.ts` direct bonding-curve rescue script

**Still open:**

**P1 — reliability**
- [ ] Cosmetic log bug: "stop loss | PnL: X%" log line fires even when
  `closeTrade()` returned early due to sell failure. Confusing in logs
  but behavior is correct. Fix: return a boolean from `closeTrade()` and
  gate the SL/CB/TO logs on it.
- [ ] Jupiter 429 retry backoff (buy path) — still occasional noise

**P2 — capture upside**
- [ ] Trailing stop after L3 (biggest alpha opportunity — see airdropper
  140x miss). Requires tracking `highest_price_seen` per position.
- [ ] Telegram setup — code ready (`src/lib/telegram.ts`), needs
  `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in `.env.local`.
- [ ] Cloudflare Workers migration for 24/7 uptime.

**P3 — scaling**
- [ ] Re-enable 0.10 SOL position size after one clean session
  (zero phantoms, zero stuck sells, WR > 55% on ≥20 real LIVE trades).

**Deferred / won't-fix**
- Jude's 6024 root cause (pump.fun bonding-curve state, not Token-2022)
  — not reproducible in general, manifests per-mint. `sell-pumpfun.ts`
  is the rescue path.

## Key Lessons (Day 3)

1. **Every auto-retry path needs an escape hatch.** The phantom loop was
   caused by retry logic that couldn't recognize "token is just gone."
2. **Distinguish error classes before retrying.** 6001 and 6024 look
   similar in the logs but have totally different resolution paths.
3. **Paper WR ≠ real WR.** Dashboard showed 64.2% WR, wallet was down −1.63
   SOL. Phantom positions inflate the numerator. Now fixed at the source.
4. **Grid strategies leave moonshots on the table.** That's a tradeoff
   you pick deliberately, not a bug. Worth considering a partial-ride
   approach for the next sprint.

## Files Changed This Session

```
src/agents/risk-guard.ts              (phantom-loop fix + locked-PnL close)
src/agents/price-scout.ts             (Token-2022 extension filter)
src/lib/jupiter-swap.ts               (6024 bail + hasTokenBalance export)
src/scripts/cleanup-phantom-positions.ts  (one-time cleanup, uses locked-PnL)
src/scripts/sell-pumpfun.ts           (NEW — direct bonding-curve sell rescue)
src/scripts/smoketest-transfer-fee.ts (NEW — T22 extension walker)
```
