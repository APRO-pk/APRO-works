# Validating an APRO Works Deployment

How to prove that the orchestration layer actually works — on a developer machine, in CI, or
on a deployed workspace.

There are two tools, and they answer different questions:

| Tool | Question | Touches real data? |
| --- | --- | --- |
| `aproctl doctor` | Is this deployment **configured and healthy**? | No — read-only |
| `aproctl selftest` | Does the store **behave correctly**? | No — uses a throwaway store by default |

Together they cover "is it wired up" and "does it actually work".

---

## 1. Build the tools

```powershell
cargo build --release -p aproctl
# binary: target/release/aproctl.exe
```

For local development, `cargo build -p aproctl` and `target/debug/aproctl.exe` is fine.

Verify the build itself:

```powershell
cargo test --workspace
```

Expected: **26 tests pass** across the store, client, and API crates, including 8 end-to-end
HTTP tests that exercise real sockets, real authentication, and real payload bytes.

---

## 2. The 10-second check

```powershell
aproctl selftest
```

This runs 16 behavioural assertions against a **temporary store** and exits non-zero if any
fail. It is safe to run anywhere, any time — it cannot touch your real data.

Expected output ends with:

```
  16 passed, 0 warning(s), 0 failed
```

What it proves, in order:

| Check | Proves |
| --- | --- |
| store opens | SQLite opens and migrations apply |
| type identity rejects the legacy spaced slug | The `Propulsor - Liquid Engine…` slug class is rejected |
| app interface declares and persists | Declarations are recorded |
| publish then fetch returns identical bytes | Round-trip integrity, content hash correctness |
| byte-identical push does not create revision spam | Idempotent saves |
| changed bytes append an immutable revision with lineage | Immutability + parent linkage |
| tracking dependency goes stale on upstream change | Staleness computation |
| satisfying an edge clears staleness | `satisfy_edge` |
| a pinned dependency never goes stale | **Reproducibility guarantee** |
| a compatible dependency tracks a floor | `Compatible` mode |
| consumer can declare a dependency before the producer publishes | Placeholder artifacts |
| payloads above the inline threshold use the blob store | Blob path + on-disk integrity |
| event cursor is monotonic and does not replay | Change feed correctness |
| writing an undeclared type is refused | Write enforcement |
| demo data seeds and purges without touching real data | **Dummy-data isolation** |
| consumer declarations are recorded with their default mode | Consume contracts |

> Run `aproctl selftest --keep` to run the same checks against the **real** data directory. It
> only adds artifacts under the `selftest-app/` namespace, but it does write to your live store,
> so prefer the throwaway form unless you specifically want to test the real path.

---

## 3. Checking a real deployment

```powershell
aproctl doctor
```

Runs against `%LOCALAPPDATA%\APRO\Store` by default, or anywhere you point it:

```powershell
aproctl --data-dir D:\APRO\Store doctor
```

Read-only. It never writes to the store (it does write and delete a small probe file to confirm
the directory is genuinely writable, because `exists()` does not prove writability).

Example of a healthy deployment:

```
aproctl doctor — C:\Users\you\AppData\Local\APRO\Store
--------------------------------------------------------
  [PASS] data directory is writable
  [PASS] store opens
         SQLite opened and migrations applied
  [PASS] schema version
         v1 matches this build
  [PASS] node identity
         node_id 01a0e30d-2496-71a8-b611-248f9e782bc5
  [PASS] blob store is writable
  [PASS] blob integrity
         every referenced blob is present and hash-valid
  [PASS] demo data
         no seeded dummy data present
  [PASS] dependency graph
         0 edge(s), none stale
  [PASS] store contents
         0 artifact(s), 0 revision(s), 0 edge(s), 0 blob(s) (0 B)
  [WARN] api endpoint
         not checked; pass --endpoint http://127.0.0.1:PORT to verify the running API

  9 passed, 1 warning(s), 0 failed
```

Exit code is **0 when there are no failures**. Warnings do not fail the run — they are things an
operator should know (demo data present, dependencies stale, API not checked).

---

## 4. Checking the running API

`doctor` can also verify the live HTTP surface. Get the endpoint from the hub's console output
(it prints `APRO store listening on http://127.0.0.1:PORT`), or from the discovery file:

```powershell
Get-Content "$env:LOCALAPPDATA\APRO\store.json"
```

Then:

```powershell
aproctl doctor --endpoint http://127.0.0.1:52431
```

This adds two checks:

| Check | Meaning |
| --- | --- |
| api endpoint reachable | `GET /v1/health` returned `status: ok` |
| api authentication | `[PASS]` = launch tickets required (secure). `[WARN]` = running `--insecure`, **which must never happen on a store holding real data** |

You do not need a token; `/v1/health` is public by design, and it reports the auth mode so
`doctor` can flag an insecure deployment.

---

## 5. Running it in CI

`--json` emits a machine-readable report and preserves the exit code:

```yaml
- name: Validate orchestration layer
  run: |
    cargo build --release -p aproctl
    ./target/release/aproctl selftest --json
    ./target/release/aproctl doctor --json
```

```json
{
  "ok": true,
  "passed": 16,
  "warnings": 0,
  "failed": 0,
  "checks": [ { "name": "…", "status": "pass", "detail": "…" } ]
}
```

Recommended gating:

| Gate | Command | Fails on |
| --- | --- | --- |
| Always | `aproctl selftest --json` | Any behavioural regression |
| Always | `cargo test --workspace` | Unit + HTTP integration regressions |
| On deploy | `aproctl doctor --json` | Broken data dir, schema mismatch, corrupt blobs |
| On deploy | `aproctl doctor --endpoint … --json` | API unreachable, auth disabled |

Because `doctor` reports **warnings** for stale dependencies and demo data, `doctor --json` is
safe to run as a gate: only genuine failures set `"ok": false`.

---

## 6. Dummy data: creating and removing it

The platform ships a removable demo dataset so the whole feature can be exercised before real
apps are integrated.

### Create

```powershell
aproctl seed
```

It writes **3 artifacts, 4 revisions, 2 dependency edges**, deliberately engineered so that
**exactly one edge is stale** — the CAD → 6DOF scenario:

| Artifact | Instance | Revisions | Encoding |
| --- | --- | --- | --- |
| `burn-geometry-modeler/grain-geometry` | `engine-demo` | 2 | JSON (inline) |
| `burn-geometry-modeler/geometry-step` | `engine-demo` | 1 | Blob, 96 KiB (exercises the blob path) |
| `apro-demo/propellant` | `lox-ch4` | 1 | JSON |

| Consumer | Type | Mode | State |
| --- | --- | --- | --- |
| `hexadof` / `run-demo-001` | `burn-geometry-modeler/grain-geometry` | `tracking` | **STALE** (satisfied at rev 1, now at rev 2) |
| `hexadof` / `run-demo-001` | `apro-demo/propellant` | `pinned` | fresh (never goes stale) |

```powershell
aproctl edges
# hexadof  run-demo-001  burn-geometry-modeler/grain-geometry  tracking  1  2  STALE
# hexadof  run-demo-001  apro-demo/propellant                 pinned    1  1  fresh
```

Seeding is **idempotent**: running it twice does nothing. Use `--force` to rebuild:

```powershell
aproctl seed --force
```

### Remove

```powershell
aproctl purge-demo                # removes the standard demo batch
aproctl purge-demo --all          # removes every seeded batch, whatever its name
aproctl purge-demo --batch demo-v1
```

The purge removes the artifacts, their revisions, their edges, their events, **and prunes the
now-unreferenced blobs**. Verified output:

```
  artifacts : 3
  revisions : 4
  edges     : 2
  events    : 9
  blobs     : 1 (96.0 KiB)
```

### Why it is guaranteed removable

Two independent mechanisms make demo data safe to remove and impossible to confuse with real data:

1. **A seed-batch marker.** Every artifact written by `seed` carries `seed_batch = "demo-v1"`
   in its own column. Purge selects on that marker.
2. **A reserved namespace.** `apro-demo/*` is reserved, and purge additionally matches it.

Real artifacts have no marker and live outside the namespace, so they are not eligible under
either rule. This is asserted by a test
(`purge_removes_every_demo_artifact_and_leaves_real_data_alone`) and by the `selftest` check
`demo data seeds and purges without touching real data`, which writes a real artifact first and
asserts it survives.

