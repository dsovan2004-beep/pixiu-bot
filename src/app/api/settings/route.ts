/**
 * PixiuBot — Settings API
 * GET  /api/settings → { live_trading: boolean }
 * POST /api/settings { live_trading: boolean } → updates bot_state.mode
 *
 * Uses bot_state.mode field: "paper" | "live"
 */

import { createClient } from "@supabase/supabase-js";

export const runtime = "edge";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

export async function GET(): Promise<Response> {
  const { data } = await supabase
    .from("bot_state")
    .select("mode")
    .limit(1)
    .single();

  const liveTrading = data?.mode === "live";

  return new Response(
    JSON.stringify({ live_trading: liveTrading }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const liveTrading = body.live_trading === true;
    const newMode = liveTrading ? "live" : "paper";

    const { error } = await supabase
      .from("bot_state")
      .update({ mode: newMode, last_updated: new Date().toISOString() })
      .neq("id", "00000000-0000-0000-0000-000000000000");

    if (error) {
      return new Response(
        JSON.stringify({ ok: false, error: error.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ ok: true, live_trading: liveTrading, mode: newMode }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
