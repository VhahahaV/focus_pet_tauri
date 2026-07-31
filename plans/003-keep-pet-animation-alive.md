# 003 — Keep the desktop pet animation alive

- **Status**: DONE
- **Commit**: af56cb3
- **Severity**: HIGH
- **Category**: Performance, interruptibility
- **Estimated scope**: 7 frontend files, small

## Problem

The desktop companion advances one frame per timer callback. When the WebView
coalesces or delays timers, elapsed animation time is lost and the pet can look
stuck. Drag completion also publishes a short-lived physical intent, but the
main runtime only expires it on the ten-second activity sampling tick.

```tsx
// src/components/PetCompanion.tsx:198 — current
useEffect(() => {
  if (!settings.animationEnabled || frames.length <= 1) return undefined;
  const timer = window.setInterval(() => {
    setFrameIndex((index) => nextPetFrameIndex(index, frames.length, true, true));
  }, frameDelay);
  return () => window.clearInterval(timer);
}, [frameDelay, frames.length, settings.animationEnabled]);
```

```tsx
// src/app/useFocusPetApp.ts:866 — current
useEffect(() => {
  if (!ready) return undefined;
  void tick();
  const interval = window.setInterval(() => {
    void tick();
  }, 10000);
  return () => window.clearInterval(interval);
}, [ready, tick]);
```

## Target

- Derive the displayed frame from monotonic elapsed time so delayed callbacks
  skip forward to the correct frame instead of losing animation progress.
- Use `requestAnimationFrame` for visible-window frame presentation.
- Loop every multi-frame companion action, including drag and landing.
- Retire an expired physical interaction intent independently of the ten-second
  activity sampler.
- Normalize legacy persisted `animationEnabled: false` values to `true` and
  remove the obsolete desktop-pet animation toggle.
- Give single-frame fallback art a subtle compositor-only breathing transform
  so the companion never appears dead when a pack lacks an action.

## Repo conventions to follow

- Pure pet animation helpers live in `src/app/petCompanionLogic.ts`.
- Companion rendering remains in `src/components/PetCompanion.tsx`.
- Persisted setting migrations live in `src/core/settings.ts`.
- Motion uses only `transform` and `opacity`; on-screen breathing uses
  `cubic-bezier(0.77, 0, 0.175, 1)`.

## Steps

1. Add a pure elapsed-time looping frame-index helper and unit tests.
2. Replace the interval frame clock with a monotonic `requestAnimationFrame`
   loop that resets only when the actual action or frame set changes.
3. Add an explicit physical-intent expiry timer after landing.
4. Force normalized desktop-pet animation on and remove the animation toggle.
5. Add a subtle infinite breathing transform to the pet image and disable that
   displacement under `prefers-reduced-motion`.

## Boundaries

- Do NOT change pet-pack files or fabricate missing action frames.
- Do NOT add an animation dependency.
- Do NOT animate layout, window coordinates, width, height, or margins.
- Preserve drag hit testing, native window movement, and action mappings.

## Verification

- **Mechanical**: `npm test`, `npm run build`, `npm run lint`, and
  `npm run test:ui` pass.
- **Completed 2026-07-30**: all mechanical checks passed; the elapsed-time
  frame helper, landing-intent expiry, always-on setting migration, and
  reduced-motion fallback are covered by automated tests.
- **Feel check**:
  - Drag and release the selected four-frame pet; landing loops and promptly
    returns to the state action without waiting for the activity sampler.
  - Leave the desktop pet unfocused for one minute; its frame animation remains
    live and resumes at the correct phase after a screen-space switch.
  - Select a single-frame preview pack; subtle breathing remains visible.
  - Emulate `prefers-reduced-motion: reduce`; positional breathing is removed,
    while sprite-frame state feedback remains available.
- **Done when**: no multi-frame action parks on its final frame and no expired
  drag intent can hold a static landing pose until the next ten-second tick.
