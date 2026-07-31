mod agent_events;
mod codex_sessions;
mod native;
mod notifications;
mod pet_pack;
mod runtime_service;
mod ssh_sessions;
mod store;
mod system_monitor;

use agent_events::AgentCompletionEvent;
use codex_sessions::{
    CodexEventEnvelope, CodexHookConfigurationResult, CodexIntegrationStatus, CodexSessionManager,
    CodexSessionSnapshot, CodexSyncPreferences,
};
use native::NativeActivitySample;
use pet_pack::ImportedPetPack;
use runtime_service::{NativeRuntimeEnvelope, NativeRuntimeService};
use serde_json::Value;
use ssh_sessions::{
    SshConnectionStatus, SshHostCandidate, SshHostDiagnostic, SshProvisionResult,
    SshSessionManager, SshUninstallResult,
};
use std::path::{Path, PathBuf};
use store::FocusPetStore;
use system_monitor::{SystemMetricsSample, SystemMonitorState};
use tauri::{Emitter, Manager};

const TRAY_OPEN_TODAY: &str = "open-today";
const TRAY_OPEN_PET: &str = "open-pet";
const TRAY_OPEN_SETTINGS: &str = "open-settings";
const TRAY_TOGGLE_WIDGETS: &str = "toggle-widgets";
const TRAY_TOGGLE_PET: &str = "toggle-pet";
const TRAY_PAUSE_REMINDERS: &str = "pause-reminders";
const TRAY_RESUME_REMINDERS: &str = "resume-reminders";
const TRAY_FINISH_FOCUS: &str = "finish-focus";
const TRAY_QUIT: &str = "quit";

#[derive(Clone, Debug, Default)]
struct PetWindowTrackingConfig {
    visible: bool,
    size: f64,
    placement: String,
}

#[derive(Clone, Default)]
struct PetWindowTracker {
    config: std::sync::Arc<std::sync::Mutex<PetWindowTrackingConfig>>,
    paused: std::sync::Arc<std::sync::atomic::AtomicBool>,
    main_thread_tick_pending: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PetWindowFollowEvent {
    x: f64,
    y: f64,
    phase: &'static str,
}

#[tauri::command]
fn set_pet_window_tracking_paused(
    paused: bool,
    tracker: tauri::State<'_, PetWindowTracker>,
) -> bool {
    tracker
        .paused
        .store(paused, std::sync::atomic::Ordering::Release);
    true
}

#[tauri::command]
fn set_pet_panel_position(app: tauri::AppHandle, x: f64, y: f64) -> Result<bool, String> {
    use tauri::{Manager, PhysicalPosition};

    let Some(window) = app.get_webview_window("widget-pet-companion") else {
        return Ok(false);
    };
    window
        .set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
        .map_err(|error| error.to_string())?;
    sync_native_pet_panel_from_host(&window, true);
    Ok(true)
}

#[tauri::command]
fn set_pet_panel_ignores_mouse_events(
    app: tauri::AppHandle,
    ignores: bool,
) -> Result<bool, String> {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("widget-pet-companion") else {
        return Ok(false);
    };
    set_native_pet_panel_ignores_mouse_events(&window, ignores);
    Ok(true)
}

#[derive(Clone, serde::Serialize)]
struct NativeMenuAction {
    action: String,
}

#[tauri::command]
fn perform_menu_bar_action(app: tauri::AppHandle, action: String) -> bool {
    if !is_native_menu_action(&action) {
        return false;
    }
    handle_native_menu_action(&app, &action);
    true
}

fn is_native_menu_action(action: &str) -> bool {
    matches!(
        action,
        TRAY_OPEN_TODAY
            | TRAY_OPEN_PET
            | TRAY_OPEN_SETTINGS
            | TRAY_TOGGLE_WIDGETS
            | TRAY_TOGGLE_PET
            | TRAY_PAUSE_REMINDERS
            | TRAY_RESUME_REMINDERS
            | TRAY_FINISH_FOCUS
            | TRAY_QUIT
    )
}

#[tauri::command]
fn sample_system_metrics(
    state: tauri::State<'_, SystemMonitorState>,
) -> Result<SystemMetricsSample, String> {
    state.sample()
}

#[tauri::command]
fn drain_agent_events() -> Result<Vec<AgentCompletionEvent>, String> {
    agent_events::drain_events()
}

#[tauri::command]
fn agent_event_inbox_path() -> String {
    agent_events::inbox_path()
}

#[tauri::command]
fn drain_codex_session_events(
    state: tauri::State<'_, CodexSessionManager>,
) -> Result<Vec<CodexEventEnvelope>, String> {
    state.drain()
}

#[tauri::command]
fn codex_session_snapshot(
    state: tauri::State<'_, CodexSessionManager>,
) -> Result<Vec<CodexSessionSnapshot>, String> {
    state.snapshot()
}

#[tauri::command]
fn codex_integration_status() -> CodexIntegrationStatus {
    codex_sessions::integration_status()
}

#[tauri::command]
fn set_codex_sync_preferences(
    preferences: CodexSyncPreferences,
    _state: tauri::State<'_, CodexSessionManager>,
) -> Result<CodexSyncPreferences, String> {
    codex_sessions::set_sync_preferences(preferences)
}

#[tauri::command]
fn start_codex_managed_daemon(
    state: tauri::State<'_, CodexSessionManager>,
) -> Result<bool, String> {
    let started = codex_sessions::start_managed_daemon()?;
    if started {
        codex_sessions::start_managed_event_stream(state.inner().clone());
    }
    Ok(started)
}

#[tauri::command]
fn poll_codex_managed_status(
    state: tauri::State<'_, CodexSessionManager>,
) -> Result<Vec<CodexEventEnvelope>, String> {
    let events = codex_sessions::managed_status_events()?;
    state.ingest_external(events)
}

#[tauri::command]
fn install_codex_hooks() -> Result<CodexHookConfigurationResult, String> {
    codex_sessions::install_hooks()
}

#[tauri::command]
fn uninstall_codex_hooks() -> Result<CodexHookConfigurationResult, String> {
    codex_sessions::uninstall_hooks()
}

#[tauri::command]
fn discover_codex_ssh_hosts() -> Result<Vec<SshHostCandidate>, String> {
    ssh_sessions::discover_hosts()
}

#[tauri::command]
fn save_codex_ssh_host(
    alias: String,
    hostname: String,
    user: Option<String>,
    port: Option<u16>,
) -> Result<SshHostCandidate, String> {
    ssh_sessions::save_host(&alias, &hostname, user.as_deref(), port)
}

#[tauri::command]
fn forget_codex_ssh_host(
    alias: String,
    ssh: tauri::State<'_, SshSessionManager>,
) -> Result<bool, String> {
    ssh.disconnect(&alias)?;
    ssh_sessions::forget_host(&alias)?;
    Ok(true)
}

#[tauri::command]
fn diagnose_codex_ssh_host(alias: String) -> Result<SshHostDiagnostic, String> {
    ssh_sessions::diagnose_host(&alias)
}

#[tauri::command]
fn provision_codex_ssh_host(alias: String) -> Result<SshProvisionResult, String> {
    ssh_sessions::provision_host(&alias)
}

#[tauri::command]
fn uninstall_codex_ssh_host(
    alias: String,
    ssh: tauri::State<'_, SshSessionManager>,
) -> Result<SshUninstallResult, String> {
    ssh.disconnect(&alias)?;
    ssh_sessions::uninstall_host(&alias)
}

#[tauri::command]
fn connect_codex_ssh_host(
    alias: String,
    ssh: tauri::State<'_, SshSessionManager>,
) -> Result<bool, String> {
    ssh.connect(&alias)?;
    Ok(true)
}

#[tauri::command]
fn drain_codex_ssh_events(
    codex: tauri::State<'_, CodexSessionManager>,
    ssh: tauri::State<'_, SshSessionManager>,
) -> Result<Vec<CodexEventEnvelope>, String> {
    codex.ingest_external(ssh.drain()?)
}

#[tauri::command]
fn codex_ssh_connection_status(
    ssh: tauri::State<'_, SshSessionManager>,
) -> Result<Vec<SshConnectionStatus>, String> {
    ssh.connection_statuses()
}

pub fn maybe_handle_agent_notification() -> bool {
    codex_sessions::maybe_ingest_hook_from_process_args()
        || agent_events::maybe_ingest_from_process_args()
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallationSnapshot {
    bundle_path: String,
    build_identifier: String,
    version_display: String,
    is_installed: bool,
    is_running_from_mounted_volume: bool,
}

#[tauri::command]
fn load_snapshot(runtime: tauri::State<'_, NativeRuntimeService>) -> Result<Value, String> {
    Ok(runtime.snapshot())
}

#[tauri::command]
async fn save_snapshot(
    app: tauri::AppHandle,
    snapshot: Value,
    runtime: tauri::State<'_, NativeRuntimeService>,
) -> Result<bool, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.persist_snapshot(&app, snapshot)?;
        Ok(true)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn native_runtime_snapshot(
    runtime: tauri::State<'_, NativeRuntimeService>,
) -> NativeRuntimeEnvelope {
    runtime.envelope()
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) -> bool {
    codex_sessions::stop_focus_pet_ephemeral_app_server();
    app.exit(0);
    true
}

#[tauri::command]
fn sample_activity() -> NativeActivitySample {
    native::sample_activity()
}

#[tauri::command]
async fn app_icon(
    app: tauri::AppHandle,
    bundle_id: Option<String>,
    app_name: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        export_app_icon(&app, bundle_id.as_deref(), &app_name)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(target_os = "macos")]
fn export_app_icon(
    app: &tauri::AppHandle,
    bundle_id: Option<&str>,
    app_name: &str,
) -> Result<Option<String>, String> {
    let app_bundle = bundle_id
        .filter(|value| !value.trim().is_empty())
        .and_then(|value| {
            native::run_text_command(
                "/usr/bin/mdfind",
                &[&format!(
                    "kMDItemCFBundleIdentifier == '{}'",
                    value.replace('\u{27}', "")
                )],
            )
            .and_then(|output| {
                output
                    .lines()
                    .find(|line| line.ends_with(".app"))
                    .map(PathBuf::from)
            })
        })
        .or_else(|| {
            let safe_name = app_name.trim().replace('/', "");
            [
                PathBuf::from("/Applications").join(format!("{safe_name}.app")),
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .unwrap_or_default()
                    .join("Applications")
                    .join(format!("{safe_name}.app")),
            ]
            .into_iter()
            .find(|path| path.is_dir())
        });
    let Some(app_bundle) = app_bundle else {
        return Ok(None);
    };
    let resources = app_bundle.join("Contents/Resources");
    let plist = app_bundle.join("Contents/Info.plist");
    let declared_icon = native::run_text_command(
        "/usr/bin/defaults",
        &["read", plist.to_string_lossy().as_ref(), "CFBundleIconFile"],
    );
    let icon_path = declared_icon
        .map(|name| {
            let path = resources.join(name.trim());
            if path.extension().is_some() {
                path
            } else {
                path.with_extension("icns")
            }
        })
        .filter(|path| path.is_file())
        .or_else(|| {
            std::fs::read_dir(&resources)
                .ok()?
                .flatten()
                .map(|entry| entry.path())
                .find(|path| path.extension().and_then(|value| value.to_str()) == Some("icns"))
        });
    let Some(icon_path) = icon_path else {
        return Ok(None);
    };
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("app-icons");
    std::fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    let identity = bundle_id.unwrap_or(app_name);
    let safe_identity: String = identity
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect();
    let output_path = cache_dir.join(format!("{safe_identity}.png"));
    if !output_path.is_file() {
        let status = std::process::Command::new("/usr/bin/sips")
            .args(["-Z", "128", "-s", "format", "png"])
            .arg(&icon_path)
            .arg("--out")
            .arg(&output_path)
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() || !output_path.is_file() {
            return Ok(None);
        }
    }
    Ok(Some(output_path.to_string_lossy().to_string()))
}

#[cfg(target_os = "windows")]
fn export_app_icon(
    app: &tauri::AppHandle,
    bundle_id: Option<&str>,
    app_name: &str,
) -> Result<Option<String>, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::os::windows::process::CommandExt;

    let Some(source) = windows_icon_source(bundle_id) else {
        return Ok(None);
    };
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("app-icons");
    std::fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    let mut hasher = DefaultHasher::new();
    source.hash(&mut hasher);
    let store_packaged_app = is_windows_store_package_path(&source);
    if store_packaged_app {
        // Bump the cache identity when choosing the AppX light-background logo
        // so existing white-on-transparent cache files are not reused.
        "appx-light-logo-v2".hash(&mut hasher);
    }
    let safe_name = app_name
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(32)
        .collect::<String>();
    let output_path = cache_dir.join(format!(
        "{}-{:016x}.png",
        if safe_name.is_empty() {
            "app"
        } else {
            &safe_name
        },
        hasher.finish()
    ));
    if output_path.is_file() {
        return Ok(Some(output_path.to_string_lossy().to_string()));
    }

    // Packaged Windows apps commonly expose only a generic executable icon.
    // Prefer their AppX manifest logo when the foreground executable lives in
    // WindowsApps, which covers ChatGPT/Codex and other Store-distributed apps.
    if store_packaged_app {
        if let Some(store_logo) = windows_store_logo_source(&source) {
            if std::fs::copy(&store_logo, &output_path).is_ok() && output_path.is_file() {
                return Ok(Some(output_path.to_string_lossy().to_string()));
            }
            let _ = std::fs::remove_file(&output_path);
        }
    }

    let script = r#"
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:FOCUS_PET_ICON_SOURCE)
if ($null -eq $icon) { exit 2 }
$bitmap = $icon.ToBitmap()
try {
  $bitmap.Save($env:FOCUS_PET_ICON_OUTPUT, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $bitmap.Dispose()
  $icon.Dispose()
}
"#;
    let status = std::process::Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .env("FOCUS_PET_ICON_SOURCE", &source)
        .env("FOCUS_PET_ICON_OUTPUT", &output_path)
        .creation_flags(0x0800_0000)
        .status()
        .map_err(|error| error.to_string())?;
    if !status.success() || !output_path.is_file() {
        let _ = std::fs::remove_file(&output_path);
        return Ok(None);
    }
    Ok(Some(output_path.to_string_lossy().to_string()))
}

#[cfg(target_os = "windows")]
fn windows_icon_source(bundle_id: Option<&str>) -> Option<PathBuf> {
    bundle_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_file())
}

