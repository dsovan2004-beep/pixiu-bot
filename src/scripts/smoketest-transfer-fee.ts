import "../lib/supabase-server";
import { Connection, PublicKey } from "@solana/web3.js";

const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const BLOCKING: Record<number, string> = {
  1: "TransferFeeConfig",
  9: "NonTransferable",
  12: "PermanentDelegate",
  14: "TransferHook",
};

const MINTS = [
  { name: "Jude Zero G (failed with 6024)", mint: "HLe8k9hNFAWXTm5LqXZs28PYQ4whkMqfJph6DWkkpump" },
];

function conn() {
  return new Connection(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, "confirmed");
}

(async () => {
  for (const m of MINTS) {
    if (!m.mint) continue;
    const info = await conn().getAccountInfo(new PublicKey(m.mint));
    if (!info) { console.log(`${m.name}: not found`); continue; }
    const is2022 = info.owner.equals(TOKEN_2022);
    if (!is2022) { console.log(`${m.name}: standard SPL (safe)`); continue; }
    const d = info.data;
    const exts: Array<{ type: number; name: string; len: number }> = [];
    let offset = 166, blockingHit: string | null = null;
    while (offset + 4 <= d.length) {
      const t = d.readUInt16LE(offset);
      const l = d.readUInt16LE(offset + 2);
      const name = BLOCKING[t] ?? `type_${t}`;
      exts.push({ type: t, name, len: l });
      if (BLOCKING[t] && !blockingHit) blockingHit = BLOCKING[t];
      offset += 4 + l;
      if (l === 0 && t === 0) break;
    }
    console.log(`${m.name}`);
    console.log(`  token2022=${is2022} data_len=${d.length}`);
    console.log(`  extensions: ${exts.map(e => `${e.name}(t=${e.type},l=${e.len})`).join(", ")}`);
    console.log(`  blocked: ${blockingHit ?? "no"}`);
  }
})();
