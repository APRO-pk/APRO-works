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
| `storage_objects` | **Ours, not the website's.** One row per object in the R2 bucket, keyed by `u/<owner>/self/<sha256>` or `u/<owner>/w/<workspace>/<sha256>`. A null `workspace_id` means private to its owner. |
| `storage_accounts` | **Ours.** One row per person who has ever uploaded, carrying `quota_bytes` (default 1 GiB). Split out from `storage_objects` so one account can be raised without a migration. |

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
| `list_workspace_members(p_workspace_id)` | The only reader that can turn `user_id` values into named people. Falls back to `admins.username` / `auth.users.email` for staff. |
| `invite_workspace_member(p_workspace_id, p_email, p_role)` | Owner only. Resolves the address against an approved member, then against staff in `admins` via `auth.users`. |
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

### The six we added

These came from `supabase/storage/ledger.sql` and exist only for online storage.
The first four are readable by `authenticated`; the two writers are **`service_role`
only**, because a client that could write `byte_size` directly could grant itself
an unlimited allowance.

| Function | Purpose |
| --- | --- |
| `apro_storage_quota(p_user_id)` | That person's allowance, falling back to a literal 1 GiB so a read never creates a row. |
| `apro_storage_used(p_user_id)` | Sum of live `byte_size` across their objects. |
| `my_storage_summary()` | `{used_bytes, quota_bytes, object_count, shared_count}` for `auth.uid()`. What the homescreen progress bar reads. |
| `list_workspace_storage(p_workspace_id)` | The objects shared into one workspace. Raises `42501` when the caller is not a member. |
| `register_storage_object(...)` | **`service_role` only.** Takes a per-user `for update` lock on the account row, refuses anything that would exceed the quota with `23514`, and upserts on `object_key`. |
| `remove_storage_object(p_object_key)` | **`service_role` only.** Soft-deletes and reports whether a row was retired, which is the Worker's cue to delete the R2 object. |

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
**you cannot invite somebody who has not already signed up**. `invite_workspace_member`
resolves the address against the `members` table and falls back to staff in
`admins` (through `auth.users`, since `admins` has no email column), raising
`No approved APRO account was found for that email` if it matches neither.

That is a real product limitation, not an oversight in the client, and the invite
form says so rather than pretending otherwise.

### Staff live in a second identity table

This is the thing that makes the two halves of the app disagree, so it is worth
stating plainly. There are two populations, and they are stored separately:

| | table | key | carries |
|---|---|---|---|
| Approved member | `public.members` | `auth_user_id` | `email`, `full_name`, `member_type`, `account_status` |
| APRO staff | `public.admins` | `auth_id` | `username` only |

Staff are not a flavour of member: the two tables share no key and no row, and
**most administrators have never had a `members` row at all**. Four of the seven
`admins` rows had none: `aliarsalan.u6@gmail.com`, `laibakkhuram@gmail.com`,
`henryarkenberg@gmail.com` and `danishzaryab007@gmail.com`.

Anything that asks "is this person allowed?" must therefore consider both tables.
`apro_is_approved_member` does, and it is what `create_shared_workspace` gates on;
`invite_workspace_member` and `list_workspace_members` were taught the same
fallback so staff can be invited and appear by name in a roster.

RLS supports this without any elevated key: `admins` carries an
`admins_select_own_row` policy (`auth_id = auth.uid()`), so the hub reads the
caller's own staff row on the caller's own token.

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

### Online storage is ours, and lives in R2

R2 rather than Supabase Storage, for a reason the numbers make plain: this
project's free tier gives **1 GB for the whole database**, shared with the live
website, so "1 GB per user" is not something Supabase can express. R2 gives
10 GB-month and — the part that matters when a workspace auto-downloads a
colleague's output — **no egress charge at all**.

The bucket `apro-workspace-storage` is not reachable by any client. Its API is
S3, which has no notion of a user: shipping bucket credentials inside a desktop
app would mean one extracted key reads everybody's gigabyte. So every byte goes
through `cloudflare/workspace-storage`, which derives the key prefix from the
verified session, checks membership with `apro_workspace_role`, and calls the two
writer functions under a service-role key that never leaves the Worker. The
presence room deliberately keeps its no-service-role property; storage is a
different trust level and gets a different Worker.

Three consequences worth remembering:

- **The key is derived, never supplied.** A client says only *what* to store.
- **The quota lives in Postgres, not in R2**, which has no per-user accounting.
  `register_storage_object` takes a `for update` lock on the account row before
  deciding, without which two simultaneous uploads would both read the old total
  and both be allowed.
- **Nothing stored here has meaning.** Which revision is current is a
  `workspace_projects` question, and the hub does not answer it.

## Applied changes

| Date | Change | Why |
| --- | --- | --- |
| 2026-10-07 | `alter policy shared_workspaces_select_participant … using (apro_workspace_role(id) is not null or exists (select 1 from public.workspace_invitations invitation where invitation.workspace_id = shared_workspaces.id and invitation.invited_user_id = auth.uid() and invitation.status = 'PENDING' and invitation.expires_at > now()))` | The policy read `invitation.workspace_id = invitation.id`, comparing the invitation's workspace to its own id — a tautology that is never true. The invitee branch could therefore never match, so somebody with a pending invitation could not read the workspace they were invited to and an invitation card had no name to show. More restrictive than intended, never a leak. |
| 2026-10-07 | `apro_is_approved_member` now returns true for a row in `admins` as well as an APPROVED row in `members`; `invite_workspace_member` falls back to `auth.users ⋈ admins` when the address is not an approved member (message reworded to `No approved APRO account was found for that email`); `list_workspace_members` rewritten to use scalar subqueries with `coalesce(members, admins/auth.users)` instead of a single `left join members`. | Four of the seven administrators have no `members` row, so the old predicate answered "no" for them and `create_shared_workspace` refused them with `Only approved APRO members can create workspaces`. Staff could also not be invited and showed up nameless. Purely additive: a PENDING applicant is still refused (verified), and the subquery rewrite removes a latent row fan-out when a `members.auth_user_id` is duplicated. |

| 2026-10-07 | `supabase/storage/ledger.sql`: created `storage_objects` and `storage_accounts` (both RLS-enabled, SELECT-only policies) plus `apro_storage_quota`, `apro_storage_used`, `my_storage_summary`, `list_workspace_storage` for `authenticated`, and `register_storage_object`, `remove_storage_object` for `service_role` alone. | Backing store for per-user online storage in R2, which has no user model, no quota and no membership — all three have to live somewhere, and this is the database the hub already authenticates against. Deliberately additive and deliberately **without a foreign key to `shared_workspaces`**: a cascade would let `purge_expired_workspaces()` delete accounting rows while the R2 objects they describe still exist, and a new constraint on a table we do not own could block the website's own deletes. Fingerprinted before and after — only these 2 tables and 6 functions were added, every pre-existing count identical. |

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
  workspace; `apro-products` is public. R2 bucket `apro-workspace-storage` backs
  online storage and is **not** purged with a workspace: `storage_objects` has no
  cascade, by design, so a deleted workspace leaves its shared objects accounted
  for. Nothing removes them automatically yet.
- **The R2 bucket is on a different Cloudflare account from the presence room
  that preceded it.** Both Workers now live on the one account that can hold a
  billing method. The room was redeployed there rather than migrated, because it
  holds no durable user data — cursors are in memory and identity lives in the
  socket attachment.
