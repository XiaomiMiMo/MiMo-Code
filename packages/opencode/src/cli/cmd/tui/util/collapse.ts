// Collapsed tool blocks budget their height in RENDERED ROWS, not source lines:
// one line of JSON or a 4000-char rg hit wraps to dozens of terminal rows, which
// is exactly the flood the collapsed state exists to cap.
//
// Wrapped height is an estimate — every character counts as one cell, so CJK and
// emoji undercount. Good enough for a collapse budget.

export function lines(content: string) {
  if (!content) return []
  return content.replace(/\n$/, "").split("\n")
}

/** Usable text columns inside a BlockTool body (left border + padding). */
export function columns(width: number) {
  return Math.max(20, width - 3)
}

export function rows(content: string, cols: number) {
  return lines(content).reduce((total, line) => total + Math.max(1, Math.ceil(line.length / cols)), 0)
}

/** Head of `content` that fits in `budget` rows, with a "…" marker when cut. A
 * line straddling the budget is sliced mid-line so a single huge line still
 * shows its beginning instead of collapsing to nothing. */
export function clip(content: string, cols: number, budget: number) {
  const kept: string[] = []
  let used = 0
  for (const line of lines(content)) {
    if (used >= budget) return [...kept, "…"].join("\n")
    const height = Math.max(1, Math.ceil(line.length / cols))
    if (used + height <= budget) {
      kept.push(line)
      used += height
      continue
    }
    return [...kept, line.slice(0, (budget - used) * cols), "…"].join("\n")
  }
  return content
}
