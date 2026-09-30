//! Type-level subscriptions, edge removal, and read logging.
//!
//! ## Why subscriptions exist
//!
//! The workflow canvas wires applications, so a wire is inherently *type-level*: "the
//! CAD app's mass properties feed HexaDOF". An `edge`, by contrast, is *instance-level*:
//! it names one artifact. Those are not the same thing, and pretending otherwise would
//! force the UI to pick an instance the user never chose.
//!
//! So a subscription is the durable thing the user edits, and concrete edges are
//! **materialised** from it — one per existing instance — and extended automatically as
//! new instances are published.
//!
//! Materialisation only ever *inserts*. It uses `ON CONFLICT DO NOTHING` rather than
//! [`Store::register_edge`]'s upsert, because re-syncing must never reset
//! `last_satisfied_revision_id`; doing so would silently mark every dependency fresh and
//! destroy the freshness signal the whole graph exists to provide.

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{Result, StoreError};
use apro_types::*;
use crate::store::{emit_event, list_edges_with, now_millis, opt_u32, validate_app, Store};

impl Store {
    // -- subscriptions ------------------------------------------------------

    /// Create or update a subscription, then materialise its edges.
    ///
    /// Idempotent: subscribing twice to the same type updates the mode and creates no
    /// duplicate edges.
    pub fn create_subscription(&self, request: SubscriptionRequest) -> Result<SubscriptionSummary> {
        validate_app(&request.consumer_app)?;
        let type_id = request.type_id.as_str().to_string();

        let subscription_id = {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            let now = now_millis();

            tx.execute(
                "INSERT INTO subscription
                   (subscription_id, consumer_app, type_id, mode, created_by, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (consumer_app, type_id) DO UPDATE SET mode = excluded.mode",
                params![
                    uuid::Uuid::now_v7().to_string(),
                    request.consumer_app,
                    type_id,
                    request.mode.as_str(),
                    request.created_by,
                    now
                ],
            )?;

            // The upsert keeps the original id on conflict, so read it back rather than
            // using the id we generated.
            let id: String = tx.query_row(
                "SELECT subscription_id FROM subscription WHERE consumer_app = ?1 AND type_id = ?2",
                params![request.consumer_app, type_id],
                |row| row.get(0),
            )?;

            let created = materialize_subscription(
                &tx,
                &id,
                &request.consumer_app,
                &type_id,
                request.mode,
                now,
            )?;

            emit_event(
                &tx,
                "subscription.created",
                Some(&type_id),
                None,
                None,
                None,
                Some(&request.consumer_app),
                Some(&format!(
                    "{} subscribes to {} ({}){}{}",
                    request.consumer_app,
                    type_id,
                    request.mode,
                    if created > 0 { ", " } else { "" },
                    if created > 0 {
                        format!("{created} edge(s) materialised")
                    } else {
                        String::new()
                    }
                )),
            )?;

            tx.commit()?;
            id
        };

        self.get_subscription(&subscription_id)?
            .ok_or_else(|| StoreError::SubscriptionNotFound(subscription_id))
    }

    pub fn get_subscription(&self, subscription_id: &str) -> Result<Option<SubscriptionSummary>> {
        // Deliberately does not take the connection first: `list_subscriptions` locks,
        // and the mutex is not reentrant.
        Ok(self
            .list_subscriptions()?
            .into_iter()
            .find(|summary| summary.subscription_id == subscription_id))
    }

    pub fn list_subscriptions(&self) -> Result<Vec<SubscriptionSummary>> {
        let conn = self.conn();

        let rows: Vec<(String, String, String, String, Option<String>, Millis)> = {
            let mut stmt = conn.prepare(
                "SELECT subscription_id, consumer_app, type_id, mode, created_by, created_at
                 FROM subscription ORDER BY consumer_app, type_id",
            )?;
            let mapped = stmt.query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })?;
            mapped.collect::<std::result::Result<Vec<_>, _>>()?
        };

        // Staleness is computed per edge by the same rules everything else uses, so it
        // is resolved here rather than duplicated in SQL.
        let edges = list_edges_with(&conn, &EdgeFilter::default())?;

