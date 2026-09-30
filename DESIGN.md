# APRO Works — Local Orchestration Layer

**Status:** Implemented for M0–M2. See "Implementation status" below.
**Scope:** Local-only data orchestration between APRO Works (the hub) and the products it installs and launches.
**Out of scope for now:** cloud sync, multi-user sharing, network transport.

## Implementation status

Built and tested (37 workspace tests, 28 `npm run verify:workflow` checks, 16 `aproctl selftest` checks):

| Crate | Contents |
| --- | --- |
| `crates/apro-store` | SQLite schema + migrations, content-addressed blob store, push/pull, revisions, dependency edges, event log, demo seed/purge |
| `crates/apro-api` | axum server on loopback, launch-ticket → session auth, full endpoint set, 512 MiB body limit |
| `crates/apro-client` | `AproStoreClient` trait, `HttpStoreClient`, `LocalStoreClient`, launch-environment discovery |
| `crates/aproctl` | `serve`, `seed`, `purge-demo`, `doctor`, `selftest`, `ls`, `edges`, `events`, `stats` |
| `src-tauri` | Store lifecycle in-process, ticket minting via the auth registry, `--apro-store-endpoint` handoff, `get_store_status` / `seed_store_demo` / `purge_store_demo` commands |

Not yet built: the hub "Data" UI section (§11 M4), protobuf codegen (§6.2), cloud transport
(§11 M5), and the hide-to-tray close behaviour required by §7 R1.


---

## 1. Context

This repository is the **hub/launcher**, not an application. Current facts established by reading the code:

