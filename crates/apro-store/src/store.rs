//! The store: SQLite metadata + content-addressed blobs + an append-only event log.
//!
//! Design contract (see DESIGN.md):
//! * Revisions are immutable. `revision` rows are only ever inserted (D3).
//! * Payload bytes are opaque. This module never parses them (D1, D12).
//! * Freshness is computed from the graph on read, never stored (5.3).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension};

use crate::blob::{content_hash, BlobStore};
use crate::error::{Result, StoreError};
use apro_types::*;
use crate::schema;

pub(crate) fn now_millis() -> Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn opt_u32(value: Option<i64>) -> Option<u32> {
    value.map(|v| v as u32)
}

/// Instance names become part of a stable identity, so they must not be able to
/// escape their namespace or carry control characters.
fn validate_instance(instance: &str) -> Result<()> {
    if instance.is_empty() || instance.len() > 200 {
        return Err(StoreError::invalid(
            "instance must be 1-200 characters".to_string(),
        ));
    }
    if instance == "." || instance == ".." {
        return Err(StoreError::invalid(format!(
            "instance {instance:?} is not a valid name"
        )));
    }
    if instance
        .chars()
        .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err(StoreError::invalid(format!(
            "instance {instance:?} must not contain control characters or path separators"
        )));
    }
    Ok(())
}

