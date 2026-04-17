# PixiuBot Backlog

Active work queue. Ordered by priority. Move to `docs/SPRINT*-RECAP.md`
when shipped, then delete from here.

---

## Sprint 8

### P1 — Commit 6 cleanup pass
Dead code left behind by Sprint 7 Day 3 consolidation:
- `src/lib/entry-guards.ts` — orphaned (only `signal-validator` imported
  it; validator was deleted in `7dbe342`).
- `src/app/api/webhook/route.ts` — dead `checkLiquidity()` helper (lines
  ~160–175) + local `MIN_LIQUIDITY_USD` const, unused after
  `checkTokenSafety()` migration in commit `4bdc377`.
- `src/lib/price-guards.ts:5` — stale comment mentioning
  `price-scout.ts` (file no longer exists).
- `src/agents/wallet-watcher.ts` — still broadcasts to
  `pixiubot:signals` channel, which now has zero subscribers
  (validator was the only one). Either drop the broadcast or keep
  as a future hook — decision pending.

Single commit, bot stays running throughout (node-side only, no edge
change).

### P2 — Cloud migration: Mac → DigitalOcean
Move the swarm runner off the local MacBook so overnight sessions
don't depend on `caffeinate` and a wake-cycle-free laptop. Webhook
is already on Cloudflare Edge so no edge work needed — only the
4-agent swarm (`wallet-watcher`, `trade-executor`, `risk-guard`,
`tier-manager`) needs to move.

Scope:
- Provision droplet, install Node 22 / tsx / wrangler.
- Port `.env.local` secrets to droplet (Helius, Supabase, RPC, wallet
  keypair). Keep wallet key encrypted at rest.
- systemd unit for `npx tsx src/agents/run-all.ts` with auto-restart.
- Observability: pipe logs to Grafana/loki or similar.

### P3 — Position size bump: 0.05 → 0.10 SOL
**Hard gate — do not bump until all three pass:**
- 48h of clean runs (no bypass, no phantom, no crash restart).
- Win rate > 55% on a 20+ trade window.
- Buy-land rate > 90% (real fills / attempted entries).

Change touches `src/config/smart-money.ts` `LIVE_BUY_SOL` and
`DAILY_LOSS_LIMIT_SOL` (scale loss budget proportionally). Backfill
script may need to re-scale historical SOL accounting for reporting
parity.

### P4 — $1K capital injection
**Gate:** 1 full week clean at 0.10 SOL position size (after P3
ships and holds).

On-chain transfer into the live wallet, dashboard recognizes the
new bankroll automatically via `paper_bankroll` reconciliation.

---

## Parking lot (no timeline)

- Webhook → shared canonical guard module (currently inlined). Would
  require either porting `supabase-server.ts` to edge-safe, or moving
  DB reads to a small edge-side client. Low priority — duplication
  is small and stable.
- Replace DexScreener dependency with an on-chain pool reader (Raydium
  / pump.fun bonding curve). DS outages have caused false-negative
  `token_unsafe` rejects.
- Tier-4 whale detector — wallets buying before the top T1 wallets.
