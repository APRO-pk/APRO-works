//! `aproctl` — operator CLI for the APRO Works orchestration store.
//!
//! Two commands matter most:
//!
//! * `aproctl doctor`   — validate a deployed store and a running API. Read-only.
//! * `aproctl selftest` — exercise every storage semantic end to end on a throwaway
//!                        store, so you can prove a deployment actually works.
//!
//! Run `aproctl doctor --json` in CI to fail a pipeline on a broken deployment.

mod checks;
mod doctor;
mod local_client;
mod selftest;

use std::net::IpAddr;
use std::path::PathBuf;
use std::time::Duration;

use clap::{Parser, Subcommand};

use apro_api::{AuthRegistry, ServerConfig};
use apro_store::{
    demo, ArtifactFilter, EdgeFilter, Store, StoreConfig, DEFAULT_SEED_BATCH,
};

use checks::{all_passed, human_bytes, print_json, print_report, Check};

#[derive(Parser)]
#[command(
    name = "aproctl",
    about = "Operate and validate the APRO Works orchestration store.",
    version
)]
struct Cli {
    /// Store data directory. Defaults to %LOCALAPPDATA%\APRO\Store.
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the store API in the foreground (standalone, without the hub).
    Serve {
        /// Port to bind. 0 lets the OS choose a free one.
        #[arg(long, default_value_t = 0)]
        port: u16,
        /// Loopback address to bind.
        #[arg(long, default_value = "127.0.0.1")]
        bind: String,
        /// Disable authentication entirely. Development only.
        #[arg(long)]
        insecure: bool,
        /// Issue a session token for this app and print it, then keep serving.
        #[arg(long)]
        session_for: Option<String>,
    },

    /// Insert the removable dummy dataset.
    Seed {
        /// Batch marker. Everything written by a batch can be removed in one call.
        #[arg(long, default_value = "demo-v1")]
        batch: String,
        /// Rebuild the batch even if it is already present.
        #[arg(long)]
        force: bool,
    },

    /// Remove dummy data. Real data is never eligible.
    #[command(name = "purge-demo")]
    PurgeDemo {
        /// Batch to remove. Defaults to the standard demo batch.
        #[arg(long)]
        batch: Option<String>,
        /// Remove every seeded batch, whatever its name.
        #[arg(long)]
        all: bool,
    },

    /// Validate a deployed store (and optionally a running API). Read-only.
    Doctor {
        /// Also probe a running API, e.g. http://127.0.0.1:5555.
        #[arg(long)]
        endpoint: Option<String>,
        /// Machine-readable output for CI.
        #[arg(long)]
        json: bool,
    },

    /// Exercise every storage semantic end to end on a throwaway store.
    Selftest {
        /// Run against the real data directory instead of a temporary one.
        #[arg(long)]
        keep: bool,
        /// Machine-readable output for CI.
        #[arg(long)]
        json: bool,
    },

    /// List artifacts.
    Ls {
        /// Filter by type, e.g. burn-geometry-modeler/grain-geometry.
        #[arg(long = "type")]
        type_id: Option<String>,
        /// Include seeded dummy data.
        #[arg(long)]
        include_demo: bool,
    },

    /// List dependency edges, with their freshness.
    Edges {
        /// Only show edges that are out of date.
        #[arg(long)]
        stale: bool,
    },

    /// Show the change log.
    Events {
        #[arg(long, default_value_t = 0)]
        since: i64,
        #[arg(long, default_value_t = 50)]
        limit: u32,
    },

    /// Show store counters.
    Stats,
}

fn resolve_data_dir(explicit: Option<PathBuf>) -> Result<PathBuf, String> {
    match explicit {
        Some(dir) => Ok(dir),
        None => apro_store::default_data_dir().map_err(|err| err.to_string()),
    }
}

fn open_store(data_dir: &PathBuf) -> Result<Store, String> {
    Store::open(StoreConfig::new(data_dir)).map_err(|err| err.to_string())
}

fn main() {
    let cli = Cli::parse();

    let result = match cli.command {
        Command::Doctor { endpoint, json } => {
            run_doctor(cli.data_dir, endpoint, json)
        }
        Command::Selftest { keep, json } => run_selftest(cli.data_dir, keep, json),
        command => {
            let data_dir = match resolve_data_dir(cli.data_dir) {
                Ok(dir) => dir,
                Err(err) => {
                    eprintln!("error: {err}");
                    std::process::exit(2);
                }
            };
            match command {
                Command::Serve {
                    port,
                    bind,
                    insecure,
                    session_for,
                } => run_serve(data_dir, port, bind, insecure, session_for),
                Command::Seed { batch, force } => run_seed(&data_dir, &batch, force),
                Command::PurgeDemo { batch, all } => run_purge(&data_dir, batch, all),
                Command::Ls {
                    type_id,
                    include_demo,
                } => run_ls(&data_dir, type_id, include_demo),
                Command::Edges { stale } => run_edges(&data_dir, stale),
                Command::Events { since, limit } => run_events(&data_dir, since, limit),
                Command::Stats => run_stats(&data_dir),
                Command::Doctor { .. } | Command::Selftest { .. } => unreachable!(),
            }
        }
    };

    if let Err(err) = result {
        eprintln!("error: {err}");
        std::process::exit(2);
    }
}

