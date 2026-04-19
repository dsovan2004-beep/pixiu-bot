/**
 * PixiuBot — Wallet Balance API
 * GET /api/phantom-balance → { sol, usd, solPrice }
 *
 * Fetches LIVE SOL balance from Helius RPC. No caching.
 * No baseline/starting SOL tracked — wallet numbers are pure current state.
 * Performance accounting (Trade PnL, Win Rate, ROI) is computed by the
 * dashboard from `trades.real_pnl_sol`, which is decoupled from wallet
 * balance and unaffected by deposits/withdrawals.
 */

export const runtime = "edge";

const WALLET_PUBKEY = "ESK3r8n5jhaLn9Few59QKNJ5UMeD9iqZ5p1rbU9euvey";
const HELIUS_KEY = process.env.HELIUS_API_KEY || "f3a19f49-e666-407d-b11f-0a0d58b24d5d";

async function getSolPrice(): Promise<number> {
  try {
    const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112");
    if (res.ok) {
      const data = await res.json();
      const p = data.pairs?.find((pair: any) =>
        pair.quoteToken?.symbol === "USDC" || pair.quoteToken?.symbol === "USDT"
      );
      const price = p ? parseFloat(p.priceUsd) : 0;
      if (price > 0) return price;
    }
  } catch {}
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "getAsset",
        params: { id: "So11111111111111111111111111111111111111112" },
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const price = data.result?.token_info?.price_info?.price_per_token;
      if (typeof price === "number" && price > 0) return price;
    }
  } catch {}
  return 84; // last-known approximate fallback
}

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-cache, no-store, must-revalidate",
};

export async function GET(): Promise<Response> {
  try {
    const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "getBalance",
        params: [WALLET_PUBKEY],
      }),
    });

    if (!res.ok) {
      return new Response(
        JSON.stringify({ sol: 0, usd: 0, lamports: 0, solPrice: 0 }),
        { status: 200, headers: HEADERS }
      );
    }

    const [data, solPrice] = await Promise.all([res.json(), getSolPrice()]);
    const lamports = data.result?.value ?? 0;
    const sol = lamports / 1e9;
    const usd = sol * solPrice;

    return new Response(
      JSON.stringify({
        sol: Number(sol.toFixed(4)),
        usd: Number(usd.toFixed(2)),
        lamports,
        solPrice: Number(solPrice.toFixed(2)),
      }),
      { status: 200, headers: HEADERS }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ sol: 0, usd: 0, lamports: 0, solPrice: 0, error: err.message }),
      { status: 200, headers: HEADERS }
    );
  }
}
