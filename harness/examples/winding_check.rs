//! Diagnostic: does a mesh's triangle winding point outward?
//!
//! Run with `cargo run --manifest-path harness/Cargo.toml --example winding_check`.
//!
//! `compute_mass_properties` takes `.abs()` of the total volume and divides the first
//! moment by the *signed* volume. An inward-wound mesh therefore still reports the right
//! volume, mass and centre of gravity, but its inertia tensor comes out with the wrong
//! sign — and not merely flipped, because the parallel-axis term is subtracted with the
//! opposite sign to the origin integral.
//!
//! ## Confirmed finding (aproCAD, `crates/massprops/src/lib.rs`)
//!
//! The `unit_cube_mesh` fixture in aproCAD's own massprops tests is wound inward:
//!
//! ```text
//!   volume (abs) = 1.0                      <- looks correct
//!   mass         = 1.0                      <- looks correct
//!   com          = [0.5, 0.5, 0.5]          <- looks correct
//!   Ixx          = -1.166666666666667       <- WRONG (closed form: +1/6 = 0.16667)
//! ```
//!
//! `-1.1667 = -(2/3) - 0.5`: a negated origin integral minus a correctly-signed
//! parallel-axis term. The fixture's inward winding is invisible to aproCAD's tests
//! because `test_unit_cube_volume`, `test_unit_cube_com` and `test_unit_cube_mass` assert
//! only quantities that survive a global winding inversion — **none of them touches the
//! inertia tensor.**
//!
//! Meshes produced by the Truck kernel are wound outward, so production is almost
//! certainly unaffected. The gap is test coverage: the inertia path has no assertion
//! against a known-correct mesh. Fixing the fixture's winding, or simply asserting
//! `Ixx` in `test_unit_cube_*`, closes it.
//!
//! Fixture below is copied verbatim from aproCAD so this can be re-run after any change.

fn main() {
    let positions = vec![
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0,
        1.0, 1.0, 1.0, 0.0, 1.0, 1.0,
    ];
    let indices = vec![
        0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4,
        1, 5, 6, 1, 6, 2,
    ];
    let mesh = apro_kernel::MeshData {
        positions,
        normals: vec![0.0; 24],
        indices,
    };
    let mp = apro_massprops::compute_mass_properties(&mesh, 1.0);

    println!("aproCAD's own unit_cube_mesh fixture:");
    println!("  volume (abs) = {}", mp.volume);
    println!("  mass         = {}", mp.mass);
    println!("  com          = {:?}", mp.center_of_mass);
    println!("  Ixx          = {}", mp.inertia_tensor[0][0]);
    println!("  Izz          = {}", mp.inertia_tensor[2][2]);
    println!();
    println!("closed form for a unit cube about its centre: Ixx = Iyy = Izz = 1/6 = {}", 1.0 / 6.0);
    println!(
        "verdict: {}",
        if mp.inertia_tensor[0][0] < 0.0 {
            "INVERTED WINDING -- inertia is negative"
        } else {
            "winding is outward"
        }
    );
}
