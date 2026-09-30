//! # apro-harness
//!
//! Verification harness for the APRO orchestration layer.
//!
//! This crate exists to prove the layer carries data between the **real** applications,
//! not between stubs. It holds no logic of its own: it wires the production bridges from
//! both application repositories together against a real store and a real HTTP API, so a
//! regression in either bridge shows up here.
//!
//! * [`apro_cad_bridge`] lives in `aproCAD/` and depends on `apro-document`, `apro-kernel`
//!   and `apro-massprops`.
//! * [`hex_bridge`] lives in `hexadof2/` and depends on `hex-model` and `hex-core`.
//!
//! The platform must never depend on an application, which is why this harness is a
//! standalone workspace rather than a member of the `APRO-works` workspace: the
//! dependency points from here into the applications, never the other way round.
//!
//! ## The two boundaries this harness exists to police
//!
//! **Units.** aproCAD computes in document units, which default to millimetres. HexaDOF is
//! SI. Its mass is already kilograms, so a spot-check of the mass looks right while the
//! inertia is wrong by a factor of **1e6** — a discrepancy that still produces
//! plausible-looking flight dynamics.
//!
//! **Axes.** aproCAD renders Y-up and models along +Z; HexaDOF's body frame is
//! Forward-Left-Up. A model can be perfectly SI and still arrive pointing the wrong way.
//!
//! Both are checked here against closed-form physics rather than against a round trip,
//! because a round trip through the same wrong conversion agrees with itself.

/// Re-exported so a test can reach the producer bridge, its client and its contract types
/// through one path.
pub use apro_cad_bridge;

/// Re-exported so a test can reach the consumer bridge the same way.
pub use hex_bridge;

/// The wire contract, as published by the producer bridge.
pub use apro_cad_bridge::apro_contracts;

/// The store client both bridges talk through.
pub use apro_cad_bridge::apro_client;
