/**
 * PixiuBot Agent 3 — Price Scout
 *
 * Subscribes to pixiubot:entries channel.
 * Fetches real price from DexScreener for the coin address.
 * If price > 0 → publishes CONFIRMED_ENTRY to pixiubot:confirmed channel.
 * If price fails → logs [SKIP] and drops the entry.
 */

import supabase from "../lib/supabase-server";

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
