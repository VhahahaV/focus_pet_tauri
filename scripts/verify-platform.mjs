import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const platform = process.platform;
const preflightOnly = process.argv.includes("--preflight-only");

const commandExists = (program, args = ["--version"]) => {
  const result = spawnSync(program, args, {
    env: process.env,
    stdio: "ignore",
  });
  return result.status === 0;
};

const commandAvailable = (program) => {
  const lookup = platform === "win32"
    ? ["where", [program]]
    : ["sh", ["-lc", `command -v ${program}`]];
  const result = spawnSync(lookup[0], lookup[1], {
    env: process.env,
    stdio: "ignore",
  });
  return result.status === 0;
};

const commandOutput = (program, args = []) => {
  const result = spawnSync(program, args, {
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
};

const windowsVbScriptEnabled = () => {
  const tempDir = mkdtempSync(join(tmpdir(), "focus-pet-vbs-"));
  const scriptPath = join(tempDir, "smoke.vbs");
  try {
    writeFileSync(scriptPath, "WScript.Echo \"ok\"\n", "utf8");
    const output = commandOutput("cscript", ["//Nologo", scriptPath]);
    return output.trim() === "ok";
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
};

const dependencyChecks = {
  darwin: [
    ["osascript", () => commandExists("osascript", ["-e", "return 1"])],
    ["ioreg", () => commandExists("ioreg", ["-c", "IOHIDSystem", "-r", "-d", "1"])],
    ["cargo", () => commandAvailable("cargo")],
    ["Node.js", () => commandExists(process.execPath)],
  ],
  win32: [
    ["PowerShell", () => commandExists("powershell", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion"])],
    ["VBScript packaging host", () => commandAvailable("cscript") && windowsVbScriptEnabled()],
    ["cargo", () => commandAvailable("cargo")],
    ["Node.js", () => commandExists(process.execPath)],
  ],
  linux: [
    ["Tauri WebKitGTK build libraries", () => commandAvailable("pkg-config") && commandExists("pkg-config", ["--exists", "webkit2gtk-4.1"])],
    ["Tauri AppImage patcher", () => commandAvailable("patchelf")],
    ["desktop opener integration", () => commandAvailable("xdg-open")],
    ["Debian package tools", () => commandAvailable("dpkg-deb") && commandAvailable("fakeroot")],
    ["RPM package tools", () => commandAvailable("rpmbuild") || commandAvailable("rpm")],
    ["notify-send", () => commandExists("notify-send", ["--help"])],
    ["xdotool or Wayland-limited fallback", () => commandExists("xdotool", ["--version"]) || (process.env.XDG_SESSION_TYPE ?? "").toLowerCase() === "wayland"],
    ["xprop or Wayland-limited fallback", () => commandAvailable("xprop") || (process.env.XDG_SESSION_TYPE ?? "").toLowerCase() === "wayland"],
    ["xprintidle or qdbus idle fallback", () => commandAvailable("xprintidle") || commandExists("qdbus", ["--version"])],
    ["zenity or kdialog picker", () => commandAvailable("zenity") || commandAvailable("kdialog")],
    ["cargo", () => commandAvailable("cargo")],
    ["Node.js", () => commandExists(process.execPath)],
  ],
};

const platformName = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
}[platform] ?? platform;

console.log(`==> Focus Pet platform verification on ${platformName}`);
if (platform === "linux") {
  console.log(`Session type: ${process.env.XDG_SESSION_TYPE ?? "unknown"}`);
}
if (platform === "win32") {
  const burnToast = commandOutput("powershell", ["-NoProfile", "-Command", "Get-Module -ListAvailable BurntToast | Select-Object -First 1 -ExpandProperty Name"]);
  console.log(`BurntToast module: ${burnToast || "not installed; tray balloon fallback will be used"}`);
  console.log("MSI bundle preflight: bundle.targets is all, so VBScript must be enabled for WiX MSI packaging.");
}

const checks = dependencyChecks[platform] ?? [];
const missing = [];
for (const [label, verify] of checks) {
  const ok = verify();
  console.log(`${ok ? "ok" : "missing"} - ${label}`);
  if (!ok) missing.push(label);
}
if (missing.length > 0) {
  console.warn(`\nDependency warning: ${missing.join(", ")} missing. Automated build checks will still run, but native smoke or bundle coverage may be limited on this machine.\n`);
}

const launchHint = {
  darwin: "Open src-tauri/target/release/bundle/macos/Focus Pet.app and confirm the main window appears.",
  win32: "Launch the produced Windows installer or src-tauri\\target\\release\\focus-pet.exe and confirm the main window appears.",
  linux: "Launch the produced AppImage/deb/rpm or src-tauri/target/release/focus-pet and confirm the main window appears.",
}[process.platform] ?? "Launch the produced desktop bundle and confirm the main window appears.";

const platformNativeChecklist = {
  darwin: [
    "Confirm Settings > Recognition > Refresh Diagnostics reads the frontmost app through System Events.",
    "Confirm Settings > Permissions opens macOS Privacy/Input Monitoring and Notifications panes.",
    "Confirm a test notification appears through AppleScript display notification.",
    "Confirm Dock-near pet placement uses the active monitor work area.",
  ],
  win32: [
    "Confirm Settings > Recognition > Refresh Diagnostics reads foreground window title and process name through the direct Win32 adapter.",
    "Confirm Settings > Permissions opens Windows privacy and notification settings.",
    "Confirm a test notification appears through BurntToast or the tray balloon fallback.",
    "Confirm taskbar-near pet placement uses the active monitor work area.",
    "Confirm the Tauri native dialog imports a folder, pet.json, a single-pack zip, and a collection zip.",
  ],
  linux: [
    "Confirm Settings > Recognition > Refresh Diagnostics reads active window information on X11, or reports wayland-limited on restricted Wayland sessions.",
    "Confirm Settings > Permissions opens the desktop privacy/settings entry when available.",
    "Confirm a test notification appears through notify-send.",
    "Confirm panel-near pet placement uses the active monitor work area.",
    "Confirm zenity or kdialog imports folder, pet.json, and zip packs.",
  ],
}[process.platform] ?? [];

const printNativeChecklist = () => {
  console.log(`
==> Manual native smoke checklist
1. ${launchHint}
2. Open Settings > Permissions, click Refresh Permissions, then click Test Notification and confirm a system notification is shown.
3. Open Settings > Recognition, click Refresh Diagnostics, and confirm the foreground app/status updates for this OS.
4. Enable both desktop status cards and the pet companion; confirm widget windows appear, move freely when enabled, and restore position.
5. Use the tray/menu to open Today, Pet, Settings, toggle widgets, toggle pet, pause reminders, and quit.
6. Import a pet pack from a folder, pet.json, single zip, and multi-pack zip; confirm preview, frame playback, audio, hide/delete, and reimport restore.
7. Start and finish a focus session; confirm local persistence after restart, export/delete data, and log folder/current-log actions.
${platformNativeChecklist.map((item, index) => `${index + 8}. ${item}`).join("\n")}
`);
};

if (preflightOnly) {
  printNativeChecklist();
  process.exit(missing.length > 0 ? 1 : 0);
}

const nodeCommand = (entry, args = []) => [process.execPath, [entry, ...args]];
const rustTestArgs = ["test", "--manifest-path", "src-tauri/Cargo.toml"];
if ((process.env.RUSTUP_TOOLCHAIN ?? "").includes("gnullvm")) rustTestArgs.splice(1, 0, "--release");

const commands = [
  nodeCommand("scripts/verify-tauri-contract.mjs"),
  nodeCommand("scripts/verify-migration.mjs"),
  nodeCommand("scripts/verify-frontend-tokens.mjs"),
  nodeCommand("node_modules/typescript/bin/tsc", ["-b"]),
  nodeCommand("node_modules/vite/bin/vite.js", ["build"]),
  nodeCommand("node_modules/vitest/vitest.mjs", ["run"]),
  nodeCommand("node_modules/oxlint/bin/oxlint"),
  nodeCommand("node_modules/@playwright/test/cli.js", ["test"]),
  ["cargo", ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--check"]],
  ["cargo", ["check", "--manifest-path", "src-tauri/Cargo.toml"]],
  ["cargo", rustTestArgs],
  nodeCommand("node_modules/@tauri-apps/cli/tauri.js", ["build", "--config", JSON.stringify({ build: { beforeBuildCommand: "" } })]),
];

for (const [program, args] of commands) {
  const label = `${program} ${args.join(" ")}`;
  console.log(`\n==> ${label}`);
  const result = spawnSync(program, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`\nPlatform verification failed at: ${label}`);
    process.exit(result.status ?? 1);
  }
}

printNativeChecklist();
