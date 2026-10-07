/**
 * Workspaces — everything the hub reads and writes in Postgres.
 *
 * This is the cloud half of the product, and it is the first place in the app
 * that talks to Supabase for anything other than the approval gate in
 * `App.tsx`. Things worth knowing before changing anything here:
 *
 * **The schema is not ours.** Workspaces already existed in this database when
 * the desktop feature was written — `shared_workspaces`, `workspace_members`,
 * `workspace_invitations`, `workspace_projects` and their RPCs were built for
 * the APRO website, and this client is a *second* consumer of them. That is why
 * every shape below is dictated by what the tables actually contain rather than
 * what would be convenient, and why several ideas the UI would like to have
 * (an invitation for someone who has not signed up yet, a member named by
 * email) are simply not representable.
 *
 * **Every table grants `authenticated` SELECT and nothing else.** There are no
 * INSERT, UPDATE or DELETE policies on any of them. Writes go through the
 * `security definer` functions, which is where the invariants live — an owner
 * cannot be removed, a workspace cannot be left without one, an invitation
 * cannot be accepted twice. Writing around them with a direct table update
 * would not fail loudly; it would fail silently, because RLS denies by
 * returning zero rows. So there are no `.insert()`/`.update()`/`.delete()`
 * calls in this file, and there should never be.
 *
 * **There is no demo fallback.** `platform-data.ts` returns labelled sample data
 * when the local store is unreachable, which is right for a store that lives on
 * this machine. A fabricated list of workspaces would be a lie about *other
 * people's* data — it would show collaborators who do not exist and invitations
 * nobody sent. So failures throw, with a message meant to be read by a person.
 *
 * **Reads are flat, not nested.** The obvious way to get a workspace with its
 * roster is one query with embedded resources; instead the reads below issue
 * several flat queries and join them here. PostgREST's embedded selects return a
 * shape that depends on how the row-level policies happen to compose, and the
 * client cannot see those policies. The data is small — a handful of
 * workspaces, each with a handful of members.
 */

import { supabase, supabaseConfigError } from "./supabase";

// -----------------------------------------------------------------------------
// Roles
// -----------------------------------------------------------------------------

/**
 * The database's role set, verbatim.
 *
 * These are the literal values in `workspace_members.role` and the strings
 * `apro_workspace_role()` returns. They are compared case-sensitively by SQL, so
 * they are uppercase here too rather than being prettified at the boundary —
 * a mismatch would be a silent authorization difference, not a cosmetic one.
 */
export type WorkspaceRole = "OWNER" | "EDITOR" | "VIEWER";

/** Most powerful first, matching how the SQL ranks them. */
export const WORKSPACE_ROLES: readonly WorkspaceRole[] = ["OWNER", "EDITOR", "VIEWER"];

const ROLE_RANK: Record<WorkspaceRole, number> = { OWNER: 0, EDITOR: 1, VIEWER: 2 };

export function roleRank(role: WorkspaceRole): number {
  return ROLE_RANK[role] ?? ROLE_RANK.VIEWER;
}

/**
 * Roles that can be handed to somebody else.
 *
 * `invite_workspace_member` accepts only `EDITOR` or `VIEWER`; ownership is
 * transferred by other means. Offering the owner role in an invite form would
 * produce a guaranteed database error, so it is not offered.
 */
export const INVITABLE_ROLES: readonly WorkspaceRole[] = ["EDITOR", "VIEWER"];

/** Owners manage people; editors contribute; viewers read. */
export function isOwner(role: WorkspaceRole): boolean {
  return role === "OWNER";
}

/** Owners and editors both work inside a workspace, so both get a cursor. */
export function canCollaborate(role: WorkspaceRole): boolean {
  return roleRank(role) <= ROLE_RANK.EDITOR;
}

export function roleLabel(role: WorkspaceRole): string {
  switch (role) {
    case "OWNER":
      return "Owner";
    case "EDITOR":
      return "Editor";
    default:
      return "Viewer";
  }
}

