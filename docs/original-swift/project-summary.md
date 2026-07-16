# Focus Pet MVP Architecture Summary

## Product Shape

Focus Pet is a local macOS desktop pet for productivity tracking. The app uses frontmost app metadata, window title classification, input idle time, app switch frequency, and explicit focus or break sessions.

The product state model has exactly four states:

- `focus`
- `distracted`
- `break`
- `away`

The state priority is `away > break > focus > distracted`.

## Target Split

- `FocusPetCore`: state model, activity snapshots, classifier, state engine, time tracker, session models, nudges, privacy policy, retention policy, summary builder.
- `FocusPetStorage`: clean MVP JSON store and export/delete helpers.
- `FocusPetResources`: pet pack manifest parsing, validation, bundled catalog, and action fallback.
- `FocusPetRenderer`: desktop pet panel, bubble text, and pet drawing.
- `FocusPetMac`: SwiftUI app, menu bar, local monitors, state loop, five dashboard tabs.

## Local Data

New MVP data is stored under `Application Support/FocusPetMVP`.

Files:

- `schema.json`
- `settings.json`
- `classification-rules.json`
- `state-segments.json`
- `app-usage.json`
- `focus-sessions.json`
- `break-sessions.json`
- `nudges.json`

The MVP schema starts fresh. Older local runtime data is not imported.

## Validation

Required commands:

```bash
swift build
swift run FocusPetCoreChecks
./scripts/package-macos-app.sh
```
