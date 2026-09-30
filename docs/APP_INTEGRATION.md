# Connecting an App to the APRO Works Orchestration Layer

**Audience:** whoever wires one of our apps (Burn & Geometry Modeler, Propulsor, HexaDOF, …)
into shared platform data.

**Goal:** let your app publish data that other apps can consume, and consume data other apps
publish — with revisions, freshness tracking, and no custom sync code.

This guide is self-contained. It is also written so it can be handed to an AI coding agent
as the spec for the integration; see [§12 Integration checklist](#12-integration-checklist).

---

## 0. The 30-second version

```rust
use apro_client::{AproStoreClient, HttpStoreClient};
use apro_client::{Encoding, TypeId};

// 1. Connect. Returns None when not launched by the hub -> degrade, don't crash.
let Some(store) = HttpStoreClient::from_launch_environment()? else {
    return Ok(()); // run without shared data
};

// 2. Publish.
let grain = TypeId::new("burn-geometry-modeler", "grain-geometry")?;
store.push(&grain, "engine-A", Encoding::Json, &my_bytes)?;

// 3. Consume.
if let Some(payload) = store.pull(&grain, "engine-A", Default::default())? {
    let json = payload.as_json()?;
}

// 4. React to changes (a notification, not a payload).
for event in store.events(cursor)? {
    println!("{} changed", event.summary.unwrap_or_default());
}
```

That is the entire surface. Everything below is detail.

---

## 1. The mental model — read this before writing code

Data is identified by a **triple**, not by a filename or a tag:

| Axis | Example | Answers |
| --- | --- | --- |
| **type** | `burn-geometry-modeler/grain-geometry` | *What kind of thing* is this? |
| **instance** | `engine-A` | *Which one* is it? |
| **encoding** | `json`, `protobuf`, `blob`, `text` | *How are the bytes serialized?* |

**All three are required.** Two grain geometries for two different engines share a type but
have different instances. If you collapse the instance into the type, the platform can no
longer tell "a new version of the same model" apart from "a different model" — and every
downstream guarantee (freshness, pinning, reproducibility) collapses with it.

### What the platform does and does not understand

- It stores your payload **byte-for-byte** and **never parses it**. Your schema is yours.
- It understands the *envelope*: which artifacts exist, which revisions exist, who depends
  on what, and what is out of date.
- It **never re-encodes** your payload. What you push is exactly what others pull.

> **Never hand it a file path.** `push` takes bytes, and the platform snapshots them. If you
> gave it a path instead, editing the file in place would silently mutate shared data with
> no revision event and would invalidate every freshness computation.

---

## 2. Prerequisite: your app slug must be kebab-case

Type ids are namespaced by the **publishing app's slug**, so the slug becomes part of a
permanent identifier. It must be lower-case kebab:

```
✅ burn-geometry-modeler        ✅ hexadof
❌ Propulsor - Liquid Engine Design Studio      (spaces, capitals)
❌ Propulsor_Liquid_Engine                      (underscores)
```

Rules: `a-z`, `0-9`, `-` only; 1–64 characters; must not start or end with `-`.

This is enforced — an invalid slug is rejected at the API with `invalid_type_id`, because a
slug like `Propulsor - Liquid Engine Design Studio` would end up in URLs, on disk, and in
type namespaces. **The Propulsor entry in `src/App.tsx` currently uses a slug with spaces
and must be normalized before it can publish anything.**

Reserved namespaces you must not use:
- `apro-core/*` — hub-defined types
- `apro-demo/*` — removable dummy data

---

## 3. Add the dependency

The whole integration is one crate. It pulls in transport, authentication, hashing, cursors
and serialization so your app does not have to.

```toml
# In your app's src-tauri/Cargo.toml
[dependencies]
apro-client = { git = "https://github.com/APRO-pk/apro-client", tag = "v0.1.0" }
```

The SDK is published from
[APRO-pk/apro-client](https://github.com/APRO-pk/apro-client), separately from this platform
repository, so an app does not need a checkout of APRO Works to build. **Pin the tag** rather
than tracking a branch — an app should only move SDK version deliberately.

`apro-client` re-exports every wire type from its crate root, so a single dependency gives you
`AppInterface`, `EdgeRequest`, `Mode`, `TypeId` and the rest:

```rust
use apro_client::{AproStoreClient, AppInterface, EdgeRequest, HttpStoreClient, Mode, TypeId};
```

The whole vocabulary also stays reachable as `apro_client::apro_types::{...}` if you prefer to
qualify it.

**Do not depend on `apro-store` directly.** That is the server-side engine — it links SQLite
and has no business in a product app. `apro-client` deliberately does not depend on it either;
that separation is why the SDK is a small, fast build.

---

## 4. Connect — and handle "not connected" honestly

The hub launches your app with three arguments:

```
your-app.exe --apro-product-slug <your-slug> \
             --apro-launch-token <single-use ticket> \
             --apro-store-endpoint http://127.0.0.1:<port>
```

You do **not** parse these yourself:

```rust
use apro_client::{AproStoreClient, HttpStoreClient};

let store = match HttpStoreClient::from_launch_environment()? {
    Some(store) => store,
    None => {
        // Not launched by the hub. This is a normal state, not an error:
        // the user ran your exe directly, or from a shortcut.
        eprintln!("Running without shared platform data (not launched by APRO Works).");
        return Ok(());
    }
};
```

`from_launch_environment()`:
1. reads the launch arguments;
2. exchanges the launch ticket for a **session token** (tickets are single-use and expire in
   90 seconds);
3. returns `None` if no credentials were supplied.

It also falls back to `%LOCALAPPDATA%\APRO\store.json` for the endpoint, which is how a
hand-launched app finds a running hub.

### The store can disappear underneath you

The store is hosted inside the hub process. **If the user closes the hub, the store goes
away** — including while your app is still running. Your app must treat that as a normal
condition:

```rust
match store.pull(&type_id, instance, Default::default()) {
    Ok(Some(payload)) => { /* use it */ }
    Ok(None) => { /* never published yet */ }
    Err(err) if err.is_unreachable() => {
        // The hub is not running. Fall back to local data, tell the user calmly,
        // and retry when they reconnect.
    }
    Err(err) if err.is_unauthorized() => {
        // Session expired or was revoked. A relaunch from the hub fixes it.
    }
    Err(err) => { /* a genuine API error: log err.api_code() and err */ }
}
```

Use `err.api_code()` for branching — it returns the same stable code whether you are talking
over HTTP or to an in-process store:

| Code | Meaning |
| --- | --- |
| `artifact_not_found` | No such type+instance, or no revision yet |
| `write_not_declared` | You pushed a type you never declared (see §5) |
| `invalid_type_id` | Malformed type id, or a non-kebab-case slug |
| `invalid_request` | Bad parameters |
| `unauthorized` | Missing/expired/incorrect token |
| `forbidden` | Identity mismatch (claiming another app's slug) |

---

## 5. Declare your interface

Tell the platform what you publish and consume. Do this once at startup.

```rust
use apro_client::{AppInterface, ConsumeDecl, Mode, TypeId};

store.declare_interface(&AppInterface {
    app: "burn-geometry-modeler".into(),
    publishes: vec![
        TypeId::new("burn-geometry-modeler", "grain-geometry")?,
        TypeId::new("burn-geometry-modeler", "geometry-step")?,
    ],
    consumes: vec![
        ConsumeDecl {
            type_id: TypeId::new("apro-core", "propellant")?,
            default_mode: Mode::Pinned,
        },
    ],
})?;
```

**Write enforcement.** If you declare at least one published type, the platform rejects writes
to any type you did not declare (`write_not_declared`). This is deliberate: it catches typos
and accidental cross-app writes. An app with *no* declarations may write anything, so a
half-integrated app still works — but declare properly.

Declarations are also what the hub shows as your app's data contract, so keep them accurate.

---

## 6. Publishing

```rust
use apro_client::Encoding;

// Simple form.
let handle = store.push(
    &grain_type,          // type
    "engine-A",           // instance
    Encoding::Json,       // encoding
    &payload_bytes,
)?;

println!("revision {} ({} bytes)", handle.revision_number, handle.byte_size);

// With a human-readable label, shown in the hub UI.
let handle = store.push_labeled(
    &grain_type, "engine-A", Encoding::Json,
    Some("Grain geometry — engine A"),
    &payload_bytes,
)?;
```

### Revision semantics — the important part

- **Revisions are immutable.** A push *appends*. It never overwrites. The previous revision
  stays readable forever, by number.
- **Identical bytes are a no-op.** If you push exactly what is already current, no revision is
  created and `handle.unchanged == true`. This makes "save" buttons safe to wire up directly.
- **`handle.created_new_artifact`** tells you whether this was the first ever push for that
  instance.
- `handle.content_hash` is the sha256 of your payload — useful for your own dedup or logging.

### Choosing an encoding

| Encoding | Use for | Notes |
| --- | --- | --- |
| `Json` | Config, parameters, results, small structured data | Human-readable; easiest to debug |
| `Protobuf` | Structured data you want typed in every language | **The platform treats it as opaque bytes** — see below |
| `Blob` | CAD/STEP exports, meshes, images, anything binary | Go here for anything large |
| `Text` | Logs, scripts, plain text | |

> **You can use `Protobuf` today with no `.proto` toolchain.** The platform never decodes your
> payload, so `Encoding::Protobuf` simply means "these bytes are protobuf". You only need
> codegen when two apps want *typed* access, which is a per-type decision you can make later.
> This is why encoding is per-revision rather than a platform-wide setting.

### Size

- Payloads ≤ **64 KiB** are stored inline in SQLite.
- Larger payloads are written to a content-addressed **blob store**, deduplicated by hash.
- The API rejects bodies above **512 MiB** with HTTP 413. If you need more, split the file.

You do not choose this; it is automatic. But it means pushing a large file is cheap the second
time if the bytes are unchanged.

---

## 7. Consuming

```rust
use apro_client::Selector;

// Latest revision.
let payload = store.pull(&grain_type, "engine-A", Selector::Latest)?;

// A specific revision — this is how you reproduce a past result.
let payload = store.pull(&grain_type, "engine-A", Selector::Number(2))?;

if let Some(payload) = payload {
    println!("type      : {}", payload.type_id);
    println!("instance  : {}", payload.instance);
    println!("revision  : {}", payload.revision_number);
    println!("hash      : {}", payload.content_hash);
    println!("encoding  : {}", payload.encoding);
    println!("bytes     : {}", payload.byte_size);

    // Convenience accessors:
    let text = payload.as_str()?;      // UTF-8 view
    let json = payload.as_json()?;     // parsed JSON
    // ...or use payload.bytes directly.
}
```

`Ok(None)` means "no revision exists yet" — for example a consumer declared a dependency on an
artifact the producer has never published. That is a valid state, not an error.

You can also enumerate:

```rust
use apro_client::ArtifactFilter;

let all = store.list_artifacts(&ArtifactFilter::default())?;              // hides demo data
let mine = store.list_artifacts(&ArtifactFilter {
    owner_app: Some("burn-geometry-modeler".into()),
    include_demo: true,
    ..Default::default()
})?;

let history = store.list_revisions(&grain_type, "engine-A")?;  // oldest first, with lineage
```

---

## 8. Dependencies and freshness — the reason this layer exists

> **Edges vs subscriptions.** An **edge** is one dependency on one *instance*:
> "HexaDOF's run-001 depends on `grain-geometry/engine-A`". A **subscription** is one
> dependency on a *type*: "HexaDOF consumes grain geometry, whatever instances exist".
>
> Subscriptions are what the hub's Workflows canvas draws, because a wire between two
> apps names a kind of data, not a particular design. The store **materialises** concrete
> edges from a subscription — one per existing instance — and extends them automatically
> when a new instance is published.
>
> Use a subscription when you want to follow every instance. Use a raw edge when you need
> to depend on one specific design.

When your app uses another app's data, **register that as a dependency**. This is what lets the
platform tell you, and tell the user, that something you relied on has changed.

```rust
use apro_client::{EdgeRequest, Mode};

let edge = store.register_edge(&EdgeRequest {
    consumer_app: String::new(),      // server fills this in from your session
    consumer_ref: Some("run-2024-07-11-a".into()),  // your internal id for this result
    type_id: grain_type.clone(),
    instance: "engine-A".into(),
    mode: Mode::Tracking,             // see the table below
    pinned_revision_number: None,
    min_revision_number: None,
})?;

println!("stale already? {}", edge.stale);
```

### Choose the mode deliberately

| Mode | Satisfied by | Goes stale? | Use for |
| --- | --- | --- | --- |
| `Pinned` | One exact revision | **Never** | **Anything that produced a recorded result.** Default. |
| `Tracking` | The current revision | Yes, when upstream publishes | Live design work where you want to follow changes |
| `Compatible` | Any revision ≥ a floor | Only until the floor is met | "I need at least v3" |

> **Default to `Pinned` for anything you might have to defend later.**
> A simulation run, a report, a test result — all of these must be able to name the exact input
> revision they used, permanently. If you track `latest`, your result silently becomes
> unreproducible the moment someone edits an upstream model, and you will not notice until you
> are asked to justify a number.
>
> Use `Tracking` for design-time work where you genuinely want to follow upstream changes, and
> rely on the staleness signal below rather than auto-adopting.

### Reacting to changes

`events` returns **notifications, not payloads**:

```rust
let mut cursor = 0;   // persist this across restarts; 0 means "from the beginning"

loop {
    let events = store.events(cursor)?;
    for event in &events {
        cursor = event.seq;   // always advance the cursor, even if you ignore the event
        match event.kind.as_str() {
            "revision.published" => { /* something changed; maybe pull it */ }
            "demo.purged" => { /* dummy data was removed */ }
            _ => {}
        }
    }
    std::thread::sleep(std::time::Duration::from_secs(2));
}
```

Why pull instead of receiving the payload: pushing payloads to every interested app would mean
N×M copies on disk, apps that are not running would miss everything, and any app editing its
local copy would silently fork your data. The hub stays the single source of truth; your app
holds references.

### Checking whether you are out of date

```rust
use apro_client::EdgeFilter;

let mine = store.list_edges(&EdgeFilter {
    consumer_app: Some("hexadof".into()),
    stale: Some(true),       // only the ones needing attention
    ..Default::default()
})?;

for edge in mine {
    eprintln!("{} {} is out of date", edge.type_id, edge.instance);
}
```

When the user accepts the update, record it:

```rust
store.satisfy_edge(&edge.edge_id, None)?;        // adopt the current revision
store.satisfy_edge(&edge.edge_id, Some(4))?;     // adopt revision 4 specifically
```

**Recommended UX:** on a stale `Tracking` edge, show the user what changed and let them decide.
Never silently adopt a new revision into a result that has already been recorded.

---

## 9. A complete integration sketch

```rust
// src-tauri/src/platform_data.rs
use apro_client::{AproStoreClient, ClientError, HttpStoreClient};
use apro_client::{AppInterface, ArtifactFilter, EdgeFilter, Encoding, Mode, Selector, TypeId};

const APP_SLUG: &str = "burn-geometry-modeler";   // kebab-case, matches your product slug

pub struct PlatformData {
    store: HttpStoreClient,
    grain: TypeId,
}

impl PlatformData {
    /// Returns Ok(None) when the app was not launched by the hub.
    pub fn connect() -> Result<Option<Self>, ClientError> {
        let Some(store) = HttpStoreClient::from_launch_environment()? else {
            return Ok(None);
        };

        let grain = TypeId::new(APP_SLUG, "grain-geometry")
            .expect("static type id is valid");

        store.declare_interface(&AppInterface {
            app: APP_SLUG.into(),
            publishes: vec![grain.clone()],
            consumes: vec![],
        })?;

        Ok(Some(Self { store, grain }))
    }

    pub fn publish_grain(&self, instance: &str, payload: &[u8]) -> Result<u32, ClientError> {
        let handle = self.store.push(&self.grain, instance, Encoding::Json, payload)?;
        Ok(handle.revision_number)
    }

    pub fn load_grain(&self, instance: &str) -> Result<Option<Vec<u8>>, ClientError> {
        Ok(self
            .store
            .pull(&self.grain, instance, Selector::Latest)?
            .map(|payload| payload.bytes))
    }

    pub fn stale_dependencies(&self) -> Result<Vec<String>, ClientError> {
        Ok(self
            .store
            .list_edges(&EdgeFilter {
                consumer_app: Some(APP_SLUG.into()),
                stale: Some(true),
                ..Default::default()
            })?
            .into_iter()
            .map(|edge| format!("{} / {}", edge.type_id, edge.instance))
            .collect())
    }
}
```

Call it from a Tauri command, keeping blocking work off the async runtime:

```rust
#[tauri::command]
async fn publish_grain(instance: String, payload: Vec<u8>) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = PlatformData::connect().map_err(|e| e.to_string())?;
        let Some(data) = data else { return Err("not connected to APRO Works".into()) };
        data.publish_grain(&instance, &payload).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
```

> `HttpStoreClient` is a **blocking** client. Never call it directly from inside an async
> runtime — wrap it in `spawn_blocking` (as above) or run it on a worker thread. Calling
> blocking `reqwest` inside a Tokio runtime panics.

---

## 10. Raw HTTP reference (non-Rust apps, scripts, debugging)

The Rust client is a convenience wrapper. The API is plain HTTP on loopback, so MATLAB, Python,
or a shell script can use it directly — and it is the same contract a future cloud service will
expose.

**Base URL:** the `--apro-store-endpoint` value, e.g. `http://127.0.0.1:52431`.

**Auth:** `Authorization: Bearer <session-token>` on everything except `/v1/health` and
`/v1/session`. Optionally send `x-apro-app: <your-slug>`; if present it must match the session.

### Getting a session

```bash
# Exchange the launch ticket (from --apro-launch-token) for a session.
curl -s -X POST "$ENDPOINT/v1/session" -H "Authorization: Bearer $LAUNCH_TICKET"
# -> {"session_token":"...","app_slug":"...","scopes":["read","write"],"expires_at":...}

# Extend a live session.
curl -s -X POST "$ENDPOINT/v1/session/refresh" -H "Authorization: Bearer $SESSION"
```

### Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/health` | Public. Node id, schema version, auth mode |
| `POST` | `/v1/session` | Ticket → session |
| `POST` | `/v1/session/refresh` | Extend session |
| `POST` | `/v1/declare` | JSON `{app, publishes:[…], consumes:[{type_id, default_mode}]}` |
| `POST` | `/v1/push` | **Raw body.** `?type_id=&instance=&encoding=&label=` |
| `GET` | `/v1/pull` | **Raw bytes out.** `?type_id=&instance=&selector=latest\|number&number=N` |
| `GET` | `/v1/artifacts` | `?type_id=&owner_app=&instance=&include_demo=` |
| `GET` | `/v1/artifacts/{artifact_id}` | Metadata for one artifact |
| `GET` | `/v1/revisions` | `?type_id=&instance=` — full history with lineage |
| `POST` | `/v1/edges` | JSON `EdgeRequest` — one dependency, on one instance |
| `GET` | `/v1/edges` | `?consumer_app=&artifact_id=&stale=true\|false` |
| `DELETE` | `/v1/edges/{edge_id}` | Remove one edge |
| `POST` | `/v1/edges/{edge_id}/satisfy` | `?revision_number=N` (omit for current) |
| `POST` | `/v1/subscriptions` | JSON `{consumer_app, type_id, mode}` — one dependency on a **type** |
| `GET` | `/v1/subscriptions` | All subscriptions, with their materialised edge counts |
| `DELETE` | `/v1/subscriptions/{subscription_id}` | Un-wire: removes the subscription and its edges |
| `POST` | `/v1/subscriptions/materialize` | Back-fill edges for instances published since subscribing |
| `GET` | `/v1/events` | `?since=<cursor>&limit=<n>` — **changes only** |
| `GET` | `/v1/access` | `?since=<cursor>&limit=<n>` — the read log |
| `GET` | `/v1/stats` | Counters |
| `GET` | `/v1/interfaces` | Declared contracts |
| `GET` | `/v1/types` | Registered type ids |

> Type ids contain a `/`, so **percent-encode them** in query strings:
> `type_id=burn-geometry-modeler%2Fgrain-geometry`.

### `pull` response headers

The body is the raw payload. Metadata arrives as headers — this is how you learn *which*
revision you got without a second request:

| Header | Meaning |
| --- | --- |
| `x-apro-artifact-id` | Stable artifact identity |
| `x-apro-type-id` | Canonical `owner-app/type-name` |
| `x-apro-instance` | Which instance |
| `x-apro-revision-id` | Revision UUID |
| `x-apro-revision-number` | Monotonic revision number *(use this in your UI)* |
| `x-apro-encoding` | `json` / `protobuf` / `blob` / `text` |
| `x-apro-content-hash` | sha256 of the body — verify it if integrity matters |
| `x-apro-byte-size` | Size in bytes |
| `x-apro-created-at` | Unix epoch milliseconds |
| `x-apro-label` | Human label, if one was set |
| `x-apro-seed-batch` | Present only on dummy data |

### Worked example

```bash
ENDPOINT=http://127.0.0.1:52431
SESSION=<session token>

# Publish
curl -s -X POST "$ENDPOINT/v1/push?type_id=burn-geometry-modeler%2Fgrain-geometry&instance=engine-A&encoding=json" \
  -H "Authorization: Bearer $SESSION" \
  -H "Content-Type: application/octet-stream" \
  --data-binary '{"outer_diameter":152.4}'
# -> {"artifact_id":"…","revision_id":"…","revision_number":1,…}

# Consume, with metadata
curl -s -D - "$ENDPOINT/v1/pull?type_id=burn-geometry-modeler%2Fgrain-geometry&instance=engine-A" \
  -H "Authorization: Bearer $SESSION"

# Read a specific historical revision
curl -s "$ENDPOINT/v1/pull?type_id=burn-geometry-modeler%2Fgrain-geometry&instance=engine-A&selector=number&number=1" \
  -H "Authorization: Bearer $SESSION"

# What is out of date for me?
curl -s "$ENDPOINT/v1/edges?consumer_app=hexadof&stale=true" -H "Authorization: Bearer $SESSION"
```

### Error format

Every failure returns a JSON envelope with an HTTP status that matches the error class:

```json
{ "error": { "code": "write_not_declared", "message": "app \"x\" is not permitted to write type \"x/y\"…" } }
```

Branch on `code`, not on the message text.

---

## 11. Rules to not get burned by

1. **Never store a file path.** Push bytes. The platform snapshots them.
2. **Never overwrite.** There is no update-in-place; a push appends a revision. Read the old one
   by number whenever you need it.
3. **Don't treat `latest` as an answer** for anything you record. Pin it.
4. **Don't poll `pull` in a tight loop.** Use `events` to learn that something changed, then pull.
5. **Always advance your event cursor**, even for events you ignore, or you will replay forever.
6. **Don't parse another app's payload with assumptions.** Read its declared interface, and
   version it in the type name (`…-geometry-v2`) when you break it.
7. **Handle "store unreachable"** as a normal state. The hub can be closed.
8. **Type ids are forever.** Renaming a type orphans every existing artifact of it. Adding
   `-v2` is the supported way to evolve. Type-id segments are kebab-case only
   (`a-z`, `0-9`, `-`), so use a hyphen — `.v2` is rejected as an invalid type id.
9. **Treat the session token as a credential.** Do not log it; do not write it to a file.
10. **`Encoding` is metadata only.** Nothing validates that a `protobuf` payload is valid
    protobuf. Your app owns that.

---

## 12. Integration checklist

Copy this into the app's tracking issue.

**Prerequisites**
- [ ] App slug is kebab-case (`a-z`, `0-9`, `-`), 1–64 chars, no leading/trailing `-`
- [ ] Slug matches the `products[].slug` entry in `src/App.tsx`
- [ ] `apro-client` added to `src-tauri/Cargo.toml`

**Connection**
- [ ] `HttpStoreClient::from_launch_environment()` called once at startup
- [ ] `Ok(None)` path handled: app runs without shared data, no crash, clear message
- [ ] Blocking client calls wrapped in `spawn_blocking`, never inside an async context
- [ ] `is_unreachable()` / `is_unauthorized()` handled distinctly

**Contract**
- [ ] `declare_interface` lists every type the app publishes
- [ ] Consumed types declared with the intended `default_mode`
- [ ] Payload schemas documented somewhere in the app's repo
- [ ] Type names are namespaced under the app's own slug

**Publishing**
- [ ] App pushes **bytes**, never paths
- [ ] `handle.unchanged` tolerated (idempotent saves are fine)
- [ ] Large binaries use `Encoding::Blob`
- [ ] Every instance has a stable, meaningful name

**Consuming**
- [ ] Dependencies registered via `register_edge` with a deliberate mode
- [ ] Anything that produces a recorded result uses `Mode::Pinned`
- [ ] Stale edges surfaced to the user before they continue
- [ ] `satisfy_edge` called only after the user accepts the update
- [ ] `Ok(None)` from `pull` handled as "not published yet"

**Changes**
- [ ] Event cursor persisted across restarts
- [ ] Polling interval is sane (≥1s); no busy loops
- [ ] Cursor advanced even for ignored events

**Verify**
- [ ] `aproctl selftest` passes on this machine
- [ ] `aproctl doctor` reports 0 failures
- [ ] End-to-end: edit in the producing app → consumer shows stale → accept → run proceeds
- [ ] End-to-end: close the hub while the app runs → app degrades, does not crash

---

## 13. Where to go next

| I want to… | Read |
| --- | --- |
| Validate a deployment or debug a failure | [`VALIDATION.md`](VALIDATION.md) |
| Understand why the platform is built this way | [`../DESIGN.md`](../DESIGN.md) |
| See every endpoint in detail | [§10](#10-raw-http-reference-non-rust-apps-scripts-debugging) |
| Inspect the store without writing code | `aproctl --help` |
