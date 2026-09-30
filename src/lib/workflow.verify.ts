/**
 * Verification for the workflow graph rules.
 *
 * The frontend has no test runner, so this is executed by bundling with esbuild and
 * running under Node:
 *
 *   npm run verify:workflow
 *
 * It covers the rules that decide whether a wire is allowed, which is the part of the
 * canvas that is easy to get subtly wrong and impossible to eyeball.
 */

import {
  addWire,
  buildPorts,
  checkConnection,
  defaultWorkflow,
  describeType,
  isValidNamespace,
  mergeStoreEdges,
  nodeIdFor,
  reconcileApps,
  refreshPorts,
  removeNode,
  removeWire,
  setWireMode,
  type AppDescriptor,
  type PortRef,
  type WorkflowGraph,
} from "./workflow";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const APPS: AppDescriptor[] = [
  { slug: "apro-cad", name: "APRO CAD", installed: true, icon: "/assets/icons/cad.png" },
  {
    slug: "burn-geometry-modeler",
    name: "Burn & Geometry Modeler",
    installed: true,
    icon: "/assets/icons/geometry.png",
  },
  { slug: "Propulsor - Liquid Engine Design Studio", name: "Propulsor", installed: true },
  { slug: "hexadof", name: "HexaDOF", installed: true },
];

const APRO_CAD = nodeIdFor("apro-cad");
const CAD = nodeIdFor("burn-geometry-modeler");
const HEX = nodeIdFor("hexadof");
const MASS = "apro-cad/mass-properties-si-v1";
const GRAIN = "burn-geometry-modeler/grain-geometry-v1";
const THRUST = "propulsor/thrust-curve-v1";

function out(nodeId: string, typeId: string): PortRef {
  return { nodeId, typeId, direction: "out" };
}
function inp(nodeId: string, typeId: string): PortRef {
  return { nodeId, typeId, direction: "in" };
}

console.log("\nworkflow graph verification\n---------------------------");

// ---------------------------------------------------------------- namespace rule
check(
  "the propulsor slug is rejected as a namespace",
  !isValidNamespace("Propulsor - Liquid Engine Design Studio"),
);
check("a kebab slug is accepted as a namespace", isValidNamespace("burn-geometry-modeler"));
check("trailing dash is rejected", !isValidNamespace("hexadof-"));

// ---------------------------------------------------------------- default template
const graph = defaultWorkflow(APPS);
check("default template places every registered app", graph.nodes.length === 4, `${graph.nodes.length}`);
check(
  "the default template wires both producers into HexaDOF",
  graph.wires.length === 2 && graph.wires.every((wire) => wire.toNode === HEX),
  `${graph.wires.length} wires`,
);
check(
  "the real (invalid) propulsor slug is on the canvas rather than a stand-in",
  graph.nodes.some((node) => node.appSlug === "Propulsor - Liquid Engine Design Studio"),
);

const aproCadNode = graph.nodes.find((node) => node.id === APRO_CAD);
const hexNode = graph.nodes.find((node) => node.id === HEX);
check(
  "APRO CAD owns the mass-properties output",
  Boolean(aproCadNode?.ports.find((p) => p.typeId === MASS && p.direction === "out")),
);
check(
  "HexaDOF exposes a mass-properties input",
  Boolean(hexNode?.ports.find((p) => p.typeId === MASS && p.direction === "in")),
);
check(
  "the grain modeler consumes rather than publishes the CAD namespace",
  !graph.nodes
    .find((node) => node.id === CAD)
    ?.ports.some((p) => p.typeId.startsWith("apro-cad/") && p.direction === "out"),
);

// ---------------------------------------------------------------- connection rules
const mismatch = checkConnection(graph, out(CAD, GRAIN), inp(HEX, MASS));
check(
  "a type mismatch is refused",
  !mismatch.ok && mismatch.code === "type_mismatch",
  mismatch.ok ? "accepted" : mismatch.code,
);

const selfLink = checkConnection(graph, out(CAD, MASS), inp(CAD, MASS));
check("an app cannot feed itself", !selfLink.ok && selfLink.code === "self");

const duplicate = checkConnection(graph, out(APRO_CAD, MASS), inp(HEX, MASS));
check("a duplicate wire is refused", !duplicate.ok && duplicate.code === "duplicate");

const reversed = checkConnection(graph, out(HEX, MASS), inp(CAD, MASS));
check("output-to-output direction is refused", !reversed.ok);

const missing = checkConnection(graph, out(CAD, "nope/nothing-v1"), inp(HEX, MASS));
check("an unknown port is refused", !missing.ok && missing.code === "missing_port");

// A genuinely new connection is accepted.
const accepted = checkConnection(
  graph,
  out(APRO_CAD, "apro-cad/reference-geometry-si-v1"),
  inp(HEX, "apro-cad/reference-geometry-si-v1"),
);
check("a matching pair on an unwired port is accepted", accepted.ok, accepted.ok ? "" : accepted.reason);

