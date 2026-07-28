# Target Machine Validation

Use this checklist when claiming a Focus Pet migration build is verified on a real macOS, Windows, or Linux desktop. CI proves the automated build/test/bundle path; this file captures the visible desktop behavior that headless runners cannot fully prove.

## Command Sequence

Run these from the repository root on each target OS:

```bash
npm ci
npm run verify:preflight
npm run verify:native
npm run verify:native:notify
npm run verify:tauri-contract
npm run verify:migration
npm run verify:platform
```

`verify:preflight` must finish without missing required helpers before native coverage is considered complete. `verify:native:notify` should only be run in a visible desktop session because it displays a system notification.

## Evidence To Record

- OS name, version, CPU architecture, and desktop session type.
- Exact command outputs or CI log links for `verify:preflight`, `verify:native`, `verify:native:notify`, and `verify:platform`.
- Generated bundle paths from `src-tauri/target/release/bundle`.
- Screenshot or short note confirming the main window launched from the produced bundle.
- Screenshot or short note confirming tray/menu actions, widget windows, and companion pet movement.
- Pet-pack import evidence for folder, `pet.json`, single-pack zip, and multi-pack zip.
- Persistence evidence after restart: active settings, imported packs, session/history state, and widget/pet positions.
- Privacy/data evidence: export file created, delete-all-data clears local state, logs/current-log actions open correctly.

## Platform-Specific Smoke Items

macOS:

- `sample_activity` reads the frontmost app through System Events on a visible desktop.
- Privacy/Input Monitoring and Notifications settings panes open from Settings.
- Test notification appears through AppleScript notification delivery.
- Dock-near companion placement uses the active monitor work area.
- DMG launch warning appears when running from `/Volumes`, and installed build notice appears once from Applications.

Windows:

- `sample_activity` reads foreground window title/process, idle time, global input counters, and screen-lock state through direct Win32 APIs.
- VBScript is enabled when building MSI packages because `bundle.targets` is `all`.
- Privacy and notification settings open through `ms-settings:...`.
- Test notification appears through BurntToast or tray balloon fallback.
- Tauri native dialogs import a folder, `pet.json`, single zip, and collection zip.
- Taskbar-near companion placement uses the active monitor work area.

Linux:

- X11 sessions read active window title/class through `xdotool` and `xprop`; restricted Wayland sessions report `wayland-limited` instead of false success.
- `notify-send` displays the test notification.
- `zenity` or `kdialog` imports folder, `pet.json`, single zip, and collection zip.
- Panel-near companion placement uses the active monitor work area.
- AppImage, deb, and rpm artifacts launch on the intended baseline distribution.

## Current Workspace Status

macOS automated checks and release bundle smoke have been run in the original workspace. Windows direct adapter tests, release build, canonical data directory, and a XiaoDaiLocal import smoke have been run on a real Windows x86_64 machine; the remaining visible Windows and installer items are tracked in `docs/windows-compatibility-handoff-2026-07-18.md`. Linux still needs its own target OS or CI coverage followed by visible desktop smoke before the migration can be called fully target-verified.
