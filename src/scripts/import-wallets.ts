/**
 * PixiuBot — Wallet Importer (Sprint 1.1)
 * Usage: npx ts-node src/scripts/import-wallets.ts
 *
 * Reads wallets.json (Ethan Rosper's tracked wallet list).
 * Imports into tracked_wallets table with actual names as tags.
 * Deduplicates on wallet_address via upsert.
 */

import fs from "fs";
import path from "path";
import supabase from "../lib/supabase-server";

const WALLETS_FILE = path.resolve(__dirname, "../../wallets.json");
const BATCH_SIZE = 50;

interface WalletJson {
  trackedWalletAddress: string;
  name: string;
  emoji: string;
  alertsOn: boolean;
}

function loadWallets(filePath: string): WalletJson[] {
  if (!fs.existsSync(filePath)) {
    console.error(`  [ERROR] File not found: ${filePath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const data: WalletJson[] = JSON.parse(raw);

  // Validate
  return data.filter((w) => {
    if (!w.trackedWalletAddress || w.trackedWalletAddress.length < 32) {
      console.warn(`  [SKIP] Invalid address for "${w.name}"`);
      return false;
    }
    return true;
  });
}

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Wallet Importer (JSON)");
  console.log("═══════════════════════════════════════════════════════════\n");

  const wallets = loadWallets(WALLETS_FILE);
  console.log(`  Loaded ${wallets.length} wallets from wallets.json\n`);

  if (wallets.length === 0) {
    console.log("  No valid wallets found.\n");
    return;
  }

  let imported = 0;
  let skipped = 0;

  // Batch upsert for speed
  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    const batch = wallets.slice(i, i + BATCH_SIZE);

    const rows = batch.map((w) => ({
      wallet_address: w.trackedWalletAddress,
      tag: w.name || `wallet-${w.trackedWalletAddress.slice(0, 8)}`,
      active: true,
    }));

    const { error } = await supabase
      .from("tracked_wallets")
      .upsert(rows, { onConflict: "wallet_address" });

    if (error) {
      console.error(`  [ERROR] Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${error.message}`);
      skipped += batch.length;
    } else {
      imported += batch.length;
      console.log(
        `  [BATCH ${Math.floor(i / BATCH_SIZE) + 1}] ${batch.length} wallets upserted (${imported}/${wallets.length})`
      );
    }
  }

  console.log(`\n  ✓ Done: ${imported} imported, ${skipped} skipped.`);
  console.log(`  Total in file: ${wallets.length}\n`);

  // Verify count in DB
  const { count } = await supabase
    .from("tracked_wallets")
    .select("id", { count: "exact", head: true });

  console.log(`  Tracked wallets in Supabase: ${count}\n`);
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
