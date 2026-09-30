//! End-to-end verification: real aproCAD mass properties, through the real orchestration
//! store and HTTP API, into a real HexaDOF model import.
//!
//! Everything numeric here is checked against closed-form physics for a rectangular
//! body, not against itself. That is deliberate: a unit error of 1e6 in the inertia
//! tensor is self-consistent and would pass a round-trip test that only compared the
//! payload to itself.
//!
//! Uses a plain `#[test]` rather than `#[tokio::test]`: `reqwest::blocking` panics if
//! constructed inside a Tokio runtime context, so the runtime is driven explicitly and
//! the blocking client runs on the test thread.

use std::net::{IpAddr, Ipv4Addr};

use apro_api::{AuthRegistry, ServerConfig};
use apro_client::{AproStoreClient, ClientConfig, HttpStoreClient};
use apro_store::{
    AppInterface, EdgeFilter, EdgeRequest, Encoding, Mode, Selector, Store, StoreConfig, TypeId,
};

use apro_harness::{
    to_model_document, MassPropertiesV1, ReferenceGeometrySi, SourceUnits, MASS_PROPERTIES_TYPE,
};

// ---------------------------------------------------------------------------
// Geometry fixtures
// ---------------------------------------------------------------------------

const EDGE_MM: f64 = 100.0;
const DENSITY_KG_PER_MM3: f64 = 2700.0 / 1.0e9; // Al-6061-T6

/// A `EDGE_MM x EDGE_MM x length_mm` rectangular body, **outward wound**.
///
/// Winding matters. `compute_mass_properties` takes `.abs()` of the total volume and
/// divides the first moment by the *signed* volume, so an inverted mesh still yields the
/// right volume, mass and centre of gravity — but its inertia tensor comes out with the
/// wrong sign. A box is used because volume, CG and the full inertia tensor all have
/// exact closed forms, so these assertions are physics rather than self-consistency.
fn body_mesh_mm(length_mm: f32) -> apro_kernel::MeshData {
    let (dx, dy, dz) = (EDGE_MM as f32, EDGE_MM as f32, length_mm);
    let positions = vec![
        0.0, 0.0, 0.0, dx, 0.0, 0.0, dx, dy, 0.0, 0.0, dy, 0.0, // z = 0
        0.0, 0.0, dz, dx, 0.0, dz, dx, dy, dz, 0.0, dy, dz, // z = dz
    ];
    let indices = vec![
        0, 2, 1, 0, 3, 2, // z = 0   outward -Z
        4, 5, 6, 4, 6, 7, // z = dz  outward +Z
        0, 5, 4, 0, 1, 5, // y = 0   outward -Y
        3, 6, 2, 3, 7, 6, // y = dy  outward +Y
        0, 7, 3, 0, 4, 7, // x = 0   outward -X
        1, 6, 5, 1, 2, 6, // x = dx  outward +X
    ];
    apro_kernel::MeshData {
        positions,
        normals: vec![0.0; 24],
        indices,
    }
}

/// The CAD document that declares the unit system. Parsed for real rather than assumed,
/// because the source units drive every conversion factor.
const ROCKET_RON: &str = r#"
Vehicle(
    name: "Sounding Rocket",
    units: Millimeters,
    components: [
        Component(
            name: "Body",
            material: "Al-6061-T6",
            color: None,
            visible: true,
            transform: (position: (0.0, 0.0, 0.0), rotation: (0.0, 0.0, 0.0)),
            kind: Solid([
                Extrude(
                    profile: Rectangle(width: 100.0, height: 100.0, corner_radius: None),
                    height: 600.0,
                    direction: None,
                    taper: None,
                ),
            ]),
        ),
    ],
)
"#;

/// Closed-form mass properties for the box, in native CAD units.
fn expected_native(length_mm: f64) -> (f64, f64, f64, f64) {
    let volume_mm3 = EDGE_MM * EDGE_MM * length_mm;
    let mass_kg = DENSITY_KG_PER_MM3 * volume_mm3;
    // Ixx is about the x axis, so the perpendicular dimensions are y and z.
    let ixx_mm = mass_kg / 12.0 * (EDGE_MM * EDGE_MM + length_mm * length_mm);
    let izz_mm = mass_kg / 12.0 * (EDGE_MM * EDGE_MM + EDGE_MM * EDGE_MM);
    (mass_kg, volume_mm3, ixx_mm, izz_mm)
}

