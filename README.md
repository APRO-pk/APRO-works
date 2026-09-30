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
  aproctl/              Operator CLI: serve, seed, purge-demo, doctor, selftest
harness/                Cross-application verification (its own workspace — see below)
docs/                   Integration and validation guides
```

The client SDK is **not** in this repository. `apro-client` and its `apro-types` wire
vocabulary are published from [APRO-pk/apro-client](https://github.com/APRO-pk/apro-client)
and consumed here as a pinned git dependency, exactly as a product app consumes it. Keeping
one copy means the platform cannot drift from the artifact it hands out.

`apro-store` and `apro-api` deliberately do **not** depend on Tauri, so the store can be
extracted into its own process later without a rewrite.

## Quick start

### Configuration (required)

The hub authenticates against Supabase, and Vite **inlines the credentials at build
time**. They cannot be supplied at runtime, and a build compiled without them cannot sign
anyone in.

```powershell
Copy-Item .env.example .env
# then fill in VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY
```

The release workflow reads the same two values from repository variables
(`vars.VITE_SUPABASE_URL`, `vars.VITE_SUPABASE_PUBLISHABLE_KEY`). Without them a tagged
release builds cleanly and then ships an installer that cannot sign in.

If the credentials are missing the app now says so on screen. It previously threw during
import, which took the whole module graph down before React could mount — and because the
window is created hidden and revealed only by the interface, the result was no window and
no error at all. `run()` in `src-tauri/src/lib.rs` reveals the window on a timer as a
second line of defence, so a frontend that never starts is visible rather than silent.

### Signing updates (required to publish a release)

The hub updates itself. The rail card downloads the new installer, checks it against the
public key compiled into `src-tauri/tauri.conf.json`, and runs it. Nothing unsigned is
ever installed, so every release must be signed.

Two repository **secrets** are needed (Settings → Secrets and variables → Actions →
Secrets; the Supabase values next door are variables, these are not):

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | the contents of the private key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password it was generated with |

To make a new pair:

```powershell
npm run tauri signer generate -- -w ~/.tauri/apro-works.key
```

Put the generated public key in `src-tauri/tauri.conf.json` and the private key in the
secret above.

**Losing the private key, or its password, means no already-installed copy can ever be
updated again.** The updater refuses a release it cannot verify and offers no way to
trust a new key from the client side; the only remedy is a manual reinstall by every
user. Keep a copy somewhere durable that is not this repository.

**Install with the NSIS setup, not the MSI.** The updater installs the NSIS package, and
an update only replaces an installation made by the same installer. Install from the MSI
and the first in-app update leaves two copies on the machine rather than one updated app.

The release workflow builds `latest.json` beside the installers and verifies it was
produced — a release without it is announced by the update check but refused by the
installer, which is a confusing state to hand anyone.

```powershell
# Install frontend deps and run the hub
npm install
npm run tauri dev

# Build and validate the orchestration layer
cargo build -p aproctl
cargo test --workspace          # 29 tests (the SDK's own tests run in its repo)
aproctl selftest                # 16 behavioural checks on a throwaway store
aproctl doctor                  # inspect the real store
npm run verify:workflow         # 30 checks on the workflow graph rules
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
