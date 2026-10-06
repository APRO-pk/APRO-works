# Supabase

The durable half of APRO Works **Workspaces**: the workspace, its roster, its
role assignments, and the entities that live inside it. The live half — cursors,
who is online — is not here; it is the Durable Object in
`cloudflare/workspace-room/`.

Both halves read the same project: **`zljhwosvsdqvgcgusqct`**, the one in the
repository root `.env`.

## This schema is not ours

Read this before changing anything in this directory.

The workspace tables and functions were **already in this database** when the
desktop feature was written. They belong to the APRO website, which is a second
consumer of the same data, and they were live — two workspaces, four
memberships, five projects and two invitations existed on day one. The desktop
hub is a *client* of this schema, not its author.

Three consequences:

1. **There are no migrations in this repository, and there should not be any
   invented ones.** An earlier attempt at `migrations/0001_workspaces.sql` was
   written against an assumed schema. It would have hit
   `create table if not exists`, silently skipped every table that already
   existed, and then layered its own functions and RLS policies on top of a live
   feature. It failed on the first constraint it touched —
   `ERROR: 42703: column m.email does not exist` — and the Management API runs a
   submitted batch atomically, so nothing was applied. Every policy in this
   database still carries a comment-free, hand-reviewed shape that took real
   thought; do not paper over it.

2. **A schema change is a change to the website.** Anything altered here must be
   checked against the other consumer first.

3. **If you do need a migration**, put it in a file, apply it once, record what
   was applied and when at the bottom of this document, and never edit it
   afterwards. A migration that has run is a fact about the database, and
   rewriting it makes the database's history disagree with the repository's.

### Administering this project

There is no CI step and no Supabase CLI state committed. Running SQL needs a
**Management API token** — a credential the hub never uses and never ships. It
is not the publishable key, and it can do anything the project's owner can.
Create one at <https://supabase.com/dashboard/account/tokens>, put it in
`.secrets/` (git-ignored), and:

```powershell
$token = ([regex]::Match(
  [System.IO.File]::ReadAllText("$PWD\.secrets\supabase-access-token", [Text.Encoding]::UTF8),
  'sbp_[A-Za-z0-9]+')).Value

$json = '{"query":' + (ConvertTo-Json -InputObject $sql -Compress) + '}'
$json = [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })

Invoke-RestMethod -Method Post `
  -Uri 'https://api.supabase.com/v1/projects/zljhwosvsdqvgcgusqct/database/query' `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType 'application/json' `
  -Body ([System.Text.Encoding]::ASCII.GetBytes($json))