/// Run the real CAD pipeline for a body of the given length, returning its native
/// (document-unit) mass properties.
fn native_mass_properties(length_mm: f32) -> apro_massprops::MassProperties {
    let mesh = body_mesh_mm(length_mm);
    let density = apro_document::density_kg_per_mm3("Al-6061-T6");
    apro_massprops::compute_mass_properties(&mesh, density)
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct Harness {
    _dir: tempfile::TempDir,
    runtime: tokio::runtime::Runtime,
    server: apro_api::RunningServer,
    auth: AuthRegistry,
    endpoint: String,
}

impl Harness {
    fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(StoreConfig::new(dir.path())).unwrap();
        let auth = AuthRegistry::new();

        let runtime = tokio::runtime::Runtime::new().unwrap();
        let server = runtime
            .block_on(apro_api::spawn(
                store,
                auth.clone(),
                ServerConfig {
                    bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
                    port: 0,
                    ..Default::default()
                },
            ))
            .unwrap();

        let endpoint = server.endpoint.clone();
        Self {
            _dir: dir,
            runtime,
            server,
            auth,
            endpoint,
        }
    }

    fn client(&self, app_slug: &str) -> HttpStoreClient {
        let ticket = self.auth.issue_launch_ticket(app_slug, &["read", "write"]);
        HttpStoreClient::connect(
            ClientConfig::new(&self.endpoint, app_slug).with_launch_ticket(ticket),
        )
        .unwrap()
    }

    fn shutdown(self) {
        self.runtime.block_on(self.server.shutdown());
    }
}

fn reference_geometry(length_m: f64) -> ReferenceGeometrySi {
    ReferenceGeometrySi {
        reference_area_m2: 0.01, // 100 mm x 100 mm body
        reference_length_m: length_m,
        body_diameter_m: 0.1,
    }
}

// ---------------------------------------------------------------------------
// The end-to-end test
// ---------------------------------------------------------------------------

