//! Wire and storage types for the orchestration layer.
//!
//! The identity triple is `type_id x instance x encoding` (DESIGN.md D17):
//!
//! * `TypeId`  — semantics, namespaced by the owning app (`owner-app/type-name`)
//! * `instance` — *which* one (a stable identity across revisions)
//! * `Encoding` — how the payload bytes are serialized
//!
//! The hub never interprets payload bytes; `Encoding` is metadata only.

use serde::{Deserialize, Serialize};
use std::fmt;

use crate::error::{Result, TypeError};

pub type Millis = i64;

/// Namespace reserved for hub-defined types. Never accepted as an app slug.
pub const CORE_NAMESPACE: &str = "apro-core";
/// Namespace reserved for removable dummy data.
pub const DEMO_NAMESPACE: &str = "apro-demo";
/// Default seed batch marker. Everything created by this batch is removable in one call.
pub const DEFAULT_SEED_BATCH: &str = "demo-v1";

/// Payloads at or below this size are stored inline in SQLite; larger ones go to the blob store.
pub const INLINE_MAX_BYTES: usize = 64 * 1024;

fn is_kebab_segment(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return false;
    }
    let first = value.chars().next().unwrap_or('-');
    let last = value.chars().last().unwrap_or('-');
    first != '-' && last != '-'
}

/// A namespaced semantic type, canonically `"<owner-app>/<type-name>"`.
///
/// Both segments must be kebab-case. This is enforced because type ids are used in
/// URLs, on disk and as namespaces, and because the legacy product slug
/// `"Propulsor - Liquid Engine Design Studio"` (spaces) must not be able to produce one.
///
/// Deserialization goes through [`TypeId::parse`], so an invalid id arriving over the
/// wire is rejected rather than silently stored.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TypeId(String);

impl Serialize for TypeId {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for TypeId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        TypeId::parse(&raw).map_err(serde::de::Error::custom)
    }
}

impl TypeId {
    pub fn new(owner_app: &str, name: &str) -> Result<Self> {
        if !is_kebab_segment(owner_app) {
            return Err(TypeError::InvalidTypeId {
                raw: owner_app.to_string(),
                reason: "owner app must be kebab-case (a-z, 0-9, '-'), 1-64 chars, \
                         and must not start or end with '-'"
                    .into(),
            });
        }
        if !is_kebab_segment(name) {
            return Err(TypeError::InvalidTypeId {
                raw: name.to_string(),
                reason: "type name must be kebab-case (a-z, 0-9, '-'), 1-64 chars, \
                         and must not start or end with '-'"
                    .into(),
            });
        }
        Ok(Self(format!("{owner_app}/{name}")))
    }

    pub fn parse(raw: &str) -> Result<Self> {
        let (app, name) = raw.split_once('/').ok_or_else(|| TypeError::InvalidTypeId {
            raw: raw.to_string(),
            reason: "expected the form \"<owner-app>/<type-name>\"".into(),
        })?;
        if name.contains('/') {
            return Err(TypeError::InvalidTypeId {
                raw: raw.to_string(),
                reason: "expected exactly one '/' separator".into(),
            });
        }
        Self::new(app, name)
    }

    pub fn owner_app(&self) -> &str {
        self.0.split_once('/').map(|(app, _)| app).unwrap_or(CORE_NAMESPACE)
    }

    pub fn name(&self) -> &str {
        self.0.split_once('/').map(|(_, name)| name).unwrap_or(&self.0)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// True for the reserved dummy-data namespace. Used by purge to be belt-and-braces.
    pub fn is_demo(&self) -> bool {
        self.owner_app() == DEMO_NAMESPACE
    }
}

impl fmt::Display for TypeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// How payload bytes are serialized. The hub stores them verbatim (DESIGN.md D12).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Encoding {
    Json,
    Protobuf,
    Blob,
    Text,
}

impl Encoding {
    pub fn as_str(self) -> &'static str {
        match self {
            Encoding::Json => "json",
            Encoding::Protobuf => "protobuf",
            Encoding::Blob => "blob",
            Encoding::Text => "text",
        }
    }

    pub fn parse(raw: &str) -> Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "json" => Ok(Encoding::Json),
            "protobuf" | "proto" | "pb" => Ok(Encoding::Protobuf),
            "blob" | "binary" | "octet-stream" => Ok(Encoding::Blob),
            "text" | "plain" => Ok(Encoding::Text),
            other => Err(TypeError::invalid(format!(
                "unknown encoding {other:?}; expected one of json, protobuf, blob, text"
            ))),
        }
    }
}

impl fmt::Display for Encoding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How a consumer's dependency on an artifact is satisfied (DESIGN.md D4/D5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Frozen at one revision. Never goes stale. The default.
    Pinned,
    /// Follows the artifact's current revision. Goes stale when upstream publishes.
    Tracking,
    /// Satisfied by any revision at or above a floor. Never goes stale once met.
    Compatible,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Pinned => "pinned",
            Mode::Tracking => "tracking",
            Mode::Compatible => "compatible",
        }
    }

    pub fn parse(raw: &str) -> Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "pinned" | "pin" => Ok(Mode::Pinned),
            "tracking" | "track" | "latest" => Ok(Mode::Tracking),
            "compatible" | "compat" => Ok(Mode::Compatible),
            other => Err(TypeError::invalid(format!(
                "unknown mode {other:?}; expected one of pinned, tracking, compatible"
            ))),
        }
    }
}

