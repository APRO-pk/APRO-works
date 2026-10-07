use reqwest::blocking::{Client, Response};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::{copy, Cursor, Read},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use zip::ZipArchive;

mod storage_sync;
mod store_host;
mod update;

use store_host::{StoreHost, StoreStatus};

const LAUNCH_TICKET_TTL: Duration = Duration::from_secs(90);

#[derive(Serialize)]
struct ProductStatus {
    installed: bool,
    update_available: bool,
    install_dir: String,
    executable_path: String,
}

#[derive(Serialize, Deserialize)]
struct ProductInstallReceipt {
    source_url: String,
    etag: Option<String>,
    last_modified: Option<String>,
    content_length: Option<u64>,
    local_modified_epoch_ms: Option<u128>,
}

#[derive(Clone)]
struct ArchiveSignature {
    etag: Option<String>,
    last_modified: Option<String>,
    content_length: Option<u64>,
    local_modified_epoch_ms: Option<u128>,
}

#[derive(Clone, Serialize)]
struct ProductProgress {
    slug: String,
    phase: String,
    progress: u8,
    message: String,
}

#[derive(Serialize, Deserialize)]
struct LaunchTicket {
    token: String,
    product_slug: String,
    expires_at_epoch_ms: u128,
}

fn apro_products_dir() -> Result<PathBuf, String> {
    let local_data = dirs::data_local_dir().ok_or("Unable to locate local app data directory")?;
    Ok(local_data.join("APRO").join("Products"))
}

fn launch_tickets_dir() -> Result<PathBuf, String> {
    let local_data = dirs::data_local_dir().ok_or("Unable to locate local app data directory")?;
    Ok(local_data.join("APRO").join("LaunchTickets"))
}

fn product_install_dir(slug: &str) -> Result<PathBuf, String> {
    Ok(apro_products_dir()?.join(slug))
}

fn product_executable_path(slug: &str, exe_path: &str) -> Result<PathBuf, String> {
    Ok(product_install_dir(slug)?.join(Path::new(exe_path)))
}

fn product_receipt_path(slug: &str) -> Result<PathBuf, String> {
    Ok(product_install_dir(slug)?.join(".apro-install.json"))
}

fn current_epoch_millis() -> Result<u128, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("System clock error: {err}"))?
        .as_millis())
}

fn common_root_component(paths: &[PathBuf]) -> Option<String> {
    let first = paths.first()?.components().next()?;
    let Component::Normal(root) = first else {
        return None;
    };

    let root = root.to_string_lossy().to_string();
    if paths.iter().all(|path| {
        let mut components = path.components();
        matches!(components.next(), Some(Component::Normal(part)) if part.to_string_lossy() == root)
            && components.next().is_some()
    }) {
        Some(root)
    } else {
        None
    }
}

fn emit_progress(app: &AppHandle, payload: ProductProgress) {
    let _ = app.emit("product-progress", payload);
}

fn download_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("APRO-Hub/0.1")
        .build()
        .map_err(|err| format!("Failed to prepare download client: {err}"))
}

fn decode_html_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&#x2F;", "/")
        .replace("&#47;", "/")
        .replace("&quot;", "\"")
}

fn extract_mediafire_download_url(html: &str) -> Option<String> {
    let marker = "id=\"downloadButton\"";
    let marker_index = html.find(marker)?;
    let anchor_start = html[..marker_index].rfind("<a ")?;
    let href_start = html[anchor_start..marker_index].find("href=\"")? + anchor_start + 6;
    let href_end = html[href_start..].find('"')? + href_start;
    Some(decode_html_entities(&html[href_start..href_end]))
}

fn is_local_archive_path(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }

    let path = Path::new(trimmed);
    path.is_absolute() || path.exists()
}

fn file_modified_epoch_ms(path: &Path) -> Result<u128, String> {
    Ok(fs::metadata(path)
        .map_err(|err| format!("Failed to read archive metadata for {}: {err}", path.display()))?
        .modified()
        .map_err(|err| format!("Failed to read archive modified time for {}: {err}", path.display()))?
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("Archive modified time is invalid for {}: {err}", path.display()))?
        .as_millis())
}

fn resolve_local_archive_signature(path: &Path) -> Result<ArchiveSignature, String> {
    let metadata =
        fs::metadata(path).map_err(|err| format!("Failed to inspect local archive {}: {err}", path.display()))?;

    Ok(ArchiveSignature {
        etag: None,
        last_modified: None,
        content_length: Some(metadata.len()),
        local_modified_epoch_ms: Some(file_modified_epoch_ms(path)?),
    })
}

