/**
 * pump.fun bonding-curve pricer (shadow-only; read-only on-chain).
 *
 * Fresh pump.fun launches have NO DexScreener price at t0 and the pump.fun
 * frontend API is Cloudflare-blocked (HTTP 530). The only free t0/forward price
 * source is the on-chain bonding-curve account: derive its PDA from the mint,
 * read it via Helius RPC, and compute price = virtualSolReserves /
 * virtualTokenReserves. Used by the SNIPER-v1 launch probe. NO SOL, NO writes —
 * pure RPC reads.
 *
 * Account layout (Anchor): [0..8) discriminator, [8..16) virtualTokenReserves
 * u64, [16..24) virtualSolReserves u64, [24..32) realTokenReserves,
 * [32..40) realSolReserves, [40..48) tokenTotalSupply, [48] complete (bool).
 * Verified live 2026-06-24: account len=115, prices ~2.8-4.2e-8 SOL/token.
 */
import { PublicKey } from "@solana/web3.js";

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const CURVE_SEED = Buffer.from("bonding-curve");
const SOL_DECIMALS = 1e9;
const TOKEN_DECIMALS = 1e6;

export function bondingCurvePda(mint: string): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [CURVE_SEED, new PublicKey(mint).toBuffer()],
    PUMP_PROGRAM,
  );
  return pda.toBase58();
}

export type CurveState = {
  priceSol: number;        // SOL per token (virtual reserves)
  complete: boolean;       // true = curve filled / token graduated to a DEX
  virtualSol: number;
  virtualTokens: number;
};

/**
 * Read + decode the bonding-curve state for a mint. Returns null if the curve
 * account does not exist (not a pump.fun mint, or already migrated and closed)
 * or on any read/parse failure (fail-closed — caller treats null as no price).
 */
export async function getCurveState(mint: string, rpcUrl: string): Promise<CurveState | null> {
  let pda: string;
  try {
    pda = bondingCurvePda(mint);
  } catch {
    return null;
  }
  try {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [pda, { encoding: "base64" }] }),
    });
    if (!resp.ok) return null;
    const j = (await resp.json()) as any;
    const val = j?.result?.value;
    if (!val?.data?.[0]) return null;
    const buf = Buffer.from(val.data[0], "base64");
    if (buf.length < 49) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const vTok = Number(dv.getBigUint64(8, true));
    const vSol = Number(dv.getBigUint64(16, true));
    const complete = buf[48] !== 0;
    if (vTok <= 0 || vSol <= 0) return null;
    const priceSol = (vSol / SOL_DECIMALS) / (vTok / TOKEN_DECIMALS);
    if (!isFinite(priceSol) || priceSol <= 0) return null;
    return { priceSol, complete, virtualSol: vSol, virtualTokens: vTok };
  } catch {
    return null;
  }
}

/** Convenience: just the price (SOL per token), or null. */
export async function getCurvePriceSol(mint: string, rpcUrl: string): Promise<number | null> {
  const s = await getCurveState(mint, rpcUrl);
  return s ? s.priceSol : null;
}
