/**
 * The workflow canvas.
 *
 * Radically, this is configuration plus a live status view — not a data pipeline.
 * A wire registers a dependency in the orchestration store and makes staleness
 * visible; it does not move bytes. See `src/lib/workflow.ts` for the model.
 */

import { useCallback, useEffect, useMemo, type CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";

import {
  addAppNode,
  addWire,
  checkConnection,
  moveNode,
  removeNode,
  removeWire,
  type AppDescriptor,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowWire,
} from "../../lib/workflow";
import { AppNode, parseHandleId, type AppNodeType } from "./AppNode";

const NODE_TYPES = { app: AppNode };

/**
 * Edge weight marks the exception, not the norm.
 *
 * A stale wire is genuinely worse than a fresh one — the consumer is behind the producer
 * — so it gets the warning colour. Everything else is quiet: a satisfied wire is the
 * normal case and marking every one of them green would leave the canvas mostly green,
 * at which point the colour has stopped carrying information and the eye has to hunt for
 * the one that differs. A locally drawn draft is quieter still, because it has not been
 * written yet and that is not a fault.
 */
const STALE_STROKE = "var(--color-warn)";
const LIVE_STROKE = "var(--color-ink-dim)";
const DRAFT_STROKE = "var(--color-ink-faint)";
const CONNECT_STROKE = "var(--color-accent)";

/**
 * React Flow's chrome defaults to a LIGHT theme: the control buttons paint a near-white
 * surface and their icons are `fill: currentColor`, which is near-white in this app. The
 * result is white icons on white buttons, i.e. apparently missing icons.
 *
 * Theming the `Controls` container is not enough — the per-button custom properties are
 * what the icon colour comes from, so they are set here. React Flow also defaults the
 * canvas to a transparent/white background, so `--xy-background-color` is set explicitly
 * from the token layer.
 */
const CANVAS_THEME = {
  "--xy-background-color": "var(--color-canvas)",
  "--xy-controls-button-background-color": "var(--color-surface)",
  "--xy-controls-button-background-color-hover": "var(--color-raised)",
  "--xy-controls-button-color": "var(--color-ink-dim)",
  "--xy-controls-button-color-hover": "var(--color-ink)",
  "--xy-controls-button-border-color": "var(--color-line)",
  "--xy-controls-box-shadow": "none",
  "--xy-minimap-background-color": "var(--color-surface)",
  "--xy-minimap-mask-background-color": "var(--color-canvas)",
  "--xy-minimap-mask-stroke-color": "var(--color-line)",
  "--xy-minimap-node-background-color": "var(--color-ink-faint)",
  "--xy-minimap-node-stroke-color": "var(--color-line-strong)",
  "--xy-attribution-background-color": "var(--color-surface)",
  "--xy-edge-label-background-color": "var(--color-surface)",
  "--xy-edge-label-color": "var(--color-ink-dim)",
  "--xy-handle-background-color": "var(--color-ink-faint)",
  "--xy-handle-border-color": "var(--color-line-strong)",
  "--xy-selection-background-color": "var(--color-accent-soft)",
  "--xy-selection-border": "1px dotted var(--color-accent)",
} as CSSProperties;

function toRfNode(
  node: WorkflowNode,
  graph: WorkflowGraph,
  onRemove: () => void,
): AppNodeType {
  const touching = graph.wires.filter(
    (wire) => wire.fromNode === node.id || wire.toNode === node.id,
  );
  return {
    id: node.id,
    type: "app",
    position: node.position,
    data: {
      node,
      staleWires: touching.filter((wire) => wire.stale).length,
      wiredCount: touching.length,
      onRemove,
    },
  };
}

function toRfEdge(wire: WorkflowWire): Edge {
  const stale = wire.stale === true;
  const draft = !wire.applied;
  return {
    id: wire.id,
    source: wire.fromNode,
    sourceHandle: `out:${wire.fromTypeId}`,
    target: wire.toNode,
    targetHandle: `in:${wire.toTypeId}`,
    animated: stale,
    label: wire.mode,
    labelShowBg: true,
    labelBgPadding: [5, 2],
    labelBgBorderRadius: 6,
    labelBgStyle: { fill: "var(--color-surface)", stroke: "var(--color-line)" },
    labelStyle: {
      fill: stale ? STALE_STROKE : "var(--color-ink-dim)",
      fontSize: 10,
      letterSpacing: 0.6,
    },
    style: {
      stroke: stale ? STALE_STROKE : draft ? DRAFT_STROKE : LIVE_STROKE,
      strokeWidth: 2,
      strokeDasharray: draft ? "6 4" : undefined,
    },
  };
}

type Props = {
  graph: WorkflowGraph;
  apps: AppDescriptor[];
  onGraphChange: (graph: WorkflowGraph) => void;
  onReject: (reason: string) => void;
};

function CanvasInner({ graph, apps, onGraphChange, onReject }: Props) {
  const { screenToFlowPosition } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNodeType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Project the canonical graph onto the canvas. Existing React Flow node objects are
  // reused so selection and drag state survive; only data and position are refreshed.
  useEffect(() => {
    setNodes((current) => {
      const existing = new Map(current.map((node) => [node.id, node]));
      return graph.nodes.map((node) => {
        const fresh = toRfNode(node, graph, () =>
          onGraphChange(removeNode(graph, node.id)),
        );
        const prior = existing.get(node.id);
        return prior
          ? { ...prior, data: fresh.data, position: node.position }
          : fresh;
      });
    });
    setEdges(graph.wires.map(toRfEdge));
  }, [graph, setNodes, setEdges, onGraphChange]);

  const handleConnect = useCallback(
    (connection: Connection) => {
      const from = parseHandleId(connection.sourceHandle);
      const to = parseHandleId(connection.targetHandle);
      if (!from || !to || !connection.source || !connection.target) return;

      const check = checkConnection(
        graph,
        { nodeId: connection.source, typeId: from.typeId, direction: "out" },
        { nodeId: connection.target, typeId: to.typeId, direction: "in" },
      );
      if (!check.ok) {
        onReject(check.reason);
        return;
      }

      onGraphChange(
        addWire(
          graph,
          { nodeId: connection.source, typeId: from.typeId, direction: "out" },
          { nodeId: connection.target, typeId: to.typeId, direction: "in" },
          // Design-time default. Pinned never goes stale, which would make the
          // canvas look broken; recorded results switch to pinned explicitly.
          "tracking",
        ),
      );
    },
    [graph, onGraphChange, onReject],
  );

  const handleNodeDragStop = useCallback(
    (_event: unknown, node: AppNodeType) => {
      onGraphChange(moveNode(graph, node.id, node.position));
    },
    [graph, onGraphChange],
  );

  const handleNodesDelete = useCallback(
    (deleted: AppNodeType[]) => {
      let next = graph;
      for (const node of deleted) next = removeNode(next, node.id);
      onGraphChange(next);
    },
    [graph, onGraphChange],
  );

  const handleEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      let next = graph;
      for (const edge of deleted) next = removeWire(next, edge.id);
      onGraphChange(next);
    },
    [graph, onGraphChange],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const slug = event.dataTransfer.getData("application/apro-app");
      if (!slug) return;
      const app = apps.find((candidate) => candidate.slug === slug);
      if (!app) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      onGraphChange(addAppNode(graph, app, position));
    },
    [apps, graph, onGraphChange, screenToFlowPosition],
  );

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const nodeTypes = useMemo(() => NODE_TYPES, []);

  return (
    <div className="h-full w-full" onDrop={handleDrop} onDragOver={handleDragOver}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange as (changes: NodeChange<AppNodeType>[]) => void}
        onEdgesChange={onEdgesChange as (changes: EdgeChange<Edge>[]) => void}
        onConnect={handleConnect}
        onNodeDragStop={handleNodeDragStop}
        onNodesDelete={handleNodesDelete}
        onEdgesDelete={handleEdgesDelete}
        fitView
        fitViewOptions={{ padding: 0.28, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={1.6}
        proOptions={{ hideAttribution: false }}
        connectionLineStyle={{ stroke: CONNECT_STROKE, strokeWidth: 2 }}
        defaultEdgeOptions={{ style: { stroke: LIVE_STROKE, strokeWidth: 2 } }}
        deleteKeyCode={["Backspace", "Delete"]}
        style={CANVAS_THEME}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1}
          color="var(--color-line-strong)"
        />
        <Controls
          showInteractive={false}
          className="!rounded-md !border !border-line-strong !bg-surface !shadow-none"
        />
        <MiniMap
          pannable
          zoomable
          className="!rounded-md !border !border-line-strong !bg-surface"
          maskColor="color-mix(in srgb, var(--color-canvas) 72%, transparent)"
          nodeColor="var(--color-ink-faint)"
        />
      </ReactFlow>
    </div>
  );
}

export function WorkflowCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
