use thiserror::Error;

/// Every fallible operation in the store returns this error.
#[derive(Debug, Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    /// A shared wire type rejected its input. The wire types live in `apro-types` so the
    /// client SDK can use them without linking SQLite, so their validation errors arrive
    /// from there rather than being duplicated here.
    #[error(transparent)]
    Types(#[from] apro_types::TypeError),

    #[error("invalid type id {raw:?}: {reason}")]
    InvalidTypeId { raw: String, reason: String },

    #[error("invalid request: {0}")]
    InvalidRequest(String),

    #[error("artifact not found for type {type_id:?} instance {instance:?}")]
    ArtifactNotFound { type_id: String, instance: String },

    #[error("no revision {selector} for artifact {artifact_id}")]
    RevisionNotFound { artifact_id: String, selector: String },

    #[error("edge not found: {0}")]
    EdgeNotFound(String),

    #[error("subscription not found: {0}")]
    SubscriptionNotFound(String),

    #[error("app {app:?} is not permitted to write type {type_id:?}; declared publishes: {declared:?}")]
    WriteNotDeclared {
        app: String,
        type_id: String,
        declared: Vec<String>,
    },

    #[error("configuration error: {0}")]
    Config(String),
}

/// Coarse classification of a store failure.
///
/// Each transport picks its own representation from this — HTTP picks a status code,
/// the in-process client picks nothing at all. Keeping the classification here means
/// the two can never drift apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// The thing named does not exist.
    NotFound,
    /// The caller was authenticated but is not allowed to do this.
    Forbidden,
    /// The caller asked for something malformed.
    Invalid,
    /// The store itself failed.
    Internal,
}

impl StoreError {
    /// Stable machine-readable code, used by the HTTP layer and `aproctl`.
    pub fn code(&self) -> &'static str {
        match self {
            StoreError::Db(_) => "db_error",
            StoreError::Io(_) => "io_error",
            StoreError::Serialization(_) => "serialization_error",
            StoreError::Types(err) => err.code(),
            StoreError::InvalidTypeId { .. } => "invalid_type_id",
            StoreError::InvalidRequest(_) => "invalid_request",
            StoreError::ArtifactNotFound { .. } => "artifact_not_found",
            StoreError::RevisionNotFound { .. } => "revision_not_found",
            StoreError::EdgeNotFound(_) => "edge_not_found",
            StoreError::SubscriptionNotFound(_) => "subscription_not_found",
            StoreError::WriteNotDeclared { .. } => "write_not_declared",
            StoreError::Config(_) => "config_error",
        }
    }

    /// Which family of failure this is, so each transport can map it to its own shape.
    pub fn kind(&self) -> ErrorKind {
        match self {
            StoreError::ArtifactNotFound { .. }
            | StoreError::RevisionNotFound { .. }
            | StoreError::EdgeNotFound(_)
            | StoreError::SubscriptionNotFound(_) => ErrorKind::NotFound,

            StoreError::WriteNotDeclared { .. } => ErrorKind::Forbidden,

            StoreError::InvalidTypeId { .. }
            | StoreError::InvalidRequest(_)
            | StoreError::Types(_)
            | StoreError::Serialization(_) => ErrorKind::Invalid,

            StoreError::Db(_) | StoreError::Io(_) | StoreError::Config(_) => ErrorKind::Internal,
        }
    }

    pub fn invalid(msg: impl Into<String>) -> Self {
        StoreError::InvalidRequest(msg.into())
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;
