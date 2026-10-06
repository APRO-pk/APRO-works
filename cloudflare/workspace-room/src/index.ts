/**
 * The edge in front of the workspace rooms.
 *
 * This Worker has one job: decide whether the person asking for a WebSocket is
 * an active member of the workspace they named. Everything it decides comes from
 * Supabase, and it decides nothing itself — it presents the caller's own access
 * token to PostgREST and asks. `public.apro_workspace_role()` is the predicate
 * every row-level policy in the workspaces schema is built from, so asking it is
 * asking the same question the database asks; there is no second copy here to
 * fall out of step with it.
 *
 * The consequence worth stating plainly: **this Worker holds no service-role key
 * and cannot read data it was not given permission to read.** The publishable
 * key it does hold is the same one compiled into the desktop app.
 *
 * A verified caller is then handed to their workspace's Durable Object, which
 * never sees a credential at all — only the identity this Worker established.
 */

import { WorkspaceRoom, type PeerIdentity } from "./room";
import type { Env } from "./env";

export { WorkspaceRoom };

/** A v4-ish UUID. Enough to reject anything that is not a workspace id. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long Supabase may take before we give up on a connection attempt. */
const AUTH_TIMEOUT_MS = 8000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json(
        { ok: true, service: "apro-workspace-room" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // /workspace/:id/live
    const match = url.pathname.match(/^\/workspace\/([^/]+)\/live\/?$/);
    if (!match) {
      return Response.json({ error: "Not found." }, { status: 404 });
    }

    // `match[1]` is `string | undefined` under `noUncheckedIndexedAccess`; the
    // regex guarantees group 1, and the UUID test rejects anything else.
    const workspaceId = match[1] ?? "";
    if (!UUID.test(workspaceId)) {
      // Deliberately the same answer as a well-formed but unknown id, so this
      // endpoint cannot be used to tell the two apart.
      return Response.json({ error: "Not found." }, { status: 404 });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "Expected a WebSocket upgrade." }, { status: 426 });
    }

    const token = readToken(request, url);
    if (!token) {
      return Response.json({ error: "Missing access token." }, { status: 401 });
    }

    let identity: PeerIdentity;
    try {
      const access = await authorize(env, token, workspaceId);
      if (access === "unauthorized") {
        return Response.json({ error: "Invalid or expired session." }, { status: 401 });
      }
      if (access === "forbidden") {
        // "Not a member" and "no such workspace" are the same answer, so a
        // signed-in stranger cannot enumerate workspace ids.
        return Response.json({ error: "Workspace not found." }, { status: 404 });
      }
      identity = access;
    } catch (error) {
      return Response.json(
        { error: "Could not verify access.", detail: String(error) },
        { status: 502 },
      );
    }

    const room = env.WORKSPACE_ROOM.get(env.WORKSPACE_ROOM.idFromName(workspaceId));
    const forwarded = new Request("https://room/workspace/live", request);
    forwarded.headers.set("X-Workspace-Peer", JSON.stringify(identity));
    forwarded.headers.set("X-Workspace-Id", workspaceId);

    return room.fetch(forwarded);
  },
} satisfies ExportedHandler<Env>;

/**
 * The caller's token.
 *
 * Two places are accepted because two kinds of client exist. A browser
 * `WebSocket` cannot set request headers, so the desktop app must put the token
 * in the query string; a native client can do the tidier thing.
 *
 * The query-string form is a real tradeoff rather than a free choice: query
 * strings are more likely to be captured in logs than headers are. It is
 * acceptable here because the transport is TLS end to end and the token is a
 * short-lived user access token, not a durable secret — but it is why the Worker
 * does not log the URL, and why the client refreshes the token on every
 * reconnect instead of holding a connection open indefinitely.
 */
function readToken(request: Request, url: URL): string | null {
  const header = request.headers.get("Authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    const value = header.slice(7).trim();
    if (value) return value;
  }

  const param = url.searchParams.get("access_token");
  return param?.trim() || null;
}

type AccessResult = PeerIdentity | "unauthorized" | "forbidden";

/**
 * Ask Supabase two questions with the caller's own token.
 *
 * The order matters. `/auth/v1/user` establishes *who* the token belongs to and
 * is the only place a token is validated; `apro_workspace_role` then asks
 * whether that person is in this workspace. Skipping straight to the RPC would
 * technically work — PostgREST would reject an invalid token — but it would
 * collapse "your session expired" and "you are not a member" into one answer,
 * and the client needs to tell those apart to know whether to refresh or to give
 * up.
 *
 * `apro_workspace_role` returns the caller's role text, or NULL when they are
 * not a member. A workspace id that does not exist yields the same NULL, so
 * "unknown workspace" and "not yours" are indistinguishable here by
 * construction rather than by our choosing to treat them alike.
 *
 * The role it returns is exactly the role the database will enforce:
 * `OWNER | EDITOR | VIEWER`. The Worker does not interpret it — it is passed to
 * the room as an identity attribute so the client can label a cursor, and the
 * database remains the only thing that acts on it.
 */
async function authorize(
  env: Env,
  token: string,
  workspaceId: string,
): Promise<AccessResult> {
  const headers = {
    apikey: env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const who = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers,
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  });

  if (who.status === 401 || who.status === 403) return "unauthorized";
  if (!who.ok) throw new Error(`Supabase auth responded ${who.status}`);

  const user = (await who.json()) as {
    id?: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
  };
  if (!user?.id) return "unauthorized";

  const access = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/apro_workspace_role`, {
    method: "POST",
    headers,
    body: JSON.stringify({ p_workspace_id: workspaceId }),
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  });

  if (!access.ok) throw new Error(`Supabase rpc responded ${access.status}`);

  const role = (await access.json()) as unknown;
  if (typeof role !== "string" || role.length === 0) return "forbidden";

  return {
    user_id: user.id,
    email: user.email ?? "",
    full_name: displayName(user),
    role,
  };
}

/**
 * A short human name for a cursor chip.
 *
 * Deliberately derived from what the auth call already returned rather than from
 * a second query for `members.full_name`. The room needs something to draw on a
 * cursor; the *roster* the panel shows comes from `list_workspace_members()`,
 * which is the authority on names. Fetching the name twice would add a round
 * trip per connection to make one label marginally prettier, and would put two
 * answers to "what is this person called" in the system.
 */
function displayName(user: { email?: string; user_metadata?: Record<string, unknown> }): string {
  const meta = user.user_metadata ?? {};
  for (const key of ["full_name", "name", "display_name"] as const) {
    const value = meta[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const local = user.email?.split("@")[0]?.trim();
  return local || "Member";
}
