/**
 * PixiuBot — Helius Webhook Setup
 * Usage: npx tsx src/scripts/setup-webhook.ts
 *
 * Registers a webhook with Helius for all tracked wallets.
 * Run once, then the webhook ID is stored for reference.
 */

import supabase from "../lib/supabase-server";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_API_KEY) {
  throw new Error("Missing HELIUS_API_KEY in .env.local");
}

const WEBHOOK_URL = "https://pixiu-bot.pages.dev/api/webhook";

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PIXIU BOT — Helius Webhook Setup");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Fetch all active wallets
  const { data: wallets, error } = await supabase
    .from("tracked_wallets")
    .select("wallet_address")
    .eq("active", true);

  if (error || !wallets) {
    console.error("  [ERROR] Failed to fetch wallets:", error?.message);
    process.exit(1);
  }

  const addresses = wallets.map((w) => w.wallet_address);
  console.log(`  Found ${addresses.length} active wallets\n`);

  // Check for existing webhooks first
  console.log("  Checking existing webhooks...");
  const listRes = await fetch(
    `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`
  );

  if (listRes.ok) {
    const existing = await listRes.json();
    if (Array.isArray(existing) && existing.length > 0) {
      console.log(`  Found ${existing.length} existing webhook(s):`);
      for (const wh of existing) {
        console.log(
          `    ID: ${wh.webhookID} | URL: ${wh.webhookURL} | Accounts: ${wh.accountAddresses?.length || 0}`
        );
      }
      console.log("");

      // Delete old pixiu webhooks to avoid duplicates
      for (const wh of existing) {
        if (wh.webhookURL?.includes("pixiu-bot")) {
          console.log(`  Deleting old webhook ${wh.webhookID}...`);
          await fetch(
            `https://api.helius.xyz/v0/webhooks/${wh.webhookID}?api-key=${HELIUS_API_KEY}`,
            { method: "DELETE" }
          );
        }
      }
    }
  }

  // Helius free tier limits webhook to 100 addresses per webhook
  // We need multiple webhooks for 718 wallets
  const BATCH_SIZE = 100;
  const webhookIds: string[] = [];

  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const batch = addresses.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(addresses.length / BATCH_SIZE);

    console.log(
      `  Registering webhook ${batchNum}/${totalBatches} (${batch.length} addresses)...`
    );

    const res = await fetch(
      `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhookURL: WEBHOOK_URL,
          transactionTypes: ["SWAP"],
          accountAddresses: batch,
          webhookType: "enhanced",
        }),
      }
    );

    if (!res.ok) {
      const errBody = await res.text();
      console.error(
        `  [ERROR] Webhook ${batchNum} failed: ${res.status} ${errBody}`
      );

      // If we hit a limit, log what we have and stop
      if (res.status === 400 || res.status === 403) {
        console.log(
          "\n  Helius free tier may limit webhook count. Registered what we could."
        );
        break;
      }
      continue;
    }

    const data = await res.json();
    const webhookId = data.webhookID;
    webhookIds.push(webhookId);
    console.log(`  [OK] Webhook ${batchNum}: ${webhookId}`);
  }

  console.log(`\n  ✓ Registered ${webhookIds.length} webhook(s)`);
  console.log(`  Webhook URL: ${WEBHOOK_URL}`);
  console.log(`  Webhook IDs: ${webhookIds.join(", ")}`);
  console.log(
    `\n  Add to .env.local:\n  HELIUS_WEBHOOK_IDS=${webhookIds.join(",")}\n`
  );
}

main().catch((err) => {
  console.error("Webhook setup failed:", err);
  process.exit(1);
});
