/**
 * Workspace live protocol — the desktop app's half.
 *
 * MIRROR OF `cloudflare/workspace-room/src/protocol.ts`. The worker is bundled
 * and deployed from its own directory against its own tsconfig, and this app is
 * bundled by Vite from the repository root, so neither build can import the
 * other without dragging one toolchain into the other. Two small files beat one
 * clever import.
 *
 * Since a mirrored file can drift, the client does not trust it: every frame
 * that arrives goes through `parseServerMessage` before anything acts on it, and
 * anything unrecognised is dropped. A room running a newer protocol therefore
 * degrades to "that message was ignored", never to a broken tab — which matters
 * because the deployed worker and the installed desktop app update on entirely
 * different schedules.
 */

/** A person currently connected to a workspace. */
export type Peer = {
  /** Connection id. One person on two machines is two peers with two cursors. */
  id: string;
  user_id: string;
  email: string;
  full_name: string;
  /**
   * The role the database already enforced: `OWNER | EDITOR | VIEWER`.
   *
   * A plain string rather than the `WorkspaceRole` union, and unparsed on
   * purpose. This is a label the room relayed, not a permission the client
   * acts on — anything that decides what somebody may do asks the database. If
   * a room running a newer schema sends a role this build has never heard of,
   * drawing it verbatim is better than silently downgrading it to "Viewer" and
   * telling the user something untrue about their own access.
   */
  role: string;
  /**
   * Index into the cursor palette, 0–7.
   *
   * A number rather than a colour: the palette lives in `src/index.css` with
   * every other colour in the product, and it is derived from `user_id` so the
   * same person draws in the same colour on every machine and after every
   * reconnect.
   */
  color: number;
  /** Which application this peer has running, or null when they are not in one. */
  app: string | null;
  /** Normalised 0–1 against the workspace surface, so window sizes need not match. */
  cursor: { x: number; y: number } | null;
  joined_at: number;
};

/** Messages the client sends. */
export type ClientMessage =
  | { t: "cursor"; x: number; y: number }
  | { t: "app"; slug: string | null }
  | { t: "ping" };

/** Messages the server sends. */
export type ServerMessage =
  | { t: "welcome"; you: Peer; peers: Peer[] }
  | { t: "join"; peer: Peer }
  | { t: "leave"; id: string }
  | { t: "cursor"; id: string; x: number; y: number }
  | { t: "app"; id: string; slug: string | null }
  | { t: "pong" }
  | { t: "error"; message: string };

/** How many cursor colours the palette defines. Kept in step with the worker. */
export const CURSOR_COLOURS = 8;

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** A finite number, or null. `typeof NaN === "number"`, so `isFinite` matters. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parsePeer(value: unknown): Peer | null {
  if (!isRecord(value)) return null;

  const id = str(value.id);
  if (!id) return null;

  const cursor = isRecord(value.cursor)
    ? { x: num(value.cursor.x) ?? 0, y: num(value.cursor.y) ?? 0 }
    : null;

  const color = num(value.color);

  return {
    id,
    user_id: str(value.user_id),
    email: str(value.email),
    full_name: str(value.full_name, str(value.email, "Member")),
    role: str(value.role, "member"),
    // A colour outside the palette would read past the end of the colour array
    // and paint an invisible cursor, so it is clamped to something valid.
    color: color === null ? 0 : ((Math.trunc(color) % CURSOR_COLOURS) + CURSOR_COLOURS) % CURSOR_COLOURS,
    app: typeof value.app === "string" ? value.app : null,
    cursor,
    joined_at: num(value.joined_at) ?? Date.now(),
  };
}

/**
 * Turn one frame from the wire into a message, or null.
 *
 * Returning null is the contract: nothing here throws, because a room that
 * sends something unexpected must not be able to take down the workspace view.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(value)) return null;

  switch (value.t) {
    case "welcome": {
      const you = parsePeer(value.you);
      if (!you) return null;

      const peers = Array.isArray(value.peers)
        ? value.peers.map(parsePeer).filter((peer): peer is Peer => peer !== null)
        : [];

      return { t: "welcome", you, peers };
    }

    case "join": {
      const peer = parsePeer(value.peer);
      return peer ? { t: "join", peer } : null;
    }

    case "leave": {
      const id = str(value.id);
      return id ? { t: "leave", id } : null;
    }

    case "cursor": {
      const id = str(value.id);
      const x = num(value.x);
      const y = num(value.y);
      if (!id || x === null || y === null) return null;
      return { t: "cursor", id, x, y };
    }

    case "app": {
      const id = str(value.id);
      if (!id) return null;
      return { t: "app", id, slug: typeof value.slug === "string" ? value.slug : null };
    }

    case "pong":
      return { t: "pong" };

    case "error":
      return { t: "error", message: str(value.message, "The workspace room reported an error.") };

    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
// The palette
// -----------------------------------------------------------------------------

/**
 * Tailwind classes for each cursor colour, in the worker's index order.
 *
 * Written out in full rather than composed from a template string because
 * Tailwind scans source text: a class assembled at runtime is a class that never
 * gets generated, and the cursor would simply have no colour. The values come
 * from the `--color-cursor-*` tokens in `src/index.css`.
 */
export const CURSOR_PALETTE: readonly string[] = [
  "var(--color-cursor-0)",
  "var(--color-cursor-1)",
  "var(--color-cursor-2)",
  "var(--color-cursor-3)",
  "var(--color-cursor-4)",
  "var(--color-cursor-5)",
  "var(--color-cursor-6)",
  "var(--color-cursor-7)",
];

export function cursorColor(index: number): string {
  const size = CURSOR_PALETTE.length;
  const safe = ((Math.trunc(index) % size) + size) % size;
  return CURSOR_PALETTE[safe] ?? CURSOR_PALETTE[0]!;
}
