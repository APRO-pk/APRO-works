/**
 * Online storage — the hub's side of the R2 bucket.
 *
 * Every account gets a gigabyte for the bytes its applications produce, so a
 * workspace's members can pick up each other's work without the file having to
 * travel by any other route. Three things are worth knowing before changing
 * anything here.
 *
 * **This file never talks to R2.** Object storage is addressed by key, and a key
 * the client can choose is a key the client can guess. All traffic goes through
 * `cloudflare/workspace-storage`, which derives the prefix from the session it
 * verified and then asks the database whether this person may put something
 * there. The hub only ever says *what* to store, never *where*.
 *
 * **The quota lives in Postgres, not in R2.** R2 has no per-tenant limit; the
 * ceiling is a row in `storage_accounts` that `register_storage_object`
 * serialises per user, and the 507 this file can throw is that check coming
 * back. An upload that would cross the line is refused *before* any bytes are
 * written, so a failed upload costs nothing but the round trip.
 *
 * **A failure throws.** There is no sample-data fallback, for the same reason
 * `workspaces.ts` has none: this is other people's data, and a fabricated
 * listing would name files that do not exist. What this file does keep is the
 * Worker's own sentence — the messages there are written to be read by a person,
 * so they are passed through rather than flattened into "something went wrong".
 *
 * The unit of interest is the **content hash**, not the filename. Uploading the
 * same bytes twice is accepted, changes nothing, and is not charged twice, so
 * callers do not need to ask whether something is already there.
 */

import { invoke } from "@tauri-apps/api/core";

import { supabase } from "./supabase";

/**
 * Where the storage Worker lives.
 *
 * Hardcoded rather than left empty when the variable is missing, for the same
 * reason as the presence room's default: the release workflow does not pass this
 * variable, and a build that silently ships without online storage would look
 * exactly like a build where nobody has uploaded anything yet. Setting
 * `VITE_WORKSPACE_STORAGE_URL` overrides it, which is what points a development
 * build at `wrangler dev`.
 */
const DEFAULT_STORAGE_BASE = "https://apro-workspace-storage.henryarkenberg.workers.dev";

function resolveBase(): string {
  const configured = (import.meta.env.VITE_WORKSPACE_STORAGE_URL ?? "").trim();
  return (configured || DEFAULT_STORAGE_BASE).replace(/\/+$/, "");
}

export const workspaceStorageBase: string = resolveBase();

/** Matches the ledger's `quota_bytes` default. Used only when the read fails. */
const DEFAULT_QUOTA_BYTES = 1_073_741_824;

/** Long enough for 25 MB over a slow domestic uplink. */
const UPLOAD_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

// -----------------------------------------------------------------------------
// Shapes
// -----------------------------------------------------------------------------

/** What `my_storage_summary()` returns, once normalised. */
export type StorageSummary = {
  used_bytes: number;
  quota_bytes: number;
  object_count: number;
  /** How many of those objects are shared into a workspace. */
  shared_count: number;
};

/**
 * One stored object.
 *
 * `owner_user_id` is absent from the workspace listing, which reports the owner
 * because a shared object may not be yours — and present in the workspace
 * response only because the RPC includes it. Both readings are typed the same
 * way and the field is optional rather than being guessed at.
 */
export type StoredObject = {
  id: string;
  owner_user_id: string | null;
  workspace_id: string | null;
  object_key: string;
  content_hash: string;
  byte_size: number;
  content_type: string | null;
  label: string | null;
  created_at: string;
};

export type WorkspaceStorage = {
  workspace_id: string;
  total_bytes: number;
  object_count: number;
  objects: StoredObject[];
};

export type UploadOptions = {
  /** Omit to keep the object private to its owner; it still counts against quota. */
  workspaceId?: string | null;
  label?: string | null;
  contentType?: string | null;
};

/**
 * A refusal with a status.
 *
 * Status 0 means the request never reached the Worker — the difference between
 * "the storage service is down" and "you are not allowed" is one people act on
 * differently, and a bare `Error` cannot carry it.
 */
export class StorageFailure extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "StorageFailure";
    this.status = status;
  }
}

