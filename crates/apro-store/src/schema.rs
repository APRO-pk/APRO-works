//! Schema and migrations.
//!
//! Migrations are driven by `PRAGMA user_version`. To add a migration: bump
//! [`SCHEMA_VERSION`] and append an arm to [`migrate`]. Never edit an existing arm.

use rusqlite::Connection;

use crate::error::Result;

pub const SCHEMA_VERSION: i32 = 2;

const V1: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact (
  artifact_id         TEXT PRIMARY KEY,
  type_id             TEXT NOT NULL,
  owner_app           TEXT NOT NULL,
  instance            TEXT NOT NULL,
  label               TEXT,
  current_revision_id TEXT,
  created_by          TEXT,
  origin_node_id      TEXT NOT NULL,
  seed_batch          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (type_id, instance)
);

CREATE INDEX IF NOT EXISTS idx_artifact_type  ON artifact (type_id);
CREATE INDEX IF NOT EXISTS idx_artifact_owner ON artifact (owner_app);
CREATE INDEX IF NOT EXISTS idx_artifact_seed  ON artifact (seed_batch);

-- Immutable. A row here is never updated after insert (DESIGN.md D3).
CREATE TABLE IF NOT EXISTS revision (
  revision_id        TEXT PRIMARY KEY,
  artifact_id        TEXT NOT NULL REFERENCES artifact (artifact_id) ON DELETE CASCADE,
  parent_revision_id TEXT REFERENCES revision (revision_id) ON DELETE SET NULL,
  revision_number    INTEGER NOT NULL,
  type_id            TEXT NOT NULL,
  encoding           TEXT NOT NULL,
  inline_payload     BLOB,
  blob_hash          TEXT,
  content_hash       TEXT NOT NULL,
  byte_size          INTEGER NOT NULL,
  created_by         TEXT,
  origin_node_id     TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  UNIQUE (artifact_id, revision_number),
  CHECK (inline_payload IS NOT NULL OR blob_hash IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_revision_artifact ON revision (artifact_id, revision_number);
CREATE INDEX IF NOT EXISTS idx_revision_content  ON revision (content_hash);
CREATE INDEX IF NOT EXISTS idx_revision_blob     ON revision (blob_hash);

-- consumer_ref is NOT NULL DEFAULT '' so UNIQUE can dedupe edges with no ref.
CREATE TABLE IF NOT EXISTS edge (
  edge_id                    TEXT PRIMARY KEY,
  consumer_app               TEXT NOT NULL,
  consumer_ref               TEXT NOT NULL DEFAULT '',
  artifact_id                TEXT NOT NULL REFERENCES artifact (artifact_id) ON DELETE CASCADE,
  mode                       TEXT NOT NULL,
  pinned_revision_id         TEXT REFERENCES revision (revision_id) ON DELETE SET NULL,
  min_revision_number        INTEGER,
  last_satisfied_revision_id TEXT REFERENCES revision (revision_id) ON DELETE SET NULL,
  created_by                 TEXT,
  created_at                 INTEGER NOT NULL,
  UNIQUE (consumer_app, consumer_ref, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_edge_artifact ON edge (artifact_id);
CREATE INDEX IF NOT EXISTS idx_edge_consumer ON edge (consumer_app, consumer_ref);

-- Append-only. `seq` is the change cursor (DESIGN.md 5.2).
CREATE TABLE IF NOT EXISTS event (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  type_id     TEXT,
  artifact_id TEXT,
  revision_id TEXT,
  edge_id     TEXT,
  actor_app   TEXT,
  summary     TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_artifact ON event (artifact_id);

CREATE TABLE IF NOT EXISTS app_interface (
  app          TEXT NOT NULL,
  direction    TEXT NOT NULL,
  type_id      TEXT NOT NULL,
  default_mode TEXT,
  source       TEXT NOT NULL,
  declared_at  INTEGER NOT NULL,
  PRIMARY KEY (app, direction, type_id)
);

CREATE TABLE IF NOT EXISTS type_registry (
  type_id        TEXT PRIMARY KEY,
  owner_app      TEXT NOT NULL,
  descriptor_set BLOB,
  registered_at  INTEGER NOT NULL
);
"#;

/// v2 — read logging and type-level subscriptions.
///
/// `access_log` is deliberately NOT the `event` table. Consumers poll `event` with a
/// cursor to learn what *changed*; read records in that feed would spam every app's
/// change loop with entries it does not care about.
///
/// `subscription` is what the workflow canvas edits. A wire is type-level ("the CAD
/// app's mass properties feed HexaDOF"), while an `edge` is instance-level, so concrete
/// edges are *materialised* from a subscription — one per existing instance — and kept
/// up to date as new instances appear.
const V2: &str = r#"
CREATE TABLE IF NOT EXISTS access_log (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_app       TEXT NOT NULL,
  type_id         TEXT NOT NULL,
  instance        TEXT NOT NULL,
  revision_id     TEXT,
  revision_number INTEGER,
  outcome         TEXT NOT NULL,   -- 'hit' | 'miss'
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_access_type  ON access_log (type_id, seq);
CREATE INDEX IF NOT EXISTS idx_access_actor ON access_log (actor_app, seq);

CREATE TABLE IF NOT EXISTS subscription (
  subscription_id TEXT PRIMARY KEY,
  consumer_app    TEXT NOT NULL,
  type_id         TEXT NOT NULL,
  mode            TEXT NOT NULL,
  created_by      TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (consumer_app, type_id)
);

CREATE INDEX IF NOT EXISTS idx_subscription_type ON subscription (type_id);
"#;

/// Apply pending migrations. Idempotent.
pub fn migrate(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;

    let mut version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    if version < 1 {
        conn.execute_batch(V1)?;
        version = 1;
    }

    if version < 2 {
        conn.execute_batch(V2)?;
        version = 2;
    }

    if version != SCHEMA_VERSION {
        return Err(crate::error::StoreError::Config(format!(
            "store schema version {version} does not match this build's expected {SCHEMA_VERSION}; \
             the store was written by a different version of APRO Works"
        )));
    }

    conn.pragma_update(None, "user_version", version)?;
    Ok(())
}
