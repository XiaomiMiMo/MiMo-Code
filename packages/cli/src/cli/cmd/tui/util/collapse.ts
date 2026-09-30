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

/** Usable text columns inside a BlockTool body. `ctx.width` (contentWidth) nets
 * out the sidebar and the conversation box padding; the remaining chrome is
 * exactly 6 — the transcript scrollbox's viewport paddingRight, the scrollbar's
 * paddingLeft and its always-reserved cell, plus the block's left border and
 * paddingLeft of 2. */
export function columns(width: number) {
  return Math.max(20, width - 6)
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

/** Head of `line` that fits in `cells` display columns. Walks GRAPHEME clusters,
 * not code points: Bun.stringWidth is not additive over code points — "❤️" is
 * U+2764 U+FE0F and measures 2 as a unit but 1 + 0 summed, so a per-code-point
 * walk under-charges emoji-presentation sequences and would overshoot the budget.
 * A cluster that would overflow is dropped whole, never split. */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function sliceToWidth(line: string, cells: number) {
  let used = 0
  let out = ""
  for (const { segment } of graphemes.segment(line)) {
    const w = width(segment)
    // A single cluster can be wider than the whole budget (stacked Hangul jamo
    // measure 4+). Keep the first one anyway — emitting nothing defeats the point
    // of slicing mid-line, and one cluster of overshoot is invisible next to the
    // word-wrap slack we already accept.
    if (used + w > cells) return out || segment
    used += w
    out += segment
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
