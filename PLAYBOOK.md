# PixiuBot Playbook

Operational runbook. If you're modifying entry logic, guards, exit
priority, or deploy paths — read this first.

For project conventions (edge runtime quirks, guard order rationale,
and the nextjs-version warning) see `AGENTS.md`.
For where we are and what's next: `ROADMAP.md` + `docs/BACKLOG.md`.
For change history: `docs/JOURNAL.md` + `docs/SPRINT*-RECAP.md`.

---

## Purpose

One-stop runbook for operating and modifying PixiuBot. The intent is
that a fresh contributor (or Claude instance) can get productive here
without reading the full git history.

---

## The Golden Rule: one entry path

**As of Sprint 7 Day 3 (Apr 17 2026), there is exactly one place that
inserts rows into `paper_trades`: `src/app/api/webhook/route.ts` inside
`evaluateAndEnter()`.**

Before this rule, the code had two entry paths — the Cloudflare edge
webhook and a Node-side `signal-validator → price-scout` pipeline. The
two drifted out of sync and caused bypass losses (The Bull −60.61%, 千鳥
−44.66%, dogwifbeanie −37.71% all opened while `is_running=false`).
The dual path is gone; the validator and scout agents are deleted.

If you're about to add a new entry guard, put it in
`evaluateAndEnter()`. If you're about to add a new entry path — stop
and solve the problem differently.

---

## Architecture at a glance

### Runtime topology

| Component | Runtime | Role |
|---|---|---|
| `src/app/api/webhook/route.ts` | Cloudflare Edge | Helius webhook receiver; runs `evaluateAndEnter()` — owns all 15 entry guards and is the only code path that inserts `paper_trades` |
| `src/agents/wallet-watcher.ts` | Node (local or DO) | Watches tracked wallets, writes to `coin_signals` table |
| `src/agents/trade-executor.ts` | Node | Polls `paper_trades` every 3s, performs Jupiter swaps, tags `[LIVE]` |
| `src/agents/risk-guard.ts` | Node | Polls open positions every 5s, fires exits |
| `src/agents/tier-manager.ts` | Node | Demotes/promotes tracked wallets T1↔T2 |

`src/agents/run-all.ts` is the node-side swarm entry point. It starts
those 4 agents and nothing else.

### Edge / node boundary

Everything that runs in Cloudflare workers (edge):
- `/api/webhook`, `/api/settings`, `/api/phantom-balance`, `/bot` page.

Everything else (including the swarm, one-shot scripts in
`src/scripts/`, backfill tools) is Node. Don't mix.

---

## Entry guard order (15 steps)

Order is intentional: cheap string/arithmetic checks first, DB reads
next, network calls last. Reordering drives cost-per-signal up fast —
every signal that survives step N pays for steps 1..N.

| # | Guard | Cost | Reject reason string |
|---|---|---|---|
| 1 | `bot_running` (dashboard STOP honored) | 1 DB row | `bot_stopped` |
| 2 | Stablecoin name filter | string compare | `stablecoin name filter: ${coinName}` |
| 3 | Offensive name filter | string compare | `offensive name filter: ${coinName}` |
| 4 | Rug storm (3/5 closed losses in 2h) | DB, ~5 rows | `rug_storm_active` |
| 5 | Token-2022 extension filter | 1 Helius RPC | `token_2022_${ext}` |
| 6 | Gap filter (webhook lag) | arithmetic | `gap ${gapMinutes}m > ${MAX_GAP_MINUTES}m` |
| 7 | Position already open | DB count | `position already open` |
| 8 | 120min address cooldown | DB count | `recently traded (120min cooldown, same address)` |
| 9 | 30min name cooldown | DB count | `recently traded same name (30min cooldown): ${coinName}` |
| 10 | T1 Smart Money required (tier=1) | DB join | `no T1 Smart Money ...` |
| 11 | Whale hold time (2min sell-after-buy) | DB count | `quick_sell_${wallet}` |
| 12 | Bundle detection (≥80% from one wallet, ≥3 signals) | in-memory | `bundle (${tag} = ${count}/${totalSigs})` |
| 13 | Price fetch success | 1 DexScreener call | `price fetch failed (source: ${source})` |
| 14 | `isPriceTooHigh` ($0.001 max) | arithmetic | `price too high: $${price}` |
| 15 | `checkTokenSafety` — liq ≥ $10k, fdv ≥ $10k, m5 ≥ −20% | 1 DexScreener call (30s cache) | `token_unsafe: ${safety.reason}` |
| 16 | `checkLpAndHolders` — LP burned + top10 ≤ 80% | 1 RugCheck call | `LP not burned (rug risk)` or `top10 holders >80% (developer cluster)` |

