<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Multi-agent collaboration — read FIRST if Code and Codex are both active

If both **Claude Code** and **Codex** are building PixiuBot, read and obey
[`COLLAB.md`](COLLAB.md) before editing anything: claim files on its Lock Board
before editing (one writer per file), sync before writing, exact-file commits,
push immediately, and hand off via its append-only Handoff Log. This prevents
the concurrent-edit collisions that corrupt shared files.

**LOCKED build rules (binding on both agents):** obey
[`docs/ops/global-build-rules.md`](docs/ops/global-build-rules.md) — dynamic /
policy-driven / data-driven / fail-closed / evidence-based. No hardcoded wallets,
allowlists, denylists, or thresholds: values that can change must come from policy
/ config / source-of-truth tables, never source-code constants. Missing critical
data → fail closed + report, never guess.

# PixiuBot Architecture — read before touching entry logic

**As of Sprint 7 Day 3 (Apr 17 2026), there is ONE entry path.**

`src/app/api/webhook/route.ts` → `evaluateAndEnter()` is the **only**
place that inserts rows into the `trades` table. If you're
thinking about adding an entry guard, rejection check, or a second
insert site, add it there — not in the swarm.

## Runtime topology

| Component | Runtime | Role |
|---|---|---|
| `src/app/api/webhook/route.ts` | Cloudflare Edge | Helius webhook receiver; runs `evaluateAndEnter()` which owns **all 15 entry guards** and is the only code path that inserts `trades` |
| `src/agents/wallet-watcher.ts` | Node (local/DO) | Watches tracked wallets, writes to `coin_signals` table |
| `src/agents/trade-executor.ts` | Node | Polls `trades` every 3s, performs Jupiter swaps |
| `src/agents/risk-guard.ts` | Node | Polls open positions (L0 2s / L1+ 5s), handles exits, reaps phantom `open` rows. Runs even when bot STOPPED |
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
- `LIVE_BUY_SOL` (0.025 baseline) and `DAILY_LOSS_LIMIT_SOL` (0.50)
  live in `src/config/smart-money.ts`. The daily loss calc uses
  `SUM(LIVE_BUY_SOL × |pnl_pct| / 100)` — not count × size. Old
  logic overstated losses ~3.5×.
- **Elite sizing**: `ELITE_WALLET_TAGS` (theo pump sad, daniww) get
  `ELITE_BUY_SOL` (0.05, 2×) — resolve size via
  `getBuySolForWalletTag()`, matching the PRIMARY tag only. These are
  the only wallets net-positive on live `real_pnl_sol`. Trust live PnL
  for wallet selection, NOT external GMGN/Kolscan WR labels (jijo +
  Sheep were cut for exactly that — labels said 55/64%, real was
  28/20%).
- **Phantom rows**: the webhook inserts `status='open'` per passing
  signal; the executor only resolves them while LIVE. Stale phantoms
  (open + `entry_sol_cost` NULL + not `[LIVE]` + age > 15min) are
  reaped by risk-guard. Never write an unbounded `SELECT WHERE
  status='open'` — bound it to confirmed rows (2,107 phantoms once
  piled up and capped the guard query). See PLAYBOOK failure modes.
- `checkTokenSafety()` and `checkLpAndHolders()` can fail-open on
  network errors — intentional. Better to miss an entry than to
  entry-block the world when DexScreener is flaky.
- **Strategy reality**: copy-trading public smart money is −EV at our
  T+30s latency (snipers/copy-traders take the liquidity first). The
  exit/filter stack limits loss magnitude but can't fix the ~24% WR.
  Forward plan is the Limo Path in `docs/BACKLOG.md` / `ROADMAP.md`.
