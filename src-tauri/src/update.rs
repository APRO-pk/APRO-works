//! Update checking against GitHub Releases.
//!
//! The hub is installed from a GitHub Release, so that is the source of truth for what
//! the newest version is. There is no server to ask.
//!
//! This deliberately **checks and reports**; it does not download or install. Doing
//! that in place needs Tauri's updater plugin, a signing keypair, and a signed manifest
//! published beside each build — none of which exist yet, and generating a signing key
//! on someone else's behalf would be the wrong call. So the app tells the user a
//! release exists and hands them the page.
//!
//! The network call is the thin part. Everything that decides *whether* an update is
//! available is a pure function with tests, because that is the part that silently
//! gets version comparisons wrong.

use serde::{Deserialize, Serialize};

/// Where releases are published. Public, so no token is needed.
const LATEST_RELEASE: &str = "https://api.github.com/repos/APRO-pk/APRO-works/releases/latest";

/// The same answer, obtained without the API.
///
/// `/releases/latest` is a page redirect rather than an API call, so it is not
/// counted against the hourly budget that unauthenticated API access shares per
/// IP address — which means a machine behind a busy office NAT is not competing
/// with its neighbours to find out its own version. See `latest_tag_from_redirect`.
const LATEST_REDIRECT: &str = "https://github.com/APRO-pk/APRO-works/releases/latest";

/// GitHub rejects requests without a User-Agent, with a 403 that reads like a
/// permissions problem rather than a missing header.
const USER_AGENT: &str = "APRO-Works";

/// What to say when GitHub refuses to answer at all.
const RATE_LIMITED: &str =
    "GitHub is rate-limiting update checks from this machine. Try again later.";

/// The page a user is sent to when an update exists.
pub const RELEASES_PAGE: &str = "https://github.com/APRO-pk/APRO-works/releases";

/// Longest release note body handed to the interface. The full text lives on the
/// release page; this is a preview and does not need to be the whole changelog.
const MAX_NOTES: usize = 1200;

/// What the interface needs in order to decide what to show.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateStatus {
    /// The version this build reports.
    pub current: String,
    /// The newest published version, when there is one. `None` also covers "no
    /// releases have been published yet", which is not an error.
    pub latest: Option<String>,
    pub available: bool,
    pub release_url: Option<String>,
    pub release_name: Option<String>,
    /// Trimmed release notes, for a preview.
    pub notes: Option<String>,
    pub published_at: Option<String>,
    /// A sentence to show the user verbatim.
    pub detail: String,
}

/// The subset of GitHub's release payload this cares about.
#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

/// The numeric components of a version.
///
/// Accepts a leading `v`, and ignores anything from `-` or `+` onwards. A missing
/// component reads as zero, so `1.2` and `1.2.0` are the same version — tags written
/// both ways should not read as different.
pub fn version_parts(raw: &str) -> Option<(u64, u64, u64)> {
    let trimmed = raw.trim();
    let without_v = trimmed.strip_prefix(['v', 'V']).unwrap_or(trimmed);
    let core = without_v
        .split(['-', '+'])
        .next()
        .unwrap_or(without_v)
        .trim();
    if core.is_empty() {
        return None;
    }

    let mut parts = core.split('.');
    let mut read = |fallback: u64| -> Option<u64> {
        match parts.next() {
            None => Some(fallback),
            Some(segment) => segment.trim().parse::<u64>().ok(),
        }
    };

    let major = read(0)?;
    let minor = read(0)?;
    let patch = read(0)?;
    Some((major, minor, patch))
}

/// Whether `candidate` is a strictly later version than `current`.
///
/// Purely numeric: a prerelease tag with a higher number counts as newer here. The
/// caller filters prereleases, because "is this numerically later" and "should we tell
/// the user about it" are different questions and mixing them is how a beta ends up
/// pushed at everyone.
///
/// Returns false when either side cannot be parsed. Failing towards "no update" means
/// an odd tag can never produce a nag the user cannot act on.
pub fn is_newer(current: &str, candidate: &str) -> bool {
    match (version_parts(current), version_parts(candidate)) {
        (Some(a), Some(b)) => b > a,
        _ => false,
    }
}

