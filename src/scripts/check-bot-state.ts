import "../lib/supabase-server";
import supabase from "../lib/supabase-server";
(async () => {
  const { data } = await supabase.from("bot_state").select("*").limit(1).single();
  console.log(JSON.stringify(data, null, 2));
})();
