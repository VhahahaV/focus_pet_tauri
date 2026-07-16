# Focus Pet Tauri — Frontend Redesign & Migration Recovery Plan

> Status: implemented and native-reviewed on 2026-07-16.
> Scope: React components, CSS, secondary webview windows, and the narrowly
> related runtime/window changes required for companion performance.
> Baseline evidence: original app reference shots
> (`public/assets/focus-pet-today.png`, `focus-pet-dashboard.png`,
> `focus-pet-widgets.png`), Swift design system
> (`../focus_pet/Sources/FocusPetMac/DesignSystem/*`), current stylesheets
> (`src/App.css`, `src/design-v2.css`).

---

## 1. Diagnosis — why the frontend does not feel like the original

The migration moved every *feature* across (the product-equivalence audit is
honest about that), but the *visual product* regressed. The gap is not one
missing screen; it is five systemic problems that affect every screen at once.

### 1.1 Two design systems are fighting in the same app

`src/App.tsx` imports **both** stylesheets, in this order:

```tsx
import "./App.css";        // 5,668 lines — "v1", a faithful port of FPColor/FPLayout
import "./design-v2.css";  // 1,901 lines — "v2", an override sheet that redefines the same tokens
```

- `App.css` `:root` reproduces the Swift palette exactly (`--focus-500:
  #5aa6f8`, `--radius-card: 20px`, blue-tinted backgrounds `#f8fbff → #eef4fa`,
  soft deep shadows). This matches `FPColor.swift` value-for-value.
- `design-v2.css` `:root` **redefines the same custom properties** with a
  different, desaturated palette (`--focus-500: #4f8fdf`, `--radius-card:
  14px`, grey backgrounds `#f7f8fa → #edf1f4`, tighter/flatter shadows), and
  then overrides hundreds of v1 selectors by cascade order.

Consequences:

- Every v1 rule that uses a token silently changes meaning; every v1 rule that
  uses a **hardcoded hex** (there are ~200 hardcoded colors in `App.css`, e.g.
  `#5aa6f8`, `#de7f69`, `#4fad85`) keeps the *old* palette. The result is a UI
  where chips, chart fills, and text accents come from one palette and cards,
  borders, and backgrounds come from another. This is the diffuse "something is
  off" quality the current build has.
- v2 actively **deletes migrated fidelity**. Concrete examples in
  `src/design-v2.css`:
  - `.rhythm-pie-depth { display: none; }` — removes the pie's depth layer that
    was ported from Swift `RhythmFilledPieChart`.
  - `.rhythm-pie-callout { display: none; }` — removes the multi-slice callouts.
  - `.rhythm-pie-face::after { inset: 25%; background: #fff; }` — punches a
    hole in the filled pie, regressing it to the flat donut the migration notes
    say was replaced.
  The migration doc claims "窗口节奏卡已对齐 Swift RhythmFilledPieChart"; the
  v2 layer un-did that alignment after the check was recorded.

### 1.2 The color theme drifted away from the product's character

Side-by-side of the semantic palette:

| Token | Swift original (`FPColor`) | `App.css` (v1) | `design-v2.css` (wins today) |
|---|---|---|---|
| focus 500 | `#5AA6F8` (bright sky blue) | `#5aa6f8` ✓ | `#4F8FDF` (duller, greyer) |
| focus 600 | `#2F7EDB` | `#2f7edb` ✓ | `#397AC8` |
| distracted 500 | `#F3B25B` (**warm amber**) | `#f3b25b` ✓ | `#D87964` (**terracotta red**) |
| rest 500 | `#68BE8B` (fresh green) | `#68be8b` ✓ | `#55AA7B` (darker, muddier) |
| app background | `#F8FBFF/#F3F7FC/#EEF4FA` (blue-white) | ✓ same | `#F7F8FA/#F4F6F8/#EDF1F4` (neutral grey) |
| card radius | 20 (hero 22) | 20 ✓ | 14 |
| text primary | `#243447` (blue-ink) | ✓ same | `#202A36` |

Two of these are not "toning down", they are **semantic changes**:

- *Distracted* changed hue family from amber (a gentle "drifting" warning) to
  terracotta/red (an error color). The original deliberately reserved red for
  errors only (`FPColor.error #E16A6A`). Today "走神" reads as "failure".
- The blue-tinted canvas is what made the original feel airy and "sky-like"
  (the sidebar even has a decorative `HeaderSkyMark` with clouds). The neutral
  grey canvas plus lower radii makes the current build read as a generic admin
  dashboard.

`docs/brand-spec.md` codifies the v2 palette, so this drift was a *decision*,
but the user-visible verdict is in: the v2 look does not meet expectations.
This plan treats the **original Swift palette as the source of truth** and
demotes `brand-spec.md` to be rewritten accordingly (see §3.1).

### 1.3 The material/depth system was never ported

