-- ============================================================================
-- Per-user online storage — the accounting ledger behind Cloudflare R2.
--
-- The bytes live in R2 (bucket `apro-workspace-storage`). The object key is
-- derived server-side by the storage Worker, never by the client. This file adds
-- only the *bookkeeping*: what exists, who owns it, which workspace may see it,
-- and how much of the 1 GiB allowance is spent.
--
-- ADDITIVE ONLY. Nothing here alters an existing table, function or policy. This
-- database belongs to the APRO website and is not ours to reshape; see
-- `../README.md`.
--
-- Deliberately NO foreign key to `shared_workspaces`. Two reasons:
--   1. A cascade would let the website's `purge_expired_workspaces()` delete
--      accounting rows while the R2 objects they describe are still in the
--      bucket — losing the only record of bytes somebody is still being billed
--      for.
--   2. A new constraint that references a table we do not own can start blocking
--      the website's own deletes.
--
-- Key shape, decided here because the ledger stores it:
--     u/<owner_user_id>/w/<workspace_id>/<sha256>
-- Content-addressed, so re-uploading identical bytes is a no-op at the same key
-- (matching the local store in `crates/apro-store/src/blob.rs`). Scoped by
-- workspace rather than shared across workspaces, which costs a second copy when
-- the same file belongs to two workspaces but makes one row mean exactly one
-- thing. The alternative — one key, many workspaces — needs a join table and
-- makes `byte_size` count once per row, which is the wrong number for a quota.
-- ============================================================================

