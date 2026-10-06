/**
 * The wire protocol between the workspace view and a `WorkspaceRoom`.
 *
 * THIS FILE IS MIRRORED at `src/lib/workspace-protocol.ts` in the desktop app.
 * The worker is bundled and deployed on its own (`wrangler deploy` runs from
 * this directory, against this directory's tsconfig) and the app is bundled by
 * Vite from the repository root, so neither can import the other without
 * dragging one build system into the other. Two small files beat one clever
 * import.
 *
 * The copy is therefore a real drift risk, and it is handled in two places
 * rather than by hope: the client *validates every message it receives* before
 * acting on it (`parseServerMessage` in `src/lib/workspace-protocol.ts`), so a
 * mismatch degrades to "ignored", never to a crash. When you change a shape
 * here, change it there.
 */

/** A person currently connected to a workspace. */
export type Peer = {
  /** Connection id. One person on two machines is two peers with two cursors. */
  id: string;
  user_id: string;
  email: string;
  full_name: string;
  /** owner | admin | member | viewer */
  role: string;
  /**
   * Index into the client's cursor palette, 0–7.
   *
   * A number, not a colour: the palette lives in `src/index.css` alongside every
   * other colour in the product, and the worker has no business knowing a hex
   * value. It is derived from `user_id`, so the same person draws in the same
   * colour on every machine and after every reconnect.
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
  /** Position, normalised 0–1 relative to the workspace surface. */
  | { t: "cursor"; x: number; y: number }
  /** Which application this peer is now running. null = stopped. */
  | { t: "app"; slug: string | null }
  /** Liveness, every ~25s. Keeps presence honest when the network dies silently. */
  | { t: "ping" };

/** Messages the server sends. */
export type ServerMessage =
  | {
      t: "welcome";
      /** The caller's own peer record, including the connection id. */
      you: Peer;
      /** Everyone else already present. */
      peers: Peer[];
    }
  | { t: "join"; peer: Peer }
  | { t: "leave"; id: string }
  | { t: "cursor"; id: string; x: number; y: number }
  | { t: "app"; id: string; slug: string | null }
  | { t: "pong" }
  | { t: "error"; message: string };

/** How many cursor colours the client defines. Kept here so the hash is stable. */
export const CURSOR_COLOURS = 8;

/** Above this, a message is not a cursor update, it is an attack or a bug. */
export const MAX_MESSAGE_BYTES = 4096;

/** Peers per workspace. Generous, but not unbounded. */
export const MAX_PEERS = 32;

/** A peer that has not spoken for this long is assumed gone. */
export const PEER_TIMEOUT_MS = 75_000;