The original's signature look comes from `FPGlassLayer.swift` (425 lines): every
card, button, badge, and stage sits on a layered "liquid glass" material —
base gradient + `ultraThinMaterial` blur + tint overlay + specular gradient +
rim stroke + inner top-left highlight + tinted bottom-right edge + soft tinted
shadow, with role presets (`data / control / badge / button / hero / stage /
menu`) and selected/pressed states. Semantic hero cards
(`FPSemanticCardModifier`) add a status-tinted gradient wash and a 4px capsule
strip.

The React build has: flat `#fff` cards with 1px borders and one box-shadow.
The only survivors are the 4px `.semantic-strip` on two Today cards and some
`backdrop-filter` on hover bubbles. Nothing else has tint, specular, rim, or
per-status tinting. This single omission accounts for most of the perceived
"cheapness" — same information, no material.

### 1.4 There is no real component layer

`src/components/common.tsx` exports 7 generic primitives (Panel,
SectionHeader, IconButton, CommandButton, StateBadge, DurationMetric,
EmptyState). The Swift app had ~20 *status-aware* design-system components.
Everything else in the React build is ad-hoc JSX + ad-hoc CSS classes per tab
(`.today-chip`, `.break-ring`, `.minute-selector`, `.history-card`…), which is
why the same concept looks different on every screen:

- Segmented pickers: Swift `SlidingSegmentedPicker` (animated sliding thumb) →
  today four different CSS implementations (Today time-window pills, Settings
  full-width segments, Pet position row, widget range picker), none animated,
  each with different heights/paddings.
- Steppers: Swift `NumberStepperControl` → hand-rolled per settings row.
- Toggles: Swift `TogglePillButton` (colored check, tinted fill when on) →
  Pet tab renders plain outline buttons where **on and off states are nearly
  indistinguishable** (see `design-v2-final-pet.png`: "显示桌宠" off vs "动画"
  on differ only by a faint blue border).
- Sliders: Swift `ControlSliderRow` (tinted track, value bubble) → **unstyled
  native `<input type="range">`** in `PetTab.tsx:397,402` — the stark black
  webkit slider visibly clashes with everything around it.
- Meters: Swift `MiniMeter`/`CompactMeter` → three different bar
  implementations across Today/History/widgets.

### 1.5 Charts are div-only and hit their ceiling

There is **zero `<svg>`/`<canvas>`** in `src/`. All charts are stacked divs +
`conic-gradient`. That was enough to pass functional Playwright checks, but it
caps fidelity:

- No smooth arcs with per-slice strokes/callout leader lines (rhythm pie).
- No line/band chart at all — Swift `StatusLineChart` + `TimelineStateBands`
  (the smoothed status curve) simply has no equivalent.
- Hourly bars, heatmap cells, and timeline tracks can't share one axis/grid
  system (`ChartGridLines` in Swift), so alignment between tracks is
  approximate.
- Hover targets are the divs themselves; precise time-position hover (Swift
  `TimelineHoverBubble` follows the cursor along the time axis) is coarse.

### 1.6 Smaller compounding issues

- `index.css` hardcodes `html { background: #f3f7fc; }` outside the token
  system.
- 22 `style={{…}}` inline styles across Today/Sessions/Widget bypass the
  stylesheet entirely.
- No dark mode anywhere (`color-scheme: light` forced). The original was also
  light-only, so this is *not* a migration gap, but the token rebuild in §3
  should at least leave the door open.
- Good news worth preserving: the current build has genuinely better
  accessibility plumbing than the original (`aria-current`, `role="status"`,
  `aria-live`, `prefers-reduced-motion/contrast/transparency` blocks,
  `:focus-visible` rings). Keep all of it through the redesign.

---

## 2. Strategy decisions

### 2.1 Component choice: keep hand-rolled React + CSS, add a real primitive layer. No heavy UI library.

Rationale:

- The target look is a bespoke macOS-native glass aesthetic. Any styled
  library (MUI, Ant, Mantine, shadcn default theme) fights it; you'd override
  90% of every component.
- Bundle discipline matters for three always-on webviews (widgets + pet).
  Current UI deps are just `lucide-react` — that is a strength.
- What's missing is not a library, it's *our own* primitives. Port the Swift
  design system 1:1 into `src/components/ui/` (see §4).
- Optional, allowed: **Radix UI headless primitives** (`@radix-ui/react-slider`,
  `react-switch`, `react-tabs`) *only* where native behavior is hard
  (slider drag + keyboard, roving tab index). They ship unstyled, so they don't
  fight the skin. If adopted, wrap them inside our `ui/` components so the rest
  of the app never imports Radix directly. If not adopted, styling the native
  `<input type="range">` with `::-webkit-slider-thumb` is acceptable — the app
  only ships on WebKit (macOS) and WebView2 (Windows, Chromium) and GTK
  WebKit (Linux), all of which support the webkit pseudo-elements.

### 2.2 Charts: hand-rolled SVG components, no chart library

Recharts/visx/d3 are overkill and bloat the widget windows. Everything the
original renders is geometrically simple (arcs, bars, rounded rects, one
smoothed line). Build a small `src/components/charts/` family (§4.3) on plain
SVG. Keep pure-CSS bars only where they already look right (MiniMeter rows).

