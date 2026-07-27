// Collapsed tool blocks budget their height in RENDERED ROWS, not source lines:
// one line of JSON or a 4000-char rg hit wraps to dozens of terminal rows, which
// is exactly the flood the collapsed state exists to cap.
//
// Height is still an ESTIMATE, and it undercounts: the renderer word-wraps
// (@opentui TextBufferRenderable defaults to wrapMode "word"), so a row breaks
// early at a space and the leftover spills into an extra row. The budget is
// therefore an approximate ceiling, not a hard bound — see the follow-up note in
// docs/compose/spec/exec-tool-view.md.

export function lines(content: string) {
  if (!content) return []
  return content.replace(/\n$/, "").split("\n")
}

/** Usable text columns inside a BlockTool body (left border + padding). */
export function columns(width: number) {
  return Math.max(20, width - 3)
}

/** Display cells of a single line. Bun.stringWidth reports 0 for a tab, but the
 * renderer still draws a cell for it, so tabs are charged 1 (the real tab stop
 * is unknown; the prompt editor charges 2 to match @opentui's editor offsets,
 * which is a different coordinate system — see component/prompt/offset.ts). */
function width(text: string) {
  return Bun.stringWidth(text) + (text.match(/\t/g)?.length ?? 0)
}

function height(line: string, cols: number) {
  return Math.max(1, Math.ceil(width(line) / cols))
}

export function rows(content: string, cols: number) {
  return lines(content).reduce((total, line) => total + height(line, cols), 0)
}

/** Head of `line` that fits in `cells` display columns. Walks code points so a
 * wide character is never split in half; stops before one that would overflow.
 * A multi-code-point grapheme (ZWJ emoji) is over-charged here, which only makes
 * the slice shorter — never taller than the budget. */
function sliceToWidth(line: string, cells: number) {
  let used = 0
  let out = ""
  for (const char of line) {
    const w = width(char)
    if (used + w > cells) return out
    used += w
    out += char
  }
  return out
}

/** Head of `content` that fits in `budget` rows, with a "…" marker when cut. A
 * line straddling the budget is sliced mid-line so a single huge line still
 * shows its beginning instead of collapsing to nothing. */
export function clip(content: string, cols: number, budget: number) {
  const kept: string[] = []
  let used = 0
  for (const line of lines(content)) {
    if (used >= budget) return [...kept, "…"].join("\n")
    const rendered = height(line, cols)
    if (used + rendered <= budget) {
      kept.push(line)
      used += rendered
      continue
    }
    return [...kept, sliceToWidth(line, (budget - used) * cols), "…"].join("\n")
  }
  return content
}