fn resolve_download_response(client: &Client, url: &str) -> Result<Response, String> {
    if url.contains("mediafire.com/file/") {
        let html = client
            .get(url)
            .send()
            .map_err(|err| format!("Failed to open MediaFire share link: {err}"))?
            .error_for_status()
            .map_err(|err| format!("Failed to open MediaFire share link: {err}"))?
            .text()
            .map_err(|err| format!("Failed to read MediaFire page: {err}"))?;

        let download_url = extract_mediafire_download_url(&html)
            .ok_or("Unable to resolve MediaFire download link from the shared page.")?;

        return client
            .get(download_url)
            .send()
            .map_err(|err| format!("Failed to download MediaFire file: {err}"))?
            .error_for_status()
            .map_err(|err| format!("Failed to download MediaFire file: {err}"));
    }

    if is_local_archive_path(url) {
        return Err("Local archives do not use HTTP download responses.".into());
    }

    client
        .get(url)
        .send()
        .map_err(|err| format!("Failed to download product archive: {err}"))?
        .error_for_status()
        .map_err(|err| format!("Failed to download product archive: {err}"))
}

fn response_signature(response: &Response) -> ArchiveSignature {
    let headers = response.headers();
    ArchiveSignature {
        etag: headers
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_string()),
        last_modified: headers
            .get(reqwest::header::LAST_MODIFIED)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_string()),
        content_length: response.content_length(),
        local_modified_epoch_ms: None,
    }
}

fn resolve_archive_signature(client: &Client, url: &str) -> Result<ArchiveSignature, String> {
    if is_local_archive_path(url) {
        return resolve_local_archive_signature(Path::new(url));
    }

    if url.contains("mediafire.com/file/") {
        let html = client
            .get(url)
            .send()
            .map_err(|err| format!("Failed to open MediaFire share link: {err}"))?
            .error_for_status()
            .map_err(|err| format!("Failed to open MediaFire share link: {err}"))?
            .text()
            .map_err(|err| format!("Failed to read MediaFire page: {err}"))?;

        let download_url = extract_mediafire_download_url(&html)
            .ok_or("Unable to resolve MediaFire download link from the shared page.")?;

        let response = client
            .head(&download_url)
            .send()
            .map_err(|err| format!("Failed to inspect MediaFire file: {err}"))?
            .error_for_status()
            .map_err(|err| format!("Failed to inspect MediaFire file: {err}"))?;

        return Ok(response_signature(&response));
    }

    let response = client
        .head(url)
        .send()
        .map_err(|err| format!("Failed to inspect product archive: {err}"))?
        .error_for_status()
        .map_err(|err| format!("Failed to inspect product archive: {err}"))?;

    Ok(response_signature(&response))
}

fn signatures_match(local: &ProductInstallReceipt, remote: &ArchiveSignature) -> bool {
    if let (Some(local_modified_epoch_ms), Some(remote_modified_epoch_ms)) =
        (local.local_modified_epoch_ms, remote.local_modified_epoch_ms)
    {
        return local_modified_epoch_ms == remote_modified_epoch_ms
            && local.content_length == remote.content_length;
    }

    if let (Some(local_etag), Some(remote_etag)) = (&local.etag, &remote.etag) {
        return local_etag == remote_etag;
    }

    if let (Some(local_modified), Some(remote_modified)) = (&local.last_modified, &remote.last_modified) {
        return local_modified == remote_modified;
    }

    if let (Some(local_size), Some(remote_size)) = (local.content_length, remote.content_length) {
        return local_size == remote_size;
    }

    false
}

fn cleanup_expired_launch_tickets() -> Result<(), String> {
    let tickets_dir = launch_tickets_dir()?;
    if !tickets_dir.exists() {
        return Ok(());
    }

    let now = current_epoch_millis()?;
    for entry in fs::read_dir(&tickets_dir).map_err(|err| format!("Failed to inspect launch tickets: {err}"))? {
        let entry = entry.map_err(|err| format!("Failed to inspect launch tickets: {err}"))?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let Ok(contents) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(ticket) = serde_json::from_str::<LaunchTicket>(&contents) else {
            continue;
        };

        if ticket.expires_at_epoch_ms <= now {
            let _ = fs::remove_file(path);
        }
    }

    Ok(())
}

