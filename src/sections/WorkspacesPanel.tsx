/**
 * Workspaces — the panel behind the sidebar entry.
 *
 * Two screens share one file because they share one body of state: the
 * homescreen, which lists every workspace you belong to and the invitations
 * waiting for you, and the workspace itself, which is a roster on the right, the
 * applications you can run on the left, and everyone else's pointer over the top
 * of both.
 *
 * ## What this panel is not
 *
 * It does not edit project data. The schema has `workspace_projects`,
 * `workspace_project_live_state`, a revision history and a ninety-second
 * single-editor lock, and none of that is wired up here — deliberately, because
 * the model is turn-taking rather than simultaneous editing and exposing it as
 * if it were the latter would be a lie about what the app does. What *is* here is
 * the part the schema has no answer for: who is online, where their pointer is,
 * and which application they have open.
 *
 * ## Why the cursors do not go through React
 *
 * `CursorLayer` reads positions out of the presence client's map inside a
 * `requestAnimationFrame` loop. `presence` below re-renders this component only
 * when the *roster* changes, which is rare, and never for a pointer move. See
 * `src/lib/presence.ts` for why that split exists.
 *
 * ## Colours
 *
 * Cursor colours are identity, not status — they say "this is Priya", not "this
 * is good" — which is why they come from their own `--color-cursor-*` palette
 * rather than the semantic `good`/`bad`/`warn` tokens. Everywhere a status
 * colour appears below it is a genuine better-or-worse: `pill-failed` when
 * presence is broken.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CursorLayer } from "../components/workspace/CursorLayer";
import { formatBytes } from "../lib/platform-data";
import {
  createPresenceClient,
  type CursorTarget,
  type PresenceClient,
  type PresenceSnapshot,
} from "../lib/presence";
import { fetchStorageSummary, storageRatio, type StorageSummary } from "../lib/storage";
import {
  addProject,
  canCollaborate,
  createWorkspace,
  deleteWorkspace,
  inviteMember,
  INVITABLE_ROLES,
  isOwner,
  listMembers,
  listProjects,
  projectSlugKey,
  removeMember,
  respondToInvitation,
  restoreWorkspace,
  roleLabel,
  updateMemberRole,
  type Invitation,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceProject,
  type WorkspaceRole,
} from "../lib/workspaces";
import type { Peer } from "../lib/workspace-protocol";

/** One application in the local hub, offered inside a workspace. */
export type WorkspacePanelApp = {
  slug: string;
  name: string;
  installed: boolean;
  icon?: string;
};

