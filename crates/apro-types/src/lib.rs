//! # apro-types
//!
//! Shared wire types for the APRO orchestration layer: artifact identities, revisions,
//! dependency edges, subscriptions and the read log.
//!
//! They live in their own crate, with no storage or networking dependencies, so an
//! application embedding `apro-client` does not also compile SQLite. Previously the
//! client depended on `apro-store`, which meant every app linked the server's storage
//! engine in order to talk to it over HTTP.

pub mod error;
pub mod model;

pub use error::{Result, TypeError};
pub use model::*;