(There are 15 entry gates plus the final DB insert error path, which
also logs in the standard format.)

### Why this order

- Steps 1–4 are free or near-free. They should short-circuit the
  noisiest rejections (STOP button, stablecoin spam, obvious rugs).
- Steps 5–12 are DB-bound. They're cheap enough to run before we
  decide the signal is worth a network call, but they need `coin_name`
  and wallet tags which the earlier string filters have already
  validated.
- Steps 13–16 are the expensive network path. They run only when a
  signal has passed the whole pipeline — roughly 1 in ~30 at current
  signal volume.

**Do not reorder without a reason.** If you add a new guard, put it
next to its peers by cost class and document why.

---

## Rejection logging convention

Every `return { entered: false, reason }` path in `evaluateAndEnter()`
logs exactly this format before the return:

```ts
console.log(`  [WEBHOOK] ❌ ${coinName || mint.slice(0, 8)} — ${reason}`);
```

Two leading spaces, `[WEBHOOK] ❌`, coin name (or first 8 chars of the
mint if name is missing), em-dash, then the reason. This format is
load-bearing — operational grep recipes depend on it.

**Do not invent new prefixes.** Previous drifts (`[FILTER]`, `[SKIP]`,
stale `[VALIDATOR]`) were normalized to `[WEBHOOK] ❌` in commit
`2e41899`.

### Grep recipes

Tail CF logs for recent rejections:

```bash
npx wrangler pages deployment tail --project-name=pixiu-bot \
  | grep "\[WEBHOOK\]"
```

Count reject reasons over a session (CF dashboard log export):

```bash
grep "\[WEBHOOK\] ❌" cf-logs.txt \
  | sed -E 's/.*— ([^ ]+).*/\1/' \
  | sort | uniq -c | sort -rn
```

Expected top reasons on a healthy run:
- `no T1 Smart Money ...` (most signals are T2-only)
- `position already open` (duplicate signals on active trades)
- `120min cooldown (address)` (retry on recently-traded mints)
- `bundle (…)` (coordinated pump detection)

---

## Edge-runtime constraints

`src/app/api/webhook/route.ts` declares `export const runtime = "edge"`.
That binds every import transitively to the Cloudflare Workers runtime.

### Banned

- Node builtins: `path`, `fs`, `buffer`, `crypto` (use WebCrypto),
  `dotenv`, `os`, `child_process`.
- `src/lib/supabase-server.ts` — it pulls `path` transitively via
  `dotenv`. Use the edge-safe `createClient()` directly instead.
- `@solana/web3.js` — verified not used by any edge route as of Sprint
  7 D3. Don't be the first. Use plain fetch to Helius JSON-RPC.
- `src/lib/entry-guards.ts` — orphaned after Sprint 7; scheduled for
  removal. Do not import.

### Approved

- `fetch`, `Request`, `Response`, `URL`, `URLSearchParams`.
- `atob`, `btoa`, `TextEncoder`, `TextDecoder`.
- `Uint8Array`, `DataView`, `ArrayBuffer`.
- `AbortController`, `AbortSignal.timeout()`.
- In-memory `Map` / `Set` caches at module scope (survive across
  invocations within the same worker instance — not globally).

