/**
 * Update checking, from the interface's side.
 *
 * The work is done in Rust; this wraps it with a cache and a link opener.
 *
 * The cache exists for two reasons. A stored answer paints the sidebar card
 * immediately on launch instead of popping in a second later, and it keeps the app
 * from spending a GitHub request every time the window is reopened during a
 * development session — unauthenticated requests are limited per hour, and the
 * failure mode when that runs out is silence, which looks exactly like "broken".
 */

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import { formatRelative } from "./platform-data";

export type UpdateStatus = {
  /** The version the running build reports. */
  current: string;
  /** The newest published version, or null when there is nothing to compare to. */
  latest: string | null;
  available: boolean;
  release_url: string | null;
  release_name: string | null;
  notes: string | null;
  published_at: string | null;
  /** A sentence to show verbatim. */
  detail: string;
};

export type CachedUpdate = { status: UpdateStatus; at: number };

const CACHE_KEY = "apro.update-status";

/**
 * How long a stored answer is trusted before the network is consulted again.
 *
 * The card still shows a cached result at any age — it just may be stale. Only the
 * automatic check respects this; pressing "Check now" always asks.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;

export function loadCachedUpdate(): CachedUpdate | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedUpdate;
    if (!parsed?.status || typeof parsed.at !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCachedUpdate(status: UpdateStatus): CachedUpdate {
  const entry = { status, at: Date.now() };
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // A full or unavailable store is not worth failing an update check over.
  }
  return entry;
}

/** Whether a cached answer is recent enough to skip the automatic check. */
export function cacheIsFresh(cached: CachedUpdate | null): boolean {
  return cached !== null && Date.now() - cached.at < CACHE_TTL_MS;
}

/**
 * Ask GitHub. Always hits the network, and throws when the check could not be made —
 * callers decide whether that is worth telling anyone about.
 */
export async function fetchUpdateStatus(): Promise<UpdateStatus> {
  return invoke<UpdateStatus>("check_for_update");
}

/** Open the release page. A browser preview has no opener, so failure is swallowed. */
export async function openReleasePage(status: UpdateStatus | null): Promise<void> {
  const url = status?.release_url;
  if (!url) return;
  try {
    await openUrl(url);
  } catch {
    // Nothing useful to do: the URL is also printed in Settings.
  }
}

/** Human phrasing for when the last check ran. */
export function formatCheckedAt(at: number | null): string {
  if (at === null) return "Never checked";
  return `Checked ${formatRelative(at)}`;
}