### 2.3 Theme: restore the original Swift palette as the single source of truth

- One token file generated from `FPColor.swift` values (§3.1). Kill the v2
  palette. Rewrite `docs/brand-spec.md` to document the restored palette so
  docs and code agree.
- Keep light-only for this phase (parity with original), but express every
  color as a token so a dark theme later is a token-file swap, not a rewrite.

### 2.4 CSS architecture: one cascade, no override sheet

Target layout (all imported once from `App.tsx`, in order):

```
src/styles/tokens.css        // :root custom properties only (colors, radii, spacing, type, motion, shadows)
src/styles/base.css          // reset, html/body, focus-visible, selection, a11y media queries
src/styles/primitives.css    // .fp-card, .fp-glass, .fp-badge, .fp-button, .fp-segment, … (matches ui/ components)
src/styles/shell.css         // sidebar, header, toast, install notice
src/styles/today.css
src/styles/history.css
src/styles/pet.css
src/styles/settings.css
src/styles/widgets.css       // widget windows + menu bar panel + pet companion
```

Migration rule: **move, don't layer.** A selector may exist in exactly one
file. `design-v2.css` is deleted at the end of Phase 1; `App.css` shrinks to
zero and is deleted at the end of Phase 4. No `!important` except inside
`prefers-*` a11y blocks. All ~200 hardcoded hexes must become tokens —
enforce with a CI grep (`scripts/verify-frontend-tokens.mjs`, fails on
`#[0-9a-f]{3,8}` outside `tokens.css`).

---

## 3. The restored design system (specification)

### 3.1 Color tokens (`src/styles/tokens.css`) — values from `FPColor.swift`

```css
:root {
  /* canvas */
  --app-bg-top: #f8fbff; --app-bg-mid: #f3f7fc; --app-bg-bottom: #eef4fa;
  --sidebar-top: #f2f7fc; --sidebar-bottom: #eaf1f8;
  /* surfaces */
  --card: #ffffff; --card-soft: #fbfdff; --card-hover: #f6fafe;
  --inset-surface: #f4f8fc; --control-surface: #f7fafd;
  /* strokes */
  --border-default: #dce7f2; --border-soft: #e7eef6;
  --border-strong: #c9daec; --divider: #eaf0f6;
  /* ink */
  --text-primary: #243447; --text-secondary: #5e7188;
  --text-tertiary: #8a9aaf; --text-disabled: #b4c0cf;
  /* semantic ramps — 050/100/200/300/400/500/600 like FPColor */
  --focus-600: #2f7edb; --focus-500: #5aa6f8; --focus-400: #7bb9fa;
  --focus-300: #a8d2fd; --focus-200: #d8ecff; --focus-100: #eef7ff; --focus-050: #f5faff;
  --distracted-600: #c98422; --distracted-500: #f3b25b; --distracted-400: #f6c27b;
  --distracted-300: #f9d6a8; --distracted-200: #fdebd3; --distracted-100: #fff6ea; --distracted-050: #fffaf2;
  --rest-600: #3d9964; --rest-500: #68be8b; --rest-400: #85cda1;
  --rest-300: #b6e2c4; --rest-200: #ddf4e5; --rest-100: #f2fbf5; --rest-050: #f7fcf9;
  --away-500: #9aa8b8; --away-300: #cbd5e1; --away-100: #f1f5f9;
  --pet-500: #d99a83; --pet-300: #f1c9b9; --pet-100: #fff3ed;
  --cyan-500: #58bdd2; --cyan-300: #a9e0ea; --cyan-100: #effbfd;
  --success: #63b985; --success-bg: #eaf8f0;
  --warning: #e0a64f; --warning-bg: #fff5e5;
  --error: #e16a6a;   --error-bg: #fdeeee;
  --selection: #eaf5ff;
  /* charts (FPChartPalette) */
  --chart-kbd: #9b7cf6; --chart-kbd-strong: #7756d9;
  --chart-pointer: #45b7a8; --chart-pointer-strong: #268e82;
  --chart-switch: #8a7baf; --chart-input-track: #f0ecff;
  --chart-grid: #ecf2f8; --chart-neutral-track: #eaf1f7; --chart-empty: #e7eef6;
}
```

Semantic status mapping (from `FPStatus.swift`) must be expressed once as a
CSS class contract used by *all* status-aware primitives:
`.is-focus / .is-distracted / .is-rest / .is-away / .is-pet / .is-privacy /
.is-warning / .is-error / .is-neutral`, each setting
`--status-primary / --status-strong / --status-soft / --status-border`
locally. Components then style themselves off those four locals. This replaces
today's scattered `state-focus`-style one-off classes.

### 3.2 Shape, spacing, elevation, type, motion

