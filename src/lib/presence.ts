/**
 * Live presence for a workspace: who is here, where their pointer is, and which
 * application they are inside.
 *
 * Framework-free on purpose. `WorkspacesPanel` renders the roster and the cursor
 * layer, but neither owns the socket — reconnecting and re-authenticating are
 * state machines that are much easier to get right as a plain object with a
 * listener than as a chain of effects.
 *
 * ## Why the cursors are not React state
 *
 * A remote pointer arrives several times a second. Routing that through
 * `useState` would re-render the whole workspace panel on every frame of
 * somebody else's mouse, and the re-render is what would look janky, not the
 * network. So incoming positions land in a plain `Map` that the cursor layer
 * reads from inside a `requestAnimationFrame` loop and writes straight to
 * element transforms. React re-renders only when the *roster* changes, which is
 * rare.
 *
 * ## Why the send rate is low
 *
 * Outbound frames are capped at ten a second, and movement under a couple of
 * pixels is not sent at all. Both are the same argument: the room fans every
 * frame out to every other member, so a frame costs one broadcast per person
 * present, and a pointer moving at twenty-five a second spends most of them
 * saying "still about there". Interpolation is what makes a low rate look
 * smooth, so the frames are the thing to economise, not the motion.
 *
 * ## Interpolation
 *
 * The request was explicit: update, and interpolate if updates are not quick
 * enough. Both cases are the same line of code. Each cursor keeps a rendered
 * position and a target, and every frame moves the rendered position a fraction
 * of the way toward the target:
 *
 *     k = 1 - exp(-dt / TAU)
 *
 * Exponential smoothing is frame-rate independent, so a 144 Hz display and a
 * 60 Hz one glide identically, and it degrades correctly at both extremes: when
 * updates arrive every 100 ms the rendered position is already on the target and
 * nothing is added, and when an update is 400 ms late the cursor eases across the
 * gap instead of teleporting. A plain `x += (target - x) * 0.2` would look
 * different on every machine and overshoot never — this does not.
 */

import { supabase } from "./supabase";
import {
  parseServerMessage,
  type ClientMessage,
  type Peer,
  type ServerMessage,
} from "./workspace-protocol";

/** Where a person's pointer is drawn from, when it is not the network. */
export type CursorTarget = { x: number; y: number };

export type PresenceStatus =
  /** No socket, and none wanted. */
  | "idle"
  /** Opening, or waiting to retry. */
  | "connecting"
  /** Open and authenticated. */
  | "live"
  /** Gave up; `detail` says why. */
  | "error";

export type PresenceSnapshot = {
  status: PresenceStatus;
  /** A sentence for a person, or null when there is nothing to say. */
  detail: string | null;
  /** The caller's own peer record, once the room has welcomed them. */
  you: Peer | null;
  /** Everyone else, in join order. */
  peers: Peer[];
};

const EMPTY_SNAPSHOT: PresenceSnapshot = {
  status: "idle",
  detail: null,
  you: null,
  peers: [],
};

/**
 * Outbound cursor frames are capped at this rate.
 *
 * Ten a second, not twenty-five. The room broadcasts every frame to everyone
 * else in the workspace, so the rate is multiplied by the number of people
 * present — and at 25 Hz most frames carry a position a couple of pixels from
 * the last one. Interpolation covers the gap; the extra frames buy nothing.
 */
const CURSOR_INTERVAL_MS = 100;

/**
 * Movement smaller than this is not sent, in normalised units.
 *
 * A stationary mouse still emits pointer events whenever anything under it
 * changes, and a hand resting on a desk produces a drift of single pixels with
 * no intent behind it. 0.0015 of the window is about 2 px at 1440 wide, which
 * is below the threshold of noticing.
 *
 * The comparison is against the last position actually *sent*, never against
 * the one merely queued, so a slow deliberate drag accumulates and goes out
 * once it passes the threshold instead of being swallowed.
 */
const CURSOR_MIN_DELTA = 0.0015;

/** Liveness, comfortably inside the room's 75 s patience. */
const PING_INTERVAL_MS = 25_000;

