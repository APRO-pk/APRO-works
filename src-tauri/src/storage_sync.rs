//! Mirroring the local orchestration store into an account's online storage.
//!
//! The hub already keeps every published artifact as a content-addressed blob
//! under `%LOCALAPPDATA%\APRO\Store\blobs`, and the whole point of that layout is
//! that a blob's name *is* the hash of its bytes. That is what makes this file
//! short: there is no manifest to keep, no ordering to agree on and no conflict
//! to resolve, because two people who publish the same bytes produce the same
//! name and the second write is a no-op. A workspace's object list is therefore
//! the entire state of the sync, and it lives on the server rather than here.
//!
//! ## Why the run is a loop over hashes
//!
//! Both directions compare sets of hashes and transfer only the difference. On
//! the first pass into a workspace that means everything; afterwards it means
//! whatever was published since, and an unchanged store costs one listing and
//! nothing else. That is deliberate — the alternative, remembering what was sent
//! in a local file, would be a second source of truth that can disagree with the
//! objects that actually exist.
//!
//! ## Why this is not a general file synchroniser
//!
//! It moves opaque payloads between the store and one workspace's prefix in R2,
//! and understands nothing about what is inside them. `docs/APP_INTEGRATION.md`
//! puts the meaning on the product's side, and this is the hub's half of that
//! contract: bytes in, bytes out, addressed by hash.
//!
//! ## What it will not do
//!
//! It does not delete. An object removed from R2 is not removed locally, and a
//! blob pruned locally is left online, because "this file is gone everywhere" is
//! a decision about other people's data and a background sync is the wrong place
//! to make it. A partial failure is reported rather than thrown: one unreadable
//! blob should not abandon the other nine hundred.

use std::collections::HashSet;
use std::time::Duration;

use apro_store::Store;
use serde::{Deserialize, Serialize};

/// The listing is small and should fail quickly if the Worker is unreachable.
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// A single blob, in either direction. Generous: this is domestic uplink speed.
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(300);

/// What one pass did.
///
/// Serializable so the command can hand it straight to the UI, which is where
/// the numbers are worth showing — "12 files, 4.1 MB" is the only evidence a
/// person gets that a background sync happened at all.
#[derive(Serialize, Default)]
pub struct SyncReport {
    pub uploaded: usize,
    pub uploaded_bytes: u64,
    pub downloaded: usize,
    pub downloaded_bytes: u64,
    /// Already present on the far side, so nothing was sent.
    pub unchanged: usize,
    pub failed: usize,
    /// The first thing that went wrong, kept because it is the one worth showing.
    pub detail: Option<String>,
}

impl SyncReport {
    /// Count a failure and remember the first explanation for it.
    ///
    /// Later failures are counted but their text is dropped: a screen listing
    /// nine stack traces helps nobody, and the first is almost always the cause.
    fn note(&mut self, message: String) {
        self.failed += 1;
        if self.detail.is_none() {
            self.detail = Some(message);
        }
    }
}

#[derive(Debug, Deserialize)]
struct StoredObject {
    id: String,
    #[serde(default)]
    content_hash: String,
}

#[derive(Deserialize)]
struct ObjectList {
    #[serde(default)]
    objects: Vec<StoredObject>,
}

/// The Worker's failure body. `error` is written to be read by a person.
#[derive(Deserialize)]
struct ApiError {
    #[serde(default)]
    error: String,
}

fn trimmed(base: &str) -> &str {
    base.trim().trim_end_matches('/')
}

/// The Worker's own sentence where there is one, and the status where there is not.
fn describe(status: reqwest::StatusCode, body: &str) -> String {
    serde_json::from_str::<ApiError>(body)
        .ok()
        .map(|api| api.error)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| format!("Online storage answered {}.", status.as_u16()))
}

fn list(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
    workspace_id: &str,
) -> Result<Vec<StoredObject>, String> {
    let response = client
        .get(format!("{base}/storage/objects"))
        .query(&[("workspace_id", workspace_id)])
        .bearer_auth(token)
        .timeout(LIST_TIMEOUT)
        .send()
        .map_err(|err| format!("Could not reach online storage: {err}"))?;

    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(describe(status, &body));
    }

    serde_json::from_str::<ObjectList>(&body)
        .map(|listing| listing.objects)
        .map_err(|err| format!("Online storage sent a listing this build does not understand: {err}"))
}

fn upload(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
    workspace_id: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let response = client
        .post(format!("{base}/storage/objects"))
        .query(&[("workspace_id", workspace_id)])
        .bearer_auth(token)
        .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
        .body(bytes.to_vec())
        .timeout(TRANSFER_TIMEOUT)
        .send()
        .map_err(|err| format!("Could not reach online storage: {err}"))?;

    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let body = response.text().unwrap_or_default();
    Err(describe(status, &body))
}

