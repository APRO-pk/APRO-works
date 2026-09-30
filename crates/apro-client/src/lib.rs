//! # apro-client
//!
//! The client SDK for the APRO Works orchestration store. This is the **only**
//! dependency an app needs; transport, authentication, hashing, cursors and
//! serialization are all handled here.
//!
//! ## The whole surface an app author learns
//!
//! ```no_run
//! use apro_client::{AproStoreClient, HttpStoreClient};
//! use apro_types::{Encoding, TypeId};
//!
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! // Returns None when the app was not launched by the hub, so the app can
//! // fall back to a local-only mode instead of crashing (DESIGN.md 7/R2).
//! let Some(client) = HttpStoreClient::from_launch_environment()? else {
//!     eprintln!("not launched by APRO Works; running without shared data");
//!     return Ok(());
//! };
//!
//! let grain = TypeId::new("burn-geometry-modeler", "grain-geometry")?;
//!
//! // Publish. Bytes are snapshotted; a revision is appended, never overwritten.
//! client.push(&grain, "engine-A", Encoding::Json, br#"{"outer_diameter":152.4}"#)?;
//!
//! // Consume.
//! if let Some(payload) = client.pull(&grain, "engine-A", Default::default())? {
//!     println!("revision {} ({} bytes)", payload.revision_number, payload.byte_size);
//! }
//!
//! // React to changes. This returns a notification, not a payload.
//! let events = client.events(0)?;
//! println!("{} change(s) since the beginning", events.len());
//! # Ok(())
//! # }
//! ```
//!
//! ## The identity triple
//!
//! `(type_id, instance, encoding)` أ¢â‚¬â€‌ see `DESIGN.md` D17. `type_id` is the semantic
//! kind (`owner-app/type-name`), `instance` says *which one*, and `encoding` says how
//! the bytes are serialized. Collapsing `instance` into `type_id` makes it impossible
//! to know which revision a downstream result depended on.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use apro_types::{
    AccessRecord, AppInterface, ArtifactFilter, ArtifactSummary, EdgeFilter, EdgeRequest,
    EdgeSummary, Encoding, EventRecord, RevisionHandle, RevisionSummary, Selector, StoreStats,
    SubscriptionRequest, SubscriptionSummary, TypeId,
};

