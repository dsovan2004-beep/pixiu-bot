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
inserts rows into `trades`: `src/app/api/webhook/route.ts` inside
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
| `src/app/api/webhook/route.ts` | Cloudflare Edge | Helius webhook receiver; runs `evaluateAndEnter()` — owns all 15 entry guards and is the only code path that inserts `trades` |
| `src/agents/wallet-watcher.ts` | Node (local or DO) | Watches tracked wallets, writes to `coin_signals` table |
| `src/agents/trade-executor.ts` | Node | Polls `trades` every 3s, performs Jupiter swaps, tags `[LIVE]` |
| `src/agents/risk-guard.ts` | Node | Polls open positions (L0 every 2s / L1+ every 5s), fires exits, reaps phantom rows. Runs even when bot STOPPED |
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

`risk-guard.ts` polls on a split cadence: **L0 positions every 2 s,
L1+ every 5 s**. The guard ALWAYS runs even when the bot is STOPPED —
STOP only blocks new entries, never exits. On each tick, per position,
in order — first match wins:

```
0.  Phantom reaper (pre-loop)  — open + entry_sol_cost NULL + not [LIVE]
                                 + age > 15min → mark failed/phantom_reaped
0a. Closing reaper (pre-loop)  — 'closing' stuck > 5min → revert to 'open'
0b. Skip phantom pre-confirm   — open but not yet [LIVE] / no entry_sol_cost
0c. Holder exodus              — top-holder retention drop > 73% → exit
0d. Liquidity drain monitor    — sim full-bag sell < 0.85 of entry cost
                                 → pool_drain exit (catches broken pools)
 1. Circuit Breaker            — L0 ≤ -15% / L1+ ≤ -15% → emergency exit
 2. Whale Exit                 — DISABLED (structural latency; see below)
 3. Stop Loss                  — pnlPct ≤ -10% → full exit
 4. Timeout                    — held > 10min → full exit
 5. Grid Levels (each gated by the PHANTOM PEAK GATE):
    L1 +15%  → sell 50%   ┐  before firing, sim-quote the slice; if
    L2 +40%  → sell 25%   ┤  recovery < GRID_SIM_RECOVERY_FLOOR (1.0)
    L3 +100% → trailing   ┘  skip partial, revert grid claim (mark is
                             phantom at our size). Post-L1 trail 25%,
                             post-L2 trail 12% + 0.85 sim floor + 3min cap.
 6. Zero-balance close         — wallet has 0 tokens → lock PnL and close
```

### Key exit thresholds (all in `risk-guard.ts`, Jun 2026)

| Constant | Value | Role |
|---|---|---|
| `CIRCUIT_BREAKER_L0_PCT` | 15 | CB threshold before any partials locked |
| `STOP_LOSS_PCT` | 10 | hard SL |
| `LIQUIDITY_DROP_THRESHOLD` | 0.85 | drain-monitor floor (full-bag sim ÷ entry) |
| `GRID_SIM_RECOVERY_FLOOR` | 1.0 | phantom-peak gate — only fire L1/L2 if real breakeven+ available |
| `POST_L1_TRAIL_PCT` | 25 | retrace from peak that closes a post-L1 position |
| `POST_L2_TRAIL_PCT` | 12 | tighter retrace post-L2 |
| `POST_L2_SIM_RECOVERY_FLOOR` | 0.85 | post-L2 sim auto-close |
| `POST_L2_MAX_HOLD_MS` | 3 min | force-close post-L2 if no L3 (lock spike) |

### Phantom peak gate (why grid partials sim-check first)

DexScreener mark is a thin-pool MID price. At L1/L2 our actual Jupiter
fill can be 15–40 pts below mark because snipers/copy-traders drained
the pool first (Ben Pasterneck: +31.4% mark → −36% real on the slice).
So before every grid partial the guard sim-quotes the sell; if recovery
< 1.0 it logs `🧿 PHANTOM PEAK`, skips the partial, and reverts the DB
grid claim. Real-profit partials still fire and lock SOL (e.g. LandSat
Earth L1 +0.0004 real).

### Drain monitor (broken-pool containment)