// -----------------------------------------------------------------------------
// Shapes
// -----------------------------------------------------------------------------

export type Workspace = {
  id: string;
  name: string;
  /** The caller's own role. Every workspace here is one they belong to. */
  role: WorkspaceRole;
  owner_user_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  purge_after: string | null;
  project_count: number;
  /**
   * How many people are in it, or null when the count could not be read.
   *
   * Null rather than 0 on purpose: a card that says "0 members" because a query
   * failed is stating something false, and the two are worth telling apart.
   */
  member_count: number | null;
};

/**
 * A member of one workspace, as `list_workspace_members()` reports them.
 *
 * Note the absence of an id: the membership is keyed by `(workspace_id,
 * user_id)`, and every write about a member names those two rather than a row
 * id. `email` and `full_name` come from the `members` table and can be null,
 * because the join there is on `auth_user_id` and a membership whose account
 * record is missing still exists.
 */
export type WorkspaceMember = {
  user_id: string;
  full_name: string | null;
  email: string | null;
  role: WorkspaceRole;
  joined_at: string;
};

export type InvitationStatus = "PENDING" | "ACCEPTED" | "DECLINED" | "CANCELLED";

export type Invitation = {
  id: string;
  workspace_id: string;
  /**
   * Resolved with a second read, and may legitimately be missing.
   *
   * The policy on `shared_workspaces` admits an invitee, but the *invitations*
   * policy admits them too, and the two reads are separate statements — so a
   * window exists in which the invitation is visible and the name is not. An
   * invitation with no name still shows, labelled generically, rather than
   * vanishing.
   */
  workspace_name: string | null;
  invited_email: string;
  role: WorkspaceRole;
  status: InvitationStatus;
  created_at: string;
  expires_at: string;
};

// -----------------------------------------------------------------------------
// Product slugs
// -----------------------------------------------------------------------------

/**
 * Reduce a product name to something `create_workspace_project` will accept.
 *
 * The database requires `^[a-z0-9][a-z0-9-]{1,79}$`. The hub's own product list
 * does not meet that: `"Propulsor - Liquid Engine Design Studio"` is a product
 * slug in `src/App.tsx` with spaces and capitals in it, and a slug that is
 * merely *passed through* joins directly into a filesystem path on the machine
 * (DESIGN.md risk R5). So the two vocabularies are reconciled here, in the
 * client, at one place, rather than by loosening the constraint that the
 * website's own data already satisfies.
 *
 * This is lossy in one direction only: `"Propulsor - Liquid Engine Design
 * Studio"` and `"propulsor-liquid-engine-design-studio"` collapse to the same
 * key. That is the intended behaviour — they are the same application — but it
 * does mean the returned value must never be used to look a product up. Keep
 * using the original slug for that.
 */
export function normalizeProductSlug(slug: string): string {
  const cleaned = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "");

  // The pattern needs at least two characters and must not end on a separator.
  const trimmed = cleaned.replace(/-+$/, "");
  if (trimmed.length >= 2) return trimmed.slice(0, 80);

  // Pathological input: a slug that is one character, or none at all. Padding to
  // the minimum length keeps the call legal, and the fallback keeps it unique
  // enough to be obvious if it ever shows up in the database.
  const padded = `${trimmed}app`.replace(/^-+/, "");
  return padded.length >= 2 ? padded.slice(0, 80) : "app";
}

// -----------------------------------------------------------------------------
// Plumbing
// -----------------------------------------------------------------------------

/** Postgres and PostgREST errors arrive as `{ message, details, hint }`. */
type PostgrestishError = { message?: string; details?: string; hint?: string; code?: string };

/**
 * Turn whatever Supabase returned into one sentence worth showing someone.
 *
 * The raw objects are useful in a log and useless in a toast, so `details` and
 * `hint` are appended only when they say something the message does not.
 */
