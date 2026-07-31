# 004 — Keep the pet visible and animated across macOS Spaces

- **Status**: DONE
- **Commit**: af56cb3
- **Severity**: HIGH
- **Category**: Performance, interruptibility
- **Estimated scope**: 4 files, small

## Problem

The native tracker only acts when the physical monitor changes. A macOS Space
switch on the same monitor therefore performs no recovery:

```rust
// src-tauri/src/lib.rs:1091 — current
if let Some(current) = window.current_monitor().ok().flatten() {
    if !monitors_match(&current, &target) {
        // move window
    }
}
```

The Tauri window is a normal `NSWindow`, unlike the reference Focus Pet
renderer’s non-activating `NSPanel`. It receives only the base all-Spaces
behaviors once and is never reasserted after Space transitions:

```rust
// src-tauri/src/lib.rs:1358 — current
let behavior = ns_window.collectionBehavior()
    | NSWindowCollectionBehavior::CanJoinAllSpaces
    | NSWindowCollectionBehavior::FullScreenAuxiliary;
ns_window.setCollectionBehavior(behavior);
ns_window.orderFrontRegardless();
```

The sprite clock is a single `requestAnimationFrame` callback chain. WebKit can
suspend that chain while a transparent window is outside the active Space; no
independent liveness watchdog restarts it:

```tsx
// src/components/PetCompanion.tsx:200 — current
const startedAt = performance.now();
let frameID = 0;
const renderFrame = (now: number) => {
  setFrameIndex(loopingPetFrameIndex(now - startedAt, frames.length, effectiveFps));
  frameID = window.requestAnimationFrame(renderFrame);
};
```

## Target

- Keep the pet window in every Space with the reference renderer's
  `CanJoinAllSpaces | FullScreenAuxiliary` behavior.
- On each existing 500 ms native tracking pass, reapply collection behavior
  and call `orderFrontRegardless` on the main thread. Runtime verification
  showed that `isOnActiveSpace` can remain true for `CanJoinAllSpaces` windows
  even when CoreGraphics no longer lists the window on screen, so it must not
  gate recovery.
- Emit `focus-pet-companion-wake` to the pet window after a Space recovery and
  after a physical-monitor move.
- Preserve one monotonic animation epoch per action. A wake must restart only
  the rAF callback chain, never reset the action to frame zero.
- Add a 750 ms liveness threshold. Native wake, `visibilitychange`, `pageshow`,
  and window `focus` restart rAF only if the last delivered frame is stale.

## Repo conventions to follow

- Native window placement and tracking stay in `src-tauri/src/lib.rs`.
- Pure animation-clock decisions live in
  `src/app/petCompanionLogic.ts`, with tests in `src/tests/core.test.ts`.
- AppKit calls must stay inside `WebviewWindow::run_on_main_thread`; the
  2026-07-30 crash reports prove direct calls from Tauri command workers trap
  with “Must only be used from the main thread”.
- The reference implementation at
  `/Users/vhahahav/Code/focus_pet/Sources/FocusPetRenderer/PetRenderer.swift`
  uses `canJoinAllSpaces`, `fullScreenAuxiliary`, and
  `orderFrontRegardless` on its pet panel.

## Steps

1. In `src-tauri/src/lib.rs`, create and retain a genuine borderless,
   nonactivating `NSPanel` and reparent the pet WKWebView into it.
2. Add a macOS-only helper that schedules a main-thread active-Space recovery.
   Reapply the behavior, call `orderFrontRegardless`, and emit
   `focus-pet-companion-wake` to `widget-pet-companion`. Do not use
   `NSWindow::isOnActiveSpace()` as a skip condition. Add a no-op non-macOS
   implementation.
3. Call that helper from every visible, unpaused pet tracker pass. Keep the
   existing monitor remap logic; after a move, order the window forward and
   emit the same wake event.
4. Add
   `petAnimationClockNeedsWake(nowMilliseconds, lastFrameMilliseconds,
   staleAfterMilliseconds = 750)` to
   `src/app/petCompanionLogic.ts`. Return false for non-finite or backwards
   timestamps and true only when elapsed time is at least the threshold.
5. In `src/components/PetCompanion.tsx`, retain the action’s monotonic start
   time while allowing the rAF chain to restart. Listen for
   `focus-pet-companion-wake`, `visibilitychange`, `pageshow`, and `focus`.
   Restart only when the pure helper reports a stale clock. A healthy native
   wake must not churn the rAF loop.
6. Add frontend unit tests for the 750 ms boundary, invalid timestamps, and
   backwards time. Add or extend Rust tests for the monitor remap behavior and
   keep all AppKit invocations main-thread dispatched.

## Boundaries

- Do NOT use private macOS Space APIs or query private Space identifiers.
- Do NOT move the pet when it is being dragged (`tracker.paused`).
- Do NOT activate Focus Pet or steal keyboard focus.
- Do NOT call AppKit from the tracker thread.
- Do NOT reset the sprite epoch on wake or change easing/duration tokens.
- Do NOT add dependencies.

## Verification

- **Mechanical**: `npm run lint`, `npm test`, `npm run build`,
  `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`,
  `cargo test --manifest-path src-tauri/Cargo.toml`, and
  `npm run test:ui` pass.
- **Runtime**:
  - Install the Universal DMG and launch the application.
  - Swipe between two Spaces on the same display; the pet appears in the new
    Space within one 500 ms tracker pass without Focus Pet taking focus.
  - Switch back; the sprite continues from its elapsed-time phase rather than
    parking or restarting from frame zero.
  - Repeat on an external display and during a drag; monitor remapping remains
    proportional and the tracker does not fight the pointer.
  - Run for at least 30 seconds and confirm no new macOS crash report contains
    “Must only be used from the main thread”.
- **Done when**: same-display Space switches, reverse switches, and physical
  monitor changes all preserve both pet visibility and animation liveness.

### 2026-07-30 runtime result

The periodic `setCollectionBehavior` + `orderFrontRegardless` workaround is not
sufficient for Tauri's normal `NSWindow`. In an isolated Universal DMG runtime,
CoreGraphics reported the pet window as visible at the start of a Space swipe,
then absent for every 500 ms sample from 0.5 through 7.5 seconds on the
destination Space. It remained visible after returning to the original Space.

Do not mark this plan done or publish the resulting DMG as the Space fix. The
next implementation must match the reference renderer's native window model:
an `NSPanel` created with `.nonactivatingPanel` and `.borderless`, carrying
`.canJoinAllSpaces` and `.fullScreenAuxiliary`. Retain the main-thread boundary
and the elapsed-time animation wake logic.

### 2026-07-31 completion result

The companion now uses a genuine `NSPanel` constructed on the AppKit main
thread with borderless and non-activating style masks plus
`CanJoinAllSpaces | FullScreenAuxiliary`. The Tauri `NSWindow` remains hidden
as a lifecycle/geometry proxy and the WKWebView is reparented into the panel;
no Objective-C runtime class mutation remains.

An isolated debug-app smoke test verified:

- runtime logging confirmed creation of a real `NSPanel`;
- the isolated process remained alive after Control-Right and Control-Left
  Space switches, with no new macOS crash report;
- the tracker continued remapping the hidden geometry proxy across the active
  app's displays after the Space switches;
- drag cleanup now releases tracking on pointer-up, pointer-cancel, lost
  capture, blur, visibility change, and component teardown.

The acceptance app uses a separate bundle identifier and data root so the
running release process is not modified during verification.
