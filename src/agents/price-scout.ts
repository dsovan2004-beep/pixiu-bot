/**
 * PixiuBot Agent 3 — Price Scout
 *
 * Subscribes to pixiubot:entries channel.
 * Fetches real price from DexScreener for the coin address.
 * If price > 0 → publishes CONFIRMED_ENTRY to pixiubot:confirmed channel.
 * If price fails → logs [SKIP] and drops the entry.
 */

import supabase from "../lib/supabase-server";
import { isPriceTooHigh } from "../lib/entry-guards";

interface EntryEvent {
  coin_address: string;
  coin_name: string;
  wallet_label: string;
  smart_money_count: number;
}

async function fetchDexScreenerPrice(
  mint: string
): Promise<{ price: number; source: string }> {
  // Source 1: Jupiter
  try {
    const res = await fetch(`https://price.jup.ag/v6/price?ids=${mint}`);
    if (res.ok) {
      const data = await res.json();
      const price = data.data?.[mint]?.price;
      if (typeof price === "number" && price > 0) {
        return { price, source: "jupiter" };
      }
    }
  } catch {}

  // Source 2: DexScreener
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`
    );
    if (res.ok) {
      const data = await res.json();
      const p = data.pairs?.[0]?.priceUsd;
      if (p) {
        const price = parseFloat(p);
        if (price > 0) return { price, source: "dexscreener" };
      }
    }
  } catch {}

  return { price: 0, source: "none" };
}

const MIN_LIQUIDITY_USD = 10_000;

// ─── Liquidity Check ────────────────────────────────────

async function checkLiquidity(
  mint: string
): Promise<{ liquidity: number | null; passed: boolean }> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`
    );
    if (res.ok) {
      const data = await res.json();
      const liq = data.pairs?.[0]?.liquidity?.usd;
      if (typeof liq === "number") {
        return { liquidity: liq, passed: liq >= MIN_LIQUIDITY_USD };
      }
    }
  } catch {}
  // API failure or null → allow entry (don't block on missing data)
  return { liquidity: null, passed: true };
}

// ─── LP Burn & Holder Check via RugCheck ────────────────

async function checkLpAndHolders(
  mint: string
): Promise<{ lpSafe: boolean; holdersSafe: boolean; reason: string }> {
  try {
    const res = await fetch(
      `https://api.rugcheck.xyz/v1/tokens/${mint}/report`
    );
    if (res.ok) {
      const data = await res.json();

      // Check LP risks: any risk with 'lp' in name and level 'danger'
      const risks: Array<{ name: string; level: string }> = data.risks || [];
      const lpDanger = risks.some(
        (r) =>
          r.name?.toLowerCase().includes("lp") && r.level === "danger"
      );

      // Check top 10 holder concentration
      const top10Pct: number = data.top10HoldersPercent ?? 0;
      const holdersConcentrated = top10Pct > 80;

      if (lpDanger) return { lpSafe: false, holdersSafe: !holdersConcentrated, reason: "LP not burned" };
      if (holdersConcentrated) return { lpSafe: true, holdersSafe: false, reason: `top10 holders ${top10Pct.toFixed(0)}%` };

      return { lpSafe: true, holdersSafe: true, reason: "healthy" };
    }
  } catch {}
  // API failure → allow entry
  return { lpSafe: true, holdersSafe: true, reason: "api_unavailable" };
}

export async function startPriceScout(): Promise<void> {
  console.log("  [SCOUT] Starting price scout...");

  // Create broadcast channel for publishing confirmed entries
  const confirmedChannel = supabase.channel("pixiubot:confirmed");
  await confirmedChannel.subscribe();

  // Subscribe to pixiubot:entries channel
  const entryChannel = supabase.channel("pixiubot:entries");

  entryChannel
    .on("broadcast", { event: "enter" }, async ({ payload }) => {
      const entry = payload as EntryEvent;
      const coin =
        entry.coin_name || entry.coin_address.slice(0, 8) + "...";

      const { price, source } = await fetchDexScreenerPrice(
        entry.coin_address
      );

      if (!price || price <= 0) {
        console.log(
          `  [SKIP] ${coin} — could not fetch price, skipping entry`
        );
        return;
      }

      console.log(
        `  [SCOUT] ${coin} price confirmed $${price.toFixed(10)} (source: ${source})`
      );

      // Filter 0: Max entry price — reject high-priced stable tokens
      if (isPriceTooHigh(price)) {
        console.log(
          `  [VALIDATOR] Rejected — price too high: $${price.toFixed(10)} (max $0.001)`
        );
        return;
      }

      // Filter 1: Minimum liquidity check
      const { liquidity, passed: liqPassed } = await checkLiquidity(
        entry.coin_address
      );
      if (!liqPassed) {
        console.log(
          `  [SCOUT] ❌ ${coin} — liquidity too low ($${liquidity?.toLocaleString() ?? "?"}) min $${MIN_LIQUIDITY_USD.toLocaleString()}`
        );
        return;
      }
      if (liquidity !== null) {
        console.log(
          `  [SCOUT] ✅ ${coin} — liquidity $${liquidity.toLocaleString()} confirmed`
        );
      }

      // Filter 2: LP burned & holder concentration check
      const { lpSafe, holdersSafe, reason: rugReason } = await checkLpAndHolders(
        entry.coin_address
      );
      if (!lpSafe) {
        console.log(`  [SCOUT] ❌ ${coin} — LP not burned (rug risk)`);
        return;
      }
      if (!holdersSafe) {
        console.log(
          `  [SCOUT] ❌ ${coin} — top10 holders >80% (developer cluster)`
        );
        return;
      }
      if (lpSafe && holdersSafe && rugReason !== "api_unavailable") {
        console.log(`  [SCOUT] ✅ ${coin} — LP burned, holders healthy`);
      }

      confirmedChannel.send({
        type: "broadcast",
        event: "confirmed_entry",
        payload: {
          coin_address: entry.coin_address,
          coin_name: entry.coin_name,
          wallet_label: entry.wallet_label,
          smart_money_count: entry.smart_money_count,
          price,
          price_source: source,
        },
      });
    })
    .subscribe();

  console.log("  [SCOUT] Listening on pixiubot:entries channel");
}
