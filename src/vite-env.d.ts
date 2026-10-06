/// <reference types="vite/client" />

/**
 * The environment variables this app reads, named in one place.
 *
 * Vite already gives `import.meta.env` a permissive index signature, so nothing
 * here changes what compiles — this exists so that the complete set of variables
 * the app depends on is greppable and described, rather than discoverable only
 * by searching for `import.meta.env` at each use site.
 *
 * All of them are **inlined into the bundle at build time**. A build compiled
 * without one does not fall back to anything at runtime; the affected feature
 * reports itself as unconfigured. See `.env.example` for what each one means.
 */
interface ImportMetaEnv {
  /** Supabase project URL, e.g. `https://<ref>.supabase.co`. */
  readonly VITE_SUPABASE_URL?: string;
  /** Legacy anon JWT. Superseded by the publishable key below. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Publishable key. Either this or the anon key is required. */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /**
   * Origin of the workspace presence Durable Object, from
   * `cloudflare/workspace-room`. No trailing slash.
   *
   * Optional: the code defaults to the deployed worker, so this only needs
   * setting to point at a different deployment.
   */
  readonly VITE_WORKSPACE_LIVE_URL?: string;
}
