//! Removable dummy data.
//!
//! Everything here is written with a `seed_batch` marker and is removed in one call by
//! [`Store::purge_demo`](crate::Store::purge_demo). Nothing in this module can touch or
//! corrupt real data: purge only considers artifacts that carry a batch marker or live in
//! the reserved `apro-demo/` namespace.
//!
//! The scenario is the motivating one from DESIGN.md 2: a geometry modeler publishes a
//! grain geometry, HexaDOF tracks it, the modeler then edits the model, and HexaDOF's
//! dependency goes stale. Seeding therefore leaves exactly one stale edge behind, which
//! is what `aproctl doctor` and `aproctl selftest` assert on.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::Result;
use apro_types::*;
use crate::store::Store;

/// Apps simulated by the demo data. These are not real installs.
pub const DEMO_APPS: &[&str] = &["burn-geometry-modeler", "hexadof", DEMO_NAMESPACE];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedReport {
    pub batch: String,
    pub already_present: bool,
    pub purged_before_seed: bool,
    pub artifacts: u64,
    pub revisions: u64,
    pub edges: u64,
    pub stale_edges: u64,
    pub notes: Vec<String>,
}

fn grain_geometry(outer_mm: f64, inner_mm: f64, port_count: u32, note: &str) -> Vec<u8> {
    serde_json::to_vec_pretty(&json!({
        "schema": "burn-geometry-modeler/grain-geometry/1",
        "units": "mm",
        "outer_diameter": outer_mm,
        "inner_diameter": inner_mm,
        "length": 600.0,
        "grain_count": 5,
        "port_count": port_count,
        "propellant": "lox-ch4",
        "note": note,
        "demo": true,
    }))
    .expect("static json is serializable")
}

/// Deterministic pseudo-random bytes, standing in for a CAD/STEP export.
/// Deterministic so a re-seed produces identical content hashes.
fn demo_binary_blob(seed: u64, len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    let mut state = seed.wrapping_mul(2_862_933_555_777_941_757).wrapping_add(3_037_000_493);
    for index in 0..len {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        out.push((state >> 33) as u8 ^ (index as u8));
    }
    out
}

