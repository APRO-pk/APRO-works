import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;

// Supabase now issues "publishable" keys (sb_publishable_...) which replace the
// legacy anon JWT key. Accept either variable name so existing setups and new
// projects both work.
const supabaseKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

/**
 * Why the credentials are absent, or null when they are present.
 *
 * This used to be a module-scope `throw`, on the reasoning that a missing credential
 * should fail loudly. It did the opposite. `App` imports this module, so the throw took
 * down the whole module graph before React could mount — and because the window is
 * created hidden and only revealed from the interface, nothing ever revealed it. The
 * result was an app with no window and no error anywhere, which is precisely the
 * outcome the throw was meant to prevent.
 *
 * Reporting the problem instead lets `App` render a screen that states what is wrong.
 */
export const supabaseConfigError: string | null =
  supabaseUrl && supabaseKey
    ? null
    : "Supabase credentials missing. Set VITE_SUPABASE_URL and either " +
      "VITE_SUPABASE_ANON_KEY or VITE_SUPABASE_PUBLISHABLE_KEY in .env, then rebuild " +
      "(Vite inlines these values at build time). See .env.example.";

/**
 * The client.
 *
 * Placeholder values are used when the configuration is missing, so that importing this
 * module can never fail. Nothing may use the client until `supabaseConfigError` has been
 * checked — `App` returns its configuration screen before rendering anything else.
 */
export const supabase = createClient(
  supabaseUrl ?? "https://unconfigured.invalid",
  supabaseKey ?? "unconfigured",
);
