# QA Rubric

Use this rubric for comprehensive design-to-implementation QA.

## Fidelity

- Layout: frame size, grid, alignment, content order, spatial grouping, card radius, elevation, borders.
- Spacing: page margins, section gaps, item gaps, padding, tap-target spacing, vertical rhythm, cramped text, collapsed sections, and density drift.
- Typography: font family, weight, size, line height, letter spacing, wrapping, truncation, hierarchy, text density, optical balance, and mismatched display/body treatment.
- Color: token mapping, contrast, brand palette, state colors, gradients, opacity, shadows.
- Imagery: all target image assets are accounted for and match subject accuracy, crop, aspect ratio, generated/real image quality, background treatment.
- Icons: all icons are accounted for and match stroke weight, size, style family, alignment, optical balance, state changes.
- Shape and surfaces: rounded cards, borders, dividers, shadows, fills, and container treatments match the target rather than generic component defaults.
- Responsiveness: elements do not overlap, collapse into adjacent sections, clip, wrap awkwardly, or break hierarchy across desktop, tablet, and mobile viewports.
- Implementation shortcuts: custom CSS art, inline SVG substitutes, placeholder avatars, decorative blobs, and fake product imagery are flagged when they drift from the target design.

## Mandatory Comparison Passes

Do not rely on generic "looks close" judgment. For each design QA pass, inspect and report on these areas:

### Core design and functionality

- Fonts and typography: identify mismatched font family/fallback, weight, scale, line height, letter spacing, antialiasing, text hierarchy, wrapping, truncation, display-vs-body optical treatment, cramped text, and places where text spacing makes the UI feel broken or harder to scan.
- Spacing and layout: compare frame/crop, alignment, margins, padding, gaps, component sizes, radii, elevation, borders, and vertical rhythm. Cite where spacing drift changes hierarchy, density, readability, or causes elements to collide.
- Viewport resilience: check desktop, tablet, and mobile widths for overlapping elements, clipped content, collapsing sections, broken grids, awkward wrapping, and controls that become unusable.
- Colors and tokens: compare palette, gradients, opacity, shadows, contrast, semantic status colors, disabled/active states, and whether implementation tokens map to design intent.
- Image quality and asset fidelity: check subject match, crop, scale, aspect ratio, sharpness, compression, transparency/masking artifacts, halos, background integration, and raster-vs-vector suitability. Div/CSS art or custom SVG art that replace images in the target design are banned.
- Copy and content: for any copy that is part of the app, not dynamic content, check that it is coherent, makes sense in the standalone context of the app, and is visually appealing.
- Icons: zoom in and analyze all visible icons and icons hidden behind controls/interactions to ensure they are fully implemented, aligned, and visually consistent.
- States and interactions: expand/collapse sidebars, tooltips, forms, hover, focus, active, selected, disabled, loading, success, error, empty states, and any interactive controls needed for a functional frontend.
- AI shortcut artifacts: flag generic rounded cards, unnecessary borders, decorative CSS blobs, fake SVG illustrations, half-built avatars, mismatched hero art, and custom CSS/SVG replacements where the target called for real imagery, real icons, or a different surface treatment.

### Accessibility

- Contrast, focus indicators, keyboard reachability, semantic controls, labels, alt text, reduced motion.
- Text scaling and zoom resilience.
- Tap targets at practical mobile sizes.
- Layout stability when text wraps, scales, or appears in longer real-world strings.

## Finding Quality

A useful finding includes:

- One specific mismatch or flaw.
- Design evidence and implementation evidence.
- User or fidelity impact.
- Concrete fix, ideally with file/component/token/CSS guidance.
- Severity based on user impact, not personal taste.
- The affected fidelity surface when relevant: fonts, spacing, colors, image quality, layout, behavior, accessibility, content, icons, or responsiveness.
- Crammed text, broken wrapping, mismatched font weights, bad line height, or awkward letter spacing when they affect readability or hierarchy.
- Elements that overlap, clip, collapse into nearby sections, or break at alternate viewport sizes.
- Rounded cards, borders, shadows, or container treatments that appear in the implementation but are not present in the target.
- Borked icons, custom SVGs, half-assed attempts at avatars, hero art mismatches, custom CSS art, and placeholder-looking generated assets.
- Overflowing text, cramped text, broken layout, missing states, and incomplete interactions.

Avoid:

- Vague statements such as "make it more polished."
- Criticizing known placeholder content unless it affects the design goal.
- Treating every pixel difference as a bug when the design intent is preserved.
- Mixing multiple unrelated flaws into one finding.