function describe(error: PostgrestishError | null, fallback: string): string {
  if (!error) return fallback;

  const message = error.message?.trim() || fallback;
  const extras = [error.details, error.hint]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part) && part !== message);

  return extras.length > 0 ? `${message} (${extras.join(" — ")})` : message;
}

/**
 * The signed-in identity.
 *
 * `getSession` reads the locally cached session and only refreshes when it is
 * actually near expiry, so calling it per operation costs nothing. The id is
 * used to find which membership row is "me", and the email is kept because an
 * invitation names a person by address.
 */
async function requireViewer(): Promise<{ id: string; email: string }> {
  if (supabaseConfigError) {
    throw new Error(supabaseConfigError);
  }

  const { data, error } = await supabase.auth.getSession();
  if (error) {
    throw new Error(describe(error, "Could not read your session."));
  }

  const user = data.session?.user;
  if (!user) {
    throw new Error("You are not signed in.");
  }

  return { id: user.id, email: (user.email ?? "").toLowerCase() };
}

/**
 * Coerce a role string from the wire.
 *
 * Case-insensitive because the value's case is a property of *this* schema that
 * a future revision could change, and guessing wrong in the direction of
 * "VIEWER" is the safe failure: it grants nothing.
 */
function toRole(value: unknown): WorkspaceRole {
  const upper = String(value ?? "").toUpperCase();
  return upper === "OWNER" || upper === "EDITOR" || upper === "VIEWER" ? upper : "VIEWER";
}

function toTextOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > 0 ? text : null;
}

/** PostgREST returns an object for `maybeSingle` and an array for `select`. */
type Row = Record<string, unknown>;

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

export type WorkspaceDirectory = {
  /** Workspaces that exist right now. */
  active: Workspace[];
  /**
   * Soft-deleted workspaces, still restorable for seven days.
   *
   * Returned rather than filtered away at the query, because "my workspace
   * vanished" is a worse experience than seeing it greyed out with a way back —
   * and `restore_shared_workspace` exists precisely because the delete is
   * reversible.
   */
  archived: Workspace[];
};

/**
 * Every workspace the caller belongs to, with a member count on each.
 *
 * The read goes through `workspace_overview`, which is a `security_invoker`
 * view — so row-level security applies *through* it and there is no filter here.
 * There should not be one, either: a client-side filter on top of a policy
 * invites the belief that the policy is optional.
 *
 * The view deliberately does not filter `deleted_at`; it also joins the roster,
 * so an invitee who has not accepted yet is not in it. Both are handled here
 * rather than being worked around.
 */
export async function listWorkspaces(): Promise<WorkspaceDirectory> {
  await requireViewer();

  const result = await supabase
    .from("workspace_overview")
    .select(
      "id, name, role, owner_user_id, created_at, updated_at, deleted_at, purge_after, project_count",
    )
    .order("updated_at", { ascending: false });

  if (result.error) {
    throw new Error(describe(result.error, "Could not load your workspaces."));
  }

  const rows = (result.data ?? []) as Row[];
  if (rows.length === 0) return { active: [], archived: [] };

  const ids = rows.map((row) => String(row.id));

  // One query for every roster, counted here. A count that fails is cosmetic;
  // a workspace list that fails because a count failed is not, so this one is
  // allowed to come back empty and the cards say nothing rather than lying.
  const countsResult = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .in("workspace_id", ids);

  const memberCounts = new Map<string, number>();
  if (!countsResult.error) {
    for (const row of (countsResult.data ?? []) as Row[]) {
      const id = String(row.workspace_id);
      memberCounts.set(id, (memberCounts.get(id) ?? 0) + 1);
    }
  }

  const toWorkspace = (row: Row): Workspace => {
    const id = String(row.id);
    return {
      id,
      name: String(row.name ?? "Untitled workspace"),
      role: toRole(row.role),
      owner_user_id: String(row.owner_user_id ?? ""),
      created_at: String(row.created_at ?? ""),
      updated_at: String(row.updated_at ?? ""),
      deleted_at: toTextOrNull(row.deleted_at),
      purge_after: toTextOrNull(row.purge_after),
      project_count: Number(row.project_count ?? 0),
      member_count: countsResult.error ? null : (memberCounts.get(id) ?? 0),
    };
  };

  const active: Workspace[] = [];
  const archived: Workspace[] = [];

  for (const row of rows) {
    const workspace = toWorkspace(row);
    if (workspace.deleted_at === null) active.push(workspace);
    else archived.push(workspace);
  }

  return { active, archived };
}

