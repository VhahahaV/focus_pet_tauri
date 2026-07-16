use super::{now_iso, run_text_command, PermissionSnapshot, RawActivitySample};
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::event::CGEventType;
use core_graphics::window::{
    create_description_from_array, create_window_list, kCGNullWindowID, kCGWindowLayer,
    kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly, kCGWindowName,
    kCGWindowOwnerPID,
};
use std::ffi::c_void;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Once;
use std::time::{SystemTime, UNIX_EPOCH};

const FOCUS_PET_BUNDLE_ID: &str = "com.focuspet.FocusPet";
static INPUT_MONITOR_INIT: Once = Once::new();
static INPUT_MONITOR_AVAILABLE: AtomicBool = AtomicBool::new(false);
static KEYBOARD_COUNT: AtomicU32 = AtomicU32::new(0);
static POINTER_COUNT: AtomicU32 = AtomicU32::new(0);
static LAST_POINTER_MOTION_MS: AtomicU64 = AtomicU64::new(0);
static LAST_POINTER_SCROLL_MS: AtomicU64 = AtomicU64::new(0);
static LAST_POINTER_DRAG_MS: AtomicU64 = AtomicU64::new(0);

const POINTER_GESTURE_IDLE_MS: u64 = 650;

struct FrontmostApplication {
    app_name: String,
    bundle_id: Option<String>,
    process_id: i32,
}

pub fn sample_activity() -> RawActivitySample {
    ensure_input_monitor();
    let screen_locked = screen_is_locked();
    if screen_locked {
        let (tap_keyboard_count, tap_pointer_count) = drain_input_counts();
        let (fallback_keyboard_count, fallback_pointer_count) = input_fallback_counts(1.5);
        return RawActivitySample {
            timestamp: now_iso(),
            platform: "macos".to_string(),
            sample_quality: "screen-locked".to_string(),
            app_name: "Locked Screen".to_string(),
            bundle_id: None,
            window_title: None,
            idle_seconds: idle_seconds(),
            input_monitoring_status: if INPUT_MONITOR_AVAILABLE.load(Ordering::Relaxed) {
                "available"
            } else {
                "needs-input-monitoring-permission"
            }
            .to_string(),
            keyboard_count: tap_keyboard_count.max(fallback_keyboard_count),
            pointer_count: tap_pointer_count.max(fallback_pointer_count),
            is_system_sleeping: false,
            is_screen_locked: true,
        };
    }

    let workspace_frontmost = frontmost_application_from_workspace();
    let mut app_name = workspace_frontmost
        .as_ref()
        .map(|snapshot| snapshot.app_name.clone())
        .unwrap_or_else(|| "Unknown".to_string());
    let mut bundle_id = workspace_frontmost
        .as_ref()
        .and_then(|snapshot| snapshot.bundle_id.clone());
    let mut window_title = workspace_frontmost
        .as_ref()
        .and_then(|snapshot| front_window_title_for_pid(snapshot.process_id));
    let mut status = if workspace_frontmost.is_some() {
        "available".to_string()
    } else {
        "frontmost-unavailable".to_string()
    };

    if workspace_frontmost.is_none() || bundle_id.is_none() || window_title.is_none() {
        let script = r#"tell application "System Events"
set frontApps to application processes whose frontmost is true
if (count of frontApps) is 0 then
  return "__NO_FRONTMOST_APP__"
end if
set frontApp to item 1 of frontApps
set appName to ""
set bundleID to ""
set windowTitle to ""
try
  set appName to name of frontApp
end try
try
  set bundleID to bundle identifier of frontApp
end try
try
  set windowTitle to name of front window of frontApp
end try
return appName & linefeed & bundleID & linefeed & windowTitle
end tell"#;
        let output = Command::new("osascript").arg("-e").arg(script).output();
        if let Ok(output) = output {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                if text.trim() == "__NO_FRONTMOST_APP__" {
                    if workspace_frontmost.is_none() {
                        status = "frontmost-unavailable".to_string();
                        app_name = "No Frontmost App".to_string();
                    }
                } else {
                    let mut lines = text.lines();
                    let script_app_name = lines.next().and_then(normalized_apple_script_value);
                    let script_bundle_id = lines.next().and_then(normalized_apple_script_value);
                    let script_window_title = lines.next().and_then(normalized_apple_script_value);
                    if workspace_frontmost.is_none() {
                        app_name = script_app_name.unwrap_or_else(|| "Unknown".to_string());
                        bundle_id = script_bundle_id;
                        status = "available".to_string();
                    } else if bundle_id.is_none() {
                        bundle_id = script_bundle_id;
                    }
                    if window_title.is_none() {
                        window_title = script_window_title;
                    }
                }
            } else if workspace_frontmost.is_none() {
                status = "needs-accessibility-permission".to_string();
            }
        } else if workspace_frontmost.is_none() {
            status = "osascript-unavailable".to_string();
        }
    }

    let (tap_keyboard_count, tap_pointer_count) = drain_input_counts();
    let (fallback_keyboard_count, fallback_pointer_count) = input_fallback_counts(1.5);
    let keyboard_count = tap_keyboard_count.max(fallback_keyboard_count);
    let pointer_count = tap_pointer_count.max(fallback_pointer_count);
    let input_status = match (
        status.as_str(),
        INPUT_MONITOR_AVAILABLE.load(Ordering::Relaxed),
    ) {
        ("available", true) => "available",
        ("available", false) => "needs-input-monitoring-permission",
        _ => status.as_str(),
    };
    RawActivitySample {
        timestamp: now_iso(),
        platform: "macos".to_string(),
        sample_quality: if status == "available" {
            if INPUT_MONITOR_AVAILABLE.load(Ordering::Relaxed) {
                "frontmost-app-window-cg-event-tap".to_string()
            } else {
                "frontmost-app-window-idle-input-fallback".to_string()
            }
        } else {
            "permission-limited".to_string()
        },
        app_name,
        bundle_id,
        window_title,
        idle_seconds: idle_seconds(),
        input_monitoring_status: input_status.to_string(),
        keyboard_count,
        pointer_count,
        is_system_sleeping: false,
        is_screen_locked: screen_locked,
    }
}

