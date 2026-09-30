# APRO Works

Desktop hub for APRO's aerospace and rocketry applications. It authenticates members,
installs and launches the product apps (APRO CAD, Burn & Geometry Modeler, Propulsor,
HexaDOF), and hosts the **local orchestration layer** that lets those apps share data.

## Documentation

| Document | What it covers |
| --- | --- |
| [`DESIGN.md`](DESIGN.md) | Why the orchestration layer is built the way it is: the artifact/dependency-graph model, decisions log, risks, milestones |
| [`docs/APP_INTEGRATION.md`](docs/APP_INTEGRATION.md) | How to connect an app: the client API, types and instances, dependency modes, raw HTTP reference, integration checklist |
| [`docs/VALIDATION.md`](docs/VALIDATION.md) | How to prove a deployment works: `doctor`, `selftest`, CI gating, dummy-data lifecycle, troubleshooting |

## Repository layout

```
src/                    React + Tailwind hub UI (auth, install, launch)
src-tauri/              Tauri host: product install/launch + store lifecycle
crates/
  apro-store/           Storage engine: SQLite, content-addressed blobs, event log
  apro-api/             Loopback HTTP surface + launch-ticket/session auth
  apro-client/          Client SDK — the only dependency an app needs
  aproctl/              Operator CLI: serve, seed, purge-demo, doctor, selftest
harness/                Cross-application verification (its own workspace — see below)
docs/                   Integration and validation guides
```

`apro-store` and `apro-api` deliberately do **not** depend on Tauri, so the store can be
extracted into its own process later without a rewrite.

## Quick start

```powershell
# Install frontend deps and run the hub
npm install
npm run tauri dev

# Build and validate the orchestration layer
cargo build -p aproctl
cargo test --workspace          # 37 tests
aproctl selftest                # 16 behavioural checks on a throwaway store
aproctl doctor                  # inspect the real store
npm run verify:workflow         # 28 checks on the workflow graph rules
```

## Cross-application verification (`harness/`)

`harness/` proves the layer carries data between **real applications**, not just between
stubs. It path-depends on `aproCAD` and `hexadof2`, runs the real
`apro_massprops::compute_mass_properties`, publishes through the real HTTP API, then maps
the result onto `hex_model::ModelDocument` and imports it with the real
`hex_model::import_json`.

```powershell
cargo test --manifest-path harness/Cargo.toml
```

It is a **separate workspace** (`exclude`d from the root), because it depends on the app
crates and the platform must never depend on an application. In production the two halves
belong in their own repos:

- `apro-cad-bridge` → in `aproCAD/`, because it depends on `apro-document`/`apro-massprops`
- `hex-bridge` → in `hexadof2/`, because it depends on `hex-model`

The harness is where that bridge logic is developed and verified until those repos can
take it. It currently carries mass properties only; `harness/src/lib.rs` holds the payload
contract and the unit conversion.

The numeric assertions are checked against **closed-form physics** for a rectangular body
rather than against the payload itself, because a unit error of 1e6 in the inertia tensor
is entirely self-consistent and would pass a naive round-trip test.


## The orchestration layer in one paragraph

Apps share data through a **revisioned artifact + dependency graph**, not a universal schema.
An artifact is identified by a triple — `type` (`owner-app/type-name`), `instance` (`which
one`), and `encoding` — and its revisions are immutable. The hub stores payloads as opaque
bytes and never parses them, so each app owns its own format. What the hub *does* understand is
the graph: which artifacts exist, which revisions exist, who depends on what, and what is now
out of date. Freshness, update notifications, and reproducibility all fall out of that graph.
See [`DESIGN.md`](DESIGN.md) §2.

## Wiring applications together

The hub's **Workflows** tab is a node graph of the installed apps. Dragging a wire from
one app's output port to another's matching input port is not a cosmetic gesture — it
writes a **subscription** to the orchestration store and takes effect immediately.

The distinction that matters:

| | Durable object | Names |
| --- | --- | --- |
| **Subscription** | What the canvas draws | A *type* — "HexaDOF consumes grain geometry" |
| **Edge** | Materialised from a subscription | An *instance* — "…of `engine-A`" |

Subscriptions are the durable thing because a wire between two apps names a *kind* of
data, not a particular design. The store materialises concrete edges — one per existing
instance — and extends them automatically when a new instance is published.

Two rules keep it honest:

- Materialising only ever **inserts**. It never resets freshness, so pressing Apply or
  Sync cannot make a stale dependency look up to date (`DESIGN.md` D19).
- Reads are logged in a **separate table** from the change feed, so an app polling for
  changes is never spammed by other apps' reads (`DESIGN.md` D20). The console's
  **Pulls** tab reads that log, including misses — which is how "never asked" is
  distinguished from "asked before anything existed".

Removing a wire deletes the subscription and its edges. Removing a single edge is
transient by design, because the subscription still owns it.

## How the hub gets a product

Every entry in the `products` array in `src/App.tsx` is an archive URL plus the path of
the executable inside it. The installer downloads the archive, extracts it, strips one
common root folder, and checks the executable exists. Updates are detected by comparing
the stored ETag / Last-Modified / Content-Length from a `HEAD` against the local receipt.

Three hosts are in use, and they are not equally good:

| Host | Publish | Fragility | Cost |
| --- | --- | --- | --- |
| **GitHub Releases** | CI on a tag | None | Free bandwidth |
| **Supabase Storage** | Upload via API | None | Metered egress |
| **MediaFire** | Manual re-upload | **The hub scrapes `id="downloadButton"` from the HTML** | Free |

MediaFire is the fragile one: if the page markup changes, every install and update of
that product fails at once. GitHub Releases is the target for new products.

### Publishing to GitHub Releases

`APRO CAD` is published this way. Its workflow lives in the app repo at
`.github/workflows/release.yml`, and the hub points at:

```
https://github.com/APRO-pk/aproCAD/releases/latest/download/apro-cad-win64.zip
```

Three requirements, each of which fails quietly if broken:

1. **The repository must be public.** `download_client()` sends only a `User-Agent`, so a
   private repo's assets return 404. Do not put a token in the app — it is extractable.
2. **The asset name must not contain a version.** `/releases/latest/download/<name>`
   requires a byte-identical filename on every release, so `apro-cad-win64.zip` works and
   `apro-cad-0.1.0-win64.zip` 404s.
3. **Ship a zip.** The installer uses `ZipArchive`; a raw `.exe` cannot be installed.

The hub's automatic update then works because the ETag changes when a new release is
published, while the URL stays the same.

## Using dummy data

```powershell
aproctl seed            # 3 demo artifacts, deliberately leaving 1 stale dependency
aproctl ls --include-demo
aproctl purge-demo      # removes the demo set and prunes its blobs
```

Demo data is hidden from listings by default, carries a `seed_batch` marker, and cannot be
confused with real data. See [`docs/VALIDATION.md`](docs/VALIDATION.md) §6.

## Known gaps

- Closing the hub window destroys the in-process store, including while products are running.
  Specified fix in `DESIGN.md` §7 R1; not yet implemented.
- The hub UI has no Data section yet. The Tauri commands (`get_store_status`,
  `seed_store_demo`, `purge_store_demo`) are wired and callable.
- No cloud sync, no sharing, no encryption at rest. The data model is built so sync is additive
  rather than a rewrite (`DESIGN.md` §8).