impl fmt::Display for Mode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Which revision of an artifact to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Selector {
    /// Highest revision number.
    #[default]
    Latest,
    /// An explicit revision number.
    Number(u32),
}

impl Selector {
    pub fn describe(&self) -> String {
        match self {
            Selector::Latest => "latest".to_string(),
            Selector::Number(n) => format!("number {n}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushRequest {
    pub type_id: TypeId,
    pub instance: String,
    pub encoding: Encoding,
    #[serde(default)]
    pub label: Option<String>,
    /// The app performing the write. Validated against declared publishes.
    pub actor_app: String,
    /// Attribution; the Supabase member id when known.
    #[serde(default)]
    pub created_by: Option<String>,
    /// Non-null marks the artifact as seed data removable by `purge_demo`.
    #[serde(default)]
    pub seed_batch: Option<String>,
    #[serde(skip)]
    pub payload: Vec<u8>,
}

impl PushRequest {
    pub fn new(
        type_id: TypeId,
        instance: impl Into<String>,
        encoding: Encoding,
        actor_app: impl Into<String>,
        payload: Vec<u8>,
    ) -> Self {
        Self {
            type_id,
            instance: instance.into(),
            encoding,
            label: None,
            actor_app: actor_app.into(),
            created_by: None,
            seed_batch: None,
            payload,
        }
    }

    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn with_seed_batch(mut self, batch: impl Into<String>) -> Self {
        self.seed_batch = Some(batch.into());
        self
    }

    pub fn with_created_by(mut self, who: impl Into<String>) -> Self {
        self.created_by = Some(who.into());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeRequest {
    pub consumer_app: String,
    #[serde(default)]
    pub consumer_ref: Option<String>,
    pub type_id: TypeId,
    pub instance: String,
    #[serde(default = "default_mode_pinned")]
    pub mode: Mode,
    /// Required for `Mode::Pinned`. Defaults to the artifact's current revision.
    #[serde(default)]
    pub pinned_revision_number: Option<u32>,
    /// Required for `Mode::Compatible`.
    #[serde(default)]
    pub min_revision_number: Option<u32>,
}

fn default_mode_pinned() -> Mode {
    Mode::Pinned
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsumeDecl {
    pub type_id: TypeId,
    #[serde(default = "default_mode_pinned")]
    pub default_mode: Mode,
}

/// An app's declared data contract (DESIGN.md D16).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInterface {
    pub app: String,
    #[serde(default)]
    pub publishes: Vec<TypeId>,
    #[serde(default)]
    pub consumes: Vec<ConsumeDecl>,
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactSummary {
    pub artifact_id: String,
    pub type_id: String,
    pub owner_app: String,
    pub instance: String,
    pub label: Option<String>,
    pub current_revision_id: Option<String>,
    pub current_revision_number: Option<u32>,
    pub revision_count: u32,
    pub created_by: Option<String>,
    pub origin_node_id: String,
    pub seed_batch: Option<String>,
    pub created_at: Millis,
    pub updated_at: Millis,
}

impl ArtifactSummary {
    pub fn is_demo(&self) -> bool {
        self.seed_batch.is_some()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevisionSummary {
    pub revision_id: String,
    pub artifact_id: String,
    pub revision_number: u32,
    pub parent_revision_id: Option<String>,
    pub encoding: Encoding,
    pub content_hash: String,
    pub byte_size: u64,
    pub created_by: Option<String>,
    pub origin_node_id: String,
    pub created_at: Millis,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevisionHandle {
    pub artifact_id: String,
    pub revision_id: String,
    pub revision_number: u32,
    pub content_hash: String,
    pub byte_size: u64,
    pub created_new_artifact: bool,
    /// True when the pushed bytes were byte-identical to the current revision, so no
    /// new revision was created. Prevents revision spam from idempotent saves.
    pub unchanged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchedRevision {
    pub artifact: ArtifactSummary,
    pub revision: RevisionSummary,
    #[serde(skip)]
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeSummary {
    pub edge_id: String,
    pub consumer_app: String,
    pub consumer_ref: Option<String>,
    pub artifact_id: String,
    pub type_id: String,
    pub instance: String,
    pub mode: Mode,
    pub pinned_revision_id: Option<String>,
    pub pinned_revision_number: Option<u32>,
    pub min_revision_number: Option<u32>,
    pub last_satisfied_revision_id: Option<String>,
    pub last_satisfied_revision_number: Option<u32>,
    pub current_revision_id: Option<String>,
    pub current_revision_number: Option<u32>,
    /// Computed from the graph; never stored (DESIGN.md 5.3).
    pub stale: bool,
    pub created_at: Millis,
}

/// A type-level subscription: what the workflow canvas actually edits.
///
/// A wire in the UI says "this app's *kind* of output feeds that app's *kind* of input".
/// An [`EdgeSummary`] is instance-level. Concrete edges are materialised from a
/// subscription, one per existing instance, and kept current as new instances appear.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionSummary {
    pub subscription_id: String,
    pub consumer_app: String,
    pub type_id: String,
    pub mode: Mode,
    /// How many concrete edges this subscription currently materialises to.
    pub edge_count: u32,
    /// How many of those are out of date.
    pub stale_edges: u32,
    pub created_by: Option<String>,
    pub created_at: Millis,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionRequest {
    pub consumer_app: String,
    pub type_id: TypeId,
    #[serde(default = "default_mode_pinned")]
    pub mode: Mode,
    #[serde(default)]
    pub created_by: Option<String>,
}

/// One read of one revision, or an attempt that found nothing.
///
/// Recorded in `access_log`, never in `event`: consumers poll the change feed with a
/// cursor, and read records there would spam every app's loop.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessRecord {
    pub seq: i64,
    pub actor_app: String,
    pub type_id: String,
    pub instance: String,
    pub revision_id: Option<String>,
    pub revision_number: Option<u32>,
    /// `hit` when a revision was returned, `miss` when nothing existed yet.
    pub outcome: String,
    pub created_at: Millis,
}

/// The `consumer_ref` prefix marking an edge as materialised from a subscription.
/// Lets a subscription own its edges without a separate mapping table.
pub const SUBSCRIPTION_REF_PREFIX: &str = "sub:";

pub fn subscription_ref(subscription_id: &str) -> String {
    format!("{SUBSCRIPTION_REF_PREFIX}{subscription_id}")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventRecord {
    pub seq: i64,
    pub kind: String,
    pub type_id: Option<String>,
    pub artifact_id: Option<String>,
    pub revision_id: Option<String>,
    pub edge_id: Option<String>,
    pub actor_app: Option<String>,
    pub summary: Option<String>,
    pub created_at: Millis,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PurgeReport {
    pub seed_batch: Option<String>,
    pub artifacts: u64,
    pub revisions: u64,
    pub edges: u64,
    pub events: u64,
    pub blobs_removed: u64,
    pub bytes_freed: u64,
}

impl PurgeReport {
    pub fn total_rows(&self) -> u64 {
        self.artifacts + self.revisions + self.edges + self.events
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreStats {
    pub node_id: String,
    pub schema_version: i32,
    pub data_dir: String,
    pub artifacts: u64,
    pub revisions: u64,
    pub edges: u64,
    pub events: u64,
    pub stale_edges: u64,
    pub demo_artifacts: u64,
    pub inline_bytes: u64,
    pub blob_count: u64,
    pub blob_bytes: u64,
    pub cursor: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeclaredType {
    pub app: String,
    pub direction: String,
    pub type_id: String,
    pub default_mode: Option<String>,
    pub source: String,
    pub declared_at: Millis,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ArtifactFilter {
    #[serde(default)]
    pub type_id: Option<String>,
    #[serde(default)]
    pub owner_app: Option<String>,
    #[serde(default)]
    pub instance: Option<String>,
    /// When false (the default) seed/demo artifacts are hidden from listings.
    #[serde(default)]
    pub include_demo: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EdgeFilter {
    #[serde(default)]
    pub consumer_app: Option<String>,
    #[serde(default)]
    pub artifact_id: Option<String>,
    /// Filter to only stale / only fresh edges.
    #[serde(default)]
    pub stale: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn type_id_rejects_the_legacy_spaced_slug() {
        let err = TypeId::new("Propulsor - Liquid Engine Design Studio", "chamber").unwrap_err();
        assert_eq!(err.code(), "invalid_type_id");
    }

    #[test]
    fn type_id_round_trips() {
        let id = TypeId::new("burn-geometry-modeler", "grain-geometry").unwrap();
        assert_eq!(id.as_str(), "burn-geometry-modeler/grain-geometry");
        assert_eq!(id.owner_app(), "burn-geometry-modeler");
        assert_eq!(id.name(), "grain-geometry");
        assert_eq!(TypeId::parse(id.as_str()).unwrap(), id);
    }

    #[test]
    fn type_id_rejects_bad_shapes() {
        assert!(TypeId::parse("no-separator").is_err());
        assert!(TypeId::parse("a/b/c").is_err());
        assert!(TypeId::new("App", "x").is_err());
        assert!(TypeId::new("-app", "x").is_err());
        assert!(TypeId::new("app", "x_").is_err());
        assert!(TypeId::new("", "x").is_err());
    }

    #[test]
    fn encoding_parses_aliases() {
        assert_eq!(Encoding::parse("PB").unwrap(), Encoding::Protobuf);
        assert_eq!(Encoding::parse("json").unwrap(), Encoding::Json);
        assert!(Encoding::parse("yaml").is_err());
    }
}