/// Persist a launch ticket that the store's auth registry has already minted.
///
/// The token is produced by `StoreHost`, not here, so the value written to disk is the
/// same one the API accepts when the product later exchanges it for a session. Previously
/// this function invented a token that nothing ever validated.
fn write_launch_ticket(slug: &str, token: &str, ttl: Duration) -> Result<(), String> {
    cleanup_expired_launch_tickets()?;

    let tickets_dir = launch_tickets_dir()?;
    fs::create_dir_all(&tickets_dir).map_err(|err| format!("Failed to prepare launch ticket directory: {err}"))?;

    let now = current_epoch_millis()?;
    let ticket = LaunchTicket {
        token: token.to_string(),
        product_slug: slug.to_string(),
        expires_at_epoch_ms: now + ttl.as_millis(),
    };

    let ticket_path = tickets_dir.join(format!("{token}.json"));
    let contents =
        serde_json::to_vec_pretty(&ticket).map_err(|err| format!("Failed to serialize launch ticket: {err}"))?;
    fs::write(&ticket_path, contents).map_err(|err| format!("Failed to write launch ticket: {err}"))?;

    Ok(())
}

fn stop_running_product_process(executable_path: &Path) -> Result<(), String> {
    if !executable_path.exists() {
        return Ok(());
    }

    let exe_name = executable_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Unable to resolve executable name for {}", executable_path.display()))?;

    let status = Command::new("taskkill")
        .args(["/IM", exe_name, "/F", "/T"])
        .status()
        .map_err(|err| format!("Failed to stop running product process {exe_name}: {err}"))?;

    if status.success() || matches!(status.code(), Some(128) | Some(255)) {
        Ok(())
    } else {
        Err(format!(
            "Unable to stop running product process {exe_name} before replacing installed files."
        ))
    }
}

/// Where each phase sits on the progress bar.
///
/// These bands are the contract between this side and the progress bar, and they have
/// to be non-overlapping and never decreasing. They were not: the "extracting" step
/// announced 74 and the first archive entry then reported 70, so at exactly the moment
/// a user was watching, the bar jumped backwards. Every constant and formula below is
/// covered by `the_whole_sequence_only_ever_moves_forward`, which is the test that
/// would have caught it.
mod band {
    /// Nothing received yet. Not zero: a bar that sits at 0 looks stalled.
    pub const DOWNLOAD_START: u8 = 1;
    pub const DOWNLOAD_END: u8 = 70;
    /// Stopping a running copy and clearing the previous install.
    pub const PREPARE: u8 = 71;
    pub const EXTRACT_START: u8 = 72;
    pub const EXTRACT_END: u8 = 99;
    pub const READY: u8 = 100;

    /// Progress across the download band.
    ///
    /// An unknown total stays at the start of the band rather than pretending to
    /// advance, and a server that over-reports cannot push past the end of it.
    pub fn download(done: u64, total: Option<u64>) -> u8 {
        match total {
            Some(total) if total > 0 => {
                let span = u64::from(DOWNLOAD_END - DOWNLOAD_START);
                DOWNLOAD_START + (done.saturating_mul(span) / total).min(span) as u8
            }
            _ => DOWNLOAD_START,
        }
    }

    /// Progress across the extract band.
    ///
    /// Counted over **files**, not archive entries: a directory is created instantly,
    /// so counting them made a zip with many folders appear to stall through its first
    /// half and then lurch.
    pub fn extract(files_done: usize, files_total: usize) -> u8 {
        if files_total == 0 {
            return EXTRACT_START;
        }
        let span = u64::from(EXTRACT_END - EXTRACT_START);
        let done = (files_done as u64).min(files_total as u64);
        EXTRACT_START + (done.saturating_mul(span) / files_total as u64) as u8
    }
}

/// Slugs with an install in flight.
///
/// Installs of *different* products are independent and run concurrently — the user
/// asked for that. Two installs of the *same* product would both clear and rewrite the
/// same directory, so the second is refused rather than allowed to corrupt the first.
fn installs_in_flight() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Releases the slot however the install ends, including on an early return or a panic.
struct InstallSlot(String);

impl Drop for InstallSlot {
    fn drop(&mut self) {
        if let Ok(mut set) = installs_in_flight().lock() {
            set.remove(&self.0);
        }
    }
}