Demo data is also **hidden by default**: `aproctl ls` will not show it unless you pass
`--include-demo`, and `GET /v1/artifacts` filters it out unless `include_demo=true`. Seeded
payloads additionally carry `"demo": true` inside their JSON, so a human inspecting the bytes
can always tell.

### From the hub UI

The same operations are exposed to the frontend as Tauri commands:

```ts
await invoke("seed_store_demo", { force: false });
await invoke("purge_store_demo");
const status = await invoke("get_store_status");
```

So the platform can offer a "Load sample data" / "Remove sample data" control without shelling
out to `aproctl`.

---

## 7. Check reference

### `aproctl doctor`

| Check | PASS means | If it FAILS |
| --- | --- | --- |
| data directory is writable | A probe file round-tripped | Check permissions and that the path exists. On a locked-down machine, `%LOCALAPPDATA%` may be redirected |
| store opens | SQLite opened, migrations applied | The file may be corrupt or locked by another process. Check `store.db` in the data dir |
| schema version | `user_version` matches this build | The store was written by a **different** version of APRO Works. Do not downgrade; use the matching build or start a fresh data dir |
| node identity | `node_id` is present | The `meta` table is missing its node id; the store is damaged |
| blob store is writable | The blobs directory is writable | Same causes as the data directory |
| blob integrity | Every referenced blob exists **and** hashes correctly | Data loss or disk corruption. The affected revisions cannot be recovered from this store alone |
| demo data | No seeded artifacts | Not a failure. Informational: run `aproctl purge-demo` to clean up |
| dependency graph | No stale edges | Not a failure. It means consumers genuinely are behind their producers |
| store contents | Counters read successfully | A database read error |
| api endpoint reachable | `/v1/health` returned ok | The hub is not running, or the port is wrong |
| api authentication | Secure mode | **Action required if this is a real deployment** — `--insecure` accepts any token |

### `aproctl selftest`

Any FAIL is a behavioural regression and should block a release. The most load-bearing ones:

- **a pinned dependency never goes stale** — if this fails, reproducibility is broken. A past
  simulation result could stop referring to the inputs it actually used.
- **demo data seeds and purges without touching real data** — if this fails, dummy data is no
  longer safely removable.
- **writing an undeclared type is refused** — if this fails, write enforcement is off, and one
  app can silently corrupt another's namespace.
- **byte-identical push does not create revision spam** — if this fails, ordinary save
  operations will flood the revision history.

---

## 8. Manual end-to-end acceptance test

Run this before declaring the layer ready for real apps.

**Setup**

```powershell
cargo build -p aproctl
$exe = "target\debug\aproctl.exe"
$store = "$env:TEMP\apro-acceptance"
& $exe --data-dir $store seed --force
& $exe --data-dir $store doctor
```

- [ ] `doctor` reports **0 failed**
- [ ] `doctor` warns that 3 seeded artifacts are present

**1 — Dummy data is invisible by default**

```powershell
& $exe --data-dir $store ls
```
- [ ] Reports "No artifacts"
- [ ] Explains that demo data is hidden

**2 — Dummy data is visible on request**

```powershell
& $exe --data-dir $store ls --include-demo
```
- [ ] Shows 3 artifacts, each with marker `demo-v1`
- [ ] `grain-geometry` shows `REV 2`, `REVS 2`

**3 — Staleness is real**

```powershell
& $exe --data-dir $store edges
```
- [ ] `grain-geometry` edge is `STALE` (satisfied 1, current 2)
- [ ] `propellant` edge is `fresh` and `pinned`

**4 — The API serves it over loopback**

```powershell
& $exe --data-dir $store serve --port 45911 --session-for hexadof
```
In a second terminal:

```powershell
& $exe --data-dir $store doctor --endpoint http://127.0.0.1:45911
```
- [ ] `api endpoint reachable` PASSes
- [ ] `api authentication` PASSes as secure

**5 — Auth actually gates access**

```powershell
curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:45911/v1/stats
```
- [ ] Prints `401`

**6 — Pull works and metadata is correct**