/**
 * Pending invitations addressed to the caller.
 *
 * The policy on `workspace_invitations` admits a row when the caller
 * administers the workspace *or* when the row names them. This query relies on
 * the second half, which is the only way somebody can learn a workspace exists
 * before joining it.
 *
 * Filtering on `invited_user_id` rather than on the address is deliberate.
 * Invitations are addressed to an account — the column is `NOT NULL`, so the
 * database cannot represent an invitation to an email that has never signed up —
 * and matching on the id means a person who changes their address keeps the
 * invitations they were sent.
 */
export async function listInvitations(): Promise<Invitation[]> {
  const viewer = await requireViewer();

  const result = await supabase
    .from("workspace_invitations")
    .select("id, workspace_id, invited_email, role, status, created_at, expires_at")
    .eq("invited_user_id", viewer.id)
    .eq("status", "PENDING")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });

  if (result.error) {
    throw new Error(describe(result.error, "Could not load your invitations."));
  }

  const rows = (result.data ?? []) as Row[];
  if (rows.length === 0) return [];

  const ids = Array.from(new Set(rows.map((row) => String(row.workspace_id))));

  // Resolving the name is best-effort. Reading `shared_workspaces` as an invitee
  // is permitted, but the two reads are separate statements and a name that
  // arrives empty is a missing label, not a missing invitation.
  const names = await supabase.from("shared_workspaces").select("id, name").in("id", ids);
  const nameById = new Map<string, string>();
  for (const row of (names.data ?? []) as Row[]) {
    nameById.set(String(row.id), String(row.name ?? ""));
  }

  return rows.map((row) => {
    const workspaceId = String(row.workspace_id);
    return {
      id: String(row.id),
      workspace_id: workspaceId,
      workspace_name: nameById.get(workspaceId) || null,
      invited_email: String(row.invited_email ?? ""),
      role: toRole(row.role),
      status: String(row.status ?? "PENDING").toUpperCase() as InvitationStatus,
      created_at: String(row.created_at ?? ""),
      expires_at: String(row.expires_at ?? ""),
    };
  });
}

/**
 * The named roster for one workspace.
 *
 * `list_workspace_members()` is the only thing in the system that turns the
 * `user_id` values in `workspace_members` into people, because it is the only
 * reader that can reach `members` — that table is not readable by a workspace
 * peer through RLS. It raises when the caller is not a member, which is the
 * correct behaviour and is surfaced as the query's own message.
 */
export async function listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  await requireViewer();

  const result = await supabase.rpc("list_workspace_members", {
    p_workspace_id: workspaceId,
  });

  if (result.error) {
    throw new Error(describe(result.error, "Could not load the members of this workspace."));
  }

  return ((result.data ?? []) as Row[]).map((row) => ({
    user_id: String(row.user_id ?? ""),
    full_name: toTextOrNull(row.full_name),
    email: toTextOrNull(row.email),
    role: toRole(row.role),
    joined_at: String(row.joined_at ?? ""),
  }));
}

// -----------------------------------------------------------------------------
// Projects
// -----------------------------------------------------------------------------

