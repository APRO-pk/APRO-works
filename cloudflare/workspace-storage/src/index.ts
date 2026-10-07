/**
 * The edge in front of per-user online storage.
 *
 * Every user gets a gigabyte for the file outputs their applications produce.
 * The bytes live in R2; the accounting lives in Supabase, in
 * `storage_objects` / `storage_accounts`. This Worker is the only thing that
 * holds both, and it exists because R2's own API cannot tell one member from
 * another.
 *
 * ## Why the bytes are not addressed directly
 *
 * An R2 bucket is reachable with an account key and addresses whatever object it
 * is told to. Shipping that key in a desktop app would mean one extracted string
 * reads everybody's gigabyte — so no client ever sees it. Every upload and
 * download passes through here, which derives the object key from a Supabase
 * access token the caller presented:
 *
 *     u/<owner_user_id>/w/<workspace_id>/<sha256>   shared with a workspace
 *     u/<owner_user_id>/self/<sha256>               private to its owner
 *
 * The owner segment is what makes a key unforgeable in practice: a caller can
 * only ever write under their own id, and a workspace segment is only ever
 * accepted after `apro_workspace_role()` has confirmed a place in that
 * workspace. That same function is the predicate every row-level policy in the
 * workspaces schema is built from, so the permission checked here and the one
 * enforced by PostgREST cannot drift apart.
 *
 * ## Why this is a second Worker rather than another route on the room
 *
 * The presence room's cleanest property is that it holds no service-role key and
 * therefore cannot read anything the caller could not. Storage needs the
 * opposite. Keeping them as two deployments means that property is still true of
 * the room, and a mistake here cannot reach into a live socket's authorisation.
 *
 * ## What is deliberately not done here
 *
 * Quota is *not* counted in this Worker. It is counted by
 * `register_storage_object()`, inside the same transaction that records the
 * object, because a count kept here would be a second source of truth and would
 * be wrong the first time two uploads raced. This Worker's job with respect to
 * quota is to translate the database's refusal into an HTTP status.
 */

import type { Env } from "./env";

/** A v4-ish UUID. Enough to reject anything that is not an id. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long Supabase may take before we give up on a connection attempt. */
const AUTH_TIMEOUT_MS = 8000;

/**
 * The largest single object this Worker will accept.
 *
 * There is a hard reason rather than a policy reason: the object key is its
 * content hash, and `crypto.subtle.digest` needs the whole thing in memory
 * before it will produce one. A Worker gets 128 MB, so a body large enough to
 * matter would be an out-of-memory rather than a polite error. R2 itself would
 * happily take a streamed upload many times this size; it is the content
 * addressing that sets the ceiling, and it is worth the ceiling.
 */
const MAX_OBJECT_BYTES = 25 * 1024 * 1024;

/**
 * Who may add an object to a shared workspace.
 *
 * `VIEWER` is a real read-only role in this schema, and honouring it here is the
 * difference between a role system and a label. A viewer can still store things
 * privately — that path takes no workspace at all.
 */
const WRITE_ROLES: ReadonlySet<string> = new Set(["OWNER", "EDITOR"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "apro-workspace-storage" });
    }

    if (!url.pathname.startsWith("/storage/")) {
      return json({ error: "Not found." }, 404);
    }

    const token = readToken(request);
    if (!token) return json({ error: "Missing access token." }, 401);

    let caller: Caller;
    try {
      const who = await identify(env, token);
      if (who === "unauthorized") {
        return json({ error: "Invalid or expired session." }, 401);
      }
      caller = who;
    } catch (error) {
      return json({ error: "Could not verify access.", detail: String(error) }, 502);
    }

    try {
      switch (url.pathname) {
        case "/storage/summary":
          return await summary(env, token);
        case "/storage/objects":
          return await objects(request, url, env, token, caller);
        case "/storage/blob":
          return await blob(request, url, env, token);
        default:
          return json({ error: "Not found." }, 404);
      }
    } catch (error) {
      // The ledger raises with deliberate SQLSTATEs; `mapRpcFailure` has already
      // turned those into the right status. Anything else is ours and is a 502.
      if (error instanceof RpcError) return json({ error: error.message }, error.status);
      return json({ error: "Storage request failed.", detail: String(error) }, 502);
    }
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

type Caller = { id: string; email: string };

/**
 * The caller's token, from the header only.
 *
 * The presence room also accepts `?access_token=` because a browser `WebSocket`
 * cannot set a header. Nothing here has that excuse — every request to this
 * Worker is a `fetch` — so the tidier form is the only form, and a token cannot
 * end up quoted in an access log.
 */
function readToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}

