/**
 * PixiuBot — Phantom Wallet Balance API
 * GET /api/phantom-balance → { sol, usd, lamports }
 *
 * Fetches LIVE SOL balance from Helius RPC. No caching.
 */

export const runtime = "edge";

const SOL_PRICE_USD = 85;
const WALLET_PUBKEY = "ESK3r8n5jhaLn9Few59QKNJ5UMeD9iqZ5p1rbU9euvey";
const HELIUS_KEY = process.env.HELIUS_API_KEY || "f3a19f49-e666-407d-b11f-0a0d58b24d5d";
const STARTING_SOL = 3.6705; // Balance before first live trade

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
        id: 1,
        method: "getBalance",
        params: [WALLET_PUBKEY],
      }),
      cache: "no-store" as RequestCache,
    });

    if (!res.ok) {
      return new Response(
        JSON.stringify({ sol: 0, usd: 0, lamports: 0, startingSol: STARTING_SOL, pnlSol: 0, pnlUsd: 0 }),
        { status: 200, headers: HEADERS }
      );
    }

    const data = await res.json();
    const lamports = data.result?.value ?? 0;
    const sol = lamports / 1e9;
    const usd = sol * SOL_PRICE_USD;
    const pnlSol = sol - STARTING_SOL;
    const pnlUsd = pnlSol * SOL_PRICE_USD;

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