/// Re-exported so apps need only depend on `apro-client`.
pub use apro_types;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("could not reach the APRO store: {0}")]
    Transport(String),

    #[error("the APRO store rejected the request ({status} {code}): {message}")]
    Api {
        status: u16,
        code: String,
        message: String,
    },

    #[error("not connected to the APRO store: {0}")]
    NotConnected(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    /// A shared value type rejected its input, before any request was made.
    #[error("invalid value: {0}")]
    Types(#[from] apro_types::TypeError),
}

pub type Result<T> = std::result::Result<T, ClientError>;

impl ClientError {
    /// True when the store simply is not running, as opposed to rejecting the request.
    /// Apps should degrade to local-only mode rather than failing hard here.
    pub fn is_unreachable(&self) -> bool {
        matches!(self, ClientError::Transport(_))
    }

    /// True when the session has expired or was revoked; the app should re-exchange
    /// its launch ticket or ask the user to relaunch from the hub.
    pub fn is_unauthorized(&self) -> bool {
        matches!(self, ClientError::Api { status: 401, .. })
    }

    /// Stable machine-readable error code, identical across transports.
    ///
    /// App code must be able to branch on the same code whether it is talking to a
    /// local store or over HTTP.
    pub fn api_code(&self) -> Option<&str> {
        match self {
            ClientError::Api { code, .. } => Some(code),
            ClientError::Types(err) => Some(err.code()),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthInfo {
    pub status: String,
    pub service: String,
    pub node_id: String,
    pub schema_version: i32,
    pub data_dir: String,
    pub insecure_auth: bool,
}

/// A fetched payload plus the metadata that identifies exactly which revision it is.
#[derive(Debug, Clone)]
pub struct Payload {
    pub artifact_id: String,
    pub type_id: String,
    pub instance: String,
    pub label: Option<String>,
    pub revision_id: String,
    pub revision_number: u32,
    pub encoding: Encoding,
    pub content_hash: String,
    pub byte_size: u64,
    pub created_at: i64,
    pub seed_batch: Option<String>,
    pub bytes: Vec<u8>,
}

impl Payload {
    /// Interpret the payload as UTF-8, for `Encoding::Json` / `Encoding::Text`.
    pub fn as_str(&self) -> std::result::Result<&str, std::str::Utf8Error> {
        std::str::from_utf8(&self.bytes)
    }

    pub fn as_json(&self) -> Result<serde_json::Value> {
        Ok(serde_json::from_slice(&self.bytes)?)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryFile {
    pub endpoint: String,
    pub instance_id: String,
    pub pid: u32,
    pub node_id: String,
    pub api_version: u32,
}

/// Default location of the hub's store discovery file.
pub fn discovery_path() -> Result<PathBuf> {
    let local = dirs::data_local_dir().ok_or_else(|| {
        ClientError::NotConnected("unable to locate the local app data directory".into())
    })?;
    Ok(local.join("APRO").join("store.json"))
}

pub fn read_discovery() -> Result<Option<DiscoveryFile>> {
    let path = discovery_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&raw).ok())
}

#[derive(Debug, Clone)]
pub struct ClientConfig {
    pub endpoint: String,
    pub app_slug: String,
    /// Exchanged once for a session token at connect time.
    pub launch_ticket: Option<String>,
    /// Used directly when already present.
    pub session_token: Option<String>,
    pub timeout: Duration,
}

impl ClientConfig {
    pub fn new(endpoint: impl Into<String>, app_slug: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
            app_slug: app_slug.into(),
            launch_ticket: None,
            session_token: None,
            timeout: Duration::from_secs(30),
        }
    }

    pub fn with_launch_ticket(mut self, ticket: impl Into<String>) -> Self {
        self.launch_ticket = Some(ticket.into());
        self
    }

    pub fn with_session_token(mut self, token: impl Into<String>) -> Self {
        self.session_token = Some(token.into());
        self
    }
}

/// The transport-independent surface. Implemented by [`HttpStoreClient`] today and by a
/// cloud transport later; apps code against this and never against HTTP (DESIGN.md D7).
pub trait AproStoreClient {
    fn health(&self) -> Result<HealthInfo>;

    fn declare_interface(&self, interface: &AppInterface) -> Result<()>;

    /// Publish bytes. Appends an immutable revision; never overwrites.
    fn push(
        &self,
        type_id: &TypeId,
        instance: &str,
        encoding: Encoding,
        payload: &[u8],
    ) -> Result<RevisionHandle>;

    /// Labeled variant of [`AproStoreClient::push`].
    fn push_labeled(
        &self,
        type_id: &TypeId,
        instance: &str,
        encoding: Encoding,
        label: Option<&str>,
        payload: &[u8],
    ) -> Result<RevisionHandle>;

    /// Fetch a revision. `None` also covers "pinned but never published yet".
    fn pull(&self, type_id: &TypeId, instance: &str, selector: Selector) -> Result<Option<Payload>>;

    fn list_artifacts(&self, filter: &ArtifactFilter) -> Result<Vec<ArtifactSummary>>;

    fn list_revisions(&self, type_id: &TypeId, instance: &str) -> Result<Vec<RevisionSummary>>;

    /// Declare a dependency. Creates the artifact as a placeholder if the producer has
    /// not published yet.
    fn register_edge(&self, request: &EdgeRequest) -> Result<EdgeSummary>;

    fn list_edges(&self, filter: &EdgeFilter) -> Result<Vec<EdgeSummary>>;

    /// Mark a dependency satisfied, defaulting to the artifact's current revision.
    fn satisfy_edge(&self, edge_id: &str, revision_number: Option<u32>) -> Result<EdgeSummary>;

    /// Notification-only change feed. Pull the payload separately when ready.
    fn events(&self, since: i64) -> Result<Vec<EventRecord>>;

    fn stats(&self) -> Result<StoreStats>;

    // -- wiring -------------------------------------------------------------

    /// Subscribe to a *type* rather than an instance. Concrete edges are materialised
    /// from it, one per existing instance, and extended as new instances appear.
    fn create_subscription(&self, request: &SubscriptionRequest) -> Result<SubscriptionSummary>;

    fn list_subscriptions(&self) -> Result<Vec<SubscriptionSummary>>;

    /// Remove a subscription and every edge it materialised. Returns edges removed.
    fn delete_subscription(&self, subscription_id: &str) -> Result<u64>;

    /// Back-fill edges for instances published since the subscription was created.
    /// Idempotent, and it never resets an existing edge's freshness.
    fn materialize_subscriptions(&self) -> Result<u64>;

    /// Remove one dependency edge.
    ///
    /// An edge materialised by a subscription reappears on the next materialize, so
    /// delete the subscription to un-wire durably.
    fn delete_edge(&self, edge_id: &str) -> Result<()>;

    /// The read log. Deliberately separate from the change feed.
    fn access_log(&self, since: i64) -> Result<Vec<AccessRecord>>;
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|index| args.get(index + 1))
        .map(|value| value.trim().trim_matches('"').to_string())
        .filter(|value| !value.is_empty())
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct HttpStoreClient {
    base_url: String,
    app_slug: String,
    token: String,
    insecure: bool,
    http: reqwest::blocking::Client,
}

impl std::fmt::Debug for HttpStoreClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the token.
        f.debug_struct("HttpStoreClient")
            .field("base_url", &self.base_url)
            .field("app_slug", &self.app_slug)
            .field("insecure", &self.insecure)
            .finish()
    }
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Deserialize)]
struct ErrorBody {
    code: String,
    message: String,
}

