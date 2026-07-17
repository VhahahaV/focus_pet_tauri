# Frontend redesign validation — 2026-07-16

## Scope completed in this pass

- Restored the Swift `FPColor` palette as `src/styles/tokens.css` and updated
  `docs/brand-spec.md` to use it as the source of truth.
- Added shared base, glass-material, shell, screen, chart, and secondary-surface
  styles under `src/styles/`.
- Added status-aware UI primitives under `src/components/ui/`: glass/card
  surfaces, badges, primary/soft buttons, segmented controls, toggle pills,
  steppers, sliders, meters, metric tiles, and hover cards.
- Added plain-SVG chart primitives under `src/components/charts/`: filled pie,
  progress ring, aligned status timeline, input columns, hourly bars, heatmap,
  and `ChartFrame`, plus tested scale utilities. History now renders its heatmap
  and 24-hour activity chart as SVG.
- Adopted the primitives in the app shell, Today, History, Pet, Settings, and
  recent-rhythm widget surfaces. Restored the filled rhythm pie depth and
  callouts and removed the v2 donut regression.
- Added `scripts/verify-frontend-tokens.mjs` and wired it into platform
  verification. It validates all frontend CSS, rejects raw hex outside the
  token file, rejects legacy stylesheet reintroduction, and restricts
  `!important` to reduced-motion/transparency fallbacks. The companion
  `scripts/normalize-frontend-css.mjs` assigns every non-root selector to one
  style module, and verification rejects cross-module selector ownership.
- Deleted `src/App.css` and `src/design-v2.css`; `App.tsx` now imports one
  ordered design-system cascade under `src/styles/`.
- Added the dev/test-only `/__gallery` visual regression surface for all
  primitive statuses and chart families.
- Converted remaining dynamic layout values to inline CSS custom properties
  and moved their actual declarations into the relevant style modules.
- Removed the Today App activity lane, increased input-column prominence and
  minimum hit width, and moved the hour scale into its own unobstructed footer
  row. The time range remains in the metric row rather than being duplicated
  over the plot.
- Replaced Pet and Settings secondary left rails with horizontal resource and
  module layouts, removed the sidebar status card, and removed the redundant
  workspace title/status header from every primary page.
- Rebuilt the desktop companion as a shadowless transparent sprite with a
  compact icon-only hover strip and debounced drag persistence.
- Removed the full-history deep clone from the runtime sampling path and added
  an immutability regression test.

## Automated evidence

- `npm run verify:frontend-tokens`: pass
- `npm test`: 33 tests pass (29 core + 4 design-system/scale)
- `npm run lint`: pass with no warnings
- `npm run build`: pass
- `npm run test:ui`: 12/12 pass across desktop and narrow viewport projects
- `npm run verify:platform`: pass, including 33 Vitest tests, 12 Playwright
  cases, 20 Rust tests, `cargo check`, and release Tauri app/DMG bundling

## Visual evidence

Browser and native screenshots were captured and reviewed during implementation
but were intentionally removed with the temporary validation output instead of
being retained as repository history. The final review confirmed the compact
Today timeline, aligned weekly heatmap, right-side History insight panel,
expanded hourly plot, horizontal Pet/Settings layouts, and transparent desktop
companion.

## Native desktop check

`npm run verify:platform` built and signed the release bundle at
`src-tauri/target/release/bundle/macos/Focus Pet.app` and the DMG successfully.
To prevent LaunchServices from resolving the already installed Swift app with
the same product name, an ephemeral uniquely identified copy of the final
release bundle was ad-hoc signed and opened for validation. That temporary app
was removed after review.

Computer Use then opened the native Tauri window and switched through all four
primary pages. An isolated temporary HOME was used for the final navigation
pass so an off-screen widget from existing user preferences could not be
mistaken for the main window; existing Focus Pet data and settings were not
modified. The native window was inspected at 1180×820. Review confirmed that
Today has no redundant workspace header, its input bars remain readable,
History insights sit beside the heatmap, and the desktop pet is transparent at
rest with a compact icon toolbar. This completes the native sign-off.

## Acceptance refinement — 2026-07-17

- Today's two summary cards are 156 px tall at desktop width. The recovery
  selector and action share a compact aligned row, leaving the activity window
  above the fold.
- Every input bucket now contains a green pointer segment and a purple keyboard
  segment. Each channel is normalized against its own maximum before the two
  segments are stacked, so neither input type hides the other.
- The weekly heatmap is capped at 440 px and the History insight panel stretches
  to the same bottom baseline as the chart and legend.
- Today and History share one native application-icon loader with cached,
  error-safe fallback behavior. Native History QA confirmed Edge, Cursor, and
  WeChat icons instead of the former category initials.
- Pet resources remain a horizontal shelf; action mapping, display behavior,
  and position/appearance are page-level full-width rows. All Settings modules
  use the same full-width reading rhythm.
- The desktop companion hover toolbar contains only dashboard, rest, change
  action, and pet settings, with larger hit targets.

The final automated pass completed 33 Vitest tests, 12 Playwright cases,
linting, frontend token verification, 20 Rust tests, and release `.app`/`.dmg`
bundling. The native release was then cold-started after terminating the prior
resident process. Computer Use screenshots verified Today and History at the
real Tauri window size, including dual-color input bars, native icons, compact
summary cards, and the aligned weekly heatmap/insight baseline.