/** Backoff between reconnect attempts. The last value repeats forever. */
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000];

/** How close counts as arrived, in normalised units. ~0.2 px on a 1080p window. */
export const CURSOR_EPSILON = 0.0002;

/**
 * Smoothing time constant. Lower is snappier, higher is smoother.
 *
 * Raised alongside the send interval. At ten updates a second the cursor has to
 * cover twice the distance per update, and a constant tuned for 40 ms updates
 * would leave it visibly trailing the real pointer.
 */
export const CURSOR_TAU_MS = 90;

/**
 * The deployed workspace room, used when the environment does not name one.
 *
 * This is the app's own backend, built from `cloudflare/workspace-room/` and
 * pinned to one account, so its address is a constant in the same way the update
 * feed's GitHub endpoint is one in `tauri.conf.json` — not per-machine
 * configuration.
 *
 * Making it a fallback rather than a requirement is deliberate. A release built
 * without `VITE_WORKSPACE_LIVE_URL` would otherwise ship with cursors quietly
 * missing, which is the kind of failure nobody notices until two people are
 * staring at the same screen wondering why they cannot see each other.
 */
const DEFAULT_LIVE_BASE = "https://apro-workspace-room.aliarsalan-u6.workers.dev";

/**
 * The live endpoint. `VITE_WORKSPACE_LIVE_URL` overrides the default, which is
 * what a local `wrangler dev` or a staging worker needs.
 *
 * Read once at module load, like every other Vite env var.
 */
export const workspaceLiveBase: string = (() => {
  const raw = import.meta.env.VITE_WORKSPACE_LIVE_URL as string | undefined;
  const trimmed = raw?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : DEFAULT_LIVE_BASE;
  return base.replace(/\/+$/, "");
})();

export type PresenceClient = {
  connect(): void;
  disconnect(): void;
  /** Tell the room which application this client has open, or null for none. */
  setApp(slug: string | null): void;
  /** Offer a normalised position. Throttled and deduplicated internally. */
  sendCursor(x: number, y: number): void;
  /** Live target positions, keyed by peer connection id. Read inside a frame. */
  readTargets(): ReadonlyMap<string, CursorTarget>;
  /** The current snapshot. Stable between discrete changes. */
  getSnapshot(): PresenceSnapshot;
  /** Called when the snapshot changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
};

type Options = {
  workspaceId: string;
  /** Called with a sentence whenever the client gives up on its own. */
  onFatal?: (message: string) => void;
};