fn normalized_apple_script_value(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("missing value") {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn frontmost_application_from_workspace() -> Option<FrontmostApplication> {
    use objc2_app_kit::NSWorkspace;

    let workspace = NSWorkspace::sharedWorkspace();
    let application = workspace.frontmostApplication()?;
    let process_id = application.processIdentifier();
    let mut app_name = application
        .localizedName()
        .map(|value| value.to_string())
        .and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
        .unwrap_or_else(|| "Unknown".to_string());
    let mut bundle_id = application
        .bundleIdentifier()
        .map(|value| value.to_string());

    if process_id == std::process::id() as i32 {
        app_name = "Focus Pet".to_string();
        if bundle_id.is_none() {
            bundle_id = Some(FOCUS_PET_BUNDLE_ID.to_string());
        }
    }

    Some(FrontmostApplication {
        app_name,
        bundle_id,
        process_id,
    })
}

fn front_window_title_for_pid(process_id: i32) -> Option<String> {
    let options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
    let window_ids = create_window_list(options, kCGNullWindowID)?;
    let descriptions = create_description_from_array(window_ids)?;

    for window in descriptions.iter() {
        let owner_pid = cf_number_value(&window, unsafe { kCGWindowOwnerPID })?;
        let layer = cf_number_value(&window, unsafe { kCGWindowLayer }).unwrap_or_default();
        if owner_pid as i32 != process_id || layer != 0 {
            continue;
        }
        if let Some(title) = cf_string_value(&window, unsafe { kCGWindowName }) {
            return Some(title);
        }
    }

    None
}

fn cf_number_value(dictionary: &CFDictionary<CFString, CFType>, key: CFStringRef) -> Option<i64> {
    dictionary.find(key)?.downcast::<CFNumber>()?.to_i64()
}

fn cf_string_value(
    dictionary: &CFDictionary<CFString, CFType>,
    key: CFStringRef,
) -> Option<String> {
    dictionary
        .find(key)?
        .downcast::<CFString>()
        .map(|value| value.to_string())
        .and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
}

fn ensure_input_monitor() {
    INPUT_MONITOR_INIT.call_once(|| {
        let events = [
            CGEventType::KeyDown,
            CGEventType::FlagsChanged,
            CGEventType::LeftMouseDown,
            CGEventType::RightMouseDown,
            CGEventType::OtherMouseDown,
            CGEventType::MouseMoved,
            CGEventType::LeftMouseDragged,
            CGEventType::RightMouseDragged,
            CGEventType::OtherMouseDragged,
            CGEventType::ScrollWheel,
        ];
        let mask = events.iter().fold(0_u64, |value, event_type| {
            value | (1_u64 << (*event_type as u32))
        });
        let tap = unsafe {
            CGEventTapCreate(
                K_CG_SESSION_EVENT_TAP,
                K_CG_HEAD_INSERT_EVENT_TAP,
                K_CG_EVENT_TAP_OPTION_LISTEN_ONLY,
                mask,
                Some(input_event_callback),
                std::ptr::null_mut(),
            )
        };
        if tap.is_null() {
            INPUT_MONITOR_AVAILABLE.store(false, Ordering::Relaxed);
            return;
        }
        let source = unsafe { CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0) };
        if source.is_null() {
            INPUT_MONITOR_AVAILABLE.store(false, Ordering::Relaxed);
            return;
        }
        unsafe {
            CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
            CGEventTapEnable(tap, true);
        }
        INPUT_MONITOR_AVAILABLE.store(true, Ordering::Relaxed);
    });
}

fn drain_input_counts() -> (u32, u32) {
    (
        KEYBOARD_COUNT.swap(0, Ordering::Relaxed),
        POINTER_COUNT.swap(0, Ordering::Relaxed),
    )
}

extern "C" fn input_event_callback(
    _proxy: *mut c_void,
    event_type: u32,
    event: *mut c_void,
    _user_info: *mut c_void,
) -> *mut c_void {
    match event_type {
        value
            if should_count_keyboard_event(
                value,
                value == CGEventType::KeyDown as u32 && keyboard_event_is_autorepeat(event),
            ) =>
        {
            KEYBOARD_COUNT.fetch_add(1, Ordering::Relaxed);
        }
        value
            if value == CGEventType::LeftMouseDown as u32
                || value == CGEventType::RightMouseDown as u32
                || value == CGEventType::OtherMouseDown as u32 =>
        {
            if should_count_pointer_down(mouse_event_click_state(event)) {
                POINTER_COUNT.fetch_add(1, Ordering::Relaxed);
            }
        }
        value if value == CGEventType::MouseMoved as u32 => {
            count_pointer_gesture(&LAST_POINTER_MOTION_MS);
        }
        value
            if value == CGEventType::LeftMouseDragged as u32
                || value == CGEventType::RightMouseDragged as u32
                || value == CGEventType::OtherMouseDragged as u32 =>
        {
            count_pointer_gesture(&LAST_POINTER_DRAG_MS);
        }
        value if value == CGEventType::ScrollWheel as u32 => {
            count_pointer_gesture(&LAST_POINTER_SCROLL_MS);
        }
        _ => {}
    }
    event
}

fn should_count_keyboard_event(event_type: u32, is_autorepeat: bool) -> bool {
    if event_type == CGEventType::KeyDown as u32 {
        return !is_autorepeat;
    }
    event_type == CGEventType::FlagsChanged as u32
}

fn should_count_pointer_down(click_state: i64) -> bool {
    click_state <= 1
}

fn keyboard_event_is_autorepeat(event: *mut c_void) -> bool {
    !event.is_null() && event_integer_field(event, K_CG_KEYBOARD_EVENT_AUTOREPEAT) != 0
}

fn mouse_event_click_state(event: *mut c_void) -> i64 {
    if event.is_null() {
        return 1;
    }
    event_integer_field(event, K_CG_MOUSE_EVENT_CLICK_STATE)
}

fn event_integer_field(event: *mut c_void, field: u32) -> i64 {
    unsafe { CGEventGetIntegerValueField(event, field) }
}

fn count_pointer_gesture(last_ms: &AtomicU64) {
    let now = now_millis();
    let previous = last_ms.swap(now, Ordering::Relaxed);
    if previous == 0 || now.saturating_sub(previous) > POINTER_GESTURE_IDLE_MS {
        POINTER_COUNT.fetch_add(1, Ordering::Relaxed);
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

pub fn permission_snapshot() -> PermissionSnapshot {
    let input_monitoring = if input_monitoring_is_allowed() {
        "已允许"
    } else {
        "待开启"
    };
    PermissionSnapshot {
        refreshed_at: now_iso(),
        input_monitoring: input_monitoring.to_string(),
        notifications: "system-managed".to_string(),
    }
}

fn input_monitoring_is_allowed() -> bool {
    ensure_input_monitor();
    INPUT_MONITOR_AVAILABLE.load(Ordering::Relaxed) || can_create_passive_input_event_tap()
}

fn can_create_passive_input_event_tap() -> bool {
    let events = [
        CGEventType::KeyDown,
        CGEventType::LeftMouseDown,
        CGEventType::RightMouseDown,
        CGEventType::OtherMouseDown,
    ];
    let mask = events.iter().fold(0_u64, |value, event_type| {
        value | (1_u64 << (*event_type as u32))
    });
    let tap = unsafe {
        CGEventTapCreate(
            K_CG_SESSION_EVENT_TAP,
            K_CG_HEAD_INSERT_EVENT_TAP,
            K_CG_EVENT_TAP_OPTION_LISTEN_ONLY,
            mask,
            Some(input_event_callback),
            std::ptr::null_mut(),
        )
    };
    if tap.is_null() {
        return false;
    }
    unsafe {
        CFMachPortInvalidate(tap);
    }
    true
}

pub fn open_system_settings(destination: &str) -> bool {
    let pane = match destination {
        "inputMonitoring" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
        }
        "notifications" => "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
        _ => "x-apple.systempreferences:com.apple.preference.security",
    };
    open::that(pane).is_ok()
}

fn idle_seconds() -> f64 {
    run_text_command(
        "sh",
        &[
            "-lc",
            "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ { printf \"%.3f\", $NF / 1000000000; exit }'",
        ],
    )
    .and_then(|value| value.parse::<f64>().ok())
    .unwrap_or(0.0)
}

fn screen_is_locked() -> bool {
    let session = unsafe { CGSessionCopyCurrentDictionary() };
    if !session.is_null() {
        let dictionary: CFDictionary<CFString, CFType> =
            unsafe { TCFType::wrap_under_create_rule(session) };
        let key = CFString::from_static_string("CGSSessionScreenIsLocked");
        if let Some(value) = dictionary.find(&key) {
            if let Some(boolean) = value.downcast::<CFBoolean>() {
                return bool::from(boolean);
            }
            if let Some(number) = value.downcast::<CFNumber>() {
                return number.to_i64().is_some_and(|value| value != 0);
            }
        }
    }

    run_text_command(
        "sh",
        &[
            "-lc",
            "ioreg -n Root -d1 | grep -q 'CGSSessionScreenIsLocked.*Yes' && echo locked",
        ],
    )
    .is_some()
}

fn input_fallback_counts(window_seconds: f64) -> (u32, u32) {
    let window = window_seconds.max(0.5) + window_seconds.mul_add(0.25, 0.0).clamp(0.25, 1.5);
    (
        u32::from(keyboard_idle_seconds().is_some_and(|seconds| seconds <= window)),
        u32::from(pointer_idle_seconds().is_some_and(|seconds| seconds <= window)),
    )
}

fn keyboard_idle_seconds() -> Option<f64> {
    seconds_since_most_recent(&[CGEventType::KeyDown, CGEventType::FlagsChanged])
}

fn pointer_idle_seconds() -> Option<f64> {
    seconds_since_most_recent(&[
        CGEventType::MouseMoved,
        CGEventType::LeftMouseDown,
        CGEventType::RightMouseDown,
        CGEventType::OtherMouseDown,
        CGEventType::LeftMouseDragged,
        CGEventType::RightMouseDragged,
        CGEventType::OtherMouseDragged,
        CGEventType::ScrollWheel,
    ])
}

fn seconds_since_most_recent(event_types: &[CGEventType]) -> Option<f64> {
    event_types
        .iter()
        .filter_map(|event_type| seconds_since_last_event(*event_type))
        .min_by(|left, right| left.total_cmp(right))
}

fn seconds_since_last_event(event_type: CGEventType) -> Option<f64> {
    let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(0, event_type as u32) };
    seconds.is_finite().then_some(seconds)
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    #[allow(non_snake_case)]
    fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
    #[allow(non_snake_case)]
    fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
    #[allow(non_snake_case)]
    fn CGEventGetIntegerValueField(event: *mut c_void, field: u32) -> i64;
    #[allow(non_snake_case)]
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: Option<extern "C" fn(*mut c_void, u32, *mut c_void, *mut c_void) -> *mut c_void>,
        user_info: *mut c_void,
    ) -> *mut c_void;
    #[allow(non_snake_case)]
    fn CGEventTapEnable(tap: *mut c_void, enable: bool);
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFRunLoopCommonModes: *const c_void;
    #[allow(non_snake_case)]
    fn CFMachPortCreateRunLoopSource(
        allocator: *const c_void,
        port: *mut c_void,
        order: isize,
    ) -> *mut c_void;
    #[allow(non_snake_case)]
    fn CFRunLoopGetMain() -> *mut c_void;
    #[allow(non_snake_case)]
    fn CFRunLoopAddSource(run_loop: *mut c_void, source: *mut c_void, mode: *const c_void);
    #[allow(non_snake_case)]
    fn CFMachPortInvalidate(port: *mut c_void);
}

const K_CG_SESSION_EVENT_TAP: u32 = 1;
const K_CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
const K_CG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;
const K_CG_MOUSE_EVENT_CLICK_STATE: u32 = 1;
const K_CG_KEYBOARD_EVENT_AUTOREPEAT: u32 = 8;

#[cfg(test)]
mod tests {
    use super::{should_count_keyboard_event, should_count_pointer_down};
    use core_graphics::event::CGEventType;

    #[test]
    fn keyboard_event_filter_ignores_autorepeat_key_downs() {
        assert!(should_count_keyboard_event(
            CGEventType::KeyDown as u32,
            false
        ));
        assert!(!should_count_keyboard_event(
            CGEventType::KeyDown as u32,
            true
        ));
        assert!(should_count_keyboard_event(
            CGEventType::FlagsChanged as u32,
            true
        ));
        assert!(!should_count_keyboard_event(
            CGEventType::KeyUp as u32,
            false
        ));
    }

    #[test]
    fn pointer_down_filter_ignores_extra_click_state_events() {
        assert!(should_count_pointer_down(0));
        assert!(should_count_pointer_down(1));
        assert!(!should_count_pointer_down(2));
        assert!(!should_count_pointer_down(3));
    }
}
