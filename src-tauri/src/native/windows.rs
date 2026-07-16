use super::{now_iso, run_text_command, PermissionSnapshot, RawActivitySample};

pub fn sample_activity() -> RawActivitySample {
    let foreground = foreground_window();
    RawActivitySample {
        timestamp: now_iso(),
        platform: "windows".to_string(),
        sample_quality: foreground
            .as_ref()
            .map(|_| "foreground-window-process-idle-fallback-input".to_string())
            .unwrap_or_else(|| "fallback".to_string()),
        app_name: foreground
            .as_ref()
            .map(|sample| sample.process_name.clone())
            .unwrap_or_else(|| "Windows desktop".to_string()),
        bundle_id: foreground
            .as_ref()
            .and_then(|sample| sample.process_path.clone()),
        window_title: foreground.and_then(|sample| sample.window_title),
        idle_seconds: idle_seconds(),
        input_monitoring_status: "windows-adapter-active".to_string(),
        keyboard_count: 0,
        pointer_count: 0,
        is_system_sleeping: false,
        is_screen_locked: false,
    }
}

pub fn permission_snapshot() -> PermissionSnapshot {
    PermissionSnapshot {
        refreshed_at: now_iso(),
        input_monitoring: "windows-session".to_string(),
        notifications: "windows-toast-runtime".to_string(),
    }
}

pub fn open_system_settings(destination: &str) -> bool {
    let uri = match destination {
        "notifications" => "ms-settings:notifications",
        "inputMonitoring" => "ms-settings:privacy",
        _ => "ms-settings:privacy",
    };
    open::that(uri).is_ok()
}

struct ForegroundWindow {
    process_name: String,
    process_path: Option<String>,
    window_title: Option<String>,
}

fn foreground_window() -> Option<ForegroundWindow> {
    let script = r#"
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FocusPetWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$h = [FocusPetWin32]::GetForegroundWindow()
$builder = New-Object System.Text.StringBuilder 512
[void][FocusPetWin32]::GetWindowText($h, $builder, $builder.Capacity)
$pidValue = 0
[void][FocusPetWin32]::GetWindowThreadProcessId($h, [ref]$pidValue)
$p = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
$path = ""
try { $path = $p.Path } catch {}
Write-Output (($p.ProcessName) + "`n" + $path + "`n" + $builder.ToString())
"#;
    let output = run_text_command(
        "powershell",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ],
    )?;
    let mut lines = output.lines();
    let process_name = lines.next()?.trim().to_string();
    if process_name.is_empty() {
        return None;
    }
    let process_path = lines
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let window_title = lines
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some(ForegroundWindow {
        process_name,
        process_path,
        window_title,
    })
}

fn idle_seconds() -> f64 {
    let script = r#"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FocusPetIdle {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
  }
  [DllImport("user32.dll")]
  public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
}
"@
$info = New-Object FocusPetIdle+LASTINPUTINFO
$info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
[void][FocusPetIdle]::GetLastInputInfo([ref]$info)
$idleMs = [Environment]::TickCount64 - [int64]$info.dwTime
[math]::Round([Math]::Max(0, $idleMs) / 1000.0, 3)
"#;
    run_text_command(
        "powershell",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ],
    )
    .and_then(|value| value.parse::<f64>().ok())
    .unwrap_or(0.0)
}
