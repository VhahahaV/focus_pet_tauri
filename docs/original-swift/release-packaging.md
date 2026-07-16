# Focus Pet Release Packaging

This project has two packaging modes:

- Distribution mode: signed with a Developer ID Application certificate, notarized,
  stapled, and safe to upload as a downloaded DMG.
- Local mode: ad-hoc signed and useful only for local smoke tests. Never upload
  local DMGs for other Macs.

The default `scripts/package-dmg.sh` mode is distribution mode so the release path
fails early when signing or notarization is not configured.

## One-Time Release Setup

Install a valid Developer ID Application certificate in the keychain and confirm
that macOS can see it:

```bash
security find-identity -v -p codesigning
```

Store Apple notary credentials in the keychain. Prefer a keychain profile over
passing credentials directly on the command line:

```bash
xcrun notarytool store-credentials focuspet-notary \
  --apple-id you@example.com \
  --team-id TEAMID \
  --password app-specific-password
```

## Distribution Build

Build the uploadable DMG:

```bash
FOCUSPET_CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
FOCUSPET_NOTARY_PROFILE=focuspet-notary \
scripts/package-dmg.sh
```

Successful output:

- `dist/FocusPet-<version>-<build>.dmg`
- `dist/FocusPet.dmg`
- `dist/FocusPet-<version>-<build>.dmg.sha256`
- `dist/FocusPet-<version>-<build>.dmg.manifest.txt`

Only these distribution-mode DMGs should be uploaded for users to download.

The script performs the release gates in order:

- builds a universal `arm64+x86_64` Swift executable with
  `--configuration release` by default;
- creates a stable `Focus Pet.app` bundle;
- places SwiftPM resource bundles under `Contents/Resources`;
- excludes `external_generated_packs` and `LocalPetPacks` by default so
  local-only or third-party test pet assets are not redistributed accidentally;
- signs the app with hardened runtime;
- verifies the embedded WidgetKit extension as gallery-ready, which requires
  trusted app and extension signing rather than ad-hoc signing;
- notarizes and staples the app;
- creates the DMG with the Applications symlink and Finder layout;
- signs, notarizes, and staples the DMG;
- verifies the DMG checksum, signature, staple ticket, mounted app, and
  Gatekeeper assessment.

After the build, run the downloaded-file verifier:

```bash
scripts/verify-dmg-release.sh dist/FocusPet.dmg
```

This writes `dist/FocusPet.dmg.verification.txt` unless `--report` is provided.

For a final acceptance pass on a clean test Mac, copy the DMG to that Mac and run:

```bash
scripts/verify-dmg-release.sh --install-to /Applications --replace --open-smoke /path/to/FocusPet.dmg
```

## Local Smoke Build

Recommended repeatable local packaging command:

```bash
scripts/build-verified-local-dmg.sh
```

This script builds a timestamped local DMG, checks the release build, verifies
the mounted app, confirms the Finder installer window metadata, requires that
no local pet packs are bundled in the app, and runs an installed-copy launch
smoke test.

Build a local-only DMG:

```bash
scripts/package-dmg.sh --local
```

Local mode excludes pet packs by default, matching the distribution asset
policy. Build the separate resource zip folder when you want to hand pet packs
to users for optional import:

```bash
scripts/build-local-pet-packs.py
```

This writes individual archives under `dist/local/PetPacks/`, including:

- `LuoXiaoHeiLocal`
- `PixelCatMemeLocal`
- `XiaoDaiLocal`
- `UNIkeNLocal.zip` when `dist/local/UNIkeNLocal.zip` exists

Pass `--include-local-test-pets` only for internal smoke testing of bundled
resource behavior; user-facing DMGs should not use that flag.

Pass `--native` only for fast local iteration. Uploadable builds should keep the
default universal executable so Apple Silicon and Intel Macs are both covered.

Successful output:

- `dist/local/FocusPet-local-<version>-<build>.dmg`
- `dist/local/FocusPet-local.dmg`
- `dist/local/FocusPet-local-<version>-<build>.dmg.sha256`
- `dist/local/FocusPet-local-<version>-<build>.dmg.manifest.txt`

Local images are ad-hoc signed. They are expected to fail Gatekeeper assessment
after being downloaded on another Mac, so they must not be uploaded as releases.
They can also be hidden by the native macOS widget gallery even when PlugInKit
registration succeeds. If `chronod` logs `Ignoring restricted or unknown
extension com.focuspet.FocusPet`, rebuild with an Apple Development or Developer
ID signing identity before treating the WidgetKit gallery path as verified.

