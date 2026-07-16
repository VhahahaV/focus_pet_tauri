# 001 — Unify motion and interaction feedback

- **Status**: DONE
- **Commit**: unavailable (workspace is not a Git repository)
- **Severity**: HIGH
- **Category**: Easing, physicality, accessibility, cohesion
- **Estimated scope**: 8 frontend files, medium

## Problem

The app has multiple motion dialects and some interactions conflict with the
desired physical feel.

```css
/* src/design-v2.css:60 — current */
button {
  transition:
    color 150ms ease,
    background-color 150ms ease,
    border-color 150ms ease,
    box-shadow 150ms ease,
    transform 100ms ease;
}

button:active:not(:disabled) {
  transform: translateY(1px);
}
```

```css
/* src/design-v2.css:407 — current */
.workspace-toast {
  animation: workspace-toast-in 180ms ease-out both;
}
```

```css
/* src/design-v2.css:1080 — current */
.settings-content-body {
  padding: 14px;
  animation: settings-content-in 180ms ease-out both;
}
```

```css
/* src/design-v2.css:1218 — current */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

## Target

- Define `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`,
  `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)`, and
  `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)` once.
- Pressable controls use `transform: scale(0.97)` with a 120–160ms strong
  ease-out. High-frequency navigation does not translate or bounce.
- Dynamic toast entry uses transitions plus `@starting-style`, not keyframes.
- Settings module changes do not translate; use at most a short opacity bridge.
- Animate only `transform` and `opacity` for movement. Progress changes that
  need motion use `scaleX()` rather than animated `width`.
- Reduced-motion drops position/scale movement while retaining short opacity,
  color, border, and background feedback.
- Hover-only motion is gated by
  `@media (hover: hover) and (pointer: fine)`.

## Repo conventions to follow

- Final visual tokens and overrides live in `src/design-v2.css`.
- Semantic state classes remain `state-focus`, `state-distracted`,
  `state-break`, and `state-away`.
- Keep the existing Apple system font stack and 4px spacing rhythm from
  `docs/brand-spec.md`.

## Steps

1. Add the three motion curves and short duration tokens to
   `src/design-v2.css`.
2. Replace global button translation with `scale(0.97)` press feedback and
   explicit transition properties.
3. Keep sidebar/settings navigation crisp: color/background/border feedback,
   no entrance, bounce, or positional animation.
4. Replace the workspace toast keyframe with a 180ms opacity/transform
   transition and `@starting-style` from `opacity: 0` and
   `translateY(100%) scale(0.97)`.
5. Remove the settings content keyframe and keep a maximum 120ms opacity
   bridge.
6. Update reduced-motion styles to preserve non-vestibular feedback and remove
   movement only.
7. Add `aria-pressed` to every segmented/toggle control whose state is
   currently exposed only through the `.active` class.

## Boundaries

- Do NOT add a motion dependency.
- Do NOT animate core dashboard navigation or data charts for decoration.
- Do NOT change business logic, persisted settings, or native contracts.
- Preserve the existing component names and end-to-end test labels.

## Verification

- **Mechanical**: `npm run build`, `npm test`, `npm run lint`, and
  `npm run test:ui` all pass.
- **Feel check**:
  - Press any primary, segmented, or icon button; feedback begins immediately
    and settles without a bounce.
  - Rapidly switch settings modules; content never restarts from a displaced
    position.
  - Trigger a status toast; it enters from its own bottom edge and does not
    appear from `scale(0)`.
  - Emulate `prefers-reduced-motion: reduce`; movement disappears while
    opacity/color/selection feedback remains.
  - In the Animations panel at 10% speed, confirm every moved surface uses
    transform/opacity and stays below 300ms.
- **Done when**: motion tokens are shared, all active-state controls expose
  accessible state, and no review standard is blocking.
