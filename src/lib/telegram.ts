/**
 * PixiuBot — Telegram alert sender.
 *
 * Setup:
 *   1. Talk to @BotFather on Telegram → /newbot → save the token
 *   2. Talk to your new bot once (any message) so it can DM you
 *   3. Visit https://api.telegram.org/bot<TOKEN>/getUpdates → grab `chat.id`
 *   4. Add to .env.local:
 *        TELEGRAM_BOT_TOKEN=<token>
 *        TELEGRAM_CHAT_ID=<chat_id>
 *
 * If env vars are missing, sendAlert is a silent no-op — bot keeps trading.
 */

const TELEGRAM_API = "https://api.telegram.org";

// In-memory dedupe — same alert text within 5min is suppressed
const recentAlerts = new Map<string, number>();
const DEDUPE_MS = 5 * 60_000;

export type AlertKind =
  | "whale_exit"
  | "circuit_breaker"
  | "stop_loss"
  | "take_profit"
  | "daily_limit"
  | "buy_failed"
  | "buy_rescued"
  | "sell_failed"
  | "stuck_sell"
  | "divergence_warning"
  | "info";

const EMOJI: Record<AlertKind, string> = {
  whale_exit: "🐳",
  circuit_breaker: "🚨",
  stop_loss: "❌",
  take_profit: "✅",
  daily_limit: "🛑",
  buy_failed: "⚠️",
  buy_rescued: "🛟",
  sell_failed: "🩸",
  stuck_sell: "🪤",
  divergence_warning: "📐",
  info: "ℹ️",
};

export async function sendAlert(kind: AlertKind, message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; // silently disabled

  const text = `${EMOJI[kind]} ${message}`;

  // Dedupe identical text within window
  const now = Date.now();
  const last = recentAlerts.get(text);
  if (last && now - last < DEDUPE_MS) return;
  recentAlerts.set(text, now);

  // Periodic dedupe map cleanup
  if (recentAlerts.size > 200) {
    for (const [k, t] of recentAlerts) {
      if (now - t > DEDUPE_MS) recentAlerts.delete(k);
    }
  }

  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error(`  [TELEGRAM] send failed: ${res.status}`);
    }
  } catch (err: any) {
    // Never let alert failure crash trading
    console.error(`  [TELEGRAM] error: ${err.message}`);
  }
}
