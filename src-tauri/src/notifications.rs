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
        let script = format!(
            r#"
$title = @'
{}
'@
$body = @'
{}
'@
if (Get-Command New-BurntToastNotification -ErrorAction SilentlyContinue) {{
  New-BurntToastNotification -Text $title, $body | Out-Null
  'sent'
}} else {{
  Add-Type -AssemblyName System.Windows.Forms
  $n = New-Object System.Windows.Forms.NotifyIcon
  $n.Icon = [System.Drawing.SystemIcons]::Information
  $n.BalloonTipTitle = $title
  $n.BalloonTipText = $body
  $n.Visible = $true
  $n.ShowBalloonTip(3500)
  Start-Sleep -Milliseconds 800
  $n.Dispose()
  'sent'
}}
"#,
            powershell_literal(title),
            powershell_literal(body)
        );
        return crate::native::run_command_success(
            "powershell",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ],
        );
    }

    #[cfg(target_os = "linux")]
    {
        return crate::native::run_command_success("notify-send", &[title, body]);
    }

    #[allow(unreachable_code)]
    false
}

#[cfg(target_os = "macos")]
fn apple_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(target_os = "windows")]
fn powershell_literal(value: &str) -> String {
    value.replace("'@", "' + '@' + @'")
}