| Group | Tokens |
|---|---|
| Radius (`FPRadius`) | small 8, medium 12, large 16, **card 20, hero 22**, pill 999 |
| Spacing (`FPSpacing`) | 4 / 8 / 12 / 16 / 20 / 24 / 32 |
| Sizes (`FPSize`) | sidebar 240, nav item 50, button 40, small button 32, badge 28, row 56, icon box 34 |
| Shadows | card: `0 8px 18px rgba(0,0,0,.022)` + tint per status for semantic cards (`status 6% 22px 12y`); restore v1 soft depth, not v2 flat |
| Type (`FPTypography`) | window 24/600 · page 22/600 · hero 30/600 · **hero metric 34/600 rounded** (`font-family: ui-rounded, "SF Pro Rounded", -apple-system` + `font-variant-numeric: tabular-nums`) · section 16/600 · card title 15/600 · body 14 · caption 12 · small 11 |
| Motion | 120ms press / 150ms fast / 200ms ui / 240ms module; `--ease-out: cubic-bezier(0.23,1,0.32,1)`; press scale 0.985 (keep current) — merge with `plans/001-unify-motion-and-feedback.md` |

### 3.3 The glass material (`.fp-glass`) — port of `FPGlassLayer`

One CSS recipe + a `GlassSurface` React wrapper with `role` and `status`
props. Implementation sketch (all values derived from `FPGlassLayer.swift`):

```css
.fp-glass {
  position: relative; overflow: hidden;
  background:
    linear-gradient(135deg, rgb(255 255 255 / .66), rgb(255 255 255 / .38)),   /* base */
    linear-gradient(135deg, var(--status-soft, var(--focus-100)) 0%, transparent 62%); /* tint */
  backdrop-filter: blur(18px) saturate(1.25);
  border: 1px solid var(--status-border, var(--border-default));
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / .55),                       /* specular top */
    inset -1px -1px 0 color-mix(in srgb, var(--status-primary, var(--focus-500)) 14%, transparent), /* tinted bottom-right rim */
    0 8px 22px color-mix(in srgb, var(--status-primary, var(--focus-500)) 8%, rgb(30 43 58 / .05));
}
.fp-glass[data-role="badge"]   { backdrop-filter: blur(10px); }
.fp-glass[data-role="stage"]   { backdrop-filter: blur(24px) saturate(1.4); }
.fp-glass[data-role="menu"]    { background: rgb(255 255 255 / .78); }
.fp-glass[data-selected="true"]{ /* raise tint + border strength */ }
```

Skip the animated `FPLiquidGlassSweep` initially (Swift-only nicety); add it
later as a `@keyframes` gradient sweep gated behind
`prefers-reduced-motion: no-preference` if desired. The `prefers-reduced-transparency`
block must swap `.fp-glass` to opaque `var(--card)` (pattern already exists —
keep it).

---

## 4. Component inventory to build (`src/components/ui/`, `src/components/charts/`)

Each maps 1:1 to a Swift source so fidelity is checkable.

### 4.1 Surfaces

| New component | Swift source | Notes |
|---|---|---|
| `Card` | `FPCardModifier` | radius 20, glass `role="data"`, border, soft shadow; replaces `.panel`/`.history-card`/ad-hoc cards |
| `SemanticCard` | `FPSemanticCardModifier` | hero radius 22, status gradient wash (soft→transparent 135°), 4px capsule strip inset 8/16, tinted shadow; used by Today hero + break card, History insight header, Pet stage |
| `InsetCard` | `FPInsetCardModifier` | radius 16, `card-soft` 30% fill, selectable (status tint when selected); used by pack grid cells, settings rows, widget tiles |
| `GlassSurface` | `FPGlassLayer` | the `.fp-glass` wrapper with `role`/`status`/`selected` props |

### 4.2 Controls

| New component | Swift source | Key behaviors to replicate |
|---|---|---|
| `SegmentedControl<T>` | `SlidingSegmentedPicker` | single sliding thumb animated 200ms ease-out (one absolutely-positioned thumb, `transform: translateX`), roving arrow-key focus, `aria-pressed`/radiogroup semantics. Replaces ALL four current segmented implementations (Today windows, Settings ranges, Pet positions, Widget 4h/8h/12h) |
| `Stepper` | `NumberStepperControl` | label + tabular-nums value + −/+ 28px round buttons, disabled at bounds, press-and-hold repeat |
| `TogglePill` | `TogglePillButton` | ON = status soft fill + colored check icon + status border; OFF = neutral surface + hollow icon. The on/off difference must be obvious at a glance (fixes Pet tab) |
| `SliderRow` | `ControlSliderRow` | label · tinted track (filled portion `--status-primary`, rest `--chart-neutral-track`) · 18px white thumb with border+shadow · right-aligned value chip. Style webkit pseudo-elements or wrap Radix Slider |
| `Badge` | `FPBadge` | capsule, 28px (compact 22px), optional icon, status tinted glass; replaces `.today-chip`, `.workspace-state`, timeline metric pills, session stat pills |
| `PrimaryButton` / `SoftButton` | `FPPrimaryButtonStyle` / `FPSoftButtonStyle` | 40px / 32px, status-tinted glass fill, press scale; `CommandButton` variants fold into these |
| `MetricTile`, `RatioTile` | `MetricTile`, `RatioTile` | icon box 34px in status-100 rounded square + value + caption; used by History stat row, widget tiles |
| `MiniMeter` | `MiniMeter` | keep the current div implementation, but tokenize colors and unify Today/History/widget usages into one component |
| `HoverCard` | `TimelineHoverBubble`/`AttentionHeatmapHoverCard` | one shared floating detail bubble (glass, 12px radius, caret), used by timeline, heatmap, hourly chart |