#[cfg(target_os = "windows")]
const WINDOWS_STORE_LOGO_SCRIPT: &str = r#"
$source = $env:FOCUS_PET_ICON_SOURCE
$package = Get-AppxPackage | Where-Object {
  $source.StartsWith($_.InstallLocation, [StringComparison]::OrdinalIgnoreCase)
} | Select-Object -First 1
if ($null -eq $package) { exit 1 }
$manifest = Get-AppxPackageManifest -Package $package.PackageFullName
$application = @($manifest.Package.Applications.Application | Where-Object {
  $executable = Join-Path $package.InstallLocation $_.Executable.Replace('/', '\')
  [string]::Equals($executable, $source, [StringComparison]::OrdinalIgnoreCase)
} | Select-Object -First 1)
$visual = $application.VisualElements
$relative = [string]$visual.Square44x44Logo
if ([string]::IsNullOrWhiteSpace($relative)) { $relative = [string]$visual.Square150x150Logo }
if ([string]::IsNullOrWhiteSpace($relative)) { $relative = [string]$manifest.Package.Properties.Logo }
if ([string]::IsNullOrWhiteSpace($relative)) { exit 2 }
$logo = Join-Path $package.InstallLocation $relative.Replace('/', '\')
$directory = Split-Path -Parent $logo
$stem = [IO.Path]::GetFileNameWithoutExtension($logo)
$extension = [IO.Path]::GetExtension($logo)
$candidates = @(
  (Join-Path $directory ($stem + '.targetsize-256_altform-lightunplated' + $extension)),
  (Join-Path $directory ($stem + '.targetsize-256_altform-unplated' + $extension)),
  (Join-Path $directory ($stem + '.targetsize-256' + $extension)),
  (Join-Path $directory ($stem + '.scale-200' + $extension)),
  $logo
)
foreach ($candidate in $candidates) {
  if ((Test-Path -LiteralPath $candidate) -and [IO.Path]::GetExtension($candidate) -ieq '.png') {
    $candidate
    exit 0
  }
}
exit 3
"#;

#[cfg(target_os = "windows")]
fn windows_store_logo_source(source: &Path) -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;

    if !is_windows_store_package_path(source) {
        return None;
    }
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            WINDOWS_STORE_LOGO_SCRIPT,
        ])
        .env("FOCUS_PET_ICON_SOURCE", source)
        .creation_flags(0x0800_0000)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let logo = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)?;
    logo.is_file().then_some(logo)
}

