/**
 * The workflow graph: a global, per-installation view of how the platform's
 * applications feed each other.
 *
 * This is a *projection* of the orchestration layer's dependency edges, not a second
 * source of truth. A wire here corresponds to an `edge` in the store:
 *
 *   wire: cad --[type_id]--> hexadof      =>      edge { consumer_app, type_id, mode }
 *
 * What a wire does and does not do (decided, see DESIGN.md):
 *   - It REGISTERS a dependency and tracks freshness. The hub computes staleness.
 *   - It does NOT transfer payloads, transform data, or wake a closed app.
 *     Producers publish; consumers pull when notified.
 *
 * Ports are always derived from an app's *declared* artifact types, never hardcoded
 * per app. That is what lets the graph scale to many applications without UI changes.
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type PortDirection = "in" | "out";

/** How a dependency is satisfied. Mirrors `apro_store::Mode`. */
export type WireMode = "pinned" | "tracking" | "compatible";

/**
 * Node kinds are an open registry. Only `app` ships today; `source`, `sink` and
 * `group` are additive without touching the graph engine.
 */
export type NodeKind = "app";

export type ArtifactPort = {
  /** Canonical artifact type id, e.g. `apro-cad/mass-properties-si-v1`. */
  typeId: string;
  direction: PortDirection;
  label: string;
  description: string;
  /** Whether the port is wired yet — outputs may go nowhere. */
  connected: boolean;
};

export type WorkflowNode = {
  id: string;
  kind: NodeKind;
  /** Product slug. Becomes the app's type namespace, so it must be kebab-case. */
  appSlug: string;
  name: string;
  installed: boolean;
  /** Product artwork, when the registry provides it. */
  icon?: string;
  position: { x: number; y: number };
  ports: ArtifactPort[];
};

export type WorkflowWire = {
  id: string;
  fromNode: string;
  fromTypeId: string;
  toNode: string;
  toTypeId: string;
  mode: WireMode;
  /**
   * `true` when this wire exists as a real edge in the store, `false` when it is a
   * local draft. Drafts are what the UI shows before the backend write lands.
   */
  applied: boolean;
  /** Live freshness from the store, when known. */
  stale?: boolean;
};

export type WorkflowGraph = {
  schema: "apro-workflow-v1";
  id: string;
  name: string;
  /** Reserved for per-project graphs; the shipped UI is install-global. */
  scope: "global" | "project";
  nodes: WorkflowNode[];
  wires: WorkflowWire[];
  /**
   * Apps the user has taken off the canvas on purpose.
   *
   * Without this, removing a block is not durable: `reconcileApps` adds any app the
   * canvas has never seen, so a removed block comes straight back on the next load.
   * That rule exists so a newly installed product shows up without pressing Reset,
   * and it is the right rule — but "absent because it was never placed" and "absent
   * because it was deliberately removed" are different states and had been collapsed
   * into one.
   *
   * Optional in the type because graphs saved before this field existed do not have
   * it; every read goes through `removedAppsOf`.
   */
  removedApps?: string[];
};

/** The deliberate removals, tolerating graphs saved before the field existed. */
export function removedAppsOf(graph: WorkflowGraph): string[] {
  return Array.isArray(graph.removedApps) ? graph.removedApps : [];
}

export type AppDescriptor = {
  slug: string;
  name: string;
  installed: boolean;
  /** Product artwork, passed through to the canvas node. */
  icon?: string;
};

// ---------------------------------------------------------------------------
// Type registry: the UI's view of artifact types
// ---------------------------------------------------------------------------

export type TypeDescriptor = {
  label: string;
  description: string;
  /** The app that owns this type, i.e. its namespace. */
  owner: string;
};

