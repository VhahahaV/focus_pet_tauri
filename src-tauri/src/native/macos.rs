use super::{now_iso, RawActivitySample};
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::event::{CGEvent, CGEventType};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGRect;
use core_graphics::window::{
    create_description_from_array, create_window_list, kCGNullWindowID, kCGWindowBounds,
    kCGWindowLayer, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
    kCGWindowName, kCGWindowOwnerPID,
};
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const FOCUS_PET_BUNDLE_ID: &str = "com.focuspet.FocusPet";
static INPUT_MONITOR_SETUP: Mutex<()> = Mutex::new(());
static INPUT_MONITOR_AVAILABLE: AtomicBool = AtomicBool::new(false);
static INPUT_MONITOR_TAP: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
static INPUT_MONITOR_LAST_ATTEMPT_MS: AtomicU64 = AtomicU64::new(0);
static KEYBOARD_COUNT: AtomicU32 = AtomicU32::new(0);
static POINTER_COUNT: AtomicU32 = AtomicU32::new(0);
static LAST_MODIFIER_FLAGS: AtomicU64 = AtomicU64::new(0);

struct FrontmostApplication {
    app_name: String,
    bundle_id: Option<String>,
    process_id: i32,
}

pub fn sample_activity() -> RawActivitySample {
    ensure_input_monitor();
    let screen_locked = screen_is_locked();
    if screen_locked {
        // Discard lock-screen input; never attribute passwords to activity.
        drain_input_counts();
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
            keyboard_count: 0,
            pointer_count: 0,
            switch_count: 0,
            is_system_sleeping: false,
            is_screen_locked: true,
        };
    }

    let workspace_frontmost = frontmost_application_from_workspace();
    let app_name = workspace_frontmost
        .as_ref()
        .map(|snapshot| snapshot.app_name.clone())
        .unwrap_or_else(|| "Unknown".to_string());
    let bundle_id = workspace_frontmost
        .as_ref()
        .and_then(|snapshot| snapshot.bundle_id.clone());
    let mut window_title = workspace_frontmost
        .as_ref()
        .and_then(|snapshot| front_window_title_for_pid(snapshot.process_id));
    let status = if workspace_frontmost.is_some() {
        "available".to_string()
    } else {
        "frontmost-unavailable".to_string()
    };

    // Window titles are optional. Query accessibility directly without spawning
    // an AppleScript process (or triggering automation prompts) on every sample.
    if window_title.is_none() {
        window_title = workspace_frontmost
            .as_ref()
            .and_then(|app| accessible_window_title(app.process_id));
    }
    let (keyboard_count, pointer_count) = drain_input_counts();
    let available = INPUT_MONITOR_AVAILABLE.load(Ordering::Acquire);
    let input_status = if available {
        "available"
    } else {
        "needs-input-monitoring-permission"
    };
    RawActivitySample {
        timestamp: now_iso(),
        platform: "macos".to_string(),
        sample_quality: if status == "available" {
            if INPUT_MONITOR_AVAILABLE.load(Ordering::Relaxed) {
                "frontmost-app-window-cg-event-tap".to_string()
            } else {
                "frontmost-app-input-unavailable".to_string()
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
        switch_count: 0,
        is_system_sleeping: false,
        is_screen_locked: screen_locked,
    }
}

fn accessible_window_title(process_id: i32) -> Option<String> {
    if !unsafe { AXIsProcessTrusted() } {
        return None;
    }
    let app = unsafe { AXUIElementCreateApplication(process_id) };
    if app.is_null() {
        return None;
    }
    let app: CFType = unsafe { TCFType::wrap_under_create_rule(app) };
    let mut window = std::ptr::null();
    let focused = CFString::from_static_string("AXFocusedWindow");
    if unsafe {
        AXUIElementCopyAttributeValue(
            app.as_CFTypeRef(),
            focused.as_concrete_TypeRef(),
            &mut window,
        )
    } != 0
        || window.is_null()
    {
        return None;
    }
    let window: CFType = unsafe { TCFType::wrap_under_create_rule(window) };
    let title_key = CFString::from_static_string("AXTitle");
    let mut title = std::ptr::null();
    if unsafe {
        AXUIElementCopyAttributeValue(
            window.as_CFTypeRef(),
            title_key.as_concrete_TypeRef(),
            &mut title,
        )
    } != 0
        || title.is_null()
    {
        return None;
    }
    let title: CFType = unsafe { TCFType::wrap_under_create_rule(title) };
    title
        .downcast::<CFString>()
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
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
        let owner_pid = match cf_number_value(&window, unsafe { kCGWindowOwnerPID }) {
            Some(pid) => pid,
            None => continue,
        };
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

/// Returns the center of the actual NSWorkspace frontmost application's
/// ordinary window. Filtering by PID avoids choosing a visually high window
/// from another display when the user switches apps or Spaces by keyboard.
pub fn frontmost_window_center() -> Option<(f64, f64)> {
    let frontmost_process_id = i64::from(frontmost_application_from_workspace()?.process_id);
    let options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
    let window_ids = create_window_list(options, kCGNullWindowID)?;
    let descriptions = create_description_from_array(window_ids)?;
    for window in descriptions.iter() {
        let Some(owner_pid) = cf_number_value(&window, unsafe { kCGWindowOwnerPID }) else {
            continue;
        };
        let layer = cf_number_value(&window, unsafe { kCGWindowLayer }).unwrap_or_default();
        if owner_pid != frontmost_process_id || layer != 0 {
            continue;
        }
        let Some(bounds_value) = window.find(unsafe { kCGWindowBounds }) else {
            continue;
        };
        let Some(bounds_dictionary) = bounds_value.downcast::<CFDictionary>() else {
            continue;
        };
        let Some(bounds) = CGRect::from_dict_representation(&bounds_dictionary) else {
            continue;
        };
        if bounds.size.width <= 1.0 || bounds.size.height <= 1.0 {
            continue;
        }
        return Some((
            bounds.origin.x + bounds.size.width / 2.0,
            bounds.origin.y + bounds.size.height / 2.0,
        ));
    }
    None
}

pub fn cursor_position() -> Option<(f64, f64)> {
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
    let point = CGEvent::new(source).ok()?.location();
    Some((point.x, point.y))
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
    let tap = INPUT_MONITOR_TAP.load(Ordering::Acquire);
    if !tap.is_null() {
        unsafe {
            if !CGEventTapIsEnabled(tap) {
                CGEventTapEnable(tap, true);
            }
            INPUT_MONITOR_AVAILABLE.store(CGEventTapIsEnabled(tap), Ordering::Release);
        }
        return;
    }
    let now = now_millis();
    let previous_attempt = INPUT_MONITOR_LAST_ATTEMPT_MS.load(Ordering::Relaxed);
    if previous_attempt > 0 && now.saturating_sub(previous_attempt) < 30_000 {
        return;
    }
    let Ok(_guard) = INPUT_MONITOR_SETUP.try_lock() else {
        return;
    };
    if INPUT_MONITOR_AVAILABLE.load(Ordering::Acquire)
        && !INPUT_MONITOR_TAP.load(Ordering::Acquire).is_null()
    {
        return;
    }
    INPUT_MONITOR_LAST_ATTEMPT_MS.store(now, Ordering::Relaxed);
    let events = [
        CGEventType::KeyDown,
        CGEventType::FlagsChanged,
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
        INPUT_MONITOR_AVAILABLE.store(false, Ordering::Release);
        return;
    }
    let source = unsafe { CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0) };
    if source.is_null() {
        unsafe {
            CFMachPortInvalidate(tap);
            CFRelease(tap)
        };
        INPUT_MONITOR_AVAILABLE.store(false, Ordering::Release);
        return;
    }
    LAST_MODIFIER_FLAGS.store(unsafe { CGEventSourceFlagsState(1) }, Ordering::Relaxed);
    unsafe {
        CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
        CGEventTapEnable(tap, true);
        CFRelease(source);
    }
    INPUT_MONITOR_TAP.store(tap, Ordering::Release);
    INPUT_MONITOR_AVAILABLE.store(true, Ordering::Release);
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
    if event_type == CGEventType::TapDisabledByTimeout as u32
        || event_type == CGEventType::TapDisabledByUserInput as u32
    {
        let tap = INPUT_MONITOR_TAP.load(Ordering::Acquire);
        if !tap.is_null() {
            unsafe { CGEventTapEnable(tap, true) };
            INPUT_MONITOR_AVAILABLE.store(true, Ordering::Release);
        } else {
            INPUT_MONITOR_AVAILABLE.store(false, Ordering::Release);
        }
        return event;
    }
    // Quartz events posted by automation have a source PID. Keep these out
    // of the physical input totals, even when posted into the HID tap.
    if event.is_null() || !is_physical_event(event_integer_field(event, 41)) {
        return event;
    }
    if event_type == CGEventType::KeyDown as u32 {
        if event_integer_field(event, K_CG_KEYBOARD_EVENT_AUTOREPEAT) == 0 {
            increment(&KEYBOARD_COUNT);
        }
    } else if event_type == CGEventType::FlagsChanged as u32 {
        let flags = unsafe { CGEventGetFlags(event) };
        let previous = LAST_MODIFIER_FLAGS.swap(flags, Ordering::Relaxed);
        if modifier_pressed(event_integer_field(event, 9), flags, previous) {
            increment(&KEYBOARD_COUNT);
        }
    } else if matches!(event_type, 1 | 3 | 25) {
        // Every button-down counts, including the second press of a double click.
        increment(&POINTER_COUNT);
    }
    event
}

fn is_physical_event(source_pid: i64) -> bool {
    source_pid == 0
}

fn increment(counter: &AtomicU32) {
    let _ = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
        Some(value.saturating_add(1))
    });
}