#[test]
fn cad_mass_properties_reach_hexadof_as_si() {
    const LENGTH_MM: f64 = 600.0;
    let (mass_kg, volume_mm3, ixx_mm, izz_mm) = expected_native(LENGTH_MM);

    // ---------------------------------------------------------------- 1. producer
    let native = native_mass_properties(LENGTH_MM as f32);

    // The real CAD computation, in native document units.
    assert!(
        (native.volume - volume_mm3).abs() / volume_mm3 < 1e-6,
        "volume {} != {volume_mm3}",
        native.volume
    );
    assert!(
        (native.mass - mass_kg).abs() / mass_kg < 1e-6,
        "mass {} != {mass_kg}",
        native.mass
    );
    assert!((native.center_of_mass[2] - LENGTH_MM / 2.0).abs() < 1e-6);
    assert!(
        (native.inertia_tensor[0][0] - ixx_mm).abs() / ixx_mm < 1e-6,
        "native Ixx {} != {ixx_mm} (check mesh winding)",
        native.inertia_tensor[0][0]
    );
    assert!(
        (native.inertia_tensor[2][2] - izz_mm).abs() / izz_mm < 1e-6,
        "native Izz {} != {izz_mm}",
        native.inertia_tensor[2][2]
    );

    // The document's own unit system drives the conversion.
    let vehicle: apro_document::Vehicle = ron::from_str(ROCKET_RON).expect("RON must parse");
    assert_eq!(vehicle.name, "Sounding Rocket");
    let source = SourceUnits::from_aprocad(&vehicle.units);
    assert_eq!(source, SourceUnits::Millimeters);
    assert_eq!(source.metres_per_unit(), 0.001);
    assert_eq!(source.inertia_scale(), 1.0e-6);

    // ---------------------------------------------------------------- 2. bridge
    let payload = MassPropertiesV1::from_aprocad(&native, source);
    assert_eq!(payload.units, "SI");
    assert!((payload.mass_kg - mass_kg).abs() / mass_kg < 1e-9);
    assert!(
        (payload.center_of_gravity_m[2] - 0.3).abs() < 1e-12,
        "CG should be 0.3 m, got {}",
        payload.center_of_gravity_m[2]
    );
    assert!(
        (payload.inertia_kg_m2[0][0] - ixx_mm / 1.0e6).abs() < 1e-9,
        "Ixx should be {} kg.m^2, got {}",
        ixx_mm / 1.0e6,
        payload.inertia_kg_m2[0][0]
    );

    // The trap, in executable form: inertia differs by exactly 1e6, mass by nothing.
    let ratio = native.inertia_tensor[0][0] / payload.inertia_kg_m2[0][0];
    assert!(
        (ratio - 1.0e6).abs() < 1.0,
        "inertia conversion should be 1e6x, was {ratio}"
    );
    let mass_ratio = native.mass / payload.mass_kg;
    assert!(
        (mass_ratio - 1.0).abs() < 1e-12,
        "mass must not be converted, ratio was {mass_ratio}"
    );
    assert!(
        payload.inertia_asymmetry() < 1e-12,
        "inertia must be symmetric"
    );

    // ---------------------------------------------------------------- 3. platform
    let harness = Harness::start();
    let cad = harness.client("burn-geometry-modeler");
    let consumer = harness.client("hexadof");

    let type_id = TypeId::parse(MASS_PROPERTIES_TYPE).expect("type id must be valid");
    cad.declare_interface(&AppInterface {
        app: "burn-geometry-modeler".into(),
        publishes: vec![type_id.clone()],
        consumes: vec![],
    })
    .unwrap();

    let revision_one_bytes = payload.to_json().unwrap().into_bytes();
    let published = cad
        .push_labeled(
            &type_id,
            "sounding-rocket-a",
            Encoding::Json,
            Some("Mass properties - sounding rocket A"),
            &revision_one_bytes,
        )
        .unwrap();
    assert_eq!(published.revision_number, 1);
    assert_eq!(published.byte_size, revision_one_bytes.len() as u64);

    // Identical re-publish must not spam revisions.
    let again = cad
        .push(
            &type_id,
            "sounding-rocket-a",
            Encoding::Json,
            &revision_one_bytes,
        )
        .unwrap();
    assert!(
        again.unchanged,
        "an unchanged save must not create a revision"
    );

    // ---------------------------------------------------------------- 4. consumer
    let edge = consumer
        .register_edge(&EdgeRequest {
            consumer_app: "hexadof".into(),
            consumer_ref: Some("run-001".into()),
            type_id: type_id.clone(),
            instance: "sounding-rocket-a".into(),
            mode: Mode::Tracking,
            pinned_revision_number: None,
            min_revision_number: None,
        })
        .unwrap();
    assert!(!edge.stale, "a fresh edge starts satisfied");

    let pulled = consumer
        .pull(&type_id, "sounding-rocket-a", Selector::Latest)
        .unwrap()
        .expect("consumer must be able to fetch the published payload");
    assert_eq!(pulled.revision_number, 1);
    assert_eq!(
        pulled.content_hash,
        apro_store::content_hash(&revision_one_bytes),
        "the store must return the producer's bytes verbatim"
    );

    let received = MassPropertiesV1::from_json(pulled.as_str().unwrap()).unwrap();
    assert_eq!(received, payload, "payload must survive the round trip exactly");

    // ------------------------------------------------- 5. real HexaDOF import
    let document = to_model_document(
        &received,
        "sounding-rocket-a",
        "Sounding Rocket A",
        reference_geometry(0.6),
    )
    .expect("an SI payload must map onto the model document");

    let text = document.to_json_pretty().unwrap();
    let imported = hex_model::import_json(&text, &hex_model::ImportOptions::si())
        .expect("HexaDOF must import");

    assert!(
        !imported.validation.has_errors(),
        "HexaDOF reported blocking findings: {:?}",
        imported.validation
    );
    assert!(
        (imported.mass() - mass_kg).abs() / mass_kg < 1e-9,
        "mass drifted"
    );
    let cg = imported.center_of_gravity();
    assert!(
        (cg[2] - 0.3).abs() < 1e-12,
        "HexaDOF read CG {} m, expected 0.3 m",
        cg[2]
    );
    let inertia = imported.inertia();
    assert!(
        (inertia.ixx - ixx_mm / 1.0e6).abs() < 1e-9,
        "HexaDOF read Ixx {} kg.m^2, expected {}",
        inertia.ixx,
        ixx_mm / 1.0e6
    );
    assert!((inertia.izz - izz_mm / 1.0e6).abs() < 1e-9);
    // Off-diagonal terms of a box about its own CG are zero.
    assert!(inertia.ixy.abs() < 1e-12);

    // ---------------------------------------------------------------- 6. the graph
    // The model genuinely changes: the body is extended from 600 mm to 800 mm.
    const REVISED_MM: f64 = 800.0;
    let (mass2, _vol2, ixx2_mm, izz2_mm) = expected_native(REVISED_MM);
    let revised = MassPropertiesV1::from_aprocad(
        &native_mass_properties(REVISED_MM as f32),
        source,
    );
    assert!((revised.mass_kg - mass2).abs() / mass2 < 1e-6);
    assert!(
        (revised.inertia_kg_m2[0][0] - ixx2_mm / 1.0e6).abs() < 1e-6,
        "revision 2 Ixx should reflect the longer body"
    );
    assert!(revised.inertia_kg_m2[0][0] > payload.inertia_kg_m2[0][0]);

    let revision_two_bytes = revised.to_json().unwrap().into_bytes();
    assert_ne!(revision_one_bytes, revision_two_bytes);

    let second = cad
        .push(
            &type_id,
            "sounding-rocket-a",
            Encoding::Json,
            &revision_two_bytes,
        )
        .unwrap();
    assert_eq!(second.revision_number, 2);

    let stale = consumer
        .list_edges(&EdgeFilter {
            consumer_app: Some("hexadof".into()),
            stale: Some(true),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        stale.len(),
        1,
        "the tracking edge must be stale after revision 2"
    );
    assert_eq!(stale[0].last_satisfied_revision_number, Some(1));
    assert_eq!(stale[0].current_revision_number, Some(2));

    // Reproducibility: revision 1 is still readable byte-for-byte after revision 2.
    let historical = consumer
        .pull(&type_id, "sounding-rocket-a", Selector::Number(1))
        .unwrap()
        .unwrap();
    assert_eq!(
        historical.bytes, revision_one_bytes,
        "a superseded revision must remain reproducible"
    );

    // The stale notification is actionable: the consumer re-imports at revision 2 and
    // gets the new physics, then the edge is satisfied again.
    let refreshed =
        MassPropertiesV1::from_json(historical.as_str().unwrap()).unwrap();
    assert_eq!(refreshed, payload);
    let latest = consumer
        .pull(&type_id, "sounding-rocket-a", Selector::Latest)
        .unwrap()
        .unwrap();
    let latest_payload = MassPropertiesV1::from_json(latest.as_str().unwrap()).unwrap();
    let updated_doc = to_model_document(
        &latest_payload,
        "sounding-rocket-a",
        "Sounding Rocket A",
        reference_geometry(0.8),
    )
    .unwrap();
    let updated = hex_model::import_json(
        &updated_doc.to_json_pretty().unwrap(),
        &hex_model::ImportOptions::si(),
    )
    .unwrap();
    assert!(
        (updated.mass() - mass2).abs() / mass2 < 1e-9,
        "the updated model must carry the new mass"
    );
    assert!((updated.inertia().izz - izz2_mm / 1.0e6).abs() < 1e-9);

    let satisfied = consumer.satisfy_edge(&edge.edge_id, Some(2)).unwrap();
    assert!(!satisfied.stale, "accepting the update clears staleness");
    assert_eq!(satisfied.last_satisfied_revision_number, Some(2));

    // A pinned dependency never moves, whatever upstream does.
    let pinned = consumer
        .register_edge(&EdgeRequest {
            consumer_app: "hexadof".into(),
            consumer_ref: Some("run-001-report".into()),
            type_id: type_id.clone(),
            instance: "sounding-rocket-a".into(),
            mode: Mode::Pinned,
            pinned_revision_number: Some(1),
            min_revision_number: None,
        })
        .unwrap();
    assert_eq!(pinned.pinned_revision_number, Some(1));
    assert!(!pinned.stale, "a pinned edge is satisfied by definition");

    cad.push(
        &type_id,
        "sounding-rocket-a",
        Encoding::Json,
        b"{\"third\":true}",
    )
    .unwrap();
    let still_pinned = consumer
        .list_edges(&EdgeFilter::default())
        .unwrap()
        .into_iter()
        .find(|e| e.edge_id == pinned.edge_id)
        .unwrap();
    assert_eq!(
        still_pinned.pinned_revision_number,
        Some(1),
        "the pin must not drift to a newer revision"
    );
    assert!(!still_pinned.stale, "a pinned edge never goes stale");

    harness.shutdown();
}

/// The consumer must refuse a payload that does not declare SI, rather than guessing.
/// A silent guess here is a factor of 1e6 in the inertia tensor.
#[test]
fn a_non_si_payload_is_refused_rather_than_guessed() {
    let (mass_kg, volume_mm3, ixx_mm, izz_mm) = expected_native(600.0);

    let mut payload = MassPropertiesV1 {
        schema: MASS_PROPERTIES_TYPE.to_string(),
        units: "mm".to_string(),
        mass_kg,
        center_of_gravity_m: [0.05, 0.05, 300.0], // deliberately not converted
        inertia_kg_m2: [[ixx_mm, 0.0, 0.0], [0.0, ixx_mm, 0.0], [0.0, 0.0, izz_mm]],
        volume_m3: volume_mm3,
        source_units: SourceUnits::Millimeters,
        source_note: "producer forgot to convert".into(),
    };

    let error = to_model_document(
        &payload,
        "unconverted",
        "Unconverted",
        reference_geometry(0.6),
    )
    .unwrap_err();
    assert!(
        matches!(error, apro_harness::BridgeError::NotSi { .. }),
        "expected a NotSi refusal, got {error}"
    );

    // The same payload declared as SI is accepted, proving the guard is about the
    // declared unit and not about the values.
    payload.units = "SI".into();
    assert!(
        to_model_document(&payload, "converted", "Converted", reference_geometry(0.6)).is_ok()
    );
}