/**
 * An application that has been added to a workspace.
 *
 * The schema calls this a "project" and the UI calls it an application, because
 * they are the same thing from two directions: the workspace holds a copy of a
 * hub product's data, and a person sees an application they can open. The row is
 * one product in one workspace, so the same application in two workspaces is two
 * rows with two independent histories.
 */
export type WorkspaceProject = {
  id: string;
  workspace_id: string;
  name: string;
  /** The normalised form of a hub product slug. See `projectSlugKey`. */
  product_slug: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

/**
 * The key a hub product is stored under in a workspace.
 *
 * Exported so the panel can line a workspace's rows up with the hub's own
 * product list without repeating the normalisation. The two must agree exactly,
 * and the failure mode if they do not is a tile that quietly refuses to launch
 * because it could not find the application it belongs to.
 */
export function projectSlugKey(localProductSlug: string): string {
  return normalizeProductSlug(localProductSlug);
}

/**
 * The applications in one workspace.
 *
 * Read straight from `workspace_projects` rather than through the
 * `workspace_project_overview` view that also exists: the view's columns are not
 * documented anywhere this client can see, and a select naming a column that
 * does not exist fails the whole query rather than degrading. The table's own
 * shape is known, and its policy admits any member of the workspace.
 *
 * Soft-deleted rows are filtered here. The table has `deleted_at` and nothing
 * currently sets it, but a tile for an application that has been removed would
 * be a phantom everyone could click and nobody could open.
 */
export async function listProjects(workspaceId: string): Promise<WorkspaceProject[]> {
  await requireViewer();

  const result = await supabase
    .from("workspace_projects")
    .select("id, workspace_id, name, product_slug, created_by, created_at, updated_at, deleted_at")
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (result.error) {
    throw new Error(
      describe(result.error, "Could not load the applications in this workspace."),
    );
  }

  return ((result.data ?? []) as Row[]).map((row) => ({
    id: String(row.id ?? ""),
    workspace_id: String(row.workspace_id ?? ""),
    name: String(row.name ?? "Untitled application"),
    product_slug: String(row.product_slug ?? ""),
    created_by: toTextOrNull(row.created_by),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    deleted_at: toTextOrNull(row.deleted_at),
  }));
}

/**
 * Add one of the hub's applications to a workspace.
 *
 * `p_initial_project` is an empty object on purpose. The function requires a
 * JSON object and this client does not understand project data — DESIGN.md's
 * whole premise is that the hub moves opaque payloads and never interprets
 * them — so an empty starting document is the honest thing to send. The
 * application itself decides what its data should be once it opens.
 *
 * The slug is normalised here rather than by the caller: the database's pattern
 * is `^[a-z0-9][a-z0-9-]{1,79}$` and the hub's own product list does not satisfy
 * it, so a caller that forgot would get a refusal it could not explain.
 */
export async function addProject(
  workspaceId: string,
  name: string,
  productSlug: string,
): Promise<string> {
  await requireViewer();

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("That application has no name to store.");
  }

  const result = await supabase.rpc("create_workspace_project", {
    p_workspace_id: workspaceId,
    p_name: trimmed,
    p_product_slug: projectSlugKey(productSlug),
    p_initial_project: {},
  });

  if (result.error) {
    throw new Error(
      describe(result.error, "Could not add that application to the workspace."),
    );
  }

  return String(result.data ?? "");
}

// -----------------------------------------------------------------------------
// Workspace lifecycle
// -----------------------------------------------------------------------------

/**
 * Create a workspace and become its owner.
 *
 * One call, not two: `create_shared_workspace` inserts the workspace *and* the
 * caller's OWNER membership in the same transaction. Inserting them separately
 * would leave a window in which a workspace exists with nobody able to touch
 * it, and `workspace_overview` joins the roster — so a half-created workspace
 * would be invisible to its own creator.
 */
export async function createWorkspace(name: string): Promise<string> {
  await requireViewer();

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("Give the workspace a name.");
  }

  const result = await supabase.rpc("create_shared_workspace", { p_name: trimmed });

  if (result.error) {
    throw new Error(describe(result.error, "Could not create the workspace."));
  }

  return String(result.data ?? "");
}