Every poll, for confirmed `[LIVE]` positions, sim-quote a full-bag sell
÷ entry cost. Below `LIQUIDITY_DROP_THRESHOLD` (0.85) → immediate
`pool_drain` exit. This is the last line against broken-pool entries
that pass the pre-buy filter but collapse the instant our buy lands.
Pre-buy `MIN_ROUND_TRIP_RECOVERY` (0.97) is the FIRST line — reject
before we pay. The pre/post-buy sim gap (95–98% → 70–85%) is the
MEV/sniper tax on pump.fun and the core reason copy-trading is −EV at
our latency.

### Atomic-claim pattern

Guard uses `UPDATE trades SET status='closing' WHERE id=X AND
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

### Position sizing (current — Jun 2026)

Two tiers, both in `smart-money.ts`:

| Constant | Value | Applies to |
|---|---|---|
| `LIVE_BUY_SOL` | `0.025` | every signaler (baseline) |
| `ELITE_BUY_SOL` | `0.05` (2×) | PRIMARY signaler in `ELITE_WALLET_TAGS` |

`ELITE_WALLET_TAGS` = `theo pump sad`, `daniww` — the only wallets
net-positive on live `real_pnl_sol`. Executor resolves size via
`getBuySolForWalletTag(wallet_tag)`, matching the PRIMARY tag only (a
co-buyer being elite does NOT upgrade size). The pre-buy round-trip sim
runs at the ACTUAL chosen size so liquidity validation matches the
real trade.

History: baseline was `0.05`; halved to `0.025` (`eb4ac3c`, Apr 22) to
cut loss magnitude while expectancy was negative. Any bump back must
scale `DAILY_LOSS_LIMIT_SOL` proportionally. The dashboard reads
`LIVE_BUY_SOL` from config (since `c61c547`) — never hardcode it in UI.

---

## Live-trading safety rules

1. **`is_running` is authoritative.** Every entry path must check
   `bot_state.is_running` before inserting `trades`. Currently
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

## Runbook: git push auth (when push 403s or "could not read Username")

GitHub deprecated password auth; `git push` needs a PAT in a place git
can read. Two failure modes seen Jun 2026:

- **403 "Permission denied"** = a *valid* token that lacks write scope
  (fine-grained PAT missing **Contents: Read and write**), OR an
  expired token cached in macOS Keychain. Note `gh api repos/...`
  returning `push:true` reflects your account ROLE, not the token's
  scopes — it can lie.
- **"could not read Username" / "Invalid username or token"** = no
  credential is stored (keychain erased) or the token got truncated on
  an interactive paste (fine-grained PATs are ~93 chars).

**The reliable fix (one shot, no truncation):** inline-URL push —

```bash
cd ~/PixiuBot && git push "https://<PAT>@github.com/dsovan2004-beep/pixiu-bot.git" main
```

Takes the whole token in one shot; the interactive `Password:` prompt
is invisible and silently truncates long pastes.

**To persist** (so future pushes need no token): store it once —

```bash
printf "protocol=https\nhost=github.com\nusername=dsovan2004-beep\npassword=<PAT>\n\n" \
  | git credential-osxkeychain store
```

**Cleanest of all (no token handling):** `gh auth login` → GitHub.com →
HTTPS → "Authenticate Git? Yes" → "Login with a web browser". Browser
OAuth grants every scope automatically (including `read:org`, which
`gh auth login --with-token` rejects fine-grained PATs for). Then
`gh auth setup-git`.

Diagnostics: `git config --get-all credential.helper` (which helper
answers), and to see what git actually resolves without leaking the
secret, compare only against known placeholder strings — never print a
real token's prefix/length into the transcript.

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

Legacy bankroll (in `DEPRECATED_bankroll`) and real SOL wallet drift over
time — phantoms, partial fills, rescue sells outside the bot.

1. `src/scripts/phantom-balance.ts` — reads real on-chain wallet
   balance.
2. Compute delta vs. `DEPRECATED_bankroll.current_balance`.
3. Apply the delta as a single UPDATE with a reason string:
   ```sql
   UPDATE DEPRECATED_bankroll
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
   UPDATE trades
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

**Symptom:** bot showed `STOPPED` on dashboard, but new `trades`
rows kept appearing with `[LIVE]` tag. The Bull −60.61%, 千鳥 −44.66%,
dogwifbeanie −37.71% all opened during a dashboard STOP.