/// The sentence shown under the version.
///
/// Shared so that the answer reached cheaply and the answer reached through the
/// API cannot drift into saying slightly different things about the same state.
pub fn detail_for(current: &str, latest: &str, available: bool) -> String {
    if version_parts(current).is_none() {
        "This build's version could not be read, so no comparison was possible.".to_string()
    } else if available {
        format!("APRO Works {latest} is available. You are on {current}.")
    } else {
        format!("Up to date. You are on {current}, the newest release.")
    }
}

/// The release page for one tag.
fn release_url_for(tag: &str) -> String {
    format!("{RELEASES_PAGE}/tag/{tag}")
}

/// Pull the tag out of a `…/releases/tag/v1.2.3` URL.
///
/// GitHub puts the tag in the last path segment, so anything trailing — a query
/// string, a fragment — is dropped. Returns `None` rather than guessing when the
/// shape is not what a release redirect produces.
pub fn tag_from_release_url(url: &str) -> Option<String> {
    let (_, tail) = url.split_once("/releases/tag/")?;
    let tag = tail
        .split(['?', '#'])
        .next()
        .unwrap_or(tail)
        .trim()
        .trim_end_matches('/');
    (!tag.is_empty()).then(|| tag.to_string())
}

/// Decide what to report from a raw GitHub release payload.
///
/// Split out from the network call so it can be tested against real payloads without
/// a request.
pub fn interpret(current: &str, body: &str) -> Result<UpdateStatus, String> {
    let release: GithubRelease =
        serde_json::from_str(body).map_err(|err| format!("unreadable release payload: {err}"))?;

    let latest = release.tag_name.trim().to_string();
    let release_url = release
        .html_url
        .clone()
        .unwrap_or_else(|| RELEASES_PAGE.to_string());

    // `releases/latest` already excludes drafts and prereleases. Checking anyway is
    // cheap, and it means a future switch to the full releases list cannot quietly
    // start announcing betas.
    let tellable = !release.draft && !release.prerelease && !latest.is_empty();
    let available = tellable && is_newer(current, &latest);

    let notes = release
        .body
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| {
            if text.chars().count() > MAX_NOTES {
                let clipped: String = text.chars().take(MAX_NOTES).collect();
                format!("{clipped}…")
            } else {
                text.to_string()
            }
        });

    let detail = if !tellable {
        format!("{latest} is a pre-release; staying on {current}.")
    } else {
        detail_for(current, &latest, available)
    };

    Ok(UpdateStatus {
        current: current.to_string(),
        latest: if tellable { Some(latest) } else { None },
        available,
        release_url: Some(release_url),
        release_name: release.name,
        notes,
        published_at: release.published_at,
        detail,
    })
}

/// The status when there is nothing to compare against.
pub fn no_release(current: &str) -> UpdateStatus {
    UpdateStatus {
        current: current.to_string(),
        latest: None,
        available: false,
        release_url: Some(RELEASES_PAGE.to_string()),
        release_name: None,
        notes: None,
        published_at: None,
        detail: "No releases have been published yet.".to_string(),
    }
}

/// Why the API could not answer.
///
/// Kept apart from a plain string because "GitHub refused us" has a good fallback —
/// the redirect already answered the question — while every other failure does not.
enum ApiFailure {
    /// This machine's address has spent the shared hourly budget.
    RateLimited,
    /// Anything else, already phrased for the user.
    Other(String),
}

/// The newest tag, read from the redirect instead of the API.
///
/// `Ok(None)` means the repository has no releases yet, which is a state rather than a
/// failure.
fn latest_tag_from_redirect(client: &reqwest::blocking::Client) -> Result<Option<String>, String> {
    let response = client
        .get(LATEST_REDIRECT)
        .header("User-Agent", USER_AGENT)
        .send()
        .map_err(|err| format!("could not reach GitHub: {err}"))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }

    // The client disables redirects deliberately, so GitHub's answer arrives as the
    // Location header rather than as a fetched page.
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            format!(
                "GitHub returned {} without saying which release is newest.",
                response.status()
            )
        })?;

    tag_from_release_url(location)
        .map(Some)
        .ok_or_else(|| format!("GitHub sent an unexpected location: {location}"))
}