/**
 * Ask Supabase who the token belongs to.
 *
 * `/auth/v1/user` is the only place a token is validated. Nothing downstream of
 * this function trusts a value the caller supplied, which is what makes passing
 * the resulting id to a service-role write safe.
 */
async function identify(env: Env, token: string): Promise<Caller | "unauthorized"> {
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  });

  if (response.status === 401 || response.status === 403) return "unauthorized";
  if (!response.ok) throw new Error(`Supabase auth responded ${response.status}`);

  const user = (await response.json()) as { id?: string; email?: string };
  if (!user?.id) return "unauthorized";

  return { id: user.id, email: user.email ?? "" };
}

/**
 * The caller's role in a workspace, or null when they have none.
 *
 * A workspace id that does not exist yields the same null as one they are not in,
 * which is why every caller of this treats null as "not found" rather than as
 * "forbidden": answering differently would let a signed-in stranger enumerate
 * workspace ids.
 */
async function roleFor(env: Env, token: string, workspaceId: string): Promise<string | null> {
  const value = await callRpc(env, { token, key: env.SUPABASE_ANON_KEY }, "apro_workspace_role", {
    p_workspace_id: workspaceId,
  });
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The caller's own storage figures, straight from the database.
 *
 * `my_storage_summary()` derives the user from `auth.uid()`, so there is no user
 * parameter to get wrong and nothing to check first. It is delegated rather than
 * recomputed here because the number on the progress bar has to be the same
 * number the upload path enforces.
 */
async function summary(env: Env, token: string): Promise<Response> {
  return json(await callRpc(env, { token, key: env.SUPABASE_ANON_KEY }, "my_storage_summary", {}));
}

/**
 * What is stored in one workspace, or — with no workspace named — what the
 * caller has stored anywhere.
 *
 * Membership is checked here as well as by the RPC. It is not redundant: the RPC
 * raises for a non-member, and catching that to invent a status would mean
 * guessing at which SQLSTATE it used. Asking `apro_workspace_role` first gives
 * the same answer without a second error path.
 */
async function list(url: URL, env: Env, token: string, caller: Caller): Promise<Response> {
  const requested = url.searchParams.get("workspace_id")?.trim() ?? "";
  if (!requested) return listOwnObjects(env, token, caller);

  const workspaceId = requireUuid(requested);
  if (!workspaceId) return json({ error: "Workspace not found." }, 404);
  if (!(await roleFor(env, token, workspaceId))) {
    return json({ error: "Workspace not found." }, 404);
  }

  const rows = asRows(await listWorkspaceObjects(env, token, workspaceId));
  let total = 0;
  for (const row of rows) total += row.byte_size;

  return json({
    workspace_id: workspaceId,
    total_bytes: total,
    object_count: rows.length,
    objects: rows,
  });
}

/**
 * The caller's own objects — private and shared alike.
 *
 * Row-level security does the narrowing: `storage_objects_select_visible` admits
 * a row when the caller owns it or is in its workspace, and this filter is only
 * the "mine" half of that. There is no service-role read here on purpose, so a
 * bug in this Worker cannot leak somebody else's object listing.
 */
async function listOwnObjects(env: Env, token: string, caller: Caller): Promise<Response> {
  const query =
    `owner_user_id=eq.${encodeURIComponent(caller.id)}` +
    `&deleted_at=is.null&limit=200&order=created_at.desc` +
    `&select=${OBJECT_COLUMNS}`;
  const rows = await select(env, token, query);
  return json({ objects: rows });
}

/** Everything shared into one workspace, via the RPC that checks membership. */
async function listWorkspaceObjects(env: Env, token: string, workspaceId: string): Promise<unknown> {
  return callRpc(env, { token, key: env.SUPABASE_ANON_KEY }, "list_workspace_storage", {
    p_workspace_id: workspaceId,
  });
}

/**
 * Hand back the bytes.
 *
 * The row is looked up with the caller's own token, so visibility is decided by
 * the same policy that decides what they can see listed — a peer in the
 * workspace passes, a stranger does not, and neither answer is computed here. R2
 * is then addressed with the key from that row rather than with anything the
 * caller sent, which is why the id is the only thing this endpoint accepts.
 */
async function blob(
  request: Request,
  url: URL,
  env: Env,
  token: string,
): Promise<Response> {
  const id = requireUuid(url.searchParams.get("id"));
  if (!id) return json({ error: "Not found." }, 404);

  const rows = await select(
    env,
    token,
    `id=eq.${id}&deleted_at=is.null&select=object_key,content_type,byte_size`,
  );
  const row = asRows(rows)[0];
  if (!row) return json({ error: "Not found." }, 404);

  const object = await env.STORAGE.get(row.object_key);
  if (!object) {
    // The ledger and the bucket disagree. That is a fault on our side, not a
    // missing-file answer for the caller.
    return json({ error: "The stored bytes are missing." }, 502);
  }

  const headers = cors({
    "Content-Type": row.content_type ?? "application/octet-stream",
    // Content-addressed, so these bytes can never change under this URL.
    "Cache-Control": "private, max-age=31536000, immutable",
    ETag: object.httpEtag,
  });

  if (request.method === "HEAD") return new Response(null, { headers });
  return new Response(object.body, { headers });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function objects(
  request: Request,
  url: URL,
  env: Env,
  token: string,
  caller: Caller,
): Promise<Response> {
  switch (request.method) {
    case "GET":
      return list(url, env, token, caller);
    case "POST":
      return upload(request, url, env, token, caller);
    case "DELETE":
      return remove(url, env, token, caller);
    default:
      return Promise.resolve(json({ error: "Method not allowed." }, 405));
  }
}

/**
 * Store one object.
 *
 * The order is the interesting part. The ledger is written **before** the bucket
 * because the ledger is what enforces the quota; uploading first and recording
 * afterwards would let two simultaneous uploads each pass a check against a
 * total that neither had yet changed, and would leave bytes in the bucket for a
 * user who had just gone over. Registering first means an over-quota upload
 * costs one round trip and no bytes.
 *
 * The reverse order is not free either, and the cleanup below is the price: if
 * R2 refuses after the ledger row exists, the row is retired with the same
 * service-role key that created it. That can itself fail, and the honest
 * statement of the result is a row for bytes that were never stored — which is
 * why a missing object is reported as a server fault rather than as a 404.
 */
async function upload(
  request: Request,
  url: URL,
  env: Env,
  token: string,
  caller: Caller,
): Promise<Response> {
  const requested = url.searchParams.get("workspace_id")?.trim() ?? "";
  let workspaceId: string | null = null;

  if (requested) {
    if (!UUID.test(requested)) return json({ error: "Workspace not found." }, 404);
    const role = await roleFor(env, token, requested);
    if (!role) return json({ error: "Workspace not found." }, 404);
    if (!WRITE_ROLES.has(role)) {
      return json({ error: "Your role in this workspace does not allow uploads." }, 403);
    }
    workspaceId = requested;
  }

  // Checked before reading the body as well as after, so an obviously oversized
  // request is refused without being buffered at all.
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_OBJECT_BYTES) return tooLarge();

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return json({ error: "An empty body cannot be stored." }, 400);
  if (bytes.byteLength > MAX_OBJECT_BYTES) return tooLarge();

  const hash = await sha256Hex(bytes);
  const objectKey = workspaceId
    ? `u/${caller.id}/w/${workspaceId}/${hash}`
    : `u/${caller.id}/self/${hash}`;

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  const label = url.searchParams.get("label")?.trim() ?? "";

  const id = await callRpc(env, { key: env.SUPABASE_SERVICE_ROLE_KEY }, "register_storage_object", {
    p_owner_user_id: caller.id,
    p_object_key: objectKey,
    p_content_hash: hash,
    p_byte_size: bytes.byteLength,
    p_workspace_id: workspaceId,
    p_content_type: contentType || null,
    p_label: label || null,
  });

  const options: R2PutOptions = { customMetadata: { owner: caller.id, hash } };
  if (contentType) options.httpMetadata = { contentType };

  try {
    await env.STORAGE.put(objectKey, bytes, options);
  } catch (error) {
    // Best effort. If this also fails the row stands, and a later read of it
    // reports the missing bytes rather than pretending they were never promised.
    await callRpc(env, { key: env.SUPABASE_SERVICE_ROLE_KEY }, "remove_storage_object", {
      p_object_key: objectKey,
    }).catch(() => undefined);
    return json({ error: "Upload failed.", detail: String(error) }, 502);
  }

  return json(
    {
      id: typeof id === "string" ? id : null,
      object_key: objectKey,
      content_hash: hash,
      byte_size: bytes.byteLength,
      content_type: contentType || null,
      label: label || null,
      workspace_id: workspaceId,
    },
    201,
  );
}

/**
 * Retire one object.
 *
 * The ledger goes first, so the caller's quota is freed even if R2 is
 * unreachable. That leaves bytes in the bucket with nothing pointing at them,
 * which costs us storage and costs the user nothing — the opposite order would
 * charge somebody for a file they had already deleted, which is the worse of the
 * two ways to be wrong.
 */
async function remove(url: URL, env: Env, token: string, caller: Caller): Promise<Response> {
  const id = requireUuid(url.searchParams.get("id"));
  if (!id) return json({ error: "Not found." }, 404);

  const rows = await select(env, token, `id=eq.${id}&deleted_at=is.null&select=object_key,owner_user_id`);
  const row = asRows(rows)[0];
  if (!row) return json({ error: "Not found." }, 404);
  if (row.owner_user_id !== caller.id) {
    return json({ error: "Only the owner can delete this object." }, 403);
  }

  await callRpc(env, { key: env.SUPABASE_SERVICE_ROLE_KEY }, "remove_storage_object", {
    p_object_key: row.object_key,
  });

  try {
    await env.STORAGE.delete(row.object_key);
  } catch (error) {
    console.error("ledger retired but R2 delete failed", row.object_key, String(error));
  }

  return json({ deleted: true, object_key: row.object_key });
}

// ---------------------------------------------------------------------------
// Supabase and R2 plumbing
// ---------------------------------------------------------------------------

const OBJECT_COLUMNS =
  "id,workspace_id,object_key,content_hash,byte_size,content_type,label,created_at";

type StoredObjectRow = {
  id: string;
  workspace_id: string | null;
  object_key: string;
  content_hash: string;
  byte_size: number;
  content_type: string | null;
  label: string | null;
  created_at: string;
  owner_user_id?: string;
};

/**
 * A refusal the caller should be told about verbatim.
 *
 * The database states its reasons in SQLSTATEs that map cleanly onto HTTP, and
 * collapsing them into a generic 500 would throw away the one message a user
 * needs — "Not enough online storage: 1132462080 of 1073741824 bytes already
 * used." is the whole answer to why an upload failed.
 */
class RpcError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

function mapRpcFailure(status: number, payload: unknown): RpcError {
  const record = (payload ?? {}) as { message?: string; code?: string };
  const message =
    typeof record.message === "string" && record.message
      ? record.message
      : `Supabase responded ${status}`;

  switch (record.code) {
    case "23514": // check_violation — the quota
      return new RpcError(507, message);
    case "42501": // insufficient_privilege — not a member of that workspace
      return new RpcError(403, message);
    case "22023": // invalid_parameter_value — the ledger refused the values
      return new RpcError(400, message);
    case "28000": // invalid_authorization_specification — no session
      return new RpcError(401, message);
    default:
      return new RpcError(502, message);
  }
}

type Credential = { token?: string; key: string };

/**
 * Call a PostgREST RPC.
 *
 * The two credential shapes in this file are one function apart on purpose: a
 * call either carries the caller's own token, in which case row-level security
 * applies and `auth.uid()` is them, or it carries the service-role key, in which
 * case neither is true and the function itself is responsible for deciding what
 * is allowed. Making that a visible choice at each call site is the whole point.
 */
async function callRpc(
  env: Env,
  credential: Credential,
  name: string,
  body: unknown,
): Promise<unknown> {
  const bearer = credential.token ?? credential.key;
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: credential.key,
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  });

  const payload = await readJson(response);
  if (!response.ok) throw mapRpcFailure(response.status, payload);
  return payload;
}

