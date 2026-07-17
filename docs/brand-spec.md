# Focus Pet visual specification

## Product character

Focus Pet is a quiet desktop focus companion. The interface should feel native,
calm, legible, and warm without becoming decorative. The pet is part of the
working experience, not a mascot added on top of a generic dashboard.

## Source assets

- App icon: `public/assets/AppIcon.png`
- Status icon: `public/assets/StatusIcon.png`
- Default pet previews: `public/assets/pet-pixel-cat.png`,
  `public/assets/pet-xiaodai.png`, `public/assets/pet-luo-xiaohei.png`
- Product references: `public/assets/focus-pet-today.png`,
  `public/assets/focus-pet-dashboard.png`,
  `public/assets/focus-pet-widgets.png`
- Native reference implementation: `../focus_pet/Sources/FocusPetMac`

## Design system

- Source of truth: `src/styles/tokens.css`, restored from
  `../focus_pet/Sources/FocusPetMac/DesignSystem/FPColor.swift`.
- Blue-white canvas: `#F8FBFF`, `#F3F7FC`, `#EEF4FA`
- Text: `#243447`, `#5E7188`, `#8A9AAF`
- Focus: `#5AA6F8`; rest: `#68BE8B`; distracted: `#F3B25B`
- Pet accent: `#D99A83`; away: `#9AA8B8`
- Typography: SF Pro through the native Apple system font stack
- Spacing: 4px base, primarily 8/12/16/24/32px
- Radius: 8px controls, 12/16px modules, 20px cards, 22px hero surfaces
- Elevation: layered translucent material with specular top rim, tinted
  bottom-right edge, and soft status-aware shadow
- Motion: 120-240ms, ease-out for state changes and module transitions

## Appearance theme architecture

- Persistent setting: `AppSettings.appearance.theme`; legacy snapshots without
  the field normalize to `neobrutalism`.
- Theme ID and normalization source: `src/core/theme.ts`.
- User-facing registry metadata: `src/themes/index.ts`.
- Shared component and layout CSS remains in `src/styles/*.css`; theme recipes
  are the final override layer in `src/styles/themes.css`.
- Components consume semantic tokens and state classes. They must not branch on
  a theme ID. Theme-specific rendering belongs in the recipe layer.
- Theme state is mirrored to the document and browser storage immediately, then
  persisted in the normal app snapshot. The main dashboard, menu-bar panel,
  status widgets, and pet companion receive the same theme.

### Installed themes

- `neobrutalism`: cream ground, saturated flat blocks, 2-3px black outlines,
  zero-blur offset shadows, and push-into-shadow controls.
- `mid-century-modern`: cream/oatmeal ground, walnut ink, mustard/avocado/
  burnt-orange/teal accents, organic decoration, and shadowless flat surfaces.
- `constructivism`: red/black slabs, newsprint ground, condensed grotesk type,
  hard black rules, clipped grayscale imagery, and reduced-motion-safe diagonal
  poster geometry.

### Adding another theme

1. Add the stable ID to `AppThemeID` and `appThemeIDs`.
2. Add one metadata record to `appThemes` for the Settings preview.
3. Add a token recipe and narrowly scoped material overrides to `themes.css`.
4. Extend the registry and end-to-end tests; no business component should need
   modification.

## Interaction principles

- One clear primary action per module.
- Show only the settings content the user is currently editing.
- Use semantic colors for status and data. Status-aware hero surfaces may use
  a restrained semantic wash and a 4px leading strip to reinforce state.
- Preserve stable dimensions for charts, controls, and desktop widgets.
- Prefer direct feedback beside the action over global status text.
