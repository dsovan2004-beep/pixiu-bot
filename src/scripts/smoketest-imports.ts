import "../lib/supabase-server";
import { LIVE_BUY_SOL, DAILY_LOSS_LIMIT_SOL, BUY_RESCUE_DELAY_MS } from "../config/smart-money";
import { sendAlert } from "../lib/telegram";
import { hasTokenBalance } from "../lib/jupiter-swap";

console.log("Constants:", { LIVE_BUY_SOL, DAILY_LOSS_LIMIT_SOL, BUY_RESCUE_DELAY_MS });
console.log("hasTokenBalance type:", typeof hasTokenBalance);
console.log("sendAlert type:", typeof sendAlert);

// Verify executor + guard import cleanly
import("../agents/trade-executor").then((m) => {
  console.log("trade-executor exports:", Object.keys(m));
});
import("../agents/risk-guard").then((m) => {
  console.log("risk-guard exports:", Object.keys(m));
});

void sendAlert("info", "smoketest — telegram noop if not configured").then(() => {
  setTimeout(() => process.exit(0), 1500);
});
