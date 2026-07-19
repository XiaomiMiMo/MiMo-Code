---
name: url-to-code
description: "Recreate an authorized live website or app URL as a faithful, runnable, frontend-only local implementation."
---

# URL to Code

Use this workflow only when the user asks to clone or faithfully recreate a live site they own or have permission to reproduce. For redesign, improvement, or a loosely inspired result, route through `../index/SKILL.md` to context and ideation instead.

Read `../index/SKILL.md`, `../../references/critical-overrides.md`, and relevant saved context before building.

## Workflow

1. Remind the user that they must have permission and follow the target site's terms.
2. Open the source with the browser selected by the index. Stop if it resolves to a wrong page, login wall, error, unrelated redirect, or other surface that cannot ground the requested clone.
3. Capture the full desktop page and a representative mobile viewport. Inspect small scroll increments so sticky, lazy-loaded, and animated content is not missed.
4. Inspect the DOM and visible behavior for text, links, controls, component states, images, icons, fonts, colors, spacing, dimensions, breakpoints, and interaction behavior.
5. Test important interactions one at a time and return to the starting state between tests. Preserve evidence for changed states.
6. Save permitted source assets locally. Do not hotlink them in the final result. When an asset cannot be obtained, use an available generation tool or an appropriate open replacement and disclose the substitution.
7. Inspect the target repository and use its existing framework and conventions. React is not required. If no app exists, create the smallest suitable frontend supported by the harness; plain HTML/CSS/JavaScript is acceptable.
8. Build only from captured evidence. Implement the visible desktop/mobile layouts and primary interactions without inventing unrelated design choices or backend behavior.
9. Run and inspect the local implementation with a real browser. Compare the same viewport and states against the source.
10. Run `../design-qa/SKILL.md`, save `design-qa.md`, fix blocking and high-impact mismatches, and hand off only after `final result: passed` or a clearly documented verification blocker.

## Hard rules

- Capture source evidence before scaffolding or editing.
- Do not infer hidden states when source evidence is available.
- Do not use screenshots alone when DOM/style/interaction evidence can be inspected.
- Do not leave placeholder assets or improvised icon glyphs in the final implementation.
- Build success and server health are not visual verification.
- Publish only when the user asks and the host exposes an authorized deployment tool.