/**
 * Soft-delete a workspace, starting its seven-day countdown.
 *
 * Deliberately not a hard delete. `soft_delete_shared_workspace` stamps
 * `deleted_at` and `purge_after`; `purge_expired_workspaces()` does the
 * destroying later, once the window has passed and nobody has changed their
 * mind.
 */
export async function deleteWorkspace(workspaceId: string): Promise<void> {
  await requireViewer();

  const result = await supabase.rpc("soft_delete_shared_workspace", {
    p_workspace_id: workspaceId,
  });

  if (result.error) {
    throw new Error(describe(result.error, "Could not delete the workspace."));
  }
}

export async function restoreWorkspace(workspaceId: string): Promise<void> {
  await requireViewer();

  const result = await supabase.rpc("restore_shared_workspace", {
    p_workspace_id: workspaceId,
  });

  if (result.error) {
    throw new Error(describe(result.error, "Could not restore the workspace."));
  }
}

// -----------------------------------------------------------------------------
// People
// -----------------------------------------------------------------------------

/**
 * Invite somebody by email.
 *
 * The database resolves the address against an approved hub member or an APRO
 * administrator, and refuses with "No approved APRO account was found for that
 * email" if it matches neither — which is why this can fail on an address a
 * person believes is valid. It is a real constraint of the schema, not a
 * validation the client should try to pre-empt: the hub cannot read the
 * membership table to check first, and even if it could, the check would be a
 * race.
 *
 * Staff are matchable because `public.admins` carries no email of its own, so
 * the lookup falls back to `auth.users` inside the function.
 *
 * Owners only. An editor calling this gets the function's own refusal.
 */
export async function inviteMember(
  workspaceId: string,
  email: string,
  role: WorkspaceRole,
): Promise<string> {
  await requireViewer();

  const result = await supabase.rpc("invite_workspace_member", {
    p_workspace_id: workspaceId,
    p_email: email.trim().toLowerCase(),
    p_role: role,
  });

  if (result.error) {
    throw new Error(describe(result.error, "Could not send that invitation."));
  }

  return String(result.data ?? "");
}

/**
 * Change somebody's role.
 *
 * `p_user_id`, not a membership row id — the table has no such id. The function
 * refuses to alter an OWNER row, so demoting the last owner is not something
 * the client has to prevent.
 */
export async function updateMemberRole(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<void> {
  await requireViewer();

  const result = await supabase.rpc("update_workspace_member_role", {
    p_workspace_id: workspaceId,
    p_user_id: userId,
    p_role: role,
  });

  if (result.error) {
    throw new Error(describe(result.error, "Could not change that member's role."));
  }
}

export async function removeMember(workspaceId: string, userId: string): Promise<void> {
  await requireViewer();

  const result = await supabase.rpc("remove_workspace_member", {
    p_workspace_id: workspaceId,
    p_user_id: userId,
  });

  if (result.error) {
    throw new Error(describe(result.error, "Could not remove that member."));
  }
}

/**
 * Accept or decline an invitation.
 *
 * One function for both, because they are one transition with two ends and
 * splitting them would duplicate the ownership and expiry checks that guard it.
 * A refusal is reported rather than thrown away: the function treats "expired"
 * and "not yours" as the same answer on purpose, so that somebody probing
 * invitation ids learns nothing from the difference.
 */
export async function respondToInvitation(
  invitationId: string,
  accept: boolean,
): Promise<void> {
  await requireViewer();

  const result = await supabase.rpc("respond_to_workspace_invitation", {
    p_invitation_id: invitationId,
    p_accept: accept,
  });

  if (result.error) {
    throw new Error(
      describe(
        result.error,
        accept ? "Could not accept that invitation." : "Could not decline that invitation.",
      ),
    );
  }
}
