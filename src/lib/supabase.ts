import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;

// Supabase now issues "publishable" keys (sb_publishable_...) which replace the
// legacy anon JWT key. Accept either variable name so existing setups and new
// projects both work.
const supabaseKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Fail loudly and clearly: a missing credential otherwise throws from inside
// createClient during module load, which prevents the whole app from mounting
// and leaves the Tauri window hidden with no visible error.
if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    "Supabase credentials missing. Set VITE_SUPABASE_URL and either " +
      "VITE_SUPABASE_ANON_KEY or VITE_SUPABASE_PUBLISHABLE_KEY in .env, " +
      "then restart `npm run tauri dev` (env vars are read only at startup).",
  );
}

export const supabase = createClient(supabaseUrl, supabaseKey);
