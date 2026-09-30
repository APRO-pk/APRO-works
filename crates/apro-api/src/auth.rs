//! Launch-ticket -> session authentication.
//!
//! Replaces the previously unvalidated launch handoff with a real exchange:
//!
//! 1. The hub mints a short-lived **launch ticket** for one app and passes it on the
//!    command line (preserving the existing `--apro-launch-token` contract).
//! 2. The app exchanges it once at startup for a longer-lived **session token**.
//! 3. Every request carries the session token as a bearer credential.
//!
//! Sessions are scoped to a single app slug, so the store can attribute and validate
//! writes. Scopes exist from day one so authorization can be tightened later without
//! changing the token format.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

/// Matches the hub's existing launch-ticket TTL.
pub const LAUNCH_TICKET_TTL_SECS: i64 = 90;
/// Long enough for a working session; refreshable.
pub const SESSION_TTL_SECS: i64 = 12 * 60 * 60;

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
struct Grant {
    app_slug: String,
    scopes: Vec<String>,
    expires_at: i64,
}

/// What a validated request is allowed to do.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedAuth {
    pub app_slug: String,
    pub scopes: Vec<String>,
    pub insecure: bool,
}

impl ResolvedAuth {
    pub fn allows(&self, scope: &str) -> bool {
        self.insecure || self.scopes.iter().any(|s| s == "*" || s == scope)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub session_token: String,
    pub app_slug: String,
    pub scopes: Vec<String>,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    /// No `Authorization: Bearer <token>` header.
    MissingCredentials,
    /// Unknown, expired, or already-redeemed.
    InvalidTicket,
    /// Unknown or expired session.
    InvalidSession,
}

impl AuthError {
    pub fn message(self) -> &'static str {
        match self {
            AuthError::MissingCredentials => {
                "missing Authorization header; expected \"Bearer <token>\""
            }
            AuthError::InvalidTicket => {
                "launch ticket is unknown, expired, or already redeemed"
            }
            AuthError::InvalidSession => "session token is unknown or expired",
        }
    }
}

#[derive(Default)]
struct Inner {
    tickets: HashMap<String, Grant>,
    sessions: HashMap<String, Grant>,
}

#[derive(Clone)]
pub struct AuthRegistry {
    inner: Arc<Mutex<Inner>>,
    /// When true, any bearer token is accepted and the acting app comes from the
    /// `x-apro-app` header. For local development and `aproctl` only.
    insecure: bool,
}