create table if not exists public.storage_accounts (
  user_id     uuid primary key,
  -- 1 GiB by default. Per row rather than a constant so one person can be given
  -- more without a migration.
  quota_bytes bigint not null default 1073741824 check (quota_bytes > 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.storage_objects (
  id            uuid primary key default extensions.gen_random_uuid(),
  owner_user_id uuid not null,
  -- Null is allowed and means "private to its owner": counted against the quota,
  -- visible to nobody else.
  workspace_id  uuid,
  object_key    text not null unique,
  content_hash  text not null,
  byte_size     bigint not null check (byte_size >= 0),
  content_type  text,
  label         text,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create index if not exists storage_objects_owner_live_idx
  on public.storage_objects (owner_user_id) where deleted_at is null;
create index if not exists storage_objects_workspace_live_idx
  on public.storage_objects (workspace_id) where deleted_at is null;

alter table public.storage_accounts enable row level security;
alter table public.storage_objects  enable row level security;

-- Reads: your own rows, plus anything shared into a workspace you belong to. The
-- second half is what lets a colleague's uploaded revision be discovered at all.
drop policy if exists storage_objects_select_visible on public.storage_objects;
create policy storage_objects_select_visible on public.storage_objects
  for select to authenticated
  using (
    owner_user_id = auth.uid()
    or (workspace_id is not null and public.apro_workspace_role(workspace_id) is not null)
  );

drop policy if exists storage_accounts_select_own on public.storage_accounts;
create policy storage_accounts_select_own on public.storage_accounts
  for select to authenticated
  using (user_id = auth.uid());

-- No insert/update/delete policy anywhere: every write goes through a
-- SECURITY DEFINER function below. A client able to write `byte_size` directly
-- could write itself an unlimited allowance.
grant select on public.storage_objects  to authenticated;
grant select on public.storage_accounts to authenticated;
grant all    on public.storage_objects  to service_role;
grant all    on public.storage_accounts to service_role;


-- ---------------------------------------------------------------------------
-- The allowance. Stable, so no row is created on a read path.
-- ---------------------------------------------------------------------------
create or replace function public.apro_storage_quota(p_user_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select account.quota_bytes
       from public.storage_accounts account
      where account.user_id = p_user_id),
    1073741824
  );
$$;


-- ---------------------------------------------------------------------------
-- Bytes currently stored for one user.
-- ---------------------------------------------------------------------------
create or replace function public.apro_storage_used(p_user_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(object.byte_size), 0)
    from public.storage_objects object
   where object.owner_user_id = p_user_id
     and object.deleted_at is null;
$$;


-- ---------------------------------------------------------------------------
-- Everything the progress bar needs, in one round trip.
-- ---------------------------------------------------------------------------
create or replace function public.my_storage_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = '28000';
  end if;

  return jsonb_build_object(
    'used_bytes',   public.apro_storage_used(v_user),
    'quota_bytes',  public.apro_storage_quota(v_user),
    'object_count', (select count(*) from public.storage_objects object
                      where object.owner_user_id = v_user and object.deleted_at is null),
    'shared_count', (select count(*) from public.storage_objects object
                      where object.owner_user_id = v_user and object.deleted_at is null
                        and object.workspace_id is not null)
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- What a workspace can see. Membership checked here, not left to RLS, so a
-- non-member gets a sentence rather than an empty list that looks like "nothing
-- has been uploaded".
-- ---------------------------------------------------------------------------
create or replace function public.list_workspace_storage(p_workspace_id uuid)
returns table (
  id            uuid,
  owner_user_id uuid,
  object_key    text,
  content_hash  text,
  byte_size     bigint,
  content_type  text,
  label         text,
  created_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '28000';
  end if;

  if public.apro_workspace_role(p_workspace_id) is null then
    raise exception 'You do not have access to this workspace.' using errcode = '42501';
  end if;

  return query
    select object.id, object.owner_user_id, object.object_key, object.content_hash,
           object.byte_size, object.content_type, object.label, object.created_at
      from public.storage_objects object
     where object.workspace_id = p_workspace_id
       and object.deleted_at is null
     order by object.created_at;
end;
$$;


-- ---------------------------------------------------------------------------
-- Writes. service_role only — these are called by the storage Worker *after* it
-- has authenticated the caller and checked workspace access. The desktop app
-- must never be able to reach them.
-- ---------------------------------------------------------------------------
create or replace function public.register_storage_object(
  p_owner_user_id uuid,
  p_object_key    text,
  p_content_hash  text,
  p_byte_size     bigint,
  p_workspace_id  uuid default null,
  p_content_type  text default null,
  p_label         text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    uuid;
  v_quota bigint;
  v_used  bigint;
  v_old   bigint := 0;
begin
  if p_owner_user_id is null then
    raise exception 'An owner is required.' using errcode = '22023';
  end if;

  if p_object_key is null or p_object_key = '' then
    raise exception 'An object key is required.' using errcode = '22023';
  end if;

  if p_byte_size is null or p_byte_size < 0 then
    raise exception 'A non-negative size is required.' using errcode = '22023';
  end if;

  -- A key is namespaced by owner, so this cannot happen through the Worker. It
  -- would mean the key derivation is wrong, which is worth failing loudly for.
  if exists (select 1 from public.storage_objects object
              where object.object_key = p_object_key
                and object.owner_user_id <> p_owner_user_id) then
    raise exception 'That object key belongs to another account.' using errcode = 'check_violation';
  end if;

  -- Serialise this user's registrations. Without the lock, two simultaneous
  -- uploads both read the old total and both pass the quota check.
  insert into public.storage_accounts (user_id) values (p_owner_user_id)
  on conflict (user_id) do nothing;

  select account.quota_bytes into v_quota
    from public.storage_accounts account
   where account.user_id = p_owner_user_id
     for update;

  -- Re-registering the same key replaces its previous size rather than adding it.
  select coalesce(sum(object.byte_size), 0) into v_old
    from public.storage_objects object
   where object.object_key = p_object_key
     and object.deleted_at is null;

  select coalesce(sum(object.byte_size), 0) into v_used
    from public.storage_objects object
   where object.owner_user_id = p_owner_user_id
     and object.deleted_at is null;

  if v_used - v_old + p_byte_size > v_quota then
    raise exception 'Not enough online storage: % of % bytes already used.',
      v_used - v_old, v_quota
      using errcode = 'check_violation';
  end if;

  insert into public.storage_objects as object
    (owner_user_id, workspace_id, object_key, content_hash, byte_size, content_type, label)
  values
    (p_owner_user_id, p_workspace_id, p_object_key, p_content_hash, p_byte_size, p_content_type, p_label)
  on conflict (object_key) do update
    set workspace_id = excluded.workspace_id,
        content_hash = excluded.content_hash,
        byte_size    = excluded.byte_size,
        content_type = excluded.content_type,
        label        = excluded.label,
        deleted_at   = null
  returning object.id into v_id;

  return v_id;
end;
$$;


-- Soft delete. Returns whether a row was actually retired, which is the Worker's
-- cue to delete the R2 object. A second call returns false and does nothing.
create or replace function public.remove_storage_object(p_object_key text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  update public.storage_objects object
     set deleted_at = now()
   where object.object_key = p_object_key
     and object.deleted_at is null
  returning object.owner_user_id into v_owner;

  return v_owner is not null;
end;
$$;


-- ---------------------------------------------------------------------------
-- ACL. Functions are EXECUTE-to-PUBLIC by default, so the revoke is the part
-- that matters: without it `anon` could call a service_role-only writer.
-- ---------------------------------------------------------------------------
revoke all on function public.apro_storage_quota(uuid) from public, anon;
revoke all on function public.apro_storage_used(uuid) from public, anon;
revoke all on function public.my_storage_summary() from public, anon;
revoke all on function public.list_workspace_storage(uuid) from public, anon;
revoke all on function public.register_storage_object(uuid, text, text, bigint, uuid, text, text) from public, anon, authenticated;
revoke all on function public.remove_storage_object(text) from public, anon, authenticated;

grant execute on function public.apro_storage_quota(uuid) to authenticated, service_role;
grant execute on function public.apro_storage_used(uuid) to authenticated, service_role;
grant execute on function public.my_storage_summary() to authenticated, service_role;
grant execute on function public.list_workspace_storage(uuid) to authenticated, service_role;
grant execute on function public.register_storage_object(uuid, text, text, bigint, uuid, text, text) to service_role;
grant execute on function public.remove_storage_object(text) to service_role;