### How to verify before deploy

1. `git grep -nE "from [\"'].*supabase-server|@solana/web3|node:" src/app/api/webhook/`
   should return nothing.
2. Check every new import chain by reading each file you pull from.
   Transitive Node imports are the usual killer (see the `0ac8725`
   failure — imported `entry-guards` which imported `supabase-server`
   which imported `dotenv` which pulled `path`).
3. The CF build only fails at deploy, not at `next dev`. Assume green
   locally = nothing.

---

## Exit priority (risk-guard)

`risk-guard.ts` polls open positions every 5 seconds. On each tick,
per position, in order — first match wins:

```
0a. Minimum hold time (30s)  — skip all except CB
0b. Rug detection            — price=0 after 2min → exit at -100%
 1. Circuit Breaker           — pnlPct ≤ -25% → emergency full exit
 1b. Price echo guard         — pnlPct === 0.00% → skip (wait for real move)
 2. Whale Exit                — confirming T1 wallet SELL → exit with whale
 3. Stop Loss                 — pnlPct ≤ -10% → full exit
 4. Timeout                   — held > 20min → full exit
 5. Grid Levels:
    L1 +15%  → sell 50% (break-even lock)
    L2 +40%  → sell 25%
    L3 +100% → trailing stop mode (replaces old sell-25%-at-L3);
               hold until peak drop ≥ 20%, then full exit
 6. Zero-balance close        — wallet has 0 tokens → lock PnL and close
                                (phantom position rescue)
```

### Atomic-claim pattern

Guard uses `UPDATE paper_trades SET status='closing' WHERE id=X AND
status='open' RETURNING *` to claim a row before selling. If zero rows
return, another poll beat us — skip. After Jupiter sell confirms,
`UPDATE ... SET status='closed' WHERE id=X AND status='closing'`.

### Idempotent close

The close UPDATE uses `.eq("status", "closing").select().maybeSingle()`.
If zero rows come back, do not credit the bankroll — another path
already did. This prevents the double-credit seen on Deep Fucking Value
before commit `9e83741`.

---

## Daily loss accounting

`src/config/smart-money.ts` defines `DAILY_LOSS_LIMIT_SOL` (currently
`3.0`). The guard halts entries for the UTC day if today's realized
loss exceeds it.

**Formula (commit `8bac7c5`):**

```ts
dailyLossSol = SUM(LIVE_BUY_SOL × |pnl_pct| / 100) for today's closed losses
```

Not `count × LIVE_BUY_SOL`. The old logic overstated actual SOL loss
by ~3.55× on observed data — verified by `src/scripts/verify-daily-loss.ts`.

`LIVE_BUY_SOL` (also `smart-money.ts`) is the per-trade position size.
Currently `0.05`. Any bump to `0.10` must scale `DAILY_LOSS_LIMIT_SOL`
proportionally.

---

## Live-trading safety rules

1. **`is_running` is authoritative.** Every entry path must check
   `bot_state.is_running` before inserting `paper_trades`. Currently
   that's one path (webhook). If you ever add another — check it
   first, then write the code.
2. **Do not skip the check under any optimisation.** The bypass
   commits (`0ac8725`, `8772d39`) exist because we lost the habit.
3. **Fail-open vs fail-closed policy:** DexScreener / RugCheck /
   Helius RPC outages → fail-open (allow entry). Better to miss a
   guard during a provider outage than block every signal. **Except**:
   `is_running`, `rug_storm`, `position already open`, `cooldown`,
   `daily_loss_limit` — these are DB-local and must never fail-open.
4. **No `console.log` of secrets.** Wallet keys live in `.env.local`
   and `SUPABASE_SERVICE_ROLE_KEY` must not appear in any log.
5. **Webhook POST body is untrusted.** Validate mint / wallet / name
   shape before using them in DB queries or URL interpolation.

---

## Runbook: restart swarm

Local (Mac):

