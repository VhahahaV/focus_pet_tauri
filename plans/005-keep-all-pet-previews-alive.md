# 005 — Keep every pet preview animation alive

- **Status**: DONE
- **Commit**: af56cb3
- **Severity**: HIGH
- **Category**: Performance, interruptibility, cohesion
- **Estimated scope**: 3 frontend files, small

## Problem

The desktop companion now derives its sprite frame from monotonic elapsed time,
but the Today-page mini pet and Pet-settings preview still advance one frame per
`setInterval` callback. Delayed or coalesced callbacks lose elapsed animation
time, so these previews can appear stuck after the page or window was
backgrounded.

The Today preview also keys its animation by the transient intent UUID. The
resident runtime can publish the same visible state every five seconds with a
new intent object, resetting the preview to frame zero even though its pack and
source action did not change.

```tsx
// src/components/TodayTab.tsx:492 — current
key: `${selectedPet?.id ?? "fallback"}:${action?.id ?? "preview"}:${bundle.state.currentPetIntent.id}`,
```

```tsx
// src/components/TodayTab.tsx:508 — current
const timer = window.setInterval(() => {
  setMiniPetFrameIndex((index) => (index + 1) % miniPetAnimation.frames.length);
}, 1000 / miniPetAnimation.fps);
```

```tsx
// src/components/PetTab.tsx:92 — current
const timer = window.setInterval(() => {
  setFrameIndex((current) => (current + 1) % frames.length);
}, 1000 / previewFPS);
```

## Target

- Key a preview animation only by the pack ID, source-action ID, and actual
  frame-set signature. Do not include `PetIntent.id`.
- Derive every preview frame with
  `loopingPetFrameIndex(performance.now() - startedAt, frameCount, fps)`.
- Present visible preview frames through `requestAnimationFrame`; when a
  callback is delayed, the next callback skips to the correct phase.
- Reset the monotonic epoch only when the pack, source action, or frame-set
  signature actually changes.
- Keep all multi-frame previews looping indefinitely. A runtime state refresh
  with the same visible action must not restart them.
- Do not animate layout properties. Sprite changes remain image-source swaps;
  optional fallback breathing remains compositor-only `transform`.

## Repo conventions to follow

- The elapsed-time helper already lives in
  `src/app/petCompanionLogic.ts`:
  `loopingPetFrameIndex(elapsedMilliseconds, frameCount, fps)`.
- The desktop companion in `src/components/PetCompanion.tsx:109-134` keys its
  epoch only by pack and source action.
- The desktop companion in `src/components/PetCompanion.tsx:198-250` is the
  reference `requestAnimationFrame` implementation.
- On-screen constant frame progression is time-linear; no easing curve should
  be added to sprite indexing.

## Steps

1. In `src/components/TodayTab.tsx`, remove
   `bundle.state.currentPetIntent.id` from the preview key. Add a stable frame
   signature when needed so a changed frame set resets the epoch.
2. Replace the Today preview interval with a monotonic epoch ref and a
   `requestAnimationFrame` loop that calls `loopingPetFrameIndex`.
3. In `src/components/PetTab.tsx`, replace the settings-preview interval with
   the same monotonic rAF pattern. Key its epoch by pack ID, action ID, and
   frame signature.
4. In `src/tests/core.test.ts`, retain the existing boundary tests for
   `loopingPetFrameIndex` and add a regression assertion showing that two
   different intent UUIDs resolving to the same pack/action produce the same
   animation identity.
5. In the UI test, leave the Today page active through at least two native
   runtime update intervals and assert that the mini pet does not repeatedly
   return to frame zero.

## Boundaries

- Do NOT change the desktop companion drag, landing, wake, or native window
  implementation.
- Do NOT add an animation dependency.
- Do NOT change pet-pack files, source-action FPS metadata, or fabricate frames.
- Do NOT animate width, height, margin, padding, top, left, or window position.
- If the cited preview structure has drifted since commit `af56cb3`, stop and
  report the mismatch instead of improvising.

## Verification

- **Mechanical**: `npm test`, `npm run build`, `npm run lint`, and
  `npm run test:ui` pass.
- **Feel check**:
  - Keep Today visible for 30 seconds; the mini pet loops continuously without
    jumping to frame zero every five seconds.
  - Background and restore the window; both Today and Pet-settings previews
    resume at their elapsed phase instead of continuing from a stale index.
  - Switch to a different source action; only that real action change resets
    the preview epoch.
  - Emulate `prefers-reduced-motion` and confirm the preview follows the
    project’s chosen sprite-frame accessibility policy without positional
    breathing.
- **Done when**: every multi-frame pet surface uses elapsed-time looping, and
  equivalent native runtime snapshots cannot restart an unchanged animation.

### 2026-07-31 completion result

Today and Pet-settings previews now use `requestAnimationFrame` with
`loopingPetFrameIndex`. Their animation identity contains only pack ID,
source-action ID, and the concrete frame signature, so a new runtime intent
UUID cannot reset an unchanged visible action. Unit coverage locks the stable
identity and elapsed-time frame boundaries.
