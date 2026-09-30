/**
 * A software block on the workflow canvas.
 *
 * Outputs are on the right, inputs on the left, and handles are laid out at fixed row
 * offsets so the geometry is deterministic — React Flow positions handles absolutely
 * relative to the node, so the layout constants below are the contract between this
 * component and the connector anchors.
 */

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import { describeType, isValidNamespace, type WorkflowNode } from "../../lib/workflow";

export const HEADER_H = 46;
export const PAD_TOP = 8;
/**
 * Height of the `in` / `out` column captions.
 *
 * This must be a fixed height, not text-sized: handles are positioned from these
 * constants, so a caption that grows with its font would offset every port below it.
 */
export const LABEL_H = 16;
export const ROW_H = 28;

function rowTop(index: number): number {
  return HEADER_H + PAD_TOP + LABEL_H + index * ROW_H + ROW_H / 2;
}

export type AppNodeData = {
  node: WorkflowNode;
  /** Number of wires touching this node that are out of date. */
  staleWires: number;
  /** Total wires touching this node. */
  wiredCount: number;
  /**
   * Take this block off the canvas.
   *
   * Optional so the node still renders if it is ever mounted outside the canvas. The
   * handler also removes every wire touching the node, so removing a block cannot
   * leave a connection pointing at nothing.
   */
  onRemove?: () => void;
};

export type AppNodeType = Node<AppNodeData, "app">;

function PortRow({
  label,
  typeId,
  connected,
}: {
  label: string;
  typeId: string;
  connected: boolean;
}) {
  return (
    <div
      className="flex h-7 items-center gap-1.5 overflow-hidden"
      style={{ height: ROW_H }}
      title={`${label} — ${typeId}\n${describeType(typeId).description}`}
    >
      {/* A port that has a wire is an active state, so it takes the accent. A port with
          no wire is neutral, not wrong. */}
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          connected ? "bg-accent" : "bg-ink-faint"
        }`}
      />
      <span
        className={`truncate text-[11px] leading-none ${
          connected ? "text-ink" : "text-ink-dim"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

export function AppNode({ data, selected }: NodeProps<AppNodeType>) {
  const { node, staleWires, wiredCount, onRemove } = data;
  const inputs = node.ports.filter((port) => port.direction === "in");
  const outputs = node.ports.filter((port) => port.direction === "out");
  const namespaceOk = isValidNamespace(node.appSlug);
  const isStale = staleWires > 0;

  return (
    <div
      className={`card w-[272px] select-none rounded-lg transition ${
        selected ? "ring-1 ring-accent" : isStale ? "ring-1 ring-warn" : ""
      }`}
    >
      {/* header */}
      <div
        className="flex items-center gap-2.5 border-b border-line px-3"
        style={{ height: HEADER_H }}
      >
        {node.icon ? (
          <img
            src={node.icon}
            alt=""
            draggable={false}
            className="h-6 w-6 shrink-0 rounded-md object-cover"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium leading-tight text-ink">
            {node.name}
          </div>
          <div className="truncate text-[10px] leading-tight text-ink-faint">{node.appSlug}</div>
        </div>
        {/* Stale wires are the one genuinely worse state a node can be in: fewer is good. */}
        {isStale ? (
          <span className="pill pill-stale shrink-0" title={`${staleWires} connection(s) out of date`}>
            STALE
          </span>
        ) : null}

        {onRemove ? (
          /* `nodrag` stops React Flow treating the press as the start of a node drag,
             and the propagation stops are the belt to that braces — without them the
             node moves under the cursor and the click never lands. */
          <button
            type="button"
            className="nodrag icon-btn icon-btn-danger shrink-0"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
            aria-label={`Remove ${node.name} from the workflow`}
            title="Remove this block and its connections"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        ) : null}
      </div>

      {/* ports */}
      <div className="grid grid-cols-2 gap-x-3 px-3 pb-3" style={{ paddingTop: PAD_TOP }}>
        <div>
          <div className="label flex items-center" style={{ height: LABEL_H }}>
            in
          </div>
          {inputs.length === 0 ? (
            <div className="text-[10px] italic text-ink-faint">none</div>
          ) : (
            inputs.map((port) => (
              <PortRow
                key={port.typeId}
                label={port.label}
                typeId={port.typeId}
                connected={port.connected}
              />
            ))
          )}
        </div>
        <div className="text-right">
          <div className="label flex items-center justify-end" style={{ height: LABEL_H }}>
            out
          </div>
          {outputs.length === 0 ? (
            <div className="text-[10px] italic text-ink-faint">none</div>
          ) : (
            outputs.map((port) => (
              <div key={port.typeId} className="flex justify-end">
                <PortRow
                  label={port.label}
                  typeId={port.typeId}
                  connected={port.connected}
                />
              </div>
            ))
          )}
        </div>
      </div>

      {/* footer */}
      <div className="flex items-center gap-1.5 border-t border-line px-3 py-1.5 text-[10px] text-ink-faint">
        {/* Installed or not is a state, not a verdict, so the dot carries no status
            colour. A count of connections is likewise neutral. */}
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            node.installed ? "bg-ink-dim" : "bg-ink-faint"
          }`}
        />
        <span>{node.installed ? "installed" : "not installed"}</span>
        <span className="text-ink-faint">·</span>
        <span>
          {wiredCount} connection{wiredCount === 1 ? "" : "s"}
        </span>
        {/* A slug that cannot namespace a type is a real defect: it blocks publishing. */}
        {!namespaceOk ? (
          <span
            className="ml-auto text-bad"
            title={`"${node.appSlug}" is not kebab-case, so it cannot namespace an artifact type. Normalise the product slug before this app publishes anything.`}
          >
            invalid slug
          </span>
        ) : null}
      </div>

      {/* Handles: direct children of the node, at deterministic row offsets. */}
      {inputs.map((port, index) => (
        <Handle
          key={`in:${port.typeId}`}
          id={`in:${port.typeId}`}
          type="target"
          position={Position.Left}
          style={{ top: rowTop(index) }}
          className={port.connected ? "!border-accent !bg-accent" : "!border-line-strong !bg-ink-faint"}
        />
      ))}
      {outputs.map((port, index) => (
        <Handle
          key={`out:${port.typeId}`}
          id={`out:${port.typeId}`}
          type="source"
          position={Position.Right}
          style={{ top: rowTop(index) }}
          className={port.connected ? "!border-accent !bg-accent" : "!border-line-strong !bg-ink-faint"}
        />
      ))}
    </div>
  );
}

/**
 * Parse a React Flow handle id back into the node-relative port identity.
 * Handle ids are `in:<typeId>` / `out:<typeId>`.
 */
export function parseHandleId(handleId: string | null | undefined): {
  direction: "in" | "out";
  typeId: string;
} | null {
  if (!handleId) return null;
  const separator = handleId.indexOf(":");
  if (separator < 0) return null;
  const direction = handleId.slice(0, separator);
  const typeId = handleId.slice(separator + 1);
  if (direction !== "in" && direction !== "out") return null;
  return { direction, typeId };
}
