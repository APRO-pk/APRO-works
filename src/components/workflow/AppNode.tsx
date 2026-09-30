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
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          connected ? "bg-[rgba(128,154,255,0.95)]" : "bg-white/22"
        }`}
      />
      <span
        className={`truncate text-[11px] leading-none ${
          connected ? "text-white/78" : "text-white/48"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

export function AppNode({ data, selected }: NodeProps<AppNodeType>) {
  const { node, staleWires, wiredCount } = data;
  const inputs = node.ports.filter((port) => port.direction === "in");
  const outputs = node.ports.filter((port) => port.direction === "out");
  const namespaceOk = isValidNamespace(node.appSlug);
  const isStale = staleWires > 0;

  return (
    <div
      className={`panel-raised w-[272px] select-none rounded-2xl transition ${
        selected ? "ring-1 ring-[rgba(128,154,255,0.55)]" : ""
      }`}
      style={
        isStale
          ? { boxShadow: "0 0 0 1px rgba(255,183,94,0.42), 0 16px 28px rgba(0,0,0,0.28)" }
          : undefined
      }
    >
      {/* header */}
      <div
        className="flex items-center gap-2.5 rounded-t-2xl border-b border-white/6 px-3"
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
          <div className="truncate text-[12.5px] font-medium leading-tight text-white/92">
            {node.name}
          </div>
          <div className="truncate text-[10px] leading-tight text-white/40">{node.appSlug}</div>
        </div>
        {isStale ? (
          <span
            className="shrink-0 rounded-full bg-[rgba(255,183,94,0.16)] px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-[rgba(255,201,133,0.95)]"
            title={`${staleWires} connection(s) out of date`}
          >
            STALE
          </span>
        ) : null}
      </div>

      {/* ports */}
      <div className="grid grid-cols-2 gap-x-3 px-3 pb-3" style={{ paddingTop: PAD_TOP }}>
        <div>
          <div
            className="flex items-center text-[9px] uppercase tracking-[0.14em] text-white/28"
            style={{ height: LABEL_H }}
          >
            in
          </div>
          {inputs.length === 0 ? (
            <div className="text-[10px] italic text-white/24">none</div>
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
          <div
            className="flex items-center justify-end text-[9px] uppercase tracking-[0.14em] text-white/28"
            style={{ height: LABEL_H }}
          >
            out
          </div>
          {outputs.length === 0 ? (
            <div className="text-[10px] italic text-white/24">none</div>
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
      <div className="flex items-center gap-1.5 border-t border-white/5 px-3 py-1.5 text-[9.5px] text-white/34">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            node.installed ? "bg-[rgba(122,226,168,0.95)]" : "bg-white/25"
          }`}
        />
        <span>{node.installed ? "installed" : "not installed"}</span>
        <span className="text-white/20">·</span>
        <span>
          {wiredCount} connection{wiredCount === 1 ? "" : "s"}
        </span>
        {!namespaceOk ? (
          <span
            className="ml-auto text-[rgba(255,160,160,0.9)]"
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
          className={port.connected ? "!bg-[rgba(128,154,255,0.95)]" : undefined}
        />
      ))}
      {outputs.map((port, index) => (
        <Handle
          key={`out:${port.typeId}`}
          id={`out:${port.typeId}`}
          type="source"
          position={Position.Right}
          style={{ top: rowTop(index) }}
          className={port.connected ? "!bg-[rgba(128,154,255,0.95)]" : undefined}
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
