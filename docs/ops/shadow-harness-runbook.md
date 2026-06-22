# Forward Shadow Harness — Runbook

Recurring, **shadow-only** collection for the pre-registered TR-v1 token-risk
rule (see `token-risk-rule-TR-v1.md`). No SOL, no broadcast, no enforcement.
Writes only `stacked_filter_shadow`; reads `coin_signals` + `token_risk_policy`.
Requires migration 020 applied and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`.

## What runs (macOS launchd user agents)
| Agent | Script | Cadence |
|---|---|---|
| `com.pixiu.shadow-collect` | `shadow-run.sh collect` | every 600s (10 min) |
| `com.pixiu.shadow-paper-sim` | `shadow-run.sh paper-sim` | every 180s (3 min) |
| `com.pixiu.shadow-report` | `shadow-run.sh report` | every 1800s (30 min) |

Wrapper: `src/scripts/shadow-run.sh <collect|paper-sim|report>` — cd's to repo
root, sets PATH (`/usr/local/bin`), single-instance lock per mode, appends to
`logs/shadow-<mode>.log` (bounded to ~2000 lines). `logs/` is gitignored.

> Note: launchd jobs run only while the Mac is **awake** (they coalesce on wake).
> For continuous overnight collection keep the Mac plugged in / prevent sleep.
> RugCheck/DexScreener rate limits degrade gracefully (fail-closed → would_block
> + missing flags), never crash.

## Status
```bash
launchctl list | grep pixiu
tail -f ~/PixiuBot/logs/shadow-collect.log     # or shadow-paper-sim / shadow-report
npx tsx ~/PixiuBot/src/scripts/shadow-report.ts   # report on demand
```

## Stop (pause collection)
```bash
launchctl unload ~/Library/LaunchAgents/com.pixiu.shadow-collect.plist
launchctl unload ~/Library/LaunchAgents/com.pixiu.shadow-paper-sim.plist
launchctl unload ~/Library/LaunchAgents/com.pixiu.shadow-report.plist
```

## Start (resume)
```bash
launchctl load -w ~/Library/LaunchAgents/com.pixiu.shadow-collect.plist
launchctl load -w ~/Library/LaunchAgents/com.pixiu.shadow-paper-sim.plist
launchctl load -w ~/Library/LaunchAgents/com.pixiu.shadow-report.plist
```

## Force a run now
```bash
launchctl kickstart -k gui/$(id -u)/com.pixiu.shadow-collect
```

## Plist install (if recreating on another machine)
The 3 plists live in `~/Library/LaunchAgents/com.pixiu.shadow-*.plist`. Each runs
`/bin/bash /Users/<user>/PixiuBot/src/scripts/shadow-run.sh <mode>` with
`WorkingDirectory` = repo root, `RunAtLoad=true`, `StartInterval` per the table,
and `StandardOut/ErrorPath` → `logs/launchd-<mode>.{out,err}`. Adjust the
absolute paths for the target machine, then `launchctl load -w` each.

## Evaluating evidence
`shadow-report` prints the pre-registered TR-v1 gate check (N≥50 would_enter,
net-positive, discriminates enter>block, trailing preserved). Edge is **not**
claimed until those hold out-of-sample / walk-forward. TR-v1 thresholds are
frozen — any change is a new pre-registered **TR-v2**, never a tune of TR-v1.
