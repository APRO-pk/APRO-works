//! End-to-end demonstration of the platform's motivating example.
//!
//! Mass properties measured in the CAD application, pushed to the orchestration store,
//! picked up by HexaDOF, and imported as a flight-dynamics model — using the **real**
//! `apro_massprops` and the **real** `hex_model` code, not reimplementations.
//!
//! Run with:
//!
//! ```powershell
//! cargo run --manifest-path harness/Cargo.toml --example mass_properties_flow
//! ```
//!
//! Every number printed here is checked against closed-form physics for a rectangular
//! body, so a unit error would be visible rather than self-consistent: the CAD app works
//! in millimetres and `kg·mm²`, HexaDOF is SI, and the inertia factor between them is
//! **1e6** — large enough to be invisible in a spot-check of the mass.

use std::net::{IpAddr, Ipv4Addr};

use apro_api::{AuthRegistry, ServerConfig};
use apro_client::{AproStoreClient, ClientConfig, HttpStoreClient};
use apro_store::{
    EdgeFilter, Encoding, Mode, Store, StoreConfig, SubscriptionRequest, TypeId,
};

use apro_harness::{
    to_model_document, MassPropertiesV1, ReferenceGeometrySi, SourceUnits, MASS_PROPERTIES_TYPE,
};

/// Rocket body dimensions, in millimetres.
const EDGE_MM: f64 = 100.0;
const DENSITY_KG_PER_MM3: f64 = 2700.0 / 1.0e9; // Al-6061-T6
const MATERIAL: &str = "Al-6061-T6";

/// The CAD document. Parsed for real, because its declared units drive every conversion.
const DESIGN_RON: &str = r#"
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

/// A rectangular body, wound outward.
///
/// Winding matters: `compute_mass_properties` takes `.abs()` of the volume and divides
/// the first moment by the *signed* volume, so an inward-wound mesh still reports the
/// right mass and centre of gravity but a wrong-signed inertia tensor.
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

/// Closed form for the box, so the printed numbers can be checked by hand.
fn expected(length_mm: f64) -> (f64, f64, f64, f64) {
    let volume = EDGE_MM * EDGE_MM * length_mm;
    let mass = DENSITY_KG_PER_MM3 * volume;
    let ixx = mass / 12.0 * (EDGE_MM * EDGE_MM + length_mm * length_mm);
    let izz = mass / 12.0 * (EDGE_MM * EDGE_MM + EDGE_MM * EDGE_MM);
    (mass, volume, ixx, izz)
}

fn rule(title: &str) {
    println!("\n{}", "─".repeat(74));
    println!("{title}");
    println!("{}", "─".repeat(74));
}

