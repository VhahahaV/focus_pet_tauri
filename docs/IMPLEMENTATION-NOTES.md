# Focus Pet implementation notes

> This document preserves the detailed implementation narrative that previously lived in the repository README. For the product overview, platform status, and primary development entry points, see the [main README](../README.md).

Focus Pet has been migrated into a Tauri + React architecture. The new app keeps the original product split:

- `src/core`: state model, classifier, privacy sanitizing, state engine, sessions, nudges, timelines, summaries.
- `src/store`: browser/Tauri storage bridge and redacted export helpers.
- `src/resources`: `pet.json` parsing, source-action resolution, validation, and preview records.
- `src/app`: runtime orchestration, sampling ticks, persistence, user actions, native menu action routing, widget sync, and companion-pet action selection.
- `src/components`: React dashboard, history, pet, settings, widget views, and floating companion UI.
- `src-tauri/src`: native command layer, local JSON store, pet-pack importer, notification bridge, widget windows, and platform adapters.
- `local-pet-packs`: migrated local pet-pack archives from the Swift app, kept as importer verification fixtures rather than bundled defaults.
- `docs/original-swift`: original Swift-era design, resource, and release notes preserved for migration traceability.

## Platform Modules

The Tauri backend exposes one stable command surface to React, with OS-specific implementations under:

- `src-tauri/src/native/macos.rs`
- `src-tauri/src/native/windows.rs`
- `src-tauri/src/native/linux.rs`

Current commands:

- `load_snapshot`, `save_snapshot`, `native_runtime_snapshot`
- `sample_activity`, `sample_system_metrics`
- `choose_and_import_pet_pack`, `import_pet_pack_from_path`
- `list_pet_packs`, `delete_pet_pack`
- `deliver_notification`
- `sync_widget_windows`

The macOS adapter reads the frontmost app/window through System Events, reads HID idle time through `ioreg`, detects lock state with a read-only session check, and uses CoreGraphics idle-event timestamps as a keyboard/pointer fallback. Windows calls Win32 directly for foreground-window metadata, idle time, lock state, and low-level keyboard/pointer hooks; PowerShell is retained only for the notification delivery fallback. Linux uses X11/KDE-friendly command adapters (`xdotool`, `xprop`, `xprintidle`, `qdbus`) with a clear Wayland-limited status when compositor restrictions apply. A shared native tracker computes app-switch deltas and conservative idle-based input fallback counts when a platform cannot provide direct events.

Pet packs can be imported through the native picker or by path from a pack folder, `pet.json`, a single-pack `.zip`, or a collection `.zip` containing multiple packs. The importer extracts archives into a temporary directory, validates every `pet.json`, action folder, PNG frame set, `frameCount`, preview, license, distribution, and idle source-action reference before copying anything into local app data, then returns normalized records and per-action frame/audio assets to React. The app scans the local `PetPacks` library on launch, restores imported packs into the picker, plays mapped source-action frames in the floating pet window, supports hover status/actions, hides built-in/preview packs by id, physically deletes user-imported packs when available, and rotates playable source actions at the configured random-action interval. Reimporting a pack removes the matching hidden id, matching the original recovery behavior.

Desktop status cards and the companion pet are real Tauri webview windows (`widget-current-status`, `widget-recent-rhythm`, `widget-pet-companion`) that render lightweight React views and receive state from the main runtime. The status cards respect the original fixed/free movement mode, report their physical window position back to the main runtime when freely moved, and restore those positions on the next sync. The companion pet can be placed in screen corners, near the OS Dock/taskbar/panel using each monitor's work area, or dragged into a custom position. System notifications are bridged through per-OS native commands and can be verified from the permissions panel with a test notification.

The migrated settings surface includes recognition sensitivity presets, recognition thresholds, recognition diagnostics refresh/reset controls, focus target minutes, break duration, auto-start break, reminder channels/thresholds/cooldowns/pause duration, privacy/data export/delete controls, logging enablement, permissions refresh/test-notification/log diagnostics, desktop card visibility/rhythm window/movement mode, and pet display/audio/hover/random-action/placement controls. Activity history is maintained indefinitely by default.

The history page now mirrors the original attention-history intent with weekly/monthly attention heatmaps, 3/7/15/30/60 day range switching, optional weekend exclusion, daily average focus/distracted/break/away time, app active time, input active time, and top-app ranking computed from clipped timeline records.