        Ok(rows
            .into_iter()
            .map(
                |(subscription_id, consumer_app, type_id, mode_raw, created_by, created_at)| {
                    let reference = subscription_ref(&subscription_id);
                    let owned: Vec<&EdgeSummary> = edges
                        .iter()
                        .filter(|edge| {
                            edge.consumer_app == consumer_app
                                && edge.consumer_ref.as_deref() == Some(reference.as_str())
                        })
                        .collect();

                    SubscriptionSummary {
                        subscription_id,
                        consumer_app,
                        type_id,
                        mode: Mode::parse(&mode_raw).unwrap_or(Mode::Pinned),
                        edge_count: owned.len() as u32,
                        stale_edges: owned.iter().filter(|edge| edge.stale).count() as u32,
                        created_by,
                        created_at,
                    }
                },
            )
            .collect())
    }

    /// Remove a subscription and every edge it materialised. Returns edges removed.
    pub fn delete_subscription(&self, subscription_id: &str) -> Result<u64> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;

        let found: Option<(String, String)> = tx
            .query_row(
                "SELECT consumer_app, type_id FROM subscription WHERE subscription_id = ?1",
                params![subscription_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((consumer_app, type_id)) = found else {
            return Err(StoreError::SubscriptionNotFound(subscription_id.to_string()));
        };

        let removed = tx.execute(
            "DELETE FROM edge WHERE consumer_app = ?1 AND consumer_ref = ?2",
            params![consumer_app, subscription_ref(subscription_id)],
        )? as u64;

        tx.execute(
            "DELETE FROM subscription WHERE subscription_id = ?1",
            params![subscription_id],
        )?;

        emit_event(
            &tx,
            "subscription.removed",
            Some(&type_id),
            None,
            None,
            None,
            Some(&consumer_app),
            Some(&format!(
                "{consumer_app} unsubscribed from {type_id} ({removed} edge(s) removed)"
            )),
        )?;

        tx.commit()?;
        Ok(removed)
    }

    /// Materialise edges for every subscription. Idempotent.
    ///
    /// This is what the canvas "Sync" action runs: it back-fills edges for instances
    /// published since the subscription was created, without disturbing existing ones.
    pub fn materialize_subscriptions(&self) -> Result<u64> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let now = now_millis();

        let subscriptions: Vec<(String, String, String, String)> = {
            let mut stmt = tx.prepare(
                "SELECT subscription_id, consumer_app, type_id, mode FROM subscription",
            )?;
            let mapped = stmt.query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?;
            mapped.collect::<std::result::Result<Vec<_>, _>>()?
        };

        let mut created = 0_u64;
        for (id, consumer_app, type_id, mode_raw) in subscriptions {
            let mode = Mode::parse(&mode_raw)?;
            created += materialize_subscription(&tx, &id, &consumer_app, &type_id, mode, now)?;
        }

        tx.commit()?;
        Ok(created)
    }

    // -- edge removal -------------------------------------------------------

    /// Remove a single dependency edge.
    ///
    /// Deleting an edge materialised by a subscription effectively un-wires that one
    /// instance; the next `materialize_subscriptions` would restore it. To un-wire
    /// durably, delete the subscription instead.
    pub fn delete_edge(&self, edge_id: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;

        let found: Option<(String, String, String)> = tx
            .query_row(
                "SELECT e.consumer_app, e.artifact_id, a.type_id
                   FROM edge e JOIN artifact a ON a.artifact_id = e.artifact_id
                  WHERE e.edge_id = ?1",
                params![edge_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;

        let Some((consumer_app, artifact_id, type_id)) = found else {
            return Err(StoreError::EdgeNotFound(edge_id.to_string()));
        };

        tx.execute("DELETE FROM edge WHERE edge_id = ?1", params![edge_id])?;

        emit_event(
            &tx,
            "edge.removed",
            Some(&type_id),
            Some(&artifact_id),
            None,
            Some(edge_id),
            Some(&consumer_app),
            Some(&format!("{consumer_app} dependency on {type_id} removed")),
        )?;

        tx.commit()?;
        Ok(())
    }

    // -- read log -----------------------------------------------------------

    /// Record one read attempt. Never written to `event`; see the module docs.
    pub fn record_access(
        &self,
        actor_app: &str,
        type_id: &str,
        instance: &str,
        revision_id: Option<&str>,
        revision_number: Option<u32>,
        outcome: &str,
    ) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO access_log
               (actor_app, type_id, instance, revision_id, revision_number, outcome, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                actor_app,
                type_id,
                instance,
                revision_id,
                revision_number,
                outcome,
                now_millis()
            ],
        )?;
        Ok(())
    }

    pub fn access_log(&self, since: i64, limit: u32) -> Result<Vec<AccessRecord>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT seq, actor_app, type_id, instance, revision_id, revision_number, outcome, created_at
               FROM access_log WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![since, limit], |row| {
            Ok(AccessRecord {
                seq: row.get(0)?,
                actor_app: row.get(1)?,
                type_id: row.get(2)?,
                instance: row.get(3)?,
                revision_id: row.get(4)?,
                revision_number: opt_u32(row.get(5)?),
                outcome: row.get(6)?,
                created_at: row.get(7)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn access_cursor(&self) -> Result<i64> {
        let conn = self.conn();
        Ok(conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM access_log", [], |row| {
            row.get(0)
        })?)
    }
}