fn modifier_pressed(keycode: i64, flags: u64, previous: u64) -> bool {
    // Device-specific masks from IOKit/IOLLEvent.h distinguish the two sides.
    // A shared Shift flag stays set when one Shift is released while the other is held.
    let mask = match keycode {
        59 => 0x0001,
        56 => 0x0002,
        60 => 0x0004,
        55 => 0x0008,
        54 => 0x0010,
        58 => 0x0020,
        61 => 0x0040,
        62 => 0x2000,
        63 => 0x800000,
        // Caps Lock sends a toggle event; both on and off are physical presses.
        57 => return (flags ^ previous) & 0x10000 != 0,
        _ => return false,
    };
    flags & mask != 0 && previous & mask == 0
}

fn event_integer_field(event: *mut c_void, field: u32) -> i64 {
    unsafe { CGEventGetIntegerValueField(event, field) }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn idle_seconds() -> f64 {
    // Hardware state: synthetic UI automation must not keep a person "active".
    let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(1, u32::MAX) };
    if seconds.is_finite() {
        seconds.max(0.0)
    } else {
        0.0
    }
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

    false
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXUIElementCreateApplication(pid: i32) -> *const c_void;
    fn AXUIElementCopyAttributeValue(
        element: *const c_void,
        attribute: CFStringRef,
        value: *mut *const c_void,
    ) -> i32;
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
    fn CGEventGetFlags(event: *mut c_void) -> u64;
    fn CGEventTapIsEnabled(tap: *mut c_void) -> bool;
    fn CGEventSourceFlagsState(state_id: i32) -> u64;
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
    fn CFRelease(value: *const c_void);
}

