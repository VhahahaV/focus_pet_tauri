pub fn deliver(title: &str, body: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display notification {} with title {}",
            apple_string(body),
            apple_string(title)
        );
        return crate::native::run_command_success("osascript", &["-e", &script]);
    }

    #[cfg(target_os = "windows")]
    {
        return windows_notification_command(title, body)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }

    #[cfg(target_os = "linux")]
    {
        return crate::native::run_command_success("notify-send", &[title, body]);
    }

    #[allow(unreachable_code)]
    false
}

#[cfg(target_os = "windows")]
const WINDOWS_NOTIFICATION_SCRIPT: &str = r#"
$title = $env:FOCUS_PET_NOTIFICATION_TITLE
$body = $env:FOCUS_PET_NOTIFICATION_BODY
if (Get-Command New-BurntToastNotification -ErrorAction SilentlyContinue) {
  New-BurntToastNotification -Text $title, $body | Out-Null
  'sent'
} else {
  Add-Type -AssemblyName System.Windows.Forms
  $n = New-Object System.Windows.Forms.NotifyIcon
  $n.Icon = [System.Drawing.SystemIcons]::Information
  $n.BalloonTipTitle = $title
  $n.BalloonTipText = $body
  $n.Visible = $true
  $n.ShowBalloonTip(3500)
  # Keep the NotifyIcon alive for the requested display interval. Disposing it
  # after only a few hundred milliseconds makes the fallback disappear before
  # Windows has time to surface the balloon on busy systems.
  Start-Sleep -Milliseconds 4000
  $n.Dispose()
  'sent'
}
"#;

#[cfg(target_os = "windows")]
fn windows_notification_command(title: &str, body: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;

    let mut command = std::process::Command::new("powershell.exe");
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            WINDOWS_NOTIFICATION_SCRIPT,
        ])
        .env("FOCUS_PET_NOTIFICATION_TITLE", title)
        .env("FOCUS_PET_NOTIFICATION_BODY", body)
        .creation_flags(0x0800_0000);
    command
}

#[cfg(target_os = "macos")]
fn apple_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::{windows_notification_command, WINDOWS_NOTIFICATION_SCRIPT};

    #[test]
    fn windows_notification_text_is_passed_only_through_environment_variables() {
        let title = "Focus Pet ' @\nUnicode 小呆";
        let body = "line one\n'@\nRemove-Item C:\\\\unsafe";
        let command = windows_notification_command(title, body);
        let args = command
            .get_args()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>();
        assert!(args
            .iter()
            .any(|value| value.as_ref() == WINDOWS_NOTIFICATION_SCRIPT));
        assert!(!args
            .iter()
            .any(|value| value.contains(title) || value.contains(body)));
        let env = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().to_string(),
                    value.map(|value| value.to_string_lossy().to_string()),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            env.get("FOCUS_PET_NOTIFICATION_TITLE")
                .and_then(Clone::clone),
            Some(title.to_string())
        );
        assert_eq!(
            env.get("FOCUS_PET_NOTIFICATION_BODY")
                .and_then(Clone::clone),
            Some(body.to_string())
        );
    }
}