impl HttpStoreClient {
    /// Build a client from the hub's launch arguments.
    ///
    /// Precedence for the endpoint: `--apro-store-endpoint`, then the on-disk discovery
    /// file. Returns `Ok(None)` when no credential is present, which means "not launched
    /// by APRO Works" أ¢â‚¬â€‌ the app should degrade to local-only rather than fail.
    pub fn from_launch_args(args: &[String]) -> Result<Option<Self>> {
        let ticket = flag_value(args, "--apro-launch-token");
        let session = flag_value(args, "--apro-store-token");
        if ticket.is_none() && session.is_none() {
            return Ok(None);
        }

        let app_slug = flag_value(args, "--apro-product-slug").unwrap_or_else(|| "apro-unknown".into());

        let endpoint = match flag_value(args, "--apro-store-endpoint") {
            Some(endpoint) => endpoint,
            None => match read_discovery()? {
                Some(discovery) => discovery.endpoint,
                None => {
                    return Err(ClientError::NotConnected(
                        "a launch token was supplied but no store endpoint could be found \
                         (no --apro-store-endpoint and no discovery file)"
                            .into(),
                    ))
                }
            },
        };

        let mut config = ClientConfig::new(endpoint, app_slug);
        config.launch_ticket = ticket;
        config.session_token = session;
        Self::connect(config).map(Some)
    }

    pub fn from_launch_environment() -> Result<Option<Self>> {
        let args: Vec<String> = std::env::args().collect();
        Self::from_launch_args(&args)
    }

    /// Connect, exchanging a launch ticket for a session token when needed.
    pub fn connect(config: ClientConfig) -> Result<Self> {
        let http = reqwest::blocking::Client::builder()
            .timeout(config.timeout)
            .build()
            .map_err(|err| ClientError::Transport(err.to_string()))?;

        let base_url = config.endpoint.trim_end_matches('/').to_string();

        let (token, insecure) = if let Some(token) = config.session_token {
            (token, false)
        } else if let Some(ticket) = config.launch_ticket {
            let response = http
                .post(format!("{base_url}/v1/session"))
                .bearer_auth(&ticket)
                .send()
                .map_err(|err| ClientError::Transport(err.to_string()))?;
            if !response.status().is_success() {
                return Err(decode_error(response));
            }
            let info: serde_json::Value = response
                .json()
                .map_err(|err| ClientError::Transport(err.to_string()))?;
            let token = info
                .get("session_token")
                .and_then(|value| value.as_str())
                .ok_or_else(|| {
                    ClientError::Transport("session response did not contain a token".into())
                })?
                .to_string();
            (token, false)
        } else {
            return Err(ClientError::NotConnected(
                "no launch ticket and no session token".into(),
            ));
        };

        let client = Self {
            base_url,
            app_slug: config.app_slug,
            token,
            insecure,
            http,
        };

        // If the server is in insecure mode any token is accepted, so record that.
        let insecure = client
            .health()
            .map(|health| health.insecure_auth)
            .unwrap_or(insecure);

        Ok(Self { insecure, ..client })
    }