impl Default for AuthRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl AuthRegistry {
    /// Secure mode: a ticket or session issued by this registry is required.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            insecure: false,
        }
    }

    /// Development mode. Never use this for a store holding real data.
    pub fn new_insecure() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            insecure: true,
        }
    }

    pub fn is_insecure(&self) -> bool {
        self.insecure
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Mint a launch ticket for one app. The hub writes the returned token into the
    /// existing launch-ticket file, so the on-disk contract is unchanged.
    pub fn issue_launch_ticket(&self, app_slug: &str, scopes: &[&str]) -> String {
        self.issue_launch_ticket_with_ttl(app_slug, scopes, LAUNCH_TICKET_TTL_SECS)
    }

    pub fn issue_launch_ticket_with_ttl(
        &self,
        app_slug: &str,
        scopes: &[&str],
        ttl_secs: i64,
    ) -> String {
        self.purge_expired();
        let token = format!("{app_slug}-{}", uuid::Uuid::new_v4().simple());
        let grant = Grant {
            app_slug: app_slug.to_string(),
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            expires_at: now_secs() + ttl_secs,
        };
        self.inner().tickets.insert(token.clone(), grant);
        token
    }

    /// Redeem a launch ticket exactly once for a session token.
    pub fn exchange_ticket(&self, ticket: &str) -> Result<SessionInfo, AuthError> {
        self.purge_expired();
        let grant = self
            .inner()
            .tickets
            .remove(ticket)
            .ok_or(AuthError::InvalidTicket)?;
        self.issue_session(grant)
    }

    fn issue_session(&self, grant: Grant) -> Result<SessionInfo, AuthError> {
        if grant.expires_at <= now_secs() {
            return Err(AuthError::InvalidTicket);
        }
        let token = format!(
            "{}-{}",
            grant.app_slug,
            uuid::Uuid::new_v4().simple()
        );
        let session = Grant {
            app_slug: grant.app_slug.clone(),
            scopes: grant.scopes.clone(),
            expires_at: now_secs() + SESSION_TTL_SECS,
        };
        let expires_at = session.expires_at;
        self.inner().sessions.insert(token.clone(), session);
        Ok(SessionInfo {
            session_token: token,
            app_slug: grant.app_slug,
            scopes: grant.scopes,
            expires_at,
        })
    }

    /// Start a session for an app without a ticket. Used by `aproctl` and by the hub
    /// for its own in-process diagnostics.
    pub fn issue_session_direct(
        &self,
        app_slug: &str,
        scopes: &[&str],
        ttl_secs: i64,
    ) -> SessionInfo {
        self.purge_expired();
        let token = format!("{app_slug}-{}", uuid::Uuid::new_v4().simple());
        let scopes: Vec<String> = scopes.iter().map(|s| s.to_string()).collect();
        let expires_at = now_secs() + ttl_secs;
        self.inner().sessions.insert(
            token.clone(),
            Grant {
                app_slug: app_slug.to_string(),
                scopes: scopes.clone(),
                expires_at,
            },
        );
        SessionInfo {
            session_token: token,
            app_slug: app_slug.to_string(),
            scopes,
            expires_at,
        }
    }

    /// Extend a live session. Returns the same token with a refreshed expiry.
    pub fn refresh(&self, session_token: &str) -> Result<SessionInfo, AuthError> {
        self.purge_expired();
        let mut inner = self.inner();
        let grant = inner
            .sessions
            .get_mut(session_token)
            .ok_or(AuthError::InvalidSession)?;
        grant.expires_at = now_secs() + SESSION_TTL_SECS;
        Ok(SessionInfo {
            session_token: session_token.to_string(),
            app_slug: grant.app_slug.clone(),
            scopes: grant.scopes.clone(),
            expires_at: grant.expires_at,
        })
    }

    /// Validate a bearer token. In insecure mode any non-empty token is accepted and
    /// the app slug is resolved from `fallback_app`.
    pub fn validate(&self, token: &str, fallback_app: Option<&str>) -> Option<ResolvedAuth> {
        self.purge_expired();

        if self.insecure {
            return Some(ResolvedAuth {
                app_slug: fallback_app.unwrap_or("apro-unknown").to_string(),
                scopes: vec!["*".to_string()],
                insecure: true,
            });
        }

        let inner = self.inner();
        let grant = inner.sessions.get(token)?;
        Some(ResolvedAuth {
            app_slug: grant.app_slug.clone(),
            scopes: grant.scopes.clone(),
            insecure: false,
        })
    }

    pub fn active_tickets(&self) -> usize {
        self.purge_expired();
        self.inner().tickets.len()
    }

    pub fn active_sessions(&self) -> usize {
        self.purge_expired();
        self.inner().sessions.len()
    }

    pub fn purge_expired(&self) {
        let now = now_secs();
        let mut inner = self.inner();
        inner.tickets.retain(|_, g| g.expires_at > now);
        inner.sessions.retain(|_, g| g.expires_at > now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_is_single_use() {
        let auth = AuthRegistry::new();
        let ticket = auth.issue_launch_ticket("hexadof", &["read", "write"]);
        let session = auth.exchange_ticket(&ticket).unwrap();
        assert_eq!(session.app_slug, "hexadof");
        assert!(
            auth.exchange_ticket(&ticket).is_err(),
            "a ticket must not be redeemable twice"
        );
    }

    #[test]
    fn expired_ticket_is_rejected() {
        let auth = AuthRegistry::new();
        let ticket = auth.issue_launch_ticket_with_ttl("hexadof", &[], -1);
        assert!(matches!(
            auth.exchange_ticket(&ticket),
            Err(AuthError::InvalidTicket)
        ));
    }

    #[test]
    fn session_validation_and_refresh() {
        let auth = AuthRegistry::new();
        let ticket = auth.issue_launch_ticket("hexadof", &["write"]);
        let session = auth.exchange_ticket(&ticket).unwrap();

        let resolved = auth.validate(&session.session_token, None).unwrap();
        assert_eq!(resolved.app_slug, "hexadof");
        assert!(resolved.allows("write"));
        assert!(!resolved.allows("admin"));

        assert!(auth.validate("nonsense", None).is_none());
        assert!(auth.refresh(&session.session_token).is_ok());
        assert!(auth.refresh("nonsense").is_err());
    }

    #[test]
    fn insecure_mode_accepts_any_token() {
        let auth = AuthRegistry::new_insecure();
        let resolved = auth.validate("anything", Some("hexadof")).unwrap();
        assert_eq!(resolved.app_slug, "hexadof");
        assert!(resolved.insecure);
        assert!(resolved.allows("admin"));
    }
}