fn claim_install_slot(slug: &str) -> Result<InstallSlot, String> {
    let mut set = installs_in_flight()
        .lock()
        .map_err(|_| "The install registry is unavailable.".to_string())?;
    if !set.insert(slug.to_string()) {
        return Err(format!("{slug} is already being installed."));
    }
    Ok(InstallSlot(slug.to_string()))
}

/// Read a response body, reporting progress across the download band.
fn read_body_with_progress(
    app: &AppHandle,
    slug: &str,
    response: &mut Response,
) -> Result<Vec<u8>, String> {
    let total = response.content_length();
    // Pre-sizing is a hint, not a promise: a wrong or hostile Content-Length must not
    // make this allocate gigabytes up front.
    let hint = total.unwrap_or(0).min(512 * 1024 * 1024) as usize;
    let mut bytes = Vec::with_capacity(hint);
    let mut buffer = [0_u8; 512 * 1024];
    let mut downloaded = 0_u64;
    let mut last_emitted = band::DOWNLOAD_START;
    let mut last_emit_at = Instant::now();

    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|err| format!("Failed to read product archive: {err}"))?;
        if read == 0 {
            break;
        }

        bytes.extend_from_slice(&buffer[..read]);
        downloaded += read as u64;

        let progress = band::download(downloaded, total);
        if progress > last_emitted || last_emit_at.elapsed() >= Duration::from_millis(160) {
            last_emitted = last_emitted.max(progress);
            last_emit_at = Instant::now();

            emit_progress(
                app,
                ProductProgress {
                    slug: slug.to_string(),
                    phase: "downloading".into(),
                    progress,
                    message: match total {
                        Some(total) => format!(
                            "Downloading… {}%",
                            (downloaded.saturating_mul(100) / total.max(1)).min(100)
                        ),
                        None => "Downloading…".into(),
                    },
                },
            );
        }
    }

    Ok(bytes)
}

fn extract_product_archive_with_progress(
    bytes: Vec<u8>,
    install_dir: &Path,
    progress_context: Option<(&AppHandle, &str)>,
) -> Result<(), String> {
    // One pass to learn the shape of the archive, then a second to write it.
    //
    // `by_index` borrows only for the entry's lifetime, so the same archive serves both
    // passes. The previous version cloned the whole buffer to build a second archive
    // just to count entries, which doubled peak memory for a 9 MB installer.
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|err| format!("Invalid zip archive: {err}"))?;

    let mut entries: Vec<(PathBuf, bool)> = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|err| format!("Failed to inspect archive entry: {err}"))?;
        if let Some(path) = entry.enclosed_name() {
            entries.push((path.to_path_buf(), entry.is_dir()));
        }
    }

    let paths: Vec<PathBuf> = entries.iter().map(|(path, _)| path.clone()).collect();
    let common_root = common_root_component(&paths);
    let files_total = entries.iter().filter(|(_, is_dir)| !*is_dir).count().max(1);
    let mut files_done = 0_usize;

    fs::create_dir_all(install_dir).map_err(|err| format!("Failed to create install directory: {err}"))?;

    for (index, (enclosed_path, is_dir)) in entries.iter().enumerate() {
        let relative_path = if let Some(root) = &common_root {
            let root_path = Path::new(root);
            enclosed_path
                .strip_prefix(root_path)
                .unwrap_or(enclosed_path)
                .to_path_buf()
        } else {
            enclosed_path.clone()
        };

        if relative_path.as_os_str().is_empty() {
            continue;
        }

        let output_path = install_dir.join(relative_path);

        if *is_dir {
            fs::create_dir_all(&output_path)
                .map_err(|err| format!("Failed to create directory {}: {err}", output_path.display()))?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("Failed to create directory {}: {err}", parent.display()))?;
        }

        {
            let mut entry = archive
                .by_index(index)
                .map_err(|err| format!("Failed to extract archive entry: {err}"))?;
            let mut output_file = fs::File::create(&output_path)
                .map_err(|err| format!("Failed to create file {}: {err}", output_path.display()))?;
            copy(&mut entry, &mut output_file)
                .map_err(|err| format!("Failed to write file {}: {err}", output_path.display()))?;
        }

        files_done += 1;
        if let Some((app, slug)) = progress_context {
            emit_progress(
                app,
                ProductProgress {
                    slug: slug.to_string(),
                    phase: "installing".into(),
                    progress: band::extract(files_done, files_total),
                    message: format!("Installing files… ({files_done}/{files_total})"),
                },
            );
        }
    }

    Ok(())
}

