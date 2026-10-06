/**
 * Loading the workspace directory, once, for whoever needs it.
 *
 * The sidebar shows workspace names, the homescreen shows workspace cards, and
 * the workspace view shows a roster. All three are views of the same read, and
 * doing it in each place would mean the sidebar and the panel could disagree
 * about what exists — or, worse, that opening a workspace issued the same three
 * queries twice.
 *
 * So this loads them once and hands the result down.
 *
 * ## Why it refreshes on focus instead of subscribing to Realtime
 *
 * Only two tables in this schema are published to `supabase_realtime`:
 * `workspace_project_live_state` and `works_projects` — the project data, which
 * this panel does not show. The tables it *does* show, `shared_workspaces` and
 * `workspace_invitations`, are not published, and adding them would be the wrong
 * fix: row-level security on `postgres_changes` is only enforced for private
 * channels, so a public subscription to `shared_workspaces` would broadcast
 * every workspace's existence to every signed-in client.
 *
 * Refreshing when the window regains focus is the honest alternative. For a
 * desktop app it is close enough to live — the thing that changes while you are
 * looking elsewhere is an invitation, and you will look back at some point — and
 * it cannot leak.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  listInvitations,
  listWorkspaces,
  type Invitation,
  type Workspace,
} from "./workspaces";

export type WorkspaceDirectory = {
  /** Workspaces that exist right now. */
  workspaces: Workspace[];
  /** Soft-deleted workspaces, restorable for seven days. */
  archived: Workspace[];
  /** Pending invitations addressed to the signed-in user. */
  invitations: Invitation[];
  loading: boolean;
  /** The last failure, or null. Cleared on a successful reload. */
  error: string | null;
  /** Re-read from the database. Safe to call at any time. */
  reload: () => void;
  /** Replace a workspace in place, for edits that do not change the set. */
  patch: (workspaceId: string, changes: Partial<Workspace>) => void;
};

/** Focus-triggered refreshes closer together than this are coalesced. */
const FOCUS_REFRESH_FLOOR_MS = 5_000;

export function useWorkspaceDirectory(reloadToken = 0): WorkspaceDirectory {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [archived, setArchived] = useState<Workspace[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Bumped to request a reload; an effect keyed on it does the reading. */
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      try {
        // Both reads at once: they are independent, and the homescreen needs
        // them together anyway.
        const [directory, nextInvitations] = await Promise.all([
          listWorkspaces(),
          listInvitations(),
        ]);

        if (cancelled) return;
        setWorkspaces(directory.active);
        setArchived(directory.archived);
        setInvitations(nextInvitations);
        setError(null);
      } catch (failure) {
        if (cancelled) return;
        // Keep whatever was already on screen. Losing a populated sidebar
        // because one refresh timed out is worse than showing slightly stale
        // names, and the error banner says so.
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [version, reloadToken]);

  const reload = useCallback(() => {
    setVersion((current) => current + 1);
  }, []);

  const patch = useCallback((workspaceId: string, changes: Partial<Workspace>) => {
    const apply = (current: Workspace[]) =>
      current.map((workspace) =>
        workspace.id === workspaceId ? { ...workspace, ...changes } : workspace,
      );

    setWorkspaces(apply);
    setArchived(apply);
  }, []);

  // Coming back to the window is the moment a refresh is both most likely to be
  // wanted and least likely to be noticed. Throttled so alt-tabbing does not
  // turn into a burst of queries.
  const lastRefresh = useRef(Date.now());

  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (now - lastRefresh.current < FOCUS_REFRESH_FLOOR_MS) return;
      lastRefresh.current = now;
      reload();
    };

    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  return { workspaces, archived, invitations, loading, error, reload, patch };
}