#[cfg(target_os = "windows")]
fn is_windows_store_package_path(path: &Path) -> bool {
    path.to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
        .contains("\\program files\\windowsapps\\")
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn export_app_icon(
    _app: &tauri::AppHandle,
    _bundle_id: Option<&str>,
    _app_name: &str,
) -> Result<Option<String>, String> {
    Ok(None)
}

#[tauri::command]
fn installation_snapshot(app: tauri::AppHandle) -> InstallationSnapshot {
    let version = app.package_info().version.to_string();
    let identifier = app.config().identifier.clone();
    let bundle_path = application_bundle_path();
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    installation_snapshot_for_path(&bundle_path, &identifier, &version, home.as_deref())
}

#[tauri::command]
async fn choose_and_import_pet_pack(
    app: tauri::AppHandle,
) -> Result<Option<Vec<ImportedPetPack>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = pet_pack::choose_pet_pack_source(&app) else {
            return Ok(None);
        };
        import_pet_pack_from_path(app, path.to_string_lossy().to_string()).map(Some)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn import_pet_pack_from_path(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<ImportedPetPack>, String> {
    let store = FocusPetStore::new(&app).map_err(|error| error.to_string())?;
    pet_pack::import_pet_packs(std::path::Path::new(&path), &store.pet_packs_dir())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_pet_packs(app: tauri::AppHandle) -> Result<Vec<ImportedPetPack>, String> {
    let store = FocusPetStore::new(&app).map_err(|error| error.to_string())?;
    pet_pack::list_pet_packs(&store.pet_packs_dir()).map_err(|error| error.to_string())
}

#[tauri::command]
fn pet_pack_assets(
    app: tauri::AppHandle,
    id: String,
) -> Result<Vec<pet_pack::PetSourceActionAssets>, String> {
    let store = FocusPetStore::new(&app).map_err(|error| error.to_string())?;
    pet_pack::pet_pack_assets(&store.pet_packs_dir(), &id).map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_pet_pack(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    let store = FocusPetStore::new(&app).map_err(|error| error.to_string())?;
    pet_pack::delete_pet_pack(&store.pet_packs_dir(), &id).map_err(|error| error.to_string())
}

#[tauri::command]
async fn deliver_notification(title: String, body: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || notifications::deliver(&title, &body))
        .await
        .unwrap_or(false)
}

fn application_bundle_path() -> PathBuf {
    let executable = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    #[cfg(target_os = "macos")]
    {
        for ancestor in executable.ancestors() {
            if ancestor.extension().and_then(|value| value.to_str()) == Some("app") {
                return ancestor.to_path_buf();
            }
        }
    }
    executable
}

fn installation_snapshot_for_path(
    bundle_path: &Path,
    identifier: &str,
    version: &str,
    home: Option<&Path>,
) -> InstallationSnapshot {
    InstallationSnapshot {
        bundle_path: bundle_path.to_string_lossy().to_string(),
        build_identifier: format!("{identifier}|{version}"),
        version_display: version.to_string(),
        is_installed: is_installed_application_path(bundle_path, home),
        is_running_from_mounted_volume: is_running_from_mounted_volume_path(bundle_path),
    }
}

fn is_running_from_mounted_volume_path(path: &Path) -> bool {
    path.to_string_lossy().starts_with("/Volumes/")
}

fn is_installed_application_path(path: &Path, home: Option<&Path>) -> bool {
    #[cfg(not(target_os = "macos"))]
    let _ = home;

    #[cfg(target_os = "macos")]
    {
        let text = path.to_string_lossy();
        let user_applications = home.map(|home| home.join("Applications"));
        return text.starts_with("/Applications/")
            || user_applications
                .as_deref()
                .is_some_and(|applications| path.starts_with(applications));
    }

    #[cfg(target_os = "windows")]
    {
        let mut roots = Vec::new();
        for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(value) = std::env::var_os(key) {
                roots.push(PathBuf::from(value));
            }
        }
        return is_windows_installed_path(path, &roots);
    }

    #[cfg(target_os = "linux")]
    {
        return path.starts_with("/opt")
            || path.starts_with("/usr/bin")
            || path.starts_with("/usr/local/bin");
    }

    #[allow(unreachable_code)]
    false
}

#[cfg(target_os = "windows")]
fn is_windows_installed_path(path: &Path, roots: &[PathBuf]) -> bool {
    let normalized = normalize_windows_path(path);
    roots.iter().any(|root| {
        let root = normalize_windows_path(root);
        normalized == root || normalized.starts_with(&format!("{root}\\"))
    })
}

#[cfg(target_os = "windows")]
fn normalize_windows_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn sync_widget_windows(
    app: tauri::AppHandle,
    tracker: tauri::State<'_, PetWindowTracker>,
    current_status_visible: bool,
    recent_rhythm_visible: bool,
    current_status_origin_x: Option<f64>,
    current_status_origin_y: Option<f64>,
    recent_rhythm_origin_x: Option<f64>,
    recent_rhythm_origin_y: Option<f64>,
    pet_companion_visible: bool,
    pet_size: f64,
    pet_placement: String,
    pet_origin_x: Option<f64>,
    pet_origin_y: Option<f64>,
) -> Result<bool, String> {
    if let Ok(mut config) = tracker.config.lock() {
        *config = PetWindowTrackingConfig {
            visible: pet_companion_visible,
            size: pet_size,
            placement: pet_placement.clone(),
        };
    }
    sync_widget_window(
        &app,
        "widget-current-status",
        "/?widget=currentStatus",
        current_status_visible,
        204.0,
        204.0,
        current_status_origin_x.zip(current_status_origin_y),
    )?;
    sync_widget_window(
        &app,
        "widget-recent-rhythm",
        "/?widget=recentRhythm",
        recent_rhythm_visible,
        400.0,
        204.0,
        recent_rhythm_origin_x.zip(recent_rhythm_origin_y),
    )?;
    let pet_window_width = pet_size.max((pet_size + 280.0).min(420.0));
    let pet_window_height = pet_size + 390.0;
    let requested_pet_origin = pet_origin_x.zip(pet_origin_y);
    let pet_origin = requested_pet_origin
        .filter(|(x, y)| pet_origin_is_visible(&app, *x, *y, pet_window_width, pet_window_height))
        .or_else(|| {
            default_pet_origin(
                &app,
                pet_placement.as_str(),
                pet_window_width,
                pet_window_height,
            )
        });
    log::info!(
        "sync pet window: visible={pet_companion_visible}, placement={pet_placement}, size={pet_size}, origin={pet_origin:?}"
    );
    sync_widget_window(
        &app,
        "widget-pet-companion",
        "/?widget=petCompanion",
        pet_companion_visible,
        pet_window_width,
        pet_window_height,
        pet_origin,
    )?;
    Ok(true)
}

fn toggle_menu_bar_window(app: &tauri::AppHandle) {
    use tauri::Manager;

    if let Some(window) = app.get_webview_window("widget-menu-bar") {
        if window.is_visible().unwrap_or(false) {
            window.hide().ok();
            return;
        }
    }
    let width = 360.0;
    let height = 374.0;
    let origin = default_menu_bar_origin(app, width, height);
    if sync_widget_window(
        app,
        "widget-menu-bar",
        "/?widget=menuBar",
        true,
        width,
        height,
        origin,
    )
    .is_ok()
    {
        if let Some(window) = app.get_webview_window("widget-menu-bar") {
            window.set_focus().ok();
        }
    }
}

fn default_menu_bar_origin(app: &tauri::AppHandle, width: f64, height: f64) -> Option<(f64, f64)> {
    use tauri::Manager;

    let monitor = app
        .get_webview_window("main")
        .and_then(|window| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| app.available_monitors().ok()?.into_iter().next());
    let Some(monitor) = monitor else {
        return Some((1280.0 - width - 18.0, 28.0));
    };
    let work_area = monitor.work_area();
    let scale_factor = monitor.scale_factor();
    let physical_width = width * scale_factor;
    let physical_height = height * scale_factor;
    Some((
        f64::from(work_area.position.x) + f64::from(work_area.size.width) - physical_width - 18.0,
        f64::from(work_area.position.y)
            + 12.0_f64.min((f64::from(work_area.size.height) - physical_height).max(0.0)),
    ))
}

fn default_pet_origin(
    app: &tauri::AppHandle,
    placement: &str,
    width: f64,
    height: f64,
) -> Option<(f64, f64)> {
    use tauri::Manager;

    let monitor = frontmost_monitor(app)
        .or_else(|| {
            app.get_webview_window("main")
                .and_then(|window| window.current_monitor().ok().flatten())
        })
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| app.available_monitors().ok()?.into_iter().next());
    let Some(monitor) = monitor else {
        return match placement {
            "bottomLeft" => Some((24.0, 720.0 - height)),
            "topRight" => Some((1280.0 - width - 24.0, 24.0)),
            "topLeft" => Some((24.0, 24.0)),
            _ => Some((1280.0 - width - 24.0, 720.0 - height - 24.0)),
        };
    };
    Some(default_pet_origin_for_monitor(
        placement, width, height, &monitor,
    ))
}

fn default_pet_origin_for_monitor(
    placement: &str,
    width: f64,
    height: f64,
    monitor: &tauri::Monitor,
) -> (f64, f64) {
    let screen = monitor.size();
    let screen_pos = monitor.position();
    let work_area = monitor.work_area();
    let screen_rect = Rect {
        x: f64::from(screen_pos.x),
        y: f64::from(screen_pos.y),
        width: f64::from(screen.width),
        height: f64::from(screen.height),
    };
    let work_rect = Rect {
        x: f64::from(work_area.position.x),
        y: f64::from(work_area.position.y),
        width: f64::from(work_area.size.width),
        height: f64::from(work_area.size.height),
    };
    let scale_factor = monitor.scale_factor();
    default_pet_origin_for_rects(
        placement,
        width * scale_factor,
        height * scale_factor,
        screen_rect,
        work_rect,
    )
}

fn frontmost_monitor(app: &tauri::AppHandle) -> Option<tauri::Monitor> {
    let (x, y) = native::frontmost_window_center().or_else(native::cursor_position)?;
    app.available_monitors().ok()?.into_iter().find(|monitor| {
        let scale_factor = monitor.scale_factor();
        let position = monitor.position().to_logical::<f64>(scale_factor);
        let size = monitor.size().to_logical::<f64>(scale_factor);
        x >= position.x
            && x < position.x + size.width
            && y >= position.y
            && y < position.y + size.height
    })
}

fn monitors_match(left: &tauri::Monitor, right: &tauri::Monitor) -> bool {
    left.position() == right.position() && left.size() == right.size()
}

fn remap_pet_origin_between_monitors(
    origin: (f64, f64),
    source_size: (f64, f64),
    target_size: (f64, f64),
    source: &tauri::Monitor,
    target: &tauri::Monitor,
) -> (f64, f64) {
    let source_work = source.work_area();
    let target_work = target.work_area();
    let source_max_x =
        f64::from(source_work.position.x) + f64::from(source_work.size.width) - source_size.0;
    let source_max_y =
        f64::from(source_work.position.y) + f64::from(source_work.size.height) - source_size.1;
    let x_ratio = normalized_position(origin.0, f64::from(source_work.position.x), source_max_x);
    let y_ratio = normalized_position(origin.1, f64::from(source_work.position.y), source_max_y);
    (
        mapped_position(
            x_ratio,
            f64::from(target_work.position.x),
            f64::from(target_work.position.x) + f64::from(target_work.size.width) - target_size.0,
        ),
        mapped_position(
            y_ratio,
            f64::from(target_work.position.y),
            f64::from(target_work.position.y) + f64::from(target_work.size.height) - target_size.1,
        ),
    )
}

fn normalized_position(value: f64, lower: f64, upper: f64) -> f64 {
    if upper <= lower {
        0.5
    } else {
        ((value - lower) / (upper - lower)).clamp(0.0, 1.0)
    }
}

fn mapped_position(ratio: f64, lower: f64, upper: f64) -> f64 {
    if upper <= lower {
        lower
    } else {
        lower + ratio.clamp(0.0, 1.0) * (upper - lower)
    }
}

fn schedule_pet_window_tracker_tick(app: &tauri::AppHandle, tracker: PetWindowTracker) {
    let config = tracker
        .config
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default();
    if !config.visible
        || tracker.paused.load(std::sync::atomic::Ordering::Acquire)
        || tracker
            .main_thread_tick_pending
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_err()
    {
        return;
    }

    let tick_app = app.clone();
    let tick_tracker = tracker.clone();
    if app
        .run_on_main_thread(move || {
            let mut moved_between_monitors = false;
            if let Some(window) = tick_app.get_webview_window("widget-pet-companion") {
                if !tick_tracker
                    .paused
                    .load(std::sync::atomic::Ordering::Acquire)
                {
                    if let (Some(target), Some(current)) = (
                        frontmost_monitor(&tick_app),
                        window.current_monitor().ok().flatten(),
                    ) {
                        if !monitors_match(&current, &target) {
                            let width = config.size.max((config.size + 280.0).min(420.0));
                            let height = config.size + 390.0;
                            let source_scale = current.scale_factor();
                            let target_scale = target.scale_factor();
                            let next_origin = if config.placement == "custom" {
                                window.outer_position().ok().map(|position| {
                                    remap_pet_origin_between_monitors(
                                        (f64::from(position.x), f64::from(position.y)),
                                        (width * source_scale, height * source_scale),
                                        (width * target_scale, height * target_scale),
                                        &current,
                                        &target,
                                    )
                                })
                            } else {
                                Some(default_pet_origin_for_monitor(
                                    &config.placement,
                                    width,
                                    height,
                                    &target,
                                ))
                            };
                            if let Some((x, y)) = next_origin {
                                moved_between_monitors = window
                                    .set_position(tauri::PhysicalPosition::new(
                                        x.round() as i32,
                                        y.round() as i32,
                                    ))
                                    .is_ok();
                                if moved_between_monitors {
                                    // Move the hidden lifecycle host first, copy the final
                                    // frame without drawing an intermediate position, then
                                    // reveal the NSPanel once on the target Space.
                                    sync_native_pet_panel_from_host(&window, false);
                                }
                                if moved_between_monitors && config.placement == "custom" {
                                    let _ = tick_app.emit_to(
                                        "main",
                                        "focus-pet-companion-moved",
                                        PetWindowFollowEvent {
                                            x,
                                            y,
                                            phase: "follow",
                                        },
                                    );
                                }
                            }
                        }
                    }
                    recover_pet_window_active_space(&window, moved_between_monitors);
                }
            }
            tick_tracker
                .main_thread_tick_pending
                .store(false, std::sync::atomic::Ordering::Release);
        })
        .is_err()
    {
        tracker
            .main_thread_tick_pending
            .store(false, std::sync::atomic::Ordering::Release);
    }
}

fn start_pet_window_tracker(app: &tauri::AppHandle, tracker: PetWindowTracker) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        schedule_pet_window_tracker_tick(&app, tracker.clone());
        std::thread::sleep(std::time::Duration::from_millis(500));
    });
}