// -----------------------------------------------------------------------------
// Transport
// -----------------------------------------------------------------------------

async function accessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new StorageFailure(401, "Your session has ended. Sign in again to use online storage.");
  }
  return token;
}

type RequestOptions = {
  method?: string;
  body?: BodyInit | null;
  contentType?: string | null;
  timeoutMs?: number;
};

/**
 * One authenticated request, with the Worker's own error text preserved.
 *
 * The token is read here rather than cached: a long-lived upload can outlive the
 * access token it started with, and a stale one produces a 401 that looks like a
 * permissions problem.
 */
async function authed(path: string, options: RequestOptions = {}): Promise<Response> {
  const token = await accessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${workspaceStorageBase}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.contentType ? { "Content-Type": options.contentType } : {}),
      },
      body: options.body ?? null,
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    throw new StorageFailure(
      0,
      "Could not reach online storage. Check your connection, then try again.",
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.ok) return response;

  // The Worker answers failures as `{ error, detail? }`, and `error` is already a
  // sentence. Fall back to the status only when the body is not that shape.
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const record = (payload ?? {}) as { error?: unknown };
  const message =
    typeof record.error === "string" && record.error.trim()
      ? record.error
      : `Online storage answered ${response.status}.`;
  throw new StorageFailure(response.status, message);
}

async function call(path: string, options: RequestOptions = {}): Promise<unknown> {
  const response = await authed(path, options);
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Normalising what came back
// -----------------------------------------------------------------------------

/**
 * A summary that is safe to divide by.
 *
 * The progress bar computes a percentage from these numbers, and one `undefined`
 * would render a bar of `NaN%`. Anything unreadable is treated as zero used,
 * with the default quota, rather than being trusted.
 */
function asSummary(payload: unknown): StorageSummary {
  const record = (payload ?? {}) as Partial<Record<keyof StorageSummary, unknown>>;
  const quota = Number(record.quota_bytes);
  return {
    used_bytes: Math.max(0, Number(record.used_bytes) || 0),
    quota_bytes: Number.isFinite(quota) && quota > 0 ? quota : DEFAULT_QUOTA_BYTES,
    object_count: Math.max(0, Number(record.object_count) || 0),
    shared_count: Math.max(0, Number(record.shared_count) || 0),
  };
}

function asObject(raw: unknown): StoredObject | null {
  const row = raw as Partial<Record<keyof StoredObject, unknown>> | null;
  if (!row || typeof row.id !== "string" || typeof row.object_key !== "string") return null;
  return {
    id: row.id,
    owner_user_id: typeof row.owner_user_id === "string" ? row.owner_user_id : null,
    workspace_id: typeof row.workspace_id === "string" ? row.workspace_id : null,
    object_key: row.object_key,
    content_hash: typeof row.content_hash === "string" ? row.content_hash : "",
    byte_size: Math.max(0, Number(row.byte_size) || 0),
    content_type: typeof row.content_type === "string" ? row.content_type : null,
    label: typeof row.label === "string" ? row.label : null,
    created_at: typeof row.created_at === "string" ? row.created_at : "",
  };
}

function asObjects(value: unknown): StoredObject[] {
  if (!Array.isArray(value)) return [];
  const rows: StoredObject[] = [];
  for (const raw of value) {
    const row = asObject(raw);
    if (row) rows.push(row);
  }
  return rows;
}

function objectsOf(payload: unknown): StoredObject[] {
  const record = (payload ?? {}) as { objects?: unknown };
  return asObjects(record.objects);
}

// -----------------------------------------------------------------------------
// Public surface
// -----------------------------------------------------------------------------

/** How much of this account's allowance is spent. */
export async function fetchStorageSummary(): Promise<StorageSummary> {
  return asSummary(await call("/storage/summary"));
}

/** This account's own objects, private and shared alike, newest first. */
export async function fetchOwnObjects(): Promise<StoredObject[]> {
  return objectsOf(await call("/storage/objects"));
}

/** Everything shared into one workspace. Membership is checked server-side. */
export async function fetchWorkspaceStorage(workspaceId: string): Promise<WorkspaceStorage> {
  const payload = await call(`/storage/objects?workspace_id=${encodeURIComponent(workspaceId)}`);
  const record = (payload ?? {}) as { total_bytes?: unknown; object_count?: unknown };
  const objects = objectsOf(payload);
  return {
    workspace_id: workspaceId,
    total_bytes: Math.max(0, Number(record.total_bytes) || 0),
    object_count: Math.max(0, Number(record.object_count) || objects.length),
    objects,
  };
}

/**
 * Put bytes online.
 *
 * The Worker hashes the body, which is what makes a repeated upload free, so
 * callers are not expected to check first — sending the same bytes again is the
 * cheap way to be sure the object is there.
 */
export async function uploadObject(
  bytes: ArrayBuffer,
  options: UploadOptions = {},
): Promise<StoredObject> {
  const params = new URLSearchParams();
  if (options.workspaceId) params.set("workspace_id", options.workspaceId);
  if (options.label) params.set("label", options.label);
  const query = params.toString();

  const payload = await call(`/storage/objects${query ? `?${query}` : ""}`, {
    method: "POST",
    body: bytes,
    contentType: options.contentType || "application/octet-stream",
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });

  const stored = asObject(payload);
  if (!stored) {
    throw new StorageFailure(502, "Online storage accepted the upload but did not describe it.");
  }
  return stored;
}

/** The bytes back. Visibility is the same policy that decides what is listed. */
export async function fetchObjectBytes(id: string): Promise<Blob> {
  const response = await authed(`/storage/blob?id=${encodeURIComponent(id)}`, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  });
  return response.blob();
}

