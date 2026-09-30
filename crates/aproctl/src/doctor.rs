//! `aproctl doctor` — validate a deployed store without mutating real data.
//!
//! Answers: is the store where it should be, can it be written, is it the schema this
//! build expects, is every blob intact, and is the API reachable and correctly secured.

use std::path::Path;

use apro_store::{schema::SCHEMA_VERSION, ArtifactFilter, EdgeFilter, Store, StoreConfig};

use crate::checks::{human_bytes, probe_writable, Check};

pub fn run(data_dir: &Path, endpoint: Option<&str>) -> Vec<Check> {
    let mut checks = Vec::new();

    checks.push(match probe_writable(data_dir) {
        Ok(()) => Check::pass(
            "data directory is writable",
            data_dir.to_string_lossy().to_string(),
        ),
        Err(err) => {
            // Without a writable data directory nothing else can be trusted.
            checks.push(Check::fail("data directory is writable", err));
            return checks;
        }
    });

    let store = match Store::open(StoreConfig::new(data_dir)) {
        Ok(store) => {
            checks.push(Check::pass("store opens", "SQLite opened and migrations applied"));
            store
        }
        Err(err) => {
            checks.push(Check::fail("store opens", err.to_string()));
            return checks;
        }
    };

    checks.push(match store.stats() {
        Ok(stats) if stats.schema_version == SCHEMA_VERSION => Check::pass(
            "schema version",
            format!("v{} matches this build", stats.schema_version),
        ),
        Ok(stats) => Check::fail(
            "schema version",
            format!(
                "store is v{} but this build expects v{SCHEMA_VERSION}; \
                 the store was written by a different version of APRO Works",
                stats.schema_version
            ),
        ),
        Err(err) => Check::fail("schema version", err.to_string()),
    });

    checks.push(match store.stats() {
        Ok(stats) if !stats.node_id.is_empty() => Check::pass(
            "node identity",
            format!("node_id {}", stats.node_id),
        ),
        Ok(_) => Check::fail("node identity", "node_id is empty"),
        Err(err) => Check::fail("node identity", err.to_string()),
    });

    checks.push(match store.blobs().ensure() {
        Ok(()) => Check::pass(
            "blob store is writable",
            store.blobs().root().to_string_lossy().to_string(),
        ),
        Err(err) => Check::fail("blob store is writable", err.to_string()),
    });

    checks.push(match store.verify_blobs() {
        Ok(problems) if problems.is_empty() => {
            Check::pass("blob integrity", "every referenced blob is present and hash-valid")
        }
        Ok(problems) => Check::fail(
            "blob integrity",
            format!("{} problem(s): {}", problems.len(), problems.join("; ")),
        ),
        Err(err) => Check::fail("blob integrity", err.to_string()),
    });

    // Informational: demo data is safe to leave, but the operator should know it is there.
    let demo = store
        .list_artifacts(&ArtifactFilter {
            include_demo: true,
            ..Default::default()
        })
        .map(|artifacts| artifacts.iter().filter(|a| a.is_demo()).count())
        .unwrap_or(0);
    checks.push(if demo == 0 {
        Check::pass("demo data", "no seeded dummy data present")
    } else {
        Check::warn(
            "demo data",
            format!("{demo} seeded artifact(s) present; remove with `aproctl purge-demo`"),
        )
    });

    match store.list_edges(&EdgeFilter::default()) {
        Ok(edges) => {
            let stale = edges.iter().filter(|e| e.stale).count();
            checks.push(if stale == 0 {
                Check::pass("dependency graph", format!("{} edge(s), none stale", edges.len()))
            } else {
                Check::warn(
                    "dependency graph",
                    format!(
                        "{} edge(s), {stale} stale — consumers are out of date with their producers",
                        edges.len()
                    ),
                )
            });
        }
        Err(err) => checks.push(Check::fail("dependency graph", err.to_string())),
    }

    if let Ok(stats) = store.stats() {
        checks.push(Check::pass(
            "store contents",
            format!(
                "{} artifact(s), {} revision(s), {} edge(s), {} blob(s) ({})",
                stats.artifacts,
                stats.revisions,
                stats.edges,
                stats.blob_count,
                human_bytes(stats.blob_bytes)
            ),
        ));
    }

    if let Some(endpoint) = endpoint {
        checks.extend(probe_endpoint(endpoint));
    } else {
        checks.push(Check::warn(
            "api endpoint",
            "not checked; pass --endpoint http://127.0.0.1:PORT to verify the running API",
        ));
    }

    checks
}

fn probe_endpoint(endpoint: &str) -> Vec<Check> {
    let mut checks = Vec::new();
    let url = format!("{}/v1/health", endpoint.trim_end_matches('/'));

    let response = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .and_then(|client| client.get(&url).send())
    {
        Ok(response) => response,
        Err(err) => {
            checks.push(Check::fail(
                "api endpoint reachable",
                format!("{url} is unreachable: {err}"),
            ));
            return checks;
        }
    };

    if !response.status().is_success() {
        checks.push(Check::fail(
            "api endpoint reachable",
            format!("{url} returned HTTP {}", response.status()),
        ));
        return checks;
    }

    let body: serde_json::Value = match response.json() {
        Ok(body) => body,
        Err(err) => {
            checks.push(Check::fail(
                "api endpoint reachable",
                format!("health response was not valid JSON: {err}"),
            ));
            return checks;
        }
    };

    checks.push(Check::pass(
        "api endpoint reachable",
        format!("{url} -> status {}", body["status"]),
    ));

    match body["insecure_auth"].as_bool() {
        Some(false) => checks.push(Check::pass(
            "api authentication",
            "launch tickets are required (secure mode)",
        )),
        Some(true) => checks.push(Check::warn(
            "api authentication",
            "the API is running with --insecure: any token is accepted. \
             Never do this on a store holding real data.",
        )),
        None => checks.push(Check::warn(
            "api authentication",
            "the health response did not report an auth mode",
        )),
    }

    checks
}