    pub fn endpoint(&self) -> &str {
        &self.base_url
    }

    pub fn app_slug(&self) -> &str {
        &self.app_slug
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::blocking::RequestBuilder {
        self.http
            .request(method, format!("{}{}", self.base_url, path))
            .bearer_auth(&self.token)
            .header("x-apro-app", &self.app_slug)
    }

    fn decode<T: serde::de::DeserializeOwned>(
        response: reqwest::blocking::Response,
    ) -> Result<T> {
        if !response.status().is_success() {
            return Err(decode_error(response));
        }
        response
            .json::<T>()
            .map_err(|err| ClientError::Transport(err.to_string()))
    }

    /// Refresh the session in place.
    pub fn refresh_session(&mut self) -> Result<()> {
        let response = self
            .http
            .post(format!("{}/v1/session/refresh", self.base_url))
            .bearer_auth(&self.token)
            .send()
            .map_err(|err| ClientError::Transport(err.to_string()))?;
        let info: serde_json::Value = Self::decode(response)?;
        if let Some(token) = info.get("session_token").and_then(|v| v.as_str()) {
            self.token = token.to_string();
        }
        Ok(())
    }
}

fn decode_error(response: reqwest::blocking::Response) -> ClientError {
    let status = response.status().as_u16();
    let body = response.text().unwrap_or_default();
    match serde_json::from_str::<ErrorEnvelope>(&body) {
        Ok(envelope) => ClientError::Api {
            status,
            code: envelope.error.code,
            message: envelope.error.message,
        },
        Err(_) => ClientError::Api {
            status,
            code: "unknown_error".into(),
            message: if body.is_empty() {
                "the store returned an empty error body".into()
            } else {
                body
            },
        },
    }
}

fn header_string(response: &reqwest::blocking::Response, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string())
}

impl AproStoreClient for HttpStoreClient {
    fn health(&self) -> Result<HealthInfo> {
        let response = self
            .http
            .get(format!("{}/v1/health", self.base_url))
            .send()
            .map_err(|err| ClientError::Transport(err.to_string()))?;
        Self::decode(response)
    }

    fn declare_interface(&self, interface: &AppInterface) -> Result<()> {
        let response = self
            .request(reqwest::Method::POST, "/v1/declare")
            .json(interface)
            .send()
            .map_err(|err| ClientError::Transport(err.to_string()))?;
        let _: serde_json::Value = Self::decode(response)?;
        Ok(())
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
        let mut query = vec![
            ("type_id", type_id.as_str()),
            ("instance", instance),
            ("encoding", encoding.as_str()),
        ];
        if let Some(label) = label {
            query.push(("label", label));
        }

        let response = self
            .request(reqwest::Method::POST, "/v1/push")
            .query(&query)
            .header("content-type", "application/octet-stream")
            .body(payload.to_vec())
            .send()
            .map_err(|err| ClientError::Transport(err.to_string()))?;
        Self::decode(response)
    }

    fn pull(&self, type_id: &TypeId, instance: &str, selector: Selector) -> Result<Option<Payload>> {
        let mut query: Vec<(String, String)> = vec![
            ("type_id".into(), type_id.as_str().to_string()),
            ("instance".into(), instance.to_string()),
        ];
        match selector {
            Selector::Latest => query.push(("selector".into(), "latest".into())),
            Selector::Number(number) => {
                query.push(("selector".into(), "number".into()));
                query.push(("number".into(), number.to_string()));
            }
        }

        let response = self
            .request(reqwest::Method::GET, "/v1/pull")
            .query(&query)
            .send()
            .map_err(|err| ClientError::Transport(err.to_string()))?;

        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(decode_error(response));
        }

