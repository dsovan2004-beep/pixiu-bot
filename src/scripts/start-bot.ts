import "../lib/supabase-server";
import supabase from "../lib/supabase-server";

(async () => {
  const { data, error } = await supabase
    .from("bot_state")
    .update({ is_running: true })
    .eq("is_running", false)
    .select();
  if (error) console.error(error);
  else console.log(`✅ Bot started at ${new Date().toISOString()} — rows updated: ${data?.length ?? 0}`);
})();
