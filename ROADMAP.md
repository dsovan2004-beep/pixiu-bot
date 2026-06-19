# PixiuBot Roadmap

Longer-horizon plan — where we're going, gated on what.

Active sprint backlog lives in `docs/BACKLOG.md`. History lives in
`SPRINT.md` + `docs/JOURNAL.md`. This file is the forward view.

---

## Where we are today (Jun 19 2026)

**Architecture**
- Single entry path: webhook `evaluateAndEnter()` with all 15 guards
  inline. Swarm = 4 agents (watcher, executor, risk-guard,
  tier-manager). Sell-side fully rebuilt (atomic claim, real grid
  partials, phantom-peak gate, drain monitor, rescue slippage ladder).
- risk-guard now self-heals phantom `status='open'` rows (reaper) and
  bounds its monitoring query to confirmed positions (`be97d0c`).

**Metrics (332-trade dashboard snapshot)**

| Metric | Value |
|---|---|
| Real SOL balance | 0.82 SOL (~\$56) |
| Trade P&L (cumulative) | −1.25 SOL (−9.6% ROI) |
| Total closed trades | 332 |
| Win rate | 23.5% (78W / 254L) |
| Avg win | +23.06% |
| Avg loss | −19.71% |
| Open positions | 0 |
| Bot status | STOPPED (user-gated restart) |

**The honest read:** the early "62% WR" era was survivorship on a
small sample; at scale, copy-trading public smart money on pump.fun is
**structurally −EV at our T+30s latency**. The Apr–Jun fix stack cut
average loss/trade from −0.017 → −0.004 (4.6×) but cannot lift the
~24% WR — that's latency/signal-quality, not code. Only two wallets
(theo pump sad, daniww) are net-positive and are protected as
permanent T1 with 2× size. Forward plan = the **Limo Path** (below +
`docs/BACKLOG.md`): stop bleeding → kill latency → become the early
money (sniper) → scale with partner capital.

---

## 🏎️ Limo Path (active strategic roadmap)

Full detail, kill criteria, and carry-forward matrix in
`docs/BACKLOG.md`. Summary:

| Stage | Goal | Gate to advance |
|---|---|---|
| **1. Prove edge** (now) | 0.82 → 3 SOL | 30 post-fix trades net-positive |
| 2. Kill latency | 3 → 10 SOL | Helius Pro gRPC + BloXroute live, PnL lifts |
| 3. pump.fun sniper | 10 → 50 SOL | sniper module +EV over 50 trades |
| 4. Capital partnership | 50 → 500 SOL | 60–90d verified track record |
| 5. 🏎️ Limo | ~500 SOL ($43k) | — |

**Stage 1 is current.** Bot stays small (0.025 / elite 0.05) until 30
post-fix trades prove net-positive expectancy. If they don't → halt
and rethink, do not size up.

---

## Watch metrics (Stage 1 validation)

- **`pool_drain` (PD) exit rate** — should fall sharply now that the
  pre-buy floor is 0.97. A string of PD closes means broken-pool
  entries are still getting through → tighten further or halt.
- **Phantom open count** — `status='open'` rows with no
  `entry_sol_cost`. Target: near-0 (reaper clears > 15min). The guard
  log should read a small number, never `Checking 1000`.
- **Elite-wallet PnL** — theo pump sad + daniww net SOL. If either
  turns net-negative over its next ~10 trades, demote from
  `ELITE_WALLET_TAGS` (their edge has decayed).
- **Buy-land rate** — real Jupiter fills / attempted entries. < 80%
  means routing/RPC issues (or Jito timeouts → BloXroute is Stage 2).
- **Postmortem cadence** — re-run `wallet-postmortem.ts` every ~30 new
  closed trades; blacklist new bleeders, protect new winners.

If any drift, stop and diagnose before shipping anything else.

---

## Sprint 8 — cleanup + infra

### P1. Commit 6 cleanup pass

Dead code surfaced by Sprint 7 consolidation:

- Delete `src/lib/entry-guards.ts` — orphaned after validator delete.
- Remove dead `checkLiquidity()` helper + local `MIN_LIQUIDITY_USD`
  const in `src/app/api/webhook/route.ts`.
- Fix stale comment in `src/lib/price-guards.ts:5` mentioning
  `price-scout.ts`.
- Drop `wallet-watcher.ts` broadcast to `pixiubot:signals` (no
  subscribers).

Single commit, bot stays up. Edge rebuild is no-op.

### P2. Cloud migration — Mac → DigitalOcean

Move the 4-agent swarm off the local MacBook so overnight runs don't
depend on `caffeinate` and a wake-cycle-free laptop.