export const TYPE_REGISTRY: Record<string, TypeDescriptor> = {
  "apro-cad/mass-properties-si-v1": {
    label: "Mass properties",
    description:
      "Mass, centre of gravity and inertia tensor, SI. Published by the CAD application.",
    owner: "apro-cad",
  },
  "apro-cad/reference-geometry-si-v1": {
    label: "Reference geometry",
    description:
      "Reference area, reference length and body diameter, SI. Aerodynamic conventions.",
    owner: "apro-cad",
  },
  "apro-cad/mesh-export-v1": {
    label: "Mesh export",
    description: "STL or STEP geometry, stored as a content-addressed blob.",
    owner: "apro-cad",
  },
  "burn-geometry-modeler/grain-geometry-v1": {
    label: "Grain geometry",
    description: "Solid grain port geometry and burn progression inputs.",
    owner: "burn-geometry-modeler",
  },
  "propulsor/thrust-curve-v1": {
    label: "Thrust curve",
    description: "Thrust against time, with application point and direction.",
    owner: "propulsor",
  },
  "hexadof/aero-model-v1": {
    label: "Aerodynamic model",
    description: "Drag table against Mach, plus lift and moment derivatives.",
    owner: "hexadof",
  },
  "hexadof/flight-run-v1": {
    label: "Flight run",
    description: "A completed 6-DOF run: trajectory, events and summary.",
    owner: "hexadof",
  },
};

export function describeType(typeId: string): TypeDescriptor {
  const known = TYPE_REGISTRY[typeId];
  if (known) return known;
  const [owner, name = typeId] = typeId.split("/");
  return {
    label: name.replace(/-/g, " "),
    description: "Type not yet described in the registry.",
    owner,
  };
}

/**
 * Fallback interfaces, used only until the store reports what each app actually
 * declared. Once an app calls `declare_interface`, its real declaration wins.
 */
export const KNOWN_INTERFACES: Record<string, { publishes: string[]; consumes: string[] }> = {
  // The CAD application owns geometry and the mass properties derived from it.
  // Everything downstream consumes these, which is why the `apro-cad/*` types belong
  // to this namespace and not to whichever app happens to read them.
  "apro-cad": {
    publishes: [
      "apro-cad/mass-properties-si-v1",
      "apro-cad/reference-geometry-si-v1",
      "apro-cad/mesh-export-v1",
    ],
    consumes: [],
  },
  "burn-geometry-modeler": {
    publishes: ["burn-geometry-modeler/grain-geometry-v1"],
    // The modeler works on geometry the CAD app produces.
    consumes: ["apro-cad/reference-geometry-si-v1"],
  },
  propulsor: {
    publishes: ["propulsor/thrust-curve-v1"],
    consumes: ["burn-geometry-modeler/grain-geometry-v1"],
  },
  hexadof: {
    publishes: ["hexadof/flight-run-v1"],
    consumes: [
      "apro-cad/mass-properties-si-v1",
      "apro-cad/reference-geometry-si-v1",
      "burn-geometry-modeler/grain-geometry-v1",
      "propulsor/thrust-curve-v1",
    ],
  },
};

// ---------------------------------------------------------------------------
// Namespace validity
// ---------------------------------------------------------------------------

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * An app slug becomes the namespace of every type it publishes, so it must be
 * kebab-case. This is the same rule the store enforces (`TypeId::new`), surfaced
 * here so the graph can warn before an app ever tries to publish.
 */
export function isValidNamespace(slug: string): boolean {
  return slug.length > 0 && slug.length <= 64 && KEBAB.test(slug);
}

// ---------------------------------------------------------------------------
// Port derivation
// ---------------------------------------------------------------------------