### 4.3 Charts (`src/components/charts/`, plain SVG)

| New component | Swift source | Notes |
|---|---|---|
| `FilledPieChart` | `RhythmFilledPieChart` + `PieSliceShape` + `RhythmPieCallout` | true filled pie (no hole), depth ellipse below (restore the layer v2 hid), inline primary-state label on the biggest slice, leader-line callouts when ≥2 slices ≥8%; SVG `path` arcs, 300ms sweep-in |
| `StatusTimeline` | `StateSegmentStrip` + `StatusStripSnapshot` | keep div track but render segments as SVG rects on a shared time scale so App/state/input tracks align to the same axis |
| `InputColumns` | `InputTimelineChart` | keyboard (violet `--chart-kbd`) + pointer (teal `--chart-pointer`) stacked columns, switch markers; shared `TimeScale` util with `StatusTimeline` |
| `HourlyBars` | `ActivityHourlyBarChart` | 24 grouped bars, grid lines `--chart-grid`, hover card |
| `Heatmap` | `WeeklyAttentionHeatmap` / `MonthlyAttentionHeatmap` | rounded-rect cells, 9-step focus-blue duration scale, stability hue overlay (高/稳/波动/偏离), hover card |
| `ProgressRing` | `BreakRecoveryRing` | 48px stroke ring for break countdown (currently a coarse conic div) |
| `ChartFrame` | `ChartGridLines` | shared axis/grid/tick rendering + `TimeScale` helper so every chart shares alignment |

---

## 5. Screen-by-screen changes

Reference source: original `public/assets/focus-pet-*.png`; temporary current
captures were reviewed during implementation and then removed.

### 5.1 App shell & sidebar (`AppShell.tsx`, `shell.css`)

Current problems: grey canvas; sidebar nav items are plain icon+text rows;
selected state is a flat white card; icons drawn at 23px with no container;
header state badge is a thin outline pill.

Changes:

1. Restore the tri-stop blue canvas gradient (`--app-bg-top → bottom`,
   135°) on `.app-stage`, and the vertical `--sidebar-top → bottom` gradient
   with `border-right: 1px solid var(--border-default)`.
2. Rebuild nav items to `FPSidebarItem` spec: 50px height, radius 16; a
   **36×36 radius-12 icon tile** (`--focus-100` fill + `--focus-600` icon when
   selected; `card-soft`/`--text-tertiary` when idle); label 16px
   (semibold when selected); selected row gets `card-soft` fill +
   `--focus-200` border + **4×26px capsule accent** on the leading edge.
   Keep the current two-line label (title + description) — it's an
   improvement over the original; render the description at 11px
   `--text-tertiary`.
3. Sidebar width 240px (`FPSize.sidebarWidth`; currently 228/188 responsive —
   keep the responsive tiers, raise the base).
4. Keep the pet dock (good v2 addition, the original had a plain pet anchor),
   but reskin: bubble becomes `InsetCard` with `--pet-100` tint; stat chips
   become compact `Badge status="focus|distracted"`; the two action buttons
   become `SoftButton`.
5. Header: page kicker 12px `--text-tertiary` над 22px title (already right);
   replace `.workspace-state` with `Badge` (status-tinted glass, colored dot);
   refresh button becomes `IconButton` on glass. Add the original's
   `HeaderSkyMark`-style decorative element only if cheap (static SVG, hidden
   under `prefers-reduced-transparency`).
6. Toast (`.workspace-toast`) and install notice: move onto `GlassSurface
   role="menu"`, status-tinted border-left 3px.

### 5.2 Today (`TodayTab.tsx`, `today.css`)

The closest screen already; fix fidelity details:

1. **Hero "今日态势" card → `SemanticCard status={currentState}`**: status
   gradient wash + capsule strip + tinted shadow (today it's a white card with
   a bare strip). Title 30/600; metric 34/600 rounded tabular; the metric block
   right-aligned as in the original. Bottom chips → `Badge` (state chip gets
   status colors; app/switch/keyboard chips neutral-glass with lucide icons).
2. **Break card → `SemanticCard status="rest"`**: minute selector becomes
   `SegmentedControl` (1m/5m/10m/30m); the ring icon becomes `ProgressRing`;
   "开始恢复" becomes `PrimaryButton status="rest"` full-width with trailing
   arrow. During a break, swap selector→progress exactly as now (logic is
   already correct; only the skin changes).
3. **Activity window card**: window picker (2h…24h) → `SegmentedControl`;
   metric pills → compact `Badge`; rebuild the three tracks on
   `StatusTimeline` + `InputColumns` over one `ChartFrame` so 状态/App/输入
   rows share the exact same time axis and hour ticks; hover uses the shared
   `HoverCard` following the cursor time position.
