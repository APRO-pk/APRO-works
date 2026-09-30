//! The push/pull round trip that the module documentation walks through.
//!
//! It lives in `tests/` rather than in a `///` example because of the way Tauri's
//! static-CRT support interferes with doctests. `tauri-build` writes an empty
//! `msvcrt.lib` into the app crate's OUT_DIR and puts that directory on the link search
//! path; the `/DEFAULTLIB` arguments that make it safe are `rustc-link-arg`, which apply
//! only to the app's own final binary. A doctest belonging to a *different* workspace
//! member still inherits the search path when the whole workspace is tested in one go,
//! finds the empty `msvcrt.lib` first, and fails to link:
//!
//! ```text
//! msvcrt.lib : warning LNK4003: invalid library format; library ignored
//! libstd-...rlib : error LNK2001: unresolved external symbol __CxxFrameHandler3
//! ```
//!
//! An integration test links like any other test target, so it is unaffected. Moving it
//! back into the documentation would break `cargo test --workspace`.

use apro_store::{Encoding, PushRequest, Selector, Store, StoreConfig, TypeId};

#[test]
fn a_pushed_revision_comes_back_from_a_latest_pull() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(StoreConfig::new(dir.path())).unwrap();

    let type_id = TypeId::new("burn-geometry-modeler", "grain-geometry").unwrap();
    store
        .push(PushRequest::new(
            type_id.clone(),
            "engine-a",
            Encoding::Json,
            "burn-geometry-modeler",
            br#"{"outer_diameter":152.4}"#.to_vec(),
        ))
        .unwrap();

    let fetched = store.pull(&type_id, "engine-a", Selector::Latest).unwrap().unwrap();
    assert_eq!(fetched.revision.revision_number, 1);
}