| Fact | Location |
| --- | --- |
| Tauri v2 + React 19 + Vite + Tailwind 4 | `package.json`, `src-tauri/Cargo.toml` |
| 4 backend commands: `get_product_status`, `install_product`, `launch_product`, `uninstall_product` | `src-tauri/src/lib.rs` |
| Products are separate executables extracted to `%LOCALAPPDATA%\APRO\Products\<slug>\` | `apro_products_dir()` in `lib.rs` |
| Product registry is a hardcoded array of 3 apps | `products` in `src/App.tsx` |
| Supabase is used for **authentication only** (the `member` table) | `src/lib/supabase.ts`, `validateApprovedMember()` |
| Close button calls `appWindow.destroy()` | `handleClose()` in `src/App.tsx` |

**The only existing hub↔app channel** is the launch handoff: `launch_product_sync()` writes a `LaunchTicket` to `%LOCALAPPDATA%\APRO\LaunchTickets\<token>.json` and spawns the child with `--apro-product-slug` and `--apro-launch-token`. Note that the hub **creates tickets but never validates them** — validation is implicitly delegated to the child app. This is already the trust boundary; it is currently a stub and will be made real.

There is no data plane of any kind. This is greenfield.

---

## 2. The central design decision

> "a generalized form of data"

Taken literally — one universal aerospace schema that every app maps into — this is a months-long ontology project that ships nothing and is wrong on first contact.

The motivating example tells us what the generalized form actually is:

> A CAD model is created in the Burn & Geometry Modeler, then consumed by HexaDOF. Editing the model invalidates the 6DOF run until the user accepts an update.

The hub does **not** need to understand grain geometry to make this work. It needs to know:

> artifact *M* exists, it is owned by *burn-geometry-modeler*, it is at revision 14, and HexaDOF's run *R* was computed against revision 12.

**Therefore: the generalized layer is a revisioned artifact + dependency graph, not a universal payload schema.**

| Layer | Owner | Hub understands? |
| --- | --- | --- |
| Envelope — artifacts, revisions, edges | Hub | Yes, fully |
| Payload — the actual domain data | Owning app | No — opaque bytes + a `type_id` |

Staleness, notification, and auto-update all fall out of the graph mechanically. Payloads stay owned by the apps that define them. This is what makes the problem tractable.

---

## 3. Decisions log

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | Envelope/graph layer only; payloads opaque | Avoids inventing an aerospace ontology up front (§2) |
| D2 | Payload `encoding` is a **per-revision** property (`protobuf` \| `json` \| `blob`) | Lets M1 ship before schemas are settled; protobuf adopted type-by-type without re-architecting |
| D3 | Revisions are **immutable**; "updates" create new revisions | No write conflicts, free audit trail, free sync merge policy, no in-place corruption |
| D4 | Dependency edges carry a `mode`: `pinned` \| `tracking` \| `compatible` | Reproducibility is configurable; both auto-update and frozen-audit are expressible |
| D5 | **Default mode is `pinned`**, `tracking` is explicit opt-in | Tracking-by-default silently destroys reproducibility and the loss is not noticed until a result must be defended. Pinned fails safe. |
| D6 | Content-addressed blob store for large/binary payloads | CAD models are large binaries, not protobuf messages; dedup and integrity for free |
| D7 | Loopback HTTP transport, transport hidden behind a Rust trait | Contract survives the move to cloud unchanged; curl-debuggable; language-agnostic escape hatch |
| D8 | Store hosted **in-process** in the hub | User decision. Fewer moving parts for v1. See R1 for the mitigation this requires. |
| D9 | Core lives in separate crates, not in `lib.rs` | Crate boundary preserves the option of extracting a daemon later as a packaging change, not a rewrite |
| D10 | All apps are Rust/Tauri ⇒ one shared client crate, build-time codegen | Removes the polyglot SDK proliferation risk entirely |
| D11 | Identity anchored to the existing Supabase `member` record + a per-install `node_id` | Login already exists; this is exactly what a future sync/merge needs, at near-zero cost |
| D12 | Hub never re-serializes a decoded message | decode→JSON→encode silently drops unknown fields and breaks forward compatibility |
| D13 | App-facing API is a flat **tag push/pull facade**; artifact/revision/edge semantics live underneath | App authors integrate in an hour without learning the storage model. Adoption is the top risk. |
| D14 | **Notify-then-pull.** The hub pushes change *notifications*, never payloads; apps pull bytes on demand | Eager fan-out creates N×M copies and lets apps fork data by editing local copies. Hub stays single source of truth; apps hold references. |
| D15 | On push the hub **snapshots bytes**; it never stores a file path | A stored path can change under a revision, silently invalidating all versioning |
| D16 | Static manifest (trusted, enforced) **union** runtime `declare()` (recorded, visible, not pre-trusted) | Runtime-only loses pre-launch visibility and write validation; static-only loses flexibility |
| D17 | Identity is the triple **type × instance × format** | Collapsing instance into type makes "which revision did this depend on" unanswerable — breaks the motivating example |
| D18 | A **subscription** (type-level) is the durable wire; concrete `edge` rows are materialised from it | The canvas wires applications, so a wire names a *kind* of data, not a particular design. Forcing the UI to pick an instance would put a choice in front of the user that they never made. |
| D19 | Materialisation only **inserts** (`ON CONFLICT DO NOTHING`), never upserts | Re-syncing must not reset `last_satisfied_revision_id`. Using `register_edge`'s upsert would silently mark every dependency fresh and destroy the freshness signal the graph exists to provide. |
| D20 | Reads are logged in a **separate `access_log`**, never in `event` | Consumers poll `event` with a cursor to learn what *changed*. Read records in that feed would spam every app's change loop with entries it does not care about. |

---

## 4. Architecture

### 4.1 Crate layout

```
APRO-works/
  src-tauri/            # existing hub app (UI + install/launch). Gains: store lifecycle + new commands
  crates/
    apro-schemas/       # .proto sources + prost-build codegen (build.rs)
    apro-store/         # storage engine: SQLite, blob store, event log. No HTTP, no Tauri.
    apro-api/           # axum server on 127.0.0.1 + auth + DTOs. Wraps apro-store.
    apro-client/        # the trait + types every product app depends on
```

`apro-store` and `apro-api` must not depend on `tauri`, and must not import from `lib.rs`. That is the boundary that keeps D9 honest.

### 4.2 Process topology (v1)

```
┌──────────────────────────── APRO Works (hub process) ────────────────────────────┐
│  React UI  ──invoke──▶  Tauri commands (lib.rs)                                   │
│                              │                                                    │
│                              ├── apro-store ──▶ SQLite (WAL) + blob dir           │
│                              └── apro-api   ──▶ axum @ 127.0.0.1:<ephemeral>      │
└───────────────────────────────────▲───────────────────────────────────────────────┘
                                    │  loopback HTTP + session token
                        ┌───────────┴───────────┐
                        │                       │
                 Burn & Geometry            HexaDOF
                 (apro-client)              (apro-client)