```bash
# Stop current process (Ctrl+C on the terminal running it)
# Graceful shutdown sets bot_state.is_running = false
cd ~/PixiuBot && caffeinate -i npx tsx src/agents/run-all.ts
```

Banner must read `All 4 agents running.` — if it says anything else,
the build hit a stale import. `git pull` and retry.

Post-restart checks:
1. Dashboard at https://pixiu-bot.pages.dev/bot shows `RUNNING` (or
   `STOPPED` if you left it stopped — `run-all.ts` preserves the
   prior state on boot, commit `88…` behavior).
2. `[WATCHER]` log lines appear within 10s.
3. `[EXECUTOR] Polling for new trades every 3s` visible.

---

## Runbook: deploy webhook (CF)

Webhook deploys automatically on push to `main` via Cloudflare's git
integration. No manual `wrangler deploy` needed.

1. Commit + `git push origin main`.
2. Watch CF dashboard build log. Success ends with
   `Success: Your site was deployed!`.
3. Verify webhook bundle size sanity (last known: ~491 KB). Sudden
   jumps usually mean an accidental Node import slipped in.
4. Hit `https://pixiu-bot.pages.dev/api/webhook` with a GET — should
   return a short health/405 response fast (<200ms).

Rollback: revert the offending commit, push. CF redeploys in ~2min.

---

## Runbook: emergency STOP

Two mechanisms, any of which stops entries:

1. **Dashboard STOP button** — flips `bot_state.is_running = false`.
   Webhook honors it within the next signal; executor stops buying
   within one 3s poll.
2. **Supabase direct update** — if the dashboard is down:
   ```sql
   UPDATE bot_state SET is_running = false, last_updated = now();
   ```

Open positions continue to exit via risk-guard regardless — STOP
halts new entries, not exits.

To also halt the swarm itself: Ctrl+C the `run-all.ts` process. The
SIGINT handler sets `is_running=false` and cleanly exits.

---

## Runbook: bankroll reconcile

Paper bankroll (in `paper_bankroll`) and real SOL wallet drift over
time — phantoms, partial fills, rescue sells outside the bot.

1. `src/scripts/phantom-balance.ts` — reads real on-chain wallet
   balance.
2. Compute delta vs. `paper_bankroll.current_balance`.
3. Apply the delta as a single UPDATE with a reason string:
   ```sql
   UPDATE paper_bankroll
   SET current_balance = current_balance + <delta>,
       last_updated = now(),
       reconcile_note = '<reason>';
   ```
4. Log the reconcile in `docs/JOURNAL.md` with the date, delta SOL,
   delta USD, and reason.

---

## Runbook: recover stuck position

If a position shows `status=open` for > 30 minutes with no exit
attempts in the log:

1. Check wallet balance for that mint:
   `src/scripts/phantom-balance.ts <mint>`.
2. If balance > 0 — Jupiter couldn't route. Try
   `src/scripts/sell-pumpfun.ts <mint>` for pump.fun bonding-curve
   direct sell, or `src/scripts/sell-all-orphans.ts` for bulk.
3. If balance = 0 — the sell happened but the close UPDATE failed.
   Force-close:
   ```sql
   UPDATE paper_trades
   SET status='closed', exit_time=now(),
       exit_reason='manual_recovery',
       pnl_pct=<computed from actual sell>
   WHERE id = <id>;
   ```
4. Log in `docs/JOURNAL.md` with trade ID, mint, recovery method,
   and PnL delta.

---

## Known failure modes + how we fixed them

Lessons-learned archive. Add to this list when you ship a fix whose
mechanism generalises. Don't repeat these mistakes.

### Webhook bypass of `is_running` (Sprint 7, commit `8772d39`)

**Symptom:** bot showed `STOPPED` on dashboard, but new `paper_trades`
rows kept appearing with `[LIVE]` tag. The Bull −60.61%, 千鳥 −44.66%,
dogwifbeanie −37.71% all opened during a dashboard STOP.

