/**
 * PixiuBot — Phantom Wallet Balance API
 * GET /api/phantom-balance → { sol, usd, lamports }
 *
 * Fetches LIVE SOL balance from Helius RPC. No caching.
 */

export const runtime = "edge";

const WALLET_PUBKEY = "ESK3r8n5jhaLn9Few59QKNJ5UMeD9iqZ5p1rbU9euvey";
const HELIUS_KEY = process.env.HELIUS_API_KEY || "f3a19f49-e666-407d-b11f-0a0d58b24d5d";
const STARTING_SOL = 3.6705; // Balance before first live trade

async function getSolPrice(): Promise<number> {
  // CoinGecko — reliable and free
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    if (res.ok) {
      const data = await res.json();
      const price = data?.solana?.usd;
      if (typeof price === "number" && price > 0) return price;
    }
  } catch {}
  return 85; // fallback
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
        id: Date.now(), // Unique ID prevents any caching
        method: "getBalance",
        params: [WALLET_PUBKEY],
      }),
    });

    if (!res.ok) {
      return new Response(
        JSON.stringify({ sol: 0, usd: 0, lamports: 0, startingSol: STARTING_SOL, pnlSol: 0, pnlUsd: 0 }),
        { status: 200, headers: HEADERS }
      );
    }

    const [data, solPrice] = await Promise.all([res.json(), getSolPrice()]);
    const lamports = data.result?.value ?? 0;
    const sol = lamports / 1e9;
    const usd = sol * solPrice;
    const pnlSol = sol - STARTING_SOL;
    const pnlUsd = pnlSol * solPrice;

    return new Response(
      JSON.stringify({
        sol: Number(sol.toFixed(4)),
        usd: Number(usd.toFixed(2)),
        lamports,
        startingSol: STARTING_SOL,
        pnlSol: Number(pnlSol.toFixed(4)),
        pnlUsd: Number(pnlUsd.toFixed(2)),
      }),
      { status: 200, headers: HEADERS }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ sol: 0, usd: 0, lamports: 0, startingSol: STARTING_SOL, pnlSol: 0, pnlUsd: 0, error: err.message }),
      { status: 200, headers: HEADERS }
    );
  }
}
