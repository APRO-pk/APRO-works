//! End-to-end HTTP tests: real socket, real auth, real bytes.
//!
//! These use a plain `#[test]` rather than `#[tokio::test]` on purpose.
//! `reqwest::blocking` panics if constructed inside a Tokio runtime context, so the
//! runtime is driven explicitly: tasks keep running on the multi-thread runtime's
//! worker threads, and the blocking client is used from the test thread outside
//! `block_on`.

use std::net::{IpAddr, Ipv4Addr};

use apro_api::{AuthRegistry, ServerConfig};
use apro_client::{AproStoreClient, ClientConfig, HttpStoreClient};
use apro_store::{
    AppInterface, ArtifactFilter, EdgeFilter, Encoding, Mode, Store, StoreConfig,
    SubscriptionRequest, TypeId,
};

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

    /// Full ticket -> session -> client path, exactly as a real app experiences it.
    fn client(&self, app_slug: &str) -> HttpStoreClient {
        let ticket = self.auth.issue_launch_ticket(app_slug, &["read", "write"]);
        let config = ClientConfig::new(&self.endpoint, app_slug).with_launch_ticket(ticket);
        HttpStoreClient::connect(config).unwrap()
    }

    fn shutdown(self) {
        self.runtime.block_on(self.server.shutdown());
    }
}

fn raw_get(url: &str, token: Option<&str>) -> reqwest::blocking::Response {
    let client = reqwest::blocking::Client::new();
    let request = client.get(url);
    match token {
        Some(token) => request.bearer_auth(token).send().unwrap(),
        None => request.send().unwrap(),
    }
}

#[test]
fn health_is_public() {
    let harness = Harness::start();
    let response = raw_get(&format!("{}/v1/health", harness.endpoint), None);
    assert_eq!(response.status(), 200);

    let body: serde_json::Value = response.json().unwrap();
    assert_eq!(body["status"], "ok");
    assert_eq!(body["insecure_auth"], false);
    harness.shutdown();
}

#[test]
fn protected_routes_require_a_session() {
    let harness = Harness::start();

    let response = raw_get(&format!("{}/v1/stats", harness.endpoint), None);
    assert_eq!(response.status(), 401, "no token must be rejected");

    let response = raw_get(&format!("{}/v1/stats", harness.endpoint), Some("garbage"));
    assert_eq!(response.status(), 401, "an unknown token must be rejected");

    // A launch ticket is NOT a session: it has to be exchanged first.
    let ticket = harness
        .auth
        .issue_launch_ticket("burn-geometry-modeler", &["write"]);
    let response = raw_get(&format!("{}/v1/stats", harness.endpoint), Some(&ticket));
    assert_eq!(response.status(), 401, "a ticket must not act as a session");

    harness.shutdown();
}

#[test]
fn launch_ticket_is_single_use_over_the_wire() {
    let harness = Harness::start();
    let ticket = harness.auth.issue_launch_ticket("hexadof", &["write"]);

    let client = reqwest::blocking::Client::new();
    let first = client
        .post(format!("{}/v1/session", harness.endpoint))
        .bearer_auth(&ticket)
        .send()
        .unwrap();
    assert_eq!(first.status(), 200);

    let second = client
        .post(format!("{}/v1/session", harness.endpoint))
        .bearer_auth(&ticket)
        .send()
        .unwrap();
    assert_eq!(second.status(), 401, "a ticket must not be redeemable twice");

    harness.shutdown();
}

