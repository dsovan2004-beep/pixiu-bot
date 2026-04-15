/**
 * PixiuBot — Phantom Wallet Balance API
 * GET /api/phantom-balance → { sol: number, usd: number }
 *
 * Fetches real SOL balance from Helius RPC.
 * Note: env vars not available on Cloudflare edge, so wallet pubkey
 * is hardcoded (public key is not secret).
 */

export const runtime = "edge";

const SOL_PRICE_USD = 85;
const WALLET_PUBKEY = "ESK3r8n5jhaLn9Few59QKNJ5UMeD9iqZ5p1rbU9euvey";
const HELIUS_KEY = process.env.HELIUS_API_KEY || "f3a19f49-e666-407d-b11f-0a0d58b24d5d";

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
    });

    if (!res.ok) {
      return new Response(
        JSON.stringify({ sol: 0, usd: 0, error: "rpc failed" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const data = await res.json();
    const lamports = data.result?.value ?? 0;
    const sol = lamports / 1e9;
    const usd = sol * SOL_PRICE_USD;

    return new Response(
      JSON.stringify({ sol: Number(sol.toFixed(4)), usd: Number(usd.toFixed(2)) }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ sol: 0, usd: 0, error: err.message }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
}