```

### 4.3 Transport & discovery

- Bind to `127.0.0.1:0` so the OS assigns a free port. Never bind `0.0.0.0`.
- **Primary discovery: launch arguments.** Extend the existing handoff in `launch_product_sync()`:

  ```
  <exe> --apro-product-slug <slug> --apro-launch-token <token> \
        --apro-store-endpoint http://127.0.0.1:<port> --apro-store-token <session>
  ```

- **Fallback discovery:** a small `%LOCALAPPDATA%\APRO\store.json` holding `{endpoint, instance_id, pid}`, for apps launched outside the hub (dev, direct exe launch).
- Any local process can read that file, so **the token is the gate, not the port**. Treat the token as a credential.

### 4.4 Authentication

Fixes the current stub (§1) and the 90-second TTL problem for long-lived apps:

```
POST /v1/session   Authorization: Bearer <launch-ticket>
  → { session_token, expires_at, app_slug, scopes[] }
```

- Launch tickets stay short-lived (90 s) and single-use; they are exchanged once at app startup.
- Session tokens are longer-lived (e.g. 12 h) and may be refreshed.
- A session is **scoped to one `app_slug`** and carries the scopes declared by that app's manifest. This shape exists from day one so authorization can be tightened without re-issuing a token format.

### 4.5 Product manifest

Each product archive ships a manifest declaring its data contract. The hub reads it at install time.

```json
{
  "app_slug": "burn-geometry-modeler",
  "manifest_version": 1,
  "publishes": [
    { "type_id": "burn-geometry-modeler/grain-geometry-v1",
      "cardinality": "many" }
  ],
  "consumes": [
    { "type_id": "apro-core/propellant-v1",
      "default_mode": "pinned" }
  ]
}
```

- The hub **validates writes against `publishes`** — an app cannot write a type it did not declare. Cheap enforcement, prevents accidental cross-app corruption.
- `default_mode` seeds the `mode` on new edges (D5).
- Type ids are namespaced strings owned by the declaring app. `apro-core/*` is reserved for hub-defined types. Type ownership is **decentralized** — the hub does not gatekeep new type ids, it only records them in `type_registry`.

**Prerequisite cleanup:** slugs must be path- and URL-safe. The current registry violates this — `"Propulsor - Liquid Engine Design Studio"` contains spaces and is joined directly into a filesystem path by `product_install_dir()`. Type ids derive from slugs, so **all slugs must be normalized to kebab-case before any of this is built.**

### 4.6 The client-facing tag interface (D13)

This is the entire surface an app author learns. Everything in §5 is implementation detail behind it.

```rust
// Declare: usually once at startup from the manifest; safe to call repeatedly to
// add runtime tags. Static (manifest) and runtime declarations are unioned (D16);
// only statically declared tags are pre-trusted for writes.
store.declare(AppInterface {
    app: "burn-geometry-modeler",
    publishes: [Tag::new("grain-geometry"), Tag::new("burn-profile")],
    consumes:  [(Tag::new("propellant"), Mode::Pinned)],
});

// Push -> immutable revision handle. Bytes are snapshotted (D15).
// If the instance does not exist it is created; otherwise this appends a revision.
let rev = store.push(
    Tag::new("grain-geometry"),      // TYPE     — semantics, who owns it
    Instance::new("engine-A"),       // INSTANCE — which one            (D17)
    FileType::Step,                  // FORMAT   — how it is encoded
    &bytes,
)?;

// Pull -> revision metadata + raw payload bytes, verbatim (D12)
let got = store.pull(Tag::new("grain-geometry"), Instance::new("engine-A"))?;

// Subscribe -> a notification arrives. NOT the payload. The app pulls when ready (D14).
store.subscribe(Tag::new("grain-geometry"), Mode::Tracking)?;
let events = store.events(since_cursor)?;
```

**Why the triple is not optional (D17).** `appname/tag/filetype` alone cannot express the motivating example:

- **Instance is missing.** If a team runs five engine projects, all five grain geometries share the tag `grain-geometry`. Worse, "editing the model pushes an update" requires knowing the new bytes are a *new version of the same model* — not a different model and not an anonymous blob. That distinction is exactly what instance identity provides, and it is what revisions hang off.
- **Format is doing ambiguous work.** As a file extension, a burn-profile CSV and a telemetry CSV are indistinguishable. As a semantic type, it is just `type_id` renamed — and then the format axis is missing instead.

`Tag` is therefore `(owner_app, semantic_type)`, separate from `Instance` (identity) and `FileType` (encoding, which maps to `revision.encoding`).

---

## 5. Data model

### 5.1 Concepts

- **Artifact** — a named, typed, app-owned thing that can be shared. Has a stable identity across all its revisions. Examples: a grain geometry, an engine design, a 6DOF run result.
- **Revision** — an immutable snapshot of an artifact's payload. Never mutated, never deleted during normal operation.
- **Edge** — "consumer *C* depends on artifact *A*", with a satisfaction policy. The edge is what makes freshness computable.
- **Event** — an append-only record of a change, with a monotonic cursor. This is what drives notifications.

### 5.2 SQLite schema

SQLite in **WAL mode**, `busy_timeout` set. Reads are concurrent; writes are serialized behind a single writer.

```sql
-- Per-installation identity and other singletons.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL           -- 'node_id' is a UUIDv7 minted once at first run
);

CREATE TABLE artifact (
  artifact_id         TEXT PRIMARY KEY,   -- UUIDv7 (time-ordered)
  type_id             TEXT NOT NULL,
  owner_app           TEXT NOT NULL,      -- publishing app slug
  instance            TEXT NOT NULL,      -- WHICH one; half of the identity (D17)
  label               TEXT,               -- human-readable, for the hub UI
  current_revision_id TEXT,               -- FK revision; NULL until first publish
  created_by          TEXT,               -- Supabase member id (D11)
  origin_node_id      TEXT NOT NULL,
  seed_batch          TEXT,               -- non-null marks removable dummy data
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (type_id, instance)              -- the type/instance pair IS the identity
);
CREATE INDEX idx_artifact_type ON artifact(type_id);
CREATE INDEX idx_artifact_owner ON artifact(owner_app);
CREATE INDEX idx_artifact_seed ON artifact(seed_batch);

CREATE TABLE revision (
  revision_id         TEXT PRIMARY KEY,   -- UUIDv7
  artifact_id         TEXT NOT NULL REFERENCES artifact(artifact_id) ON DELETE CASCADE,
  parent_revision_id  TEXT REFERENCES revision(revision_id) ON DELETE SET NULL,
  revision_number     INTEGER NOT NULL,
  type_id             TEXT NOT NULL,
  encoding            TEXT NOT NULL,      -- 'json' | 'protobuf' | 'blob' | 'text'   (D2)
  inline_payload      BLOB,               -- small payloads; NULL if blob-backed
  blob_hash           TEXT,               -- sha256 hex; NULL if inline
  content_hash        TEXT NOT NULL,      -- sha256 of the payload bytes
  byte_size           INTEGER NOT NULL,
  created_by          TEXT,
  origin_node_id      TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  UNIQUE (artifact_id, revision_number),
  CHECK (inline_payload IS NOT NULL OR blob_hash IS NOT NULL)
);
CREATE INDEX idx_revision_artifact ON revision(artifact_id, revision_number);
CREATE INDEX idx_revision_content ON revision(content_hash);
CREATE INDEX idx_revision_blob ON revision(blob_hash);

-- Consumer -> artifact dependency. Drives staleness.
CREATE TABLE edge (
  edge_id                    TEXT PRIMARY KEY,
  consumer_app               TEXT NOT NULL,
  -- NOT NULL DEFAULT '' rather than nullable: SQLite treats NULLs as distinct in UNIQUE
  -- constraints, which would let duplicate edges accumulate.
  consumer_ref               TEXT NOT NULL DEFAULT '',  -- caller-defined, e.g. a run id
  artifact_id                TEXT NOT NULL REFERENCES artifact(artifact_id) ON DELETE CASCADE,
  mode                       TEXT NOT NULL, -- 'pinned' | 'tracking' | 'compatible'  (D4)
  pinned_revision_id         TEXT REFERENCES revision(revision_id) ON DELETE SET NULL,
  min_revision_number        INTEGER,
  last_satisfied_revision_id TEXT REFERENCES revision(revision_id) ON DELETE SET NULL,
  created_by                 TEXT,
  created_at                 INTEGER NOT NULL,
  UNIQUE (consumer_app, consumer_ref, artifact_id),
  CHECK (
    (mode = 'pinned'     AND pinned_revision_id IS NOT NULL) OR
    (mode = 'tracking') OR
    (mode = 'compatible' AND min_revision_number IS NOT NULL)
  )
);
CREATE INDEX idx_edge_artifact ON edge(artifact_id);
CREATE INDEX idx_edge_consumer ON edge(consumer_app, consumer_ref);

-- Cursor-based change log. `seq` is the cursor.
CREATE TABLE event (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,   -- artifact.created | revision.published | edge.created
                               -- | edge.satisfied | demo.purged
  type_id     TEXT,
  artifact_id TEXT,
  revision_id TEXT,
  edge_id     TEXT,
  actor_app   TEXT,
  summary     TEXT,            -- human-readable one-liner for the change feed
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_event_artifact ON event(artifact_id);

-- Declared data contracts (D16). Static manifest rows are trusted; runtime rows are not.
CREATE TABLE app_interface (
  app          TEXT NOT NULL,
  direction    TEXT NOT NULL,   -- 'publish' | 'consume'
  type_id      TEXT NOT NULL,
  default_mode TEXT,            -- seed for new edges on consume declarations
  source       TEXT NOT NULL,   -- 'manifest' | 'runtime' | 'demo'
  declared_at  INTEGER NOT NULL,
  PRIMARY KEY (app, direction, type_id)
);

CREATE TABLE type_registry (
  type_id        TEXT PRIMARY KEY,
  owner_app      TEXT NOT NULL,
  descriptor_set BLOB,          -- FileDescriptorSet, optional; enables generic UI
  registered_at  INTEGER NOT NULL
);

-- ---------------------------------------------------------------- schema v2

-- Read log (D20). Never the `event` table: consumers poll that with a cursor.
CREATE TABLE access_log (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_app       TEXT NOT NULL,
  type_id         TEXT NOT NULL,
  instance        TEXT NOT NULL,
  revision_id     TEXT,
  revision_number INTEGER,
  outcome         TEXT NOT NULL,   -- 'hit' | 'miss'
  created_at      INTEGER NOT NULL
);

-- Type-level wires (D18). Materialised edges carry `consumer_ref = 'sub:<id>'`, which is
-- what lets a subscription own its edges without a separate mapping table.
CREATE TABLE subscription (
  subscription_id TEXT PRIMARY KEY,
  consumer_app    TEXT NOT NULL,
  type_id         TEXT NOT NULL,
  mode            TEXT NOT NULL,
  created_by      TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (consumer_app, type_id)
);
```

Beyond the original sketch, three columns exist because the requirements demanded them:

- **`artifact.instance`** — named `instance`, not `name`, to match the client facade (D17).
  It is half of the artifact's unique identity.
- **`artifact.seed_batch`** — records which seed batch created a row. This is what makes dummy
  data reliably removable (`docs/VALIDATION.md` §6); without it, purge could only infer
  "this is demo" from namespaces.
- **`app_interface`** — backs `declare_interface` and write enforcement (§4.5).

`event` carries no foreign key to `artifact`, so purge deletes its events explicitly and the log
survives as an audit trail of real data.

**Note on `event.seq`:** `AUTOINCREMENT` (not bare `INTEGER PRIMARY KEY`) guarantees monotonically increasing, never-reused cursors. A polling client passing `since=<seq>` must never miss or replay an event.

### 5.3 Freshness semantics

An edge is **stale** when its recorded satisfaction no longer matches the artifact's current state:

| mode | satisfied when | stale when |
| --- | --- | --- |
| `pinned` | `last_satisfied_revision_id == pinned_revision_id` | never stale — pinned edges do not track |
| `tracking` | `last_satisfied_revision_id == artifact.current_revision_id` | upstream publishes a new revision |
| `compatible` | satisfied revision's `revision_number >= min_revision_number` | never stale (lower bound already met) |

Staleness is a single join. **The hub computes it without decoding any payload** — the payoff of D1.

Auto-update is a policy attached to a `tracking` edge. It is never global, and it can never apply to a `pinned` edge.

### 5.4 Blob store

```
%LOCALAPPDATA%\APRO\Store\blobs\<sha256[0..2]>\<sha256>
```

- Two-level fanout keeps directory sizes sane on Windows.
- Content-addressed: identical payloads dedup automatically; the hash doubles as an integrity check on read.
- Write path: write to a temp file, `fsync`, then atomically rename into place. A crash never leaves a partial blob visible.
- **Blobs are never deleted while any revision references them.** Garbage collection is deferred (§10).
- **The hub snapshots bytes on every push (D15).** It must never store a path to an app's working file: that file can be edited in place, which silently mutates shared data with no revision event and invalidates every staleness computation. A push is a copy, not a reference.

### 5.5 What is deliberately NOT in the schema

- No queryable domain fields. You cannot `SELECT` a chamber pressure. If the hub ever needs to query domain data, that is a signal to add a hub-owned *summary/projection* type, not to start parsing payloads.
- No sync tables, no vector clocks, no conflict resolution. Deferred, but not foreclosed (§8).

---

## 6. Protobuf strategy

### 6.1 Where protobuf fits

Protobuf provides strict schemas, compact encoding, cross-language codegen, field-number compatibility, and unknown-field preservation.

It does **not** provide: a registry, discovery, change notification, or schema-evolution governance. Those are the hub's job (§4, §5).

Because encoding is per-revision (D2), protobuf is adopted incrementally with no architectural change.

### 6.2 Codegen

- `.proto` sources live in `crates/apro-schemas/proto/`, vendored as a versioned unit.
- Each consumer compiles them at build time via `prost-build` in `build.rs` — no distributed generated code, no version skew.
- `prost-build` needs `protoc`. Either vendor it (`protoc-bin-vendored`) or switch to a pure-Rust compiler to avoid a toolchain prerequisite on every developer machine. **Verify which option applies at M1.**
- Emit a `FileDescriptorSet` per release and store it in `type_registry`. This lets the hub validate envelopes and render generic metadata for types it does not compile, using `prost-reflect`.

### 6.3 Governance rules

These are cheap to adopt now and expensive to retrofit:

1. **Additive-only within a type version.** Removing fields breaks readers.
2. **Never renumber or reuse a field number.** Put `reserved` on deleted numbers *and* names.
3. **Never change a field's type or meaning.** That is a new type id or a new major version.
4. **Breaking changes get a new type id** (`.../grain-geometry-v2`), never an in-place edit. Both versions coexist; migration is an app concern.

   Type-id segments are kebab-case only (`a-z`, `0-9`, `-`), so version with a hyphen: `-v2`, never `.v2`. The dot form is rejected as an invalid type id by both `TypeId::parse` (`crates/apro-store/src/model.rs`) and the HTTP API.
5. **Adopt `buf` in CI**, specifically `buf breaking`, to enforce rules 1–3 mechanically rather than by discipline.

### 6.4 The re-serialization rule (D12)

Raw payload bytes are the source of truth. Decode for display only.

The failure mode: a reader with an older schema decodes a message containing fields it does not know, re-encodes it, and silently destroys those fields. Protobuf's unknown-field preservation only protects you if you never round-trip through a lossy intermediate such as JSON.

**Consequence for `apro-api`:** the payload endpoint returns the stored bytes verbatim. The hub must never store a re-encoded copy of a message it parsed.

---

## 7. Hosting in-process (D8) — and what it requires

The store is hosted by the hub process. This is accepted for v1 with the following consequences, which are **requirements, not notes**:

### R1 — Closing the hub must not destroy the store

`handleClose()` currently calls `appWindow.destroy()`. Since the hub has one window, this terminates the process and takes the store with it. Any product app running at that moment loses its data connection mid-operation.

Required change: closing the window **hides it** (minimize to tray) rather than destroying the process. Only an explicit "Quit" — which must first warn if a product is running — actually terminates the hub and shuts the store down cleanly.

### R2 — Products must degrade gracefully

A product app can never assume the store is reachable. `apro-client` must distinguish:

- **unreachable** (hub not running) → local-only mode, queue writes if the app can, surface a clear message;
- **unauthorized** (expired/revoked session) → refresh, or prompt the user to relaunch from the hub;
- **conflict / not found** → normal API error.

Treating "hub is closed" as a hard crash in every product app would be an unacceptable v1 outcome.

### R3 — Clean shutdown

On genuine quit, the API server stops accepting, in-flight writes drain, SQLite is closed properly (WAL checkpointed), and the discovery file is removed. A stale discovery file pointing at a dead port must be detected on startup by `instance_id`/`pid`.

### R4 — This decision is reversible

Because `apro-store` and `apro-api` are crate-separated (D9), extracting a supervised daemon later is a packaging change. R1–R3 are the cost of deferring that; if the hub-closed scenario proves common in practice, revisit D8.

---

## 8. Identity and the path to networking

Not building sharing now, but not foreclosing it. These choices are what make it a later feature rather than a rewrite:

| Choice | Why it matters later |
| --- | --- |
| UUIDv7 primary keys (not autoincrement) | Globally unique IDs minted offline, no coordination |
| Immutable revisions (D3) | Concurrent edits by two users produce two revisions — both preserved, no data loss. Conflicts mostly stop existing. |
| `created_by` = Supabase member id | Attribution reuses the auth you already have |
| `origin_node_id` on every revision | Provenance: which machine produced this |
| Append-only `event` with monotonic `seq` | Becomes the sync cursor; also survives restarts today |
| `content_hash` on every revision | Cheap conflict/dedup detection at sync time |

**Deliberately deferred:** the actual sync protocol, server-side schema, conflict policy, and auth token exchange with Supabase. When this happens, `CloudTransport` is a new implementation of the existing trait (D7), and the HTTP contract is unchanged.

---

## 9. API surface

Payloads are always raw bytes with `encoding` in the metadata. The API never transcodes.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/session` | Exchange launch ticket for a session token |
| `POST` | `/v1/session/refresh` | Refresh a session token |
| `POST` | `/v1/artifacts` | Create an artifact |
| `GET` | `/v1/artifacts` | List / filter by `type_id`, `owner_app` |
| `GET` | `/v1/artifacts/{id}` | Metadata + current revision |
| `PATCH` | `/v1/artifacts/{id}` | Rename only (metadata; never payload) |
| `POST` | `/v1/artifacts/{id}/revisions` | Publish an immutable revision |
| `GET` | `/v1/artifacts/{id}/revisions` | Revision history |
| `GET` | `/v1/revisions/{revision_id}` | Revision metadata |
| `GET` | `/v1/revisions/{revision_id}/payload` | **Raw bytes**, verbatim |
| `POST` | `/v1/edges` | Register a dependency |
| `GET` | `/v1/edges` | List edges, with computed `stale` flag |
| `POST` | `/v1/edges/{id}/satisfy` | Mark satisfied at a revision |
| `GET` | `/v1/events?since=<seq>` | Cursor poll for changes |
| `GET` | `/v1/health` | Liveness + `instance_id` |

Auth: `Authorization: Bearer <token>` on everything except `/v1/session` (ticket) and `/v1/health`.

Notify-then-pull: `event` is the mechanism. The hub UI subscribes via Tauri `emit` (the existing `product-progress` pattern); product apps poll `/v1/events` or long-poll, then pull the payload when they choose. WebSockets are deliberately not first — the cursor log is the real primitive and it behaves identically once remote.

### 9.1 Delivery model (D14)

| | Push | Pull |
| --- | --- | --- |
| What moves | `event` records (~100 bytes) | Payload bytes |
| When | On change, to every subscriber `GET /v1/events` | On app request |
| Cost | O(subscribers) | O(1) per fetch |

The hub is the **single source of truth**; apps hold references, never copies. Never push payloads to subscribers:

- **Duplication.** N interested apps × M artifacts = N×M copies on disk.
- **Forking.** Once app B has a local copy it can edit, there is no way to tell an edit from a new revision, and no reconciliation path. This is the exact problem the orchestration layer exists to solve.
- **Large payloads.** Copying a 100 MB+ CAD model to every subscriber on every revision is not viable.
- **Offline apps.** An app that is not running cannot receive a push, so the hub would have to store a per-app copy anyway — reimplementing the store, badly.

Notify-then-pull also gives the app control over *when* it accepts a change, which is what makes the "update before continuing" gate (§5.3) possible at all.

---

## 10. Non-goals and deferred risks

### Non-goals for v1

- Cloud sync, LAN sharing, multi-user concurrency.
- Any hub-side understanding of domain payload fields.
- A universal aerospace schema.
- Blob garbage collection (blobs accumulate; disk cost is accepted for now).
- Encryption at rest. Note that the store will contain proprietary design data — revisit before any multi-user deployment.
- Data migration between type versions. Apps own that.

### Risk register

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | Hub close destroys store | §7 R1 — hide-to-tray, warn on quit with apps running |
| R2 | Products assume store availability | §7 R2 — explicit degraded-mode contract in `apro-client` |
| R3 | Proto field-number misuse corrupts data | §6.3 — `buf breaking` in CI, reserved fields on delete |
| R4 | Hub accretes domain knowledge and becomes coupled | §5.5 — no queryable domain fields; `type_registry` keeps the hub generic |
| R5 | Slug inconsistency (`"Propulsor - Liquid Engine Design Studio"` has spaces) | Normalize all slugs to kebab-case **before** type ids derive from them |
| R6 | Schema/over-engineering with no adoption | §11 — vertical slice before generalization; ship `apro-client` + `aproctl` |
| R7 | Disk growth from immutable revisions + blobs | Accepted for v1; GC design deferred |

### Adoption risk (the one that actually kills these projects)

If integrating with the store is expensive, apps will not integrate it, regardless of architectural quality. Because all apps are Rust/Tauri (D10), this is addressable: `apro-client` is a single dependency, publishes a typed API, and hides transport, auth, hashing, and cursor handling. Budget for it as a first-class deliverable, plus an `aproctl` CLI for inspecting the store without writing any code.

---

## 11. Milestones

Generalization comes **after** a working vertical slice.

### M0 — Prerequisites
- Normalize product slugs to kebab-case (R5); update the `products` array and any existing install dirs.
- Convert to a Cargo workspace.

### M1 — The spine
- `apro-schemas`, `apro-store` (SQLite + blob store + event log), `apro-api`, `apro-client`.
- Ticket→session auth; loopback bind; discovery file.
- Hub hosts the store; emits lifecycle status.
- **Acceptance:** publish a `burn-geometry-modeler/grain-geometry-v1` artifact and read it back through `apro-client`, plus a full curl round-trip. Hub close behavior per §7 R1.

### M2 — Revisions and freshness
- Immutability, content addressing, revision history.
- `event` cursor, staleness computation, hub UI staleness badges.
- **Acceptance:** editing the artifact marks a dependent edge stale; the dependent app observes it via `/v1/events`.

### M3 — The dependency graph
- `edge` modes, `satisfy`, "update before continuing" gate.
- Auto-update policy on `tracking` edges only.
- **Acceptance:** the CAD→HexaDOF scenario end to end: edit model → notification → accept update → run proceeds; and a `pinned` edge never moves.

### M4 — Generalization
- Product manifests in archives; write validation against `publishes`.
- `type_registry` + generic metadata rendering from `FileDescriptorSet`.
- Hub "Data" section: artifacts, revisions, dependents, staleness.
- Migrate the first real shared type from JSON to protobuf to prove D2.

### M5 — Cloud (later)
- `CloudTransport` implementing the existing trait.
- Sync protocol, server schema, conflict policy.
- No changes to `apro-store`'s data model, by construction.

---

## 12. Open questions

1. **Subscription granularity.** "This app requires type T" is a coarse filter — HexaDOF does not care about *every* grain geometry, only the one for the project it is working on. Type-level subscriptions produce cross-project notification noise. Options: (a) type-level only for v1, accept the noise; (b) per-instance subscriptions; (c) introduce a project/workspace scope as a middle layer. **Unresolved — blocks M3.**
2. **Auto-update UX.** On a stale `tracking` edge, does the update apply silently, prompt per-edge, or prompt once per app launch?
3. **Multiple artifacts of one type per consumer.** `consumer_ref` (e.g. a run id) is designed to disambiguate, but the consumer-side UX is undefined.
4. **Blob size ceiling.** If individual CAD payloads exceed a few hundred MB, the temp-file-and-rename path and the `inline_payload` threshold need explicit limits.
5. **`protoc` provisioning** for `prost-build` (§6.2) — vendored binary versus pure-Rust compiler.
