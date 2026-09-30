//! In-process implementation of `AproStoreClient`.
//!
//! It lives here rather than in `apro-client` because it is the one implementation that
//! needs the storage engine. The published client must stay free of SQLite so an
//! application can embed it just to talk HTTP.

use apro_client::{AproStoreClient, ClientError, HealthInfo, Payload, Result};
use apro_store::{
    AccessRecord, AppInterface, ArtifactFilter, ArtifactSummary, EdgeFilter, EdgeRequest,
    EdgeSummary, Encoding, ErrorKind, EventRecord, RevisionHandle, RevisionSummary, Selector,
    Store, StoreStats, SubscriptionRequest, SubscriptionSummary, TypeId,
};

/// Direct, in-process implementation of the same trait. Used by the hub and by tests
/// where HTTP would be pointless overhead.
///
/// It cannot live in the published `apro-client` crate because it is the one
/// implementation that needs the storage engine — and therefore SQLite. Applications
/// talk over HTTP and must not pay for it.
pub struct LocalStoreClient {
    store: Store,
    app_slug: String,
}

impl LocalStoreClient {
    pub fn new(store: Store, app_slug: impl Into<String>) -> Self {
        Self {
            store,
            app_slug: app_slug.into(),
        }
    }
}

/// Bridges storage failures onto the client error surface.
///
/// The published client must not link SQLite, so it cannot carry a `From<StoreError>`
/// impl. Mapping here reproduces exactly what the HTTP client reports for the same
/// failure — including the machine-readable `code` — so a caller never has to branch
/// on which client implementation it happens to hold.
trait ClientResult<T> {
    fn client(self) -> Result<T>;
}

impl<T> ClientResult<T> for apro_store::Result<T> {
    fn client(self) -> Result<T> {
        self.map_err(|err| ClientError::Api {
            status: match err.kind() {
                ErrorKind::NotFound => 404,
                ErrorKind::Forbidden => 403,
                ErrorKind::Invalid => 400,
                ErrorKind::Internal => 500,
            },
            code: err.code().to_string(),
            message: err.to_string(),
        })
    }
}

impl AproStoreClient for LocalStoreClient {
    fn health(&self) -> Result<HealthInfo> {
        let stats = self.store.stats().client()?;
        Ok(HealthInfo {
            status: "ok".into(),
            service: "apro-store".into(),
            node_id: stats.node_id,
            schema_version: stats.schema_version,
            data_dir: stats.data_dir,
            insecure_auth: true,
        })
    }

    fn declare_interface(&self, interface: &AppInterface) -> Result<()> {
        self.store.declare_interface(interface, "runtime").client()
    }

    fn push(
        &self,
        type_id: &TypeId,
        instance: &str,
        encoding: Encoding,
        payload: &[u8],
    ) -> Result<RevisionHandle> {
        self.push_labeled(type_id, instance, encoding, None, payload)
    }

    fn push_labeled(
        &self,
        type_id: &TypeId,
        instance: &str,
        encoding: Encoding,
        label: Option<&str>,
        payload: &[u8],
    ) -> Result<RevisionHandle> {
        let mut request = apro_store::PushRequest::new(
            type_id.clone(),
            instance,
            encoding,
            self.app_slug.clone(),
            payload.to_vec(),
        );
        if let Some(label) = label {
            request = request.with_label(label);
        }
        self.store.push(request).client()
    }

    fn pull(&self, type_id: &TypeId, instance: &str, selector: Selector) -> Result<Option<Payload>> {
        let Some(fetched) = self.store.pull(type_id, instance, selector).client()? else {
            return Ok(None);
        };
        Ok(Some(Payload {
            artifact_id: fetched.artifact.artifact_id,
            type_id: fetched.artifact.type_id,
            instance: fetched.artifact.instance,
            label: fetched.artifact.label,
            revision_id: fetched.revision.revision_id,
            revision_number: fetched.revision.revision_number,
            encoding: fetched.revision.encoding,
            content_hash: fetched.revision.content_hash,
            byte_size: fetched.revision.byte_size,
            created_at: fetched.revision.created_at,
            seed_batch: fetched.artifact.seed_batch,
            bytes: fetched.payload,
        }))
    }

    fn list_artifacts(&self, filter: &ArtifactFilter) -> Result<Vec<ArtifactSummary>> {
        self.store.list_artifacts(filter).client()
    }

    fn list_revisions(&self, type_id: &TypeId, instance: &str) -> Result<Vec<RevisionSummary>> {
        self.store.list_revisions(type_id, instance).client()
    }

    fn register_edge(&self, request: &EdgeRequest) -> Result<EdgeSummary> {
        let mut request = request.clone();
        request.consumer_app = self.app_slug.clone();
        self.store.register_edge(request).client()
    }

    fn list_edges(&self, filter: &EdgeFilter) -> Result<Vec<EdgeSummary>> {
        self.store.list_edges(filter).client()
    }

    fn satisfy_edge(&self, edge_id: &str, revision_number: Option<u32>) -> Result<EdgeSummary> {
        self.store.satisfy_edge(edge_id, revision_number).client()
    }

    fn events(&self, since: i64) -> Result<Vec<EventRecord>> {
        self.store.events(since, 500).client()
    }

    fn create_subscription(&self, request: &SubscriptionRequest) -> Result<SubscriptionSummary> {
        let mut request = request.clone();
        request.consumer_app = self.app_slug.clone();
        self.store.create_subscription(request).client()
    }

    fn list_subscriptions(&self) -> Result<Vec<SubscriptionSummary>> {
        self.store.list_subscriptions().client()
    }

    fn delete_subscription(&self, subscription_id: &str) -> Result<u64> {
        self.store.delete_subscription(subscription_id).client()
    }

    fn materialize_subscriptions(&self) -> Result<u64> {
        self.store.materialize_subscriptions().client()
    }

    fn delete_edge(&self, edge_id: &str) -> Result<()> {
        self.store.delete_edge(edge_id).client()
    }

    fn access_log(&self, since: i64) -> Result<Vec<AccessRecord>> {
        self.store.access_log(since, 500).client()
    }

    fn stats(&self) -> Result<StoreStats> {
        self.store.stats().client()
    }
}