/// Ensure the edges a subscription needs exist. Returns how many were created.
///
/// Pinned subscriptions can only pin what has actually been published, so artifacts
/// with no current revision are skipped until they have one.
fn materialize_subscription(
    conn: &Connection,
    subscription_id: &str,
    consumer_app: &str,
    type_id: &str,
    mode: Mode,
    now: Millis,
) -> Result<u64> {
    let artifacts: Vec<(String, Option<String>)> = {
        let mut stmt =
            conn.prepare("SELECT artifact_id, current_revision_id FROM artifact WHERE type_id = ?1")?;
        let mapped = stmt.query_map(params![type_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        mapped.collect::<std::result::Result<Vec<_>, _>>()?
    };

    let consumer_ref = subscription_ref(subscription_id);
    let mut created = 0_u64;

    for (artifact_id, current_revision_id) in artifacts {
        if mode == Mode::Pinned && current_revision_id.is_none() {
            continue;
        }

        let pinned = if mode == Mode::Pinned {
            current_revision_id.clone()
        } else {
            None
        };
        let floor = if mode == Mode::Compatible { Some(1_i64) } else { None };
        // `compatible` is satisfied once the floor is met, so it starts unsatisfied and
        // the staleness rule decides; the others start satisfied at the current revision.
        let satisfied = match mode {
            Mode::Compatible => None,
            _ => current_revision_id.clone(),
        };

        let inserted = conn.execute(
            "INSERT INTO edge
               (edge_id, consumer_app, consumer_ref, artifact_id, mode,
                pinned_revision_id, min_revision_number, last_satisfied_revision_id,
                created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9)
             ON CONFLICT (consumer_app, consumer_ref, artifact_id) DO NOTHING",
            params![
                uuid::Uuid::now_v7().to_string(),
                consumer_app,
                consumer_ref,
                artifact_id,
                mode.as_str(),
                pinned,
                floor,
                satisfied,
                now
            ],
        )?;

        if inserted > 0 {
            created += 1;
            emit_event(
                conn,
                "edge.created",
                Some(type_id),
                Some(&artifact_id),
                None,
                None,
                Some(consumer_app),
                Some(&format!(
                    "{consumer_app} subscribed to {type_id} (materialised)"
                )),
            )?;
        }
    }

    Ok(created)
}

/// Materialise every subscription that watches `type_id`. Called from `push`.
pub(crate) fn materialize_for_type(conn: &Connection, type_id: &str, now: Millis) -> Result<u64> {
    let subscriptions: Vec<(String, String, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT subscription_id, consumer_app, type_id, mode FROM subscription WHERE type_id = ?1",
        )?;
        let mapped = stmt.query_map(params![type_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?;
        mapped.collect::<std::result::Result<Vec<_>, _>>()?
    };

    let mut created = 0_u64;
    for (id, consumer_app, watched_type, mode_raw) in subscriptions {
        let mode = Mode::parse(&mode_raw)?;
        created += materialize_subscription(conn, &id, &consumer_app, &watched_type, mode, now)?;
    }
    Ok(created)
}