/** Retire an object. Only its owner may, and the quota is freed either way. */
export async function deleteObject(id: string): Promise<void> {
  await call(`/storage/objects?id=${encodeURIComponent(id)}`, { method: "DELETE" });
}

// -----------------------------------------------------------------------------
// Reading the numbers
// -----------------------------------------------------------------------------

/**
 * How full the allowance is, between 0 and 1.
 *
 * Clamped because a quota can be lowered after objects were stored under a
 * larger one, and a bar wider than its track is a rendering bug rather than
 * information.
 */
export function storageRatio(summary: StorageSummary): number {
  if (!(summary.quota_bytes > 0)) return 0;
  return Math.min(1, Math.max(0, summary.used_bytes / summary.quota_bytes));
}

/** Below this, the bar is a sliver and the sentence carries the answer. */
export function storageIsEmpty(summary: StorageSummary): boolean {
  return summary.used_bytes <= 0;
}

// -----------------------------------------------------------------------------
// Mirroring the local store
// -----------------------------------------------------------------------------

/**
 * What one mirror pass did, as `src-tauri/src/storage_sync.rs` reports it.
 *
 * Snake_case because it is a Rust struct serialised straight through, not a
 * hand-written shape — renaming fields here would silently produce zeros.
 */
export type StorageSyncReport = {
  uploaded: number;
  uploaded_bytes: number;
  downloaded: number;
  downloaded_bytes: number;
  /** Already online, so nothing was sent. */
  unchanged: number;
  failed: number;
  /** The first failure, if there was one. The rest are only counted. */
  detail: string | null;
};

/**
 * Bring this machine's orchestration store and a workspace's online storage into
 * agreement: publish what is missing, fetch what is new.
 *
 * The work happens in Rust rather than here. Blobs are opaque and can be large,
 * and routing them through the webview as base64 would inflate every one of them
 * by a third to no benefit — the store already knows how to read and hash its own
 * files, and `reqwest` already exists in this process for the updater.
 *
 * The token is passed down because the session lives here; the header on the Rust
 * side is built from it and the Worker decides what it permits.
 */
export async function syncWorkspaceStorage(workspaceId: string): Promise<StorageSyncReport> {
  if (!("__TAURI_INTERNALS__" in window)) {
    throw new StorageFailure(
      0,
      "Not running inside APRO Works, so the local store cannot be mirrored.",
    );
  }

  const token = await accessToken();
  return invoke<StorageSyncReport>("sync_workspace_storage", {
    base: workspaceStorageBase,
    token,
    workspaceId,
  });
}