pub(crate) fn validate_app(app: &str) -> Result<()> {
    if app.is_empty() || app.len() > 64 {
        return Err(StoreError::invalid(
            "app slug must be 1-64 characters".to_string(),
        ));
    }
    let ok = app
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok || app.starts_with('-') || app.ends_with('-') {
        return Err(StoreError::invalid(format!(
            "app slug {app:?} must be kebab-case (a-z, 0-9, '-')"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct StoreConfig {
    pub data_dir: PathBuf,
    /// When true (the default), an app that has declared at least one publish is
    /// rejected if it writes a type it did not declare. Apps with no declarations
    /// are allowed through, so a not-yet-integrated app can still be onboarded.
    pub enforce_declared_writes: bool,
}

impl StoreConfig {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            enforce_declared_writes: true,
        }
    }
}

/// Default store location: `%LOCALAPPDATA%\APRO\Store`.
pub fn default_data_dir() -> Result<PathBuf> {
    let local = dirs::data_local_dir().ok_or_else(|| {
        StoreError::Config("unable to locate the local app data directory".to_string())
    })?;
    Ok(local.join("APRO").join("Store"))
}

struct Inner {
    conn: Mutex<Connection>,
    blobs: BlobStore,
    config: StoreConfig,
    node_id: String,
}

#[derive(Clone)]
pub struct Store {
    inner: Arc<Inner>,
}

impl Store {
    pub fn open(config: StoreConfig) -> Result<Self> {
        std::fs::create_dir_all(&config.data_dir)?;
        let blobs = BlobStore::new(config.data_dir.join("blobs"));
        blobs.ensure()?;

        let conn = Connection::open(config.data_dir.join("store.db"))?;
        schema::migrate(&conn)?;

        let node_id = match conn
            .query_row("SELECT value FROM meta WHERE key = 'node_id'", [], |row| {
                row.get::<_, String>(0)
            })
            .optional()?
        {
            Some(existing) => existing,
            None => {
                let generated = uuid::Uuid::now_v7().to_string();
                conn.execute(
                    "INSERT INTO meta (key, value) VALUES ('node_id', ?1)",
                    params![generated],
                )?;
                generated
            }
        };

        Ok(Self {
            inner: Arc::new(Inner {
                conn: Mutex::new(conn),
                blobs,
                config,
                node_id,
            }),
        })
    }

    pub fn open_default() -> Result<Self> {
        Self::open(StoreConfig::new(default_data_dir()?))
    }

    pub fn node_id(&self) -> &str {
        &self.inner.node_id
    }

    pub fn data_dir(&self) -> &Path {
        &self.inner.config.data_dir
    }

    pub fn blobs(&self) -> &BlobStore {
        &self.inner.blobs
    }

    /// Recover from a poisoned mutex rather than cascading the panic: a previous
    /// panic mid-transaction is rolled back by SQLite on drop, so the connection
    /// itself is still usable.
    pub(crate) fn conn(&self) -> MutexGuard<'_, Connection> {
        self.inner
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    // -- declarations -------------------------------------------------------

    pub fn declare_interface(&self, decl: &AppInterface, source: &str) -> Result<()> {
        validate_app(&decl.app)?;
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let ts = now_millis();

        for type_id in &decl.publishes {
            tx.execute(
                "INSERT INTO app_interface (app, direction, type_id, default_mode, source, declared_at)
                 VALUES (?1, 'publish', ?2, NULL, ?3, ?4)
                 ON CONFLICT (app, direction, type_id)
                 DO UPDATE SET source = excluded.source, declared_at = excluded.declared_at",
                params![decl.app, type_id.as_str(), source, ts],
            )?;
            register_type(&tx, type_id, &decl.app, ts)?;
        }

        for consume in &decl.consumes {
            tx.execute(
                "INSERT INTO app_interface (app, direction, type_id, default_mode, source, declared_at)
                 VALUES (?1, 'consume', ?2, ?3, ?4, ?5)
                 ON CONFLICT (app, direction, type_id)
                 DO UPDATE SET default_mode = excluded.default_mode,
                               source = excluded.source,
                               declared_at = excluded.declared_at",
                params![
                    decl.app,
                    consume.type_id.as_str(),
                    consume.default_mode.as_str(),
                    source,
                    ts
                ],
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    pub fn declared_types(&self, app: &str, direction: &str) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT type_id FROM app_interface WHERE app = ?1 AND direction = ?2 ORDER BY type_id",
        )?;
        let rows = stmt.query_map(params![app, direction], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn interfaces(&self) -> Result<Vec<DeclaredType>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT app, direction, type_id, default_mode, source, declared_at
             FROM app_interface ORDER BY app, direction, type_id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(DeclaredType {
                app: row.get(0)?,
                direction: row.get(1)?,
                type_id: row.get(2)?,
                default_mode: row.get(3)?,
                source: row.get(4)?,
                declared_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn registered_types(&self) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT type_id FROM type_registry ORDER BY type_id")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    // -- push ---------------------------------------------------------------

    pub fn push(&self, req: PushRequest) -> Result<RevisionHandle> {
        validate_instance(&req.instance)?;
        validate_app(&req.actor_app)?;

        if self.inner.config.enforce_declared_writes {
            let declared = self.declared_types(&req.actor_app, "publish")?;
            if !declared.is_empty() && !declared.iter().any(|t| t == req.type_id.as_str()) {
                return Err(StoreError::WriteNotDeclared {
                    app: req.actor_app,
                    type_id: req.type_id.as_str().to_string(),
                    declared,
                });
            }
        }

        // Blob writes are idempotent and must not happen inside the transaction.
        let byte_size = req.payload.len() as u64;
        let hash = content_hash(&req.payload);
        let (inline_payload, blob_hash) = if req.payload.len() <= INLINE_MAX_BYTES {
            (Some(req.payload.clone()), None)
        } else {
            let (blob_hash, _) = self.inner.blobs.put(&req.payload)?;
            (None, Some(blob_hash))
        };

        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let ts = now_millis();

        let existing: Option<(String, Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT artifact_id, current_revision_id, seed_batch FROM artifact
                 WHERE type_id = ?1 AND instance = ?2",
                params![req.type_id.as_str(), req.instance],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;

        let (artifact_id, created_new_artifact) = match &existing {
            Some((id, _, _)) => (id.clone(), false),
            None => {
                let id = uuid::Uuid::now_v7().to_string();
                tx.execute(
                    "INSERT INTO artifact
                       (artifact_id, type_id, owner_app, instance, label, current_revision_id,
                        created_by, origin_node_id, seed_batch, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9, ?9)",
                    params![
                        id,
                        req.type_id.as_str(),
                        req.type_id.owner_app(),
                        req.instance,
                        req.label,
                        req.created_by,
                        self.inner.node_id,
                        req.seed_batch,
                        ts
                    ],
                )?;
                register_type(&tx, &req.type_id, req.type_id.owner_app(), ts)?;
                emit_event(
                    &tx,
                    "artifact.created",
                    Some(req.type_id.as_str()),
                    Some(&id),
                    None,
                    None,
                    Some(&req.actor_app),
                    Some(&format!("created {}/{}", req.type_id, req.instance)),
                )?;
                (id, true)
            }
        };

        // Idempotence: identical bytes to the current revision do not create a revision.
        if let Some((_, Some(current_revision_id), _)) = &existing {
            let current_hash: Option<String> = tx
                .query_row(
                    "SELECT content_hash FROM revision WHERE revision_id = ?1",
                    params![current_revision_id],
                    |row| row.get(0),
                )
                .optional()?;
            if current_hash.as_deref() == Some(hash.as_str()) {
                let number: i64 = tx.query_row(
                    "SELECT revision_number FROM revision WHERE revision_id = ?1",
                    params![current_revision_id],
                    |row| row.get(0),
                )?;
                tx.commit()?;
                return Ok(RevisionHandle {
                    artifact_id,
                    revision_id: current_revision_id.clone(),
                    revision_number: number as u32,
                    content_hash: hash,
                    byte_size,
                    created_new_artifact: false,
                    unchanged: true,
                });
            }
        }

        let parent_revision_id: Option<String> = tx
            .query_row(
                "SELECT current_revision_id FROM artifact WHERE artifact_id = ?1",
                params![artifact_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();

        let next_number: i64 = tx.query_row(
            "SELECT COALESCE(MAX(revision_number), 0) + 1 FROM revision WHERE artifact_id = ?1",
            params![artifact_id],
            |row| row.get(0),
        )?;

        let revision_id = uuid::Uuid::now_v7().to_string();
        tx.execute(
            "INSERT INTO revision
               (revision_id, artifact_id, parent_revision_id, revision_number, type_id, encoding,
                inline_payload, blob_hash, content_hash, byte_size, created_by, origin_node_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                revision_id,
                artifact_id,
                parent_revision_id,
                next_number,
                req.type_id.as_str(),
                req.encoding.as_str(),
                inline_payload,
                blob_hash,
                hash,
                byte_size,
                req.created_by,
                self.inner.node_id,
                ts
            ],
        )?;

        tx.execute(
            "UPDATE artifact SET current_revision_id = ?1, updated_at = ?2,
                   label = COALESCE(?3, label),
                   seed_batch = COALESCE(seed_batch, ?4)
             WHERE artifact_id = ?5",
            params![revision_id, ts, req.label, req.seed_batch, artifact_id],
        )?;

        emit_event(
            &tx,
            "revision.published",
            Some(req.type_id.as_str()),
            Some(&artifact_id),
            Some(&revision_id),
            None,
            Some(&req.actor_app),
            Some(&format!(
                "revision {next_number} of {}/{} ({} bytes, {})",
                req.type_id,
                req.instance,
                byte_size,
                req.encoding
            )),
        )?;

        // A newly published artifact may satisfy subscriptions created before it existed.
        // Existing edges use DO NOTHING, so re-running this never resets staleness.
        crate::wiring::materialize_for_type(&tx, req.type_id.as_str(), ts)?;

        tx.commit()?;

        Ok(RevisionHandle {
            artifact_id,
            revision_id,
            revision_number: next_number as u32,
            content_hash: hash,
            byte_size,
            created_new_artifact,
            unchanged: false,
        })
    }

    // -- read ---------------------------------------------------------------

    pub fn get_artifact(&self, artifact_id: &str) -> Result<Option<ArtifactSummary>> {
        let conn = self.conn();
        fetch_artifact_by_id(&conn, artifact_id)
    }

    pub fn find_artifact(&self, type_id: &TypeId, instance: &str) -> Result<Option<ArtifactSummary>> {
        let conn = self.conn();
        let row = conn
            .query_row(
                &format!("{ARTIFACT_SELECT} WHERE a.type_id = ?1 AND a.instance = ?2"),
                params![type_id.as_str(), instance],
                map_artifact,
            )
            .optional()?;
        Ok(row)
    }

    pub fn list_artifacts(&self, filter: &ArtifactFilter) -> Result<Vec<ArtifactSummary>> {
        let conn = self.conn();
        let sql = format!(
            "{ARTIFACT_SELECT}
             WHERE (?1 IS NULL OR a.type_id = ?1)
               AND (?2 IS NULL OR a.owner_app = ?2)
               AND (?3 IS NULL OR a.instance = ?3)
               AND (?4 = 1 OR a.seed_batch IS NULL)
             ORDER BY a.updated_at DESC, a.artifact_id"
        );
        let include_demo: i64 = if filter.include_demo { 1 } else { 0 };
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![
                filter.type_id,
                filter.owner_app,
                filter.instance,
                include_demo
            ],
            map_artifact,
        )?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn list_revisions(&self, type_id: &TypeId, instance: &str) -> Result<Vec<RevisionSummary>> {
        let conn = self.conn();
        let artifact_id: Option<String> = conn
            .query_row(
                "SELECT artifact_id FROM artifact WHERE type_id = ?1 AND instance = ?2",
                params![type_id.as_str(), instance],
                |row| row.get(0),
            )
            .optional()?;
        let Some(artifact_id) = artifact_id else {
            return Ok(Vec::new());
        };
        let mut stmt = conn.prepare(
            "SELECT revision_id, artifact_id, revision_number, parent_revision_id, encoding,
                    content_hash, byte_size, created_by, origin_node_id, created_at
             FROM revision WHERE artifact_id = ?1 ORDER BY revision_number ASC",
        )?;
        let rows = stmt.query_map(params![artifact_id], map_revision)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Returns `None` when the artifact or the requested revision does not exist.
    pub fn pull(
        &self,
        type_id: &TypeId,
        instance: &str,
        selector: Selector,
    ) -> Result<Option<FetchedRevision>> {
        let conn = self.conn();
        let Some(artifact) = conn
            .query_row(
                &format!("{ARTIFACT_SELECT} WHERE a.type_id = ?1 AND a.instance = ?2"),
                params![type_id.as_str(), instance],
                map_artifact,
            )
            .optional()?
        else {
            return Ok(None);
        };

        let Some(revision_row) = fetch_revision_row(&conn, &artifact.artifact_id, selector)? else {
            return Ok(None);
        };

        let payload = match (&revision_row.inline, &revision_row.blob_hash) {
            (Some(bytes), _) => bytes.clone(),
            (None, Some(hash)) => self.inner.blobs.get(hash)?,
            (None, None) => {
                return Err(StoreError::Config(format!(
                    "revision {} has neither an inline payload nor a blob",
                    revision_row.summary.revision_id
                )))
            }
        };

        Ok(Some(FetchedRevision {
            artifact,
            revision: revision_row.summary,
            payload,
        }))
    }

    pub fn revision_payload(&self, revision_id: &str) -> Result<Option<Vec<u8>>> {
        let conn = self.conn();
        let row: Option<(Option<Vec<u8>>, Option<String>)> = conn
            .query_row(
                "SELECT inline_payload, blob_hash FROM revision WHERE revision_id = ?1",
                params![revision_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match row {
            None => Ok(None),
            Some((Some(bytes), _)) => Ok(Some(bytes)),
            Some((None, Some(hash))) => Ok(Some(self.inner.blobs.get(&hash)?)),
            Some((None, None)) => Err(StoreError::Config(format!(
                "revision {revision_id} has no payload"
            ))),
        }
    }

    // -- edges --------------------------------------------------------------

    pub fn register_edge(&self, req: EdgeRequest) -> Result<EdgeSummary> {
        validate_app(&req.consumer_app)?;
        validate_instance(&req.instance)?;

        let consumer_ref = req.consumer_ref.clone().unwrap_or_default();
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let ts = now_millis();

        // A consumer may declare a dependency before the producer has ever published.
        // That creates a placeholder artifact with no revisions yet.
        let existing: Option<String> = tx
            .query_row(
                "SELECT artifact_id FROM artifact WHERE type_id = ?1 AND instance = ?2",
                params![req.type_id.as_str(), req.instance],
                |row| row.get(0),
            )
            .optional()?;

        let artifact_id = match existing {
            Some(id) => id,
            None => {
                let id = uuid::Uuid::now_v7().to_string();
                tx.execute(
                    "INSERT INTO artifact
                       (artifact_id, type_id, owner_app, instance, label, current_revision_id,
                        created_by, origin_node_id, seed_batch, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, ?5, NULL, ?6, ?6)",
                    params![
                        id,
                        req.type_id.as_str(),
                        req.type_id.owner_app(),
                        req.instance,
                        self.inner.node_id,
                        ts
                    ],
                )?;
                register_type(&tx, &req.type_id, req.type_id.owner_app(), ts)?;
                emit_event(
                    &tx,
                    "artifact.created",
                    Some(req.type_id.as_str()),
                    Some(&id),
                    None,
                    None,
                    Some(&req.consumer_app),
                    Some(&format!(
                        "placeholder artifact for {}/{} declared by consumer",
                        req.type_id, req.instance
                    )),
                )?;
                id
            }
        };

        let current: Option<(String, i64)> = tx
            .query_row(
                "SELECT revision_id, revision_number FROM revision
                 WHERE artifact_id = ?1 ORDER BY revision_number DESC LIMIT 1",
                params![artifact_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        let resolve_number = |number: Option<u32>| -> Result<Option<String>> {
            match number {
                None => Ok(None),
                Some(n) => {
                    let found: Option<String> = tx
                        .query_row(
                            "SELECT revision_id FROM revision WHERE artifact_id = ?1 AND revision_number = ?2",
                            params![artifact_id, n],
                            |row| row.get(0),
                        )
                        .optional()?;
                    if found.is_none() {
                        return Err(StoreError::RevisionNotFound {
                            artifact_id: artifact_id.clone(),
                            selector: format!("number {n}"),
                        });
                    }
                    Ok(found)
                }
            }
        };

        let (pinned_revision_id, min_revision_number, satisfied) = match req.mode {
            Mode::Pinned => {
                let pinned = match resolve_number(req.pinned_revision_number)? {
                    Some(id) => Some(id),
                    None => current.as_ref().map(|(id, _)| id.clone()),
                };
                let Some(pinned) = pinned else {
                    return Err(StoreError::invalid(format!(
                        "a pinned dependency on {}/{} needs an existing revision, or an explicit \
                         pinned_revision_number; the artifact has no revisions yet",
                        req.type_id, req.instance
                    )));
                };
                (Some(pinned.clone()), None, Some(pinned))
            }
            Mode::Tracking => (None, None, current.as_ref().map(|(id, _)| id.clone())),
            Mode::Compatible => {
                let min = req.min_revision_number.unwrap_or(1);
                let satisfied = match &current {
                    Some((id, number)) if (*number as u32) >= min => Some(id.clone()),
                    _ => None,
                };
                (None, Some(min), satisfied)
            }
        };

        let edge_id: String = tx
            .query_row(
                "SELECT edge_id FROM edge WHERE consumer_app = ?1 AND consumer_ref = ?2 AND artifact_id = ?3",
                params![req.consumer_app, consumer_ref, artifact_id],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());

        tx.execute(
            "INSERT INTO edge
               (edge_id, consumer_app, consumer_ref, artifact_id, mode, pinned_revision_id,
                min_revision_number, last_satisfied_revision_id, created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9)
             ON CONFLICT (consumer_app, consumer_ref, artifact_id)
             DO UPDATE SET mode = excluded.mode,
                           pinned_revision_id = excluded.pinned_revision_id,
                           min_revision_number = excluded.min_revision_number,
                           last_satisfied_revision_id = excluded.last_satisfied_revision_id",
            params![
                edge_id,
                req.consumer_app,
                consumer_ref,
                artifact_id,
                req.mode.as_str(),
                pinned_revision_id,
                min_revision_number,
                satisfied,
                ts
            ],
        )?;

        emit_event(
            &tx,
            "edge.created",
            Some(req.type_id.as_str()),
            Some(&artifact_id),
            None,
            Some(&edge_id),
            Some(&req.consumer_app),
            Some(&format!(
                "{} depends on {}/{} ({})",
                req.consumer_app, req.type_id, req.instance, req.mode
            )),
        )?;

        tx.commit()?;

        get_edge_with(&conn, &edge_id)?.ok_or_else(|| StoreError::EdgeNotFound(edge_id))
    }

    pub fn get_edge(&self, edge_id: &str) -> Result<Option<EdgeSummary>> {
        let conn = self.conn();
        get_edge_with(&conn, edge_id)
    }

    pub fn list_edges(&self, filter: &EdgeFilter) -> Result<Vec<EdgeSummary>> {
        let conn = self.conn();
        list_edges_with(&conn, filter)
    }

    /// Advance an edge to a revision. With `None` it advances to the artifact's
    /// current revision.
    pub fn satisfy_edge(&self, edge_id: &str, revision_number: Option<u32>) -> Result<EdgeSummary> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;

        let row: Option<(String, String, i64)> = tx
            .query_row(
                "SELECT artifact_id, mode, min_revision_number FROM edge WHERE edge_id = ?1",
                params![edge_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, Option<i64>>(2)?.unwrap_or(1))),
            )
            .optional()?;
        let Some((artifact_id, mode, min_number)) = row else {
            return Err(StoreError::EdgeNotFound(edge_id.to_string()));
        };
        let mode = Mode::parse(&mode)?;

        let target: Option<(String, i64)> = match revision_number {
            Some(n) => tx
                .query_row(
                    "SELECT revision_id, revision_number FROM revision
                     WHERE artifact_id = ?1 AND revision_number = ?2",
                    params![artifact_id, n],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?,
            None => tx
                .query_row(
                    "SELECT revision_id, revision_number FROM revision
                     WHERE artifact_id = ?1 ORDER BY revision_number DESC LIMIT 1",
                    params![artifact_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?,
        };

        let Some((revision_id, number)) = target else {
            return Err(StoreError::RevisionNotFound {
                artifact_id,
                selector: revision_number
                    .map(|n| format!("number {n}"))
                    .unwrap_or_else(|| "latest".to_string()),
            });
        };

        if mode == Mode::Compatible && (number as u32) < min_number as u32 {
            return Err(StoreError::invalid(format!(
                "revision {number} does not satisfy the compatible floor of {min_number}"
            )));
        }

        if mode == Mode::Pinned {
            tx.execute(
                "UPDATE edge SET pinned_revision_id = ?1, last_satisfied_revision_id = ?1 WHERE edge_id = ?2",
                params![revision_id, edge_id],
            )?;
        } else {
            tx.execute(
                "UPDATE edge SET last_satisfied_revision_id = ?1 WHERE edge_id = ?2",
                params![revision_id, edge_id],
            )?;
        }

        emit_event(
            &tx,
            "edge.satisfied",
            None,
            Some(&artifact_id),
            Some(&revision_id),
            Some(edge_id),
            None,
            Some(&format!("edge satisfied at revision {number}")),
        )?;

        tx.commit()?;

        get_edge_with(&conn, edge_id)?.ok_or_else(|| StoreError::EdgeNotFound(edge_id.to_string()))
    }

    // -- events -------------------------------------------------------------

    pub fn events(&self, since: i64, limit: u32) -> Result<Vec<EventRecord>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT seq, kind, type_id, artifact_id, revision_id, edge_id, actor_app, summary, created_at
             FROM event WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![since, limit], |row| {
            Ok(EventRecord {
                seq: row.get(0)?,
                kind: row.get(1)?,
                type_id: row.get(2)?,
                artifact_id: row.get(3)?,
                revision_id: row.get(4)?,
                edge_id: row.get(5)?,
                actor_app: row.get(6)?,
                summary: row.get(7)?,
                created_at: row.get(8)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn cursor(&self) -> Result<i64> {
        let conn = self.conn();
        Ok(conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM event", [], |row| row.get(0))?)
    }

    // -- maintenance --------------------------------------------------------

    pub fn stats(&self) -> Result<StoreStats> {
        let conn = self.conn();
        let one = |sql: &str| -> Result<u64> {
            Ok(conn.query_row(sql, [], |row| row.get::<_, i64>(0))? as u64)
        };
        let schema_version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        let inline_bytes = one("SELECT COALESCE(SUM(byte_size), 0) FROM revision WHERE inline_payload IS NOT NULL")?;
        let blobs = self.inner.blobs.list()?;
        let stale_edges = list_edges_with(
            &conn,
            &EdgeFilter {
                stale: Some(true),
                ..Default::default()
            },
        )?
        .len() as u64;
        let cursor = conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM event", [], |row| {
            row.get::<_, i64>(0)
        })?;

        Ok(StoreStats {
            node_id: self.inner.node_id.clone(),
            schema_version,
            data_dir: self.inner.config.data_dir.to_string_lossy().to_string(),
            artifacts: one("SELECT COUNT(*) FROM artifact")?,
            revisions: one("SELECT COUNT(*) FROM revision")?,
            edges: one("SELECT COUNT(*) FROM edge")?,
            events: one("SELECT COUNT(*) FROM event")?,
            stale_edges,
            demo_artifacts: one("SELECT COUNT(*) FROM artifact WHERE seed_batch IS NOT NULL")?,
            inline_bytes,
            blob_count: blobs.len() as u64,
            blob_bytes: blobs.iter().map(|(_, size)| size).sum(),
            cursor,
        })
    }

    /// Remove seed/dummy data. `batch = None` removes every seeded artifact.
    ///
    /// Real data is never touched: only artifacts carrying a `seed_batch` marker, or
    /// living in the reserved `apro-demo/` namespace, are eligible.
    pub fn purge_demo(&self, batch: Option<&str>) -> Result<PurgeReport> {
        let mut report = PurgeReport {
            seed_batch: batch.map(|b| b.to_string()),
            ..Default::default()
        };

        {
            let mut conn = self.conn();
            let tx = conn.transaction()?;

            let ids: Vec<String> = {
                let mut stmt = tx.prepare(
                    "SELECT artifact_id FROM artifact
                     WHERE (seed_batch IS NOT NULL AND (?1 IS NULL OR seed_batch = ?1))
                        OR type_id LIKE 'apro-demo/%'",
                )?;
                let rows = stmt.query_map(params![batch], |row| row.get::<_, String>(0))?;
                rows.collect::<std::result::Result<Vec<_>, _>>()?
            };

            report.artifacts = ids.len() as u64;
            report.blobs_removed = 0;

            for id in &ids {
                report.edges += tx.execute("DELETE FROM edge WHERE artifact_id = ?1", params![id])? as u64;
                report.events +=
                    tx.execute("DELETE FROM event WHERE artifact_id = ?1", params![id])? as u64;
                report.revisions +=
                    tx.execute("DELETE FROM revision WHERE artifact_id = ?1", params![id])? as u64;
                tx.execute("DELETE FROM artifact WHERE artifact_id = ?1", params![id])?;
            }

            let ts = now_millis();
            if let Some(batch) = batch {
                tx.execute("DELETE FROM app_interface WHERE app = ?1", params![batch])?;
            }

            if report.artifacts > 0 {
                emit_event(
                    &tx,
                    "demo.purged",
                    None,
                    None,
                    None,
                    None,
                    Some("aproctl"),
                    Some(&format!(
                        "purged {} demo artifact(s), {} revision(s), {} edge(s)",
                        report.artifacts, report.revisions, report.edges
                    )),
                )?;
                let _ = ts;
            }

            tx.commit()?;
        }

        // Prune blobs that no surviving revision references.
        let referenced: HashSet<String> = {
            let conn = self.conn();
            let mut stmt =
                conn.prepare("SELECT DISTINCT blob_hash FROM revision WHERE blob_hash IS NOT NULL")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<std::result::Result<HashSet<_>, _>>()?
        };
        let (removed, freed) = self.inner.blobs.prune(&referenced)?;
        report.blobs_removed = removed;
        report.bytes_freed = freed;

        Ok(report)
    }

    /// Read raw payload bytes for every revision, used by `doctor` integrity checks.
    pub fn verify_blobs(&self) -> Result<Vec<String>> {
        let hashes: Vec<String> = {
            let conn = self.conn();
            let mut stmt =
                conn.prepare("SELECT DISTINCT blob_hash FROM revision WHERE blob_hash IS NOT NULL")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut problems = Vec::new();
        for hash in hashes {
            match self.inner.blobs.get(&hash) {
                Ok(bytes) => {
                    if content_hash(&bytes) != hash {
                        problems.push(format!("blob {hash} failed its content hash check"));
                    }
                }
                Err(err) => problems.push(format!("blob {hash} is unreadable: {err}")),
            }
        }
        Ok(problems)
    }
}

// ---------------------------------------------------------------------------
// SQL fragments and row mappers
// ---------------------------------------------------------------------------

const ARTIFACT_SELECT: &str = "SELECT a.artifact_id, a.type_id, a.owner_app, a.instance, a.label,
        a.current_revision_id, cur.revision_number,
        (SELECT COUNT(*) FROM revision rv WHERE rv.artifact_id = a.artifact_id),
        a.created_by, a.origin_node_id, a.seed_batch, a.created_at, a.updated_at
   FROM artifact a
   LEFT JOIN revision cur ON cur.revision_id = a.current_revision_id";

const EDGE_SELECT: &str = "SELECT e.edge_id, e.consumer_app, NULLIF(e.consumer_ref, ''), e.artifact_id,
        a.type_id, a.instance, e.mode,
        e.pinned_revision_id, pr.revision_number,
        e.min_revision_number,
        e.last_satisfied_revision_id, sr.revision_number,
        a.current_revision_id, cr.revision_number,
        e.created_at
   FROM edge e
   JOIN artifact a ON a.artifact_id = e.artifact_id
   LEFT JOIN revision pr ON pr.revision_id = e.pinned_revision_id
   LEFT JOIN revision sr ON sr.revision_id = e.last_satisfied_revision_id
   LEFT JOIN revision cr ON cr.revision_id = a.current_revision_id";

fn map_artifact(row: &rusqlite::Row<'_>) -> rusqlite::Result<ArtifactSummary> {
    Ok(ArtifactSummary {
        artifact_id: row.get(0)?,
        type_id: row.get(1)?,
        owner_app: row.get(2)?,
        instance: row.get(3)?,
        label: row.get(4)?,
        current_revision_id: row.get(5)?,
        current_revision_number: opt_u32(row.get(6)?),
        revision_count: row.get::<_, i64>(7)? as u32,
        created_by: row.get(8)?,
        origin_node_id: row.get(9)?,
        seed_batch: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn map_revision(row: &rusqlite::Row<'_>) -> rusqlite::Result<RevisionSummary> {
    let encoding: String = row.get(4)?;
    Ok(RevisionSummary {
        revision_id: row.get(0)?,
        artifact_id: row.get(1)?,
        revision_number: row.get::<_, i64>(2)? as u32,
        parent_revision_id: row.get(3)?,
        encoding: Encoding::parse(&encoding).unwrap_or(Encoding::Blob),
        content_hash: row.get(5)?,
        byte_size: row.get::<_, i64>(6)? as u64,
        created_by: row.get(7)?,
        origin_node_id: row.get(8)?,
        created_at: row.get(9)?,
    })
}

fn map_edge(row: &rusqlite::Row<'_>) -> rusqlite::Result<EdgeSummary> {
    let mode_raw: String = row.get(6)?;
    let mode = Mode::parse(&mode_raw).unwrap_or(Mode::Pinned);
    let current_revision_id: Option<String> = row.get(12)?;
    let current_revision_number = opt_u32(row.get(13)?);
    let last_satisfied_revision_id: Option<String> = row.get(10)?;
    let min_revision_number = opt_u32(row.get(9)?);

    let satisfied = match mode {
        Mode::Pinned => row.get::<_, Option<String>>(7)?.is_some()
            && row.get::<_, Option<String>>(7)? == last_satisfied_revision_id,
        Mode::Tracking => {
            current_revision_id.is_none() || current_revision_id == last_satisfied_revision_id
        }
        Mode::Compatible => match (current_revision_number, min_revision_number) {
            (Some(current), Some(min)) => current >= min,
            _ => false,
        },
    };

    Ok(EdgeSummary {
        edge_id: row.get(0)?,
        consumer_app: row.get(1)?,
        consumer_ref: row.get(2)?,
        artifact_id: row.get(3)?,
        type_id: row.get(4)?,
        instance: row.get(5)?,
        mode,
        pinned_revision_id: row.get(7)?,
        pinned_revision_number: opt_u32(row.get(8)?),
        min_revision_number,
        last_satisfied_revision_id,
        last_satisfied_revision_number: opt_u32(row.get(11)?),
        current_revision_id,
        current_revision_number,
        stale: !satisfied,
        created_at: row.get(14)?,
    })
}

struct RevisionRow {
    summary: RevisionSummary,
    inline: Option<Vec<u8>>,
    blob_hash: Option<String>,
}

fn fetch_revision_row(
    conn: &Connection,
    artifact_id: &str,
    selector: Selector,
) -> Result<Option<RevisionRow>> {
    const COLUMNS: &str = "revision_id, artifact_id, revision_number, parent_revision_id, encoding,
                           content_hash, byte_size, created_by, origin_node_id, created_at,
                           inline_payload, blob_hash";
    let mut map = |row: &rusqlite::Row<'_>| -> rusqlite::Result<RevisionRow> {
        Ok(RevisionRow {
            summary: map_revision(row)?,
            inline: row.get(10)?,
            blob_hash: row.get(11)?,
        })
    };

    let row = match selector {
        Selector::Latest => conn
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM revision WHERE artifact_id = ?1
                     ORDER BY revision_number DESC LIMIT 1"
                ),
                params![artifact_id],
                &mut map,
            )
            .optional()?,
        Selector::Number(number) => conn
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM revision WHERE artifact_id = ?1 AND revision_number = ?2"
                ),
                params![artifact_id, number],
                &mut map,
            )
            .optional()?,
    };
    Ok(row)
}

/// Connection-taking variant. Needed because `std::sync::Mutex` is not reentrant:
/// a method that already holds the guard must not call another locking method.
fn get_edge_with(conn: &Connection, edge_id: &str) -> Result<Option<EdgeSummary>> {
    let mut stmt = conn.prepare(&format!("{EDGE_SELECT} WHERE e.edge_id = ?1"))?;
    let mut rows = stmt.query_map(params![edge_id], map_edge)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub(crate) fn list_edges_with(conn: &Connection, filter: &EdgeFilter) -> Result<Vec<EdgeSummary>> {
    let sql = format!(
        "{EDGE_SELECT}
         WHERE (?1 IS NULL OR e.consumer_app = ?1)
           AND (?2 IS NULL OR e.artifact_id = ?2)
         ORDER BY e.created_at DESC, e.edge_id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![filter.consumer_app, filter.artifact_id], map_edge)?;
    let mut edges = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    if let Some(want_stale) = filter.stale {
        edges.retain(|edge| edge.stale == want_stale);
    }
    Ok(edges)
}

fn fetch_artifact_by_id(conn: &Connection, artifact_id: &str) -> Result<Option<ArtifactSummary>> {
    Ok(conn
        .query_row(
            &format!("{ARTIFACT_SELECT} WHERE a.artifact_id = ?1"),
            params![artifact_id],
            map_artifact,
        )
        .optional()?)
}

fn register_type(conn: &Connection, type_id: &TypeId, owner_app: &str, ts: Millis) -> Result<()> {
    conn.execute(
        "INSERT INTO type_registry (type_id, owner_app, descriptor_set, registered_at)
         VALUES (?1, ?2, NULL, ?3)
         ON CONFLICT (type_id) DO NOTHING",
        params![type_id.as_str(), owner_app, ts],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_event(
    conn: &Connection,
    kind: &str,
    type_id: Option<&str>,
    artifact_id: Option<&str>,
    revision_id: Option<&str>,
    edge_id: Option<&str>,
    actor_app: Option<&str>,
    summary: Option<&str>,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO event (kind, type_id, artifact_id, revision_id, edge_id, actor_app, summary, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![kind, type_id, artifact_id, revision_id, edge_id, actor_app, summary, now_millis()],
    )?;
    Ok(conn.last_insert_rowid())
}