        let encoding = header_string(&response, "x-apro-encoding")
            .and_then(|raw| Encoding::parse(&raw).ok())
            .unwrap_or(Encoding::Blob);
        let payload = Payload {
            artifact_id: header_string(&response, "x-apro-artifact-id").unwrap_or_default(),
            type_id: header_string(&response, "x-apro-type-id").unwrap_or_default(),
            instance: header_string(&response, "x-apro-instance").unwrap_or_default(),
            label: header_string(&response, "x-apro-label"),
            revision_id: header_string(&response, "x-apro-revision-id").unwrap_or_default(),
            revision_number: header_string(&response, "x-apro-revision-number")
                .and_then(|raw| raw.parse().ok())
                .unwrap_or(0),
            encoding,
            content_hash: header_string(&response, "x-apro-content-hash").unwrap_or_default(),
            byte_size: header_string(&response, "x-apro-byte-size")
                .and_then(|raw| raw.parse().ok())
                .unwrap_or(0),
            created_at: header_string(&response, "x-apro-created-at")
                .and_then(|raw| raw.parse().ok())
                .unwrap_or(0),
            seed_batch: header_string(&response, "x-apro-seed-batch"),
            bytes: response
                .bytes()
                .map_err(|err| ClientError::Transport(err.to_string()))?
                .to_vec(),
        };
        Ok(Some(payload))
    }

    fn list_artifacts(&self, filter: &ArtifactFilter) -> Result<Vec<ArtifactSummary>> {
        let mut query: Vec<(String, String)> = Vec::new();
        if let Some(type_id) = &filter.type_id {
            query.push(("type_id".into(), type_id.clone()));
        }
        if let Some(owner_app) = &filter.owner_app {
            query.push(("owner_app".into(), owner_app.clone()));
        }
        if let Some(instance) = &filter.instance {
            query.push(("instance".into(), instance.clone()));
        }
        if filter.include_demo {
            query.push(("include_demo".into(), "true".into()));
        }

        let response = self
            .request(reqwest::Method::GET, "/v1/artifacts")
            .query(&query)
            .send()
            .map_err(|err| ClientError::Transport(err.to_string()))?;
        Self::decode(response)
    }

    fn list_revisions(&self, type_id: &TypeId, instance: &str) -> Result<Vec<RevisionSummary>> {
        let response = self
            .request(reqwest::Method::GET, "/v1/revisions")
            .query(&[
                ("type_id", type_id.as_str()),
                ("instance", instance),
            ])
            .send()
            .map_err(|err| ClientError::Transport(err.to_string()))?;
        Self::decode(response)
    }

    fn register_edge(&self, request: &EdgeRequest) -> Result<EdgeSummary> {
        let response = self
            .request(reqwest::Method::POST, "/v1/edges")
            .json(request)
            .send()
            .map_err(|err| ClientError::Transport(err.to_string()))?;
        Self::decode(response)
    }

    fn list_edges(&self, filter: &EdgeFilter) -> Result<Vec<EdgeSummary>> {
        let mut query: Vec<(String, String)> = Vec::new();
        if let Some(consumer_app) = &filter.consumer_app {
            query.push(("consumer_app".into(), consumer_app.clone()));
        }
        if let Some(artifact_id) = &filter.artifact_id {
            query.push(("artifact_id".into(), artifact_id.clone()));
        }
        if let Some(stale) = filter.stale {
            query.push(("stale".into(), stale.to_string()));
        }

        let response = self
            .request(reqwest::Method::GET, "/v1/edges")
            .query(&query)
            .send()
            .map_err(|err| ClientError::Transport(err.to_string()))?;
        Self::decode(response)
    }

    fn satisfy_edge(&self, edge_id: &str, revision_number: Option<u32>) -> Result<EdgeSummary> {
        let mut query: Vec<(String, String)> = Vec::new();
        if let Some(number) = revision_number {
            query.push(("revision_number".into(), number.to_string()));
        }
        let response = self
            .request(
                reqwest::Method::POST,
                &format!("/v1/edges/{edge_id}/satisfy"),
            )
            .query(&query)
            .send()
            .map_err(|err| ClientError::Transport(err.to_string()))?;
        Self::decode(response)
    }

    fn events(&self, since: i64) -> Result<Vec<EventRecord>> {
        let response = self
            .request(reqwest::Method::GET, "/v1/events")
            .query(&[("since", since.to_string())])
            .send()
            .map_err(|err| ClientError::Transport(err.to_string()))?;
        Self::decode(response)
    }

    fn create_subscription(&self, request: &SubscriptionRequest) -> Result<SubscriptionSummary> {
        let response = self
            .request(reqwest::Method::POST, "/v1/subscriptions")
            .json(request)
            .send()
            .map_err(|err| ClientError::Transport(err.to_string()))?;
        Self::decode(response)
    }

    fn list_subscriptions(&self) -> Result<Vec<SubscriptionSummary>> {
        let response = self
            .request(reqwest::Method::GET, "/v1/subscriptions")
            .send()
            .map_err(|err| ClientError::Transport(err.to_string()))?;
        Self::decode(response)
    }

    fn delete_subscription(&self, subscription_id: &str) -> Result<u64> {
        let response = self
            .request(
                reqwest::Method::DELETE,
                &format!("/v1/subscriptions/{subscription_id}"),
            )
            .send()
            .map_err(|err| ClientError::Transport(err.to_string()))?;
        let body: serde_json::Value = Self::decode(response)?;
        Ok(body
            .get("removed_edges")
            .and_then(|value| value.as_u64())
            .unwrap_or(0))
    }

    fn materialize_subscriptions(&self) -> Result<u64> {
        let response = self
            .request(reqwest::Method::POST, "/v1/subscriptions/materialize")
            .send()
            .map_err(|err| ClientError::Transport(err.to_string()))?;
        let body: serde_json::Value = Self::decode(response)?;
        Ok(body
            .get("created_edges")
            .and_then(|value| value.as_u64())
            .unwrap_or(0))
    }

    fn delete_edge(&self, edge_id: &str) -> Result<()> {
        let response = self
            .request(reqwest::Method::DELETE, &format!("/v1/edges/{edge_id}"))
            .send()
            .map_err(|err| ClientError::Transport(err.to_string()))?;
        if !response.status().is_success() {
            return Err(decode_error(response));
        }
        Ok(())
    }

    fn access_log(&self, since: i64) -> Result<Vec<AccessRecord>> {
        let response = self
            .request(reqwest::Method::GET, "/v1/access")
            .query(&[("since", since.to_string())])
            .send()
            .map_err(|err| ClientError::Transport(err.to_string()))?;
        Self::decode(response)
    }

    fn stats(&self) -> Result<StoreStats> {
        let response = self
            .request(reqwest::Method::GET, "/v1/stats")
            .send()
            .map_err(|err| ClientError::Transport(err.to_string()))?;
        Self::decode(response)
    }
}

impl HttpStoreClient {
    /// Convenience for the hub UI and tests: read the type registry.
    pub fn registered_types(&self) -> Result<Vec<String>> {
        let response = self
            .request(reqwest::Method::GET, "/v1/types")
            .send()
            .map_err(|err| ClientError::Transport(err.to_string()))?;
        Self::decode(response)
    }
}

// ---------------------------------------------------------------------------
// In-process transport (hub internals, tests, offline tools)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_launch_flags() {
        let args: Vec<String> = [
            "app.exe",
            "--apro-product-slug",
            "hexadof",
            "--apro-launch-token",
            "hexadof-abc123",
            "--apro-store-endpoint",
            "http://127.0.0.1:5555",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();

        assert_eq!(flag_value(&args, "--apro-product-slug").unwrap(), "hexadof");
        assert_eq!(
            flag_value(&args, "--apro-store-endpoint").unwrap(),
            "http://127.0.0.1:5555"
        );
        assert_eq!(flag_value(&args, "--apro-store-token"), None);
    }

    #[test]
    fn no_credentials_means_not_launched_by_hub() {
        let args: Vec<String> = vec!["app.exe".into()];
        assert!(HttpStoreClient::from_launch_args(&args).unwrap().is_none());
    }
}
