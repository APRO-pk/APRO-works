# apro-workspace-storage

The edge in front of per-user online storage. Every user of APRO Works gets a
gigabyte for the file outputs their applications produce; the bytes live in the
R2 bucket `apro-workspace-storage`, the accounting lives in Supabase, and this
Worker is the only thing that holds both.

Deployed at **https://apro-workspace-storage.henryarkenberg.workers.dev**.

## Why this is a separate Worker from `workspace-room`

The presence room's cleanest property is that it holds no service-role key and
therefore cannot read anything its caller could not. Storage needs the opposite:
the ledger's two writers are revoked from `authenticated`, so somebody
trustworthy has to call them. Two deployments keep that property true of the
room — a mistake here cannot reach into a live socket's authorisation.

## Why the client never touches R2 directly

An R2 bucket is reachable with an account key and addresses whatever object it is
told to. Shipping that key in a desktop app would mean one extracted string reads
everybody's gigabyte. So the key stays here, and the object key is derived from a
token the caller had to present:

```
u/<owner_user_id>/w/<workspace_id>/<sha256>   shared into a workspace
u/<owner_user_id>/self/<sha256>               private to its owner
```

The owner segment is what makes a key unforgeable in practice — a caller can only
write under their own id — and a workspace segment is only accepted after
`apro_workspace_role()` has confirmed a place in that workspace. That is the same
function every row-level policy in the workspaces schema is built from, so the
permission checked here and the one PostgREST enforces cannot drift apart.

The key is the content hash, which makes an upload repeatable: the same bytes
produce the same key, and `register_storage_object` recognises the row and
subtracts the old size instead of charging twice.

## Routes

All of them need `Authorization: Bearer <supabase access token>`. A token is
**never** accepted in the query string here — unlike the presence room, nothing
in this Worker is a `WebSocket`, so there is no reason to put a credential
somewhere it can be logged.

| Route | Does |
| --- | --- |
| `GET /health` | Liveness. No auth. |
| `GET /storage/summary` | `my_storage_summary()` — `used_bytes`, `quota_bytes`, `object_count`, `shared_count`. This is the progress bar. |
| `GET /storage/objects` | The caller's own objects, private and shared alike, newest first, capped at 200. |
| `GET /storage/objects?workspace_id=<uuid>` | Everything shared into that workspace, plus `total_bytes` and `object_count`. Membership required. |
| `POST /storage/objects[?workspace_id=<uuid>][&label=…]` | Upload. Raw bytes as the body; `Content-Type` is recorded. `OWNER` or `EDITOR` only when a workspace is named. |
| `GET /storage/blob?id=<uuid>` | The bytes. Visibility is decided by the same policy that decides what can be listed, so a workspace peer passes and a stranger does not. |
| `DELETE /storage/objects?id=<uuid>` | Owner only. Retires the ledger row, then the R2 object. |

Statuses worth knowing: **413** when a body exceeds the per-object ceiling,
**507** when the caller is over quota (the database's message is passed through
verbatim), **403** when a `VIEWER` tries to upload into a workspace, **502** when
R2 and the ledger disagree.

## The per-object ceiling

25 MiB. The reason is mechanical rather than a policy: the object key is the
content hash, and `crypto.subtle.digest` needs the whole thing in memory before
it produces one, while a Worker only gets 128 MB. R2 would happily take a
streamed upload many times this size — it is the content addressing that sets the
ceiling, and it is worth the ceiling.

## Secrets

Two, both Worker secrets, neither in the repository:

```powershell
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

`SUPABASE_ANON_KEY` is the same publishable value that is compiled into the
desktop app; it is kept out of `wrangler.jsonc` only so that the config stays
reviewable without wondering which of its strings are load-bearing.

`SUPABASE_SERVICE_ROLE_KEY` is the real one. It bypasses every row-level policy
in the project and is used for exactly two calls — `register_storage_object` and
`remove_storage_object` — both of which are revoked from `authenticated` on
purpose, because a client that could write `byte_size` itself could write itself
an unlimited allowance in one request. Rotating it invalidates this Worker until
the secret is set again; the presence room is unaffected.

**On this machine, `wrangler secret put` must be piped from an absolute path.** A
`Select-String .env` run from inside this directory finds nothing, and an empty
value is accepted silently — the first attempt at the room's secret pushed an
empty string this way.

## Quota

Not counted here. It is counted by `register_storage_object()`, inside the same
transaction that records the object, because a count kept in the Worker would be
a second source of truth and would be wrong the first time two uploads raced.
This Worker's job with respect to quota is to translate the database's refusal
into an HTTP status.

The upload order follows from that: **the ledger is written before the bucket.**
Uploading first and recording afterwards would let two simultaneous uploads each
pass a check against a total neither had yet changed. Registering first means an
over-quota upload costs one round trip and no bytes. The price is the cleanup
path — if R2 refuses after the row exists, the row is retired with the same
service-role key, and if *that* fails the honest result is a row for bytes that
were never stored. A missing object is therefore reported as a 502, not a 404.

Deletion runs the other way: **the ledger first, then R2.** That frees the
caller's quota even if R2 is unreachable, at the cost of bytes in the bucket with
nothing pointing at them — which costs us storage and costs the user nothing. The
opposite order would charge somebody for a file they had already deleted.

## Not done yet

- **Nothing tells a peer that a new revision exists.** The bytes upload and a
  workspace member can list and fetch them, but the "auto-download into their
  application" half needs the Durable Object room to broadcast a frame when an
  upload completes. The room is already membership-authorised, which is where
  that belongs.
- **Orphaned R2 objects are not swept.** A failed delete leaves bytes that no row
  points at and no quota counts. Reclaiming them needs a listing job, not a
  bigger Worker.
- **Nothing uploads yet.** No product in this hub calls `store.push()` with real
  output, so the bucket is empty by design. `docs/APP_INTEGRATION.md` is the
  contract the products implement; the hub cannot watch an output directory,
  because the design deliberately forbids handing the store a file path.

## Deploy

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "1ca3a30a82f07276f864c74dd55b17eb"
npx tsc --noEmit                 # must be clean
npx wrangler deploy --dry-run --outdir=.dry-run
npx wrangler deploy
```

`account_id` is pinned in `wrangler.jsonc` so a deploy from another machine
cannot land in the wrong account.