**Root cause:** webhook's `evaluateAndEnter()` never checked
`bot_state.is_running`. Only the swarm-side executor did. So the
dashboard STOP button halted execution but not entry — the bot kept
filling up `paper_trades` until executor came back on.

**Fix:** inline `webhookIsBotRunning()` helper at the top of
`evaluateAndEnter()` — step 1 of 15 in the guard order.

**Generalised lesson:** every entry path must check `is_running`.
The Golden Rule exists because of this bug. If you're tempted to
add a second entry path, you are tempted to rediscover this bug.

### Dead code drift — validator + scout (Sprint 7, commit `7dbe342`)

**Symptom:** bugfixes landed in `signal-validator.ts` and
`price-scout.ts` for months, but real behavior didn't change. Guards
drifted between the three implementations (validator vs scout vs
webhook) in ways no one tracked.

**Root cause:** the `pixiubot:entries → pixiubot:confirmed` broadcast
path that fed scout's output into execution had been broken since
Supabase Realtime dropped — replaced with polling of `paper_trades`
in commit `d59053e`. Nobody removed the validator/scout pipeline.
They kept logging like they were enforcing, but weren't.

**Fix:** grep-verified that `pixiubot:confirmed` had zero subscribers;
deleted both files (−577 lines); migrated their guards into webhook.

**Generalised lesson:** if a module produces log lines that look
active but don't insert into `paper_trades`, don't trust the logs —
trace the actual write path end-to-end. Broadcast channels are
especially easy to silently orphan.

### CF Edge build break from transitive Node imports (commit `0ac8725` → `e888c5e`)

**Symptom:** `0ac8725` imported `isRugStorm` from
`src/lib/entry-guards.ts`, which imported `supabase-server.ts`, which
imported `dotenv`, which pulled `path`. Edge runtime rejected `path`.
CF build failed. Webhook was down for ~10 minutes during the revert.

**Root cause:** locally, `next dev` didn't flag the transitive import.
The failure only surfaced at CF deploy time.

**Fix:** `e888c5e` inlined a `webhookIsRugStorm()` helper in
`route.ts` with its own edge-safe Supabase client. The shared
`entry-guards.ts` is not importable from edge code.

**Generalised lesson:** before any commit that adds an import to
`route.ts`, trace every transitive dependency. The edge-safety
verification list in the "Edge-runtime constraints" section above
is the checklist. Don't rely on `next dev` — it lies.

### Daily-loss counter overstated losses ~3.5× (commit `8bac7c5`)

**Symptom:** bot halted early on losing days even when real SOL
loss was well under `DAILY_LOSS_LIMIT_SOL`. Overnight Apr 16, halted
after ~0.6 SOL actual loss when limit was 2.0.

**Root cause:** counter was `count × LIVE_BUY_SOL`, not
`SUM(LIVE_BUY_SOL × |pnl_pct|/100)`. A −5% loss was accounted as a
full 0.05 SOL loss instead of 0.0025 SOL.

**Fix:** recompute with the per-trade realized loss. Verified
3.55× overstatement against live DB via `verify-daily-loss.ts`.

**Generalised lesson:** when a counter drives a kill-switch, derive
it from the same numbers you'd use to compute actual P&L. Never
proxy.

---

## What NOT to do

- **Do not add a second entry path.** Golden Rule. Put it in
  `evaluateAndEnter()` or solve the problem differently.
- **Do not skip `is_running`.** Every entry path checks it first.
- **Do not invent a new log prefix.** `[WEBHOOK] ❌` is the format.
- **Do not commit anything that raises the edge bundle size > 600 KB
  without explaining why.** Usually means a Node module snuck in.
- **Do not raise position size without passing the gate.** See
  `ROADMAP.md` — 48h clean + WR > 55% on 20+ trades + buy-land > 90%.
- **Do not commit `.env.local` or wallet keys.** Ever.
- **Do not delete broadcast channel code without grepping
  subscribers.** Usually they're orphaned, but verify.