4. **窗口节奏 card**: replace the donut with `FilledPieChart` (depth layer +
   inline label + callouts restored). Legend rows become compact `Badge`s.
5. **时间去哪了 card**: keep ranked `MiniMeter` rows (already faithful);
   tokenize sub-segment colors (focus/distracted/rest/away must come from the
   restored ramps); category icon gets the 34px `--focus-100`-tinted icon box;
   add the original's category-correction affordance (right-click / kebab menu
   per row → `AppCategoryCorrectionMenu` equivalent) if it exists in runtime
   actions — it does (`recognition exceptions`), it's just not reachable from
   this card today.
6. Grid: keep `today-top-grid` 2-col (hero + break, break column
   312–382px per `FPLayout`), then activity full-width, then insights grid
   `2fr 1fr`. Set consistent 16px gaps (currently mixed 12/14/16).

### 5.3 History (`SessionsTab.tsx`, `history.css`)

1. **Heatmap** → `Heatmap` SVG: cells radius 4, duration → 9-step blue scale,
   the 高/稳/波动/偏离 stability legend colored via status ramps; week/month
   toggle → `SegmentedControl`; month view keeps per-month focus totals.
   Fix the empty-state: current all-grey grid with one colored cell looks
   broken — when a week has no data, render cells at `--chart-empty` with a
   subtle inner border and show an `EmptyState` line under the card.
2. **历史洞察 panel**: currently text overflows its meter (82% bar clips the
   "专注占比" row). Rebuild rows as `AttentionInsightRow`: label+value line,
   then full-width `MiniMeter` under it; percentages right-aligned
   tabular-nums; wrap the whole panel in `InsetCard`.
3. **活跃统计 stat row** → four `MetricTile`s (icon box + value + caption),
   range picker (3/7/15/30/60天) → `SegmentedControl`, "跳过周末" →
   `TogglePill`.
4. **全天每小时活跃** → `HourlyBars` with grid lines + `HoverCard`; legend
   dots use chart tokens.
5. **日均应用活跃** list → same row component as Today's 时间去哪了
   (one `AppUsageRow`, two contexts).
6. Restore the **rest control panel** (`RestControlPanel`) presence on this
   tab if runtime exposes it here in the original; otherwise leave to Today.

### 5.4 Pet (`PetTab.tsx`, `pet.css`) — weakest screen, biggest rebuild

Compare `focus-pet-dashboard.png` (original pet settings) with
`design-v2-final-pet.png`: the original is a dense, warm, pack-centric page;
the current page is sparse outline-buttons on white.

1. **Pack grid** → `InsetCard` cells matching `PetPackSelectionCard`: 56px
   thumbnail on `--pet-100` stage, name + source caption, radio dot right,
   selected = `--pet-300` border + tint. Import/refresh live in the card
   header as `SoftButton`s (already positioned there — keep).
2. **Selected pack summary strip** under the grid: preview + name + "可用"
   `Badge status="rest"` + author/action/audio counts caption
   (`PetPackSummaryView` port).
3. **意图映射台 (`SourceActionStageCard`)** — restore prominence: full-width
   stage on `GlassSurface role="stage"` with the subtle spotlight
   (`PetPreviewStageBackdrop` gradient is enough; skip `StageLightBeam`),
   animated frame preview at native pixel scale (`image-rendering: pixelated`),
   corner captions (action name left, fps right), "已映射" pill top-right.
   Intent chips (安静陪伴/专注休息提示/走神观察/温和提醒/强提醒/休息陪伴/休息结束/暂离睡觉)
   → `Badge` row with per-intent status colors as in the original; source
   action chips (default/sleep/left_walk/…) → selectable compact `Badge`s
   with a play glyph.
4. **Display toggles** (显示桌宠/动画/音效/悬浮状态弹窗) → `TogglePill` with
   colored check (this alone fixes the "which ones are on?" confusion).
   Random-action block: interval options → `SegmentedControl`; the block
   itself sits in an `InsetCard status="pet"` tinted when enabled.
5. **Position picker** (右下角/左下角/右上角/左上角/Dock 附近/自定义) →
   `SegmentedControl` sized to content (not six equal-width stretched cells).
6. **大小 / 透明度** → `SliderRow status="pet"` with value chips (`113px`,
   `92%`) — kills the unstyled native ranges.
7. Empty state (no packs): keep the dashed drop-zone, add the pet mascot
   illustration (reuse `pet-pixel-cat.png` at low opacity) and a
   `PrimaryButton status="pet"` "导入资源包" — currently it's a bare dashed
   box with duplicated helper text ("暂无桌宠资源包" appears twice + a toast).
8. Kill the floating bottom-right toast duplication on this tab (§5.1 toast
   handles it).

### 5.5 Settings (`SettingsTab.tsx`, `settings.css`)

Structure (accordion nav + detail) matches the original's
`SettingsAccordionCard` intent — keep it. Fix the skin and density:

1. Left module nav → `InsetCard` list items with 34px icon boxes tinted per
   module status (桌面状态卡=focus, 提醒=warning, 识别=cyan, 权限=privacy/cyan,
   数据=neutral, 关于=neutral); selected = tint + border like Swift accordion
   headers.
