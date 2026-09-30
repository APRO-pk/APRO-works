use thiserror::Error;

/// Validation errors raised by the shared value types themselves.
///
/// Deliberately separate from the store's error type. The client SDK needs these types
/// without linking the storage engine, and therefore without compiling SQLite.
#[derive(Debug, Error)]
pub enum TypeError {
    #[error("invalid type id {raw:?}: {reason}")]
    InvalidTypeId { raw: String, reason: String },

    #[error("invalid request: {0}")]
    Invalid(String),
}

impl TypeError {
    pub fn invalid(message: impl Into<String>) -> Self {
        TypeError::Invalid(message.into())
    }

    /// Stable machine-readable code, matching what the store and the HTTP API report.
    pub fn code(&self) -> &'static str {
        match self {
            TypeError::InvalidTypeId { .. } => "invalid_type_id",
            TypeError::Invalid(_) => "invalid_request",
        }
    }
}

pub type Result<T> = std::result::Result<T, TypeError>;
