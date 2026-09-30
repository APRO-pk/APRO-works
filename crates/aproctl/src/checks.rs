//! Shared check/report plumbing for `doctor` and `selftest`.

use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Pass,
    Warn,
    Fail,
}

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub name: String,
    pub status: CheckStatus,
    pub detail: String,
}

impl Check {
    pub fn pass(name: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            status: CheckStatus::Pass,
            detail: detail.into(),
        }
    }

    pub fn warn(name: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            status: CheckStatus::Warn,
            detail: detail.into(),
        }
    }

    pub fn fail(name: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            status: CheckStatus::Fail,
            detail: detail.into(),
        }
    }
}

pub fn count(checks: &[Check], status: CheckStatus) -> usize {
    checks.iter().filter(|c| c.status == status).count()
}

pub fn all_passed(checks: &[Check]) -> bool {
    count(checks, CheckStatus::Fail) == 0
}

pub fn print_report(title: &str, checks: &[Check]) {
    println!("\n{title}");
    println!("{}", "-".repeat(title.len().min(72)));
    for check in checks {
        let marker = match check.status {
            CheckStatus::Pass => "PASS",
            CheckStatus::Warn => "WARN",
            CheckStatus::Fail => "FAIL",
        };
        println!("  [{marker}] {}", check.name);
        if !check.detail.is_empty() {
            println!("         {}", check.detail);
        }
    }
    println!(
        "\n  {} passed, {} warning(s), {} failed",
        count(checks, CheckStatus::Pass),
        count(checks, CheckStatus::Warn),
        count(checks, CheckStatus::Fail),
    );
}

pub fn print_json(checks: &[Check]) {
    let payload = serde_json::json!({
        "ok": all_passed(checks),
        "passed": count(checks, CheckStatus::Pass),
        "warnings": count(checks, CheckStatus::Warn),
        "failed": count(checks, CheckStatus::Fail),
        "checks": checks,
    });
    println!("{}", serde_json::to_string_pretty(&payload).unwrap_or_default());
}

/// Verify a directory is genuinely writable by writing and reading a probe file.
/// `exists()` alone does not prove writability.
pub fn probe_writable(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|err| format!("cannot create {}: {err}", dir.display()))?;
    let probe = dir.join(format!(".aproctl-write-probe-{}", std::process::id()));
    std::fs::write(&probe, b"aproctl").map_err(|err| format!("cannot write to {}: {err}", dir.display()))?;
    let read_back =
        std::fs::read(&probe).map_err(|err| format!("cannot read back from {}: {err}", dir.display()))?;
    let _ = std::fs::remove_file(&probe);
    if read_back != b"aproctl" {
        return Err(format!("{} did not round-trip a probe write", dir.display()));
    }
    Ok(())
}

pub fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KiB", "MiB", "GiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}