// ---------------------------------------------------------------- cycle refusal
// CAD and HexaDOF both publish and consume the same type, so a wire each way would
// form a loop.
const cycleGraph: WorkflowGraph = {
  ...graph,
  nodes: graph.nodes.map((node) =>
    node.id === HEX
      ? { ...node, ports: buildPorts([MASS], [MASS], [], HEX) }
      : node.id === CAD
        ? { ...node, ports: buildPorts([MASS], [MASS], [], CAD) }
        : node,
  ),
  wires: [
    {
      id: "cad->hex",
      fromNode: CAD,
      fromTypeId: MASS,
      toNode: HEX,
      toTypeId: MASS,
      mode: "tracking",
      applied: false,
    },
  ],
};
const cycle = checkConnection(cycleGraph, out(HEX, MASS), inp(CAD, MASS));
check(
  "a wire that would close a loop is refused",
  !cycle.ok && cycle.code === "cycle",
  cycle.ok ? "accepted" : cycle.code,
);

// ---------------------------------------------------------------- mutation helpers
const wired = addWire(graph, out(CAD, GRAIN), inp(HEX, GRAIN), "tracking");
check("addWire appends an unapplied draft", wired.wires.length === graph.wires.length + 1 && wired.wires.every((w, i) => i < graph.wires.length || w.applied === false));

const withMode = setWireMode(wired, wired.wires[wired.wires.length - 1].id, "pinned");
check(
  "setWireMode updates the wire and re-opens it for apply",
  withMode.wires[withMode.wires.length - 1].mode === "pinned" &&
    withMode.wires[withMode.wires.length - 1].applied === false,
);

const pruned = removeNode(wired, CAD);
check(
  "removing a node removes every wire touching it",
  pruned.nodes.length === graph.nodes.length - 1 &&
    pruned.wires.every((wire) => wire.fromNode !== CAD && wire.toNode !== CAD) &&
    pruned.wires.length === 1,
  `${pruned.wires.length} wires left`,
);

check("removeWire drops exactly one wire", removeWire(graph, graph.wires[0].id).wires.length === 1);

// ---------------------------------------------------------------- port state
const refreshed = refreshPorts(graph, new Map());
const refreshedCad = refreshed.nodes.find((node) => node.id === APRO_CAD);
check(
  "ports reflect which of them are wired",
  refreshedCad?.ports.find((p) => p.typeId === MASS)?.connected === true &&
    refreshedCad?.ports.find((p) => p.typeId === "apro-cad/mesh-export-v1")?.connected === false,
);

// ---------------------------------------------------------------- type registry
check("a registered type has a human label", describeType(MASS).label === "Mass properties");
check(
  "an unregistered type degrades to its name rather than throwing",
  describeType("someone-new/widget-v1").label === "widget v1",
);

// ---------------------------------------------------------------- store projection
// A real `StoreEdge` carries more fields; only these four are used for projection, so
// the structural subset is what the assertion passes.
const projected = mergeStoreEdges(graph, [
  {
    consumer_app: "hexadof",
    type_id: THRUST,
    mode: "tracking",
    stale: true,
  },
]);
const thrustWire = projected.wires.find((wire) => wire.toTypeId === THRUST);
// The producer namespace is "propulsor", which is not on this canvas (the real slug
// has spaces), so the edge is skipped rather than inventing a node.
check(
  "a store edge whose producer is off-canvas is skipped",
  thrustWire === undefined,
  thrustWire ? "it was added" : "",
);

// ---------------------------------------------------------------- saved-graph reconcile
// A graph persisted before a field existed must pick up the new field rather than keep
// a stale shape. This is the bug that made node icons disappear.
const staleGraph: WorkflowGraph = {
  ...graph,
  nodes: graph.nodes.map((node) => ({
    ...node,
    name: "Stale Name",
    installed: false,
    icon: undefined,
  })),
};
const reconciled = reconcileApps(staleGraph, APPS);
const reconciledCad = reconciled.nodes.find((node) => node.id === CAD);
const staleCad = staleGraph.nodes.find((node) => node.id === CAD);

check(
  "a saved graph picks up current names and install state",
  reconciledCad?.name === "Burn & Geometry Modeler" && reconciledCad?.installed === true,
  `name=${reconciledCad?.name} installed=${reconciledCad?.installed}`,
);
check(
  "a saved graph picks up icons added after it was written",
  reconciledCad?.icon === "/assets/icons/geometry.png",
  `icon=${reconciledCad?.icon}`,
);
check(
  "reconciling preserves the user's layout",
  reconciledCad?.position.x === staleCad?.position.x &&
    reconciledCad?.position.y === staleCad?.position.y,
);
check("reconciling preserves wires", reconciled.wires.length === graph.wires.length);
check(
  "a saved graph gains nodes for newly installed apps",
  reconcileApps(
    { ...graph, nodes: graph.nodes.filter((node) => node.id !== APRO_CAD) },
    APPS,
  ).nodes.some((node) => node.id === APRO_CAD),
);
check(
  "a node whose app is no longer in the registry is left alone",
  reconcileApps(
    {
      ...staleGraph,
      nodes: [...staleGraph.nodes, { ...staleGraph.nodes[0], id: "node:gone", appSlug: "gone" }],
    },
    APPS,
  ).nodes.some((node) => node.id === "node:gone" && node.name === "Stale Name"),
);

console.log(
  `\n  ${passed} passed, ${failures.length} failed${failures.length ? ` — ${failures.join(", ")}` : ""}\n`,
);
// Throwing rather than calling process.exit keeps this runnable without @types/node;
// an uncaught error still exits non-zero.
if (failures.length > 0) {
  throw new Error(`${failures.length} workflow check(s) failed`);
}
