/**
 * WorkspaceRoom — one Durable Object per workspace, holding its live state.
 *
 * The database (see `supabase/migrations/0001_workspaces.sql`) records who is in
 * a workspace. This object records who is *here right now*, where their pointer
 * is, and which application they have open — facts that change many times a
 * second and are worth nothing a second later. Putting them in Postgres would
 * mean a row write per mouse move; putting them here means one in-memory value
 * per person and a fan-out.
 *
 * ## Hibernation shapes the design
 *
 * A Durable Object can be evicted from memory while its WebSockets stay open at
 * Cloudflare's edge, and it is woken for the next message. That is good for
 * rooms nobody is using, and it means **instance fields are not durable**. So
 * the split here is deliberate:
 *
 *   * identity — who this socket belongs to — lives in the socket's *attachment*
 *     (`ws.serializeAttachment`), which survives hibernation
 *   * cursor positions live in a plain `Map`, which does not
 *
 * Losing cursor positions on eviction is correct, not a compromise. A pointer
 * position from before the room went to sleep describes a mouse that has since
 * moved; replaying it would draw a lie. The peer reappears where they are on
 * their next move.
 *
 * Presence itself survives, because it is reconstructed by enumerating the open
 * sockets rather than by trusting a field.
 */

import {
  CURSOR_COLOURS,
  MAX_MESSAGE_BYTES,
  MAX_PEERS,
  PEER_TIMEOUT_MS,
  type ClientMessage,
  type Peer,
  type ServerMessage,
} from "./protocol";

/**
 * What is stored on each socket. This is the peer record minus the two things
 * that must not be persisted: the cursor (stale on wake) and `last_seen`
 * (rewritten on every ping, and cheap to keep in memory instead).
 */
type Attachment = {
  id: string;
  user_id: string;
  email: string;
  full_name: string;
  role: string;
  color: number;
  app: string | null;
  joined_at: number;
};

/** Identity forwarded by the Worker once it has verified the caller. */
export type PeerIdentity = {
  user_id: string;
  email: string;
  full_name: string;
  role: string;
};

/**
 * A stable colour per person.
 *
 * FNV-1a over the user id: no storage, no coordination, and the same answer on
 * every machine and every reconnect. Randomising instead would give the same
 * person a different colour in each window, which makes a room of three people
 * unreadable.
 */
function colourFor(userId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < userId.length; index += 1) {
    hash ^= userId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % CURSOR_COLOURS;
}

export class WorkspaceRoom implements DurableObject {
  /** Ephemeral by design — see the header. Keyed by connection id. */
  #cursors = new Map<string, { x: number; y: number }>();
  /** Ephemeral too: refreshed by every ping, so a missed one is not an eviction. */
  #lastSeen = new Map<string, number>();

  /**
   * Only `state` is taken. Wrangler passes the bindings as a second argument and
   * this deliberately ignores them: the room holds no Supabase credentials and
   * no storage, so there is nothing in `env` it could legitimately use. Leaving
   * the parameter out makes that a compile-time fact rather than a comment.
   */
  constructor(private readonly state: DurableObjectState) {}

  /**
   * Entry point from the Worker.
   *
   * The Worker has already established that the caller is an active member of
   * this workspace and passes the result in `X-Workspace-Peer`. This object does
   * not re-authorize and holds no Supabase credentials: there is exactly one
   * place that decides who gets in, and it is not here.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // A read-only snapshot, for `wrangler tail` and for debugging by curl. It
    // exposes no more than every connected client can already see.
    if (url.pathname.endsWith("/state")) {
      return Response.json({
        peers: this.#peers(),
        sockets: this.state.getWebSockets().length,
      });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }

    const identity = this.#readIdentity(request);
    if (!identity) {
      return new Response("Missing verified peer identity.", { status: 400 });
    }

    // Sockets that are open but silent are still counted until the sweep runs,
    // so sweep before deciding the room is full.
    this.#sweep();

    if (this.state.getWebSockets().length >= MAX_PEERS) {
      return new Response("This workspace is full.", { status: 429 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.state.acceptWebSocket(server);

    const attachment: Attachment = {
      id: crypto.randomUUID(),
      user_id: identity.user_id,
      email: identity.email,
      full_name: identity.full_name,
      role: identity.role,
      color: colourFor(identity.user_id),
      app: null,
      joined_at: Date.now(),
    };
    server.serializeAttachment(attachment);
    this.#lastSeen.set(attachment.id, Date.now());

    // Welcome first, then announce. Doing it in this order means the arriving
    // client already knows its own id when the others start referring to it.
    const welcome: ServerMessage = {
      t: "welcome",
      you: this.#peerOf(attachment),
      peers: this.#peers().filter((peer) => peer.id !== attachment.id),
    };
    server.send(JSON.stringify(welcome));

    this.#broadcast({ t: "join", peer: this.#peerOf(attachment) }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Hibernation-safe message handler.
   *
   * Declared on the class rather than as a per-socket `addEventListener`, which
   * is what lets the object be evicted without dropping the connection.
   */
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = this.#attachmentOf(ws);
    if (!attachment) return;