**Root cause:** webhook's `evaluateAndEnter()` never checked
`bot_state.is_running`. Only the swarm-side executor did. So the
dashboard STOP button halted execution but not entry — the bot kept
filling up `trades` until executor came back on.

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
Supabase Realtime dropped — replaced with polling of `trades`
in commit `d59053e`. Nobody removed the validator/scout pipeline.
They kept logging like they were enforcing, but weren't.

**Fix:** grep-verified that `pixiubot:confirmed` had zero subscribers;
deleted both files (−577 lines); migrated their guards into webhook.

**Generalised lesson:** if a module produces log lines that look
active but don't insert into `trades`, don't trust the logs —
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

### Phantom-open pileup — 2,107 stuck rows (commit `be97d0c`, Jun 19)

**Symptom:** guard logged `Checking 1000 open position(s)` (the
Supabase row cap) every 2 s while the dashboard showed 0 open. Real
count: 2,107 rows in `status='open'`, accumulated over 6 weeks.

**Root cause:** the webhook inserts `status='open'` on every passing
signal; the executor only resolves those rows (→ failed or → `[LIVE]`)
while the bot is LIVE (`if (!live) return`). Bot stopped, or signals
faster than the executor → pre-confirm rows never resolve → pile up
forever. The guard's unbounded `SELECT * WHERE status='open'` then
pulled 1,000 every poll. None were ever bought (0 `entry_sol_cost`, 0
`[LIVE]`), so the dashboard (which counts confirmed positions) showed 0.

**Fix:** (1) a phantom reaper in `checkPositions()` that flips
`open` + `entry_sol_cost NULL` + not `[LIVE]` + age > 15 min →
`failed`/`phantom_reaped`, running every poll even when stopped; (2)
bound the monitoring query to confirmed rows via
`.or(entry_sol_cost.not.is.null, wallet_tag.ilike.*LIVE*)`. One-shot
`cleanup-phantom-open.ts` cleared the backlog (with JSON backup).

**Generalised lesson:** any unbounded `status='open'` query is a
latent landmine — a write path that creates rows without a guaranteed
terminal-state writer will pile up. Bound monitoring queries to the
rows that path actually owns, and add a reaper for the orphan class.

### Phantom peak — mark-vs-real divergence ate partials (commit `c404a21`)

**Symptom:** L1/L2 "fired" at +15–40% mark but the slice booked a real
loss (Ben Pasterneck: +31.4% mark → −36% real on the 50% slice).

**Root cause:** DexScreener mark is a thin-pool MID price; at our sell
size the pool had already been drained by faster actors, so the real
Jupiter fill was far below mark.

**Fix:** phantom-peak gate — sim-quote every grid partial before firing;
skip + revert the grid claim if recovery < `GRID_SIM_RECOVERY_FLOOR`.

**Generalised lesson:** never act on DexScreener mark for a SIZED
decision. Sim-quote the actual trade. Mark is a display number, not an
executable price.

### Stale external WR labels (commit `0f8be4a`)

**Symptom:** jijo and Sheep sat in `TOP_ELITE_ADDRESSES` with "55% WR"
/ "64% WR" comments from GMGN/Kolscan, but live `real_pnl_sol` showed
28.6% / 20% WR and net-negative SOL. They kept entering and losing.

**Fix:** removed from TOP_ELITE, blacklisted. Postmortem now drives
membership off live `real_pnl_sol`, not external labels.

**Generalised lesson:** the only WR that matters is the one computed
from our own closed trades. External leaderboard labels are marketing.
Re-run `wallet-postmortem.ts` every ~30 closed trades.

### Broken-pool entries (pre/post-buy sim gap)

**Symptom:** dozens of immediate `pool_drain` exits (shoebill, Pedro
Solana, etc.). Pre-buy round-trip sim read 95–98% but post-buy sim was
70–85%.

**Root cause:** MEV/sniper tax — the pre-buy Jupiter quote is "fair
value" but our actual landed buy gets sandwiched / the pool is drained
between quote and fill on pump.fun.

**Fix:** raised pre-buy `MIN_ROUND_TRIP_RECOVERY` 0.90 → 0.95 → 0.97
(first line, reject before paying) and the drain monitor floor 0.40 →
0.60 → 0.85 (last line, contain after entry). This is the structural
reason copy-trading is −EV at our latency — see ROADMAP "Limo Path".

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
