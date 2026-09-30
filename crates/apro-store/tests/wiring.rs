//! Subscription, edge-removal and read-log behaviour.
//!
//! The load-bearing test here is [`rematerialising_never_resets_staleness`]. Materialisation
//! uses `ON CONFLICT DO NOTHING` rather than the `register_edge` upsert specifically so
//! that re-syncing cannot silently mark every dependency fresh — which would destroy the
//! freshness signal the whole graph exists to provide.

use apro_store::{
    AccessRecord, EdgeFilter, Encoding, Mode, PushRequest, RevisionHandle, Store, StoreConfig,
    SubscriptionRequest, SubscriptionSummary, TypeId,
};

fn fresh_store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(StoreConfig::new(dir.path())).unwrap();
    (dir, store)
}

fn push(store: &Store, type_id: &TypeId, instance: &str, actor: &str, payload: &[u8]) -> RevisionHandle {
    store
        .push(PushRequest::new(
            type_id.clone(),
            instance,
            Encoding::Json,
            actor,
            payload.to_vec(),
        ))
        .unwrap()
}

fn subscribe(store: &Store, type_id: &TypeId, consumer: &str, mode: Mode) -> SubscriptionSummary {
    store
        .create_subscription(SubscriptionRequest {
            consumer_app: consumer.to_string(),
            type_id: type_id.clone(),
            mode,
            created_by: None,
        })
        .unwrap()
}

fn stale_count(store: &Store) -> usize {
    store
        .list_edges(&EdgeFilter {
            stale: Some(true),
            ..Default::default()
        })
        .unwrap()
        .len()
}

#[test]
fn subscribing_materialises_edges_for_instances_that_already_exist() {
    let (_dir, store) = fresh_store();
    let mass = TypeId::new("cad-app", "mass-properties").unwrap();

    // Two designs already published before anyone subscribes.
    push(&store, &mass, "engine-a", "cad-app", b"{\"v\":1}");
    push(&store, &mass, "engine-b", "cad-app", b"{\"v\":1}");
    assert!(store.list_edges(&EdgeFilter::default()).unwrap().is_empty());

    let subscription = subscribe(&store, &mass, "solver-app", Mode::Tracking);

    assert_eq!(subscription.edge_count, 2);
    assert_eq!(subscription.stale_edges, 0);
    assert_eq!(subscription.mode, Mode::Tracking);

    let edges = store.list_edges(&EdgeFilter::default()).unwrap();
    assert_eq!(edges.len(), 2);
    assert!(edges.iter().all(|edge| edge.consumer_app == "solver-app"));
    assert!(edges
        .iter()
        .all(|edge| edge.consumer_ref.as_deref().unwrap().starts_with("sub:")));
}

#[test]
fn publishing_a_new_instance_extends_the_subscription_automatically() {
    let (_dir, store) = fresh_store();
    let mass = TypeId::new("cad-app", "mass-properties").unwrap();

    push(&store, &mass, "engine-a", "cad-app", b"{\"v\":1}");
    subscribe(&store, &mass, "solver-app", Mode::Tracking);
    assert_eq!(store.list_edges(&EdgeFilter::default()).unwrap().len(), 1, "back-filled at subscribe time");

    // A brand-new instance nobody wired explicitly.
    push(&store, &mass, "engine-c", "cad-app", b"{\"v\":1}");

    let edges = store.list_edges(&EdgeFilter::default()).unwrap();
    assert_eq!(edges.len(), 2, "push must materialise a subscription edge for the new instance");

    let subscriptions = store.list_subscriptions().unwrap();
    assert_eq!(subscriptions[0].edge_count, 2);
}

#[test]
fn rematerialising_never_resets_staleness() {
    let (_dir, store) = fresh_store();
    let mass = TypeId::new("cad-app", "mass-properties").unwrap();

    push(&store, &mass, "engine-a", "cad-app", b"{\"v\":1}");
    subscribe(&store, &mass, "solver-app", Mode::Tracking);
    assert_eq!(stale_count(&store), 0, "a fresh subscription starts satisfied");

    // The producer moves on, so the consumer is now behind.
    push(&store, &mass, "engine-a", "cad-app", b"{\"v\":2}");
    assert_eq!(stale_count(&store), 1);

    // Re-syncing must create nothing and, critically, disturb nothing.
    let created = store.materialize_subscriptions().unwrap();
    assert_eq!(created, 0, "nothing new to materialise");
    assert_eq!(
        stale_count(&store),
        1,
        "materialising must not reset freshness — that would hide a real staleness"
    );

    let edge = store.list_edges(&EdgeFilter::default()).unwrap().remove(0);
    assert_eq!(edge.last_satisfied_revision_number, Some(1));
    assert_eq!(edge.current_revision_number, Some(2));
}

#[test]
fn subscribing_is_idempotent_and_updates_the_mode() {
    let (_dir, store) = fresh_store();
    let mass = TypeId::new("cad-app", "mass-properties").unwrap();
    push(&store, &mass, "engine-a", "cad-app", b"{\"v\":1}");

    let first = subscribe(&store, &mass, "solver-app", Mode::Tracking);
    let second = subscribe(&store, &mass, "solver-app", Mode::Pinned);

    assert_eq!(
        first.subscription_id, second.subscription_id,
        "an upsert keeps the original identity"
    );
    assert_eq!(second.mode, Mode::Pinned);
    assert_eq!(store.list_subscriptions().unwrap().len(), 1);
    assert_eq!(
        store.list_edges(&EdgeFilter::default()).unwrap().len(),
        1,
        "re-subscribing must not duplicate edges"
    );
}