    if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) return;

    this.#lastSeen.set(attachment.id, Date.now());

    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      // A malformed frame is not worth closing a good connection over.
      return;
    }

    switch (message?.t) {
      case "cursor": {
        const x = Number(message.x);
        const y = Number(message.y);

        // Dropping a non-finite coordinate is right; clamping a slightly
        // out-of-range one is friendlier than dropping the frame, because a
        // value of 1.0000001 usually just means "at the right edge".
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;

        const cx = Math.min(1, Math.max(0, x));
        const cy = Math.min(1, Math.max(0, y));

        this.#cursors.set(attachment.id, { x: cx, y: cy });
        this.#broadcast({ t: "cursor", id: attachment.id, x: cx, y: cy }, ws);
        return;
      }

      case "app": {
        const slug = typeof message.slug === "string" ? message.slug.slice(0, 120) : null;

        // Rare enough to be worth persisting: it must survive hibernation, or a
        // peer who is quietly sitting inside an application would appear to be
        // using nothing after the room wakes.
        const next: Attachment = { ...attachment, app: slug };
        ws.serializeAttachment(next);

        this.#broadcast({ t: "app", id: attachment.id, slug }, ws);
        return;
      }

      case "ping": {
        this.#sweep();
        this.#send(ws, { t: "pong" });
        return;
      }

      default:
        // Unknown message types are ignored rather than fatal, so a newer client
        // talking to an older room degrades instead of disconnecting.
        return;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = this.#attachmentOf(ws);
    if (!attachment) return;

    this.#cursors.delete(attachment.id);
    this.#lastSeen.delete(attachment.id);

    // Announce before the socket is gone, so the id is still readable.
    this.#broadcast({ t: "leave", id: attachment.id }, ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    // A socket error and a socket close leave the same state behind, so they
    // take the same path. `webSocketClose` may still follow; the map deletes are
    // idempotent and the second `leave` is harmless because peers ignore an id
    // they no longer hold.
    await this.webSocketClose(ws);
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  #readIdentity(request: Request): PeerIdentity | null {
    const header = request.headers.get("X-Workspace-Peer");
    if (!header) return null;

    try {
      const parsed = JSON.parse(header) as PeerIdentity;
      if (!parsed?.user_id || !parsed?.email) return null;
      return {
        user_id: String(parsed.user_id),
        email: String(parsed.email),
        full_name: String(parsed.full_name || parsed.email.split("@")[0]),
        role: String(parsed.role || "member"),
      };
    } catch {
      return null;
    }
  }

  #attachmentOf(ws: WebSocket): Attachment | null {
    const stored = ws.deserializeAttachment() as Attachment | null;
    if (!stored?.id) return null;
    return stored;
  }

  #peerOf(attachment: Attachment): Peer {
    return {
      ...attachment,
      cursor: this.#cursors.get(attachment.id) ?? null,
    };
  }

  /** Everyone currently connected, reconstructed from the open sockets. */
  #peers(): Peer[] {
    const peers: Peer[] = [];
    for (const ws of this.state.getWebSockets()) {
      const attachment = this.#attachmentOf(ws);
      if (attachment) peers.push(this.#peerOf(attachment));
    }
    return peers;
  }

  #send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // The socket died between the sweep and this write. The close handler will
      // do the bookkeeping.
    }
  }

  /** Send to every socket except `sender` (which may be null, to send to all). */
  #broadcast(message: ServerMessage, sender: WebSocket | null): void {
    const payload = JSON.stringify(message);
    for (const ws of this.state.getWebSockets()) {
      if (ws === sender) continue;
      try {
        ws.send(payload);
      } catch {
        // As above: a dead socket is not an error worth propagating.
      }
    }
  }

  /**
   * Drop peers that have gone quiet.
   *
   * A socket that closes cleanly fires `webSocketClose`. A laptop that is
   * slammed shut, or a network that silently vanishes, does not — and without
   * this the room would show a motionless cursor for someone who left an hour
   * ago. Runs opportunistically on incoming traffic, which is exactly when it
   * matters and costs nothing when it does not.
   */
  #sweep(): void {
    const cutoff = Date.now() - PEER_TIMEOUT_MS;
    for (const ws of this.state.getWebSockets()) {
      const attachment = this.#attachmentOf(ws);
      if (!attachment) continue;

      const seen = this.#lastSeen.get(attachment.id);
      if (seen === undefined) {
        // Woken from hibernation with no in-memory record. Give it a full
        // timeout rather than expiring it immediately.
        this.#lastSeen.set(attachment.id, Date.now());
        continue;
      }

      if (seen < cutoff) {
        this.#cursors.delete(attachment.id);
        this.#lastSeen.delete(attachment.id);
        this.#broadcast({ t: "leave", id: attachment.id }, ws);
        try {
          ws.close(4000, "Timed out");
        } catch {
          // Already gone.
        }
      }
    }
  }
}
