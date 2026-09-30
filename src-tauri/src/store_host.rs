//! Hosts the orchestration store inside the hub process.
//!
//! The store is started once during Tauri setup and lives for the lifetime of the hub.
//! Its HTTP surface is bound to loopback so that launched product apps can talk to it
//! using the endpoint handed to them on the command line.
//!
//! See `DESIGN.md` section 7. Two consequences of hosting in-process are load-bearing:
//!
//! * Closing the hub destroys the store, so a running product loses its data connection.
//!   [`StoreHost::status`] exposes what is running so the UI can warn before that happens.
//! * Every product must tolerate the store being unreachable. `apro-client` returns
//!   `Ok(None)` from `from_launch_environment` in that case rather than failing.

use std::path::PathBuf;
use std::sync::Mutex;

use apro_api::{AuthRegistry, RunningServer, ServerConfig};
use apro_client::DiscoveryFile;
use apro_store::{demo, EdgeFilter, Store, StoreConfig, DEFAULT_SEED_BATCH};
use serde::Serialize;

/// How long a launched product has to exchange its ticket for a session.
pub const LAUNCH_TICKET_TTL_SECS: i64 = 90;

#[derive(Debug, Clone, Serialize)]
pub struct StoreStatus {
    pub running: bool,
    /// Populated when the store failed to start; the UI should surface this verbatim.
    pub error: Option<String>,
    pub endpoint: String,
    pub node_id: String,
    pub data_dir: String,
    pub schema_version: i32,
    pub artifacts: u64,
    pub revisions: u64,
    pub edges: u64,
    pub stale_edges: u64,
    pub demo_artifacts: u64,
    pub blob_count: u64,
    pub blob_bytes: u64,
    pub cursor: i64,
    /// Cursor for the read log, which is a separate sequence from the change feed.
    pub access_cursor: i64,
}

impl StoreStatus {
    fn failed(error: String) -> Self {
        Self {
            running: false,
            error: Some(error),
            endpoint: String::new(),
            node_id: String::new(),
            data_dir: String::new(),
            schema_version: 0,
            artifacts: 0,
            revisions: 0,
            edges: 0,
            stale_edges: 0,
            demo_artifacts: 0,
            blob_count: 0,
            blob_bytes: 0,
            cursor: 0,
            access_cursor: 0,
        }
    }
}

struct HostInner {
    store: Store,
    auth: AuthRegistry,
    endpoint: String,
    server: Mutex<Option<RunningServer>>,
    discovery_path: Option<PathBuf>,
}

/// Managed Tauri state. Degrades to a recorded startup error rather than panicking, so a
/// broken store shows up in the UI instead of preventing the hub from launching.
pub struct StoreHost {
    inner: Option<HostInner>,
    startup_error: Option<String>,
}

impl StoreHost {
    pub fn start() -> Self {
        match Self::try_start() {
            Ok(host) => host,
            Err(err) => Self {
                inner: None,
                startup_error: Some(err),
            },
        }
    }

    fn try_start() -> Result<Self, String> {
        let data_dir = apro_store::default_data_dir().map_err(|err| err.to_string())?;
        let store = Store::open(StoreConfig::new(&data_dir)).map_err(|err| {
            format!(
                "could not open the store at {}: {err}",
                data_dir.display()
            )
        })?;
        let auth = AuthRegistry::new();

        let server = tauri::async_runtime::block_on(apro_api::spawn(
            store.clone(),
            auth.clone(),
            ServerConfig::default(),
        ))
        .map_err(|err| format!("could not bind the store API on loopback: {err}"))?;

        let endpoint = server.endpoint.clone();
        let discovery_path = write_discovery_file(&store, &endpoint).ok();

        Ok(Self {
            inner: Some(HostInner {
                store,
                auth,
                endpoint,
                server: Mutex::new(Some(server)),
                discovery_path,
            }),
            startup_error: None,
        })
    }

    fn inner(&self) -> Result<&HostInner, String> {
        self.inner.as_ref().ok_or_else(|| {
            self.startup_error
                .clone()
                .unwrap_or_else(|| "the APRO store is not running".to_string())
        })
    }

    pub fn endpoint(&self) -> Result<&str, String> {
        Ok(&self.inner()?.endpoint)
    }

    pub fn auth(&self) -> Result<&AuthRegistry, String> {
        Ok(&self.inner()?.auth)
    }

    pub fn store(&self) -> Result<&Store, String> {
        Ok(&self.inner()?.store)
    }

    /// Mint a launch ticket. The caller writes it to the launch-ticket file so the
    /// on-disk contract is unchanged from the pre-orchestration handoff.
    pub fn issue_launch_ticket(&self, app_slug: &str) -> Result<String, String> {
        let auth = self.auth()?;
        Ok(auth.issue_launch_ticket_with_ttl(
            app_slug,
            &["read", "write"],
            LAUNCH_TICKET_TTL_SECS,
        ))
    }

