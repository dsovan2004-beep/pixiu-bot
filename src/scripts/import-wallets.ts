/**
 * PixiuBot — Wallet Importer (Sprint 1)
 * Usage: npx ts-node src/scripts/import-wallets.ts
 *
 * Reads wallets.txt and imports into tracked_wallets table.
 * Deduplicates on wallet_address. Tags all as 'ethan-list' by default.
 */

import fs from "fs";
import path from "path";
import supabase from "../lib/supabase-server";

const WALLETS_FILE = path.resolve(__dirname, "../../wallets.txt");
const DEFAULT_TAG = "ethan-list";

interface WalletEntry {
  address: string;
  tag: string;
}

function parseWalletsFile(filePath: string): WalletEntry[] {
  if (!fs.existsSync(filePath)) {
    console.error(`  [ERROR] File not found: ${filePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const entries: WalletEntry[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Format: ADDRESS [optional-tag]
    const parts = trimmed.split(/\s+/);
    const address = parts[0];
    const tag = parts[1] || DEFAULT_TAG;

    // Basic Solana address validation (base58, 32-44 chars)
    if (address.length < 32 || address.length > 44) {
      console.warn(`  [SKIP] Invalid address: ${address}`);
      continue;
    }

    entries.push({ address, tag });
  }

  return entries;
}

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Wallet Importer");
  console.log("═══════════════════════════════════════════════════════════\n");

  const wallets = parseWalletsFile(WALLETS_FILE);

  if (wallets.length === 0) {
    console.log("  No wallets found in wallets.txt.");
    console.log("  Add Solana wallet addresses (one per line) and re-run.\n");
    return;
  }

  console.log(`  Found ${wallets.length} wallet(s) in wallets.txt\n`);

  let imported = 0;
  let skipped = 0;

  for (const wallet of wallets) {
    const { error } = await supabase
      .from("tracked_wallets")
      .upsert(
        {
          wallet_address: wallet.address,
          tag: wallet.tag,
          active: true,
        },
        { onConflict: "wallet_address" }
      );

    if (error) {
      console.error(`  [ERROR] ${wallet.address.slice(0, 8)}...: ${error.message}`);
      skipped++;
    } else {
      console.log(`  [OK] ${wallet.address.slice(0, 8)}... (tag: ${wallet.tag})`);
      imported++;
    }
  }

  console.log(`\n  Done: ${imported} imported, ${skipped} skipped.\n`);
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