fn download(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
    id: &str,
) -> Result<Vec<u8>, String> {
    let response = client
        .get(format!("{base}/storage/blob"))
        .query(&[("id", id)])
        .bearer_auth(token)
        .timeout(TRANSFER_TIMEOUT)
        .send()
        .map_err(|err| format!("Could not reach online storage: {err}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(describe(status, &body));
    }

    response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .map_err(|err| format!("A download stopped part-way: {err}"))
}

/// Bring this machine's store and one workspace's online storage into agreement.
///
/// `token` is the caller's own Supabase access token, not a service key: the
/// Worker decides what this person may do, and the hub takes no part in that
/// decision. It is passed in rather than read from anywhere on disk because the
/// session lives in the frontend and this process never sees a password.
pub fn sync(
    store: &Store,
    base: &str,
    token: &str,
    workspace_id: &str,
) -> Result<SyncReport, String> {
    let base = trimmed(base);
    if base.is_empty() {
        return Err("Online storage is not configured in this build.".into());
    }
    if workspace_id.trim().is_empty() {
        return Err("A workspace is needed before anything can be shared into one.".into());
    }

    let client = reqwest::blocking::Client::builder()
        .user_agent("APRO-Works")
        .build()
        .map_err(|err| format!("Could not prepare the storage client: {err}"))?;

    let blobs = store.blobs();
    let local = blobs
        .list()
        .map_err(|err| format!("Could not read the local store: {err}"))?;
    let remote = list(&client, base, token, workspace_id)?;

    let remote_hashes: HashSet<&str> = remote.iter().map(|o| o.content_hash.as_str()).collect();
    let local_hashes: HashSet<&str> = local.iter().map(|(hash, _)| hash.as_str()).collect();

    let mut report = SyncReport::default();

    // Push. Comparing against the workspace's own listing is what makes this
    // incremental without any local bookkeeping: the server's answer *is* the
    // record of what has already been sent, and it stays right on a machine that
    // was reinstalled.
    for (hash, size) in &local {
        if remote_hashes.contains(hash.as_str()) {
            report.unchanged += 1;
            continue;
        }

        let bytes = match blobs.get(hash) {
            Ok(bytes) => bytes,
            Err(err) => {
                report.note(format!("Could not read blob {hash}: {err}"));
                continue;
            }
        };

        match upload(&client, base, token, workspace_id, &bytes) {
            Ok(()) => {
                report.uploaded += 1;
                report.uploaded_bytes += size;
            }
            Err(err) => report.note(err),
        }
    }

    // Pull. Anything the workspace holds that this machine has never seen — a
    // colleague's publish, or this account's own work on another computer.
    for object in &remote {
        if local_hashes.contains(object.content_hash.as_str()) {
            continue;
        }

        let bytes = match download(&client, base, token, &object.id) {
            Ok(bytes) => bytes,
            Err(err) => {
                report.note(err);
                continue;
            }
        };

        // `put` names the blob after the hash of the bytes it was given, so a
        // transfer that arrived corrupted is stored under its *real* name rather
        // than the one that was asked for. Nothing is poisoned by that; the stray
        // copy is simply unreferenced and `prune` will collect it. The mismatch
        // is still reported, because it means the network or the server is lying.
        match blobs.put(&bytes) {
            Ok((actual, _)) if actual == object.content_hash => {
                report.downloaded += 1;
                report.downloaded_bytes += bytes.len() as u64;
            }
            Ok((actual, _)) => report.note(format!(
                "A downloaded object hashed to {actual} rather than {}.",
                object.content_hash
            )),
            Err(err) => report.note(format!("Could not store a downloaded object: {err}")),
        }
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::{describe, trimmed, ApiError, SyncReport};

    #[test]
    fn a_trailing_slash_does_not_produce_a_double_slash() {
        assert_eq!(trimmed("https://example.test/"), "https://example.test");
        assert_eq!(trimmed("  https://example.test  "), "https://example.test");
        assert_eq!(trimmed("https://example.test"), "https://example.test");
    }

    #[test]
    fn the_workers_own_sentence_survives() {
        let body = r#"{"error":"Not enough online storage: 512 of 1073741824 bytes already used."}"#;
        assert_eq!(
            describe(reqwest::StatusCode::INSUFFICIENT_STORAGE, body),
            "Not enough online storage: 512 of 1073741824 bytes already used."
        );
    }

    #[test]
    fn a_body_without_a_sentence_falls_back_to_the_status() {
        assert_eq!(
            describe(reqwest::StatusCode::BAD_GATEWAY, "<html>502</html>"),
            "Online storage answered 502."
        );
        assert_eq!(
            describe(reqwest::StatusCode::BAD_GATEWAY, r#"{"error":"   "}"#),
            "Online storage answered 502."
        );
    }

    #[test]
    fn only_the_first_failure_is_explained() {
        let mut report = SyncReport::default();
        report.note("the first thing".into());
        report.note("the second thing".into());

        assert_eq!(report.failed, 2);
        assert_eq!(report.detail.as_deref(), Some("the first thing"));
    }

    #[test]
    fn a_worker_error_body_deserialises_without_the_optional_detail() {
        let parsed: ApiError = serde_json::from_str(r#"{"error":"Nope."}"#).expect("parses");
        assert_eq!(parsed.error, "Nope.");
    }

    /// The Worker's own refusal comes back as its own sentence.
    ///
    /// Ignored because it needs the network, like the updater's live test. It
    /// sends a deliberately invalid token, so what it proves is not authorization
    /// but construction: the URL, the query parameter and the bearer header are
    /// all shaped so the real Worker answered at all, and its prose survived
    /// `describe` instead of being flattened into a status code.
    #[test]
    #[ignore]
    fn the_live_worker_refuses_a_bad_token_in_its_own_words() {
        let base = std::env::var("APRO_STORAGE_BASE")
            .unwrap_or_else(|_| "https://apro-workspace-storage.henryarkenberg.workers.dev".into());
        let client = reqwest::blocking::Client::builder()
            .user_agent("APRO-Works")
            .build()
            .expect("client");

        let error = super::list(
            &client,
            &base,
            "not-a-real-token",
            "23140b16-1437-40f1-80c9-f282c4e9e479",
        )
        .expect_err("a bad token must not be accepted");

        println!("the worker said: {error}");
        assert!(!error.trim().is_empty());
        assert!(
            !error.starts_with("Online storage answered 4") && !error.starts_with("Could not reach"),
            "expected the Worker's own sentence, got {error:?}"
        );
    }
}
