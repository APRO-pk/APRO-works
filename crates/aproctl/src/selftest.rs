//! `aproctl selftest` — an end-to-end behavioural test of a store directory.
//!
//! Unlike `doctor` (which inspects), this exercises the real semantics: immutability,
//! idempotent pushes, revision lineage, staleness, pinning, the blob path, the event
//! cursor, write enforcement, and demo-data isolation. It is safe to run against a
//! throwaway directory; running it against a real store only adds non-demo artifacts,
//! which are namespaced under `selftest-app/`.

use std::path::Path;

use apro_client::AproStoreClient;
use apro_store::{
    demo, AppInterface, ArtifactFilter, ConsumeDecl, EdgeFilter, EdgeRequest, Encoding, Mode,
    Selector, Store, StoreConfig, TypeId,
};

use crate::checks::{human_bytes, Check};
use crate::local_client::LocalStoreClient;

macro_rules! check {
    ($checks:expr, $name:expr, $body:block) => {{
        let outcome: std::result::Result<String, String> =
            (|| -> std::result::Result<String, String> { $body })();
        match outcome {
            Ok(detail) => $checks.push(Check::pass($name, detail)),
            Err(detail) => $checks.push(Check::fail($name, detail)),
        }
    }};
}

pub fn run(dir: &Path) -> Vec<Check> {
    let mut checks = Vec::new();

    let store = match Store::open(StoreConfig::new(dir)) {
        Ok(store) => {
            checks.push(Check::pass("store opens", dir.to_string_lossy().to_string()));
            store
        }
        Err(err) => {
            checks.push(Check::fail("store opens", err.to_string()));
            return checks;
        }
    };

    let producer = LocalStoreClient::new(store.clone(), "selftest-app");
    let consumer = LocalStoreClient::new(store.clone(), "selftest-consumer");

    let grain = TypeId::new("selftest-app", "grain").unwrap();
    let step = TypeId::new("selftest-app", "solid-model").unwrap();

    // -- identity ----------------------------------------------------------
    check!(checks, "type identity rejects the legacy spaced slug", {
        match TypeId::new("Propulsor - Liquid Engine Design Studio", "chamber") {
            Ok(_) => return Err("a spaced app slug was accepted as a type id".into()),
            Err(_) => {}
        }
        match TypeId::parse("not-namespaced") {
            Ok(_) => return Err("a type id without a namespace was accepted".into()),
            Err(_) => {}
        }
        Ok("rejects spacing and missing namespaces".into())
    });

    // -- declarations ------------------------------------------------------
    check!(checks, "app interface declares and persists", {
        producer
            .declare_interface(&AppInterface {
                app: "selftest-app".into(),
                publishes: vec![grain.clone(), step.clone()],
                consumes: vec![],
            })
            .map_err(|err| err.to_string())?;
        let declared = store
            .declared_types("selftest-app", "publish")
            .map_err(|err| err.to_string())?;
        if declared.len() != 2 {
            return Err(format!("expected 2 declared publishes, got {}", declared.len()));
        }
        Ok("2 published types recorded".into())
    });

    // -- publish / fetch ---------------------------------------------------
    check!(checks, "publish then fetch returns identical bytes", {
        let handle = producer
            .push(&grain, "engine-a", Encoding::Json, br#"{"outer_diameter":152.4}"#)
            .map_err(|err| err.to_string())?;
        if handle.revision_number != 1 {
            return Err(format!("expected revision 1, got {}", handle.revision_number));
        }
        if !handle.created_new_artifact {
            return Err("first push should have created the artifact".into());
        }

        let payload = producer
            .pull(&grain, "engine-a", Selector::Latest)
            .map_err(|err| err.to_string())?
            .ok_or("payload was not readable after publishing")?;
        if payload.bytes != br#"{"outer_diameter":152.4}"# {
            return Err("returned bytes differ from the published bytes".into());
        }
        let expected = apro_store::content_hash(br#"{"outer_diameter":152.4}"#);
        if payload.content_hash != expected {
            return Err("advertised content hash does not match the payload".into());
        }
        Ok(format!("revision 1, hash {}…", &expected[..12]))
    });

    check!(checks, "byte-identical push does not create revision spam", {
        let again = producer
            .push(&grain, "engine-a", Encoding::Json, br#"{"outer_diameter":152.4}"#)
            .map_err(|err| err.to_string())?;
        if !again.unchanged {
            return Err("an identical push created a new revision".into());
        }
        if again.revision_number != 1 {
            return Err(format!("expected to stay at revision 1, got {}", again.revision_number));
        }
        Ok("idempotent: still revision 1".into())
    });

    check!(checks, "changed bytes append an immutable revision with lineage", {
        let second = producer
            .push(&grain, "engine-a", Encoding::Json, br#"{"outer_diameter":160.0}"#)
            .map_err(|err| err.to_string())?;
        if second.revision_number != 2 {
            return Err(format!("expected revision 2, got {}", second.revision_number));
        }

        let history = producer
            .list_revisions(&grain, "engine-a")
            .map_err(|err| err.to_string())?;
        if history.len() != 2 {
            return Err(format!("expected 2 revisions, got {}", history.len()));
        }
        if history[1].parent_revision_id.as_deref() != Some(history[0].revision_id.as_str()) {
            return Err("revision 2 does not record revision 1 as its parent".into());
        }

        // The superseded revision must still be readable verbatim (DESIGN.md D3).
        let old = producer
            .pull(&grain, "engine-a", Selector::Number(1))
            .map_err(|err| err.to_string())?
            .ok_or("revision 1 became unreadable after revision 2 was published")?;
        if old.bytes != br#"{"outer_diameter":152.4}"# {
            return Err("historical revision 1 no longer returns its original bytes".into());
        }
        Ok("revision 2 appended; revision 1 still readable".into())
    });

    // -- dependency graph --------------------------------------------------
    let mut tracking_edge_id = String::new();
    check!(checks, "tracking dependency starts satisfied and goes stale on upstream change", {
        let edge = consumer
            .register_edge(&EdgeRequest {
                consumer_app: String::new(), // replaced by the session/client identity
                consumer_ref: Some("run-1".into()),
                type_id: grain.clone(),
                instance: "engine-a".into(),
                mode: Mode::Tracking,
                pinned_revision_number: None,
                min_revision_number: None,
            })
            .map_err(|err| err.to_string())?;

        if edge.stale {
            return Err("a newly created tracking edge should start satisfied".into());
        }
        tracking_edge_id = edge.edge_id;

        producer
            .push(&grain, "engine-a", Encoding::Json, br#"{"outer_diameter":168.0}"#)
            .map_err(|err| err.to_string())?;

        let edges = consumer
            .list_edges(&EdgeFilter::default())
            .map_err(|err| err.to_string())?;
        let tracked = edges
            .iter()
            .find(|e| e.edge_id == tracking_edge_id)
            .ok_or("the tracking edge disappeared")?;
        if !tracked.stale {
            return Err("the tracking edge did not go stale after the producer published".into());
        }
        Ok(format!(
            "stale at satisfied={:?} vs current={:?}",
            tracked.last_satisfied_revision_number, tracked.current_revision_number
        ))
    });

    check!(checks, "satisfying an edge clears staleness", {
        let satisfied = consumer
            .satisfy_edge(&tracking_edge_id, None)
            .map_err(|err| err.to_string())?;
        if satisfied.stale {
            return Err("the edge is still stale after being satisfied".into());
        }
        Ok(format!(
            "advanced to revision {:?}",
            satisfied.last_satisfied_revision_number
        ))
    });

    check!(checks, "a pinned dependency never goes stale and keeps its revision", {
        let pinned = consumer
            .register_edge(&EdgeRequest {
                consumer_app: String::new(),
                consumer_ref: Some("run-pinned".into()),
                type_id: grain.clone(),
                instance: "engine-a".into(),
                mode: Mode::Pinned,
                pinned_revision_number: Some(2),
                min_revision_number: None,
            })
            .map_err(|err| err.to_string())?;

        if pinned.pinned_revision_number != Some(2) {
            return Err(format!(
                "expected the pin to be revision 2, got {:?}",
                pinned.pinned_revision_number
            ));
        }

        // Publish again; a pinned consumer must not be disturbed.
        producer
            .push(&grain, "engine-a", Encoding::Json, br#"{"outer_diameter":175.0}"#)
            .map_err(|err| err.to_string())?;

        let after = consumer
            .list_edges(&EdgeFilter::default())
            .map_err(|err| err.to_string())?
            .into_iter()
            .find(|e| e.edge_id == pinned.edge_id)
            .ok_or("the pinned edge disappeared")?;

        if after.stale {
            return Err("a pinned edge went stale; reproducibility would be lost".into());
        }
        if after.pinned_revision_number != Some(2) {
            return Err("the pin moved; reproducibility would be lost".into());
        }
        Ok("stayed pinned at revision 2 across a new upstream revision".into())
    });

    check!(checks, "a compatible dependency tracks a minimum revision floor", {
        let unmet = consumer
            .register_edge(&EdgeRequest {
                consumer_app: String::new(),
                consumer_ref: Some("run-floor".into()),
                type_id: grain.clone(),
                instance: "engine-a".into(),
                mode: Mode::Compatible,
                pinned_revision_number: None,
                min_revision_number: Some(99_999),
            })
            .map_err(|err| err.to_string())?;
        if !unmet.stale {
            return Err("a floor above the current revision should not be satisfied".into());
        }

        let met = consumer
            .register_edge(&EdgeRequest {
                consumer_app: String::new(),
                consumer_ref: Some("run-floor-ok".into()),
                type_id: grain.clone(),
                instance: "engine-a".into(),
                mode: Mode::Compatible,
                pinned_revision_number: None,
                min_revision_number: Some(1),
            })
            .map_err(|err| err.to_string())?;
        if met.stale {
            return Err("a floor at or below the current revision should be satisfied".into());
        }
        Ok("unsatisfied floor is stale; satisfied floor is fresh".into())
    });

    check!(checks, "consumer can declare a dependency before the producer publishes", {
        let future = TypeId::new("selftest-app", "not-yet-published").unwrap();
        let edge = consumer
            .register_edge(&EdgeRequest {
                consumer_app: String::new(),
                consumer_ref: Some("run-future".into()),
                type_id: future.clone(),
                instance: "later".into(),
                mode: Mode::Tracking,
                pinned_revision_number: None,
                min_revision_number: None,
            })
            .map_err(|err| err.to_string())?;
        if edge.stale {
            return Err("an edge to a never-published artifact should not be stale yet".into());
        }
        let fetched = producer
            .pull(&future, "later", Selector::Latest)
            .map_err(|err| err.to_string())?;
        if fetched.is_some() {
            return Err("a placeholder artifact should have no readable revision".into());
        }
        Ok("placeholder artifact created; no revision to read yet".into())
    });

    // -- blob path ---------------------------------------------------------
    check!(checks, "payloads above the inline threshold use the blob store", {
        let big: Vec<u8> = (0..150_000u32).map(|i| ((i * 31) % 251) as u8).collect();
        if big.len() <= apro_store::INLINE_MAX_BYTES {
            return Err("test payload is not above the inline threshold".into());
        }

        producer
            .push(&step, "engine-big", Encoding::Blob, &big)
            .map_err(|err| err.to_string())?;

        let payload = producer
            .pull(&step, "engine-big", Selector::Latest)
            .map_err(|err| err.to_string())?
            .ok_or("the large payload was not readable")?;
        if payload.bytes != big {
            return Err("the large payload did not round-trip byte-for-byte".into());
        }

        let revisions = producer
            .list_revisions(&step, "engine-big")
            .map_err(|err| err.to_string())?;
        let hash = &revisions[0].content_hash;
        if !store.blobs().contains(hash) {
            return Err(format!("no blob file on disk for content hash {hash}"));
        }
        Ok(format!(
            "{} stored as blob {}…",
            human_bytes(payload.byte_size),
            &hash[..12]
        ))
    });

    // -- event cursor ------------------------------------------------------
    check!(checks, "event cursor is monotonic and does not replay", {
        let cursor = store.cursor().map_err(|err| err.to_string())?;
        if cursor <= 0 {
            return Err("the event log is empty after publishing".into());
        }
        let after = producer.events(cursor).map_err(|err| err.to_string())?;
        if !after.is_empty() {
            return Err(format!(
                "{} event(s) replayed at the current cursor",
                after.len()
            ));
        }
        let all = producer.events(0).map_err(|err| err.to_string())?;
        if all.len() < 5 {
            return Err(format!("expected a populated event log, got {}", all.len()));
        }
        Ok(format!("{cursor} event(s) recorded; no replay at the cursor"))
    });

    // -- enforcement -------------------------------------------------------
    check!(checks, "writing an undeclared type is refused", {
        let strict = LocalStoreClient::new(store.clone(), "selftest-strict");
        strict
            .declare_interface(&AppInterface {
                app: "selftest-strict".into(),
                publishes: vec![TypeId::new("selftest-strict", "declared").unwrap()],
                consumes: vec![],
            })
            .map_err(|err| err.to_string())?;

        let allowed = TypeId::new("selftest-strict", "declared").unwrap();
        strict
            .push(&allowed, "a", Encoding::Json, b"{}")
            .map_err(|err| format!("declared type was refused: {err}"))?;

        let undeclared = TypeId::new("selftest-strict", "undeclared").unwrap();
        match strict.push(&undeclared, "a", Encoding::Json, b"{}") {
            Ok(_) => Err("an undeclared type was accepted".into()),
            Err(err) if err.api_code() == Some("write_not_declared") => {
                Ok("declared type accepted, undeclared type refused".into())
            }
            Err(err) => Err(format!("unexpected error for undeclared write: {err}")),
        }
    });

    // -- demo data isolation ----------------------------------------------
    check!(checks, "demo data seeds and purges without touching real data", {
        let real_before = store
            .list_artifacts(&ArtifactFilter::default())
            .map_err(|err| err.to_string())?
            .len();

        let seeded = demo::seed(&store, apro_store::DEFAULT_SEED_BATCH, true)
            .map_err(|err| err.to_string())?;
        if seeded.stale_edges != 1 {
            return Err(format!(
                "expected the demo set to leave exactly 1 stale edge, got {}",
                seeded.stale_edges
            ));
        }
        if store.stats().map_err(|e| e.to_string())?.demo_artifacts == 0 {
            return Err("seeding produced no demo artifacts".into());
        }

        let purged = store
            .purge_demo(Some(apro_store::DEFAULT_SEED_BATCH))
            .map_err(|err| err.to_string())?;
        if purged.artifacts == 0 {
            return Err("purge removed nothing".into());
        }
        let stats = store.stats().map_err(|err| err.to_string())?;
        if stats.demo_artifacts != 0 {
            return Err(format!(
                "{} demo artifact(s) survived the purge",
                stats.demo_artifacts
            ));
        }

        let real_after = store
            .list_artifacts(&ArtifactFilter::default())
            .map_err(|err| err.to_string())?
            .len();
        if real_after != real_before {
            return Err(format!(
                "real artifacts changed during seed/purge: {real_before} -> {real_after}"
            ));
        }
        Ok(format!(
            "seeded {} artifact(s), purged them, {real_after} real artifact(s) intact",
            purged.artifacts
        ))
    });

    // -- declarations are advisory for consumers --------------------------
    check!(checks, "consumer declarations are recorded with their default mode", {
        consumer
            .declare_interface(&AppInterface {
                app: "selftest-consumer".into(),
                publishes: vec![],
                consumes: vec![ConsumeDecl {
                    type_id: grain.clone(),
                    default_mode: Mode::Tracking,
                }],
            })
            .map_err(|err| err.to_string())?;
        let interfaces = store.interfaces().map_err(|err| err.to_string())?;
        let found = interfaces
            .iter()
            .find(|entry| entry.app == "selftest-consumer" && entry.direction == "consume")
            .ok_or("the consumer declaration was not recorded")?;
        if found.default_mode.as_deref() != Some("tracking") {
            return Err(format!(
                "expected default_mode tracking, got {:?}",
                found.default_mode
            ));
        }
        Ok("consume declaration recorded".into())
    });

    checks
}