export type WorkspacesPanelProps = {
  apps: WorkspacePanelApp[];
  workspaces: Workspace[];
  archived: Workspace[];
  invitations: Invitation[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
  /** The workspace being viewed, or null for the homescreen. */
  openWorkspaceId: string | null;
  onOpenWorkspace: (workspaceId: string | null) => void;
  /** Run an application that this workspace shares. */
  onLaunchApp: (slug: string) => void;
  className?: string;
};

const EMPTY_PRESENCE: PresenceSnapshot = {
  status: "idle",
  detail: null,
  you: null,
  peers: [],
};

const NO_TARGETS: ReadonlyMap<string, CursorTarget> = new Map();

/** How long a notice stays on screen. Matches the rest of the app. */
const NOTICE_MS = 4_200;

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "3 days ago", from an ISO timestamp. Empty when the value is unusable. */
function relativeWhen(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";

  const seconds = Math.round((then - Date.now()) / 1000);
  const magnitude = Math.abs(seconds);

  if (magnitude < 60) return RELATIVE.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RELATIVE.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return RELATIVE.format(days, "day");
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return RELATIVE.format(months, "month");
  return RELATIVE.format(Math.round(months / 12), "year");
}

function initialsOf(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[parts.length - 1]![0] ?? ""}`.toUpperCase();
}

/** A member's best label: their name, then their address, then a placeholder. */
function labelOf(member: { full_name?: string | null; email?: string | null }): string {
  return member.full_name?.trim() || member.email?.trim() || "Member";
}

/**
 * The peer behind a membership row, if that person is online.
 *
 * Matched on `user_id` first. The email fallback is not redundant: the room
 * derives a peer's address from the auth session, and `list_workspace_members`
 * reads it from the `members` table, so a person whose account record and auth
 * record disagree would otherwise never light up as present.
 */
function peerForMember(peers: Peer[], member: WorkspaceMember): Peer | null {
  for (const peer of peers) {
    if (peer.user_id && peer.user_id === member.user_id) return peer;
  }

  const email = member.email?.trim().toLowerCase();
  if (!email) return null;
  for (const peer of peers) {
    if (peer.email.trim().toLowerCase() === email) return peer;
  }

  return null;
}

// -----------------------------------------------------------------------------
// Small pieces
// -----------------------------------------------------------------------------

function RolePill({ role, className = "" }: { role: WorkspaceRole; className?: string }) {
  // Ownership is a fact about the row, not a judgement about the person, so the
  // strongest pill is the neutral accent rather than a status colour.
  const tone = role === "OWNER" ? "pill pill-accent" : "pill";
  return <span className={`${tone} ${className}`}>{roleLabel(role)}</span>;
}

function Avatar({
  label,
  color,
  size = 22,
}: {
  label: string;
  color?: string;
  size?: number;
}) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full border border-line bg-raised text-ink-dim"
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.4), color }}
      title={label}
    >
      {initialsOf(label)}
    </span>
  );
}

/**
 * A product's icon, or its initials when there is no artwork.
 *
 * Takes the two fields it needs rather than a whole application, because a
 * workspace row may name an application this hub does not have — and that still
 * needs something drawn in the same place.
 */
function AppIcon({
  name,
  icon,
  size = 26,
}: {
  name: string;
  icon?: string;
  size?: number;
}) {
  if (icon) {
    return (
      <img
        src={icon}
        alt=""
        draggable={false}
        className="shrink-0 rounded-md object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      className="label flex shrink-0 items-center justify-center rounded-md border border-line bg-raised text-ink-dim"
      style={{ width: size, height: size }}
    >
      {name.replace(/[^A-Za-z]/g, "").slice(0, 2) || "AP"}
    </span>
  );
}

/**
 * Whether live presence is working.
 *
 * `idle` renders nothing. An idle client is the normal state before a workspace
 * is open, and a badge saying "not connected" on a screen that has no reason to
 * be connected would be noise dressed as information.
 */
function PresencePill({ presence }: { presence: PresenceSnapshot }) {
  if (presence.status === "idle") return null;

  if (presence.status === "error") {
    return (
      <span className="tip">
        <span className="pill pill-failed">
          <span className="pill-dot" />
          Presence offline
        </span>
        <span className="tip-bubble">{presence.detail ?? "Live presence is unavailable."}</span>
      </span>
    );
  }

  const count = presence.peers.length + 1;
  const label = presence.status === "connecting" ? "Connecting" : `${count} online`;

  return (
    <span className={presence.status === "live" ? "pill pill-accent" : "pill"}>
      <span className="pill-dot" />
      {label}
    </span>
  );
}

// -----------------------------------------------------------------------------
// Homescreen
// -----------------------------------------------------------------------------

function InvitationRow({
  invitation,
  busy,
  onRespond,
}: {
  invitation: Invitation;
  busy: boolean;
  onRespond: (invitationId: string, accept: boolean) => void;
}) {
  return (
    <li className="well flex items-center gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-ink">
          {invitation.workspace_name ?? "A workspace"}
        </div>
        <div className="truncate text-[11px] text-ink-dim">
          Invited as {roleLabel(invitation.role).toLowerCase()} &middot; expires{" "}
          {relativeWhen(invitation.expires_at)}
        </div>
      </div>

      <RolePill role={invitation.role} />

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => onRespond(invitation.id, true)}
        >
          Join
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          disabled={busy}
          onClick={() => onRespond(invitation.id, false)}
        >
          Decline
        </button>
      </div>
    </li>
  );
}

/**
 * The sentence under the storage bar.
 *
 * Separated from the markup because the interesting cases are the empty and the
 * nearly-full one, and a nested ternary in JSX is where those cases stop being
 * readable. Being nearly out of room is a genuine worse state, so it is the one
 * place here that earns a semantic colour.
 */
function storageDetail(
  summary: StorageSummary | null,
  ratio: number,
): { text: string; tone: "faint" | "warn" } {
  if (!summary) {
    return {
      text: "Your own gigabyte for application files. A workspace's members can read what you share into it.",
      tone: "faint",
    };
  }

  if (summary.object_count === 0) {
    return {
      text: "Nothing stored yet. Files stay private to you until you share them into a workspace.",
      tone: "faint",
    };
  }

  if (ratio >= 0.9) {
    const left = Math.max(0, summary.quota_bytes - summary.used_bytes);
    return {
      text: `Only ${formatBytes(left)} left. ${summary.shared_count} of ${summary.object_count} shared with a workspace.`,
      tone: "warn",
    };
  }

  const shared =
    summary.shared_count > 0
      ? `, ${summary.shared_count} shared with a workspace`
      : ", none shared yet";
  return {
    text: `${summary.object_count} object${summary.object_count === 1 ? "" : "s"}${shared}.`,
    tone: "faint",
  };
}

/**
 * How much of this account's online storage is spent.
 *
 * The bar is accent-coloured whatever its value: the quota is an allowance, not
 * a score, and the number beside it is the actual answer. The colour is spent on
 * the sentence instead, where "nearly out of room" is a real problem.
 */
function StorageMeter({
  summary,
  loading,
  error,
  onRetry,
}: {
  summary: StorageSummary | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const ratio = summary ? storageRatio(summary) : 0;
  const detail = storageDetail(summary, ratio);

  const amount = summary
    ? `${formatBytes(summary.used_bytes)} of ${formatBytes(summary.quota_bytes)}`
    : loading
      ? "Checking…"
      : "Unavailable";

  return (
    <section className="card rise flex flex-col gap-2 p-3.5">
      <div className="flex items-baseline gap-2">
        <span className="label">Online storage</span>
        <div className="flex-1" />
        <span className="text-[12px] text-ink-dim">{amount}</span>
      </div>

      <div className="progress-track h-2">
        <div className="progress-fill h-full" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>

      {error ? (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[11px] text-bad">{error}</span>
          <button type="button" className="btn btn-ghost shrink-0" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : (
        <p className={`text-[11px] ${detail.tone === "warn" ? "text-warn" : "text-ink-faint"}`}>
          {detail.text}
        </p>
      )}
    </section>
  );
}

function WorkspaceCard({
  workspace,
  onOpen,
  onDelete,
}: {
  workspace: Workspace;
  onOpen: () => void;
  onDelete: () => void;
}) {
  /** A destructive action nobody can undo from here, so it asks twice. */
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 5_000);
    return () => clearTimeout(timer);
  }, [confirming]);

  return (
    <div className="card card-interactive flex flex-col gap-3 p-4">
      <button type="button" className="flex flex-col gap-1 text-left" onClick={onOpen}>
        <span className="truncate text-[14px] text-ink">{workspace.name}</span>
        <span className="text-[11px] text-ink-dim">
          {workspace.member_count === null
            ? "Member count unavailable"
            : `${workspace.member_count} ${workspace.member_count === 1 ? "member" : "members"}`}
          {" · "}
          {workspace.project_count === 1 ? "1 app" : `${workspace.project_count} apps`}
        </span>
      </button>

      <div className="flex items-center gap-2">
        <RolePill role={workspace.role} />
        <span className="text-[11px] text-ink-faint">
          Updated {relativeWhen(workspace.updated_at)}
        </span>
      </div>

      <div className="divider" />

      <div className="flex items-center justify-between">
        <button type="button" className="btn btn-ghost" onClick={onOpen}>
          Open
        </button>

        {isOwner(workspace.role) ? (
          confirming ? (
            <span className="flex items-center gap-1.5">
              <button type="button" className="btn btn-danger" onClick={onDelete}>
                Confirm delete
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setConfirming(false)}
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="icon-btn icon-btn-danger"
              title="Delete this workspace"
              onClick={() => setConfirming(true)}
            >
              &times;
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}

function NewWorkspaceForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        onCreate(name);
      }}
    >
      <input
        className="field min-w-[200px] flex-1"
        placeholder="New workspace name"
        value={name}
        maxLength={100}
        onChange={(event) => setName(event.target.value)}
      />
      <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
        Create
      </button>
    </form>
  );
}

// -----------------------------------------------------------------------------
// Workspace view
// -----------------------------------------------------------------------------

function MemberRow({
  member,
  peer,
  canManage,
  busy,
  onRoleChange,
  onRemove,
}: {
  member: WorkspaceMember;
  peer: Peer | null;
  canManage: boolean;
  busy: boolean;
  onRoleChange: (role: WorkspaceRole) => void;
  onRemove: () => void;
}) {
  const label = labelOf(member);
  const manageable = canManage && member.role !== "OWNER";

  return (
    <li className="well flex items-center gap-2.5 px-2.5 py-2">
      <Avatar
        label={label}
        color={peer ? `var(--color-cursor-${peer.color})` : undefined}
      />

      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] text-ink">{label}</div>
        <div className="truncate text-[11px] text-ink-faint">
          {peer ? "Online now" : (member.email ?? "No address on record")}
        </div>
      </div>

      {manageable ? (
        <select
          className="field shrink-0"
          value={member.role}
          disabled={busy}
          aria-label={`Role for ${label}`}
          onChange={(event) => onRoleChange(event.target.value as WorkspaceRole)}
        >
          {INVITABLE_ROLES.map((role) => (
            <option key={role} value={role}>
              {roleLabel(role)}
            </option>
          ))}
        </select>
      ) : (
        <RolePill role={member.role} />
      )}

      {manageable ? (
        <button
          type="button"
          className="icon-btn icon-btn-danger shrink-0"
          title={`Remove ${label} from this workspace`}
          disabled={busy}
          onClick={onRemove}
        >
          &times;
        </button>
      ) : null}
    </li>
  );
}

/**
 * One application in the workspace.
 *
 * The tile is a panel with a button on it, not a button itself. It used to be
 * one big button, which meant the only affordance was an unlabelled play glyph
 * and a click anywhere on the card. Now the action has a word on it, and the
 * card can hold things that are not actions without nesting one button inside
 * another.
 *
 * `app` may be null: a workspace can name an application this hub does not have,
 * because the row belongs to the workspace rather than to this machine. That
 * tile still lists, still shows who has it open, and simply cannot be launched.
 */
function AppTile({
  project,
  app,
  users,
  mine,
  busy,
  onToggle,
}: {
  project: WorkspaceProject;
  app: WorkspacePanelApp | null;
  users: Peer[];
  mine: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  const lead = users[0] ?? null;
  const sentence = lead
    ? `${lead.full_name || lead.email} is using this application${
        users.length > 1 ? ` and ${users.length - 1} more` : ""
      }`
    : null;

  const launchable = app?.installed === true;
  const detail = !app
    ? "Not in this hub"
    : app.installed
      ? app.name
      : "Not installed on this machine";

  return (
    <div className={`card flex flex-col gap-2.5 p-3 ${mine ? "border-line-strong" : ""}`}>
      <div className="flex items-center gap-2.5">
        <AppIcon name={project.name} icon={app?.icon} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-ink">{project.name}</div>
          <div className="truncate text-[11px] text-ink-faint">{detail}</div>
        </div>
      </div>

      {users.length > 0 ? (
        <span className="tip">
          <span className="flex items-center gap-1.5">
            {users.slice(0, 3).map((peer) => (
              <Avatar
                key={peer.id}
                label={peer.full_name || peer.email}
                color={`var(--color-cursor-${peer.color})`}
                size={18}
              />
            ))}
            <span className="pill pill-accent">
              <span className="pill-dot" />
              In use
            </span>
          </span>
          <span className="tip-bubble">{sentence}</span>
        </span>
      ) : null}

      <button
        type="button"
        className={mine ? "btn btn-ghost w-full" : "btn btn-primary w-full"}
        disabled={busy || !launchable}
        title={launchable ? undefined : "This application is not installed in this hub."}
        onClick={onToggle}
      >
        {mine ? "Stop sharing" : "Launch"}
      </button>
    </div>
  );
}

function WorkspaceView({
  workspace,
  apps,
  projects,
  projectsLoading,
  projectsError,
  members,
  membersLoading,
  membersError,
  presence,
  focused,
  client,
  busy,
  onBack,
  onLaunchApp,
  onAddProject,
  onInvite,
  onRoleChange,
  onRemoveMember,
  onDelete,
}: {
  workspace: Workspace;
  apps: WorkspacePanelApp[];
  projects: WorkspaceProject[];
  projectsLoading: boolean;
  projectsError: string | null;
  members: WorkspaceMember[];
  membersLoading: boolean;
  membersError: string | null;
  presence: PresenceSnapshot;
  focused: boolean;
  client: PresenceClient | null;
  busy: boolean;
  onBack: () => void;
  onLaunchApp: (slug: string) => void;
  onAddProject: (name: string, productSlug: string) => void;
  onInvite: (email: string, role: WorkspaceRole) => void;
  onRoleChange: (userId: string, role: WorkspaceRole) => void;
  onRemoveMember: (userId: string) => void;
  onDelete: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  /** The project this client announced, by row id — see `toggleApp`. */
  const [myApp, setMyApp] = useState<string | null>(null);
  const [addingSlug, setAddingSlug] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("EDITOR");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const iAmOwner = isOwner(workspace.role);
  /** Adding an application is a write to the workspace, so viewers cannot. */
  const iCanAdd = canCollaborate(workspace.role);

  // Leaving the workspace must retract the announcement, or the roster of the
  // *next* workspace would show this person sitting in an application that is
  // not there.
  useEffect(() => {
    setMyApp(null);
    setAddingSlug("");
    setConfirmingDelete(false);
    client?.setApp(null);
  }, [workspace.id, client]);

  /**
   * Report pointer positions in the surface's own coordinate space.
   *
   * Normalised to 0–1 so two people with different window sizes agree about
   * where "the top right" is. The rect is read per move rather than cached
   * because the sidebar can change width mid-session, and reading it is cheap
   * compared with the frame it feeds.
   */
  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const surface = surfaceRef.current;
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      client?.sendCursor(
        (event.clientX - rect.left) / rect.width,
        (event.clientY - rect.top) / rect.height,
      );
    },
    [client],
  );

  const peers = presence.peers;

  /**
   * The hub's own products, keyed the way a workspace stores them.
   *
   * A workspace row names a product by its normalised slug and the hub names the
   * same product by the slug in `App.tsx`, and those are not the same string:
   * "Propulsor - Liquid Engine Design Studio" is one and
   * "propulsor-liquid-engine-design-studio" is the other. Normalising both sides
   * through the same function is what makes the match hold.
   */
  const appBySlug = useMemo(() => {
    const map = new Map<string, WorkspacePanelApp>();
    for (const app of apps) map.set(projectSlugKey(app.slug), app);
    return map;
  }, [apps]);

  /** Installed applications this workspace does not already hold. */
  const addableApps = useMemo(() => {
    const used = new Set(projects.map((project) => project.product_slug));
    return apps.filter((app) => app.installed && !used.has(projectSlugKey(app.slug)));
  }, [apps, projects]);

  /**
   * Everyone, including me, who has an application open — by project id.
   *
   * Keyed by row id rather than by product slug because that is what presence
   * carries: two workspaces can hold the same product, and one workspace could
   * legitimately hold it twice.
   */
  const usersByApp = useMemo(() => {
    const map = new Map<string, Peer[]>();
    for (const peer of peers) {
      if (!peer.app) continue;
      const bucket = map.get(peer.app);
      if (bucket) bucket.push(peer);
      else map.set(peer.app, [peer]);
    }
    return map;
  }, [peers]);

  const toggleApp = useCallback(
    (projectId: string, launchSlug: string | null) => {
      if (myApp === projectId) {
        // Already announced: this click retracts rather than launching again.
        setMyApp(null);
        client?.setApp(null);
        return;
      }

      // Announce first, then run. If the launch fails, the other people in the
      // workspace are told about a failure they can see for themselves — which
      // is better than the alternative, where the application opens and nobody
      // knows who did it.
      setMyApp(projectId);
      client?.setApp(projectId);
      if (launchSlug) onLaunchApp(launchSlug);
    },
    [myApp, client, onLaunchApp],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-center gap-3">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          &larr; All workspaces
        </button>
        <span className="truncate text-[14px] text-ink">{workspace.name}</span>
        <RolePill role={workspace.role} />
        <div className="flex-1" />
        <PresencePill presence={presence} />
      </div>

      <div
        ref={surfaceRef}
        onPointerMove={onPointerMove}
        className="relative flex min-h-0 flex-1 gap-3"
      >
        {/* Absolutely positioned over the whole surface, so a pointer that is
            over the roster is drawn in the place the other person sees. */}
        <CursorLayer
          peers={peers}
          targets={client?.readTargets() ?? NO_TARGETS}
          active={focused && presence.status === "live"}
        />

        <div className="scroll flex min-h-0 flex-1 flex-col gap-3">
          <div className="card p-3">
            <div className="label mb-2.5">Applications</div>

            {projectsLoading && projects.length === 0 ? (
              <p className="text-[12px] text-ink-dim">Loading the applications…</p>
            ) : projectsError ? (
              <p className="text-[12px] text-bad">{projectsError}</p>
            ) : projects.length === 0 ? (
              <p className="text-[12px] text-ink-dim">
                No applications have been added to this workspace yet.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {projects.map((project) => {
                  const app = appBySlug.get(project.product_slug) ?? null;
                  return (
                    <AppTile
                      key={project.id}
                      project={project}
                      app={app}
                      users={usersByApp.get(project.id) ?? []}
                      mine={myApp === project.id}
                      busy={busy}
                      onToggle={() => toggleApp(project.id, app?.installed ? app.slug : null)}
                    />
                  );
                })}
              </div>
            )}

            {/* Adding is a write to the workspace, so it follows the same rule as
                every other write: no button for people the database would refuse. */}
            {iCanAdd ? (
              <form
                className="mt-3 flex items-center gap-2 border-t border-line pt-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const app = apps.find((candidate) => candidate.slug === addingSlug);
                  if (!app) return;
                  onAddProject(app.name, app.slug);
                  setAddingSlug("");
                }}
              >
                <select
                  className="field min-w-0 flex-1"
                  value={addingSlug}
                  disabled={busy || addableApps.length === 0}
                  aria-label="Application to add to this workspace"
                  onChange={(event) => setAddingSlug(event.target.value)}
                >
                  <option value="">
                    {addableApps.length === 0
                      ? "Every installed application is already here"
                      : "Add an application…"}
                  </option>
                  {addableApps.map((app) => (
                    <option key={app.slug} value={app.slug}>
                      {app.name}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  className="btn btn-primary shrink-0"
                  disabled={busy || !addingSlug}
                >
                  Add
                </button>
              </form>
            ) : null}
          </div>
        </div>

        <aside className="card slide-in-right flex w-[268px] shrink-0 flex-col p-2.5">
          <div className="label px-1 pb-2">People</div>

          {membersLoading && members.length === 0 ? (
            <p className="px-1 text-[12px] text-ink-dim">Loading the roster…</p>
          ) : membersError ? (
            <p className="px-1 text-[12px] text-bad">{membersError}</p>
          ) : (
            <ul className="scroll flex min-h-0 flex-1 flex-col gap-1.5">
              {members.map((member) => (
                <MemberRow
                  key={member.user_id}
                  member={member}
                  peer={peerForMember(peers, member)}
                  canManage={iAmOwner}
                  busy={busy}
                  onRoleChange={(role) => onRoleChange(member.user_id, role)}
                  onRemove={() => onRemoveMember(member.user_id)}
                />
              ))}
            </ul>
          )}

          {iAmOwner ? (
            <form
              className="mt-2.5 flex flex-col gap-1.5 border-t border-line pt-2.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (!inviteEmail.trim()) return;
                onInvite(inviteEmail, inviteRole);
                setInviteEmail("");
              }}
            >
              <input
                className="field"
                type="email"
                placeholder="member@example.com"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
              />
              <div className="flex items-center gap-1.5">
                <select
                  className="field flex-1"
                  value={inviteRole}
                  aria-label="Role for the person being invited"
                  onChange={(event) => setInviteRole(event.target.value as WorkspaceRole)}
                >
                  {INVITABLE_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {roleLabel(role)}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={busy || !inviteEmail.trim()}
                >
                  Invite
                </button>
              </div>
              <p className="text-[11px] text-ink-faint">
                Only addresses that already belong to an approved APRO member or an
                APRO administrator can be invited.
              </p>
            </form>
          ) : null}

          {iAmOwner ? (
            <div className="mt-2.5 border-t border-line pt-2.5">
              {confirmingDelete ? (
                <div className="flex items-center gap-1.5">
                  <button type="button" className="btn btn-danger flex-1" onClick={onDelete}>
                    Confirm delete
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Keep
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn-quiet w-full"
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete workspace
                </button>
              )}
              <p className="mt-1.5 text-[11px] text-ink-faint">
                Deleting is reversible for seven days, then the data is purged.
              </p>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// The panel
// -----------------------------------------------------------------------------

export function WorkspacesPanel({
  apps,
  workspaces,
  archived,
  invitations,
  loading,
  error,
  onReload,
  openWorkspaceId,
  onOpenWorkspace,
  onLaunchApp,
  className = "",
}: WorkspacesPanelProps) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "good" | "bad"; text: string } | null>(null);

  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);

  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  // The account's allowance, not any one workspace's. See `loadStorage`.
  const [storage, setStorage] = useState<StorageSummary | null>(null);
  const [storageLoading, setStorageLoading] = useState(true);
  const [storageError, setStorageError] = useState<string | null>(null);

  const [presence, setPresence] = useState<PresenceSnapshot>(EMPTY_PRESENCE);
  const [focused, setFocused] = useState(true);

  const clientRef = useRef<PresenceClient | null>(null);

  const openWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === openWorkspaceId) ?? null,
    [workspaces, openWorkspaceId],
  );

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const report = useCallback((tone: "good" | "bad", text: string) => {
    setNotice({ tone, text });
  }, []);

  /**
   * Run a write, and turn a refusal into a sentence rather than a crash.
   *
   * Every one of these calls can be refused by the database for a reason the
   * client cannot know — an expired invitation, a lost ownership role, a race
   * with another owner. The function's own message is the useful part, so it is
   * shown verbatim.
   */
  const guard = useCallback(
    async (run: () => Promise<void>) => {
      setBusy(true);
      try {
        await run();
      } catch (failure) {
        report("bad", failure instanceof Error ? failure.message : String(failure));
      } finally {
        setBusy(false);
      }
    },
    [report],
  );

  // The roster for whichever workspace is open. Read fresh rather than taken
  // from the list, because the list carries a count and this needs names.
  const loadMembers = useCallback(async (workspaceId: string) => {
    setMembersLoading(true);
    try {
      const next = await listMembers(workspaceId);
      setMembers(next);
      setMembersError(null);
    } catch (failure) {
      setMembersError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setMembersLoading(false);
    }
  }, []);

  /**
   * The applications in whichever workspace is open.
   *
   * Read fresh rather than trusted from `workspace.project_count`: the count says
   * how many there are, and a tile needs to know which ones and what they are
   * called.
   */
  const loadProjects = useCallback(async (workspaceId: string) => {
    setProjectsLoading(true);
    try {
      const next = await listProjects(workspaceId);
      setProjects(next);
      setProjectsError(null);
    } catch (failure) {
      setProjectsError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  /**
   * The account's own online-storage allowance.
   *
   * Read once for the homescreen rather than per workspace: the gigabyte belongs
   * to the person, not to any one workspace, so there is a single number to show
   * and a single place it can be wrong. A failure here is not fatal to the
   * panel — the workspaces below are perfectly usable without it — so it is
   * kept in its own error rather than thrown at the page.
   */
  const loadStorage = useCallback(async () => {
    setStorageLoading(true);
    try {
      setStorage(await fetchStorageSummary());
      setStorageError(null);
    } catch (failure) {
      setStorageError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setStorageLoading(false);
    }
  }, []);

  /**
   * Re-read the meter whenever the directory is re-read.
   *
   * Depending on `workspaces` looks indirect, but it is the only signal this
   * panel receives that the Refresh button was pressed or that the window came
   * back into focus: `useWorkspaceDirectory` replaces that array on every load.
   * It is a `useState` value, so its identity is stable between loads and this
   * cannot loop.
   */
  useEffect(() => {
    if (openWorkspace) return;
    void loadStorage();
  }, [openWorkspace, loadStorage, workspaces]);

  useEffect(() => {
    if (!openWorkspace) {
      setMembers([]);
      setMembersError(null);
      setProjects([]);
      setProjectsError(null);
      return;
    }
    void loadMembers(openWorkspace.id);
    void loadProjects(openWorkspace.id);
  }, [openWorkspace, loadMembers, loadProjects]);

  /**
   * One presence client per open workspace.
   *
   * Keyed on the workspace id, so switching workspaces tears the socket down and
   * opens a new one rather than relaying one workspace's pointers into another.
   */
  useEffect(() => {
    if (!openWorkspace) {
      setPresence(EMPTY_PRESENCE);
      clientRef.current = null;
      return;
    }

    const client = createPresenceClient({
      workspaceId: openWorkspace.id,
      onFatal: (message) => report("bad", message),
    });

    clientRef.current = client;
    const unsubscribe = client.subscribe(() => setPresence(client.getSnapshot()));
    client.connect();
    setPresence(client.getSnapshot());

    return () => {
      unsubscribe();
      client.disconnect();
      clientRef.current = null;
      setPresence(EMPTY_PRESENCE);
    };
  }, [openWorkspace, report]);

  // A backgrounded window must not keep drawing pointers: they would show people
  // where someone was when they last looked, not where they are.
  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const handleCreate = useCallback(
    (name: string) => {
      void guard(async () => {
        const id = await createWorkspace(name);
        onReload();
        if (id) onOpenWorkspace(id);
      });
    },
    [guard, onReload, onOpenWorkspace],
  );

  const handleDelete = useCallback(
    (workspaceId: string) => {
      void guard(async () => {
        await deleteWorkspace(workspaceId);
        onOpenWorkspace(null);
        onReload();
        report("good", "Workspace deleted. It can be restored for seven days.");
      });
    },
    [guard, onOpenWorkspace, onReload, report],
  );

  const handleRestore = useCallback(
    (workspaceId: string) => {
      void guard(async () => {
        await restoreWorkspace(workspaceId);
        onReload();
        report("good", "Workspace restored.");
      });
    },
    [guard, onReload, report],
  );

  const handleRespond = useCallback(
    (invitationId: string, accept: boolean) => {
      void guard(async () => {
        await respondToInvitation(invitationId, accept);
        onReload();
        report("good", accept ? "You have joined the workspace." : "Invitation declined.");
      });
    },
    [guard, onReload, report],
  );

  const handleInvite = useCallback(
    (email: string, role: WorkspaceRole) => {
      if (!openWorkspace) return;
      void guard(async () => {
        await inviteMember(openWorkspace.id, email, role);
        await loadMembers(openWorkspace.id);
        report("good", `Invitation sent to ${email.trim()}.`);
      });
    },
    [guard, openWorkspace, loadMembers, report],
  );

  /**
   * Add one of this hub's installed applications to the open workspace.
   *
   * The workspace stores a normalised product slug, and the project is created
   * with an empty initial document: the applications own their own data shape and
   * this layer deliberately does not invent one. `onReload` follows because the
   * homescreen's project count has moved.
   */
  const handleAddProject = useCallback(
    (name: string, productSlug: string) => {
      if (!openWorkspace) return;
      void guard(async () => {
        await addProject(openWorkspace.id, name, productSlug);
        await loadProjects(openWorkspace.id);
        onReload();
        report("good", `${name} was added to this workspace.`);
      });
    },
    [guard, openWorkspace, loadProjects, onReload, report],
  );

  const handleRoleChange = useCallback(
    (userId: string, role: WorkspaceRole) => {
      if (!openWorkspace) return;
      void guard(async () => {
        await updateMemberRole(openWorkspace.id, userId, role);
        await loadMembers(openWorkspace.id);
      });
    },
    [guard, openWorkspace, loadMembers],
  );

  const handleRemoveMember = useCallback(
    (userId: string) => {
      if (!openWorkspace) return;
      void guard(async () => {
        await removeMember(openWorkspace.id, userId);
        await loadMembers(openWorkspace.id);
      });
    },
    [guard, openWorkspace, loadMembers],
  );

  return (
    <div className={`relative flex min-h-0 flex-col gap-3 ${className}`}>
      {loading && workspaces.length === 0 && archived.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="text-[12px] text-ink-dim">Loading workspaces…</span>
        </div>
      ) : error && workspaces.length === 0 && archived.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="card max-w-[420px] p-4">
            <div className="label mb-1.5 text-bad">Workspaces unavailable</div>
            <p className="text-[12px] leading-relaxed text-ink-dim">{error}</p>
            <button type="button" className="btn btn-ghost mt-3" onClick={onReload}>
              Try again
            </button>
          </div>
        </div>
      ) : openWorkspace ? (
        <WorkspaceView
          workspace={openWorkspace}
          apps={apps}
          projects={projects}
          projectsLoading={projectsLoading}
          projectsError={projectsError}
          members={members}
          membersLoading={membersLoading}
          membersError={membersError}
          presence={presence}
          focused={focused}
          client={clientRef.current}
          busy={busy}
          onBack={() => onOpenWorkspace(null)}
          onLaunchApp={onLaunchApp}
          onAddProject={handleAddProject}
          onInvite={handleInvite}
          onRoleChange={handleRoleChange}
          onRemoveMember={handleRemoveMember}
          onDelete={() => handleDelete(openWorkspace.id)}
        />
      ) : (
        <div className="scroll flex min-h-0 flex-1 flex-col gap-4">
          {invitations.length > 0 ? (
            <section className="rise">
              <div className="label mb-2">Invitations</div>
              <ul className="flex flex-col gap-1.5">
                {invitations.map((invitation) => (
                  <InvitationRow
                    key={invitation.id}
                    invitation={invitation}
                    busy={busy}
                    onRespond={handleRespond}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          <StorageMeter
            summary={storage}
            loading={storageLoading}
            error={storageError}
            onRetry={() => void loadStorage()}
          />

          <section className="rise">
            <div className="mb-2 flex items-center gap-3">
              <div className="label">Your workspaces</div>
              <div className="flex-1" />
              <NewWorkspaceForm busy={busy} onCreate={handleCreate} />
            </div>

            {workspaces.length === 0 ? (
              <div className="card card-dashed flex flex-col items-center gap-1 p-6 text-center">
                <span className="text-[13px] text-ink">No workspaces yet</span>
                <span className="text-[12px] text-ink-dim">
                  A workspace is a shared environment where you and other people run the same
                  applications and see each other&rsquo;s pointers.
                </span>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {workspaces.map((workspace) => (
                  <WorkspaceCard
                    key={workspace.id}
                    workspace={workspace}
                    onOpen={() => onOpenWorkspace(workspace.id)}
                    onDelete={() => handleDelete(workspace.id)}
                  />
                ))}
              </div>
            )}
          </section>

          {archived.length > 0 ? (
            <section>
              <div className="label mb-2">Recently deleted</div>
              <ul className="flex flex-col gap-1.5">
                {archived.map((workspace) => (
                  <li key={workspace.id} className="well flex items-center gap-3 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink-dim">
                      {workspace.name}
                    </span>
                    <span className="text-[11px] text-ink-faint">
                      {workspace.purge_after
                        ? `Purges ${relativeWhen(workspace.purge_after)}`
                        : "Pending purge"}
                    </span>
                    {isOwner(workspace.role) ? (
                      <button
                        type="button"
                        className="btn btn-ghost shrink-0"
                        disabled={busy}
                        onClick={() => handleRestore(workspace.id)}
                      >
                        Restore
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {error ? (
            <p className="text-[11px] text-bad">
              {error} — showing what was last loaded.
            </p>
          ) : null}
        </div>
      )}

      {notice ? (
        <div className="absolute bottom-4 left-1/2 z-30 -translate-x-1/2">
          <div className="card px-3.5 py-2.5">
            <span className={`text-[12px] ${notice.tone === "bad" ? "text-bad" : "text-ink"}`}>
              {notice.text}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default WorkspacesPanel;
