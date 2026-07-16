use super::{now_iso, shell_text, PermissionSnapshot, RawActivitySample};
use std::process::Command;

pub fn sample_activity() -> RawActivitySample {
    let window = active_window();
    RawActivitySample {
        timestamp: now_iso(),
        platform: "linux".to_string(),
        sample_quality: window
            .as_ref()
            .map(|_| "active-window-idle-fallback-input".to_string())
            .unwrap_or_else(|| "fallback".to_string()),
        app_name: window
            .as_ref()
            .and_then(|sample| sample.app_name.clone())
            .or_else(|| {
                window
                    .as_ref()
                    .and_then(|sample| sample.window_title.clone())
            })
            .unwrap_or_else(|| "Linux desktop".to_string()),
        bundle_id: window
            .as_ref()
            .and_then(|sample| sample.window_class.clone()),
        window_title: window.and_then(|sample| sample.window_title),
        idle_seconds: idle_seconds(),
        input_monitoring_status: input_monitoring_status(),
        keyboard_count: 0,
        pointer_count: 0,
        is_system_sleeping: false,
        is_screen_locked: false,
    }
}

pub fn permission_snapshot() -> PermissionSnapshot {
    PermissionSnapshot {
        refreshed_at: now_iso(),
        input_monitoring: "desktop-session".to_string(),
        notifications: "freedesktop-notifications".to_string(),
    }
}

pub fn open_system_settings(destination: &str) -> bool {
    let target = match destination {
        "notifications" => "gnome-notifications-panel.desktop",
        _ => "gnome-privacy-panel.desktop",
    };
    open::that(target).is_ok()
        || Command::new("xdg-open")
            .arg("settings://privacy")
            .status()
            .is_ok()
}

fn active_window_title() -> Option<String> {
    shell_text("command -v xdotool >/dev/null 2>&1 && xdotool getactivewindow getwindowname")
}

struct LinuxWindow {
    app_name: Option<String>,
    window_class: Option<String>,
    window_title: Option<String>,
}

fn active_window() -> Option<LinuxWindow> {
    let window_id = shell_text("command -v xdotool >/dev/null 2>&1 && xdotool getactivewindow")?;
    let window_title = active_window_title();
    let window_class = shell_text(&format!(
        "xprop -id {} WM_CLASS 2>/dev/null | sed -E 's/.*= //; s/\"//g; s/, /|/g'",
        window_id
    ))
    .filter(|value| !value.trim().is_empty());
    let pid = shell_text(&format!(
        "xprop -id {} _NET_WM_PID 2>/dev/null | awk '{{print $NF}}'",
        window_id
    ));
    let app_name = pid
        .as_deref()
        .and_then(|pid| shell_text(&format!("ps -p {} -o comm= 2>/dev/null", pid)))
        .or_else(|| {
            window_class
                .as_ref()
                .and_then(|class| class.split('|').next_back().map(str::to_string))
        });
    Some(LinuxWindow {
        app_name,
        window_class,
        window_title,
    })
}

fn idle_seconds() -> f64 {
    shell_text("command -v xprintidle >/dev/null 2>&1 && xprintidle")
        .and_then(|value| value.parse::<f64>().ok())
        .map(|milliseconds| milliseconds / 1000.0)
        .or_else(|| {
            shell_text("command -v qdbus >/dev/null 2>&1 && qdbus org.kde.screensaver /ScreenSaver org.freedesktop.ScreenSaver.GetSessionIdleTime")
                .and_then(|value| value.parse::<f64>().ok())
                .map(|milliseconds| milliseconds / 1000.0)
        })
        .unwrap_or(0.0)
}

fn input_monitoring_status() -> String {
    if shell_text("command -v xdotool").is_some() {
        "x11-xdotool".to_string()
    } else if std::env::var("WAYLAND_DISPLAY").is_ok() {
        "wayland-limited".to_string()
    } else {
        "linux-limited".to_string()
    }
}