2. Right detail column currently floats on the page background with huge
   whitespace below → wrap detail in a `Card`, cap content width ~640px,
   let the card hug content height.
3. Replace controls: 最近节奏范围 + 位置模式 → `SegmentedControl` (content
   width, not full-bleed 100%); 当前状态卡/最近节奏卡 visibility →
   `TogglePill`; 全部显示/全部隐藏 → `SoftButton` pair; every numeric
   threshold (识别阈值/提醒/暂停时长) → `Stepper`; permission rows →
   `PermissionSettingsRow` port: icon box + name + status `Badge`
   (已授权=rest / 需要授权=warning) + trailing `SoftButton` (刷新/打开设置).
4. Danger zone (清空数据) gets `--error` treatment: `SoftButton` variant
   danger inside an `InsetCard` with `--error-bg` tint and explicit copy.
5. Diagnostics/log rows → definition-list rows (56px `FPRow` style) inside
   `InsetCard`s, monospace value chips for paths.

### 5.6 Desktop widgets (`WidgetView.tsx`, `widgets.css`)

Original concept (`focus-pet-widgets.png`): translucent glass slabs floating
on the wallpaper, white text on dark blur, big rounded corners.

1. Both cards go `GlassSurface role="stage"` with radius 22 and
   `background: transparent` html/body (already plumbed via
   `data-focus-pet-surface="widget"` — keep). Text: keep dark-ink on light
   glass (WebKit `backdrop-filter` over arbitrary wallpapers with white text
   risks contrast; the original WidgetKit look can be approximated with a
   brighter glass instead). Verify contrast on light and dark wallpapers.
2. **当前状态 card**: state word 24/700 in status color + "已稳定 N分"
   caption; keyboard/mouse chips → compact `Badge`s; bottom 专/走/休 durations
   → tricolor compact `Badge` row (original layout), not the current tinted
   sub-card.
3. **最近节奏 card**: range picker → mini `SegmentedControl`; donut →
   `FilledPieChart` small variant with center % (the original widget used a
   ring — acceptable to keep ring here, it's the dashboard pie that must be
   filled); the four duration tiles → `MetricTile` compact on `InsetCard`;
   bottom distribution strip → `StatusTimeline` mini.
4. Unify paddings to 16 and gaps to 8/12; both widgets share
   `widget-card` primitives, no bespoke styles per widget.

### 5.7 Menu bar panel (`MenuBarView.tsx`)

Already close to the original `MenuBarContentView`. Remaining:

1. Panel surface → `GlassSurface role="menu"` radius 16 with `MenuGlassDivider`
   equivalents (1px `--divider` with 8px insets).
2. Status header: stability badge ("稳") should use the status ramp of the
   *current state*, not always focus-blue; percentage right-aligned
   tabular-nums.
3. Action grid buttons → `SoftButton` with 18px lucide icons in 26px icon
   boxes; hover = `--card-hover`; the two-column grid and grouping
   (打开面板/设置 · 桌面状态卡/休息 · 暂停提醒/隐藏桌宠) is faithful — keep.
4. Footer: 提醒开启 left (caption + bell), 退出 right in `--error` — keep, but
   align to 16px padding grid.

### 5.8 Floating pet companion (`PetCompanion.tsx`)

The latest native QA pass deliberately moves away from a persistent glass
card. The companion must read as a clean transparent sprite at rest:

1. Pet sprite: enforce `image-rendering: pixelated`, remove native window
   shadow, and keep only a small sprite drop-shadow.
2. Hover UI: one compact 210px status/tool strip. Focus, distraction,
   keyboard, and pointer use icons plus short values; actions are icon-only
   with accessible labels/tooltips.
3. Dragging: the sprite is a drag handle, not an implicit dashboard button.
   Persist position once, 220ms after native movement stops, so dragging does
   not trigger settings writes and widget resynchronization for every pixel.
4. Runtime bubbles are suppressed in the desktop window; temporary manual
   feedback may use a small opaque capsule without a glass tail.

---

## 6. Execution roadmap

Each phase is shippable and independently verifiable. Run
`npm run test:ui` + fresh Playwright screenshots after each phase and compare
against `public/assets/focus-pet-*.png` references.

### Phase 0 — Decision lock (0.5 day)
- [x] Confirm palette restoration (this doc §3.1) and rewrite
      `docs/brand-spec.md` to match (single source of truth).
- [x] Decide Radix-headless vs styled-native for Slider/Switch/Tabs (§2.1).
      Default recommendation: styled-native first, Radix only if keyboard/drag
      behavior proves fiddly.

### Phase 1 — Token & cascade consolidation (1–2 days)
- [x] Create `src/styles/tokens.css` (§3.1–3.2) + `base.css` (move a11y
      blocks from design-v2.css verbatim).
- [x] Delete the `:root` blocks from `App.css` and `design-v2.css`; point both
      at the new tokens; fix the ~200 hardcoded hexes in `App.css` to tokens
      (mechanical; grep-driven).