#[test]
fn a_pinned_subscription_only_pins_what_was_actually_published() {
    let (_dir, store) = fresh_store();
    let mass = TypeId::new("cad-app", "mass-properties").unwrap();

    // A consumer may subscribe before the producer has ever published.
    let subscription = subscribe(&store, &mass, "solver-app", Mode::Pinned);
    assert_eq!(subscription.edge_count, 0, "nothing to pin yet");

    push(&store, &mass, "engine-a", "cad-app", b"{\"v\":1}");
    let subscription = store.list_subscriptions().unwrap().remove(0);
    assert_eq!(subscription.edge_count, 1, "the pin is created once a revision exists");

    let edge = store.list_edges(&EdgeFilter::default()).unwrap().remove(0);
    assert_eq!(edge.pinned_revision_number, Some(1));
    assert!(!edge.stale, "a pinned edge is satisfied by definition");

    // A later revision must not disturb the pin.
    push(&store, &mass, "engine-a", "cad-app", b"{\"v\":2}");
    let edge = store.list_edges(&EdgeFilter::default()).unwrap().remove(0);
    assert_eq!(edge.pinned_revision_number, Some(1));
    assert!(!edge.stale, "pinned edges never go stale");
}

#[test]
fn deleting_a_subscription_removes_the_edges_it_owned() {
    let (_dir, store) = fresh_store();
    let mass = TypeId::new("cad-app", "mass-properties").unwrap();
    let grain = TypeId::new("cad-app", "grain-geometry").unwrap();

    push(&store, &mass, "engine-a", "cad-app", b"{}");
    push(&store, &grain, "engine-a", "cad-app", b"{}");

    let mass_sub = subscribe(&store, &mass, "solver-app", Mode::Tracking);
    subscribe(&store, &grain, "solver-app", Mode::Tracking);
    assert_eq!(store.list_edges(&EdgeFilter::default()).unwrap().len(), 2);

    let removed = store.delete_subscription(&mass_sub.subscription_id).unwrap();

    assert_eq!(removed, 1, "only this subscription's edge");
    assert_eq!(store.list_subscriptions().unwrap().len(), 1);
    assert_eq!(store.list_edges(&EdgeFilter::default()).unwrap().len(), 1);
    assert!(
        store.delete_subscription(&mass_sub.subscription_id).is_err(),
        "deleting twice is an error, not a silent success"
    );
}

#[test]
fn deleting_one_edge_leaves_the_subscription_intact() {
    let (_dir, store) = fresh_store();
    let mass = TypeId::new("cad-app", "mass-properties").unwrap();
    push(&store, &mass, "engine-a", "cad-app", b"{}");

    subscribe(&store, &mass, "solver-app", Mode::Tracking);
    let edge = store.list_edges(&EdgeFilter::default()).unwrap().remove(0);

    store.delete_edge(&edge.edge_id).unwrap();
    assert!(store.list_edges(&EdgeFilter::default()).unwrap().is_empty());
    assert_eq!(store.list_subscriptions().unwrap().len(), 1, "the wire is still configured");

    // Documented consequence: un-wiring one instance is transient, because the
    // subscription owns the edge. Un-wiring durably means deleting the subscription.
    assert_eq!(store.materialize_subscriptions().unwrap(), 1);
    assert_eq!(store.list_edges(&EdgeFilter::default()).unwrap().len(), 1);
}

#[test]
fn deleting_an_unknown_edge_reports_not_found() {
    let (_dir, store) = fresh_store();
    let error = store.delete_edge("nope").unwrap_err();
    assert_eq!(error.code(), "edge_not_found");
}

#[test]
fn the_read_log_is_separate_from_the_change_feed() {
    let (_dir, store) = fresh_store();
    let mass = TypeId::new("cad-app", "mass-properties").unwrap();
    push(&store, &mass, "engine-a", "cad-app", b"{}");

    let change_cursor = store.cursor().unwrap();
    assert!(change_cursor > 0, "publishing writes to the change feed");

    store
        .record_access("solver-app", mass.as_str(), "engine-a", Some("rev-1"), Some(1), "hit")
        .unwrap();
    store
        .record_access("solver-app", mass.as_str(), "engine-missing", None, None, "miss")
        .unwrap();

    assert_eq!(
        store.cursor().unwrap(),
        change_cursor,
        "reads must never appear in the change feed — consumers poll it with a cursor"
    );

    let log: Vec<AccessRecord> = store.access_log(0, 50).unwrap();
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].outcome, "hit");
    assert_eq!(log[0].revision_number, Some(1));
    assert_eq!(log[1].outcome, "miss");
    assert_eq!(log[1].revision_number, None);
    assert!(store.access_cursor().unwrap() >= 2);

    // Cursor semantics: `since` is exclusive.
    let tail = store.access_log(log[0].seq, 50).unwrap();
    assert_eq!(tail.len(), 1);
    assert_eq!(tail[0].outcome, "miss");
}

#[test]
fn subscriptions_survive_a_reopen_and_migrate_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let mass = TypeId::new("cad-app", "mass-properties").unwrap();

    {
        let store = Store::open(StoreConfig::new(dir.path())).unwrap();
        push(&store, &mass, "engine-a", "cad-app", b"{}");
        subscribe(&store, &mass, "solver-app", Mode::Tracking);
        assert_eq!(store.stats().unwrap().schema_version, 2);
    }

    let reopened = Store::open(StoreConfig::new(dir.path())).unwrap();
    assert_eq!(reopened.list_subscriptions().unwrap().len(), 1);
    assert_eq!(reopened.list_edges(&EdgeFilter::default()).unwrap().len(), 1);
}
