use serde::Serialize;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeActivitySample {
    pub timestamp: String,
    pub platform: String,
    pub sample_quality: String,
    pub app_name: String,
    #[serde(rename = "bundleID")]
    pub bundle_id: Option<String>,
    pub window_title: Option<String>,
    pub idle_seconds: f64,
    pub input_monitoring_status: String,
    pub keyboard_count: u32,
    pub pointer_count: u32,
    pub switch_count: u32,
    pub is_system_sleeping: bool,
    pub is_screen_locked: bool,
}

#[derive(Debug, Clone)]
pub struct RawActivitySample {
    pub timestamp: String,
    pub platform: String,
    pub sample_quality: String,
    pub app_name: String,
    pub bundle_id: Option<String>,
    pub window_title: Option<String>,
    pub idle_seconds: f64,
    pub input_monitoring_status: String,
    pub keyboard_count: u32,
    pub pointer_count: u32,
    pub switch_count: u32,
    pub is_system_sleeping: bool,
    pub is_screen_locked: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSnapshot {
    pub refreshed_at: String,
    pub input_monitoring: String,
    pub notifications: String,
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod unsupported;
#[cfg(target_os = "windows")]
mod windows;

pub fn sample_activity() -> NativeActivitySample {
    enrich_sample(platform::sample_activity())
}

pub fn permission_snapshot() -> PermissionSnapshot {
    platform::permission_snapshot()
}

pub fn open_system_settings(destination: &str) -> bool {
    platform::open_system_settings(destination)
}

pub fn open_path(path: &Path) -> bool {
    if !path.exists() {
        if path.extension().is_some() {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
        } else {
            std::fs::create_dir_all(path).ok();
        }
    }
    open::that(path).is_ok()
}

#[cfg(target_os = "macos")]
mod platform {
    pub use super::macos::*;
}
#[cfg(target_os = "windows")]
mod platform {
    pub use super::windows::*;
}
#[cfg(target_os = "linux")]
mod platform {
    pub use super::linux::*;
}
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod platform {
    pub use super::unsupported::*;
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn enrich_sample(raw: RawActivitySample) -> NativeActivitySample {
    let mut tracker = activity_tracker()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (switch_count, keyboard_count, pointer_count) = tracker.update(&raw);
    NativeActivitySample {
        timestamp: raw.timestamp,
        platform: raw.platform,
        sample_quality: raw.sample_quality,
        app_name: raw.app_name,
        bundle_id: raw.bundle_id,
        window_title: raw.window_title,
        idle_seconds: raw.idle_seconds,
        input_monitoring_status: raw.input_monitoring_status,
        keyboard_count: raw.keyboard_count.max(keyboard_count),
        pointer_count: raw.pointer_count.max(pointer_count),
        switch_count: raw.switch_count.max(switch_count),
        is_system_sleeping: raw.is_system_sleeping,
        is_screen_locked: raw.is_screen_locked,
    }
}

fn activity_tracker() -> &'static Mutex<ActivityDeltaTracker> {
    static TRACKER: OnceLock<Mutex<ActivityDeltaTracker>> = OnceLock::new();
    TRACKER.get_or_init(|| Mutex::new(ActivityDeltaTracker::default()))
}

#[derive(Default)]
struct ActivityDeltaTracker {
    current_identity: Option<String>,
    last_idle_seconds: Option<f64>,
    last_sample_at: Option<Instant>,
}

impl ActivityDeltaTracker {
    fn update(&mut self, sample: &RawActivitySample) -> (u32, u32, u32) {
        let identity = app_identity(sample);
        let switch_count = match self.current_identity.as_deref() {
            Some(previous) if previous != identity => 1,
            Some(_) => 0,
            None => 0,
        };
        self.current_identity = Some(identity.to_string());

        let now = Instant::now();
        let elapsed = self
            .last_sample_at
            .map(|last| now.saturating_duration_since(last).as_secs_f64())
            .unwrap_or(1.0);
        let fallback_has_input = self.last_idle_seconds.is_some_and(|previous_idle| {
            sample.idle_seconds <= previous_idle || sample.idle_seconds <= elapsed + 1.5
        });
        self.last_idle_seconds = Some(sample.idle_seconds.max(0.0));
        self.last_sample_at = Some(now);

        let keyboard_count = u32::from(fallback_has_input);
        let pointer_count = u32::from(fallback_has_input);
        (switch_count, keyboard_count, pointer_count)
    }
}

fn app_identity(sample: &RawActivitySample) -> &str {
    sample.bundle_id.as_deref().unwrap_or(&sample.app_name)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn run_text_command(program: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

pub fn run_command_success(program: &str, args: &[&str]) -> bool {
    std::process::Command::new(program)
        .args(args)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(any(target_os = "linux"))]
pub fn shell_text(script: &str) -> Option<String> {
    run_text_command("sh", &["-lc", script])
}

#[cfg(test)]
mod tests {
    use super::{app_identity, ActivityDeltaTracker, NativeActivitySample, RawActivitySample};

    #[test]
    fn native_activity_sample_uses_frontend_camel_case_contract() {
        let sample = NativeActivitySample {
            timestamp: "2026-07-08T00:00:00.000Z".to_string(),
            platform: "test".to_string(),
            sample_quality: "contract".to_string(),
            app_name: "Focus Pet".to_string(),
            bundle_id: Some("com.focuspet.FocusPet".to_string()),
            window_title: Some("Dashboard".to_string()),
            idle_seconds: 1.5,
            input_monitoring_status: "available".to_string(),
            keyboard_count: 2,
            pointer_count: 3,
            switch_count: 4,
            is_system_sleeping: false,
            is_screen_locked: false,
        };
        let value = serde_json::to_value(sample).expect("sample serializes");
        assert_eq!(value["sampleQuality"], "contract");
        assert_eq!(value["appName"], "Focus Pet");
        assert_eq!(value["bundleID"], "com.focuspet.FocusPet");
        assert_eq!(value["windowTitle"], "Dashboard");
        assert_eq!(value["idleSeconds"], 1.5);
        assert_eq!(value["inputMonitoringStatus"], "available");
        assert_eq!(value["keyboardCount"], 2);
        assert_eq!(value["pointerCount"], 3);
        assert_eq!(value["switchCount"], 4);
        assert_eq!(value["isSystemSleeping"], false);
        assert_eq!(value["isScreenLocked"], false);
    }

    #[test]
    fn activity_delta_tracker_counts_app_switches_and_idle_fallback_input() {
        let mut tracker = ActivityDeltaTracker::default();
        let first = raw_sample("Code", Some("com.microsoft.VSCode"), 12.0);
        assert_eq!(tracker.update(&first), (0, 0, 0));

        let second = raw_sample("Code", Some("com.microsoft.VSCode"), 0.2);
        assert_eq!(tracker.update(&second), (0, 1, 1));

        let third = raw_sample("Browser", Some("com.apple.Safari"), 0.5);
        assert_eq!(tracker.update(&third).0, 1);
        assert_eq!(app_identity(&third), "com.apple.Safari");
    }

    #[cfg(unix)]
    #[test]
    fn command_success_uses_exit_status_without_stdout() {
        assert!(super::run_command_success("sh", &["-c", "true"]));
        assert!(!super::run_command_success("sh", &["-c", "false"]));
    }

    #[cfg(windows)]
    #[test]
    fn command_success_uses_windows_exit_status_without_stdout() {
        assert!(super::run_command_success(
            "powershell",
            &["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
        ));
        assert!(!super::run_command_success(
            "powershell",
            &["-NoProfile", "-NonInteractive", "-Command", "exit 1"],
        ));
    }

    fn raw_sample(app_name: &str, bundle_id: Option<&str>, idle_seconds: f64) -> RawActivitySample {
        RawActivitySample {
            timestamp: "2026-07-08T00:00:00.000Z".to_string(),
            platform: "test".to_string(),
            sample_quality: "test".to_string(),
            app_name: app_name.to_string(),
            bundle_id: bundle_id.map(str::to_string),
            window_title: None,
            idle_seconds,
            input_monitoring_status: "test".to_string(),
            keyboard_count: 0,
            pointer_count: 0,
            switch_count: 0,
            is_system_sleeping: false,
            is_screen_locked: false,
        }
    }
}
