/**
 * Worker environment.
 *
 * `WORKSPACE_ROOM` is declared without its generic parameter on purpose. The
 * generic would name `WorkspaceRoom`, which lives in `room.ts`, which imports
 * this file — and while TypeScript is happy with a type-only cycle, keeping the
 * binding loose here means `env.ts` has no imports at all and cannot participate
 * in one.
 */
export interface Env {
  WORKSPACE_ROOM: DurableObjectNamespace;
  /** e.g. https://zljhwosvsdqvgcgusqct.supabase.co — not a secret. */
  SUPABASE_URL: string;
  /**
   * The publishable (legacy: anon) key. Stored as a Worker secret rather than a
   * plain var for hygiene, not because it is confidential: it is already
   * compiled into the desktop app and handed to every client. It is what
   * `apikey` must be for the authorization calls below to reach PostgREST.
   */
  SUPABASE_ANON_KEY: string;
}
