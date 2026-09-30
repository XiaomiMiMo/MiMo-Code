---
name: image-to-code
description: "Implement a selected image, screenshot, mockup, generated concept, or design frame as a faithful, responsive, interactive frontend in the target codebase."
---

# Image to Code

Translate a selected visual target into a high-quality frontend. Read `../index/SKILL.md`, `../../references/critical-overrides.md`, and the relevant saved context from `../user-context/SKILL.md` before building.

## Preconditions

- Require an unambiguous selected image, screenshot, mockup, generated result, or design frame. A written brief alone is not a visual target; route to ideation first when appropriate.
- Resolve which image is selected before editing. Ask when an ordinal or attachment is ambiguous.
- Use only the current task's relevant product context, tokens, components, assets, and references.

## Workflow

1. Inspect the source visual at useful detail and record its viewport, layout regions, hierarchy, spacing, typography, colors, borders, radii, shadows, imagery, icons, responsive behavior, and visible states.
2. Inventory every required asset. Reuse supplied or repository assets when they match. Use an available image-generation tool for custom raster imagery and an appropriate existing icon set for UI icons. Do not substitute emoji, generic placeholders, or improvised CSS drawings for meaningful visual assets.
3. Inspect the target repository and use its existing framework, package manager, component system, design tokens, and conventions. React is not required. Do not replace an established stack merely to match this workflow.
4. If no target app exists, create the smallest runnable frontend supported by the harness and suited to the request; plain HTML/CSS/JavaScript is acceptable.
5. Implement the full visible structure and the primary user journey. Unless requested otherwise, make navigation, tabs, menus, forms, toggles, selections, and main calls to action behave realistically without inventing backend systems.
6. Match desktop or mobile based on the source. When the source is a phone UI and no device is named, verify around 390 × 844 as well as any relevant responsive behavior.
7. Run the real app using its normal development or preview command.
8. Capture the implementation using the browser tool selected by `../index/SKILL.md` and run `../design-qa/SKILL.md` against the source visual.
9. Fix all blocking and high-impact mismatches. Save `design-qa.md` in the project root and hand off only when it records `final result: passed`, or clearly report a genuine capture/verification blocker.

## Fidelity rules

- Treat the selected visual as the design target; do not introduce unrelated redesign ideas.
- Match the same viewport and interaction state during visual comparison.
- Place real assets before final QA and avoid hotlinking third-party source assets in the finished app.
- Keep the implementation maintainable within the target repository's patterns.
- Do not claim verification from build success or an HTTP status alone; inspect the rendered result and primary interactions.

## Handoff

Provide the runnable project or changed files, the local preview information when useful, and a concise summary of what was implemented, verified, and left as a limitation. Publish only when the user asks and the host exposes an authorized deployment tool.

