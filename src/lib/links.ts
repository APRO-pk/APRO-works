/**
 * External links the hub hands to the system browser.
 *
 * These live here rather than inline so the URL is written once and so the
 * browser-preview case is handled in one place: inside the Tauri shell the
 * opener plugin is the only thing that can leave the webview, and outside it
 * there is no plugin at all.
 */

import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Where somebody without an account goes to ask for one.
 *
 * A hash route on the marketing site, not a hub screen: applications are
 * reviewed by people, and the hub has nowhere to put a pending application.
 */
export const JOIN_URL = "https://apro.works/#/join";

/**
 * Open a link outside the app.
 *
 * `openUrl` is the correct route in the Tauri shell but throws in a browser
 * preview, where `window.open` is the one that works — so both are tried rather
 * than one being assumed. Failure is swallowed because there is nothing useful
 * to say about a link that would not open, and `null` reports whether it did.
 */
export async function openExternal(url: string): Promise<boolean> {
  try {
    await openUrl(url);
    return true;
  } catch {
    try {
      return window.open(url, "_blank", "noopener,noreferrer") !== null;
    } catch {
      return false;
    }
  }
}