Scope:
- Droplet provision + Node 22 / tsx / wrangler install.
- Secrets port to droplet (`.env.local` → env vars). Wallet keypair
  stays encrypted at rest.
- systemd unit for `npx tsx src/agents/run-all.ts` with
  auto-restart on crash.
- Log pipe to Grafana Loki or similar.
- Health-check endpoint so we see when swarm is down.

Webhook is already on Cloudflare Edge — no edge work needed.

### P3 / P4 are explicit gates, not sprint items — see below.

---

## Position size bump gate (0.05 → 0.10 SOL)

**Hard gate — do not bump until all three pass:**

1. **48 hours of clean runs** after Sprint 8 ships.
2. **Win rate > 55%** on a rolling 20+ trade window (LIVE only,
   not mark-to-market).
3. **Buy-land rate > 90%** over the same window.

### What "clean" means

- Zero bypass entries (`is_running=false` → INSERT).
- Zero phantom positions (`status=open` > 30 min, non-zero wallet
  balance, no exit attempts logged).
- Zero unrecovered stuck sells (Jupiter 6024 / 429 / route failures
  that didn't recover via `sell-pumpfun.ts` or guard zero-balance
  close).
- Zero crash restarts of `run-all.ts` triggered by unhandled errors.
  Planned restarts for deploys are fine.
- CF build green on every push.

### What changes on the bump

- `src/config/smart-money.ts`: `LIVE_BUY_SOL = 0.10`.
- Same file: `DAILY_LOSS_LIMIT_SOL` scales proportionally. Current
  `3.0` at 0.05 → `6.0` at 0.10 if we want the same max % risk.
  Don't just double — re-derive from target % daily drawdown.
- Dashboard header — `0.10 SOL/trade` label.

### Rollback plan if the gate fails

If buy-land < 90% after bump, revert `LIVE_BUY_SOL` to 0.05 and file
a diagnostic sprint. Likely culprits: slippage too tight at higher
size, Jupiter route depth, or Helius RPC congestion.

---

## \$1K capital injection gate

**Trigger:** 1 full week clean at 0.10 SOL position size. ("Clean"
= same checklist as P3.)

### What happens

- On-chain transfer of ~\$1,000 worth of SOL into the live wallet
  (`ESK3r8n5jhaLn9Few59QKNJ5UMeD9iqZ5p1rbU9euvey`).
- `DEPRECATED_bankroll.current_balance` reconciles automatically via the
  existing phantom-balance path. Manually log the injection in
  `docs/JOURNAL.md` with tx sig and USD amount.
- `LIVE_BUY_SOL` stays at 0.10 unless we're scaling up the gate
  checklist separately.
- `DAILY_LOSS_LIMIT_SOL` held constant — the goal is to scale
  *runway*, not risk appetite per trade.

### Verification post-injection

- Confirm dashboard reflects new bankroll within one refresh.
- Confirm next LIVE buy uses 0.10 SOL (not accidentally scaled to
  bankroll %).
- Confirm daily loss counter is still reading real SOL.

---

## Beyond — parking lot

No timeline. Pull into an active sprint when the immediate queue is
clear.

- **Trailing stop after L3** — already shipped (`bdf4bae`); watch for
  edge cases where peak detection misses due to poll gaps.
- **On-chain pool reader** replacing DexScreener for liquidity/fdv —
  DS outages have caused false-negative `token_unsafe` rejects.
  Raydium / pump.fun bonding curve reads directly.
- **Tier-4 frontrunner detector** — wallets that consistently buy
  before the top T1 wallets. Would add a new tier with shorter
  cooldowns and tighter position sizing.
- **Telegram alerts wire-up** — code exists in `src/lib/telegram.ts`
  since Sprint 5 D3. Needs `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
  in env + a decision on which events are alert-worthy.
- **Dashboard rewrite** — auto-refresh is 10s, some panels stale.
  Low priority until it blocks something.

---

## Hard no-gos

- **Do not add a second entry path.** Golden Rule from `PLAYBOOK.md`.
  If you want to add an entry guard, put it in `evaluateAndEnter()`.
- **Do not remove the `is_running` check.** Ever. The bypass class
  of bug ate real SOL.
- **Do not raise position size without passing the gate.** Not "the
  gate but slightly flexible." The gate.
- **Do not commit wallet keys, service-role keys, or `.env.local`.**

---

## Template notes (for other bots)

This roadmap structure (current state → stability window → gated
sprint → position-size gate → capital gate → parking lot → no-gos)
is reusable. Copy it to **Abyss Bot**, **Polybot**, and **Raptor Bot**
with the bot-specific numbers filled in. The gate-based scale-up
pattern — don't increase size until N-hours-clean + WR floor +
fill-rate floor — generalises across trading bots regardless of
chain or asset.