const K_CG_SESSION_EVENT_TAP: u32 = 1;
const K_CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
const K_CG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;
const K_CG_KEYBOARD_EVENT_AUTOREPEAT: u32 = 8;

#[cfg(test)]
mod tests {
    use super::*;
    use foreign_types::ForeignType;
    #[test]
    fn modifier_releases_and_held_opposite_shift_do_not_count() {
        assert!(modifier_pressed(56, 2, 0));
        assert!(!modifier_pressed(56, 0, 2));
        assert!(modifier_pressed(60, 6, 2));
        assert!(!modifier_pressed(56, 4, 6));
        assert!(!modifier_pressed(60, 0, 4));
        assert!(modifier_pressed(57, 0x10000, 0));
        assert!(modifier_pressed(57, 0, 0x10000));
        assert!(!modifier_pressed(57, 0, 0));
    }
    #[test]
    fn posted_events_do_not_count_as_physical_input() {
        assert!(is_physical_event(0));
        assert!(!is_physical_event(123));
        assert!(!is_physical_event(-1));
    }
    #[test]
    fn actual_callback_counts_each_click_and_excludes_repeat_motion_and_injection() {
        // Construct events but do not post them to the user's desktop.
        // Use the exact production callback to verify filtering and draining.
        use core_graphics::event::EventField;
        drain_input_counts();
        let source = CGEventSource::new(CGEventSourceStateID::Private).unwrap();
        let event = CGEvent::new(source).unwrap();
        event.set_integer_value_field(EventField::EVENT_SOURCE_UNIX_PROCESS_ID, 0);
        let ptr = event.as_ptr() as *mut c_void;
        event.set_type(CGEventType::LeftMouseDown);
        for click in 1..=3 {
            event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, click);
            input_event_callback(std::ptr::null_mut(), 1, ptr, std::ptr::null_mut());
        }
        input_event_callback(std::ptr::null_mut(), 5, ptr, std::ptr::null_mut());
        input_event_callback(std::ptr::null_mut(), 22, ptr, std::ptr::null_mut());
        event.set_type(CGEventType::KeyDown);
        input_event_callback(std::ptr::null_mut(), 10, ptr, std::ptr::null_mut());
        event.set_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT, 1);
        input_event_callback(std::ptr::null_mut(), 10, ptr, std::ptr::null_mut());
        event.set_integer_value_field(EventField::EVENT_SOURCE_UNIX_PROCESS_ID, 123);
        input_event_callback(std::ptr::null_mut(), 1, ptr, std::ptr::null_mut());
        assert_eq!(drain_input_counts(), (1, 3));
        assert_eq!(drain_input_counts(), (0, 0));
    }
}