/** Read rows from a table under the caller's own token, so RLS applies. */
async function select(env: Env, token: string, query: string): Promise<unknown> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/storage_objects?${query}`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  });

  const payload = await readJson(response);
  if (!response.ok) throw mapRpcFailure(response.status, payload);
  return payload;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A gateway returned HTML rather than PostgREST returning JSON. Keeping the
    // text means the message survives into the log.
    return { message: text.slice(0, 400) };
  }
}

function asRows(payload: unknown): StoredObjectRow[] {
  return Array.isArray(payload) ? (payload as StoredObjectRow[]) : [];
}

function requireUuid(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return UUID.test(trimmed) ? trimmed : null;
}

function tooLarge(): Response {
  return json({ error: `A single object is limited to ${MAX_OBJECT_BYTES} bytes.` }, 413);
}

/** The object key is the content hash, so this is what makes an upload repeatable. */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Cross-origin headers.
 *
 * The desktop app's webview is not on this origin, so without these the browser
 * engine refuses the response before any of the above runs. `*` is acceptable
 * precisely because the endpoint authenticates with a bearer token and never
 * with a cookie: a hostile page has no way to obtain one, and if it did, the
 * token would already be the whole problem. No `Access-Control-Allow-Credentials`
 * is sent, so the wildcard cannot be paired with ambient authority.
 */
function cors(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: cors({ "Content-Type": "application/json", "Cache-Control": "no-store" }),
  });
}
