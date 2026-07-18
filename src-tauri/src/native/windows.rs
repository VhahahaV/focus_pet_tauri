use super::{now_iso, PermissionSnapshot, RawActivitySample};
use std::{
    mem::size_of,
    path::Path,
    ptr::{null, null_mut},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc, OnceLock,
    },
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HINSTANCE, LPARAM, LRESULT, WPARAM},
    System::{
        LibraryLoader::GetModuleHandleW,
        StationsAndDesktops::{
            CloseDesktop, OpenInputDesktop, SwitchDesktop, DESKTOP_SWITCHDESKTOP,
        },
        SystemInformation::GetTickCount64,
        Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION},
    },
    UI::{
        Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO},
        WindowsAndMessaging::{
            CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW,
            GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, SetWindowsHookExW,
            TranslateMessage, UnhookWindowsHookEx, MSG, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN,
            WM_SYSKEYDOWN,
        },
    },
};

static KEYBOARD_EVENTS: AtomicU32 = AtomicU32::new(0);
static POINTER_EVENTS: AtomicU32 = AtomicU32::new(0);
static FOREGROUND_SWITCH_EVENTS: AtomicU32 = AtomicU32::new(0);
static LAST_FOREGROUND_PROCESS: AtomicU32 = AtomicU32::new(0);
static INPUT_HOOKS_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn sample_activity() -> RawActivitySample {
    ensure_input_monitor();
    let hooks_active = INPUT_HOOKS_ACTIVE.load(Ordering::Acquire);
    let foreground = foreground_window();
    RawActivitySample {
        timestamp: now_iso(),
        platform: "windows".to_string(),
        sample_quality: match (foreground.is_some(), hooks_active) {
            (true, true) => "win32-foreground-low-level-input-hooks".to_string(),
            (true, false) => "win32-foreground-idle-fallback-input".to_string(),
            (false, true) => "win32-low-level-input-hooks".to_string(),
            (false, false) => "win32-idle-fallback".to_string(),
        },
        app_name: foreground
            .as_ref()
            .map(|sample| sample.process_name.clone())
            .unwrap_or_else(|| "Windows desktop".to_string()),
        bundle_id: foreground
            .as_ref()
            .and_then(|sample| sample.process_path.clone()),
        window_title: foreground.and_then(|sample| sample.window_title),
        idle_seconds: idle_seconds(),
        input_monitoring_status: if hooks_active {
            "windows-low-level-hooks-available".to_string()
        } else {
            "windows-idle-fallback".to_string()
        },
        keyboard_count: KEYBOARD_EVENTS.swap(0, Ordering::AcqRel),
        pointer_count: POINTER_EVENTS.swap(0, Ordering::AcqRel),
        switch_count: FOREGROUND_SWITCH_EVENTS.swap(0, Ordering::AcqRel),
        is_system_sleeping: false,
        is_screen_locked: screen_is_locked(),
    }
}

pub fn permission_snapshot() -> PermissionSnapshot {
    ensure_input_monitor();
    PermissionSnapshot {
        refreshed_at: now_iso(),
        input_monitoring: if INPUT_HOOKS_ACTIVE.load(Ordering::Acquire) {
            "windows-low-level-hooks-available".to_string()
        } else {
            "windows-idle-fallback".to_string()
        },
        notifications: "windows-notification-runtime-available".to_string(),
    }
}

pub fn open_system_settings(destination: &str) -> bool {
    let uri = match destination {
        "notifications" => "ms-settings:notifications",
        "inputMonitoring" | "privacySecurity" => "ms-settings:privacy-general",
        _ => "ms-settings:privacy-general",
    };
    open::that(uri).is_ok()
}

struct ForegroundWindow {
    process_name: String,
    process_path: Option<String>,
    window_title: Option<String>,
}

fn foreground_window() -> Option<ForegroundWindow> {
    // SAFETY: All handles and buffers are obtained from Win32 in this call. Buffers
    // remain alive for each API invocation and every returned handle is closed.
    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() {
            return None;
        }

        let title_length = GetWindowTextLengthW(window).max(0) as usize;
        let mut title_buffer = vec![0_u16; title_length.saturating_add(1).max(2)];
        let copied = GetWindowTextW(
            window,
            title_buffer.as_mut_ptr(),
            title_buffer.len().min(i32::MAX as usize) as i32,
        );
        let window_title = (copied > 0)
            .then(|| String::from_utf16_lossy(&title_buffer[..copied as usize]))
            .filter(|value| !value.trim().is_empty());

        let mut process_id = 0_u32;
        GetWindowThreadProcessId(window, &mut process_id);
        if process_id == 0 {
            return None;
        }

        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
        let process_path = if process.is_null() {
            None
        } else {
            let mut path_buffer = vec![0_u16; 32_768];
            let mut path_length = path_buffer.len() as u32;
            let queried =
                QueryFullProcessImageNameW(process, 0, path_buffer.as_mut_ptr(), &mut path_length);
            CloseHandle(process);
            (queried != 0 && path_length > 0)
                .then(|| String::from_utf16_lossy(&path_buffer[..path_length as usize]))
        };
        let process_name = process_path
            .as_deref()
            .and_then(|value| Path::new(value).file_stem())
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Windows process {process_id}"));

        Some(ForegroundWindow {
            process_name,
            process_path,
            window_title,
        })
    }
}