#[cfg(target_os = "macos")]
fn install_macos_workspace_observers(
    app: &tauri::AppHandle,
    runtime: NativeRuntimeService,
    tracker: PetWindowTracker,
) {
    use block2::RcBlock;
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceActiveSpaceDidChangeNotification,
        NSWorkspaceDidActivateApplicationNotification, NSWorkspaceDidWakeNotification,
        NSWorkspaceScreensDidSleepNotification, NSWorkspaceScreensDidWakeNotification,
        NSWorkspaceSessionDidBecomeActiveNotification,
        NSWorkspaceSessionDidResignActiveNotification, NSWorkspaceWillSleepNotification,
    };
    use objc2_foundation::NSNotification;
    use std::ptr::NonNull;

    let workspace = NSWorkspace::sharedWorkspace();
    let center = workspace.notificationCenter();
    let notifications = unsafe {
        [
            (
                NSWorkspaceDidActivateApplicationNotification,
                "applicationActivated",
            ),
            (
                NSWorkspaceActiveSpaceDidChangeNotification,
                "activeSpaceChanged",
            ),
            (NSWorkspaceWillSleepNotification, "willSleep"),
            (NSWorkspaceDidWakeNotification, "didWake"),
            (NSWorkspaceScreensDidSleepNotification, "screensDidSleep"),
            (NSWorkspaceScreensDidWakeNotification, "screensDidWake"),
            (
                NSWorkspaceSessionDidResignActiveNotification,
                "sessionInactive",
            ),
            (
                NSWorkspaceSessionDidBecomeActiveNotification,
                "sessionActive",
            ),
        ]
    };
    for (name, kind) in notifications {
        let app = app.clone();
        let runtime = runtime.clone();
        let tracker = tracker.clone();
        let block = RcBlock::new(move |_notification: NonNull<NSNotification>| {
            let monitor_handoff = app
                .get_webview_window("widget-pet-companion")
                .and_then(|window| {
                    let current = window.current_monitor().ok().flatten()?;
                    let target = frontmost_monitor(&app)?;
                    Some(!monitors_match(&current, &target))
                })
                .unwrap_or(false);
            if kind == "activeSpaceChanged" || monitor_handoff {
                if let Some(window) = app.get_webview_window("widget-pet-companion") {
                    // An all-Spaces panel otherwise appears at its old coordinates
                    // before the frontmost display has settled. Keep it hidden for
                    // the short coordinate handoff and reveal only the final frame.
                    hide_native_pet_panel(&window);
                }
                let follow_app = app.clone();
                let follow_tracker = tracker.clone();
                let settle_delay = if kind == "activeSpaceChanged" { 80 } else { 0 };
                std::thread::spawn(move || {
                    if settle_delay > 0 {
                        std::thread::sleep(std::time::Duration::from_millis(settle_delay));
                    }
                    schedule_pet_window_tracker_tick(&follow_app, follow_tracker);
                });
            } else {
                schedule_pet_window_tracker_tick(&app, tracker.clone());
            }
            match kind {
                "willSleep" | "screensDidSleep" => {
                    if let Err(error) = runtime.handle_system_sleep(&app) {
                        log::warn!("macOS {kind} runtime update failed: {error}");
                    }
                }
                "didWake" | "screensDidWake" => {
                    let app = app.clone();
                    let runtime = runtime.clone();
                    std::thread::spawn(move || {
                        if let Err(error) = runtime.handle_system_wake(&app) {
                            log::warn!("macOS wake runtime refresh failed: {error}");
                        }
                    });
                }
                _ => {
                    let app = app.clone();
                    let runtime = runtime.clone();
                    std::thread::spawn(move || {
                        if let Err(error) = runtime.refresh_now(&app) {
                            log::warn!("macOS workspace runtime refresh failed: {error}");
                        }
                    });
                }
            }
        });
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
        };
        // NSNotificationCenter owns the observer for the lifetime of this
        // resident process. Keeping our retain prevents an accidental teardown
        // when setup returns.
        std::mem::forget(observer);
    }
}