export function buildPorts(
  publishes: string[],
  consumes: string[],
  wires: WorkflowWire[] = [],
  nodeId = "",
): ArtifactPort[] {
  const wired = (typeId: string, direction: PortDirection) =>
    wires.some(
      (wire) =>
        (direction === "out"
          ? wire.fromNode === nodeId && wire.fromTypeId === typeId
          : wire.toNode === nodeId && wire.toTypeId === typeId),
    );

  const inputs: ArtifactPort[] = consumes.map((typeId) => ({
    typeId,
    direction: "in" as const,
    label: describeType(typeId).label,
    description: describeType(typeId).description,
    connected: wired(typeId, "in"),
  }));

  const outputs: ArtifactPort[] = publishes.map((typeId) => ({
    typeId,
    direction: "out" as const,
    label: describeType(typeId).label,
    description: describeType(typeId).description,
    connected: wired(typeId, "out"),
  }));

  return [...inputs, ...outputs];
}

export function buildNode(
  app: AppDescriptor,
  interfaceEntry: { publishes: string[]; consumes: string[] } | undefined,
  position: { x: number; y: number },
): WorkflowNode {
  const decl = interfaceEntry ?? KNOWN_INTERFACES[app.slug] ?? { publishes: [], consumes: [] };
  return {
    id: nodeIdFor(app.slug),
    kind: "app",
    appSlug: app.slug,
    name: app.name,
    installed: app.installed,
    icon: app.icon,
    position,
    ports: buildPorts(decl.publishes, decl.consumes, [], nodeIdFor(app.slug)),
  };
}

export function nodeIdFor(appSlug: string): string {
  return `node:${appSlug}`;
}

// ---------------------------------------------------------------------------
// Connection validation
// ---------------------------------------------------------------------------

export type ConnectionRejection =
  | "missing_port"
  | "direction"
  | "type_mismatch"
  | "self"
  | "duplicate"
  | "cycle";

export type ConnectionCheck =
  | { ok: true }
  | { ok: false; code: ConnectionRejection; reason: string };

export type PortRef = { nodeId: string; typeId: string; direction: PortDirection };

export function checkConnection(
  graph: WorkflowGraph,
  from: PortRef,
  to: PortRef,
): ConnectionCheck {
  if (from.nodeId === to.nodeId) {
    return { ok: false, code: "self", reason: "An app cannot feed itself." };
  }
  if (from.direction !== "out" || to.direction !== "in") {
    return {
      ok: false,
      code: "direction",
      reason: "Wires run from an output port to an input port.",
    };
  }

  const sourceNode = graph.nodes.find((node) => node.id === from.nodeId);
  const targetNode = graph.nodes.find((node) => node.id === to.nodeId);
  if (!sourceNode || !targetNode) {
    return { ok: false, code: "missing_port", reason: "Unknown node." };
  }

  const sourcePort = sourceNode.ports.find(
    (port) => port.typeId === from.typeId && port.direction === "out",
  );
  const targetPort = targetNode.ports.find(
    (port) => port.typeId === to.typeId && port.direction === "in",
  );
  if (!sourcePort || !targetPort) {
    return { ok: false, code: "missing_port", reason: "That port no longer exists." };
  }

  if (from.typeId !== to.typeId) {
    return {
      ok: false,
      code: "type_mismatch",
      reason: `${describeType(from.typeId).label} cannot feed ${describeType(to.typeId).label}. Ports must carry the same artifact type.`,
    };
  }

  const duplicate = graph.wires.some(
    (wire) =>
      wire.fromNode === from.nodeId &&
      wire.fromTypeId === from.typeId &&
      wire.toNode === to.nodeId &&
      wire.toTypeId === to.typeId,
  );
  if (duplicate) {
    return { ok: false, code: "duplicate", reason: "These ports are already connected." };
  }

  // Cycles would make staleness undefined, so they are refused rather than
  // half-supported. (The CAD app's own recompute engine makes the same call.)
  if (reaches(graph.wires, to.nodeId, from.nodeId, new Set())) {
    return {
      ok: false,
      code: "cycle",
      reason: "That would create a loop, which makes freshness undefined.",
    };
  }

  return { ok: true };
}

