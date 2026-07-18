import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const platform = process.platform;
const sendNotification = process.argv.includes("--send-notification");

const run = (program, args, options = {}) => {
  const result = spawnSync(program, args, {
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 8000,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    text: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
};

const available = (program) => {
  if (platform === "win32") return run("where", [program]).ok;
  return run("sh", ["-lc", `command -v ${program}`]).ok;
};

const checks = [];
const addCheck = (name, fn, options = {}) => {
  checks.push({ name, fn, required: options.required !== false });
};

const printResult = (result) => {
  const status = result.ok ? "ok" : result.required ? "fail" : "warn";
  console.log(`${status} - ${result.name}`);
  if (result.text) {
    const detail = result.text.split("\n").slice(0, 4).join("\n");
    console.log(detail.replace(/^/gm, "  "));
  }
};

if (platform === "darwin") {
  addCheck("macOS frontmost app via System Events", () =>
    {
      const result = run("osascript", [
      "-e",
      "tell application \"System Events\" to set frontApps to application processes whose frontmost is true\nif (count of frontApps) is 0 then return \"__NO_FRONTMOST_APP__\"\nreturn name of item 1 of frontApps",
      ]);
      if (result.text.trim() === "__NO_FRONTMOST_APP__") {
        return { ok: false, text: "no frontmost application process visible in this session" };
      }
      return result;
    },
    { required: false },
  );
  addCheck("macOS HID idle time via ioreg", () =>
    run("sh", [
      "-lc",
      "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ { printf \"%.3f\", $NF / 1000000000; exit }'",
    ]),
  );
  addCheck("macOS screen lock probe via ioreg", () =>
    run("sh", ["-lc", "ioreg -n Root -d1 >/dev/null"]),
  );
  addCheck("macOS notification helper", () => {
    if (!sendNotification) return { ok: true, text: "skipped delivery; pass --send-notification to display one" };
    return run("osascript", [
      "-e",
      "display notification \"Native adapter smoke test\" with title \"Focus Pet\"",
    ]);
  }, { required: false });
} else if (platform === "win32") {
  addCheck("Windows notification PowerShell host", () =>
    run("powershell", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]),
  );
  addCheck("Windows Rust adapter uses direct Win32 APIs", () => {
    const source = readFileSync("src-tauri/src/native/windows.rs", "utf8");
    const required = [
      "GetForegroundWindow",
      "GetLastInputInfo",
      "SetWindowsHookExW",
      "WH_KEYBOARD_LL",
      "WH_MOUSE_LL",
      "OpenInputDesktop",
    ];
    const missing = required.filter((symbol) => !source.includes(symbol));
    return {
      ok: missing.length === 0,
      text: missing.length === 0 ? "foreground, idle, input-hook, and lock probes are wired" : `missing: ${missing.join(", ")}`,
    };
  });
  addCheck("Windows foreground Win32 smoke (independent PowerShell host)", () =>
    run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FocusPetWin32Smoke {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$h = [FocusPetWin32Smoke]::GetForegroundWindow()
$builder = New-Object System.Text.StringBuilder 512
[void][FocusPetWin32Smoke]::GetWindowText($h, $builder, $builder.Capacity)
Write-Output $builder.ToString()
      `,
    ]),
  );
  addCheck("Windows idle Win32 smoke (independent PowerShell host)", () =>
    run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FocusPetIdleSmoke {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static uint GetIdleMilliseconds() {
    var info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    if (!GetLastInputInfo(ref info)) return 0;
    return unchecked((uint)Environment.TickCount - info.dwTime);
  }
}
"@
$idleMs = [FocusPetIdleSmoke]::GetIdleMilliseconds()
[math]::Round($idleMs / 1000.0, 3)
      `,
    ]),
  );
  addCheck("Windows notification helper", () => {
    const burnToast = run("powershell", [
      "-NoProfile",
      "-Command",
      "Get-Command New-BurntToastNotification -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Name",
    ]);
    if (!sendNotification) {
      return { ok: true, text: burnToast.text || "BurntToast unavailable; tray balloon fallback will be used" };
    }
    return run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `
if (Get-Command New-BurntToastNotification -ErrorAction SilentlyContinue) {
  New-BurntToastNotification -Text 'Focus Pet', 'Native adapter smoke test'
} else {
  Add-Type -AssemblyName System.Windows.Forms
  $n = New-Object System.Windows.Forms.NotifyIcon
  $n.Icon = [System.Drawing.SystemIcons]::Information
  $n.BalloonTipTitle = 'Focus Pet'
  $n.BalloonTipText = 'Native adapter smoke test'
  $n.Visible = $true
  $n.ShowBalloonTip(2000)
  Start-Sleep -Milliseconds 600
  $n.Dispose()
}
      `,
    ], { timeout: 10000 });
  }, { required: false });
  addCheck("Tauri native pet-pack dialog wiring", () => {
    const cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
    const source = readFileSync("src-tauri/src/pet_pack.rs", "utf8");
    const ok = cargo.includes("tauri-plugin-dialog")
      && source.includes("DialogExt")
      && source.includes("blocking_pick_folder")
      && source.includes("blocking_pick_file");
    return { ok, text: ok ? "folder, pet.json, and zip selection use tauri-plugin-dialog" : "native dialog wiring is incomplete" };
  });
} else if (platform === "linux") {
  addCheck("Linux session type", () => ({ ok: true, text: process.env.XDG_SESSION_TYPE || "unknown" }), { required: false });
  addCheck("Linux xdotool active window", () => {
    if (!available("xdotool")) {
      const wayland = (process.env.XDG_SESSION_TYPE ?? "").toLowerCase() === "wayland";
      return { ok: wayland, text: wayland ? "xdotool unavailable on Wayland; adapter should report wayland-limited" : "xdotool missing" };
    }
    return run("sh", ["-lc", "xdotool getactivewindow getwindowname"], { timeout: 5000 });
  }, { required: false });
  addCheck("Linux xprop active window metadata", () => {
    if (!available("xdotool") || !available("xprop")) return { ok: false, text: "xdotool or xprop missing" };
    return run("sh", ["-lc", "wid=$(xdotool getactivewindow) && xprop -id \"$wid\" WM_CLASS _NET_WM_PID"], { timeout: 5000 });
  }, { required: false });
  addCheck("Linux idle helper", () => {
    if (available("xprintidle")) return run("xprintidle", []);
    if (available("qdbus")) {
      return run("qdbus", ["org.kde.screensaver", "/ScreenSaver", "org.freedesktop.ScreenSaver.GetSessionIdleTime"]);
    }
    return { ok: false, text: "xprintidle and qdbus missing" };
  }, { required: false });
  addCheck("Linux notify-send helper", () => {
    if (!available("notify-send")) return { ok: false, text: "notify-send missing" };
    if (!sendNotification) return { ok: true, text: "skipped delivery; pass --send-notification to display one" };
    return run("notify-send", ["Focus Pet", "Native adapter smoke test"]);
  }, { required: false });
  addCheck("Linux picker helper", () => {
    if (available("zenity")) return run("zenity", ["--version"]);
    if (available("kdialog")) return run("kdialog", ["--version"]);
    return { ok: false, text: "zenity and kdialog missing" };
  }, { required: false });
} else {
  console.error(`Unsupported platform for native adapter verification: ${platform}`);
  process.exit(1);
}

let failed = 0;
let warned = 0;
console.log(`==> Focus Pet native adapter smoke on ${platform}`);
for (const check of checks) {
  const raw = check.fn();
  const result = { name: check.name, required: check.required, ok: raw.ok, text: raw.text ?? "" };
  printResult(result);
  if (!result.ok && result.required) failed += 1;
  if (!result.ok && !result.required) warned += 1;
}

if (failed > 0) {
  console.error(`\nNative adapter smoke failed: ${failed} required check(s) failed.`);
  process.exit(1);
}
if (warned > 0) {
  console.warn(`\nNative adapter smoke completed with ${warned} warning(s). Some optional native coverage is limited on this session.`);
}