#[cfg(not(target_os = "macos"))]
fn install_macos_workspace_observers(
    _app: &tauri::AppHandle,
    _runtime: NativeRuntimeService,
    _tracker: PetWindowTracker,
) {
}

/// A saved custom location can point at a disconnected monitor. Do not restore a
/// completely off-screen window: fall back to the selected placement instead.
fn pet_origin_is_visible(app: &tauri::AppHandle, x: f64, y: f64, width: f64, height: f64) -> bool {
    app.available_monitors()
        .ok()
        .unwrap_or_default()
        .into_iter()
        .any(|monitor| {
            let work_area = monitor.work_area();
            let scale_factor = monitor.scale_factor();
            window_intersects_rect(
                x,
                y,
                x + width * scale_factor,
                y + height * scale_factor,
                Rect {
                    x: f64::from(work_area.position.x),
                    y: f64::from(work_area.position.y),
                    width: f64::from(work_area.size.width),
                    height: f64::from(work_area.size.height),
                },
            )
        })
}

fn window_intersects_rect(left: f64, top: f64, right: f64, bottom: f64, rect: Rect) -> bool {
    left < rect.x + rect.width && right > rect.x && top < rect.y + rect.height && bottom > rect.y
}

#[derive(Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn default_pet_origin_for_rects(
    placement: &str,
    width: f64,
    height: f64,
    screen: Rect,
    work: Rect,
) -> (f64, f64) {
    let margin = 24.0;
    let dock_margin = 8.0;
    let (x, y) = match placement {
        "bottomLeft" => (work.x + margin, work.y + work.height - height - margin),
        "topRight" => (work.x + work.width - width - margin, work.y + margin),
        "topLeft" => (work.x + margin, work.y + margin),
        "dock" if work.y + work.height < screen.y + screen.height - 5.0 => (
            work.x + work.width - width - 80.0,
            work.y + work.height - height - dock_margin,
        ),
        "dock" if work.x > screen.x + 5.0 => {
            (work.x + dock_margin, work.y + work.height - height - 80.0)
        }
        "dock" if work.x + work.width < screen.x + screen.width - 5.0 => (
            work.x + work.width - width - dock_margin,
            work.y + work.height - height - 80.0,
        ),
        _ => (
            work.x + work.width - width - margin,
            work.y + work.height - height - margin,
        ),
    };
    (
        clamped_origin(x, work.x, work.x + work.width - width),
        clamped_origin(y, work.y, work.y + work.height - height),
    )
}

fn clamped_origin(value: f64, lower: f64, upper: f64) -> f64 {
    if upper < lower {
        lower
    } else {
        value.clamp(lower, upper)
    }
}

fn rect_contains_origin(rect: Rect, origin: (f64, f64)) -> bool {
    origin.0 >= rect.x
        && origin.0 < rect.x + rect.width
        && origin.1 >= rect.y
        && origin.1 < rect.y + rect.height
}

fn clamp_origin_to_work_area(
    origin: (f64, f64),
    physical_width: f64,
    physical_height: f64,
    work: Rect,
) -> (f64, f64) {
    (
        clamped_origin(origin.0, work.x, work.x + work.width - physical_width),
        clamped_origin(origin.1, work.y, work.y + work.height - physical_height),
    )
}

fn visible_widget_origin(
    app: &tauri::AppHandle,
    origin: (f64, f64),
    logical_width: f64,
    logical_height: f64,
) -> (f64, f64) {
    let monitors = app.available_monitors().unwrap_or_default();
    let target = monitors
        .iter()
        .find(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            rect_contains_origin(
                Rect {
                    x: f64::from(position.x),
                    y: f64::from(position.y),
                    width: f64::from(size.width),
                    height: f64::from(size.height),
                },
                origin,
            )
        })
        .cloned()
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| monitors.first().cloned());
    let Some(monitor) = target else {
        return origin;
    };
    let work = monitor.work_area();
    let scale_factor = monitor.scale_factor();
    clamp_origin_to_work_area(
        origin,
        logical_width * scale_factor,
        logical_height * scale_factor,
        Rect {
            x: f64::from(work.position.x),
            y: f64::from(work.position.y),
            width: f64::from(work.size.width),
            height: f64::from(work.size.height),
        },
    )
}

