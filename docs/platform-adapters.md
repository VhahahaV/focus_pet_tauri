# Platform Adapter Design

Focus Pet exposes the same Tauri commands to React on every desktop OS. Platform differences stay under `src-tauri/src/native`.

## Shared Contract

`sample_activity` returns:

- `platform`
- `sampleQuality`
- `appName`
- `bundleID`
- `windowTitle`
- `idleSeconds`
- `inputMonitoringStatus`
- `keyboardCount`
- `pointerCount`
- `switchCount`
- `isSystemSleeping`
- `isScreenLocked`

The React state engine consumes the same shape on macOS, Windows, and Linux.

Shared native enrichment lives in `src-tauri/src/native/mod.rs`:

- Tracks the previous foreground app identity and emits `switchCount` when it changes.
- Uses idle-time movement between samples as a conservative keyboard/pointer fallback when a platform adapter cannot observe global input events directly.
- Keeps the frontend contract stable while each OS adapter supplies the strongest available raw sample.

## macOS

File: `src-tauri/src/native/macos.rs`

- Frontmost app, bundle id, and title: `System Events` via `osascript`.
- Input idle seconds: read-only `ioreg -c IOHIDSystem` HID idle time.
- Keyboard/pointer fallback: CoreGraphics `CGEventSourceSecondsSinceLastEventType` for key, modifier, mouse, drag, and scroll event families.
- Screen lock: read-only `ioreg -n Root -d1` `CGSSessionScreenIsLocked`.
- Settings entry points: macOS Privacy/Input Monitoring and Notifications panes.
- Notifications: AppleScript `display notification`; the permissions panel can send a test notification and reports the command result.
- Pet-pack picker: AppleScript folder chooser.

## Windows

File: `src-tauri/src/native/windows.rs`

- Foreground window: PowerShell-hosted Win32 calls to `GetForegroundWindow`, `GetWindowText`, and `GetWindowThreadProcessId`.
- App identity: `Get-Process` name and executable path.
- Input idle seconds: PowerShell-hosted Win32 `GetLastInputInfo`.
- Settings entry points: `ms-settings:privacy` and `ms-settings:notifications`.
- Notifications: PowerShell notification path, using BurntToast when available and a tray balloon fallback otherwise. The permissions panel can send a test notification and reports the command result.
- Pet-pack picker: Windows Forms folder browser.

## Linux

File: `src-tauri/src/native/linux.rs`

- Active window title: `xdotool getactivewindow getwindowname`.
- Window class and PID: `xprop` on active X11 window id.
- App identity: `ps` process name, falling back to `WM_CLASS`.
- Input idle seconds: `xprintidle`, then KDE `qdbus` session idle fallback.
- Wayland limitation: many compositors intentionally restrict global active-window/input APIs; adapter reports `wayland-limited`.
- Notifications: `notify-send`; the permissions panel can send a test notification and reports the command result.
- Pet-pack picker: `zenity`, falling back to `kdialog` when available, with folder and file choices.

## Desktop Widgets

The main React runtime is the only sampler/persistence owner. `sync_widget_windows` creates or hides the lightweight desktop webview windows:

- `widget-current-status` loads `/?widget=currentStatus`.
- `widget-recent-rhythm` loads `/?widget=recentRhythm`.
- `widget-pet-companion` loads `/?widget=petCompanion`.

The main window emits `focus-pet-widget-state` to the status cards and `focus-pet-companion-state` to the floating pet after runtime changes, so widget windows render state and pet frames without starting a second sampling loop.

Status-card windows respect `desktopWidget.movementMode`: `free` allows drag-to-move and `fixed` keeps cards in place. Widget windows listen for Tauri moved events, emit physical coordinates back to the main window, and store those coordinates in `desktopWidget.currentStatusOrigin` or `desktopWidget.recentRhythmOrigin`. The companion pet can be placed in screen corners, near the OS Dock/taskbar/panel, or dragged into a custom position. `sync_widget_windows` uses the active monitor work area to calculate Dock/taskbar/panel placement on macOS, Windows, and Linux, while custom movement stores `pet.placement = custom` with physical origin settings. `sync_widget_windows` restores those physical coordinates when windows are shown again.

The widget payload includes the movement mode and pet placement, and the companion-pet payload includes the full runtime bundle plus available pet packs, allowing the secondary windows to stay render-only while the main runtime remains the persistence and sampling owner. Companion drag events also emit physical `dragged` and `landing` pet intents to match the original interaction animation model, and the pet hover panel can manually cycle to the next playable source action.

## Native Menu And Tray

Implemented in `src-tauri/src/lib.rs` and routed in `src/app/nativeMenu.ts`.