/// Ask the API, which knows the notes and the real page URL as well as the tag.
fn fetch_latest_via_api(
    client: &reqwest::blocking::Client,
    current: &str,
) -> Result<UpdateStatus, ApiFailure> {
    let response = client
        .get(LATEST_RELEASE)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", USER_AGENT)
        .send()
        .map_err(|err| ApiFailure::Other(format!("could not reach GitHub: {err}")))?;

    let status = response.status();

    // No releases yet is a normal state for a young repository, not a failure.
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(no_release(current));
    }

    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(ApiFailure::RateLimited);
    }

    if !status.is_success() {
        return Err(ApiFailure::Other(format!(
            "GitHub returned {status} for the latest release."
        )));
    }

    let body = response
        .text()
        .map_err(|err| ApiFailure::Other(format!("could not read the release response: {err}")))?;

    interpret(current, &body).map_err(ApiFailure::Other)
}

/// A status assembled from the tag alone, for when the API would add detail but will
/// not answer.
///
/// Nothing here is a guess: the tag came from GitHub's own redirect. The only thing
/// missing is the release notes and the timestamp.
fn status_from_tag(current: &str, tag: &str) -> UpdateStatus {
    let available = is_newer(current, tag);
    UpdateStatus {
        current: current.to_string(),
        latest: Some(tag.to_string()),
        available,
        release_url: Some(release_url_for(tag)),
        release_name: None,
        notes: None,
        published_at: None,
        detail: detail_for(current, tag, available),
    }
}

/// The status when the newest release is the one already running.
fn up_to_date(current: &str, latest: &str) -> UpdateStatus {
    UpdateStatus {
        current: current.to_string(),
        latest: Some(latest.to_string()),
        available: false,
        release_url: Some(release_url_for(latest)),
        release_name: None,
        notes: None,
        published_at: None,
        detail: detail_for(current, latest, false),
    }
}

/// Ask GitHub what the newest release is.
///
/// Two steps, cheapest first. The redirect answers the question the user is actually
/// asking — "is there something newer?" — and is not subject to the API's rate limit,
/// so the usual answer costs nothing at all. The API is consulted only once something
/// genuinely newer exists, to borrow the release notes; if it refuses even then, the
/// update is still reported, just without them.
fn fetch_latest(current: &str) -> Result<UpdateStatus, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        // The redirect is the answer here, not a step towards one.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|err| format!("could not build the HTTP client: {err}"))?;

    match latest_tag_from_redirect(&client) {
        // Nothing has ever been published, so there is no reason to spend a request
        // confirming it.
        Ok(None) => Ok(no_release(current)),

        // The usual answer, and the one that must never cost an API request.
        Ok(Some(tag)) if version_parts(current).is_some() && !is_newer(current, &tag) => {
            Ok(up_to_date(current, &tag))
        }

        // Something newer, or a tag that cannot be ordered against this build. The
        // notes are worth one request either way.
        Ok(Some(tag)) => match fetch_latest_via_api(&client, current) {
            Ok(status) => Ok(status),
            // The redirect has already established that a newer release exists, so
            // being refused costs the notes and nothing else.
            Err(ApiFailure::RateLimited) => Ok(status_from_tag(current, &tag)),
            Err(ApiFailure::Other(reason)) => Err(reason),
        },

        // The redirect could not answer, so the API is the only source left — and it
        // reports its own failures.
        Err(_) => match fetch_latest_via_api(&client, current) {
            Ok(status) => Ok(status),
            Err(ApiFailure::RateLimited) => Err(RATE_LIMITED.to_string()),
            Err(ApiFailure::Other(reason)) => Err(reason),
        },
    }
}

