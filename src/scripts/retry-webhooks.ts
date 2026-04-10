/**
 * PixiuBot — Retry Failed Webhooks (wallets 501-718)
 * Usage: npx tsx src/scripts/retry-webhooks.ts
 */

import supabase from "../lib/supabase-server";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_API_KEY) throw new Error("Missing HELIUS_API_KEY");

const WEBHOOK_URL = "https://pixiu-bot.pages.dev/api/webhook";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5_000;
const BATCH_SIZE = 100;

// Already covered: first 500 wallets (5 webhooks × 100)
const ALREADY_COVERED = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Retry Failed Webhooks");
  console.log("═══════════════════════════════════════════════════════════\n");

  const { data: wallets } = await supabase
    .from("tracked_wallets")
    .select("wallet_address")
    .eq("active", true);

  if (!wallets) {
    console.error("  [ERROR] No wallets found");
    process.exit(1);
  }

  // Only the uncovered wallets (501+)
  const uncovered = wallets.slice(ALREADY_COVERED);
  console.log(`  Total wallets: ${wallets.length}`);
  console.log(`  Already covered: ${ALREADY_COVERED}`);
  console.log(`  Uncovered: ${uncovered.length}\n`);

  if (uncovered.length === 0) {
    console.log("  All wallets covered!");
    return;
  }

  const newWebhookIds: string[] = [];
  const failedAddresses: string[] = [];

  for (let i = 0; i < uncovered.length; i += BATCH_SIZE) {
    const batch = uncovered.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const addresses = batch.map((w) => w.wallet_address);

    let success = false;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      console.log(
        `  Batch ${batchNum} (${addresses.length} wallets) — attempt ${attempt}/${MAX_RETRIES}...`
      );

      const res = await fetch(
        `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            webhookURL: WEBHOOK_URL,
            transactionTypes: ["SWAP"],
            accountAddresses: addresses,
            webhookType: "enhanced",
          }),
        }
      );

      if (res.ok) {
        const data = await res.json();
        newWebhookIds.push(data.webhookID);
        console.log(`  [OK] Batch ${batchNum}: ${data.webhookID}\n`);
        success = true;
        break;
      }

      const errBody = await res.text();
      console.error(`  [FAIL] ${res.status}: ${errBody}`);

      if (attempt < MAX_RETRIES) {
        console.log(`  Waiting ${RETRY_DELAY_MS / 1000}s before retry...\n`);
        await sleep(RETRY_DELAY_MS);
      }
    }

    if (!success) {
      failedAddresses.push(...addresses);
      console.error(`  [GIVE UP] Batch ${batchNum} failed after ${MAX_RETRIES} attempts\n`);
    }
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  New webhooks: ${newWebhookIds.length}`);
  if (newWebhookIds.length > 0) {
    console.log(`  IDs: ${newWebhookIds.join(",")}`);
    console.log(`  Add to HELIUS_WEBHOOK_IDS in .env.local`);
  }

  if (failedAddresses.length > 0) {
    console.log(`\n  Uncovered wallets (${failedAddresses.length}):`);
    for (const addr of failedAddresses) {
      console.log(`    ${addr}`);
    }
  } else {
    console.log(`\n  All ${uncovered.length} remaining wallets now covered!`);
  }
  console.log("═══════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("Retry failed:", err);
  process.exit(1);
});