/// Insert the demo dataset. Idempotent unless `force` is set, in which case any prior
/// batch of the same name is purged first.
pub fn seed(store: &Store, batch: &str, force: bool) -> Result<SeedReport> {
    let mut report = SeedReport {
        batch: batch.to_string(),
        already_present: false,
        purged_before_seed: false,
        artifacts: 0,
        revisions: 0,
        edges: 0,
        stale_edges: 0,
        notes: Vec::new(),
    };

    let existing = store.list_artifacts(&ArtifactFilter {
        include_demo: true,
        ..Default::default()
    })?;
    let already = existing
        .iter()
        .any(|artifact| artifact.seed_batch.as_deref() == Some(batch));

    if already && !force {
        report.already_present = true;
        report.notes.push(format!(
            "batch {batch:?} is already present; re-run with --force to rebuild it"
        ));
        report.artifacts = existing.iter().filter(|a| a.is_demo()).count() as u64;
        return Ok(report);
    }

    if already && force {
        let purged = store.purge_demo(Some(batch))?;
        report.purged_before_seed = true;
        report.notes.push(format!(
            "purged previous batch: {} artifact(s), {} revision(s)",
            purged.artifacts, purged.revisions
        ));
    }

    // 1. Declare each simulated app's data contract.
    store.declare_interface(
        &AppInterface {
            app: "burn-geometry-modeler".into(),
            publishes: vec![
                TypeId::new("burn-geometry-modeler", "grain-geometry")?,
                TypeId::new("burn-geometry-modeler", "geometry-step")?,
            ],
            consumes: vec![],
        },
        "demo",
    )?;
    store.declare_interface(
        &AppInterface {
            app: "hexadof".into(),
            publishes: vec![],
            consumes: vec![
                ConsumeDecl {
                    type_id: TypeId::new("burn-geometry-modeler", "grain-geometry")?,
                    default_mode: Mode::Tracking,
                },
                ConsumeDecl {
                    type_id: TypeId::new(DEMO_NAMESPACE, "propellant")?,
                    default_mode: Mode::Pinned,
                },
            ],
        },
        "demo",
    )?;
    store.declare_interface(
        &AppInterface {
            app: DEMO_NAMESPACE.into(),
            publishes: vec![TypeId::new(DEMO_NAMESPACE, "propellant")?],
            consumes: vec![],
        },
        "demo",
    )?;

    let grain_type = TypeId::new("burn-geometry-modeler", "grain-geometry")?;
    let step_type = TypeId::new("burn-geometry-modeler", "geometry-step")?;
    let propellant_type = TypeId::new(DEMO_NAMESPACE, "propellant")?;
    let instance = "engine-demo";

    // 2. The modeler publishes revision 1.
    store.push(
        PushRequest::new(
            grain_type.clone(),
            instance,
            Encoding::Json,
            "burn-geometry-modeler",
            grain_geometry(152.4, 76.2, 6, "initial grain design"),
        )
        .with_label("Grain geometry — engine demo")
        .with_seed_batch(batch),
    )?;

    // 3. A propellant definition in the reserved demo namespace.
    store.push(
        PushRequest::new(
            propellant_type.clone(),
            "lox-ch4",
            Encoding::Json,
            DEMO_NAMESPACE,
            serde_json::to_vec_pretty(&json!({
                "schema": "apro-demo/propellant/1",
                "name": "LOX / CH4",
                "of_ratio": 3.4,
                "chamber_temperature_k": 3400.0,
                "gamma": 1.14,
                "demo": true,
            }))
            .expect("static json is serializable"),
        )
        .with_label("LOX/CH4 propellant definition")
        .with_seed_batch(batch),
    )?;

    // 4. HexaDOF declares dependencies while revision 1 is current, so its tracking
    //    edge starts satisfied. This ordering is what makes the staleness check meaningful.
    store.register_edge(EdgeRequest {
        consumer_app: "hexadof".into(),
        consumer_ref: Some("run-demo-001".into()),
        type_id: grain_type.clone(),
        instance: instance.into(),
        mode: Mode::Tracking,
        pinned_revision_number: None,
        min_revision_number: None,
    })?;
    store.register_edge(EdgeRequest {
        consumer_app: "hexadof".into(),
        consumer_ref: Some("run-demo-001".into()),
        type_id: propellant_type.clone(),
        instance: "lox-ch4".into(),
        mode: Mode::Pinned,
        pinned_revision_number: Some(1),
        min_revision_number: None,
    })?;

    // 5. The modeler edits the model -> revision 2. The tracking edge is now stale.
    store.push(
        PushRequest::new(
            grain_type.clone(),
            instance,
            Encoding::Json,
            "burn-geometry-modeler",
            grain_geometry(152.4, 80.0, 6, "widened port after burn-rate review"),
        )
        .with_label("Grain geometry — engine demo")
        .with_seed_batch(batch),
    )?;

    // 6. A >64 KiB payload, to exercise the blob path rather than the inline path.
    store.push(
        PushRequest::new(
            step_type,
            instance,
            Encoding::Blob,
            "burn-geometry-modeler",
            demo_binary_blob(0x5EED_1234, 96 * 1024),
        )
        .with_label("Grain solid model export (simulated STEP)")
        .with_seed_batch(batch),
    )?;

    let artifacts = store.list_artifacts(&ArtifactFilter {
        include_demo: true,
        ..Default::default()
    })?;
    let demo_artifacts: Vec<_> = artifacts.iter().filter(|a| a.is_demo()).collect();
    report.artifacts = demo_artifacts.len() as u64;
    report.revisions = demo_artifacts
        .iter()
        .map(|a| a.revision_count as u64)
        .sum();

    // Count only edges that point at demo artifacts. Reporting store-wide totals here
    // would be meaningless once a store already holds real data.
    let demo_ids: std::collections::HashSet<&str> = demo_artifacts
        .iter()
        .map(|artifact| artifact.artifact_id.as_str())
        .collect();
    let demo_edges: Vec<_> = store
        .list_edges(&EdgeFilter::default())?
        .into_iter()
        .filter(|edge| demo_ids.contains(edge.artifact_id.as_str()))
        .collect();
    report.edges = demo_edges.len() as u64;
    report.stale_edges = demo_edges.iter().filter(|edge| edge.stale).count() as u64;

    report.notes.push(
        "expected after seeding: 1 stale edge (hexadof tracks grain-geometry at \
         revision 1, the modeler has published revision 2)"
            .into(),
    );

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::StoreConfig;

    fn temp_store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(StoreConfig::new(dir.path())).unwrap();
        (dir, store)
    }

    #[test]
    fn seed_creates_the_expected_stale_edge() {
        let (_dir, store) = temp_store();
        let report = seed(&store, DEFAULT_SEED_BATCH, false).unwrap();
        assert_eq!(report.artifacts, 3);
        assert_eq!(report.revisions, 4);
        assert_eq!(report.edges, 2);
        assert_eq!(report.stale_edges, 1, "the tracking edge must be stale");
    }

    #[test]
    fn seed_is_idempotent_without_force() {
        let (_dir, store) = temp_store();
        seed(&store, DEFAULT_SEED_BATCH, false).unwrap();
        let second = seed(&store, DEFAULT_SEED_BATCH, false).unwrap();
        assert!(second.already_present);
        assert_eq!(store.stats().unwrap().revisions, 4, "no extra revisions");
    }

    #[test]
    fn purge_removes_every_demo_artifact_and_leaves_real_data_alone() {
        let (_dir, store) = temp_store();

        // A real artifact, outside the demo namespaces.
        let real_type = TypeId::new("burn-geometry-modeler", "grain-geometry").unwrap();
        store.push(PushRequest::new(
            real_type.clone(),
            "engine-real",
            Encoding::Json,
            "burn-geometry-modeler",
            b"{\"real\":true}".to_vec(),
        )).unwrap();

        seed(&store, DEFAULT_SEED_BATCH, false).unwrap();
        let before = store.stats().unwrap();
        assert_eq!(before.demo_artifacts, 3);

        let report = store.purge_demo(Some(DEFAULT_SEED_BATCH)).unwrap();
        assert_eq!(report.artifacts, 3);
        assert_eq!(report.revisions, 4);
        assert_eq!(report.edges, 2);
        assert!(report.blobs_removed >= 1, "the blob-backed revision must be pruned");

        let after = store.stats().unwrap();
        assert_eq!(after.demo_artifacts, 0);
        assert_eq!(after.artifacts, 1, "the real artifact must survive");
        assert_eq!(after.revisions, 1);
        assert_eq!(after.edges, 0);

        // The surviving real artifact is still readable.
        let pulled = store.pull(&real_type, "engine-real", Selector::Latest).unwrap();
        assert!(pulled.is_some());
    }
}