/// Ask GitHub what the newest release is.
///
/// The version comes from the bundle rather than from the caller, so the interface
/// cannot ask about a version the running binary is not.
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<UpdateStatus, String> {
    let current = app.package_info().version.to_string();

    // `reqwest::blocking` panics if it is driven from a runtime thread, so the request
    // runs on the blocking pool. Doing it inline would also freeze the window.
    tauri::async_runtime::spawn_blocking(move || fetch_latest(&current))
        .await
        .map_err(|err| format!("the update check did not finish: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parts_accepts_the_shapes_tags_actually_take() {
        assert_eq!(version_parts("1.2.3"), Some((1, 2, 3)));
        assert_eq!(version_parts("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(version_parts("V1.2.3"), Some((1, 2, 3)));
        assert_eq!(version_parts(" 1.2.3 "), Some((1, 2, 3)));
        // A short tag is not a different version from its zero-padded form.
        assert_eq!(version_parts("1.2"), Some((1, 2, 0)));
        assert_eq!(version_parts("1.2"), version_parts("1.2.0"));
        // Build metadata and prerelease suffixes are not part of the ordering.
        assert_eq!(version_parts("1.2.3-beta.1"), Some((1, 2, 3)));
        assert_eq!(version_parts("1.2.3+build.9"), Some((1, 2, 3)));
    }

    #[test]
    fn version_parts_refuses_what_it_cannot_order() {
        assert_eq!(version_parts(""), None);
        assert_eq!(version_parts("v"), None);
        assert_eq!(version_parts("latest"), None);
        assert_eq!(version_parts("1.x.3"), None);
    }

    #[test]
    fn newer_compares_numerically_not_lexically() {
        assert!(is_newer("1.0.0", "1.0.1"));
        assert!(is_newer("1.0.0", "1.1.0"));
        assert!(is_newer("1.0.0", "2.0.0"));
        // The case a string comparison gets wrong: "10" sorts before "9".
        assert!(is_newer("1.9.0", "1.10.0"));
        assert!(!is_newer("1.10.0", "1.9.0"));
    }

    #[test]
    fn newer_is_false_for_equal_and_older() {
        assert!(!is_newer("1.2.3", "1.2.3"));
        assert!(!is_newer("1.2.3", "v1.2.3"));
        assert!(!is_newer("1.2.3", "1.2.2"));
        assert!(!is_newer("2.0.0", "1.9.9"));
    }

    #[test]
    fn an_unparseable_version_never_reports_an_update() {
        // Failing towards "nothing to do" means a malformed tag cannot nag the user.
        assert!(!is_newer("1.0.0", "not-a-version"));
        assert!(!is_newer("not-a-version", "2.0.0"));
    }

    const RELEASE: &str = r#"{
        "tag_name": "v0.2.0",
        "name": "APRO Works 0.2.0",
        "html_url": "https://github.com/APRO-pk/APRO-works/releases/tag/v0.2.0",
        "body": "  What changed.  ",
        "published_at": "2026-02-01T10:00:00Z",
        "draft": false,
        "prerelease": false
    }"#;

    #[test]
    fn a_real_release_reports_an_update() {
        let status = interpret("0.1.1", RELEASE).unwrap();
        assert!(status.available);
        assert_eq!(status.latest.as_deref(), Some("v0.2.0"));
        assert_eq!(status.current, "0.1.1");
        assert_eq!(status.notes.as_deref(), Some("What changed."));
        assert!(status.detail.contains("0.2.0"));
        assert!(status.release_url.unwrap().contains("releases/tag"));
    }

    #[test]
    fn the_same_version_is_not_an_update() {
        let status = interpret("0.2.0", RELEASE).unwrap();
        assert!(!status.available);
        assert!(status.detail.contains("Up to date"));
    }

    #[test]
    fn a_newer_local_build_is_not_downgraded() {
        let status = interpret("0.3.0", RELEASE).unwrap();
        assert!(!status.available);
    }

    #[test]
    fn a_prerelease_is_never_announced() {
        let body = RELEASE.replace("\"prerelease\": false", "\"prerelease\": true");
        let status = interpret("0.1.0", &body).unwrap();
        assert!(!status.available);
        assert_eq!(status.latest, None, "a prerelease has no version to show");
        assert!(status.detail.contains("pre-release"));
    }

    #[test]
    fn a_draft_is_never_announced() {
        let body = RELEASE.replace("\"draft\": false", "\"draft\": true");
        assert!(!interpret("0.1.0", &body).unwrap().available);
    }

    #[test]
    fn long_notes_are_trimmed_for_the_preview() {
        let long = "x".repeat(MAX_NOTES + 500);
        let body = format!(
            r#"{{"tag_name":"v9.9.9","html_url":"u","body":"{long}","draft":false,"prerelease":false}}"#
        );
        let notes = interpret("0.1.0", &body).unwrap().notes.unwrap();
        assert_eq!(notes.chars().count(), MAX_NOTES + 1, "clipped plus an ellipsis");
        assert!(notes.ends_with('…'));
    }

    #[test]
    fn a_payload_that_is_not_a_release_is_an_error_not_a_crash() {
        assert!(interpret("0.1.0", "{\"message\":\"Not Found\"}").is_err());
        assert!(interpret("0.1.0", "<html>").is_err());
    }

    #[test]
    fn a_missing_html_url_falls_back_to_the_releases_page() {
        let body = r#"{"tag_name":"v9.9.9","draft":false,"prerelease":false}"#;
        assert_eq!(
            interpret("0.1.0", body).unwrap().release_url.as_deref(),
            Some(RELEASES_PAGE)
        );
    }

    #[test]
    fn no_releases_yet_is_a_state_not_an_error() {
        let status = no_release("0.1.1");
        assert!(!status.available);
        assert_eq!(status.current, "0.1.1");
        assert!(status.detail.contains("No releases"));
    }

    #[test]
    fn a_release_redirect_url_yields_its_tag() {
        assert_eq!(
            tag_from_release_url("https://github.com/APRO-pk/APRO-works/releases/tag/v0.3.0"),
            Some("v0.3.0".to_string())
        );
        // A query string or fragment is not part of the tag.
        assert_eq!(
            tag_from_release_url("https://github.com/APRO-pk/APRO-works/releases/tag/v0.3.0?x=1"),
            Some("v0.3.0".to_string())
        );
        assert_eq!(
            tag_from_release_url("https://github.com/APRO-pk/APRO-works/releases/tag/v0.3.0#top"),
            Some("v0.3.0".to_string())
        );
    }

    #[test]
    fn anything_that_is_not_a_release_tag_is_refused() {
        // The repo's releases index, a bare prefix, and nothing at all.
        assert_eq!(
            tag_from_release_url("https://github.com/APRO-pk/APRO-works/releases"),
            None
        );
        assert_eq!(
            tag_from_release_url("https://github.com/APRO-pk/APRO-works/releases/tag/"),
            None
        );
        assert_eq!(tag_from_release_url(""), None);
    }

    #[test]
    fn a_tag_alone_is_enough_to_report_an_update() {
        let status = status_from_tag("0.2.1", "v0.3.0");
        assert!(status.available);
        assert_eq!(status.latest.as_deref(), Some("v0.3.0"));
        // No notes is the honest answer: they were never fetched.
        assert_eq!(status.notes, None);
        assert_eq!(
            status.release_url.as_deref(),
            Some("https://github.com/APRO-pk/APRO-works/releases/tag/v0.3.0")
        );
        assert!(status.detail.contains("0.3.0"));
    }

    #[test]
    fn a_tag_alone_will_not_claim_an_update_it_cannot_justify() {
        // Same rule as `is_newer`: unorderable means silent, not "probably newer".
        let status = status_from_tag("not-a-version", "v0.3.0");
        assert!(!status.available);
        assert!(status.detail.contains("could not be read"));
    }

    #[test]
    fn an_up_to_date_answer_says_so_without_notes() {
        let status = up_to_date("0.3.0", "v0.3.0");
        assert!(!status.available);
        assert_eq!(status.latest.as_deref(), Some("v0.3.0"));
        assert!(status.detail.contains("Up to date"));
    }

    #[test]
    fn both_paths_phrase_the_same_state_the_same_way() {
        // The cheap path and the API path must not drift apart. `RELEASE` carries the
        // tag `v0.2.0`, so both are asked the same question about the same release.
        assert_eq!(
            status_from_tag("0.1.1", "v0.2.0").detail,
            interpret("0.1.1", RELEASE).unwrap().detail
        );
        assert_eq!(
            up_to_date("0.2.0", "v0.2.0").detail,
            interpret("0.2.0", RELEASE).unwrap().detail
        );
    }

    /// The one test that talks to GitHub.
    ///
    /// Ignored by default, because a test that needs the network fails on a plane.
    /// Run it deliberately:
    /// `cargo test -p apro-works --lib -- --ignored the_live_check`
    ///
    /// This is the only check that can tell the two paths apart in reality — the
    /// redirect-versus-API decision lives in the transport, and no pure function can
    /// be asked whether a request was actually avoided.
    #[test]
    #[ignore = "reaches github.com"]
    fn the_live_check_answers_without_spending_an_api_request() {
        // No published release can be newer than this, so the answer must come from the
        // redirect alone and must not touch the notes.
        let current = fetch_latest("999.0.0").expect("the redirect path should answer");
        assert!(!current.available);
        assert_eq!(current.notes, None, "the cheap path fetches no notes");
        assert!(
            current.latest.is_some(),
            "the redirect should have named the newest tag"
        );

        // The invariant that matters: an old build is told an update exists whether or
        // not the API is willing to hand over the notes.
        let old = fetch_latest("0.0.1").expect("the check should answer");
        assert!(old.available);
    }
}
