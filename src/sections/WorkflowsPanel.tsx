/**
 * Workflows — the software block graph.
 *
 * A wire the user draws is a *subscription*: a type-level statement that one app's kind
 * of output feeds another app's kind of input. The store materialises concrete per-instance
 * edges from it, so `Apply` is a real write and `Remove` un-wires durably.
 *
 * The section's buttons (Sync, Console, Reset) live in the section header, which is why
 * this panel takes `syncToken` / `resetToken` / `consoleOpen` as props.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ActivityConsole } from "../components/ActivityConsole";
import { WorkflowCanvas } from "../components/workflow/WorkflowCanvas";
import {
  clearWorkflow,
  defaultWorkflow,
  describeType,
  loadWorkflow,
  markApplied,
  nodeApp,
  reconcileApps,
  refreshPorts,
  removeWire,
  saveWorkflow,
  setWireMode,
  type AppDescriptor,
  type WorkflowGraph,
  type WorkflowWire,
  type WireMode,
} from "../lib/workflow";
import {
  createStoreSubscription,
  deleteStoreSubscription,
  fetchStoreEdges,
  fetchStoreInterfaces,
  fetchStoreSubscriptions,
  interfaceMap,
  materializeStoreSubscriptions,
  mergeStoreEdges,
  type StoreSubscription,
} from "../lib/platform-data";

const MODES: WireMode[] = ["pinned", "tracking", "compatible"];

const MODE_HINT: Record<WireMode, string> = {
  pinned: "Freezes each instance where it is now. Never goes stale — use for recorded results.",
  tracking: "Follows the producer's latest revision and goes stale when it changes.",
  compatible: "Satisfied by any revision at or above a floor.",
};

type Props = {
  apps: AppDescriptor[];
  /** Bumped by the header's Sync button to re-read the store. */
  syncToken: number;
  /** Bumped by the header's Reset button to rebuild the default template. */
  resetToken: number;
  consoleOpen: boolean;
  onConsoleClose: () => void;
  className?: string;
};