- A desktop application menu is installed for macOS-style menu access.
- A cross-platform tray icon is installed with the bundled app icon.
- Tray/menu actions reopen the main window, jump to the Today/Pet/Settings tabs, toggle desktop status cards, toggle the companion pet, pause reminders, start/end breaks, or quit.
- Closing the main window hides it instead of exiting, so tray/menu access remains available.
- React remains the source of truth for persisted settings; Rust only emits `focus-pet-native-menu` actions to the main webview.

## Pet-Pack Import

Implemented in `src-tauri/src/pet_pack.rs`.

- Native picker import and path import share the same validator.
- Folder, `pet.json`, single-pack zip, and multi-pack collection zip imports copy validated packs into the app data `PetPacks` library.
- Imported records include per-source-action frame URLs and audio URLs for React pet playback.
- React resolves mapped source actions for each pet intent and rotates among playable source actions at `pet.randomActionSwitchSeconds` when random switching is enabled, matching the original companion behavior.
- Launch-time listing restores copied packs into React so imported pets persist after restart.
- User-imported packs can be removed from the local library by id.
- Validation checks `pet.json`, schema, id/name, action/source-action folders, PNG frame presence, `frameCount`, preview, license, distribution, and idle source-action references before copying any pack from a collection.

## Retention And Logging

- React normalizes the original retention settings (`stateRetentionDays`, `appUsageRetentionDays`, `inputActivityRetentionDays`, `sessionRetentionDays`, `nudgeRetentionDays`) and prunes old records on load, save, export, and runtime recomputation.
- Attention-history snapshots split state segments into daily buckets for weekly/monthly heatmaps. Range-based history snapshots clip state, app-usage, and input buckets into 3/7/15/30/60 day windows, with optional weekend exclusion for workday-only views, so the React history tab can preserve the original attention-history workflow without native-side aggregation.
- Logging enablement is part of persisted settings. Diagnostic snapshot writes respect `settings.logging.isEnabled`; native log-folder opening, current log-file opening, and log-path copying remain available for troubleshooting.
- Native storage uses the per-user Focus Pet application-support root on each OS. The store writes `schema.json`, migrates legacy roots (`FocusPetMVP`, `FocusPetV0`, `FocusPetLegacy`) into the current root when safe, backs up missing/invalid/unsupported schema roots, and blocks writes for unsupported schemas while still allowing read fallback.

## Installation Notices

- `installation_snapshot` reports the app/bundle path, build identifier, version display, installed-path status, and mounted-volume status.
- React shows a warning when macOS launches from `/Volumes/.../Focus Pet.app`, matching the original DMG safety notice without using a blocking native modal.
- Installed builds show a one-time ready/update notice per `identifier|version`, stored in browser local storage for the dashboard webview.

## Verification

Cross-platform compile validation should be run on each target OS:

```bash
npm run verify:preflight
npm run verify:native
npm run verify:native:notify
npm run verify:tauri-contract
npm run verify:migration
npm run verify:platform
```

`verify:preflight` checks native helper availability and prints the OS-specific smoke checklist without building. If it reports missing helpers, install the OS helper listed in the warning before claiming native feature coverage. `verify:native` exercises the current OS adapter probes without displaying notifications; `verify:native:notify` also sends a test notification and should be used only on a visible desktop session. `verify:platform` runs the automated checks below and then prints the same manual native smoke checklist:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
npm run verify:tauri-contract
npm run verify:migration
npm run build
npm test
npm run test:ui
npm run tauri:build
```

The repository includes `.github/workflows/verify-platforms.yml` for CI coverage on `macos-latest`, `windows-latest`, and `ubuntu-22.04`. The Linux job installs:

- `libwebkit2gtk-4.1-dev`
- `libayatana-appindicator3-dev`
- `libxdo-dev`
- `libssl-dev`
- `librsvg2-dev`
- `patchelf`
- `xdg-utils`
- `dpkg-dev`
- `fakeroot`
- `rpm`
- `xdotool`
- `xprintidle`
- `zenity`
- `xvfb`

The CI workflow can prove automated build/test/bundle behavior plus non-interactive native adapter probes on all three OS families and stores bundle artifacts, but the native smoke checklist still needs human confirmation on a visible desktop session for permissions panes, notification display, foreground-window sampling, tray interaction, and widget/pet window movement.

The macOS checks, release bundle build, and `.app` launch smoke test have been run in this workspace. Cross-target checks were attempted from macOS: Windows reached Tauri's Windows resource build step but needs a Windows resource compiler/MSVC environment (`llvm-rc` was not available in this workspace); Linux reached GTK/GLib build scripts but needs a Linux target sysroot and cross-aware `pkg-config`. Windows and Linux should therefore be checked on their own target OS with the same command set, plus a real runtime smoke test for foreground-window sampling, notification delivery, folder picker import, tray/menu actions, and widget window visibility.

Use `docs/target-machine-validation.md` as the evidence template for target-machine sign-off.