```

Two platform details that cost real time to rediscover:

- Windows PowerShell 5.1 decodes UTF-8 files as ANSI, so `Get-Content -Raw`
  turns an em dash into `â€”` and the request body is then rejected or mangled.
  `[System.IO.File]::ReadAllText(path, [Text.Encoding]::UTF8)` is the fix, and
  escaping non-ASCII before sending is the belt to that pair of braces.
- `ConvertTo-Json` on a hashtable wraps a string as `{"query":{"value":"…"}}`,
  which the endpoint rejects. Building the JSON string by hand, as above, is
  what works.

`pg_get_functiondef` also fails with
`ERROR: 42809: "array_agg" is an aggregate function` unless the query filters
`p.prokind = 'f'`.

## What is actually there

### Tables

| Table | Notes |
| --- | --- |
| `shared_workspaces` | `name`, `owner_user_id`, `product_slug`, `current_revision_id`, `created_at`, `updated_at`, `deleted_at`, `purge_after`. |
| `workspace_members` | Keyed by `(workspace_id, user_id)`. **No `email` column.** `role` is a `text` column, not an enum. |
| `workspace_invitations` | `invited_user_id` is `NOT NULL` **and** carries `invited_email`. Expires after 14 days. |
| `workspace_projects` | One row per application added to a workspace. `product_slug` is constrained to `^[a-z0-9][a-z0-9-]{1,79}$`. |
| `workspace_project_live_state` | The current JSON document per project, plus a `sequence`. |
| `workspace_project_revisions` | Immutable snapshots, `revision_number` + `base_revision_id`. |
| `workspace_locks` | One row per workspace. A 90-second single-editor lease. |
| `workspace_activity` | Append-only audit log. |
| `workspace_revisions` | An older workspace-level revision model, alongside the per-project one. |

Two views, both `security_invoker = true` so row-level security applies through
them: `workspace_overview` (adds the caller's `role` and a `project_count`) and
`workspace_project_overview`.

### Functions

All are `security definer` with `search_path` pinned. The ones the desktop app
calls:

| Function | Purpose |
| --- | --- |
| `apro_workspace_role(p_workspace_id, p_user_id default auth.uid())` | The single access predicate. Returns `OWNER \| EDITOR \| VIEWER`, or NULL. |
| `create_shared_workspace(p_name)` | Creates the workspace **and** the caller's OWNER row in one transaction. |
| `list_workspace_members(p_workspace_id)` | The only reader that can turn `user_id` values into named people. |
| `invite_workspace_member(p_workspace_id, p_email, p_role)` | Owner only. Resolves the address against an approved member. |
| `respond_to_workspace_invitation(p_invitation_id, p_accept)` | Accept or decline, with the ownership and expiry checks attached. |
| `update_workspace_member_role(p_workspace_id, p_user_id, p_role)` | Owner only; refuses to touch an OWNER row. |
| `remove_workspace_member(p_workspace_id, p_user_id)` | Owner only; same refusal. |
| `soft_delete_shared_workspace(p_workspace_id)` | Stamps `deleted_at` and a seven-day `purge_after`. |
| `restore_shared_workspace(p_workspace_id)` | Clears both. |
| `purge_expired_workspaces()` | Destroys expired workspaces and their `workspace-files` objects. |

The rest — `create_workspace_project`, `apply_workspace_project_patches`,
`publish_workspace_project_snapshot`, `acquire_workspace_lock`,
`renew_workspace_lock`, `release_workspace_lock`, `publish_workspace_revision` —
belong to the project-data model, which the desktop hub does not use yet.

## How the schema is shaped, and why

### Writes only ever go through a function

Every table grants `authenticated` **`SELECT` and nothing else**. There are no
`INSERT`, `UPDATE` or `DELETE` policies anywhere in this schema. The invariants
live in the functions: a workspace cannot be created without an owner, an owner
row cannot be removed or demoted, an invitation cannot be accepted twice or
after it expires.

This is worth stating plainly because getting it wrong is silent. An
`UPDATE` on `workspace_members` from the client does not raise — RLS denies it by
matching zero rows, and PostgREST reports success with an empty result. An
implementation that reached for the table directly would appear to work and
would not.

`src/lib/workspaces.ts` therefore contains no `.insert()`, `.update()` or
`.delete()` call, and should never gain one.

### Membership is keyed by user, not by email

`workspace_members.user_id` is `NOT NULL` and there is no address column. Coupled
with `workspace_invitations.invited_user_id` also being `NOT NULL`, this means
**you cannot invite somebody who has not already signed up and been approved**.
`invite_workspace_member` resolves the address against the
`members` table and raises
`No approved APRO member was found for that email` if there is no match.

That is a real product limitation, not an oversight in the client, and the invite
form says so rather than pretending otherwise.

### Roles are three, and they are ordered

`OWNER | EDITOR | VIEWER`, as text. `apro_workspace_role` is the only place the
ordering is decided, and every policy is written in terms of it — which is why
adding a role later means changing that function and the policies, and nothing in
the client beyond a label.

Note the absence of `ADMIN` or `MEMBER`: an earlier design in this repository
assumed both. There is no ownership transfer function either; adding one is a
future migration.

### Soft delete, then purge

`soft_delete_shared_workspace` is reversible for seven days and
`purge_expired_workspaces()` does the destroying. `workspace_overview` does
**not** filter `deleted_at` — deliberately, so a deleted workspace can still be
shown with a way back — so every reader has to decide what to do with it. The
hub shows them under "Recently deleted".

### Realtime covers project data and nothing else

Exactly two tables are in the `supabase_realtime` publication:
`workspace_project_live_state` and `works_projects`. The tables the hub's
workspace directory reads — `shared_workspaces` and `workspace_invitations` — are
**not** published, and adding them would be the wrong fix: row-level security on
`postgres_changes` is only enforced for private channels, so a public
subscription to `shared_workspaces` would broadcast every workspace's existence
to every signed-in client.

The hub therefore refreshes its directory on mount, when the window regains focus
(throttled to one read per five seconds), and after its own mutations. Cursors,
where immediacy is the entire point, go over the Durable Object instead.

## Applied changes

| Date | Change | Why |
| --- | --- | --- |
| 2026-10-07 | `alter policy shared_workspaces_select_participant … using (apro_workspace_role(id) is not null or exists (select 1 from public.workspace_invitations invitation where invitation.workspace_id = shared_workspaces.id and invitation.invited_user_id = auth.uid() and invitation.status = 'PENDING' and invitation.expires_at > now()))` | The policy read `invitation.workspace_id = invitation.id`, comparing the invitation's workspace to its own id — a tautology that is never true. The invitee branch could therefore never match, so somebody with a pending invitation could not read the workspace they were invited to and an invitation card had no name to show. More restrictive than intended, never a leak. |

## Known hazards

- **Product slugs do not all fit the constraint.**
  `create_workspace_project` requires `^[a-z0-9][a-z0-9-]{1,79}$`, and the hub's
  own product list contains `"Propulsor - Liquid Engine Design Studio"` — spaces
  and capitals. This is DESIGN.md risk R5 becoming concrete. It is reconciled in
  the client by `normalizeProductSlug()` in `src/lib/workspaces.ts`, which is
  written and documented but **not yet called**, because the hub does not create
  projects yet.
- **`apply_workspace_project_patches` has no version check.** It bumps
  `sequence` but does not compare the caller's expectation against it, so two
  writers can interleave. `workspace_locks` is what currently prevents that, and
  it is advisory: it expires after 90 seconds whether or not the holder is still
  working.
- **Storage.** Bucket `workspace-files` is private and is purged with its
  workspace; `apro-products` is public.