- [x] Remove the v2 fidelity-deletion rules (`.rhythm-pie-depth/callout
      display:none`, donut hole) — the Swift-faithful v1 pie returns
      immediately.
- [x] Add `scripts/verify-frontend-tokens.mjs` (fail CI on raw hex outside
      tokens.css) and wire into `verify:migration` or `verify:platform`.
- Exit check: app renders with restored palette everywhere; both legacy
  stylesheets are deleted; Playwright suite green.

### Phase 2 — UI primitives (2–3 days)
- [x] Build `ui/` components + `primitives.css` (§4.1–4.2):
      GlassSurface, Card, SemanticCard, InsetCard, Badge, PrimaryButton,
      SoftButton, SegmentedControl, TogglePill, Stepper, SliderRow,
      MetricTile, MiniMeter, HoverCard.
- [x] Vitest: SegmentedControl keyboard nav, Stepper bounds, TogglePill aria.
- [x] Storybook-lite: a hidden `/__gallery` route (dev-only) rendering all
      primitives in all statuses for eyeball QA — cheap and catches drift.
- Exit check: gallery screenshot reviewed against Swift design-system values.

### Phase 3 — Charts (2–3 days)
- [x] `charts/`: ChartFrame + TimeScale, FilledPieChart, StatusTimeline,
      InputColumns, HourlyBars, Heatmap, ProgressRing (§4.3).
- [x] Port hover interactions to shared `HoverCard`.
- [x] Vitest for scale math (time→x, duration→color step); Playwright hover
      checks stay green (selectors: keep existing class names on new SVG
      containers to minimize test churn).

### Phase 4 — Screen rebuilds (4–6 days, one PR per screen)
Order by impact: **Pet → Settings → History → Today → Shell/sidebar**
(Pet and Settings are furthest from target; Today is closest so it goes late
with least risk).
- [x] Each screen: adopt primitives, move styles into its `styles/*.css`
      file, delete the corresponding blocks from `App.css`/`design-v2.css`.
- [x] After the last screen: `App.css` and `design-v2.css` must be empty —
      delete both, plus `index.css` hardcoded background.
- Exit check per screen: side-by-side screenshot vs original reference;
  functional Playwright suite green; no `style={{…}}` left except dynamic
  values (widths/percentages), which should become CSS custom properties set
  inline (`style={{ "--value": … }}` pattern already used by the pie — keep
  that pattern).

### Phase 5 — Secondary surfaces (1–2 days)
- [x] Widgets, menu bar panel, pet companion per §5.6–5.8 on the same
      primitives (`widgets.css`).
- [x] Contrast pass for widget glass over light/dark wallpapers.

### Phase 6 — Motion & final polish (1 day)
- [x] Execute `plans/001-unify-motion-and-feedback.md` on top of the new
      primitives (it predates them; reconcile durations with §3.2).
- [ ] Optional: liquid-glass sweep on hero cards, sidebar sky mark.
- [x] Full `npm run verify:platform` + updated browser screenshots committed to
      `docs/validation/frontend-redesign-<date>.md` with before/after pairs.

Native sign-off was repeated on 2026-07-16 with a uniquely identified,
ad-hoc-signed copy of the fresh release bundle. The final direction pass:

- removes the workspace title/status header from every page while preserving
  only the macOS titlebar safety inset;
- keeps Today input bars narrow and readable and uses extracted native app
  icons in usage lists;
- places History insights beside the weekly heatmap, aligns dates directly
  over cells, compacts month panels, and expands the hourly plot vertically;
- replaces Pet and Settings secondary left rails with horizontal/resource
  layouts;
- removes the sidebar status/pet card;
- turns the desktop pet into a transparent sprite with an icon-only compact
  hover strip and debounced landing persistence;
- reduces the heavy runtime sampling cadence from 5s to 10s and replaces the
  full-history `structuredClone` on every sample with targeted immutable
  copies of only the collections that are actually mutated.

The native captures were reviewed during the QA session and then removed with
the temporary validation bundles instead of being retained as repository
history. `npm run verify:platform` is green for the Vitest, Playwright, Rust,
and release `.app`/`.dmg` packaging checks.

Total: ~11–17 working days of focused frontend work.

## 7. Risks & guardrails

- **Playwright churn**: tests select on class names (`.today-app-meter-fill`,
  `.rhythm-pie-face`…). Keep legacy class names as aliases on the new
  components during Phases 3–4, remove aliases in Phase 6.
- **Widget perf**: three always-on webviews; `backdrop-filter` is the main
  cost. Budget: no continuous animations in widgets; glass only on the root
  card; test CPU on battery.
- **Cross-platform glass**: `backdrop-filter` works on WebKit/WebView2 but can
  be weak on Linux WebKitGTK — the `prefers-reduced-transparency` opaque
  fallback doubles as the Linux degradation path; verify during the existing
  Task 3 (Linux validation) pass.
- **Scope creep**: no new features in this effort. Anything discovered missing
  functionally goes to `docs/migration-status-and-plan.md`, not here.