    pub fn status(&self) -> StoreStatus {
        let Ok(inner) = self.inner() else {
            return StoreStatus::failed(
                self.startup_error
                    .clone()
                    .unwrap_or_else(|| "the APRO store is not running".into()),
            );
        };

        let stale_edges = inner
            .store
            .list_edges(&EdgeFilter {
                stale: Some(true),
                ..Default::default()
            })
            .map(|edges| edges.len() as u64)
            .unwrap_or(0);

        match inner.store.stats() {
            Ok(stats) => StoreStatus {
                running: true,
                error: None,
                endpoint: inner.endpoint.clone(),
                node_id: stats.node_id,
                data_dir: stats.data_dir,
                schema_version: stats.schema_version,
                artifacts: stats.artifacts,
                revisions: stats.revisions,
                edges: stats.edges,
                stale_edges,
                demo_artifacts: stats.demo_artifacts,
                blob_count: stats.blob_count,
                blob_bytes: stats.blob_bytes,
                cursor: stats.cursor,
                access_cursor: inner.store.access_cursor().unwrap_or(0),
            },
            Err(err) => StoreStatus::failed(format!("the store could not be read: {err}")),
        }
    }

    pub fn seed_demo(&self, force: bool) -> Result<demo::SeedReport, String> {
        demo::seed(self.store()?, DEFAULT_SEED_BATCH, force).map_err(|err| err.to_string())
    }

    pub fn purge_demo(&self) -> Result<apro_store::PurgeReport, String> {
        self.store()?
            .purge_demo(Some(DEFAULT_SEED_BATCH))
            .map_err(|err| err.to_string())
    }

    // -- read surface for the hub UI -----------------------------------------
    //
    // The workflow canvas and the activity console read the store directly rather
    // than over loopback HTTP: the store lives in this process, so a round trip
    // through its own API would be pure overhead.

    /// Events after `since`, oldest first. `since` is the cursor from `StoreStats`.
    pub fn events(&self, since: i64, limit: u32) -> Result<Vec<apro_store::EventRecord>, String> {
        self.store()?
            .events(since, limit.min(2000))
            .map_err(|err| err.to_string())
    }

    /// Every dependency edge, with freshness computed from the graph.
    pub fn edges(&self) -> Result<Vec<apro_store::EdgeSummary>, String> {
        self.store()?
            .list_edges(&EdgeFilter::default())
            .map_err(|err| err.to_string())
    }

    /// Every declared publish/consume contract. Drives the canvas ports.
    pub fn interfaces(&self) -> Result<Vec<apro_store::DeclaredType>, String> {
        self.store()?.interfaces().map_err(|err| err.to_string())
    }

    // -- wiring write path ---------------------------------------------------
    //
    // The canvas edits *subscriptions* (type-level) rather than edges (instance-level),
    // because a wire names a kind of data, not a particular artifact. These calls are
    // what turn a drawn wire into durable state.

    pub fn subscriptions(&self) -> Result<Vec<apro_store::SubscriptionSummary>, String> {
        self.store()?
            .list_subscriptions()
            .map_err(|err| err.to_string())
    }

    pub fn create_subscription(
        &self,
        consumer_app: &str,
        type_id: &str,
        mode: &str,
    ) -> Result<apro_store::SubscriptionSummary, String> {
        let request = apro_store::SubscriptionRequest {
            consumer_app: consumer_app.to_string(),
            type_id: apro_store::TypeId::parse(type_id).map_err(|err| err.to_string())?,
            mode: apro_store::Mode::parse(mode).map_err(|err| err.to_string())?,
            created_by: None,
        };
        self.store()?
            .create_subscription(request)
            .map_err(|err| err.to_string())
    }

    pub fn delete_subscription(&self, subscription_id: &str) -> Result<u64, String> {
        self.store()?
            .delete_subscription(subscription_id)
            .map_err(|err| err.to_string())
    }

    pub fn materialize_subscriptions(&self) -> Result<u64, String> {
        self.store()?
            .materialize_subscriptions()
            .map_err(|err| err.to_string())
    }

    /// The read log, newest last.
    pub fn access_log(&self, since: i64, limit: u32) -> Result<Vec<apro_store::AccessRecord>, String> {
        self.store()?
            .access_log(since, limit.min(2000))
            .map_err(|err| err.to_string())
    }

    /// Stop serving and remove the discovery file. The hub calls this on real exit only.
    pub fn shutdown(&self) {
        let Some(inner) = &self.inner else {
            return;
        };
        if let Some(path) = &inner.discovery_path {
            let _ = std::fs::remove_file(path);
        }
        let server = inner
            .server
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(server) = server {
            tauri::async_runtime::block_on(server.shutdown());
        }
    }
}

/// Write the fallback endpoint discovery file, for apps launched outside the hub
/// (developer runs, direct executable launches). The launch arguments are the primary
/// channel; this file exists so a hand-launched app can still find the store.
fn write_discovery_file(store: &Store, endpoint: &str) -> Result<PathBuf, String> {
    let path = apro_client::discovery_path().map_err(|err| err.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    let file = DiscoveryFile {
        endpoint: endpoint.to_string(),
        instance_id: format!("{}-{}", store.node_id(), std::process::id()),
        pid: std::process::id(),
        node_id: store.node_id().to_string(),
        api_version: 1,
    };

    let contents = serde_json::to_vec_pretty(&file).map_err(|err| err.to_string())?;
    std::fs::write(&path, contents).map_err(|err| err.to_string())?;
    Ok(path)
}
