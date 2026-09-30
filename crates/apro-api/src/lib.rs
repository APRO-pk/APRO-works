//! Loopback HTTP surface for the orchestration store.
//!
//! The API is the *same contract* that a future remote service will expose, so moving
//! to the cloud is a base-URL and auth change rather than a rewrite (DESIGN.md D7).
//!
//! Payloads are always raw bytes. They are returned verbatim and never transcoded
//! (DESIGN.md D12).

pub mod auth;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Extension, Json, Router};
use bytes::Bytes;
use serde::Deserialize;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use apro_store::{
    AccessRecord, ArtifactFilter, ArtifactSummary, ConsumeDecl, DeclaredType, EdgeFilter,
    EdgeRequest, EdgeSummary, Encoding, EventRecord, FetchedRevision, Mode, PushRequest,
    RevisionHandle, RevisionSummary, Selector, Store, StoreError, StoreStats, SubscriptionRequest,
    SubscriptionSummary, TypeId,
};

pub use auth::{AuthRegistry, ResolvedAuth, SessionInfo};

/// Body-size ceiling. Raised well above axum's 2 MiB default because CAD and mesh
/// payloads are legitimately large. Requests above this are rejected with 413.
pub const DEFAULT_MAX_PAYLOAD_BYTES: usize = 512 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub bind: IpAddr,
    /// 0 lets the OS pick a free port, which is what the hub uses.
    pub port: u16,
    pub max_payload_bytes: usize,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 0,
            max_payload_bytes: DEFAULT_MAX_PAYLOAD_BYTES,
        }
    }
}

#[derive(Clone)]
pub struct ApiState {
    pub store: Store,
    pub auth: AuthRegistry,
    pub max_payload_bytes: usize,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request", message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", message)
    }

    pub fn not_found(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            message,
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({
                "error": { "code": self.code, "message": self.message }
            })),
        )
            .into_response()
    }
}

impl From<apro_store::TypeError> for ApiError {
    /// The shared value types validate before any store call, so their errors surface
    /// directly in handlers via `?`. `apro_store` re-exports them from `apro-types`.
    fn from(err: apro_store::TypeError) -> Self {
        ApiError::new(StatusCode::BAD_REQUEST, err.code(), err.to_string())
    }
}

impl From<StoreError> for ApiError {
    fn from(err: StoreError) -> Self {
        let status = match err.kind() {
            apro_store::ErrorKind::NotFound => StatusCode::NOT_FOUND,
            apro_store::ErrorKind::Forbidden => StatusCode::FORBIDDEN,
            apro_store::ErrorKind::Invalid => StatusCode::BAD_REQUEST,
            apro_store::ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        ApiError {
            status,
            code: err.code().to_string(),
            message: err.to_string(),
        }
    }
}

/// Run blocking store work off the async runtime. Every store call does SQLite and
/// possibly filesystem I/O, so none of it belongs on an async worker thread.
async fn blocking<T, F>(f: F) -> Result<T, ApiError>
where
    F: FnOnce() -> Result<T, StoreError> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(err)) => Err(ApiError::from(err)),
        Err(join) => Err(ApiError::internal(format!(
            "background store task failed: {join}"
        ))),
    }
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, value) = raw.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn client_app_header(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-apro-app")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

async fn auth_middleware(
    State(state): State<ApiState>,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let token = bearer_token(request.headers())
        .ok_or_else(|| ApiError::unauthorized(auth::AuthError::MissingCredentials.message()))?;
    let claimed = client_app_header(request.headers());

    let resolved = state
        .auth
        .validate(&token, claimed.as_deref())
        .ok_or_else(|| ApiError::unauthorized(auth::AuthError::InvalidSession.message()))?;

    // A session is bound to exactly one app. Refuse a mismatched claimed identity
    // rather than silently attributing writes to the wrong app.
    if !resolved.insecure {
        if let Some(claimed) = claimed {
            if claimed != resolved.app_slug {
                return Err(ApiError::forbidden(format!(
                    "x-apro-app {claimed:?} does not match the session's app {:?}",
                    resolved.app_slug
                )));
            }
        }
    }

    request.extensions_mut().insert(resolved);
    Ok(next.run(request).await)
}

// ---------------------------------------------------------------------------
// Public handlers
// ---------------------------------------------------------------------------

async fn health(State(state): State<ApiState>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "service": "apro-store",
        "node_id": state.store.node_id(),
        "schema_version": apro_store::schema::SCHEMA_VERSION,
        "data_dir": state.store.data_dir().to_string_lossy(),
        "insecure_auth": state.auth.is_insecure(),
    }))
}

