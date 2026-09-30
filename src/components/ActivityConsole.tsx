/**
 * The orchestration console: what the platform is actually doing.
 *
 * Two sources, deliberately kept apart in the store:
 *
 * * the change feed (`event`) — pushes, graph changes, purges
 * * the read log (`access_log`) — pulls, including misses
 *
 * They are merged into one timeline here, but they remain separate sequences so an
 * app polling the change feed is never disturbed by other apps' reads.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  eventDirection,
  fetchStoreAccess,
  fetchStoreEvents,
  fetchStoreStatus,
  formatBytes,
  formatClock,
  formatRelative,
  type StoreEvent,
  type StoreStatus,
} from "../lib/platform-data";

const POLL_MS = 2500;
const HISTORY = 300;

type Filter = "all" | "push" | "pull" | "graph";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "push", label: "Pushes" },
  { id: "pull", label: "Pulls" },
  { id: "graph", label: "Graph" },
];

/** One row of the merged timeline. */
type FeedItem = {
  key: string;
  direction: "push" | "pull" | "graph";
  badge: string;
  badgeClass: string;
  title: string;
  detail: string;
  seq: number;
  createdAt: number;
};

const PUSH_CLASS = "bg-[rgba(128,154,255,0.16)] text-[rgba(170,190,255,0.95)]";
const PULL_CLASS = "bg-[rgba(122,226,168,0.14)] text-[rgba(150,235,190,0.95)]";
const GRAPH_CLASS = "bg-[rgba(255,183,94,0.14)] text-[rgba(255,205,140,0.95)]";
const MISS_CLASS = "bg-[rgba(255,255,255,0.08)] text-white/55";

function eventItem(event: StoreEvent): FeedItem {
  const direction = eventDirection(event.kind);
  let badge = event.kind.split(".")[0] ?? "event";
  let badgeClass = GRAPH_CLASS;

  if (event.kind === "revision.published") {
    badge = "push";
    badgeClass = PUSH_CLASS;
  } else if (event.kind === "artifact.created") {
    badge = "new";
    badgeClass = PUSH_CLASS;
  } else if (event.kind === "demo.purged") {
    badge = "purge";
    badgeClass = "bg-[rgba(255,140,140,0.14)] text-[rgba(255,175,175,0.95)]";
  }

  return {
    key: `e:${event.seq}`,
    direction,
    badge,
    badgeClass,
    title: event.summary ?? event.kind,
    detail: `${event.actor_app ? `${event.actor_app} · ` : ""}${event.type_id ?? "—"}`,
    seq: event.seq,
    createdAt: event.created_at,
  };
}

type AccessRow = Awaited<ReturnType<typeof fetchStoreAccess>>["data"][number];

function accessItem(entry: AccessRow): FeedItem {
  const hit = entry.outcome === "hit";
  return {
    key: `a:${entry.seq}`,
    direction: "pull",
    badge: hit ? "pull" : "miss",
    badgeClass: hit ? PULL_CLASS : MISS_CLASS,
    title: hit
      ? `${entry.actor_app} pulled revision ${entry.revision_number ?? "?"} of ${entry.instance}`
      : `${entry.actor_app} asked for ${entry.instance}, which has no revision yet`,
    detail: entry.type_id,
    seq: entry.seq,
    createdAt: entry.created_at,
  };
}

type Props = {
  open: boolean;
  onClose: () => void;
  /** Bumped by the parent to force a reload, e.g. after a wire changes. */
  refreshToken?: number;
};