fn idle_seconds() -> f64 {
    let mut info = LASTINPUTINFO {
        cbSize: size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // LASTINPUTINFO uses the low 32 bits of the system tick counter. Wrapping
    // subtraction keeps the calculation valid after Windows has run for 49.7 days.
    let available = unsafe { GetLastInputInfo(&mut info) } != 0;
    if !available {
        return 0.0;
    }
    let current_tick = unsafe { GetTickCount64() } as u32;
    f64::from(current_tick.wrapping_sub(info.dwTime)) / 1000.0
}

fn screen_is_locked() -> bool {
    // The input desktop cannot be switched while Winlogon owns the secure desktop.
    // This is a read-only probe and does not switch the user's visible desktop.
    unsafe {
        let desktop = OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP);
        if desktop.is_null() {
            return true;
        }
        let accessible = SwitchDesktop(desktop) != 0;
        CloseDesktop(desktop);
        !accessible
    }
}

fn ensure_input_monitor() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let spawned = std::thread::Builder::new()
            .name("focus-pet-windows-input-monitor".to_string())
            .spawn(move || input_monitor_loop(ready_tx));
        if spawned.is_ok() {
            let active = ready_rx
                .recv_timeout(Duration::from_secs(1))
                .unwrap_or(false);
            INPUT_HOOKS_ACTIVE.store(active, Ordering::Release);
        }
    });
}

fn input_monitor_loop(ready: mpsc::SyncSender<bool>) {
    // SAFETY: Low-level hooks are installed on this dedicated thread, callbacks are
    // static functions, and the thread owns the Win32 message loop for their lifetime.
    unsafe {
        use windows_sys::Win32::UI::{
            Accessibility::{SetWinEventHook, UnhookWinEvent},
            WindowsAndMessaging::{EVENT_SYSTEM_FOREGROUND, WINEVENT_OUTOFCONTEXT},
        };

        let module: HINSTANCE = GetModuleHandleW(null());
        let keyboard_hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook_proc), module, 0);
        let pointer_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(pointer_hook_proc), module, 0);
        if let Some(foreground) = current_foreground_process_id() {
            LAST_FOREGROUND_PROCESS.store(foreground, Ordering::Release);
        }
        let foreground_hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            null_mut(),
            Some(foreground_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        let active = !keyboard_hook.is_null() && !pointer_hook.is_null();
        INPUT_HOOKS_ACTIVE.store(active, Ordering::Release);
        let _ = ready.send(active);

        if !active {
            if !keyboard_hook.is_null() {
                UnhookWindowsHookEx(keyboard_hook);
            }
            if !pointer_hook.is_null() {
                UnhookWindowsHookEx(pointer_hook);
            }
            if !foreground_hook.is_null() {
                UnhookWinEvent(foreground_hook);
            }
            return;
        }

        let mut message: MSG = std::mem::zeroed();
        while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        INPUT_HOOKS_ACTIVE.store(false, Ordering::Release);
        UnhookWindowsHookEx(keyboard_hook);
        UnhookWindowsHookEx(pointer_hook);
        if !foreground_hook.is_null() {
            UnhookWinEvent(foreground_hook);
        }
    }
}

fn current_foreground_process_id() -> Option<u32> {
    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() {
            return None;
        }
        let mut process_id = 0_u32;
        GetWindowThreadProcessId(window, &mut process_id);
        (process_id != 0).then_some(process_id)
    }
}

unsafe extern "system" fn foreground_event_proc(
    _hook: windows_sys::Win32::UI::Accessibility::HWINEVENTHOOK,
    _event: u32,
    window: windows_sys::Win32::Foundation::HWND,
    _object_id: i32,
    _child_id: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    if window.is_null() {
        return;
    }
    let mut process_id = 0_u32;
    unsafe { GetWindowThreadProcessId(window, &mut process_id) };
    if process_id == 0 {
        return;
    }
    let previous = LAST_FOREGROUND_PROCESS.swap(process_id, Ordering::AcqRel);
    if previous != 0 && previous != process_id {
        saturating_increment(&FOREGROUND_SWITCH_EVENTS);
    }
}

unsafe extern "system" fn keyboard_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && matches!(wparam as u32, WM_KEYDOWN | WM_SYSKEYDOWN) {
        saturating_increment(&KEYBOARD_EVENTS);
    }
    unsafe { CallNextHookEx(null_mut(), code, wparam, lparam) }
}

unsafe extern "system" fn pointer_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && (0x0200..=0x020e).contains(&(wparam as u32)) {
        saturating_increment(&POINTER_EVENTS);
    }
    unsafe { CallNextHookEx(null_mut(), code, wparam, lparam) }
}

fn saturating_increment(counter: &AtomicU32) {
    let _ = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
        Some(value.saturating_add(1))
    });
}

#[cfg(test)]
mod tests {
    use super::{permission_snapshot, sample_activity, saturating_increment};
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn input_counters_saturate_instead_of_wrapping() {
        let counter = AtomicU32::new(u32::MAX);
        saturating_increment(&counter);
        assert_eq!(counter.load(Ordering::Relaxed), u32::MAX);
    }

    #[test]
    fn native_adapter_samples_the_windows_session_without_powershell() {
        let sample = sample_activity();
        assert_eq!(sample.platform, "windows");
        assert!(sample.idle_seconds >= 0.0);
        assert!(sample.sample_quality.starts_with("win32-"));
        assert!(sample.input_monitoring_status.starts_with("windows-"));

        let permissions = permission_snapshot();
        assert!(permissions.input_monitoring.starts_with("windows-"));
        assert!(permissions.notifications.contains("available"));
    }
}