async fn session_exchange(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<SessionInfo>, ApiError> {
    let ticket = bearer_token(&headers)
        .ok_or_else(|| ApiError::unauthorized(auth::AuthError::MissingCredentials.message()))?;
    let info = state
        .auth
        .exchange_ticket(&ticket)
        .map_err(|err| ApiError::unauthorized(err.message()))?;
    Ok(Json(info))
}

async fn session_refresh(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<SessionInfo>, ApiError> {
    let token = bearer_token(&headers)
        .ok_or_else(|| ApiError::unauthorized(auth::AuthError::MissingCredentials.message()))?;
    let info = state
        .auth
        .refresh(&token)
        .map_err(|err| ApiError::unauthorized(err.message()))?;
    Ok(Json(info))
}

// ---------------------------------------------------------------------------
// Protected handlers
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct DeclareBody {
    app: String,
    #[serde(default)]
    publishes: Vec<TypeId>,
    #[serde(default)]
    consumes: Vec<ConsumeBody>,
}

#[derive(Deserialize)]
struct ConsumeBody {
    type_id: TypeId,
    #[serde(default)]
    default_mode: Option<String>,
}

async fn declare(
    State(state): State<ApiState>,
    Extension(auth): Extension<ResolvedAuth>,
    Json(body): Json<DeclareBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !auth.insecure && body.app != auth.app_slug {
        return Err(ApiError::forbidden(format!(
            "cannot declare an interface for {:?}; the session belongs to {:?}",
            body.app, auth.app_slug
        )));
    }

    let mut consumes = Vec::new();
    for entry in body.consumes {
        let mode = match entry.default_mode.as_deref() {
            Some(raw) => Mode::parse(raw)?,
            None => Mode::Pinned,
        };
        consumes.push(ConsumeDecl {
            type_id: entry.type_id,
            default_mode: mode,
        });
    }

    let interface = apro_store::AppInterface {
        app: body.app,
        publishes: body.publishes,
        consumes,
    };
    let store = state.store.clone();
    blocking(move || store.declare_interface(&interface, "runtime")).await?;
    Ok(Json(json!({ "declared": true })))
}

#[derive(Deserialize)]
struct ArtifactQuery {
    #[serde(default)]
    type_id: Option<String>,
    #[serde(default)]
    owner_app: Option<String>,
    #[serde(default)]
    instance: Option<String>,
    #[serde(default)]
    include_demo: bool,
}

async fn list_artifacts(
    State(state): State<ApiState>,
    Extension(_auth): Extension<ResolvedAuth>,
    Query(query): Query<ArtifactQuery>,
) -> Result<Json<Vec<ArtifactSummary>>, ApiError> {
    let filter = ArtifactFilter {
        type_id: query.type_id,
        owner_app: query.owner_app,
        instance: query.instance,
        include_demo: query.include_demo,
    };
    let store = state.store.clone();
    Ok(Json(blocking(move || store.list_artifacts(&filter)).await?))
}

async fn get_artifact(
    State(state): State<ApiState>,
    Extension(_auth): Extension<ResolvedAuth>,
    Path(artifact_id): Path<String>,
) -> Result<Json<ArtifactSummary>, ApiError> {
    let store = state.store.clone();
    let found = blocking(move || store.get_artifact(&artifact_id)).await?;
    found.map(Json).ok_or_else(|| {
        ApiError::not_found("artifact_not_found", "no artifact with that id")
    })
}

#[derive(Deserialize)]
struct PushQuery {
    type_id: String,
    instance: String,
    #[serde(default)]
    encoding: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    created_by: Option<String>,
}

async fn push(
    State(state): State<ApiState>,
    Extension(auth): Extension<ResolvedAuth>,
    Query(query): Query<PushQuery>,
    body: Bytes,
) -> Result<Json<RevisionHandle>, ApiError> {
    let type_id = TypeId::parse(&query.type_id)?;
    let encoding = match query.encoding.as_deref() {
        Some(raw) => Encoding::parse(raw)?,
        None => Encoding::Json,
    };

    let request = PushRequest {
        type_id,
        instance: query.instance,
        encoding,
        label: query.label,
        actor_app: auth.app_slug,
        created_by: query.created_by,
        seed_batch: None,
        payload: body.to_vec(),
    };

    let store = state.store.clone();
    Ok(Json(blocking(move || store.push(request)).await?))
}

#[derive(Deserialize)]
struct PullQuery {
    type_id: String,
    instance: String,
    #[serde(default)]
    selector: Option<String>,
    #[serde(default)]
    number: Option<u32>,
}

async fn pull(
    State(state): State<ApiState>,
    Extension(auth): Extension<ResolvedAuth>,
    Query(query): Query<PullQuery>,
) -> Result<Response, ApiError> {
    let type_id = TypeId::parse(&query.type_id)?;
    let selector = match query.selector.as_deref() {
        None | Some("latest") => Selector::Latest,
        Some("number") => Selector::Number(query.number.ok_or_else(|| {
            ApiError::bad_request("selector=number requires the ?number= parameter")
        })?),
        Some(other) => {
            return Err(ApiError::bad_request(format!(
                "unknown selector {other:?}; expected \"latest\" or \"number\""
            )))
        }
    };

    let describe = format!("{}/{}", type_id, query.instance);
    let store = state.store.clone();
    let instance = query.instance.clone();
    let identity = type_id.as_str().to_string();
    let actor = auth.app_slug;

    let fetched: Option<FetchedRevision> = blocking(move || {
        let result = store.pull(&type_id, &instance, selector)?;

        // Record the read here, not in the store's change feed. A miss is recorded too:
        // it is what distinguishes "the consumer never asked" from "it asked before
        // anything existed". Logging must never fail a read, hence the ignored result.
        let (revision_id, revision_number, outcome) = match &result {
            Some(fetched) => (
                Some(fetched.revision.revision_id.clone()),
                Some(fetched.revision.revision_number),
                "hit",
            ),
            None => (None, None, "miss"),
        };
        let _ = store.record_access(
            &actor,
            &identity,
            &instance,
            revision_id.as_deref(),
            revision_number,
            outcome,
        );

        Ok(result)
    })
    .await?;

    let Some(fetched) = fetched else {
        return Err(ApiError::not_found(
            "artifact_not_found",
            format!("no revision available for {describe}"),
        ));
    };

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header("x-apro-artifact-id", fetched.artifact.artifact_id.clone())
        .header("x-apro-type-id", fetched.artifact.type_id.clone())
        .header("x-apro-instance", fetched.artifact.instance.clone())
        .header("x-apro-revision-id", fetched.revision.revision_id.clone())
        .header(
            "x-apro-revision-number",
            fetched.revision.revision_number.to_string(),
        )
        .header("x-apro-encoding", fetched.revision.encoding.as_str())
        .header("x-apro-content-hash", fetched.revision.content_hash.clone())
        .header("x-apro-byte-size", fetched.revision.byte_size.to_string())
        .header("x-apro-created-at", fetched.revision.created_at.to_string());

    if let Some(label) = &fetched.artifact.label {
        builder = builder.header("x-apro-label", label.clone());
    }
    if let Some(batch) = &fetched.artifact.seed_batch {
        builder = builder.header("x-apro-seed-batch", batch.clone());
    }

    builder
        .body(Body::from(fetched.payload))
        .map_err(|err| ApiError::internal(format!("failed to build payload response: {err}")))
}

#[derive(Deserialize)]
struct RevisionsQuery {
    type_id: String,
    instance: String,
}

async fn list_revisions(
    State(state): State<ApiState>,
    Extension(_auth): Extension<ResolvedAuth>,
    Query(query): Query<RevisionsQuery>,
) -> Result<Json<Vec<RevisionSummary>>, ApiError> {
    let type_id = TypeId::parse(&query.type_id)?;
    let store = state.store.clone();
    Ok(Json(
        blocking(move || store.list_revisions(&type_id, &query.instance)).await?,
    ))
}

#[derive(Deserialize)]
struct EdgeQuery {
    #[serde(default)]
    consumer_app: Option<String>,
    #[serde(default)]
    artifact_id: Option<String>,
    #[serde(default)]
    stale: Option<bool>,
}

async fn list_edges(
    State(state): State<ApiState>,
    Extension(_auth): Extension<ResolvedAuth>,
    Query(query): Query<EdgeQuery>,
) -> Result<Json<Vec<EdgeSummary>>, ApiError> {
    let filter = EdgeFilter {
        consumer_app: query.consumer_app,
        artifact_id: query.artifact_id,
        stale: query.stale,
    };
    let store = state.store.clone();
    Ok(Json(blocking(move || store.list_edges(&filter)).await?))
}

async fn create_edge(
    State(state): State<ApiState>,
    Extension(auth): Extension<ResolvedAuth>,
    Json(mut request): Json<EdgeRequest>,
) -> Result<Json<EdgeSummary>, ApiError> {
    // The session decides who the consumer is, not the request body.
    if !auth.insecure {
        request.consumer_app = auth.app_slug.clone();
    }
    let store = state.store.clone();
    Ok(Json(blocking(move || store.register_edge(request)).await?))
}

#[derive(Deserialize)]
struct SatisfyQuery {
    #[serde(default)]
    revision_number: Option<u32>,
}

async fn satisfy_edge(
    State(state): State<ApiState>,
    Extension(_auth): Extension<ResolvedAuth>,
    Path(edge_id): Path<String>,
    Query(query): Query<SatisfyQuery>,
) -> Result<Json<EdgeSummary>, ApiError> {
    let store = state.store.clone();
    Ok(Json(
        blocking(move || store.satisfy_edge(&edge_id, query.revision_number)).await?,
    ))
}

#[derive(Deserialize)]
struct EventsQuery {
    #[serde(default)]
    since: Option<i64>,
    #[serde(default)]
    limit: Option<u32>,
}

async fn events(
    State(state): State<ApiState>,
    Extension(_auth): Extension<ResolvedAuth>,
    Query(query): Query<EventsQuery>,
) -> Result<Json<Vec<EventRecord>>, ApiError> {
    let since = query.since.unwrap_or(0);
    let limit = query.limit.unwrap_or(200).min(2000);
    let store = state.store.clone();
    Ok(Json(blocking(move || store.events(since, limit)).await?))
}

// ---------------------------------------------------------------------------
// Subscriptions — the type-level wires the workflow canvas edits
// ---------------------------------------------------------------------------

async fn list_subscriptions(
    State(state): State<ApiState>,
    Extension(_auth): Extension<ResolvedAuth>,
) -> Result<Json<Vec<SubscriptionSummary>>, ApiError> {
    let store = state.store.clone();
    Ok(Json(blocking(move || store.list_subscriptions()).await?))
}

async fn create_subscription(
    State(state): State<ApiState>,
    Extension(auth): Extension<ResolvedAuth>,
    Json(mut request): Json<SubscriptionRequest>,
) -> Result<Json<SubscriptionSummary>, ApiError> {
    // As with edges, the session decides who subscribes.
    if !auth.insecure {
        request.consumer_app = auth.app_slug.clone();
    }
    let store = state.store.clone();
    Ok(Json(
        blocking(move || store.create_subscription(request)).await?,
    ))
}

async fn delete_subscription(
    State(state): State<ApiState>,
    Extension(_auth): Extension<ResolvedAuth>,
    Path(subscription_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store.clone();
    let removed = blocking(move || store.delete_subscription(&subscription_id)).await?;
    Ok(Json(json!({ "removed_edges": removed })))
}

/// Back-fill edges for instances published since the subscription was created.
async fn materialize_subscriptions(
    State(state): State<ApiState>,
    Extension(_auth): Extension<ResolvedAuth>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.store.clone();
    let created = blocking(move || store.materialize_subscriptions()).await?;
    Ok(Json(json!({ "created_edges": created })))
}

async fn delete_edge(
    State(state): State<ApiState>,
    Extension(_auth): Extension<ResolvedAuth>,
    Path(edge_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let store = state.store.clone();
    blocking(move || store.delete_edge(&edge_id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct AccessQuery {
    #[serde(default)]
    since: Option<i64>,
    #[serde(default)]
    limit: Option<u32>,
}

/// The read log. Separate from `/v1/events` so consumers can poll the change feed
/// without being spammed by other apps' reads.
async fn access_log(
    State(state): State<ApiState>,
    Extension(_auth): Extension<ResolvedAuth>,
    Query(query): Query<AccessQuery>,
) -> Result<Json<Vec<AccessRecord>>, ApiError> {
    let since = query.since.unwrap_or(0);
    let limit = query.limit.unwrap_or(200).min(2000);
    let store = state.store.clone();
    Ok(Json(
        blocking(move || store.access_log(since, limit)).await?,
    ))
}

async fn stats(
    State(state): State<ApiState>,
    Extension(_auth): Extension<ResolvedAuth>,
) -> Result<Json<StoreStats>, ApiError> {
    let store = state.store.clone();
    Ok(Json(blocking(move || store.stats()).await?))
}

async fn interfaces(
    State(state): State<ApiState>,
    Extension(_auth): Extension<ResolvedAuth>,
) -> Result<Json<Vec<DeclaredType>>, ApiError> {
    let store = state.store.clone();
    Ok(Json(blocking(move || store.interfaces()).await?))
}

async fn types(
    State(state): State<ApiState>,
    Extension(_auth): Extension<ResolvedAuth>,
) -> Result<Json<Vec<String>>, ApiError> {
    let store = state.store.clone();
    Ok(Json(blocking(move || store.registered_types()).await?))
}

// ---------------------------------------------------------------------------
// Router and lifecycle
// ---------------------------------------------------------------------------

pub fn router(state: ApiState) -> Router {
    let max_payload_bytes = state.max_payload_bytes;

    let protected = Router::new()
        .route("/v1/declare", post(declare))
        .route("/v1/artifacts", get(list_artifacts))
        .route("/v1/artifacts/{artifact_id}", get(get_artifact))
        .route("/v1/push", post(push))
        .route("/v1/pull", get(pull))
        .route("/v1/revisions", get(list_revisions))
        .route("/v1/edges", get(list_edges).post(create_edge))
        .route("/v1/edges/{edge_id}", delete(delete_edge))
        .route("/v1/edges/{edge_id}/satisfy", post(satisfy_edge))
        .route(
            "/v1/subscriptions",
            get(list_subscriptions).post(create_subscription),
        )
        .route(
            "/v1/subscriptions/{subscription_id}",
            delete(delete_subscription),
        )
        .route(
            "/v1/subscriptions/materialize",
            post(materialize_subscriptions),
        )
        .route("/v1/access", get(access_log))
        .route("/v1/events", get(events))
        .route("/v1/stats", get(stats))
        .route("/v1/interfaces", get(interfaces))
        .route("/v1/types", get(types))
        .layer(middleware::from_fn_with_state(state.clone(), auth_middleware));

    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/session", post(session_exchange))
        .route("/v1/session/refresh", post(session_refresh))
        .merge(protected)
        .layer(DefaultBodyLimit::max(max_payload_bytes))
        .with_state(state)
}

/// A running API server. Dropping it without calling [`RunningServer::shutdown`] leaves
/// the server task running until the runtime shuts down.
pub struct RunningServer {
    pub endpoint: String,
    pub local_addr: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    handle: JoinHandle<()>,
}

impl RunningServer {
    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.endpoint, path)
    }

    /// Stop accepting connections, drain in-flight requests, and wait for the task.
    pub async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        let _ = self.handle.await;
    }
}

/// Bind and start serving. Binds before returning, so the caller learns the real port
/// immediately even when `port` is 0.
pub async fn spawn(
    store: Store,
    auth: AuthRegistry,
    config: ServerConfig,
) -> std::io::Result<RunningServer> {
    let listener = TcpListener::bind(SocketAddr::new(config.bind, config.port)).await?;
    let local_addr = listener.local_addr()?;
    let endpoint = format!("http://{local_addr}");

    let state = ApiState {
        store,
        auth,
        max_payload_bytes: config.max_payload_bytes,
    };
    let app = router(state);

    let (tx, rx) = oneshot::channel::<()>();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
    });

    Ok(RunningServer {
        endpoint,
        local_addr,
        shutdown: Some(tx),
        handle,
    })
}
