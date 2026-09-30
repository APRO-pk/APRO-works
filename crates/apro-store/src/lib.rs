//! # apro-store
//!
//! The APRO Works local orchestration store.
//!
//! Holds a *revisioned artifact + dependency graph*, not a universal payload schema.
//! Payloads are opaque bytes owned by the publishing app; the store only understands
//! the envelope (see `DESIGN.md` sections 2 and 5).
//!
//! ```text
//! use apro_store::{Encoding, PushRequest, Selector, Store, StoreConfig, TypeId};
//!
//! let dir = tempfile::tempdir().unwrap();
//! let store = Store::open(StoreConfig::new(dir.path())).unwrap();
//!
//! let type_id = TypeId::new("burn-geometry-modeler", "grain-geometry").unwrap();
//! store.push(PushRequest::new(
//!     type_id.clone(), "engine-a", Encoding::Json, "burn-geometry-modeler",
//!     br#"{"outer_diameter":152.4}"#.to_vec(),
//! )).unwrap();
//!
//! let fetched = store.pull(&type_id, "engine-a", Selector::Latest).unwrap().unwrap();
//! assert_eq!(fetched.revision.revision_number, 1);
//! ```
//!
//! The example above is run by `tests/round_trip.rs` rather than as a doctest, because a
//! doctest here cannot link once the Tauri app crate is in the same workspace build. That
//! file explains why in full — please read it before moving this back.

pub mod blob;
pub mod demo;
pub mod error;
pub mod schema;
pub mod store;
pub mod wiring;

pub use blob::{content_hash, BlobStore};
pub use error::{ErrorKind, Result, StoreError};
pub use store::{default_data_dir, Store, StoreConfig};

/// The wire types now live in `apro-types`, so the client SDK can use them without
/// linking the storage engine. Re-exported here so existing callers are unaffected.
pub use apro_types::*;