```powershell
$s = "<session token printed by serve>"
curl.exe -s -D - "http://127.0.0.1:45911/v1/pull?type_id=burn-geometry-modeler%2Fgrain-geometry&instance=engine-demo" -H "Authorization: Bearer $s"
```
- [ ] Body is JSON with `"outer_diameter": 152.4` and `"inner_diameter": 80.0`
- [ ] `x-apro-revision-number: 2`
- [ ] `x-apro-encoding: json`
- [ ] `x-apro-seed-batch: demo-v1`

> On PowerShell 5.1, use `curl.exe` or `Invoke-WebRequest -UseBasicParsing`. Plain
> `Invoke-WebRequest` tries to parse `application/octet-stream` through the IE engine and
> prompts, which fails in non-interactive shells.

**7 — Full removal**

```powershell
& $exe --data-dir $store purge-demo
& $exe --data-dir $store ls --include-demo
& $exe --data-dir $store stats
```
- [ ] Purge reports 3 artifacts, 4 revisions, 2 edges, 1 blob
- [ ] `ls --include-demo` reports no artifacts
- [ ] `stats` reports `0 artifacts`, `0 blobs`, and the blob directory on disk is empty

**8 — The workspace itself is clean**

```powershell
cargo test --workspace
```
- [ ] 26 tests pass

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `driver cannot bind 127.0.0.1` / `failed to bind` | Port already in use | Use `--port 0` to let the OS choose |
| `invalid_type_id` naming a spaced slug | Using `"Propulsor - Liquid Engine Design Studio"` as an app slug | Normalize to kebab-case. See `APP_INTEGRATION.md` §2 |
| `write_not_declared` | Pushing a type not in your declared `publishes` | Call `declare_interface` at startup with every published type |
| `unauthorized` on every request | Ticket expired (90 s) or already redeemed (single-use) | Relaunch from the hub; the client exchanges the ticket automatically |
| `forbidden` / identity mismatch | `x-apro-app` disagrees with the session | Send the app slug that the session was issued for, or omit the header |
| `artifact_not_found` on pull | Type+instance never published | Expected before the producer's first push; handle `Ok(None)` |
| App hangs on a store call | Blocking `reqwest` client called inside a Tokio runtime | Wrap in `spawn_blocking` |
| `schema version` FAIL | Store written by a different build | Use the matching build, or point `--data-dir` at a fresh directory |
| `blob integrity` FAIL | Missing or corrupt blob file | Data loss; restore from backup or accept losing those revisions |
| `api endpoint reachable` FAIL | Hub not running | Start the hub, or read the endpoint from `%LOCALAPPDATA%\APRO\store.json` |
| App loses data access mid-session | The hub was closed; the store is hosted in-process | Known limitation — see `DESIGN.md` §7 R1. Relaunch the hub, or restart from it |
| `doctor` prompt/hang in a script | PowerShell 5.1 `Invoke-WebRequest` on binary responses | Use `curl.exe` or `-UseBasicParsing` |

---

## 10. Known gaps at this stage

Stated plainly so validation is not mistaken for completeness:

1. **Closing the hub destroys the store.** In-process hosting is a deliberate v1 trade-off.
   `handleClose()` in `src/App.tsx` currently calls `window.destroy()`, which exits the process
   and takes the store with it. The required fix (hide-to-tray, warn on quit when products are
   running) is specified in `DESIGN.md` §7 R1 and is **not yet implemented**.
2. **No hub UI yet.** `get_store_status`, `seed_store_demo`, and `purge_store_demo` are wired
   and callable, but `App.tsx` has no Data section rendering them.
3. **No blob garbage collection.** Blobs are pruned on `purge-demo`, but revisions are never
   deleted otherwise, so long-lived stores grow monotonically. Accepted for now.
4. **Revisions cannot be deleted.** Deliberate — immutability is the foundation of
   reproducibility. A retention policy is future work.
5. **Single-user only.** Identity is attributed via `created_by`/`node_id` and IDs are UUIDv7
   precisely so a later sync layer can work, but no sharing exists yet.
6. **No encryption at rest.** The store will hold proprietary design data. Revisit before any
   multi-user or shared-machine deployment.