The runtime also backfills long sampling gaps as away time, so sleep, lock, and extended inactivity do not get counted as focus time. When welcome-back nudges are enabled, a long away backfill can emit the same `welcomeBack` pet intent and reminder used by the original wake/unlock flow.

User data is stored outside the app bundle under the per-user Focus Pet application-support directory (`Focus Pet` on each OS). The store writes schema metadata, migrates legacy roots such as `FocusPetMVP` when the current root is empty, backs up data that is missing/using an unsupported schema, and blocks writes for unknown future schemas so older builds do not damage newer data.

The desktop launch flow also preserves the original installation safety notices. When the app is opened directly from a mounted macOS DMG, the dashboard shows a warning to move it into Applications first; when an installed build is launched for the first time or after an update, it shows the ready/update notice once per build.

The desktop shell also installs a native menu/tray entry. The tray can reopen the main dashboard, jump to pet/settings tabs, toggle all desktop status cards, show or hide the floating pet, pause reminders, start/end a break, and quit. Closing the main window hides it instead of terminating the app, matching the original always-available menu bar behavior.

See `docs/platform-adapters.md` for the per-OS sampling design and validation boundary. Use `docs/target-machine-validation.md` when recording real macOS, Windows, and Linux desktop verification evidence.

## Development

```bash
npm install
npm run build
npm test
npm run test:ui
npm run verify:native
npm run verify:native:notify
npm run verify:tauri-contract
npm run verify:migration
npm run verify:preflight
npm run verify:platform
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri:build
npm run tauri:dev
```

## Verification

Verified in this workspace:

- `npm run build`
- `npm test`
- `cargo check` in `src-tauri`
- `npm run test:ui`
- `cargo test` in `src-tauri`
- `npm run tauri:build -- --target universal-apple-darwin --bundles dmg`
- macOS DMG mount, universal-binary, embedded-theme, and code-signature audit

The Vitest suite covers core behavior: classification, recognition sensitivity presets, recognition exception reset, state engine, timeline recording, range-based history snapshots, attention heatmap buckets, long-gap away backfill, welcome-back nudges, daily summary, sessions, nudges, indefinite history persistence, pet-pack records, companion animation, native menu actions, widget sync, and pet-pack validation. The Rust suite verifies frontend/backend command serialization contracts, native app-switch and physical input deltas, snapshot shape, store schema metadata, legacy store migration, unsupported-schema backup/write blocking, folder and zip pet-pack import validation, frame-asset discovery, multi-pack archive import, launch-time library listing, notification command exit-status handling, installation-path notice detection, companion-pet cross-display placement. The Playwright suite verifies the built React dashboard on desktop and mobile viewports, including tab navigation, history rendering, focus sessions, recognition/reminder/desktop movement/pet controls, theme persistence, retired-settings removal, and widget views.

For target-machine validation on macOS, Windows, and Linux, run `npm run verify:preflight` first to check native helper availability and print the OS-specific smoke checklist. Run `npm run verify:native` to exercise the native adapter probes for the current OS without showing a notification; on a visible desktop session run `npm run verify:native:notify` to also verify notification delivery. Then run `npm run verify:platform`; it executes the automated build/test/bundle sequence and prints the same manual native smoke checklist for notifications, foreground-app sampling, widget windows, tray/menu actions, pet-pack import, persistence.

The repository also includes `.github/workflows/verify-platforms.yml`, which runs the same automated verification on macOS, Windows, and Linux runners and uploads the generated desktop bundles. Linux runners install the WebKitGTK, app-indicator, xdo, packaging, desktop opener, notification, and picker helpers required for Tauri and Focus Pet native adapters.

`npm run verify:migration` audits the migrated Swift-era module map, classification catalog, image assets, original docs, local pet-pack archives, Tauri command surface, platform adapter split, and verification entry points. When the original `/Users/vhahahav/Code/focus_pet` project is available, it also compares catalog, image, and pet-pack archive hashes against the source project.

Current macOS release artifacts:

- `release/Focus-Pet-0.1.1-macos-universal-20260804.dmg`
- `release/Focus-Pet-0.1.1-macos-universal-20260804.dmg.sha256`