fn sync_widget_window(
    app: &tauri::AppHandle,
    label: &str,
    url: &str,
    visible: bool,
    width: f64,
    height: f64,
    origin: Option<(f64, f64)>,
) -> Result<(), String> {
    use tauri::{LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

    if label == "widget-pet-companion" {
        return sync_pet_companion_window(app, url, visible, width, height, origin);
    }

    if visible {
        let origin = origin.map(|value| visible_widget_origin(app, value, width, height));
        if let Some(window) = app.get_webview_window(label) {
            window.set_always_on_top(true).ok();
            window.set_visible_on_all_workspaces(true).ok();
            window.set_shadow(false).ok();
            window
                .set_size(LogicalSize::new(width, height))
                .map_err(|error| error.to_string())?;
            window.show().map_err(|error| error.to_string())?;
            if let Some((x, y)) = origin {
                let position = PhysicalPosition::new(x.round() as i32, y.round() as i32);
                window
                    .set_position(position)
                    .map_err(|error| error.to_string())?;
            }
            return Ok(());
        }
        let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
            .title("Focus Pet Widget")
            .inner_size(width, height)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .visible(origin.is_none());
        if let Some((x, y)) = origin {
            // Supplying the coordinate before WebView2 creates the native
            // window avoids its default cascade placement without resolving
            // an HWND (which can block Tauri's Windows event loop). The builder
            // uses logical pixels, so this is only an initial approximation;
            // the physical position below is the cross-DPI source of truth.
            builder = builder.position(x, y);
        }
        let window = builder.build().map_err(|error| error.to_string())?;
        if let Some((x, y)) = origin {
            window
                .set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
                .map_err(|error| error.to_string())?;
            window.show().map_err(|error| error.to_string())?;
        }
    } else if let Some(window) = app.get_webview_window(label) {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn sync_pet_companion_window(
    app: &tauri::AppHandle,
    url: &str,
    visible: bool,
    width: f64,
    height: f64,
    origin: Option<(f64, f64)>,
) -> Result<(), String> {
    use tauri::{LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

    let origin = origin.map(|value| visible_widget_origin(app, value, width, height));
    let window = match app.get_webview_window("widget-pet-companion") {
        Some(window) => window,
        None => {
            let mut builder =
                WebviewWindowBuilder::new(app, "widget-pet-companion", WebviewUrl::App(url.into()))
                    .title("Focus Pet Companion Host")
                    .inner_size(width, height)
                    .resizable(false)
                    .decorations(false)
                    .transparent(true)
                    .shadow(false)
                    .skip_taskbar(true)
                    // This NSWindow is only a Tauri/WKWebView lifecycle host.
                    // A genuine nonactivating NSPanel owns the WebView on macOS.
                    .visible(cfg!(not(target_os = "macos")));
            if let Some((x, y)) = origin {
                builder = builder.position(x, y);
            }
            builder.build().map_err(|error| error.to_string())?
        }
    };

    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    if let Some((x, y)) = origin {
        window
            .set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
            .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        if visible {
            configure_widget_macos_window(&window);
        } else {
            hide_native_pet_panel(&window);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.set_always_on_top(true).ok();
        window.set_visible_on_all_workspaces(true).ok();
        window.set_shadow(false).ok();
        if visible {
            window.show().map_err(|error| error.to_string())?;
        } else {
            window.hide().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn configure_widget_macos_window(window: &tauri::WebviewWindow) {
    if window.label() != "widget-pet-companion" {
        return;
    }
    let target = window.clone();
    let _ = window.with_webview(move |webview| {
        create_or_update_native_pet_panel(&target, webview.inner());
    });
}

#[cfg(not(target_os = "macos"))]
fn configure_widget_macos_window(_window: &tauri::WebviewWindow) {}

#[cfg(target_os = "macos")]
thread_local! {
    /// AppKit windows are main-thread confined. Keeping the strong reference in
    /// main-thread local storage makes that invariant explicit and avoids
    /// smuggling an NSPanel through a Send/Sync Rust state container.
    static NATIVE_PET_PANEL: std::cell::RefCell<Option<objc2::rc::Retained<objc2_app_kit::NSPanel>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(target_os = "macos")]
fn pet_panel_collection_behavior() -> objc2_app_kit::NSWindowCollectionBehavior {
    use objc2_app_kit::NSWindowCollectionBehavior;
    NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::FullScreenAuxiliary
}

#[cfg(target_os = "macos")]
fn create_or_update_native_pet_panel(
    host: &tauri::WebviewWindow,
    webview_ptr: *mut std::ffi::c_void,
) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSAutoresizingMaskOptions, NSBackingStoreType, NSColor, NSFloatingWindowLevel, NSPanel,
        NSView, NSWindow, NSWindowStyleMask,
    };

    let Some(mtm) = MainThreadMarker::new() else {
        log::error!("refused to create pet NSPanel away from the AppKit main thread");
        return;
    };
    let Ok(host_ptr) = host.ns_window() else {
        return;
    };
    if host_ptr.is_null() || webview_ptr.is_null() {
        return;
    }
    let host_window: &NSWindow = unsafe { &*host_ptr.cast() };

    NATIVE_PET_PANEL.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            let frame = host_window.frame();
            let panel = NSPanel::initWithContentRect_styleMask_backing_defer(
                mtm.alloc(),
                frame,
                NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
                NSBackingStoreType::Buffered,
                false,
            );
            panel.setCollectionBehavior(pet_panel_collection_behavior());
            panel.setFloatingPanel(true);
            panel.setHidesOnDeactivate(false);
            panel.setBecomesKeyOnlyIfNeeded(true);
            panel.setHasShadow(false);
            panel.setOpaque(false);
            panel.setBackgroundColor(Some(&NSColor::clearColor()));
            panel.setLevel(NSFloatingWindowLevel);
            panel.setExcludedFromWindowsMenu(true);
            panel.setMovable(false);
            panel.setMovableByWindowBackground(false);
            panel.setAcceptsMouseMovedEvents(true);
            unsafe {
                panel.setReleasedWhenClosed(false);
            }

            let webview: &NSView = unsafe { &*webview_ptr.cast() };
            webview.removeFromSuperview();
            panel.setContentView(Some(webview));
            webview.setFrame(panel.contentLayoutRect());
            webview.setAutoresizingMask(
                NSAutoresizingMaskOptions::ViewWidthSizable
                    | NSAutoresizingMaskOptions::ViewHeightSizable,
            );
            host_window.orderOut(None);
            log::info!(
                "created native desktop pet panel: class=NSPanel, nonactivating=true, all_spaces=true"
            );
            *slot = Some(panel);
        }

        if let Some(panel) = slot.as_ref() {
            panel.setFrame_display(host_window.frame(), true);
            panel.setCollectionBehavior(pet_panel_collection_behavior());
            panel.orderFrontRegardless();
            host_window.orderOut(None);
        }
    });
}

#[cfg(target_os = "macos")]
fn sync_native_pet_panel_from_host(window: &tauri::WebviewWindow, display: bool) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        use objc2_app_kit::NSWindow;

        let Ok(host_ptr) = target.ns_window() else {
            return;
        };
        if host_ptr.is_null() {
            return;
        }
        let host: &NSWindow = unsafe { &*host_ptr.cast() };
        let updated = NATIVE_PET_PANEL.with(|slot| {
            if let Some(panel) = slot.borrow().as_ref() {
                panel.setFrame_display(host.frame(), display);
                host.orderOut(None);
                true
            } else {
                false
            }
        });
        if !updated {
            configure_widget_macos_window(&target);
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn sync_native_pet_panel_from_host(_window: &tauri::WebviewWindow, _display: bool) {}

#[cfg(target_os = "macos")]
fn hide_native_pet_panel(window: &tauri::WebviewWindow) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        use objc2_app_kit::NSWindow;

        NATIVE_PET_PANEL.with(|slot| {
            if let Some(panel) = slot.borrow().as_ref() {
                panel.orderOut(None);
            }
        });
        if let Ok(host_ptr) = target.ns_window() {
            if !host_ptr.is_null() {
                let host: &NSWindow = unsafe { &*host_ptr.cast() };
                host.orderOut(None);
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn set_native_pet_panel_ignores_mouse_events(window: &tauri::WebviewWindow, ignores: bool) {
    let target = window.clone();
    let _ = window.with_webview(move |webview| {
        create_or_update_native_pet_panel(&target, webview.inner());
        NATIVE_PET_PANEL.with(|slot| {
            if let Some(panel) = slot.borrow().as_ref() {
                panel.setIgnoresMouseEvents(ignores);
            }
        });
    });
}

#[cfg(not(target_os = "macos"))]
fn set_native_pet_panel_ignores_mouse_events(window: &tauri::WebviewWindow, ignores: bool) {
    window.set_ignore_cursor_events(ignores).ok();
}

#[cfg(target_os = "macos")]
fn recover_pet_window_active_space(window: &tauri::WebviewWindow, emit_wake: bool) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let recovered = NATIVE_PET_PANEL.with(|slot| {
            if let Some(panel) = slot.borrow().as_ref() {
                panel.setCollectionBehavior(pet_panel_collection_behavior());
                panel.orderFrontRegardless();
                true
            } else {
                false
            }
        });
        if !recovered {
            configure_widget_macos_window(&target);
        }
        if emit_wake {
            let _ = target.emit("focus-pet-companion-wake", ());
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn recover_pet_window_active_space(_window: &tauri::WebviewWindow, _emit_wake: bool) {}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        window.show().ok();
        window.unminimize().ok();
        window.set_focus().ok();
    }
}

#[cfg(target_os = "macos")]
fn configure_main_macos_window(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowStyleMask, NSWindowTitleVisibility};

    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    if ns_window_ptr.is_null() {
        return;
    }

    let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast() };
    let style = ns_window.styleMask() | NSWindowStyleMask::FullSizeContentView;
    ns_window.setStyleMask(style);
    ns_window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
    ns_window.setTitlebarAppearsTransparent(true);
    ns_window.deminiaturize(None);
    ns_window.makeKeyAndOrderFront(None);
    ns_window.orderFrontRegardless();
}

#[cfg(not(target_os = "macos"))]
fn configure_main_macos_window(_window: &tauri::WebviewWindow) {}

#[cfg(target_os = "macos")]
fn activate_macos_app() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationOptions, NSApplicationActivationPolicy,
        NSRunningApplication,
    };

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    app.activate();
    NSRunningApplication::currentApplication()
        .activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows);
}

#[cfg(not(target_os = "macos"))]
fn activate_macos_app() {}

