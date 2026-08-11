---
feature: tui-quiet-mode
status: delivered
updated: 2026-08-05
branch: feature/tui-quiet-mode
commits: 91dc9d14c263d76f7e843eaf6cce3f112ee1ddda..0af69913
---

# TUI Quiet Mode

## Report

**What was built** — Added a persisted `minimal` / `vivid` visual mode with `vivid` as the default. The command palette and `/vivid` share one localized toggle. Minimal mode removes the default celestial background and uses stable progress markers; vivid mode preserves the existing presentation. The separate animation preference stops high-frequency stars, meteors, Logo motion, and spinners without disabling low-frequency functional updates.

Logo, star field, prompt, task, workflow, and agent states share the same `vivid && animations_enabled` motion contract. Runtime preference changes clean up and restart eligible timers without requiring a TUI restart.

**Verification** — `bun test test/cli/tui/visual-mode.test.ts` passed 4 tests; `bun test test/cli/tui test/cli/cmd/tui` passed 266 tests and 728 assertions; bundled skill tests passed 8 tests and 41 assertions; `bun typecheck` passed; `git diff --check` passed. Isolated development TUI runs confirmed the vivid default, concise localized `/vivid` and `ctrl+p` state/action labels, detailed two-line ON/OFF toasts, switching through both entry points, and KV persistence.

**Journey log**

- Kept home tip rotation because it is a low-frequency functional update, not decorative high-frequency motion.
- Split visual style from animation accessibility so either presentation can use the independent animation override.
- A targeted review found and closed an idle Logo timer outside the home route.
- Kept `/vivid` and `ctrl+p` on one command entry so state, persistence, and feedback cannot diverge.
- Kept command rows concise by combining current state and next action in one title, while reserving detailed visual-effect explanations for the toast.

## [S1] Problem

The current vivid presentation redraws the home screen for stars, meteors, and logo sweeps and uses elaborate animated progress indicators. The persisted "Disable animations" option only stops some shared spinners, so it cannot represent a quiet default visual style or reliably stop high-frequency cosmetic refreshes.

## [S2] Design

Add an independent KV-backed `visual_mode` preference with `minimal` and `vivid` values. It is switched by the same command from the command palette or `/vivid`, persists across launches, and defaults to `vivid`. A concise command title and completion toast distinguish the enabled and disabled states in every existing TUI-specific locale dictionary; locales without a TUI dictionary use the standard English fallback, matching `/voice`. The existing `animations_enabled` preference remains a separate accessibility and performance override.

In `minimal` mode:

- The default home background is empty: no star field and no meteors. A user-selected static background image remains visible.
- The home logo does not start automatic sweep or interaction animation timers.
- Prompt busy state uses a compact static status bar derived from the original opencode-style indicator, with no UFO glyph or timer.
- In-progress tasks, workflows, and agents use stable status glyphs rather than spinners.

In `vivid` mode, current visuals remain available. When animations are also disabled, vivid visuals become static: the star field may remain, but twinkling, meteors, logo motion, and animated progress indicators stop. Low-frequency functional updates such as home tip rotation and retry countdowns remain active in every combination. Streaming message updates and streaming-only telemetry may continue to redraw while model output is arriving.

The implementation must use the existing theme colors, dimensions, and layout; this is an existing-codebase motion change, not a new visual language.

## [S3] Out of Scope

- Adding a CLI startup flag, a `tui.json` setting, or changing the default value of the existing animation preference.
- Disabling bounded interaction feedback, home tip rotation, retry behavior, autocomplete polling, or other functional timers.
- Redesigning the home layout, logo artwork, theme, or sidebar structure.

## Tasks

- [x] T1: Add the persisted visual mode command — acceptance: the command palette and `/vivid` map to the same toggle, show localized enabled/disabled state, persist the choice, and an unset value resolves to `vivid` (covers: S2)
- [x] T2: Apply visual and animation preferences to passive home motion — acceptance: minimal mode has no default celestial background or logo motion; vivid mode preserves current visuals; disabling animations leaves vivid visuals static and preserves functional tip rotation (covers: S2; depends: T1)
- [x] T3: Stabilize every in-progress indicator — acceptance: prompt, task, workflow, and agent running states render fixed-width static markers unless both vivid mode and animations are enabled (covers: S2; depends: T1)
- [x] T4: Add focused regression coverage and verify TUI behavior — acceptance: tests cover preference resolution and relevant package tests and typecheck pass (covers: S2; depends: T1, T2, T3)
- [x] T5: Document visual mode controls — acceptance: English and Chinese READMEs and the bundled `mimocode-docs` skill describe `/vivid`, the command palette setting, the default, and the independent animation override (covers: S2; depends: T1)
