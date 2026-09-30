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
import { relaunch } from "@tauri-apps/plugin-process";
import { check as checkInstallableUpdate } from "@tauri-apps/plugin-updater";

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

export type InstallProgress = {
  downloaded: number;
  /** Null until the server declares a length; a chunked response never does. */
  total: number | null;
};

/**
 * Download, verify, install and relaunch.
 *
 * Separate from `fetchUpdateStatus` on purpose. That one asks GitHub's API whether a
 * newer release *exists*, which is a cheap question with a nice answer to display. This
 * one asks the updater plugin, which reads `latest.json` from the newest release, checks
 * the artifact against the public key compiled into the binary, and installs it. Only
 * the second can actually replace the application, so a release without `latest.json`
 * will be announced by the first and refused by the second.
 *
 * Throws rather than returning a status: the caller is a button the user just pressed,
 * so there is always somewhere to put the message.
 */
export async function installUpdate(
  onProgress: (progress: InstallProgress) => void,
): Promise<void> {
  const update = await checkInstallableUpdate();

  if (!update) {
    throw new Error(
      "The newest release has nothing to install for this build. It is probably missing " +
        "its latest.json manifest — download the installer from the release page instead.",
    );
  }

  let downloaded = 0;
  let total: number | null = null;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? null;
        onProgress({ downloaded: 0, total });
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress({ downloaded, total });
        break;
      case "Finished":
        onProgress({ downloaded, total });
        break;
    }
  });

  // Windows quits the application as the installer runs — a limitation of the
  // installers, not a choice — so on the platform this actually ships for, the process
  // is already gone by here and this never runs. It matters on the platforms where it
  // can, and it is harmless where it cannot.
  try {
    await relaunch();
  } catch {
    // The update is installed either way; only the restart needs to be manual.
  }
}