#[test]
fn full_round_trip_over_http() {
    let harness = Harness::start();
    let client = harness.client("burn-geometry-modeler");

    let grain = TypeId::new("burn-geometry-modeler", "grain-geometry").unwrap();
    client
        .declare_interface(&AppInterface {
            app: "burn-geometry-modeler".into(),
            publishes: vec![grain.clone()],
            consumes: vec![],
        })
        .unwrap();

    let handle = client
        .push(&grain, "engine-A", Encoding::Json, br#"{"outer_diameter":152.4}"#)
        .unwrap();
    assert_eq!(handle.revision_number, 1);
    assert!(handle.created_new_artifact);

    let payload = client
        .pull(&grain, "engine-A", Default::default())
        .unwrap()
        .expect("payload must be readable");
    assert_eq!(payload.bytes, br#"{"outer_diameter":152.4}"#);
    assert_eq!(payload.revision_number, 1);
    assert_eq!(payload.type_id, "burn-geometry-modeler/grain-geometry");
    assert_eq!(payload.instance, "engine-A");
    assert_eq!(payload.encoding, Encoding::Json);
    assert_eq!(
        payload.content_hash,
        apro_store::content_hash(br#"{"outer_diameter":152.4}"#),
        "the advertised hash must match the returned bytes"
    );

    // Byte-identical push must not create revision spam.
    let repeat = client
        .push(&grain, "engine-A", Encoding::Json, br#"{"outer_diameter":152.4}"#)
        .unwrap();
    assert!(repeat.unchanged);
    assert_eq!(repeat.revision_number, 1);

    // Changed bytes append a revision.
    let second = client
        .push(&grain, "engine-A", Encoding::Json, br#"{"outer_diameter":160.0}"#)
        .unwrap();
    assert_eq!(second.revision_number, 2);

    let history = client.list_revisions(&grain, "engine-A").unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[1].parent_revision_id.as_deref(), Some(history[0].revision_id.as_str()));

    // Historical revisions stay readable after the artifact moves on (D3).
    let old = client
        .pull(&grain, "engine-A", apro_store::Selector::Number(1))
        .unwrap()
        .unwrap();
    assert_eq!(old.bytes, br#"{"outer_diameter":152.4}"#);

    assert!(client.events(0).unwrap().len() >= 3);
    harness.shutdown();
}

#[test]
fn undeclared_writes_are_rejected() {
    let harness = Harness::start();
    let client = harness.client("burn-geometry-modeler");

    let allowed = TypeId::new("burn-geometry-modeler", "grain-geometry").unwrap();
    client
        .declare_interface(&AppInterface {
            app: "burn-geometry-modeler".into(),
            publishes: vec![allowed.clone()],
            consumes: vec![],
        })
        .unwrap();

    // Declared type: fine.
    assert!(client
        .push(&allowed, "engine-A", Encoding::Json, b"{}")
        .is_ok());

    // Undeclared type: refused.
    let sneaky = TypeId::new("burn-geometry-modeler", "not-declared").unwrap();
    let error = client
        .push(&sneaky, "engine-A", Encoding::Json, b"{}")
        .unwrap_err();
    assert_eq!(error.api_code(), Some("write_not_declared"));

    harness.shutdown();
}

#[test]
fn identity_mismatch_is_refused() {
    let harness = Harness::start();

    // A session genuinely belonging to hexadof.
    let session = harness
        .auth
        .issue_session_direct("hexadof", &["read", "write"], 600);

    // Matching identity is accepted.
    let ok = reqwest::blocking::Client::new()
        .get(format!("{}/v1/stats", harness.endpoint))
        .bearer_auth(&session.session_token)
        .header("x-apro-app", "hexadof")
        .send()
        .unwrap();
    assert_eq!(ok.status(), 200);

    // Claiming to be a different app must be refused, not silently attributed.
    let mismatch = reqwest::blocking::Client::new()
        .get(format!("{}/v1/stats", harness.endpoint))
        .bearer_auth(&session.session_token)
        .header("x-apro-app", "burn-geometry-modeler")
        .send()
        .unwrap();
    assert_eq!(mismatch.status(), 403);

    harness.shutdown();
}

#[test]
fn large_payload_round_trips_through_the_blob_store() {
    let harness = Harness::start();
    let client = harness.client("burn-geometry-modeler");

    let step = TypeId::new("burn-geometry-modeler", "geometry-step").unwrap();
    client
        .declare_interface(&AppInterface {
            app: "burn-geometry-modeler".into(),
            publishes: vec![step.clone()],
            consumes: vec![],
        })
        .unwrap();

    // Above INLINE_MAX_BYTES, so this must take the blob path.
    let blob: Vec<u8> = (0..200_000).map(|i| (i % 251) as u8).collect();
    assert!(blob.len() > apro_store::INLINE_MAX_BYTES);

    let handle = client
        .push(&step, "engine-A", Encoding::Blob, &blob)
        .unwrap();
    assert_eq!(handle.byte_size, blob.len() as u64);

    let payload = client
        .pull(&step, "engine-A", Default::default())
        .unwrap()
        .unwrap();
    assert_eq!(payload.bytes.len(), blob.len());
    assert_eq!(payload.bytes, blob, "blob bytes must survive verbatim");

    harness.shutdown();
}

#[test]
fn filters_hide_demo_data_by_default() {
    let harness = Harness::start();
    let client = harness.client("apro-demo");

    let demo_type = TypeId::new("apro-demo", "sample").unwrap();
    client
        .declare_interface(&AppInterface {
            app: "apro-demo".into(),
            publishes: vec![demo_type.clone()],
            consumes: vec![],
        })
        .unwrap();

    // Seed data is marked by a batch, which the API does not set, so assert the
    // filter plumbing itself works on the store level through the API surface.
    client
        .push(&demo_type, "sample-1", Encoding::Json, b"{}")
        .unwrap();

    let visible = client
        .list_artifacts(&ArtifactFilter::default())
        .unwrap();
    assert_eq!(visible.len(), 1, "non-seeded artifacts are visible");

    let filtered = client
        .list_artifacts(&ArtifactFilter {
            owner_app: Some("nonexistent-app".into()),
            ..Default::default()
        })
        .unwrap();
    assert!(filtered.is_empty());

    harness.shutdown();
}

/// The whole wiring write path over real HTTP: subscribe, materialise, log reads, un-wire.
#[test]
fn subscriptions_materialise_and_reads_are_logged() {
    let harness = Harness::start();
    let producer = harness.client("burn-geometry-modeler");
    let consumer = harness.client("hexadof");

    let mass = TypeId::new("burn-geometry-modeler", "mass-properties").unwrap();
    producer
        .declare_interface(&AppInterface {
            app: "burn-geometry-modeler".into(),
            publishes: vec![mass.clone()],
            consumes: vec![],
        })
        .unwrap();
    producer
        .push(&mass, "engine-a", Encoding::Json, br#"{"v":1}"#)
        .unwrap();

    // A wire drawn on the canvas becomes a subscription, back-filled per instance.
    let subscription = consumer
        .create_subscription(&SubscriptionRequest {
            consumer_app: "hexadof".into(),
            type_id: mass.clone(),
            mode: Mode::Tracking,
            created_by: None,
        })
        .unwrap();
    assert_eq!(subscription.edge_count, 1);
    assert_eq!(subscription.consumer_app, "hexadof");

    // Subscribing twice must not duplicate anything.
    let again = consumer
        .create_subscription(&SubscriptionRequest {
            consumer_app: "hexadof".into(),
            type_id: mass.clone(),
            mode: Mode::Tracking,
            created_by: None,
        })
        .unwrap();
    assert_eq!(again.subscription_id, subscription.subscription_id);

    // A pull is recorded in the read log, attributed to the session's app.
    consumer
        .pull(&mass, "engine-a", Default::default())
        .unwrap()
        .expect("the published revision must be readable");
    let reads = consumer.access_log(0).unwrap();
    assert!(
        reads
            .iter()
            .any(|entry| entry.outcome == "hit" && entry.actor_app == "hexadof"),
        "a hit must be logged: {reads:?}"
    );

    // A miss is logged too — that is how "never asked" is told from "asked too early".
    assert!(consumer
        .pull(&mass, "engine-missing", Default::default())
        .unwrap()
        .is_none());
    let reads = consumer.access_log(0).unwrap();
    assert!(
        reads.iter().any(|entry| entry.outcome == "miss"),
        "a miss must be logged: {reads:?}"
    );

    // Reads must not have touched the change feed.
    let change_feed = consumer.events(0).unwrap();
    assert!(
        change_feed.iter().all(|event| event.kind != "revision.fetched"),
        "the read log must never leak into the change feed"
    );

    // A new instance is picked up automatically.
    producer
        .push(&mass, "engine-b", Encoding::Json, br#"{"v":1}"#)
        .unwrap();
    assert_eq!(
        consumer.list_edges(&EdgeFilter::default()).unwrap().len(),
        2,
        "publishing a new instance must extend the subscription"
    );

    // Un-wiring removes the subscription and every edge it owned.
    let removed = consumer
        .delete_subscription(&subscription.subscription_id)
        .unwrap();
    assert_eq!(removed, 2);
    assert!(consumer
        .list_edges(&EdgeFilter::default())
        .unwrap()
        .is_empty());
    assert!(consumer.list_subscriptions().unwrap().is_empty());

    harness.shutdown();
}