export function ActivityConsole({ open, onClose, refreshToken = 0 }: Props) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [status, setStatus] = useState<StoreStatus | null>(null);
  const [source, setSource] = useState<"live" | "demo">("live");
  const [error, setError] = useState<string | undefined>(undefined);
  const [connected, setConnected] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(false);
  const eventSince = useRef(0);
  const accessSince = useRef(0);

  const merge = useCallback((incoming: FeedItem[]) => {
    setItems((current) => {
      if (incoming.length === 0) return current;
      const byKey = new Map(current.map((item) => [item.key, item]));
      for (const item of incoming) byKey.set(item.key, item);
      return [...byKey.values()]
        .sort((a, b) => b.createdAt - a.createdAt || b.key.localeCompare(a.key))
        .slice(0, HISTORY);
    });
  }, []);

  const load = useCallback(
    async (initial: boolean) => {
      if (initial) setLoading(true);

      const statusResult = await fetchStoreStatus();
      setStatus(statusResult.data);

      const statusCursor = statusResult.data?.cursor ?? 0;
      const accessCursor = statusResult.data?.access_cursor ?? 0;
      const sinceEvent = initial ? Math.max(0, statusCursor - HISTORY) : eventSince.current;
      const sinceAccess = initial ? Math.max(0, accessCursor - HISTORY) : accessSince.current;

      const [events, access] = await Promise.all([
        fetchStoreEvents(sinceEvent, HISTORY),
        fetchStoreAccess(sinceAccess, HISTORY),
      ]);

      if (initial) {
        setItems([]);
        eventSince.current = statusCursor;
        accessSince.current = accessCursor;
        setSource(events.source);
        setError(events.error ?? statusResult.error);
        setConnected(events.source === "live");
      } else if (events.source === "live") {
        setConnected(true);
      }

      merge([...events.data.map(eventItem), ...access.data.map(accessItem)]);

      eventSince.current = events.data.reduce(
        (max, event) => Math.max(max, event.seq),
        eventSince.current,
      );
      accessSince.current = access.data.reduce(
        (max, entry) => Math.max(max, entry.seq),
        accessSince.current,
      );

      if (initial) setLoading(false);
    },
    [merge],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await load(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, refreshToken, load]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => void load(false), POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const counts = useMemo(() => {
    const tally = { push: 0, pull: 0, graph: 0, all: items.length };
    for (const item of items) tally[item.direction] += 1;
    return tally;
  }, [items]);

  const visible = useMemo(
    () => (filter === "all" ? items : items.filter((item) => item.direction === filter)),
    [items, filter],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" role="dialog" aria-modal="true" aria-label="Orchestration console">
      <button
        type="button"
        aria-label="Close console"
        className="absolute inset-0 cursor-default bg-black/58 backdrop-blur-[3px]"
        onClick={onClose}
      />
      <div className="panel-shell relative flex h-full max-h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl">
        <div className="flex items-center gap-3 border-b border-white/7 px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-[0.22em] text-white/38">Orchestration</div>
            <h2 className="truncate text-[17px] font-medium text-white/94">Activity console</h2>
          </div>

          <span
            className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium tracking-wide ${
              source === "live"
                ? "bg-[rgba(122,226,168,0.14)] text-[rgba(150,235,190,0.95)]"
                : "bg-[rgba(255,183,94,0.14)] text-[rgba(255,205,140,0.95)]"
            }`}
            title={source === "live" ? "Reading the live store" : error ?? "Store unavailable"}
          >
            {source === "live" ? (connected ? "live" : "connecting") : "sample data"}
          </span>

          <button
            type="button"
            onClick={() => void load(false)}
            className="panel-soft shrink-0 rounded-xl px-3 py-1.5 text-[11px] text-white/72 transition hover:text-white"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="panel-soft flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-white/60 transition hover:text-white"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-white/6 px-5 py-2.5 text-[11px] text-white/52">
          <span>
            <span className="text-white/34">artifacts</span> {status?.artifacts ?? "—"}
          </span>
          <span>
            <span className="text-white/34">revisions</span> {status?.revisions ?? "—"}
          </span>
          <span>
            <span className="text-white/34">edges</span> {status?.edges ?? "—"}
          </span>
          <span className={status && status.stale_edges > 0 ? "text-[rgba(255,205,140,0.95)]" : ""}>
            <span className="text-white/34">stale</span> {status?.stale_edges ?? "—"}
          </span>
          <span>
            <span className="text-white/34">blobs</span>{" "}
            {status ? `${status.blob_count} (${formatBytes(status.blob_bytes)})` : "—"}
          </span>
          <span className="ml-auto truncate">
            <span className="text-white/34">cursors</span> {status?.cursor ?? "—"} / {status?.access_cursor ?? "—"}
          </span>
        </div>

        <div className="flex items-center gap-1.5 border-b border-white/6 px-5 py-2.5">
          {FILTERS.map((entry) => {
            const active = filter === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setFilter(entry.id)}
                className={`rounded-lg px-2.5 py-1 text-[11px] transition ${
                  active ? "bg-[rgba(128,154,255,0.18)] text-white/92" : "text-white/48 hover:text-white/78"
                }`}
              >
                {entry.label}
                <span className="ml-1.5 tabular-nums text-white/34">{counts[entry.id]}</span>
              </button>
            );
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {loading ? (
            <div className="px-2 py-6 text-center text-[12px] text-white/40">Loading events…</div>
          ) : visible.length === 0 ? (
            <div className="px-2 py-6 text-center text-[12px] text-white/40">
              {filter === "pull"
                ? "No pulls recorded yet. Reads are logged separately from the change feed."
                : "Nothing yet. Publish something from an app and it will show up here."}
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {visible.map((item) => (
                <li
                  key={item.key}
                  className="flex items-start gap-3 rounded-lg px-2 py-2 transition hover:bg-white/[0.035]"
                >
                  <span className="w-11 shrink-0 pt-0.5 text-right font-mono text-[10px] tabular-nums text-white/28">
                    {item.seq}
                  </span>
                  <span
                    className={`mt-0.5 w-14 shrink-0 rounded-md px-1.5 py-0.5 text-center text-[9px] font-semibold uppercase tracking-wider ${item.badgeClass}`}
                  >
                    {item.badge}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] text-white/82">{item.title}</div>
                    <div className="truncate text-[10.5px] text-white/34">{item.detail}</div>
                  </div>
                  <span
                    className="shrink-0 pt-0.5 text-right text-[10px] text-white/30"
                    title={formatClock(item.createdAt)}
                  >
                    {formatRelative(item.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-white/6 px-5 py-2.5 text-[10.5px] text-white/34">
          {source === "live"
            ? "Pushes come from the change feed; pulls from the read log. They are separate sequences so an app polling for changes is never disturbed by other apps' reads."
            : `Store not reachable${error ? ` — ${error}` : ""}. Showing sample data so the shape of the feed is visible.`}
        </div>
      </div>
    </div>
  );
}