Local checks:

```bash
scripts/verify-dmg-release.sh --local --expect-local-test-pets dist/local/FocusPet-local.dmg
scripts/verify-dmg-release.sh --local --no-quarantine --open-smoke --expect-local-test-pets dist/local/FocusPet-local.dmg
```

The verifier writes `.verification.txt` evidence files next to the checked DMG.
The second command intentionally skips the downloaded-file quarantine simulation.
It only proves that the app resources and launch path work before Developer ID
signing is available.

Widget checks:

```bash
scripts/verify-widget-extension.sh /Applications/Focus\ Pet.app
scripts/verify-widget-extension.sh --require-gallery-ready /Applications/Focus\ Pet.app
```

The first command verifies the bundle shape, codesign seal, and PlugInKit
registration. The second command is the stricter acceptance gate for native
WidgetKit gallery visibility.

If the native gallery path is blocked on a test machine, Focus Pet also ships a
fallback desktop status card. Open the menu bar icon and choose `桌面状态卡` to
show the same current-status and recent-rhythm cards without using macOS widget
editing.

## Install Layout

The DMG volume contains:

- `Focus Pet.app`
- `Applications -> /Applications`

The Finder installer window uses a compact drag-and-drop layout with a
pre-rendered Retina background:

```text
scripts/dmg-assets/background.png
```

Regenerate it after visual changes with:

```bash
swift scripts/dmg-assets/render-background.swift scripts/dmg-assets/background.png "$PWD"
```

The packaging and local verification scripts require this image to be
`1440x920`, matching the `720x460` Finder window at 2x scale.

Repeated drag installs target:

```text
/Applications/Focus Pet.app
```

This prevents the earlier `FocusPet.app` / `Focus Pet.app` naming split that
could leave two visually similar apps in Applications.

## User Data

User data is local-only and belongs outside the app bundle:

```text
~/Library/Application Support/Focus Pet
```

This directory contains:

- `settings.json`
- `classification-rules.json`
- `state-segments.json`
- `app-usage.json`
- `input-activity.json`
- `focus-sessions.json`
- `break-sessions.json`
- `nudges.json`
- `PetPacks/` for user-imported pet packs

Older builds used:

```text
~/Library/Application Support/FocusPetMVP
```

The app migrates this legacy directory into `Focus Pet` on startup when the new
directory is empty.

If the app sees existing data without a schema file, it backs up the data
directory, adopts the current schema metadata, and continues reading the data.
If it sees a schema version this build does not understand, it backs up the
directory and blocks writes so an older build cannot damage newer-format data.

## Install Notice

The drag-and-drop DMG cannot run code at the exact moment Finder finishes
copying the app into Applications. Instead, Focus Pet shows an install or update
success alert the first time each build is launched from `/Applications` or
`~/Applications`.

If a user opens the app directly from the mounted DMG, Focus Pet shows a warning
asking them to drag the app into Applications first.

## Verification Checklist

For a distribution DMG:

```bash
scripts/verify-dmg-release.sh dist/FocusPet.dmg
hdiutil verify dist/FocusPet.dmg
xcrun stapler validate dist/FocusPet.dmg
spctl -a -t open --context context:primary-signature -vv dist/FocusPet.dmg
hdiutil attach -nobrowse -readonly dist/FocusPet.dmg
spctl -a -vv --type execute "/Volumes/Focus Pet Installer/Focus Pet.app"
open "/Volumes/Focus Pet Installer/Focus Pet.app"
```

After testing:

```bash
pkill -x FocusPet
hdiutil detach "/Volumes/Focus Pet Installer"
```

To simulate the downloaded-file path before uploading, test a quarantined copy:

```bash
cp dist/FocusPet.dmg /tmp/FocusPet-download-test.dmg
xattr -w com.apple.quarantine "0083;$(printf %x $(date +%s));Safari;" /tmp/FocusPet-download-test.dmg
hdiutil attach -nobrowse -readonly /tmp/FocusPet-download-test.dmg
spctl -a -vv --type execute "/Volumes/Focus Pet Installer/Focus Pet.app"
open "/Volumes/Focus Pet Installer/Focus Pet.app"
```

If macOS says the app is damaged, do not remove quarantine as a release fix.
Instead rebuild with distribution mode and inspect the failing `spctl`,
`codesign`, `stapler`, or notarytool gate.