function reaches(
  wires: WorkflowWire[],
  current: string,
  target: string,
  seen: Set<string>,
): boolean {
  if (current === target) return true;
  if (seen.has(current)) return false;
  seen.add(current);
  return wires
    .filter((wire) => wire.fromNode === current)
    .some((wire) => reaches(wires, wire.toNode, target, seen));
}

// ---------------------------------------------------------------------------
// Graph mutation
// ---------------------------------------------------------------------------

export function wireId(from: PortRef, to: PortRef): string {
  return `wire:${from.nodeId}:${from.typeId}->${to.nodeId}:${to.typeId}`;
}

export function addWire(graph: WorkflowGraph, from: PortRef, to: PortRef, mode: WireMode): WorkflowGraph {
  const wire: WorkflowWire = {
    id: wireId(from, to),
    fromNode: from.nodeId,
    fromTypeId: from.typeId,
    toNode: to.nodeId,
    toTypeId: to.typeId,
    mode,
    applied: false,
  };
  return { ...graph, wires: [...graph.wires, wire] };
}

export function removeWire(graph: WorkflowGraph, wireId: string): WorkflowGraph {
  return { ...graph, wires: graph.wires.filter((wire) => wire.id !== wireId) };
}

export function setWireMode(graph: WorkflowGraph, wireId: string, mode: WireMode): WorkflowGraph {
  return {
    ...graph,
    wires: graph.wires.map((wire) => (wire.id === wireId ? { ...wire, mode, applied: false } : wire)),
  };
}

export function removeNode(graph: WorkflowGraph, nodeId: string): WorkflowGraph {
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  const removed = removedAppsOf(graph);

  return {
    ...graph,
    nodes: graph.nodes.filter((entry) => entry.id !== nodeId),
    wires: graph.wires.filter((wire) => wire.fromNode !== nodeId && wire.toNode !== nodeId),
    // Remember that this was deliberate, so reconciliation does not helpfully put it
    // back on the next load.
    removedApps:
      node && !removed.includes(node.appSlug) ? [...removed, node.appSlug] : removed,
  };
}

export function moveNode(
  graph: WorkflowGraph,
  nodeId: string,
  position: { x: number; y: number },
): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === nodeId ? { ...node, position } : node)),
  };
}

export function addAppNode(graph: WorkflowGraph, app: AppDescriptor, position: { x: number; y: number }): WorkflowGraph {
  if (graph.nodes.some((node) => node.appSlug === app.slug)) return graph;
  return {
    ...graph,
    nodes: [...graph.nodes, buildNode(app, undefined, position)],
    // Placing it again is a clear statement that the earlier removal is over.
    removedApps: removedAppsOf(graph).filter((slug) => slug !== app.slug),
  };
}

/**
 * Refresh the canvas from the current app registry.
 *
 * The graph is persisted in `localStorage`, so a saved canvas outlives changes to the
 * registry. Two things follow from that:
 *
 * * Existing nodes pick up current names, install state and artwork. Without this a
 *   graph saved before a field existed keeps the old shape — how node icons once went
 *   missing.
 * * Apps the canvas has never seen are **added**. Otherwise a newly installed product
 *   would be invisible on the canvas until the user pressed Reset, which is not what
 *   "the apps you have" should mean.
 *
 * Positions of existing nodes, ports and wires are preserved.
 *
 * An app the user deliberately removed is **not** put back. That distinction is the
 * whole reason `removedApps` exists: reconciliation should recover from a graph that
 * predates an app, not from a decision the user made.
 */
export function reconcileApps(graph: WorkflowGraph, apps: AppDescriptor[]): WorkflowGraph {
  if (apps.length === 0) return graph;
  const bySlug = new Map(apps.map((app) => [app.slug, app]));
  const removed = new Set(removedAppsOf(graph));

  const nodes = graph.nodes.map((node) => {
    const app = bySlug.get(node.appSlug);
    if (!app) return node;
    return { ...node, name: app.name, installed: app.installed, icon: app.icon };
  });

  const present = new Set(nodes.map((node) => node.appSlug));
  let nextY = nodes.reduce((lowest, node) => Math.max(lowest, node.position.y), 0) + 340;
  for (const app of apps) {
    if (present.has(app.slug) || removed.has(app.slug)) continue;
    nodes.push(buildNode(app, undefined, { x: 40, y: nextY }));
    nextY += 340;
  }

  return { ...graph, nodes };
}