export function createPresenceClient({ workspaceId, onFatal }: Options): PresenceClient {
  const listeners = new Set<() => void>();

  let snapshot: PresenceSnapshot = EMPTY_SNAPSHOT;
  let socket: WebSocket | null = null;
  let retry = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = true;
  /** Set while a token refresh is in flight, so a retry cannot stampede it. */
  let refreshing = false;

  /** Remote cursor targets. Mutated in place; never part of the snapshot. */
  const targets = new Map<string, CursorTarget>();

  /** Throttle state for outgoing frames. */
  let lastCursorSentAt = 0;
  let pendingCursor: CursorTarget | null = null;
  /** The last position that actually went out, for the movement threshold. */
  let lastSentCursor: CursorTarget | null = null;
  let cursorTimer: ReturnType<typeof setTimeout> | null = null;

  /** The last application this client announced, so `#hello` can restore it. */
  let announcedApp: string | null = null;

  function currentPeers(): Map<string, Peer> {
    const map = new Map<string, Peer>();
    for (const peer of snapshot.peers) map.set(peer.id, peer);
    return map;
  }

  /** Replace the snapshot only when something actually differs, then notify. */
  function commit(next: Partial<PresenceSnapshot>): void {
    const merged: PresenceSnapshot = { ...snapshot, ...next };

    const samePeers =
      merged.peers.length === snapshot.peers.length &&
      merged.peers.every((peer, index) => peer === snapshot.peers[index]);

    if (
      merged.status === snapshot.status &&
      merged.detail === snapshot.detail &&
      merged.you === snapshot.you &&
      samePeers
    ) {
      return;
    }

    snapshot = merged;
    for (const listener of listeners) listener();
  }

  function setPeers(peers: Peer[]): void {
    // Anyone who has left must stop being drawn immediately, even if the
    // render loop has not noticed.
    const present = new Set(peers.map((peer) => peer.id));
    for (const id of Array.from(targets.keys())) {
      if (!present.has(id)) targets.delete(id);
    }
    commit({ peers });
  }

  function send(message: ClientMessage): void {
    if (socket?.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A send that fails means the socket is on its way out; the close handler
      // owns what happens next.
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound
  // ---------------------------------------------------------------------------

  function apply(message: ServerMessage): void {
    switch (message.t) {
      case "welcome": {
        setPeers(message.peers);
        commit({ you: message.you, status: "live", detail: null });

        // Restore what this client was doing before the reconnect. A dropped
        // connection should not make someone appear to leave their application.
        if (announcedApp !== null) send({ t: "app", slug: announcedApp });
        return;
      }

      case "join": {
        const peers = currentPeers();
        peers.set(message.peer.id, message.peer);

        // Its arrival position, if the room remembered one.
        if (message.peer.cursor) targets.set(message.peer.id, message.peer.cursor);

        setPeers(Array.from(peers.values()));
        return;
      }

      case "leave": {
        targets.delete(message.id);
        const peers = currentPeers();
        peers.delete(message.id);
        setPeers(Array.from(peers.values()));
        return;
      }

      case "cursor": {
        // Only for people we know about. A cursor frame for an unknown id would
        // otherwise draw a ghost that nothing ever removes.
        if (!currentPeers().has(message.id)) return;
        targets.set(message.id, { x: message.x, y: message.y });
        return;
      }

      case "app": {
        const peers = currentPeers();
        const peer = peers.get(message.id);
        if (!peer) return;
        peers.set(message.id, { ...peer, app: message.slug });
        setPeers(Array.from(peers.values()));
        return;
      }

      case "error": {
        commit({ status: "error", detail: message.message });
        onFatal?.(message.message);
        return;
      }

      case "pong":
        return;

      default:
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  async function token(): Promise<string | null> {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }

  /** Refresh the session so the next attempt carries a live token. */
  async function refresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      await supabase.auth.refreshSession();
    } catch {
      // Offline, or the refresh token is gone. The retry will say so.
    } finally {
      refreshing = false;
    }
  }

  /**
   * Distinguish "the room refused us" from "we never reached it".
   *
   * A failed WebSocket handshake reaches the browser as close code 1006 with no
   * explanation — an expired token and a dropped network look identical. Probing
   * `/health` once on failure separates the two cheaply, and turns a dead end
   * into a sentence someone can act on.
   */
  async function explainFailure(): Promise<string> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const response = await fetch(`${workspaceLiveBase}/health`, {
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(timer);

      if (!response.ok) {
        return `The workspace room answered ${response.status}. It may still be deploying.`;
      }
      return "The workspace room refused this connection. Your session may have expired, or you may no longer be a member of this workspace.";
    } catch {
      return "Could not reach the workspace room. Check your connection, then try again.";
    }
  }

  function scheduleRetry(): void {
    if (stopped) return;
    if (retryTimer) return;

    const delay = RETRY_DELAYS_MS[Math.min(retry, RETRY_DELAYS_MS.length - 1)] ?? 15_000;
    retry += 1;

    retryTimer = setTimeout(() => {
      retryTimer = null;
      void open();
    }, delay);
  }

  async function open(): Promise<void> {
    if (stopped || socket) return;

    const accessToken = await token();
    if (!accessToken) {
      commit({ status: "error", detail: "You are not signed in." });
      return;
    }

    if (stopped) return;

    commit({ status: retry === 0 ? "connecting" : snapshot.status });

    let ws: WebSocket;
    try {
      ws = new WebSocket(
        `${workspaceLiveBase}/workspace/${encodeURIComponent(workspaceId)}/live?access_token=${encodeURIComponent(accessToken)}`,
      );
    } catch {
      commit({ status: "connecting", detail: "Opening a connection to the workspace room." });
      scheduleRetry();
      return;
    }

    socket = ws;

    ws.onopen = () => {
      retry = 0;
      // The welcome frame is what moves this to "live" — an open socket that has
      // not been accepted into the room is not presence.
      commit({ status: "connecting", detail: null });

      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ t: "ping" }), PING_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const message = parseServerMessage(event.data);
      if (message) apply(message);
    };

    ws.onerror = () => {
      // The close handler does the work; `onerror` carries no detail in browsers.
    };

    ws.onclose = async () => {
      socket = null;

      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }

      // Cursors from the lost session are meaningless now.
      targets.clear();
      commit({ you: null });

      if (stopped) {
        commit({ status: "idle", detail: null, peers: [] });
        return;
      }

      // Three failures is where "a blip" becomes "something is wrong", and where
      // a token refresh is worth attempting rather than merely retrying.
      if (retry === 2) await refresh();

      if (retry >= 2) {
        commit({ status: "connecting", detail: await explainFailure() });
        if (retry >= 4) {
          const detail = await explainFailure();
          commit({ status: "error", detail });
          onFatal?.(detail);
          return;
        }
      } else {
        commit({ status: "connecting", detail: "Reconnecting to the workspace room." });
      }

      scheduleRetry();
    };
  }

  /**
   * Send whatever position is queued, and remember it as the last one sent.
   *
   * Returns silently when nothing is queued, so a timer that fires after the
   * pointer stopped moving does not re-send a position the other end already
   * has.
   */
  function flushCursor(now: number): void {
    if (!pendingCursor) return;
    lastCursorSentAt = now;
    lastSentCursor = pendingCursor;
    send({ t: "cursor", ...pendingCursor });
    pendingCursor = null;
  }

  // ---------------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------------

  return {
    connect() {
      if (!stopped) return;
      stopped = false;
      retry = 0;
      void open();
    },

    disconnect() {
      stopped = true;
      retry = 0;

      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (cursorTimer) {
        clearTimeout(cursorTimer);
        cursorTimer = null;
      }

      const ws = socket;
      socket = null;
      if (ws) {
        // Detach before closing: the handler would otherwise treat a deliberate
        // disconnect as a failure and start reconnecting to a panel that is gone.
        ws.onclose = null;
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        try {
          ws.close(1000, "Left the workspace");
        } catch {
          // Already closing.
        }
      }

      targets.clear();
      pendingCursor = null;
      lastSentCursor = null;
      lastCursorSentAt = 0;
      snapshot = EMPTY_SNAPSHOT;
      for (const listener of listeners) listener();
    },

    setApp(slug) {
      announcedApp = slug;
      send({ t: "app", slug });
    },

    sendCursor(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;

      const next = {
        x: Math.min(1, Math.max(0, x)),
        y: Math.min(1, Math.max(0, y)),
      };

      // Too close to the last position that went out to be worth a broadcast.
      // The queued point is dropped rather than kept, so a superseded position
      // cannot arrive after the pointer has already moved past it.
      if (lastSentCursor) {
        const dx = next.x - lastSentCursor.x;
        const dy = next.y - lastSentCursor.y;
        if (dx * dx + dy * dy < CURSOR_MIN_DELTA * CURSOR_MIN_DELTA) {
          pendingCursor = null;
          return;
        }
      }

      pendingCursor = next;

      const now = Date.now();
      const elapsed = now - lastCursorSentAt;

      if (elapsed >= CURSOR_INTERVAL_MS) {
        flushCursor(now);
        return;
      }

      // Coalesce: whatever the pointer is on when the window opens is what gets
      // sent, so a fast mouse over a slow link loses intermediate points instead
      // of queueing them and drifting behind.
      if (!cursorTimer) {
        cursorTimer = setTimeout(() => {
          cursorTimer = null;
          flushCursor(Date.now());
        }, CURSOR_INTERVAL_MS - elapsed);
      }
    },

    readTargets() {
      return targets;
    },

    getSnapshot() {
      return snapshot;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