fn ensure_main_window(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
    use tauri::{LogicalSize, WebviewUrl, WebviewWindowBuilder};

    let window = match app.get_webview_window("main") {
        Some(window) => window,
        None => WebviewWindowBuilder::new(app, "main", WebviewUrl::App("/".into()))
            .title("Focus Pet")
            .inner_size(1180.0, 820.0)
            .min_inner_size(980.0, 760.0)
            .resizable(true)
            .fullscreen(false)
            .visible(true)
            .build()?,
    };
    configure_main_macos_window(&window);
    window
        .set_min_size(Some(LogicalSize::new(980.0, 760.0)))
        .ok();
    window.set_size(LogicalSize::new(1180.0, 820.0)).ok();
    window.center().ok();
    window.show().ok();
    window.unminimize().ok();
    window.set_focus().ok();
    activate_macos_app();
    Ok(())
}

fn emit_menu_action(app: &tauri::AppHandle, action: &str) {
    show_main_window(app);
    app.emit_to(
        "main",
        "focus-pet-native-menu",
        NativeMenuAction {
            action: action.to_string(),
        },
    )
    .ok();
}

fn handle_native_menu_action(app: &tauri::AppHandle, action: &str) {
    match action {
        TRAY_OPEN_TODAY => emit_menu_action(app, TRAY_OPEN_TODAY),
        TRAY_OPEN_PET => emit_menu_action(app, TRAY_OPEN_PET),
        TRAY_OPEN_SETTINGS => emit_menu_action(app, TRAY_OPEN_SETTINGS),
        TRAY_TOGGLE_WIDGETS => emit_menu_action(app, TRAY_TOGGLE_WIDGETS),
        TRAY_TOGGLE_PET => emit_menu_action(app, TRAY_TOGGLE_PET),
        TRAY_PAUSE_REMINDERS => emit_menu_action(app, TRAY_PAUSE_REMINDERS),
        TRAY_RESUME_REMINDERS => emit_menu_action(app, TRAY_RESUME_REMINDERS),
        TRAY_FINISH_FOCUS => emit_menu_action(app, TRAY_FINISH_FOCUS),
        TRAY_QUIT => {
            codex_sessions::stop_focus_pet_ephemeral_app_server();
            app.exit(0);
        }
        _ => {}
    }
}

#[cfg(desktop)]
fn install_desktop_menu(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, SubmenuBuilder};

    let app_menu = SubmenuBuilder::new(app, "Focus Pet")
        .text(TRAY_OPEN_TODAY, "打开面板")
        .text(TRAY_OPEN_SETTINGS, "设置")
        .separator()
        .text(TRAY_TOGGLE_WIDGETS, "显示/隐藏桌面状态卡")
        .text(TRAY_TOGGLE_PET, "显示/隐藏桌宠")
        .separator()
        .text(TRAY_PAUSE_REMINDERS, "暂停提醒")
        .text(TRAY_RESUME_REMINDERS, "恢复提醒")
        .text(TRAY_FINISH_FOCUS, "结束当前专注")
        .separator()
        .text(TRAY_QUIT, "退出")
        .build()?;

    let menu = MenuBuilder::new(app).item(&app_menu).build()?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg(desktop)]
fn install_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::MenuBuilder,
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };

    let menu = MenuBuilder::new(app)
        .text(TRAY_OPEN_TODAY, "打开 Focus Pet")
        .text(TRAY_OPEN_PET, "桌宠设置")
        .text(TRAY_OPEN_SETTINGS, "设置")
        .separator()
        .text(TRAY_TOGGLE_WIDGETS, "显示/隐藏桌面状态卡")
        .text(TRAY_TOGGLE_PET, "显示/隐藏桌宠")
        .text(TRAY_PAUSE_REMINDERS, "暂停提醒")
        .text(TRAY_RESUME_REMINDERS, "恢复提醒")
        .text(TRAY_FINISH_FOCUS, "结束当前专注")
        .separator()
        .text(TRAY_QUIT, "退出")
        .build()?;

    let mut tray = TrayIconBuilder::with_id("focus-pet")
        .menu(&menu)
        .tooltip("Focus Pet")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            handle_native_menu_action(app, event.id().as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            let should_toggle = matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            );
            if should_toggle {
                toggle_menu_bar_window(tray.app_handle());
            }
        });

    let status_icon =
        tauri::image::Image::from_bytes(include_bytes!("../../public/assets/StatusIcon.png"))?;
    tray = tray.icon(status_icon);

    #[cfg(target_os = "macos")]
    {
        tray = tray.icon_as_template(true);
    }

    tray.build(app)?;
    Ok(())
}