/** Refresh ports from declared interfaces and wire state, without moving nodes. */
export function refreshPorts(
  graph: WorkflowGraph,
  interfaces: Map<string, { publishes: string[]; consumes: string[] }>,
): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const decl =
        interfaces.get(node.appSlug) ??
        KNOWN_INTERFACES[node.appSlug] ?? { publishes: [], consumes: [] };
      return {
        ...node,
        ports: buildPorts(decl.publishes, decl.consumes, graph.wires, node.id),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// The default workflow
// ---------------------------------------------------------------------------

/**
 * The shipped template: "Rocket design → flight analysis".
 *
 * The CAD application feeds HexaDOF directly, which is the first real integration
 * wired through the harness. Propulsor is placed unconnected on purpose — dragging
 * its thrust curve into HexaDOF is the shortest demonstration that wiring works.
 */
export function defaultWorkflow(apps: AppDescriptor[]): WorkflowGraph {
  const bySlug = (slug: string) => apps.find((app) => app.slug === slug);
  const byPrefix = (prefix: string) =>
    apps.find((app) => app.slug.toLowerCase().startsWith(prefix));

  const fallback = (slug: string, name: string): AppDescriptor => ({
    slug,
    name,
    installed: false,
  });

  const cad = bySlug("apro-cad") ?? fallback("apro-cad", "APRO CAD");
  const modeler =
    bySlug("burn-geometry-modeler") ?? fallback("burn-geometry-modeler", "Burn & Geometry Modeler");
  // The product registry currently uses a slug with spaces for Propulsor. Matching by
  // prefix keeps the real (invalid) slug on the canvas so the problem is visible
  // instead of being papered over with a tidy stand-in.
  const propulsor = byPrefix("propulsor") ?? fallback("propulsor", "Propulsor");
  const hexadof = bySlug("hexadof") ?? fallback("hexadof", "HexaDOF");

  const nodes: WorkflowNode[] = [
    buildNode(cad, undefined, { x: 40, y: 40 }),
    buildNode(modeler, undefined, { x: 40, y: 380 }),
    buildNode(propulsor, undefined, { x: 40, y: 700 }),
    buildNode(hexadof, undefined, { x: 640, y: 220 }),
  ];

  const wires: WorkflowWire[] = [
    {
      id: wireId(
        { nodeId: nodeIdFor(cad.slug), typeId: MASS_PROPERTIES_TYPE, direction: "out" },
        { nodeId: nodeIdFor(hexadof.slug), typeId: MASS_PROPERTIES_TYPE, direction: "in" },
      ),
      fromNode: nodeIdFor(cad.slug),
      fromTypeId: MASS_PROPERTIES_TYPE,
      toNode: nodeIdFor(hexadof.slug),
      toTypeId: MASS_PROPERTIES_TYPE,
      // Design-time work follows upstream changes; recorded results pin instead.
      mode: "tracking",
      applied: false,
    },
    {
      id: wireId(
        { nodeId: nodeIdFor(modeler.slug), typeId: GRAIN_GEOMETRY_TYPE, direction: "out" },
        { nodeId: nodeIdFor(hexadof.slug), typeId: GRAIN_GEOMETRY_TYPE, direction: "in" },
      ),
      fromNode: nodeIdFor(modeler.slug),
      fromTypeId: GRAIN_GEOMETRY_TYPE,
      toNode: nodeIdFor(hexadof.slug),
      toTypeId: GRAIN_GEOMETRY_TYPE,
      mode: "tracking",
      applied: false,
    },
  ];

  const graph: WorkflowGraph = {
    schema: "apro-workflow-v1",
    id: "default-rocket-workflow",
    name: "Rocket design → flight analysis",
    scope: "global",
    nodes,
    wires,
  };

  return refreshPorts(graph, new Map());
}

// ---------------------------------------------------------------------------
// Projecting real store edges onto the canvas
// ---------------------------------------------------------------------------

/** The subset of a store edge the canvas needs. Structurally satisfied by `StoreEdge`. */
export type ProjectableEdge = {
  consumer_app: string;
  type_id: string;
  mode: WireMode;
  stale: boolean;
};

/**
 * Project real store edges onto the workflow graph.
 *
 * A store edge records a consumer and an artifact type, not a producer node — the
 * producer is the type's namespace owner, which is the rule the platform enforces
 * anyway (`register_edge` sets `owner_app` from the type id).
 *
 * Edges whose apps are not on the canvas are skipped rather than inventing nodes, so
 * the canvas only ever shows relationships the user can see and act on.
 */
export function mergeStoreEdges(graph: WorkflowGraph, edges: ProjectableEdge[]): WorkflowGraph {
  const wires = [...graph.wires];
  const onCanvas = new Set(graph.nodes.map((node) => node.id));

  for (const edge of edges) {
    const owner = edge.type_id.split("/")[0];
    const fromNode = nodeIdFor(owner);
    const toNode = nodeIdFor(edge.consumer_app);
    if (!onCanvas.has(fromNode) || !onCanvas.has(toNode)) continue;

    const id = `wire:${fromNode}:${edge.type_id}->${toNode}:${edge.type_id}`;
    const index = wires.findIndex((wire) => wire.id === id);
    const projected: WorkflowWire = {
      id,
      fromNode,
      fromTypeId: edge.type_id,
      toNode,
      toTypeId: edge.type_id,
      mode: edge.mode,
      applied: true,
      stale: edge.stale,
    };
    if (index >= 0) {
      wires[index] = { ...wires[index], ...projected };
    } else {
      wires.push(projected);
    }
  }

  return { ...graph, wires };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STORAGE_KEY = "apro.workflow.v1";

/** The two artifact types the default template wires. */
const MASS_PROPERTIES_TYPE = "apro-cad/mass-properties-si-v1";
const GRAIN_GEOMETRY_TYPE = "burn-geometry-modeler/grain-geometry-v1";

/**
 * A subscription as the store reports it. Structurally satisfied by `StoreSubscription`.
 */
export type ProjectableSubscription = {
  consumer_app: string;
  type_id: string;
};

/**
 * Mark wires that exist as real subscriptions in the store.
 *
 * This is the authoritative "applied" flag: a wire is applied when the store holds a
 * subscription for that consumer and type, whether it was created from this canvas or
 * by the app itself.
 */
export function markApplied(
  graph: WorkflowGraph,
  subscriptions: ProjectableSubscription[],
): WorkflowGraph {
  const keys = new Set(
    subscriptions.map((entry) => `${entry.consumer_app}::${entry.type_id}`),
  );
  return {
    ...graph,
    wires: graph.wires.map((wire) => ({
      ...wire,
      applied: keys.has(`${nodeApp(wire.toNode)}::${wire.toTypeId}`),
    })),
  };
}

/** `node:cad` -> `cad`. Node ids are the app slug prefixed. */
export function nodeApp(nodeId: string): string {
  return nodeId.startsWith("node:") ? nodeId.slice("node:".length) : nodeId;
}

export function loadWorkflow(fallback: WorkflowGraph): WorkflowGraph {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as WorkflowGraph;
    if (parsed?.schema !== "apro-workflow-v1" || !Array.isArray(parsed.nodes)) return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

export function saveWorkflow(graph: WorkflowGraph): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(graph));
  } catch {
    // A full or unavailable localStorage must not break the editor.
  }
}

export function clearWorkflow(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