fn get_product_status_sync(slug: String, url: String, exe_path: String) -> Result<ProductStatus, String> {
    let install_dir = product_install_dir(&slug)?;
    let executable_path = product_executable_path(&slug, &exe_path)?;
    let installed = executable_path.exists();
    let mut update_available = false;

    if installed {
        let receipt_path = product_receipt_path(&slug)?;
        if let Ok(contents) = fs::read_to_string(&receipt_path) {
            if let Ok(receipt) = serde_json::from_str::<ProductInstallReceipt>(&contents) {
                if let Ok(client) = download_client() {
                    if let Ok(remote) = resolve_archive_signature(&client, &url) {
                        update_available = !signatures_match(&receipt, &remote);
                    }
                }
            } else {
                update_available = true;
            }
        } else {
            update_available = true;
        }
    }

    Ok(ProductStatus {
        installed,
        update_available,
        install_dir: install_dir.to_string_lossy().to_string(),
        executable_path: executable_path.to_string_lossy().to_string(),
    })
}

fn install_product_sync(app: AppHandle, slug: String, url: String, exe_path: String) -> Result<ProductStatus, String> {
    // Refuse a second install of the same product. Different products run side by side.
    let _slot = claim_install_slot(&slug)?;

    let install_dir = product_install_dir(&slug)?;
    let executable_path = product_executable_path(&slug, &exe_path)?;
    let local_archive_path = is_local_archive_path(&url).then(|| PathBuf::from(&url));

    if let Some(parent) = install_dir.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Failed to prepare products directory: {err}"))?;
    }

    emit_progress(
        &app,
        ProductProgress {
            slug: slug.clone(),
            phase: "downloading".into(),
            progress: band::DOWNLOAD_START,
            message: "Starting download…".into(),
        },
    );

    let client = download_client()?;

    // One request.
    //
    // This used to call `resolve_download_response` twice — once to read the headers for
    // the install receipt, and again to read the body — so every install asked the
    // server for the archive twice. The signature now comes from the same response whose
    // bytes are written.
    let (archive_signature, bytes) = if let Some(local_path) = &local_archive_path {
        let signature = resolve_local_archive_signature(local_path)?;

        emit_progress(
            &app,
            ProductProgress {
                slug: slug.clone(),
                phase: "downloading".into(),
                progress: band::DOWNLOAD_START,
                message: format!("Reading local archive {}…", local_path.display()),
            },
        );

        let bytes = fs::read(local_path)
            .map_err(|err| format!("Failed to read local archive {}: {err}", local_path.display()))?;
        (signature, bytes)
    } else {
        let mut response = resolve_download_response(&client, &url)?;
        let signature = response_signature(&response);
        let bytes = read_body_with_progress(&app, &slug, &mut response)?;
        (signature, bytes)
    };

    emit_progress(
        &app,
        ProductProgress {
            slug: slug.clone(),
            phase: "installing".into(),
            progress: band::PREPARE,
            message: "Stopping running product before install…".into(),
        },
    );
    let _ = stop_running_product_process(&executable_path);

    if install_dir.exists() {
        fs::remove_dir_all(&install_dir)
            .map_err(|err| format!("Failed to clear previous install directory: {err}"))?;
    }

    emit_progress(
        &app,
        ProductProgress {
            slug: slug.clone(),
            phase: "installing".into(),
            progress: band::EXTRACT_START,
            message: "Extracting archive…".into(),
        },
    );

    extract_product_archive_with_progress(bytes, &install_dir, Some((&app, &slug)))?;

    if !executable_path.exists() {
        return Err(format!(
            "Install completed but executable was not found at {}",
            executable_path.display()
        ));
    }

    let receipt = ProductInstallReceipt {
        source_url: url,
        etag: archive_signature.etag,
        last_modified: archive_signature.last_modified,
        content_length: archive_signature.content_length,
        local_modified_epoch_ms: archive_signature.local_modified_epoch_ms,
    };
    let receipt_path = product_receipt_path(&slug)?;
    let receipt_contents =
        serde_json::to_vec_pretty(&receipt).map_err(|err| format!("Failed to serialize install receipt: {err}"))?;
    fs::write(&receipt_path, receipt_contents)
        .map_err(|err| format!("Failed to write install receipt: {err}"))?;

    emit_progress(
        &app,
        ProductProgress {
            slug: slug.clone(),
            phase: "ready".into(),
            progress: band::READY,
            message: "Install completed successfully.".into(),
        },
    );

    Ok(ProductStatus {
        installed: true,
        update_available: false,
        install_dir: install_dir.to_string_lossy().to_string(),
        executable_path: executable_path.to_string_lossy().to_string(),
    })
}

