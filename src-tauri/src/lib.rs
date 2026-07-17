mod agent_events;
mod native;
mod notifications;
mod pet_pack;
mod store;
mod system_monitor;

use native::{NativeActivitySample, PermissionSnapshot};
use agent_events::AgentCompletionEvent;
use pet_pack::ImportedPetPack;
use serde_json::Value;
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

#[derive(Clone, serde::Serialize)]
struct NativeMenuAction {
    action: String,
}

#[tauri::command]
fn perform_menu_bar_action(app: tauri::AppHandle, action: String) -> bool {
    handle_native_menu_action(&app, &action);
    true
}

#[tauri::command]
fn sample_system_metrics(state: tauri::State<'_, SystemMonitorState>) -> Result<SystemMetricsSample, String> {
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

pub fn maybe_handle_agent_notification() -> bool {
    agent_events::maybe_ingest_from_process_args()
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
async fn load_snapshot(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        FocusPetStore::new(&app)
            .map_err(|error| error.to_string())?
            .load_snapshot()
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn save_snapshot(app: tauri::AppHandle, snapshot: Value) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        FocusPetStore::new(&app)
            .map_err(|error| error.to_string())?
            .save_snapshot(&snapshot)
            .map(|_| true)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn export_snapshot(
    app: tauri::AppHandle,
    snapshot: Value,
    redacted: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        FocusPetStore::new(&app)
            .map_err(|error| error.to_string())?
            .export_snapshot(&snapshot, redacted)
            .map(|path| path.to_string_lossy().to_string())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn delete_all_data(app: tauri::AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        FocusPetStore::new(&app)
            .map_err(|error| error.to_string())?
            .delete_all()
            .map(|_| true)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) -> bool {
    app.exit(0);
    true
}

#[tauri::command]
async fn data_size(app: tauri::AppHandle) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        FocusPetStore::new(&app)
            .map_err(|error| error.to_string())?
            .data_size()
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn sample_activity() -> NativeActivitySample {
    native::sample_activity()
}

#[tauri::command]
fn permission_snapshot() -> PermissionSnapshot {
    native::permission_snapshot()
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

#[cfg(not(target_os = "macos"))]
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
fn open_system_settings(destination: String) -> bool {
    native::open_system_settings(&destination)
}

#[tauri::command]
fn open_log_folder(app: tauri::AppHandle) -> bool {
    FocusPetStore::new(&app)
        .map(|store| native::open_path(&store.logs_dir()))
        .unwrap_or(false)
}

#[tauri::command]
fn current_log_file(app: tauri::AppHandle, open_file: bool) -> Result<String, String> {
    let path = FocusPetStore::new(&app)
        .map_err(|error| error.to_string())?
        .current_log_file()
        .map_err(|error| error.to_string())?;
    if open_file {
        native::open_path(&path);
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn choose_and_import_pet_pack(
    app: tauri::AppHandle,
) -> Result<Option<Vec<ImportedPetPack>>, String> {
    let Some(path) = pet_pack::choose_pet_pack_source() else {
        return Ok(None);
    };
    import_pet_pack_from_path(app, path.to_string_lossy().to_string()).map(Some)
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
fn deliver_notification(title: String, body: String) -> bool {
    notifications::deliver(&title, &body)
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
        let normalized = path.to_string_lossy().replace('/', "\\").to_lowercase();
        let mut roots = Vec::new();
        for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(value) = std::env::var_os(key) {
                let root = PathBuf::from(value);
                roots.push(if key == "LOCALAPPDATA" {
                    root.join("Programs")
                } else {
                    root
                });
            }
        }
        return roots
            .iter()
            .map(|root| root.to_string_lossy().replace('/', "\\").to_lowercase())
            .any(|root| normalized.starts_with(&root));
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

#[tauri::command]
fn sync_widget_windows(
    app: tauri::AppHandle,
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
    let pet_window_width = pet_size.max((pet_size + 190.0).min(330.0));
    let pet_window_height = pet_size + 310.0;
    let pet_origin = pet_origin_x.zip(pet_origin_y).or_else(|| {
        default_pet_origin(
            &app,
            pet_placement.as_str(),
            pet_window_width,
            pet_window_height,
        )
    });
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
    Some((
        f64::from(work_area.position.x) + f64::from(work_area.size.width) - width - 18.0,
        f64::from(work_area.position.y)
            + 12.0_f64.min((f64::from(work_area.size.height) - height).max(12.0)),
    ))
}

fn default_pet_origin(
    app: &tauri::AppHandle,
    placement: &str,
    width: f64,
    height: f64,
) -> Option<(f64, f64)> {
    use tauri::Manager;

    let monitor = app
        .get_webview_window("main")
        .and_then(|window| window.current_monitor().ok().flatten())
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
    Some(default_pet_origin_for_rects(
        placement,
        width,
        height,
        screen_rect,
        work_rect,
    ))
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

    if visible {
        if let Some(window) = app.get_webview_window(label) {
            window.show().map_err(|error| error.to_string())?;
            window.set_always_on_top(true).ok();
            window.set_visible_on_all_workspaces(true).ok();
            window.set_shadow(false).ok();
            window.set_size(LogicalSize::new(width, height)).ok();
            if let Some((x, y)) = origin {
                window.set_position(PhysicalPosition::new(x, y)).ok();
            }
            return Ok(());
        }
        let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
            .title("Focus Pet Widget")
            .inner_size(width, height)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .visible(true)
            .build()
            .map_err(|error| error.to_string())?;
        if let Some((x, y)) = origin {
            window.set_position(PhysicalPosition::new(x, y)).ok();
        }
    } else if let Some(window) = app.get_webview_window(label) {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

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
        TRAY_QUIT => app.exit(0),
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

    let status_icon = tauri::image::Image::from_bytes(include_bytes!(
        "../../public/assets/StatusIcon.png"
    ))?;
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
mod tests {
    use super::{
        default_pet_origin_for_rects, installation_snapshot_for_path,
        is_running_from_mounted_volume_path, Rect,
    };
    use std::path::Path;

    const SCREEN: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 1440.0,
        height: 900.0,
    };

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
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            app.manage(SystemMonitorState::new());
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
            export_snapshot,
            delete_all_data,
            perform_menu_bar_action,
            quit_app,
            data_size,
            sample_activity,
            sample_system_metrics,
            drain_agent_events,
            agent_event_inbox_path,
            permission_snapshot,
            app_icon,
            installation_snapshot,
            open_system_settings,
            open_log_folder,
            current_log_file,
            choose_and_import_pet_pack,
            import_pet_pack_from_path,
            list_pet_packs,
            pet_pack_assets,
            delete_pet_pack,
            deliver_notification,
            sync_widget_windows
        ])
        .run(tauri::generate_context!())
        .expect("error while running Focus Pet");
}
