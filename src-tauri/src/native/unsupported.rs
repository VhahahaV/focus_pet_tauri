use super::{now_iso, NativeActivitySample, PermissionSnapshot};

pub fn sample_activity() -> NativeActivitySample {
    NativeActivitySample {
        timestamp: now_iso(),
        platform: "unsupported".to_string(),
        sample_quality: "unsupported".to_string(),
        app_name: "Unsupported platform".to_string(),
        bundle_id: None,
        window_title: None,
        idle_seconds: 0.0,
        input_monitoring_status: "unsupported".to_string(),
        keyboard_count: 0,
        pointer_count: 0,
        switch_count: 0,
        is_system_sleeping: false,
        is_screen_locked: false,
    }
}

pub fn permission_snapshot() -> PermissionSnapshot {
    PermissionSnapshot {
        refreshed_at: now_iso(),
        input_monitoring: "unsupported".to_string(),
        notifications: "unsupported".to_string(),
    }
}

pub fn open_system_settings(_destination: &str) -> bool {
    false
}