fn launch_product_sync(
    slug: String,
    exe_path: String,
    store_endpoint: String,
    launch_token: String,
) -> Result<(), String> {
    let executable_path = product_executable_path(&slug, &exe_path)?;

    if !executable_path.exists() {
        return Err(format!("Executable not found at {}", executable_path.display()));
    }

    let launch_dir = executable_path
        .parent()
        .ok_or_else(|| format!("Unable to resolve launch directory for {}", executable_path.display()))?;

    Command::new(&executable_path)
        .current_dir(launch_dir)
        .arg("--apro-product-slug")
        .arg(&slug)
        .arg("--apro-launch-token")
        .arg(&launch_token)
        .arg("--apro-store-endpoint")
        .arg(&store_endpoint)
        .spawn()
        .map_err(|err| format!("Failed to launch product: {err}"))?;

    Ok(())
}

fn uninstall_product_sync(app: AppHandle, slug: String, exe_path: String) -> Result<ProductStatus, String> {
    let install_dir = product_install_dir(&slug)?;
    let executable_path = product_executable_path(&slug, &exe_path)?;

    emit_progress(
        &app,
        ProductProgress {
            slug: slug.clone(),
            phase: "uninstalling".into(),
            progress: 10,
            message: "Stopping running product before uninstall...".into(),
        },
    );
    let _ = stop_running_product_process(&executable_path);

    emit_progress(
        &app,
        ProductProgress {
            slug: slug.clone(),
            phase: "uninstalling".into(),
            progress: 45,
            message: "Removing installed files...".into(),
        },
    );

    if install_dir.exists() {
        fs::remove_dir_all(&install_dir)
            .map_err(|err| format!("Failed to remove install directory {}: {err}", install_dir.display()))?;
    }

    emit_progress(
        &app,
        ProductProgress {
            slug: slug.clone(),
            phase: "idle".into(),
            progress: 100,
            message: "Product uninstalled successfully.".into(),
        },
    );

    Ok(ProductStatus {
        installed: false,
        update_available: false,
        install_dir: install_dir.to_string_lossy().to_string(),
        executable_path: executable_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn get_product_status(slug: String, url: String, exe_path: String) -> Result<ProductStatus, String> {
    tauri::async_runtime::spawn_blocking(move || get_product_status_sync(slug, url, exe_path))
        .await
        .map_err(|err| format!("Failed to check product status: {err}"))?
}

#[tauri::command]
async fn install_product(app: AppHandle, slug: String, url: String, exe_path: String) -> Result<ProductStatus, String> {
    tauri::async_runtime::spawn_blocking(move || install_product_sync(app, slug, url, exe_path))
        .await
        .map_err(|err| format!("Failed to install product: {err}"))?
}

#[tauri::command]
async fn launch_product(
    host: tauri::State<'_, StoreHost>,
    slug: String,
    exe_path: String,
) -> Result<(), String> {
    let store_endpoint = host.endpoint()?.to_string();
    let launch_token = host.issue_launch_ticket(&slug)?;
    write_launch_ticket(&slug, &launch_token, LAUNCH_TICKET_TTL)?;

    tauri::async_runtime::spawn_blocking(move || {
        launch_product_sync(slug, exe_path, store_endpoint, launch_token)
    })
    .await
    .map_err(|err| format!("Failed to launch product: {err}"))?
}

/// Current state of the local orchestration store, for the hub UI.
#[tauri::command]
fn get_store_status(host: tauri::State<'_, StoreHost>) -> StoreStatus {
    host.status()
}

/// Insert the removable dummy dataset. Safe to expose in the UI: everything it writes
/// carries a batch marker that `purge_store_demo` removes.
#[tauri::command]
fn seed_store_demo(
    host: tauri::State<'_, StoreHost>,
    force: bool,
) -> Result<apro_store::demo::SeedReport, String> {
    host.seed_demo(force)
}

/// Remove every seeded dummy artifact. Real data is never eligible.
#[tauri::command]
fn purge_store_demo(host: tauri::State<'_, StoreHost>) -> Result<apro_store::PurgeReport, String> {
    host.purge_demo()
}

/// Recent orchestration events. `since` is a change cursor; 0 means "from the start".
#[tauri::command]
fn get_store_events(
    host: tauri::State<'_, StoreHost>,
    since: i64,
    limit: u32,
) -> Result<Vec<apro_store::EventRecord>, String> {
    host.events(since, limit)
}

/// Every dependency edge, with its freshness computed from the graph.
#[tauri::command]
fn list_store_edges(
    host: tauri::State<'_, StoreHost>,
) -> Result<Vec<apro_store::EdgeSummary>, String> {
    host.edges()
}

/// Every declared publish/consume contract, used to derive canvas ports.
#[tauri::command]
fn list_store_interfaces(
    host: tauri::State<'_, StoreHost>,
) -> Result<Vec<apro_store::DeclaredType>, String> {
    host.interfaces()
}

/// Type-level subscriptions: what the workflow canvas wires.
#[tauri::command]
fn list_store_subscriptions(
    host: tauri::State<'_, StoreHost>,
) -> Result<Vec<apro_store::SubscriptionSummary>, String> {
    host.subscriptions()
}

/// Apply one drawn wire. Materialises concrete edges for every existing instance.
#[tauri::command]
fn create_store_subscription(
    host: tauri::State<'_, StoreHost>,
    consumer_app: String,
    type_id: String,
    mode: String,
) -> Result<apro_store::SubscriptionSummary, String> {
    host.create_subscription(&consumer_app, &type_id, &mode)
}

/// Un-wire durably: removes the subscription and the edges it materialised.
#[tauri::command]
fn delete_store_subscription(
    host: tauri::State<'_, StoreHost>,
    subscription_id: String,
) -> Result<u64, String> {
    host.delete_subscription(&subscription_id)
}

/// Back-fill edges for instances published since a subscription was created.
#[tauri::command]
fn materialize_store_subscriptions(host: tauri::State<'_, StoreHost>) -> Result<u64, String> {
    host.materialize_subscriptions()
}

/// The read log — what consumers actually pulled.
#[tauri::command]
fn get_store_access(
    host: tauri::State<'_, StoreHost>,
    since: i64,
    limit: u32,
) -> Result<Vec<apro_store::AccessRecord>, String> {
    host.access_log(since, limit)
}

/// Mirror the local orchestration store into one workspace's online storage.
///
/// The token is the signed-in user's own, passed down from the frontend, because
/// the session lives there and this process never sees a password. What that
/// person may upload is decided by the storage Worker against Supabase; the hub
/// takes no part in the decision and holds no key of its own.
///
/// Blocking HTTP, so it runs on the same blocking pool as the product commands.
#[tauri::command]
async fn sync_workspace_storage(
    app: AppHandle,
    base: String,
    token: String,
    workspace_id: String,
) -> Result<storage_sync::SyncReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let host = app.state::<StoreHost>();
        storage_sync::sync(host.store()?, &base, &token, &workspace_id)
    })
    .await
    .map_err(|err| format!("Failed to sync online storage: {err}"))?
}