#[cfg(not(desktop))]
fn install_tray(_app: &mut tauri::App) -> tauri::Result<()> {
    Ok(())
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::{
        clamp_origin_to_work_area, default_pet_origin_for_rects, installation_snapshot_for_path,
        is_native_menu_action, is_running_from_mounted_volume_path, mapped_position,
        normalized_position, rect_contains_origin, Rect,
    };
    use std::path::Path;
    #[cfg(target_os = "windows")]
    use std::path::PathBuf;

    const SCREEN: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 1440.0,
        height: 900.0,
    };

    #[test]
    fn native_menu_rejects_unknown_actions() {
        for action in [
            "open-today",
            "open-pet",
            "open-settings",
            "toggle-widgets",
            "toggle-pet",
            "pause-reminders",
            "resume-reminders",
            "finish-focus",
            "quit",
        ] {
            assert!(is_native_menu_action(action), "missing {action}");
        }
        assert!(!is_native_menu_action("delete-all-data"));
        assert!(!is_native_menu_action(""));
    }

    #[test]
    fn persisted_widget_origins_are_kept_inside_physical_work_areas() {
        let primary_work = Rect {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 860.0,
        };
        assert_eq!(
            clamp_origin_to_work_area((1500.0, 900.0), 300.0, 200.0, primary_work),
            (1140.0, 660.0)
        );

        let left_monitor_work = Rect {
            x: -1920.0,
            y: 0.0,
            width: 1920.0,
            height: 1040.0,
        };
        assert!(rect_contains_origin(left_monitor_work, (-1800.0, 120.0)));
        assert_eq!(
            clamp_origin_to_work_area((-1800.0, 120.0), 450.0, 300.0, left_monitor_work),
            (-1800.0, 120.0)
        );
    }

    #[test]
    fn pet_screen_follow_preserves_relative_position() {
        let ratio = normalized_position(370.0, 100.0, 1000.0);
        assert!((ratio - 0.3).abs() < f64::EPSILON);
        assert!((mapped_position(ratio, -1920.0, -420.0) - (-1470.0)).abs() < f64::EPSILON);
        let reverse_ratio = normalized_position(-1470.0, -1920.0, -420.0);
        assert!((reverse_ratio - ratio).abs() < f64::EPSILON);
        assert!((mapped_position(reverse_ratio, 100.0, 1000.0) - 370.0).abs() < f64::EPSILON);
        assert_eq!(mapped_position(-1.0, 100.0, 1000.0), 100.0);
        assert_eq!(mapped_position(2.0, 100.0, 1000.0), 1000.0);
        assert_eq!(normalized_position(50.0, 100.0, 100.0), 0.5);
    }

    #[test]
    fn dock_pet_origin_tracks_bottom_taskbar_work_area() {
        let work = Rect {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 860.0,
        };
        assert_eq!(
            default_pet_origin_for_rects("dock", 240.0, 240.0, SCREEN, work),
            (1120.0, 612.0)
        );
    }

    #[test]
    fn dock_pet_origin_tracks_side_taskbars() {
        let left_work = Rect {
            x: 64.0,
            y: 0.0,
            width: 1376.0,
            height: 900.0,
        };
        assert_eq!(
            default_pet_origin_for_rects("dock", 240.0, 240.0, SCREEN, left_work),
            (72.0, 580.0)
        );

        let right_work = Rect {
            x: 0.0,
            y: 0.0,
            width: 1376.0,
            height: 900.0,
        };
        assert_eq!(
            default_pet_origin_for_rects("dock", 240.0, 240.0, SCREEN, right_work),
            (1128.0, 580.0)
        );
    }

    #[test]
    fn pet_corner_placement_uses_work_area_edges() {
        let work = Rect {
            x: 40.0,
            y: 24.0,
            width: 1360.0,
            height: 820.0,
        };
        assert_eq!(
            default_pet_origin_for_rects("topLeft", 240.0, 240.0, SCREEN, work),
            (64.0, 48.0)
        );
        assert_eq!(
            default_pet_origin_for_rects("bottomRight", 240.0, 240.0, SCREEN, work),
            (1136.0, 580.0)
        );
    }

    #[test]
    fn offscreen_custom_pet_origin_is_rejected() {
        let work = Rect {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 860.0,
        };
        assert!(!super::window_intersects_rect(
            1964.0, 1592.0, 2277.0, 2019.0, work
        ));
        assert!(super::window_intersects_rect(
            1200.0, 600.0, 1513.0, 1027.0, work
        ));
    }

    #[test]
    fn installation_snapshot_detects_mounted_and_installed_macos_paths() {
        let mounted = Path::new("/Volumes/Focus Pet Installer/Focus Pet.app");
        let installed = Path::new("/Applications/Focus Pet.app");
        let user_installed = Path::new("/Users/tester/Applications/Focus Pet.app");

        assert!(is_running_from_mounted_volume_path(mounted));
        assert!(!is_running_from_mounted_volume_path(installed));

        let snapshot = installation_snapshot_for_path(
            mounted,
            "com.focuspet.FocusPet",
            "0.1.0",
            Some(Path::new("/Users/tester")),
        );
        assert!(snapshot.is_running_from_mounted_volume);
        assert!(!snapshot.is_installed);

        let installed_snapshot = installation_snapshot_for_path(
            installed,
            "com.focuspet.FocusPet",
            "0.1.0",
            Some(Path::new("/Users/tester")),
        );
        assert_eq!(
            installed_snapshot.build_identifier,
            "com.focuspet.FocusPet|0.1.0"
        );

        #[cfg(target_os = "macos")]
        {
            assert!(installed_snapshot.is_installed);
            assert!(
                installation_snapshot_for_path(
                    user_installed,
                    "com.focuspet.FocusPet",
                    "0.1.0",
                    Some(Path::new("/Users/tester")),
                )
                .is_installed
            );
        }

        #[cfg(not(target_os = "macos"))]
        {
            assert!(!installed_snapshot.is_installed);
            assert!(
                !installation_snapshot_for_path(
                    user_installed,
                    "com.focuspet.FocusPet",
                    "0.1.0",
                    Some(Path::new("/Users/tester")),
                )
                .is_installed
            );
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn installation_snapshot_accepts_current_user_nsis_paths_with_boundaries() {
        let roots = [
            PathBuf::from(r"C:\Program Files"),
            PathBuf::from(r"C:\Users\tester\AppData\Local"),
        ];
        assert!(super::is_windows_installed_path(
            Path::new(r"C:\Users\tester\AppData\Local\Focus Pet\focus-pet.exe"),
            &roots,
        ));
        assert!(super::is_windows_installed_path(
            Path::new(r"C:\Program Files\Focus Pet\focus-pet.exe"),
            &roots,
        ));
        assert!(!super::is_windows_installed_path(
            Path::new(r"C:\Program FilesEvil\Focus Pet\focus-pet.exe"),
            &roots,
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_icon_source_requires_an_existing_executable_path() {
        let current = std::env::current_exe().expect("test executable path");
        assert_eq!(
            super::windows_icon_source(Some(current.to_string_lossy().as_ref())),
            Some(current)
        );
        assert!(super::windows_icon_source(None).is_none());
        assert!(super::windows_icon_source(Some(r"C:\missing\focus-pet.exe")).is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_store_package_paths_are_detected_without_matching_similar_paths() {
        assert!(super::is_windows_store_package_path(Path::new(
            r"C:\Program Files\WindowsApps\OpenAI.Codex_1\app\ChatGPT.exe"
        )));
        assert!(!super::is_windows_store_package_path(Path::new(
            r"C:\Program Files\WindowsAppsBackup\OpenAI.Codex\ChatGPT.exe"
        )));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            app.manage(SystemMonitorState::new());
            let pet_window_tracker = PetWindowTracker::default();
            let native_runtime =
                NativeRuntimeService::new(app.handle()).map_err(std::io::Error::other)?;
            native_runtime.start(app.handle().clone());
            install_macos_workspace_observers(
                app.handle(),
                native_runtime.clone(),
                pet_window_tracker.clone(),
            );
            app.manage(native_runtime);
            let codex_sessions = CodexSessionManager::new();
            let ssh_sessions = SshSessionManager::new();
            start_codex_session_event_bridges(
                app.handle(),
                codex_sessions.clone(),
                ssh_sessions.clone(),
            );
            start_default_codex_integrations(codex_sessions.clone(), ssh_sessions.clone());
            app.manage(codex_sessions);
            app.manage(ssh_sessions);
            start_pet_window_tracker(app.handle(), pet_window_tracker.clone());
            app.manage(pet_window_tracker);
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);
            #[cfg(desktop)]
            install_desktop_menu(app)?;
            install_tray(app)?;
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);
            ensure_main_window(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    window.hide().ok();
                }
            }
            if window.label() == "widget-menu-bar" {
                if let tauri::WindowEvent::Focused(false) = event {
                    window.hide().ok();
                }
            }
        })
        .on_menu_event(|app, event| {
            handle_native_menu_action(app, event.id().as_ref());
        })
        .invoke_handler(tauri::generate_handler![
            load_snapshot,
            save_snapshot,
            native_runtime_snapshot,
            perform_menu_bar_action,
            quit_app,
            sample_activity,
            sample_system_metrics,
            drain_agent_events,
            agent_event_inbox_path,
            drain_codex_session_events,
            codex_session_snapshot,
            codex_integration_status,
            set_codex_sync_preferences,
            start_codex_managed_daemon,
            poll_codex_managed_status,
            install_codex_hooks,
            uninstall_codex_hooks,
            discover_codex_ssh_hosts,
            save_codex_ssh_host,
            forget_codex_ssh_host,
            diagnose_codex_ssh_host,
            provision_codex_ssh_host,
            uninstall_codex_ssh_host,
            connect_codex_ssh_host,
            drain_codex_ssh_events,
            codex_ssh_connection_status,
            app_icon,
            installation_snapshot,
            choose_and_import_pet_pack,
            import_pet_pack_from_path,
            list_pet_packs,
            pet_pack_assets,
            delete_pet_pack,
            deliver_notification,
            set_pet_window_tracking_paused,
            set_pet_panel_position,
            set_pet_panel_ignores_mouse_events,
            sync_widget_windows
        ])
        .run(tauri::generate_context!())
        .expect("error while running Focus Pet");
}

/// The official App Server stream, Hooks and rollout transcript reader all
/// feed the same normalized reducer. Hooks return quickly; this bridge emits
/// updates to the webview in sub-second batches and retains command polling
/// only as a recovery fallback for older Codex runtimes.
fn start_codex_session_event_bridges(
    app: &tauri::AppHandle,
    codex: CodexSessionManager,
    ssh: SshSessionManager,
) {
    let local_app = app.clone();
    let local_codex = codex.clone();
    std::thread::spawn(move || loop {
        if let Ok(events) = local_codex.drain() {
            if !events.is_empty() {
                let _ = local_app.emit("codex-session-events", events);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    });

    let ssh_app = app.clone();
    std::thread::spawn(move || loop {
        if let Ok(events) = ssh.drain().and_then(|events| codex.ingest_external(events)) {
            if !events.is_empty() {
                let _ = ssh_app.emit("codex-session-events", events);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    });
}

/// Configure the privacy-preserving Codex integration on every app launch.
/// All operations are idempotent and run away from the UI thread. SSH hosts
/// are connected independently so one offline alias cannot delay a live host.
fn start_default_codex_integrations(codex: CodexSessionManager, ssh: SshSessionManager) {
    std::thread::spawn(move || {
        let _ = codex_sessions::set_sync_preferences(CodexSyncPreferences::default());
        if let Err(error) = codex_sessions::install_hooks() {
            log::warn!("Codex Hook automatic setup skipped: {error}");
        }
        match codex_sessions::start_managed_daemon() {
            Ok(true) => codex_sessions::start_managed_event_stream(codex),
            Ok(false) => {}
            Err(error) => log::warn!("Codex App Server automatic setup unavailable: {error}"),
        }

        let hosts = match ssh_sessions::discover_hosts() {
            Ok(hosts) => hosts,
            Err(error) => {
                log::warn!("Codex SSH host discovery failed: {error}");
                return;
            }
        };
        for host in hosts {
            let manager = ssh.clone();
            std::thread::spawn(move || {
                loop {
                    if let Err(error) = manager.connect(&host.alias) {
                        log::info!("Codex SSH host {} is unavailable: {error}", host.alias);
                    }
                    // `connect` is idempotent while a live/reconnecting worker
                    // owns the host. This supervisor only retries failures that
                    // happened before a worker could be established.
                    std::thread::sleep(std::time::Duration::from_secs(30));
                }
            });
        }
    });
}