fn finish(checks: &[Check], json: bool) {
    if json {
        print_json(checks);
    }
    if !all_passed(checks) {
        std::process::exit(1);
    }
}

fn run_doctor(explicit: Option<PathBuf>, endpoint: Option<String>, json: bool) -> Result<(), String> {
    let data_dir = resolve_data_dir(explicit)?;
    let checks = doctor::run(&data_dir, endpoint.as_deref());
    if !json {
        print_report(&format!("aproctl doctor — {}", data_dir.display()), &checks);
        println!();
    }
    finish(&checks, json);
    Ok(())
}

fn run_selftest(explicit: Option<PathBuf>, keep: bool, json: bool) -> Result<(), String> {
    let temp;
    let data_dir = if keep {
        resolve_data_dir(explicit)?
    } else {
        temp = tempfile::tempdir().map_err(|err| format!("cannot create a temp store: {err}"))?;
        temp.path().to_path_buf()
    };

    let checks = selftest::run(&data_dir);
    if !json {
        let title = if keep {
            format!("aproctl selftest — {} (live data directory)", data_dir.display())
        } else {
            "aproctl selftest — throwaway store".to_string()
        };
        print_report(&title, &checks);
        println!();
    }
    finish(&checks, json);
    Ok(())
}

fn run_serve(
    data_dir: PathBuf,
    port: u16,
    bind: String,
    insecure: bool,
    session_for: Option<String>,
) -> Result<(), String> {
    let bind: IpAddr = bind
        .parse()
        .map_err(|_| format!("invalid --bind address: {bind:?}"))?;
    if !bind.is_loopback() {
        return Err(format!(
            "refusing to bind {bind}: the store API must stay on loopback in this release"
        ));
    }

    let store = open_store(&data_dir)?;
    let auth = if insecure {
        AuthRegistry::new_insecure()
    } else {
        AuthRegistry::new()
    };

    let runtime = tokio::runtime::Runtime::new().map_err(|err| err.to_string())?;
    let server = runtime
        .block_on(apro_api::spawn(
            store,
            auth.clone(),
            ServerConfig {
                bind,
                port,
                ..Default::default()
            },
        ))
        .map_err(|err| format!("failed to bind {bind}:{port}: {err}"))?;

    println!("aproctl serve");
    println!("  endpoint : {}", server.endpoint);
    println!("  data dir : {}", data_dir.display());
    if insecure {
        println!("  auth     : INSECURE — any bearer token is accepted");
        println!();
        println!("  WARNING: never run --insecure against a store holding real data.");
    } else {
        println!("  auth     : launch-ticket (secure)");
    }

    if let Some(app) = &session_for {
        if insecure {
            return Err("--session-for has no effect with --insecure".into());
        }
        let session = auth.issue_session_direct(app, &["*"], 24 * 60 * 60);
        println!();
        println!("  session for {app} (valid 24h):");
        println!("    export APRO_SESSION={}", session.session_token);
        println!("    curl -H \"Authorization: Bearer ${}\" {}/v1/stats", "APRO_SESSION", server.endpoint);
    }

    println!();
    println!("Press Ctrl+C to stop.");

    // Keep the server alive. `RunningServer` stays in scope; the loop never returns.
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

fn run_seed(data_dir: &PathBuf, batch: &str, force: bool) -> Result<(), String> {
    let store = open_store(data_dir)?;
    let report = demo::seed(&store, batch, force).map_err(|err| err.to_string())?;

    println!("aproctl seed");
    println!("  data dir  : {}", data_dir.display());
    println!("  batch     : {}", report.batch);
    if report.already_present {
        println!("  result    : already present (use --force to rebuild)");
    } else {
        println!("  artifacts : {}", report.artifacts);
        println!("  revisions : {}", report.revisions);
        println!("  edges     : {}", report.edges);
        println!("  stale edges: {}", report.stale_edges);
    }
    for note in &report.notes {
        println!("  note      : {note}");
    }
    println!();
    println!(
        "Everything above is removable with `aproctl purge-demo --batch {}`.",
        report.batch
    );
    Ok(())
}

fn run_purge(data_dir: &PathBuf, batch: Option<String>, all: bool) -> Result<(), String> {
    let store = open_store(data_dir)?;
    let target = if all {
        None
    } else {
        Some(batch.unwrap_or_else(|| DEFAULT_SEED_BATCH.to_string()))
    };

    let report = store.purge_demo(target.as_deref()).map_err(|err| err.to_string())?;

    println!("aproctl purge-demo");
    println!("  data dir  : {}", data_dir.display());
    println!(
        "  batch     : {}",
        target.clone().unwrap_or_else(|| "<all seeded batches>".into())
    );
    println!("  artifacts : {}", report.artifacts);
    println!("  revisions : {}", report.revisions);
    println!("  edges     : {}", report.edges);
    println!("  events    : {}", report.events);
    println!("  blobs     : {} ({})", report.blobs_removed, human_bytes(report.bytes_freed));

    if report.total_rows() == 0 {
        println!();
        println!("Nothing matched; no dummy data of that batch was present.");
    } else {
        println!();
        println!("Real data was not touched: only artifacts carrying a seed marker");
        println!("or living in the reserved apro-demo/ namespace are eligible.");
    }
    Ok(())
}

fn run_ls(data_dir: &PathBuf, type_id: Option<String>, include_demo: bool) -> Result<(), String> {
    let store = open_store(data_dir)?;
    let artifacts = store
        .list_artifacts(&ArtifactFilter {
            type_id,
            include_demo,
            ..Default::default()
        })
        .map_err(|err| err.to_string())?;

    if artifacts.is_empty() {
        println!("No artifacts.");
        if !include_demo {
            println!("(seeded dummy data is hidden by default; pass --include-demo)");
        }
        return Ok(());
    }

    println!(
        "{:<44} {:<20} {:>4} {:>5}  {}",
        "TYPE", "INSTANCE", "REV", "REVS", "MARKER"
    );
    for artifact in &artifacts {
        println!(
            "{:<44} {:<20} {:>4} {:>5}  {}",
            artifact.type_id,
            truncate(&artifact.instance, 20),
            artifact
                .current_revision_number
                .map(|n| n.to_string())
                .unwrap_or_else(|| "-".into()),
            artifact.revision_count,
            artifact.seed_batch.clone().unwrap_or_default(),
        );
    }
    println!("\n{} artifact(s)", artifacts.len());
    Ok(())
}

fn run_edges(data_dir: &PathBuf, stale_only: bool) -> Result<(), String> {
    let store = open_store(data_dir)?;
    let edges = store
        .list_edges(&EdgeFilter {
            stale: if stale_only { Some(true) } else { None },
            ..Default::default()
        })
        .map_err(|err| err.to_string())?;

    if edges.is_empty() {
        println!("No dependency edges.");
        return Ok(());
    }

    println!(
        "{:<24} {:<14} {:<44} {:<12} {:>6} {:>6} {}",
        "CONSUMER", "REF", "TYPE", "MODE", "SAT", "CUR", "STATE"
    );
    for edge in &edges {
        println!(
            "{:<24} {:<14} {:<44} {:<12} {:>6} {:>6} {}",
            truncate(&edge.consumer_app, 24),
            truncate(edge.consumer_ref.as_deref().unwrap_or("-"), 14),
            truncate(&edge.type_id, 44),
            edge.mode.as_str(),
            edge.last_satisfied_revision_number
                .map(|n| n.to_string())
                .unwrap_or_else(|| "-".into()),
            edge.current_revision_number
                .map(|n| n.to_string())
                .unwrap_or_else(|| "-".into()),
            if edge.stale { "STALE" } else { "fresh" },
        );
    }
    println!(
        "\n{} edge(s), {} stale",
        edges.len(),
        edges.iter().filter(|e| e.stale).count()
    );
    Ok(())
}

fn run_events(data_dir: &PathBuf, since: i64, limit: u32) -> Result<(), String> {
    let store = open_store(data_dir)?;
    let events = store.events(since, limit).map_err(|err| err.to_string())?;

    if events.is_empty() {
        println!("No events since {since}.");
        return Ok(());
    }
    for event in &events {
        println!(
            "{:>6}  {:<18} {:<10} {}",
            event.seq,
            event.kind,
            event.actor_app.as_deref().unwrap_or("-"),
            event.summary.as_deref().unwrap_or("")
        );
    }
    println!(
        "\n{} event(s); next cursor {}",
        events.len(),
        store.cursor().map_err(|err| err.to_string())?
    );
    Ok(())
}

fn run_stats(data_dir: &PathBuf) -> Result<(), String> {
    let store = open_store(data_dir)?;
    let stats = store.stats().map_err(|err| err.to_string())?;

    println!("aproctl stats");
    println!("  data dir        : {}", stats.data_dir);
    println!("  node id         : {}", stats.node_id);
    println!("  schema version  : {}", stats.schema_version);
    println!("  artifacts       : {}", stats.artifacts);
    println!("    of which demo : {}", stats.demo_artifacts);
    println!("  revisions       : {}", stats.revisions);
    println!("  edges           : {} ({} stale)", stats.edges, stats.stale_edges);
    println!("  events          : {} (cursor {})", stats.events, stats.cursor);
    println!(
        "  inline payloads : {}",
        human_bytes(stats.inline_bytes)
    );
    println!(
        "  blobs           : {} ({})",
        stats.blob_count,
        human_bytes(stats.blob_bytes)
    );
    Ok(())
}

/// Small helper so table columns stay aligned without pulling in a table crate.
fn truncate(value: &str, width: usize) -> String {
    if value.chars().count() <= width {
        value.to_string()
    } else {
        let mut out: String = value.chars().take(width.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}
