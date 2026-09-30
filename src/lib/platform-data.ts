/**
 * Read adapter for the orchestration store.
 *
 * The hub hosts the store in-process, so the UI reads it through Tauri commands
 * rather than HTTP. When those commands are unavailable — a plain browser preview, or
 * the store failing to start — every loader falls back to clearly-labelled sample data
 * instead of pretending to be live.
 */

import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Wire types (mirror the Rust structs in apro-store)
// ---------------------------------------------------------------------------

export type StoreEvent = {
  seq: number;
  kind: string;
  type_id: string | null;
  artifact_id: string | null;
  revision_id: string | null;
  edge_id: string | null;
  actor_app: string | null;
  summary: string | null;
  created_at: number;
};

export type StoreEdge = {
  edge_id: string;
  consumer_app: string;
  consumer_ref: string | null;
  artifact_id: string;
  type_id: string;
  instance: string;
  mode: "pinned" | "tracking" | "compatible";
  pinned_revision_number: number | null;
  min_revision_number: number | null;
  last_satisfied_revision_number: number | null;
  current_revision_number: number | null;
  stale: boolean;
  created_at: number;
};

export type StoreInterface = {
  app: string;
  direction: "publish" | "consume" | string;
  type_id: string;
  default_mode: string | null;
  source: string;
  declared_at: number;
};

export type StoreStatus = {
  running: boolean;
  error: string | null;
  endpoint: string;
  node_id: string;
  data_dir: string;
  schema_version: number;
  artifacts: number;
  revisions: number;
  edges: number;
  stale_edges: number;
  demo_artifacts: number;
  blob_count: number;
  blob_bytes: number;
  cursor: number;
  /** Cursor for the read log, which is a separate sequence from the change feed. */
  access_cursor: number;
};

/**
 * A read, tagged with where it came from. `demo` means the store was unreachable and
 * the UI must say so rather than presenting the values as live.
 */
export type Loaded<T> = {
  data: T;
  source: "live" | "demo";
  error?: string;
};

function tauriAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function read<T>(command: string, args: Record<string, unknown>, demo: T): Promise<Loaded<T>> {
  if (!tauriAvailable()) {
    return { data: demo, source: "demo", error: "Not running inside APRO Works." };
  }
  try {
    const data = await invoke<T>(command, args);
    return { data, source: "live" };
  } catch (error) {
    return {
      data: demo,
      source: "demo",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Sample data — only ever shown with a visible "sample data" banner
// ---------------------------------------------------------------------------

const now = Date.now();
const minutesAgo = (minutes: number) => now - minutes * 60_000;

const DEMO_EVENTS: StoreEvent[] = [
  {
    seq: 42,
    kind: "revision.published",
    type_id: "apro-cad/mass-properties-si-v1",
    artifact_id: "demo-artifact-1",
    revision_id: "demo-revision-2",
    edge_id: null,
    actor_app: "burn-geometry-modeler",
    summary: "revision 2 of apro-cad/mass-properties-si-v1/engine-demo (611 bytes, json)",
    created_at: minutesAgo(2),
  },
  {
    seq: 41,
    kind: "edge.stale",
    type_id: "apro-cad/mass-properties-si-v1",
    artifact_id: "demo-artifact-1",
    revision_id: null,
    edge_id: "demo-edge-1",
    actor_app: null,
    summary: "hexadof is now 1 revision behind burn-geometry-modeler",
    created_at: minutesAgo(2),
  },
  {
    seq: 40,
    kind: "revision.fetched",
    type_id: "apro-cad/mass-properties-si-v1",
    artifact_id: "demo-artifact-1",
    revision_id: "demo-revision-1",
    edge_id: "demo-edge-1",
    actor_app: "hexadof",
    summary: "hexadof pulled revision 1",
    created_at: minutesAgo(9),
  },
  {
    seq: 39,
    kind: "edge.created",
    type_id: "burn-geometry-modeler/grain-geometry-v1",
    artifact_id: "demo-artifact-2",
    revision_id: null,
    edge_id: "demo-edge-2",
    actor_app: "hexadof",
    summary: "hexadof depends on burn-geometry-modeler/grain-geometry-v1/engine-demo (tracking)",
    created_at: minutesAgo(14),
  },
  {
    seq: 38,
    kind: "artifact.created",
    type_id: "burn-geometry-modeler/grain-geometry-v1",
    artifact_id: "demo-artifact-2",
    revision_id: null,
    edge_id: null,
    actor_app: "burn-geometry-modeler",
    summary: "created burn-geometry-modeler/grain-geometry-v1/engine-demo",
    created_at: minutesAgo(26),
  },
];

const DEMO_EDGES: StoreEdge[] = [
  {
    edge_id: "demo-edge-1",
    consumer_app: "hexadof",
    consumer_ref: "run-001",
    artifact_id: "demo-artifact-1",
    type_id: "apro-cad/mass-properties-si-v1",
    instance: "engine-demo",
    mode: "tracking",
    pinned_revision_number: null,
    min_revision_number: null,
    last_satisfied_revision_number: 1,
    current_revision_number: 2,
    stale: true,
    created_at: minutesAgo(26),
  },
  {
    edge_id: "demo-edge-2",
    consumer_app: "hexadof",
    consumer_ref: "run-001",
    artifact_id: "demo-artifact-2",
    type_id: "burn-geometry-modeler/grain-geometry-v1",
    instance: "engine-demo",
    mode: "tracking",
    pinned_revision_number: null,
    min_revision_number: null,
    last_satisfied_revision_number: 3,
    current_revision_number: 3,
    stale: false,
    created_at: minutesAgo(14),
  },
];

const DEMO_INTERFACES: StoreInterface[] = [
  {
    app: "burn-geometry-modeler",
    direction: "publish",
    type_id: "apro-cad/mass-properties-si-v1",
    default_mode: null,
    source: "runtime",
    declared_at: minutesAgo(30),
  },
  {
    app: "burn-geometry-modeler",
    direction: "publish",
    type_id: "burn-geometry-modeler/grain-geometry-v1",
    default_mode: null,
    source: "runtime",
    declared_at: minutesAgo(30),
  },
  {
    app: "hexadof",
    direction: "consume",
    type_id: "apro-cad/mass-properties-si-v1",
    default_mode: "tracking",
    source: "runtime",
    declared_at: minutesAgo(20),
  },
  {
    app: "hexadof",
    direction: "consume",
    type_id: "burn-geometry-modeler/grain-geometry-v1",
    default_mode: "tracking",
    source: "runtime",
    declared_at: minutesAgo(20),
  },
];

const DEMO_STATUS: StoreStatus = {
  running: true,
  error: null,
  endpoint: "http://127.0.0.1:0",
  node_id: "demo-node",
  data_dir: "(sample data)",
  schema_version: 1,
  artifacts: 3,
  revisions: 5,
  edges: 2,
  stale_edges: 1,
  demo_artifacts: 0,
  blob_count: 1,
  blob_bytes: 98_304,
  cursor: 42,
  access_cursor: 7,
};

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

export function fetchStoreStatus(): Promise<Loaded<StoreStatus>> {
  return read("get_store_status", {}, DEMO_STATUS);
}

export function fetchStoreEvents(since = 0, limit = 200): Promise<Loaded<StoreEvent[]>> {
  return read(
    "get_store_events",
    { since, limit },
    DEMO_EVENTS.filter((event) => event.seq > since),
  );
}

export function fetchStoreEdges(): Promise<Loaded<StoreEdge[]>> {
  return read("list_store_edges", {}, DEMO_EDGES);
}

export function fetchStoreInterfaces(): Promise<Loaded<StoreInterface[]>> {
  return read("list_store_interfaces", {}, DEMO_INTERFACES);
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** Group a feed into pushes (writes) and pulls (reads). */
export function eventDirection(kind: string): "push" | "pull" | "graph" {
  if (kind === "revision.published" || kind === "artifact.created") return "push";
  if (kind === "revision.fetched") return "pull";
  return "graph";
}

export function formatRelative(millis: number, reference = Date.now()): string {
  const delta = Math.max(0, reference - millis);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

export function formatClock(millis: number): string {
  try {
    return new Date(millis).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Tauri serialises snake_case; the UI prefers camelCase in places. */
export function interfaceMap(
  entries: StoreInterface[],
): Map<string, { publishes: string[]; consumes: string[] }> {
  const map = new Map<string, { publishes: string[]; consumes: string[] }>();
  for (const entry of entries) {
    const current = map.get(entry.app) ?? { publishes: [], consumes: [] };
    if (entry.direction === "publish") current.publishes.push(entry.type_id);
    if (entry.direction === "consume") current.consumes.push(entry.type_id);
    map.set(entry.app, current);
  }
  return map;
}

export { mergeStoreEdges } from "./workflow";

// ---------------------------------------------------------------------------
// Subscriptions — the type-level wires the canvas edits
// ---------------------------------------------------------------------------

export type StoreSubscription = {
  subscription_id: string;
  consumer_app: string;
  type_id: string;
  mode: "pinned" | "tracking" | "compatible";
  edge_count: number;
  stale_edges: number;
  created_by: string | null;
  created_at: number;
};

/** One entry in the read log. Kept out of the change feed on purpose. */
export type StoreAccess = {
  seq: number;
  actor_app: string;
  type_id: string;
  instance: string;
  revision_id: string | null;
  revision_number: number | null;
  /** `hit` when a revision was returned, `miss` when nothing existed yet. */
  outcome: string;
  created_at: number;
};

const DEMO_SUBSCRIPTIONS: StoreSubscription[] = [
  {
    subscription_id: "demo-sub-1",
    consumer_app: "hexadof",
    type_id: "apro-cad/mass-properties-si-v1",
    mode: "tracking",
    edge_count: 1,
    stale_edges: 1,
    created_by: null,
    created_at: minutesAgo(26),
  },
  {
    subscription_id: "demo-sub-2",
    consumer_app: "hexadof",
    type_id: "burn-geometry-modeler/grain-geometry-v1",
    mode: "tracking",
    edge_count: 1,
    stale_edges: 0,
    created_by: null,
    created_at: minutesAgo(14),
  },
];

const DEMO_ACCESS: StoreAccess[] = [
  {
    seq: 7,
    actor_app: "hexadof",
    type_id: "burn-geometry-modeler/grain-geometry-v1",
    instance: "engine-demo",
    revision_id: "demo-revision-3",
    revision_number: 3,
    outcome: "hit",
    created_at: minutesAgo(4),
  },
  {
    seq: 6,
    actor_app: "hexadof",
    type_id: "apro-cad/mass-properties-si-v1",
    instance: "engine-demo",
    revision_id: "demo-revision-1",
    revision_number: 1,
    outcome: "hit",
    created_at: minutesAgo(9),
  },
  {
    seq: 5,
    actor_app: "propulsor",
    type_id: "apro-cad/mass-properties-si-v1",
    instance: "engine-not-yet-published",
    revision_id: null,
    revision_number: null,
    outcome: "miss",
    created_at: minutesAgo(11),
  },
];

export function fetchStoreSubscriptions(): Promise<Loaded<StoreSubscription[]>> {
  return read("list_store_subscriptions", {}, DEMO_SUBSCRIPTIONS);
}

export function fetchStoreAccess(since = 0, limit = 200): Promise<Loaded<StoreAccess[]>> {
  return read(
    "get_store_access",
    { since, limit },
    DEMO_ACCESS.filter((entry) => entry.seq > since),
  );
}

// ---------------------------------------------------------------------------
// Writes
//
// These deliberately have no sample-data fallback. A write that silently does nothing
// is worse than a write that fails: the user would believe a wire was applied.
// ---------------------------------------------------------------------------

function requireTauri(): void {
  if (!tauriAvailable()) {
    throw new Error(
      "Not running inside APRO Works, so wiring cannot be written to the orchestration store.",
    );
  }
}

/** Apply one drawn wire. Materialises edges for every existing instance. */
export async function createStoreSubscription(
  consumerApp: string,
  typeId: string,
  mode: string,
): Promise<StoreSubscription> {
  requireTauri();
  return invoke<StoreSubscription>("create_store_subscription", {
    consumerApp,
    typeId,
    mode,
  });
}

/** Un-wire durably. Returns how many edges were removed. */
export async function deleteStoreSubscription(subscriptionId: string): Promise<number> {
  requireTauri();
  return invoke<number>("delete_store_subscription", { subscriptionId });
}

/** Back-fill edges for instances published since the subscription was created. */
export async function materializeStoreSubscriptions(): Promise<number> {
  requireTauri();
  return invoke<number>("materialize_store_subscriptions");
}


