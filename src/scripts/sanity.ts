/**
 * Full sanity check — run after any migration or code change.
 * Validates DB schema, runtime code cleanliness, API contracts, and
 * config thresholds match what was shipped.
 *
 * Usage: npx tsx src/scripts/sanity.ts
 */

import "../lib/supabase-server";
import supabase from "../lib/supabase-server";
import * as fs from "fs";
import * as path from "path";
import {
  LIVE_BUY_SOL,
  DAILY_LOSS_LIMIT_SOL,
} from "../config/smart-money";

const OK = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const WARN = "\x1b[33m⚠\x1b[0m";

let pass = 0;
let fail = 0;
let warn = 0;

function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? OK : FAIL} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
}

function note(label: string, detail: string) {
  console.log(`  ${WARN} ${label} — ${detail}`);
  warn++;
}

const DASHBOARD_URL = "https://pixiu-bot.pages.dev";

(async () => {
  console.log("\n═══ PixiuBot Full Sanity Check ═══\n");

  // ─── 1. DATABASE SCHEMA ─────────────────────────────────
  console.log("▸ Database schema");

  {
    const { data, error } = await supabase
      .from("trades")
      .select("id", { count: "exact", head: true });
    check("trades table queryable", !error, error?.message);
  }

  for (const oldName of ["paper_trades", "paper_bankroll", "DEPRECATED_bankroll"]) {
    const { error } = await supabase.from(oldName).select("id").limit(1);
    const gone = !!error && /does not exist|could not find/i.test(error.message);
    check(`${oldName} removed`, gone, error?.message || "still exists!");
  }

  // Required columns via dummy-insert roundtrip
  {
    const dummyMint = "__SANITY_" + Date.now();
    const { error: insErr } = await supabase.from("trades").insert({
      coin_address: dummyMint,
      coin_name: "sanity",
      wallet_tag: "SANITY [LIVE]",
      entry_price: 1,
      status: "closed",
      priority: "normal",
      entry_time: new Date().toISOString(),
      exit_time: new Date().toISOString(),
      grid_level: 0,
      remaining_pct: 0,
      partial_pnl: 0,
      real_pnl_sol: 0.001,
      entry_sol_cost: 0.05,
      buy_tx_sig: "dummy",
      sell_tx_sig: "dummy",
      closing_started_at: null,
    });
    check(
      "required cols: real_pnl_sol, entry_sol_cost, buy/sell_tx_sig, closing_started_at",
      !insErr,
      insErr?.message
    );
    await supabase.from("trades").delete().eq("coin_address", dummyMint);
  }

  // Partial unique index
  {
    const dupeMint = "__DUPE_" + Date.now();
    const base = {
      coin_address: dupeMint,
      coin_name: "dupe",
      wallet_tag: "SANITY [LIVE]",
      entry_price: 1,
      status: "open",
      priority: "normal",
      entry_time: new Date().toISOString(),
      grid_level: 0,
      remaining_pct: 100,
      partial_pnl: 0,
    };
    const { error: e1 } = await supabase.from("trades").insert(base);
    const { error: e2 } = await supabase.from("trades").insert(base);
    const indexBlocked =
      e1 === null &&
      e2 !== null &&
      /one_open_per_mint|duplicate key|unique/i.test(e2.message);
    check(
      "one_open_per_mint_idx enforces unique open per mint",
      indexBlocked,
      e2?.message || "index missing"
    );
    await supabase.from("trades").delete().eq("coin_address", dupeMint);
  }

  // ─── 2. BOT STATE ───────────────────────────────────────
  console.log("\n▸ Bot state");

  {
    const { data } = await supabase
      .from("bot_state")
      .select("mode, is_running")
      .limit(1)
      .single();
    check(`bot_state.mode = "live"`, data?.mode === "live", `got "${data?.mode}"`);
    if (data?.is_running) {
      note("bot is RUNNING", "will process new buys");
    } else {
      note("bot is STOPPED", "click START BOT to enable entries");
    }
  }

  // ─── 3. CONFIG THRESHOLDS ───────────────────────────────
  console.log("\n▸ Config thresholds");

  check(
    `LIVE_BUY_SOL = 0.025`,
    Math.abs(LIVE_BUY_SOL - 0.025) < 1e-9,
    `got ${LIVE_BUY_SOL}`
  );
  check(
    `DAILY_LOSS_LIMIT_SOL = 0.50`,
    Math.abs(DAILY_LOSS_LIMIT_SOL - 0.50) < 1e-9,
    `got ${DAILY_LOSS_LIMIT_SOL}`
  );

  // Grep CB thresholds from risk-guard source
  {
    const rg = fs.readFileSync(
      path.resolve("src/agents/risk-guard.ts"),
      "utf8"
    );
    const l0 = rg.match(/CIRCUIT_BREAKER_L0_PCT\s*=\s*(\d+)/);
    const l1 = rg.match(/CIRCUIT_BREAKER_PCT\s*=\s*(\d+)/);
    check(
      `CB L0 threshold = 15`,
      l0?.[1] === "15",
      `got ${l0?.[1] ?? "unknown"}`
    );
    check(
      `CB L1+ threshold = 15 (was 25, tightened bf149dc)`,
      l1?.[1] === "15",
      `got ${l1?.[1] ?? "unknown"}`
    );
  }

  // Daily loss limit no longer auto-halts bot
  {
    const rg = fs.readFileSync(
      path.resolve("src/agents/risk-guard.ts"),
      "utf8"
    );
    const hasAutoHalt =
      /from\(["']bot_state["']\)\s*\n?\s*\.update\(\s*\{\s*is_running:\s*false/.test(
        rg
      );
    check(
      "daily limit does NOT auto-halt bot (keeps is_running=true)",
      !hasAutoHalt,
      hasAutoHalt ? "risk-guard still writes is_running=false" : undefined
    );
  }

  // ─── 4. NO "PAPER" IN RUNTIME CODE ──────────────────────
  console.log("\n▸ Runtime code cleanliness");

  {
    const { execSync } = await import("child_process");
    try {
      const out = execSync(
        `grep -rni 'paper' src/agents src/app src/lib src/config 2>/dev/null || true`,
        { encoding: "utf8" }
      );
      const lines = out.trim().split("\n").filter(Boolean);
      check(
        "zero 'paper' references in runtime code",
        lines.length === 0,
        lines.length > 0 ? `${lines.length} refs still found` : undefined
      );
    } catch (e: any) {
      check("paper grep", false, e.message);
    }
  }

  // ─── 5. DASHBOARD APIs ──────────────────────────────────
  console.log("\n▸ Dashboard APIs");

  try {
    const res = await fetch(`${DASHBOARD_URL}/api/phantom-balance`);
    if (!res.ok) {
      check("phantom-balance reachable", false, `HTTP ${res.status}`);
    } else {
      const j: any = await res.json();
      check(
        "phantom-balance returns sol",
        typeof j.sol === "number" && j.sol >= 0,
        `sol=${j.sol}`
      );
      check(
        "phantom-balance NO startingSol (deposit-safe)",
        j.startingSol === undefined,
        j.startingSol !== undefined
          ? `still returns startingSol=${j.startingSol}`
          : undefined
      );
      check(
        "phantom-balance NO pnlSol (deposit-safe)",
        j.pnlSol === undefined,
        j.pnlSol !== undefined ? `still returns pnlSol` : undefined
      );
    }
  } catch (e: any) {
    check("phantom-balance reachable", false, e.message);
  }

  try {
    const res = await fetch(`${DASHBOARD_URL}/api/settings`);
    if (!res.ok) {
      check("settings reachable", false, `HTTP ${res.status}`);
    } else {
      const j: any = await res.json();
      check(
        "settings returns live_trading: true",
        j.live_trading === true,
        JSON.stringify(j)
      );
    }
  } catch (e: any) {
    check("settings reachable", false, e.message);
  }

  // ─── 6. SUPPORTING TABLES ───────────────────────────────
  console.log("\n▸ Supporting tables");

  {
    const { error } = await supabase
      .from("coin_signals")
      .select("id", { count: "exact", head: true });
    check("coin_signals queryable", !error, error?.message);
  }
  {
    const { count, error } = await supabase
      .from("tracked_wallets")
      .select("id", { count: "exact", head: true })
      .eq("active", true);
    check(
      `tracked_wallets active > 0`,
      !error && (count ?? 0) > 0,
      `count=${count}`
    );
  }

  // ─── 7. TRADE DATA SNAPSHOT ─────────────────────────────
  console.log("\n▸ Trade data snapshot");

  {
    const { count: openCount } = await supabase
      .from("trades")
      .select("id", { count: "exact", head: true })
      .eq("status", "open");
    const { count: closingCount } = await supabase
      .from("trades")
      .select("id", { count: "exact", head: true })
      .eq("status", "closing");
    const { count: closedCount } = await supabase
      .from("trades")
      .select("id", { count: "exact", head: true })
      .eq("status", "closed");

    note(
      "position counts",
      `open=${openCount} | closing=${closingCount} | closed=${closedCount}`
    );

    if ((closingCount ?? 0) > 0) {
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      const { count: stuckCount } = await supabase
        .from("trades")
        .select("id", { count: "exact", head: true })
        .eq("status", "closing")
        .lt("closing_started_at", fiveMinAgo);
      if ((stuckCount ?? 0) > 0) {
        check(
          "no stuck 'closing' rows > 5min (reaper working)",
          false,
          `${stuckCount} rows stuck`
        );
      } else {
        check(
          "no stuck 'closing' rows > 5min (reaper working)",
          true,
          `${closingCount} rows active, all recent`
        );
      }
    }
  }

  // ─── Summary ────────────────────────────────────────────
  console.log(
    `\n═══ Result: ${pass} passed, ${fail} failed, ${warn} notes ═══\n`
  );
  process.exit(fail > 0 ? 1 : 0);
})();
