/**
 * Accent selection.
 *
 * The accent is the one colour that is meant to be changed, so it is the one
 * colour a user can change. Everything downstream — hover, soft fills, focus rings,
 * the ambient bloom, the canvas wires — is derived from `--color-accent` with
 * `color-mix`, so switching accent is a single property write.
 *
 * The preset values deliberately live in `index.css`, not here. This module only
 * knows *names* and reads the value out of the stylesheet at runtime. Putting hex
 * literals in TypeScript would give the palette a second home, and `verify:tokens`
 * would rightly reject it.
 */

export type AccentId =
  | "violet"
  | "indigo"
  | "cyan"
  | "emerald"
  | "amber"
  | "rose"
  | "graphite";

export type Accent = {
  id: AccentId;
  name: string;
  /** The custom property in index.css holding this preset's value. */
  token: string;
};

/** In display order. Violet is first because it is the shipped default. */
export const ACCENTS: readonly Accent[] = [
  { id: "violet", name: "Violet", token: "--color-accent-violet" },
  { id: "indigo", name: "Indigo", token: "--color-accent-indigo" },
  { id: "cyan", name: "Cyan", token: "--color-accent-cyan" },
  { id: "emerald", name: "Emerald", token: "--color-accent-emerald" },
  { id: "amber", name: "Amber", token: "--color-accent-amber" },
  { id: "rose", name: "Rose", token: "--color-accent-rose" },
  { id: "graphite", name: "Graphite", token: "--color-accent-graphite" },
] as const;

export const DEFAULT_ACCENT: AccentId = "violet";

const STORAGE_KEY = "apro.accent";

function isAccentId(value: string): value is AccentId {
  return ACCENTS.some((accent) => accent.id === value);
}

/**
 * Read a preset's value from the stylesheet.
 *
 * Returns null rather than a fallback when the property is missing: silently
 * substituting a hardcoded colour is how a palette drifts out of sync with its
 * own stylesheet, and the caller can do nothing useful with a wrong value.
 */
function accentValue(token: string): string | null {
  if (typeof window === "undefined") return null;
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value.length > 0 ? value : null;
}

/** Point the accent at a preset. No-op when the preset's token is unavailable. */
export function applyAccent(id: AccentId): void {
  const accent = ACCENTS.find((entry) => entry.id === id);
  if (!accent) return;

  const value = accentValue(accent.token);
  if (!value) return;

  document.documentElement.style.setProperty("--color-accent", value);
}

/** The stored choice, or the default. Never throws — a corrupt store is not fatal. */
export function loadAccentId(): AccentId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored && isAccentId(stored) ? stored : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function saveAccentId(id: AccentId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Private mode, or a locked-down webview. The accent still applies for this
    // session; it just will not be remembered, which is not worth an error.
  }
}

/** The resolved value of a preset, for rendering swatches. */
export function accentSwatch(id: AccentId): string {
  const accent = ACCENTS.find((entry) => entry.id === id);
  return accent ? (accentValue(accent.token) ?? "transparent") : "transparent";
}