#[tauri::command]
async fn uninstall_product(app: AppHandle, slug: String, exe_path: String) -> Result<ProductStatus, String> {
    tauri::async_runtime::spawn_blocking(move || uninstall_product_sync(app, slug, exe_path))
        .await
        .map_err(|err| format!("Failed to uninstall product: {err}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = cleanup_expired_launch_tickets();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Start the orchestration store. A failure is recorded rather than fatal,
            // so the hub still opens and can report what went wrong.
            let host = StoreHost::start();
            let status = host.status();
            if status.running {
                println!(
                    "APRO store listening on {} (data: {})",
                    status.endpoint, status.data_dir
                );
            } else if let Some(error) = &status.error {
                eprintln!("APRO store failed to start: {error}");
            }
            app.manage(host);

            // The window is created hidden (`tauri.conf.json` -> `visible: false`) so the
            // first frame paints before it appears; the interface reveals it once React
            // has mounted. That is the normal path and it stays flash-free.
            //
            // This is the fallback for when the interface never runs at all — missing
            // build-time credentials, a JavaScript error, no WebView2 runtime. In those
            // cases nothing would ever reveal the window, so the app would present as no
            // window and no error, which is indistinguishable from a crash and
            // impossible to diagnose on a machine without devtools. A short grace period
            // is long enough for the frontend to win the race in the normal case.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(2500));
                if let Some(window) = handle.get_webview_window("main") {
                    if !window.is_visible().unwrap_or(false) {
                        let _ = window.show();
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_product_status,
            install_product,
            launch_product,
            uninstall_product,
            get_store_status,
            seed_store_demo,
            purge_store_demo,
            get_store_events,
            list_store_edges,
            list_store_interfaces,
            list_store_subscriptions,
            create_store_subscription,
            delete_store_subscription,
            materialize_store_subscriptions,
            get_store_access,
            sync_workspace_storage,
            update::check_for_update
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Requires an explicit quit; see DESIGN.md 7/R1. Closing the window hides it.
            if let tauri::RunEvent::Exit = event {
                if let Some(host) = app_handle.try_state::<StoreHost>() {
                    host.shutdown();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{band, claim_install_slot};

    #[test]
    fn download_progress_stays_inside_its_band() {
        assert_eq!(band::download(0, Some(100)), band::DOWNLOAD_START);
        assert_eq!(band::download(100, Some(100)), band::DOWNLOAD_END);
        // An unknown total must not pretend to advance.
        assert_eq!(band::download(50, None), band::DOWNLOAD_START);
        assert_eq!(band::download(50, Some(0)), band::DOWNLOAD_START);
        // A server that over-reports must not push past the end of the band.
        assert_eq!(band::download(500, Some(100)), band::DOWNLOAD_END);
    }

    #[test]
    fn extract_progress_stays_inside_its_band() {
        assert_eq!(band::extract(0, 10), band::EXTRACT_START);
        assert_eq!(band::extract(10, 10), band::EXTRACT_END);
        // An archive with no files is a state, not a division by zero.
        assert_eq!(band::extract(0, 0), band::EXTRACT_START);
        assert!(band::extract(20, 10) <= band::EXTRACT_END);
    }

    #[test]
    fn progress_never_decreases_within_a_phase() {
        let mut previous = band::DOWNLOAD_START;
        for done in 0..=500_u64 {
            let value = band::download(done, Some(500));
            assert!(value >= previous, "download went backwards at {done}: {previous} -> {value}");
            previous = value;
        }

        let mut previous = band::EXTRACT_START;
        for done in 0..=500_usize {
            let value = band::extract(done, 500);
            assert!(value >= previous, "extract went backwards at {done}: {previous} -> {value}");
            previous = value;
        }
    }

    /// The regression this module exists for.
    ///
    /// The bar visibly jumped backwards at the download/install boundary, because the
    /// "extracting" step announced 74 and the first archive entry then reported 70.
    /// Replaying the real emit order is what makes that impossible to reintroduce
    /// quietly.
    #[test]
    fn the_whole_sequence_only_ever_moves_forward() {
        let mut emitted = vec![
            band::download(0, Some(100)),
            band::download(50, Some(100)),
            band::download(100, Some(100)),
            band::PREPARE,
            band::EXTRACT_START,
        ];
        for done in 1..=100_usize {
            emitted.push(band::extract(done, 100));
        }
        emitted.push(band::READY);

        for pair in emitted.windows(2) {
            assert!(
                pair[1] >= pair[0],
                "progress went backwards: {} then {}",
                pair[0],
                pair[1]
            );
        }
        assert_eq!(*emitted.last().unwrap(), band::READY);
    }

    #[test]
    fn the_bands_do_not_overlap() {
        assert!(band::DOWNLOAD_START < band::DOWNLOAD_END);
        assert!(band::DOWNLOAD_END < band::PREPARE);
        assert!(band::PREPARE < band::EXTRACT_START);
        assert!(band::EXTRACT_START < band::EXTRACT_END);
        assert!(band::EXTRACT_END < band::READY);
    }

    /// Concurrent installs of different products are the point; two of the same are
    /// not, because they would rewrite the same directory.
    #[test]
    fn only_one_install_of_a_given_product_can_be_in_flight() {
        let first = claim_install_slot("apro-cad").expect("the first claim should succeed");
        assert!(
            claim_install_slot("apro-cad").is_err(),
            "a second install of the same product must be refused"
        );
        assert!(
            claim_install_slot("hexadof").is_ok(),
            "a different product must be independent"
        );

        drop(first);
        assert!(
            claim_install_slot("apro-cad").is_ok(),
            "the slot must be released when the install ends"
        );
    }
}