function AppIcon({ app, size = 26 }: { app: AppDescriptor; size?: number }) {
  if (app.icon) {
    return (
      <img
        src={app.icon}
        alt=""
        draggable={false}
        className="shrink-0 rounded-lg object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-lg bg-white/8 text-[9px] font-semibold uppercase text-white/50"
      style={{ width: size, height: size }}
    >
      {app.name.replace(/[^A-Za-z]/g, "").slice(0, 2)}
    </span>
  );
}

export function WorkflowsPanel({
  apps,
  syncToken,
  resetToken,
  consoleOpen,
  onConsoleClose,
  className = "",
}: Props) {
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);
  const [subscriptions, setSubscriptions] = useState<StoreSubscription[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<"live" | "demo">("live");
  const [dataError, setDataError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const appKey = apps.map((app) => `${app.slug}:${app.installed ? 1 : 0}`).join("|");
  const graphReady = graph !== null;

  // Seed once the app list is known. A previously saved graph is reconciled against the
  // current registry so names, install state and icons are never stale.
  useEffect(() => {
    if (graph || apps.length === 0) return;
    setGraph(reconcileApps(loadWorkflow(defaultWorkflow(apps)), apps));
  }, [apps, graph]);

  useEffect(() => {
    if (graph) saveWorkflow(graph);
  }, [graph]);

  // Project the store onto the canvas.
  useEffect(() => {
    if (!graphReady) return;
    let cancelled = false;
    void (async () => {
      const [edges, interfaces, subs] = await Promise.all([
        fetchStoreEdges(),
        fetchStoreInterfaces(),
        fetchStoreSubscriptions(),
      ]);
      if (cancelled) return;

      const declared = interfaceMap(interfaces.data);
      setSubscriptions(subs.data);
      setGraph((current) => {
        if (!current) return current;
        const withPorts = refreshPorts(current, declared.size > 0 ? declared : new Map());
        // Edges carry freshness; subscriptions are the authoritative "applied" flag.
        return markApplied(mergeStoreEdges(withPorts, edges.data), subs.data);
      });
      setDataSource(edges.source);
      setDataError(edges.error);
    })();
    return () => {
      cancelled = true;
    };
    // `graph` itself is intentionally omitted: this projects store state and must not
    // re-run on every local edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphReady, appKey, syncToken, reloadToken]);

  // Reset to the default template when the header asks.
  const lastReset = useRef(resetToken);
  useEffect(() => {
    if (resetToken === lastReset.current) return;
    lastReset.current = resetToken;
    clearWorkflow();
    setGraph(defaultWorkflow(apps));
    setToast("Workflow reset to the default template.");
  }, [resetToken, apps]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const handleReject = useCallback((reason: string) => setToast(reason), []);

  const drafts = useMemo(
    () => (graph ? graph.wires.filter((wire) => !wire.applied) : []),
    [graph],
  );

  const nodeName = useCallback(
    (nodeId: string) => graph?.nodes.find((node) => node.id === nodeId)?.name ?? nodeId,
    [graph],
  );

  const subscriptionFor = useCallback(
    (wire: WorkflowWire) =>
      subscriptions.find(
        (entry) => entry.consumer_app === nodeApp(wire.toNode) && entry.type_id === wire.toTypeId,
      ),
    [subscriptions],
  );

  /** Write every drawn-but-unapplied wire, then back-fill edges. */
  const handleApply = useCallback(async () => {
    if (drafts.length === 0) return;
    setBusy(true);
    let applied = 0;
    const failures: string[] = [];

    for (const wire of drafts) {
      try {
        await createStoreSubscription(nodeApp(wire.toNode), wire.toTypeId, wire.mode);
        applied += 1;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (applied > 0) {
      try {
        await materializeStoreSubscriptions();
      } catch {
        // The subscription itself is the durable record; a failed back-fill just means
        // existing instances are picked up on the next Sync.
      }
    }

    setBusy(false);
    setReloadToken((token) => token + 1);
    setToast(
      failures.length > 0
        ? `Applied ${applied}, ${failures.length} failed: ${failures[0]}`
        : `Applied ${applied} connection${applied === 1 ? "" : "s"}.`,
    );
  }, [drafts]);

  const handleRemove = useCallback(
    async (wire: WorkflowWire) => {
      const existing = subscriptionFor(wire);
      setGraph((current) => (current ? removeWire(current, wire.id) : current));

      if (!existing) return;

      setBusy(true);
      try {
        const removed = await deleteStoreSubscription(existing.subscription_id);
        setToast(`Un-wired — ${removed} edge${removed === 1 ? "" : "s"} removed.`);
      } catch (error) {
        setToast(error instanceof Error ? error.message : String(error));
      }
      setBusy(false);
      setReloadToken((token) => token + 1);
    },
    [subscriptionFor],
  );

  if (!graph) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <span className="text-[12px] text-white/40">Preparing workflow…</span>
      </div>
    );
  }

  return (
    <div className={`relative flex min-h-0 flex-col gap-3 ${className}`}>
      {dataSource === "demo" ? (
        <div className="rounded-xl border border-[rgba(255,183,94,0.22)] bg-[rgba(255,183,94,0.08)] px-4 py-2 text-[11px] text-[rgba(255,205,140,0.92)]">
          Showing <strong className="font-semibold">sample data</strong> — the orchestration store
          is not reachable{dataError ? ` (${dataError})` : ""}. Wiring is disabled.
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-3">
        {/* palette */}
        <aside className="panel-soft flex w-[182px] shrink-0 flex-col rounded-2xl p-2.5">
          <div className="px-1 pb-2 text-[9px] uppercase tracking-[0.18em] text-white/32">
            Software blocks
          </div>
          <div className="flex flex-col gap-1.5 overflow-y-auto">
            {apps.map((app) => {
              const onCanvas = graph.nodes.some((node) => node.appSlug === app.slug);
              return (
                <button
                  key={app.slug}
                  type="button"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData("application/apro-app", app.slug);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  title={app.name}
                  className={`panel-raised flex cursor-grab items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition active:cursor-grabbing ${
                    onCanvas ? "opacity-45" : "hover:brightness-110"
                  }`}
                >
                  <AppIcon app={app} />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-white/84">
                    {app.name}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* canvas */}
        <div className="panel-inset min-w-0 flex-1 overflow-hidden rounded-2xl">
          <WorkflowCanvas
            graph={graph}
            apps={apps}
            onGraphChange={setGraph}
            onReject={handleReject}
          />
        </div>

        {/* connections */}
        <aside className="panel-soft flex w-[268px] shrink-0 flex-col rounded-2xl">
          <div className="flex items-center gap-2 border-b border-white/6 px-3 py-2">
            <span className="text-[9px] uppercase tracking-[0.18em] text-white/32">Connections</span>
            <div className="ml-auto flex items-center gap-1.5">
              {drafts.length > 0 ? (
                <>
                  <span className="rounded-md bg-white/8 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-white/44">
                    {drafts.length} draft
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleApply()}
                    disabled={busy}
                    className="rounded-lg bg-[rgba(128,154,255,0.2)] px-2 py-0.5 text-[10px] font-medium text-white/92 transition hover:bg-[rgba(128,154,255,0.3)] disabled:opacity-50"
                  >
                    {busy ? "…" : "Apply"}
                  </button>
                </>
              ) : (
                <span className="text-[9px] uppercase tracking-wider text-[rgba(150,235,190,0.7)]">
                  saved
                </span>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
            {graph.wires.length === 0 ? (
              <div className="px-1 py-4 text-[11px] text-white/36">No connections yet.</div>
            ) : (
              <ul className="flex flex-col gap-2">
                {graph.wires.map((wire) => (
                  <ConnectionRow
                    key={wire.id}
                    wire={wire}
                    fromName={nodeName(wire.fromNode)}
                    toName={nodeName(wire.toNode)}
                    edgeCount={subscriptionFor(wire)?.edge_count}
                    onMode={(mode) => setGraph(setWireMode(graph, wire.id, mode))}
                    onRemove={() => void handleRemove(wire)}
                  />
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      {toast ? (
        <div className="panel-raised pointer-events-none absolute bottom-4 left-1/2 z-20 max-w-[520px] -translate-x-1/2 rounded-xl px-4 py-2.5 text-[11.5px] text-white/86 shadow-2xl">
          {toast}
        </div>
      ) : null}

      <ActivityConsole open={consoleOpen} onClose={onConsoleClose} refreshToken={syncToken} />
    </div>
  );
}

function ConnectionRow({
  wire,
  fromName,
  toName,
  edgeCount,
  onMode,
  onRemove,
}: {
  wire: WorkflowWire;
  fromName: string;
  toName: string;
  edgeCount?: number;
  onMode: (mode: WireMode) => void;
  onRemove: () => void;
}) {
  const type = describeType(wire.toTypeId);
  const state = wire.stale ? "stale" : wire.applied ? "live" : "draft";

  return (
    <li className="panel-inset rounded-xl px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <span className="truncate text-[11px] text-white/82">{fromName}</span>
        <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0 text-white/30" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
        <span className="truncate text-[11px] text-white/82">{toName}</span>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove connection"
          title={wire.applied ? "Un-wire: removes the subscription and its edges" : "Discard this draft"}
          className="ml-auto shrink-0 rounded-md p-0.5 text-white/28 transition hover:text-[rgba(255,160,160,0.95)]"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.9">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      <div className="mt-1 truncate text-[10px] text-white/40" title={wire.toTypeId}>
        {type.label}
        {wire.applied && edgeCount !== undefined
          ? ` · ${edgeCount} instance${edgeCount === 1 ? "" : "s"}`
          : ""}
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        <select
          value={wire.mode}
          onChange={(event) => onMode(event.target.value as WireMode)}
          title={MODE_HINT[wire.mode]}
          disabled={wire.applied}
          className="rounded-md border border-white/8 bg-[rgba(12,16,24,0.9)] px-1.5 py-0.5 text-[10px] text-white/72 outline-none disabled:opacity-50"
        >
          {MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
        <span
          className={`rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
            state === "stale"
              ? "bg-[rgba(255,183,94,0.16)] text-[rgba(255,205,140,0.95)]"
              : state === "live"
                ? "bg-[rgba(122,226,168,0.14)] text-[rgba(150,235,190,0.95)]"
                : "bg-white/8 text-white/44"
          }`}
          title={
            state === "stale"
              ? "The consumer is behind the producer."
              : state === "live"
                ? "Registered in the orchestration store."
                : "Drawn locally; press Apply to write it."
          }
        >
          {state}
        </span>
      </div>
    </li>
  );
}
