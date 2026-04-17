<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# PixiuBot Architecture — read before touching entry logic

**As of Sprint 7 Day 3 (Apr 17 2026), there is ONE entry path.**

`src/app/api/webhook/route.ts` → `evaluateAndEnter()` is the **only**
place that inserts rows into the `paper_trades` table. If you're
thinking about adding an entry guard, rejection check, or a second
insert site, add it there — not in the swarm.

## Runtime topology

| Component | Runtime | Role |
|---|---|---|
| `src/app/api/webhook/route.ts` | Cloudflare Edge | Helius webhook receiver; runs `evaluateAndEnter()` which owns **all 15 entry guards** and is the only code path that inserts `paper_trades` |
| `src/agents/wallet-watcher.ts` | Node (local/DO) | Watches tracked wallets, writes to `coin_signals` table |
| `src/agents/trade-executor.ts` | Node | Polls `paper_trades` every 3s, performs Jupiter swaps |
| `src/agents/risk-guard.ts` | Node | Polls open positions every 5s, handles exits |
| `src/agents/tier-manager.ts` | Node | Demotes/promotes wallets T1↔T2 |

`src/agents/run-all.ts` starts the 4 node agents. **Do not** recreate
`signal-validator.ts` or `price-scout.ts` — they were deleted in
`7dbe342` because they produced log lines with zero enforcement
(their output channel `pixiubot:confirmed` had no subscribers).

## Edge-runtime constraints (webhook)

`route.ts` has `export const runtime = "edge"`. This means:
- **No node builtins** (`path`, `fs`, `Buffer`, `dotenv`).
- **No `supabase-server.ts`** — it transitively pulls `path`. Use the
  edge-compatible `createClient()` directly.
- **No `@solana/web3.js`** — use plain fetch to Helius RPC.
- Edge-safe APIs only: `fetch`, `atob`, `Uint8Array`, `DataView`,
  `AbortSignal.timeout()`.

Whenever you add a guard to `evaluateAndEnter()`, verify every import
chain is edge-safe. The CF build will reject node imports at deploy
time (not at dev-server time), so local `next dev` can pass and the
deploy still fail.

## Guard ordering inside `evaluateAndEnter()`

Cheap checks first, expensive network calls last. Current order is
intentional — if you reorder, the DB-per-signal cost goes up fast:

1. `bot_running` (DB, 1 row)
2. Stablecoin name filter (string compare)
3. Offensive name filter (string compare)
4. Rug storm (DB, ~5 rows)
5. Token-2022 extension filter (1 Helius RPC call)
6. Gap filter (arithmetic)
7. Position open (DB, count)
8. 120min address cooldown (DB, count)
9. 30min name cooldown (DB, count)
10. Smart money tier check (DB, 1 join)
11. Whale hold time (DB, count)
12. Bundle detection (in-memory map over already-fetched signals)
13. Price fetch (1 DexScreener call)
14. `isPriceTooHigh` (arithmetic)
15. `checkTokenSafety` (1 DexScreener call, cached 30s)
16. `checkLpAndHolders` (1 RugCheck call)

## Rejection logging convention

Every reject path logs exactly this format:

```ts
console.log(`  [WEBHOOK] ❌ ${coinName || mint.slice(0, 8)} — ${reason}`);
```

Two leading spaces, `[WEBHOOK] ❌`, then `${coin} — ${reason}`. Do not
invent new prefixes (`[FILTER]`, `[SKIP]`, `[VALIDATOR]` were all
normalized to `[WEBHOOK] ❌` in commit `2e41899`). CF tail-log
observability depends on this consistency.

## Live-trading safety rules

- `is_running` in `bot_state` is authoritative. Every entry path
  **must** check it. If you're adding a new entry path (you shouldn't
  — see above), add the check first.
- `LIVE_BUY_SOL` and `DAILY_LOSS_LIMIT_SOL` live in
  `src/config/smart-money.ts`. The daily loss calc uses
  `SUM(LIVE_BUY_SOL × |pnl_pct| / 100)` — not count × size. Old
  logic overstated losses ~3.5×.
- `checkTokenSafety()` and `checkLpAndHolders()` can fail-open on
  network errors — intentional. Better to miss an entry than to
  entry-block the world when DexScreener is flaky.
