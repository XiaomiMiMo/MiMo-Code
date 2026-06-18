# Report: TUI Full Repaint After Interactive Command Resume

## Problem

After an interactive command (e.g. `git push` triggering `bun turbo typecheck` via pre-push hook), the MiMoCode TUI resumes with visual artifacts: cells that only contain background color show the terminal's native background (VSCode theme color) instead of the TUI's dark theme background.

## Root Cause

`renderer.resume()` in @opentui/core internally calls:

```js
this.currentRenderBuffer.clear(this.backgroundColor)
```

This sets `currentRenderBuffer` to the theme's background color (e.g., dark gray). On the next frame, the renderer diffs `nextRenderBuffer` against `currentRenderBuffer`. Background-only cells in `nextRenderBuffer` also contain the same theme background color. The diff sees them as identical → skips writing them to the terminal. But the physical terminal (alternate screen just re-entered) doesn't have that color — it has the terminal emulator's native background.

## Fix

After `renderer.resume()`, call `renderer.currentRenderBuffer.clear()` **without arguments** (clears to transparent/zeros). This creates a mismatch:

- `currentRenderBuffer`: transparent (RGBA 0,0,0,0)  
- `nextRenderBuffer`: theme background color (e.g., RGBA 30,30,30,255)

The diff now sees ALL cells as different → writes every cell → full repaint.

## Affected Call Sites (3)

1. `packages/opencode/src/cli/cmd/tui/app.tsx` — interactive bash handler (finally block)
2. `packages/opencode/src/cli/cmd/tui/app.tsx` — Ctrl+Z SIGCONT handler
3. `packages/opencode/src/cli/cmd/tui/util/editor.ts` — external editor resume

## Approaches Tried and Rejected

| Approach | Why it failed |
|----------|--------------|
| `process.stdout.write("\x1b[2J\x1b[H")` after resume | Clears screen but renderer still skips background cells in the diff — they appear briefly then go missing |
| `renderer.clearPaletteCache()` | Only clears color code lookup cache, doesn't force cell writes |
| `--ui stream` / `TURBO_UI=0` / `CI=1` on turbo | Not a turbo bug — stream mode output itself causes the issue by writing to the terminal during suspend |

## Verification

Tested with local build `0.0.0-local-202606181503`: interactive `bun typecheck` completes, TUI resumes with clean full repaint, no VSCode background bleeding through.