fn step(n: u32, title: &str) {
    println!("\n[{n}] {title}");
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let workspace = tempfile::tempdir()?;
    let runtime = tokio::runtime::Runtime::new()?;

    println!("APRO platform — mass properties flow");
    println!("CAD application → orchestration store → HexaDOF");

    // ------------------------------------------------------------------ producer
    rule("PRODUCER — the CAD application");

    let design: apro_document::Vehicle = ron::from_str(DESIGN_RON)?;
    let units = SourceUnits::from_aprocad(&design.units);
    println!("  design    : {}", design.name);
    println!("  components: {}", design.components.len());
    println!("  units     : {} (declared in the document)", units.as_str());

    let length_mm = 600.0;
    let density = apro_document::density_kg_per_mm3(MATERIAL);
    let native = apro_massprops::compute_mass_properties(&body_mesh_mm(length_mm as f32), density);
    let (mass_kg, volume_mm3, ixx_mm, izz_mm) = expected(length_mm);

    step(1, "Mass properties, as the CAD app computes them (document units)");
    println!("  material  : {MATERIAL}, density {:.1} kg/m^3", density * 1.0e9);
    println!("  volume    : {:>14.1} mm^3", native.volume);
    println!("  mass      : {:>14.4} kg", native.mass);
    println!(
        "  cg        : ({:.1}, {:.1}, {:.1}) mm",
        native.center_of_mass[0], native.center_of_mass[1], native.center_of_mass[2]
    );
    println!("  Ixx       : {:>14.1} kg·mm^2", native.inertia_tensor[0][0]);
    println!("  Izz       : {:>14.1} kg·mm^2", native.inertia_tensor[2][2]);
    println!(
        "  closed form: mass {mass_kg:.4} kg, volume {volume_mm3:.1} mm^3, Ixx {ixx_mm:.1}, Izz {izz_mm:.1}"
    );

    step(2, "Converted at the publish boundary");
    let payload = MassPropertiesV1::from_aprocad(&native, units);
    println!("  declared  : {}", payload.units);
    println!("  mass      : {:>14.4} kg          (unchanged — CAD density is kg/mm^3)", payload.mass_kg);
    println!(
        "  cg        : ({:.4}, {:.4}, {:.4}) m",
        payload.center_of_gravity_m[0], payload.center_of_gravity_m[1], payload.center_of_gravity_m[2]
    );
    println!("  Ixx       : {:>14.7} kg·m^2", payload.inertia_kg_m2[0][0]);
    println!("  Izz       : {:>14.7} kg·m^2", payload.inertia_kg_m2[2][2]);
    println!(
        "  factor    : inertia ÷{:.0}, cg ÷{:.0}, mass ÷{:.0}",
        native.inertia_tensor[0][0] / payload.inertia_kg_m2[0][0],
        native.center_of_mass[2] / payload.center_of_gravity_m[2],
        native.mass / payload.mass_kg
    );

    // ------------------------------------------------------------------ platform
    rule("PLATFORM — the orchestration store");

    let store = Store::open(StoreConfig::new(workspace.path()))?;
    let auth = AuthRegistry::new();
    let server = runtime.block_on(apro_api::spawn(
        store,
        auth.clone(),
        ServerConfig {
            bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 0,
            ..Default::default()
        },
    ))?;
    println!("  store     : {}", server.endpoint);
    println!("  schema    : v{}", apro_store::schema::SCHEMA_VERSION);

    let cad = HttpStoreClient::connect(
        ClientConfig::new(&server.endpoint, "apro-cad").with_launch_ticket(auth.issue_launch_ticket("apro-cad", &["read", "write"])),
    )?;
    let solver = HttpStoreClient::connect(
        ClientConfig::new(&server.endpoint, "hexadof").with_launch_ticket(auth.issue_launch_ticket("hexadof", &["read", "write"])),
    )?;

    step(3, "The CAD application publishes");
    let type_id = TypeId::parse(MASS_PROPERTIES_TYPE)?;
    cad.declare_interface(&apro_store::AppInterface {
        app: "apro-cad".into(),
        publishes: vec![type_id.clone()],
        consumes: vec![],
    })?;
    let bytes = payload.to_json()?.into_bytes();
    let handle = cad.push_labeled(
        &type_id,
        "sounding-rocket-a",
        Encoding::Json,
        Some("Mass properties — sounding rocket A"),
        &bytes,
    )?;
    println!("  type      : {MASS_PROPERTIES_TYPE}");
    println!("  instance  : sounding-rocket-a");
    println!("  revision  : {}", handle.revision_number);
    println!("  bytes     : {}", handle.byte_size);
    println!("  sha256    : {}", &handle.content_hash[..24]);

    step(4, "HexaDOF subscribes to the type");
    let subscription = solver.create_subscription(&SubscriptionRequest {
        consumer_app: "hexadof".into(),
        type_id: type_id.clone(),
        mode: Mode::Tracking,
        created_by: None,
    })?;
    println!("  mode      : {}", subscription.mode);
    println!("  edges     : {} materialised from the subscription", subscription.edge_count);
    println!("  stale     : {}", subscription.stale_edges);

    // ------------------------------------------------------------------ consumer
    rule("CONSUMER — HexaDOF");

    step(5, "HexaDOF pulls and imports");
    let pulled = solver
        .pull(&type_id, "sounding-rocket-a", Default::default())?
        .ok_or("no revision available")?;
    println!("  fetched   : revision {} ({} bytes)", pulled.revision_number, pulled.byte_size);
    println!("  hash match: {}", pulled.content_hash == apro_store::content_hash(&bytes));

    let received = MassPropertiesV1::from_json(pulled.as_str()?)?;
    let document = to_model_document(
        &received,
        "sounding-rocket-a",
        "Sounding Rocket A",
        ReferenceGeometrySi {
            reference_area_m2: 0.01,
            reference_length_m: 0.6,
            body_diameter_m: 0.1,
        },
    )?;
    let imported =
        hex_model::import_json(&document.to_json_pretty()?, &hex_model::ImportOptions::si())?;

    println!("  model id  : {}", imported.model_id);
    println!("  validation: {}", imported.validation.summary());
    println!("  blocking  : {}", imported.validation.has_errors());
    println!();
    println!("  HexaDOF now has:");
    println!("    mass    : {:>14.4} kg", imported.mass());
    let cg = imported.center_of_gravity();
    println!("    cg      : ({:.4}, {:.4}, {:.4}) m", cg[0], cg[1], cg[2]);
    let inertia = imported.inertia();
    println!("    Ixx     : {:>14.7} kg·m^2", inertia.ixx);
    println!("    Izz     : {:>14.7} kg·m^2", inertia.izz);

    step(6, "Cross-checked against closed-form physics");
    let checks = [
        ("mass", imported.mass(), mass_kg, 1e-9),
        ("cg z", cg[2], 0.3, 1e-12),
        ("Ixx", inertia.ixx, ixx_mm / 1.0e6, 1e-9),
        ("Izz", inertia.izz, izz_mm / 1.0e6, 1e-9),
    ];
    for (label, actual, want, tolerance) in checks {
        let scale = want.abs().max(1e-12);
        let drift = (actual - want).abs() / scale;
        println!(
            "  {label:<6} actual {actual:>14.9}  expected {want:>14.9}  rel.err {drift:.2e}  {}",
            if drift <= tolerance { "ok" } else { "FAILED" }
        );
    }

    // ------------------------------------------------------------------ change
    rule("CHANGE — the design is edited");

    step(7, "The CAD application republishes");
    let revised_length = 800.0;
    let (mass2, _, ixx2_mm, _) = expected(revised_length);
    let revised = MassPropertiesV1::from_aprocad(
        &apro_massprops::compute_mass_properties(
            &body_mesh_mm(revised_length as f32),
            density,
        ),
        units,
    );
    let second = cad.push(
        &type_id,
        "sounding-rocket-a",
        Encoding::Json,
        &revised.to_json()?.into_bytes(),
    )?;
    println!("  body      : {length_mm:.0} mm -> {revised_length:.0} mm");
    println!("  revision  : {}", second.revision_number);
    println!("  mass      : {mass_kg:.4} kg -> {mass2:.4} kg");
    println!("  Ixx       : {:.7} -> {:.7} kg·m^2", ixx_mm / 1.0e6, ixx2_mm / 1.0e6);

    step(8, "HexaDOF is told it is out of date");
    let stale = solver.list_edges(&EdgeFilter {
        stale: Some(true),
        ..Default::default()
    })?;
    for edge in &stale {
        println!(
            "  {} / {} is stale: satisfied at revision {:?}, now at {:?}",
            edge.consumer_app,
            edge.instance,
            edge.last_satisfied_revision_number,
            edge.current_revision_number
        );
    }
    println!("  registry says {} stale edge(s)", stale.len());

    step(9, "Reproducibility: revision 1 is still readable verbatim");
    let historical = solver
        .pull(&type_id, "sounding-rocket-a", apro_store::Selector::Number(1))?
        .ok_or("revision 1 gone")?;
    println!(
        "  revision 1 returns {} bytes, byte-identical: {}",
        historical.byte_size,
        historical.bytes == bytes
    );
    println!("  a recorded run can therefore name the exact inputs it used");

    rule("RESULT");
    println!("  The CAD application's mass properties reached HexaDOF intact:");
    println!("  mass, centre of gravity and the full inertia tensor, converted to SI");
    println!("  at the publish boundary and validated by HexaDOF's own importer.");
    println!();
    println!("  Note what the hub did NOT do: it never parsed the payload. It stored");
    println!("  bytes, tracked which revision HexaDOF had seen, and computed staleness");
    println!("  from the graph.\n");

    runtime.block_on(server.shutdown());
    Ok(())
}
