/**
 * PixiuBot — Phantom Wallet Balance API
 * GET /api/phantom-balance → { sol: number, usd: number }
 *
 * Fetches real SOL balance from Helius RPC.
 */

export const runtime = "edge";

const SOL_PRICE_USD = 85; // Approximate — update as needed

export async function GET(): Promise<Response> {
  try {
    const walletPubkey = process.env.WALLET_PUBLIC_KEY;
    const heliusKey = process.env.HELIUS_API_KEY;

    if (!walletPubkey || !heliusKey) {
      return new Response(
        JSON.stringify({ sol: 0, usd: 0, error: "missing env vars" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;

    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBalance",
        params: [walletPubkey],
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
