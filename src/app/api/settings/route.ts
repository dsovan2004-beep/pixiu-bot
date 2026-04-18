/**
 * PixiuBot — Settings API
 * GET  /api/settings → { live_trading: true }
 *
 * Sprint 10: only live mode exists. bot_state.mode is always "live".
 * This endpoint remains for backwards compat with any caller that still
 * probes for the field; it always reports live=true. POST is a no-op.
 */

import { createClient } from "@supabase/supabase-js";

export const runtime = "edge";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

export async function GET(): Promise<Response> {
  // Ensure mode is "live" — self-heal if something set it otherwise.
  try {
    await supabase
      .from("bot_state")
      .update({ mode: "live" })
      .neq("mode", "live");
  } catch {}

  return new Response(
    JSON.stringify({ live_trading: true }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

export async function POST(): Promise<Response> {
  // No-op — live is the only mode now.
  return new Response(
    JSON.stringify({ ok: true, live_trading: true, mode: "live" }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
