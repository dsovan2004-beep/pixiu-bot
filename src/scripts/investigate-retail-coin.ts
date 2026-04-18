import "../lib/supabase-server";
import supabase from "../lib/supabase-server";

const MINT = "73DXBphat6UdTgAsfEZQ56hvnPvpxNps1ECEuix6pump";
const WALLET = "ESK3r8n5jhaLn9Few59QKNJ5UMeD9iqZ5p1rbU9euvey";

(async () => {
  // ─── 1. All trades for this mint today ───
  const { data: rows, error } = await supabase
    .from("trades")
    .select("*")
    .eq("coin_address", MINT)
    .order("entry_time", { ascending: true });
  if (error) { console.error(error); return; }

  console.log(`\n=== trades for ${MINT} ===\n`);
  for (const r of rows ?? []) {
    console.log(`id=${r.id}`);
    console.log(`  entry_time:      ${r.entry_time}`);
    console.log(`  exit_time:       ${r.exit_time ?? "—"}`);
    console.log(`  status:          ${r.status}`);
    console.log(`  exit_reason:     ${r.exit_reason ?? "—"}`);
    console.log(`  grid_level:      L${r.grid_level ?? 0}`);
    console.log(`  remaining_pct:   ${r.remaining_pct ?? "—"}`);
    console.log(`  pnl_pct:         ${r.pnl_pct ?? "—"}`);
    console.log(`  partial_pnl:     ${r.partial_pnl ?? "—"}`);
    console.log(`  pnl_usd:         ${r.pnl_usd ?? "—"}`);
    console.log(`  position_size:   ${r.position_size_usd ?? "—"}`);
    console.log(`  wallet_tag:      ${r.wallet_tag}`);
    console.log(`  entry_price:     ${r.entry_price}`);
    console.log(`  exit_price:      ${r.exit_price ?? "—"}`);
    console.log("");
  }

  // ─── 2. Check Token-2022 extensions on the mint via Helius RPC ───
  const rpc = process.env.HELIUS_RPC_URL
    || (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : null);
  if (!rpc) { console.log("No Helius RPC configured"); return; }

  const accRes = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [MINT, { encoding: "jsonParsed" }],
    }),
  });
  const accJs: any = await accRes.json();
  const info = accJs?.result?.value;
  console.log(`=== Mint on-chain ===`);
  console.log(`  owner program: ${info?.owner}`);
  const parsed = info?.data?.parsed;
  console.log(`  type: ${parsed?.type}`);
  const exts = parsed?.info?.extensions || [];
  console.log(`  extensions (${exts.length}):`);
  for (const e of exts) {
    console.log(`    - ${e.extension}${e.state ? ` → ${JSON.stringify(e.state).slice(0, 120)}` : ""}`);
  }

  // Raw base64 to show TLV tags manually (what the webhook filter actually parses)
  const rawRes = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "getAccountInfo",
      params: [MINT, { encoding: "base64" }],
    }),
  });
  const rawJs: any = await rawRes.json();
  const [b64] = rawJs?.result?.value?.data || [];
  if (b64) {
    const buf = Buffer.from(b64, "base64");
    console.log(`  raw account data length: ${buf.length} bytes`);
    // Token-2022 extensions start after the 165-byte mint base + 1-byte account type (166)
    if (buf.length > 166) {
      console.log(`  TLV region starts at offset 166, ${buf.length - 166} bytes of extension data`);
      let off = 166;
      const tlvs: string[] = [];
      while (off + 4 <= buf.length) {
        const t = buf.readUInt16LE(off);
        const l = buf.readUInt16LE(off + 2);
        tlvs.push(`type=${t} len=${l}`);
        off += 4 + l;
        if (tlvs.length > 20) break;
      }
      console.log(`  TLV entries: ${tlvs.join(" | ")}`);
    } else {
      console.log(`  SPL Token (not Token-2022) — no TLV region`);
    }
  }

  // ─── 3. Legacy bankroll history ───
  const { data: bankrollNow } = await supabase
    .from("DEPRECATED_DEPRECATED_bankroll")
    .select("*");
  console.log(`\n=== DEPRECATED_DEPRECATED_bankroll current ===`);
  console.log(JSON.stringify(bankrollNow, null, 2));

  // Try bankroll history table if it exists
  const { data: hist, error: histErr } = await supabase
    .from("DEPRECATED_DEPRECATED_bankroll_history")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(20);
  console.log(`\n=== DEPRECATED_DEPRECATED_bankroll_history (last 20) ===`);
  if (histErr) {
    console.log(`  (table not found or inaccessible: ${histErr.message})`);
  } else {
    for (const h of hist ?? []) {
      console.log(`  ${h.created_at}  ${h.reason ?? "—"}  Δ=${h.delta_usd ?? "?"}  balance=${h.balance_after ?? "?"}`);
    }
  }

  // ─── 4. Executor logs (if persisted) ───
  const { data: execLogs } = await supabase
    .from("executor_logs")
    .select("*")
    .eq("coin_address", MINT)
    .order("created_at", { ascending: true })
    .limit(50);
  if (execLogs && execLogs.length) {
    console.log(`\n=== executor_logs for this mint (${execLogs.length}) ===`);
    for (const l of execLogs) console.log(`  ${l.created_at}  ${l.level}  ${l.message}`);
  }

  // ─── 5. Real on-chain wallet balance for this mint ───
  const balRes = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 3, method: "getTokenAccountsByOwner",
      params: [WALLET, { mint: MINT }, { encoding: "jsonParsed" }],
    }),
  });
  const balJs: any = await balRes.json();
  const tok = balJs?.result?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount;
  console.log(`\n=== Wallet token balance ===`);
  console.log(`  ${tok?.uiAmount ?? 0} tokens (raw: ${tok?.amount}, dec: ${tok?.decimals})`);
})();
