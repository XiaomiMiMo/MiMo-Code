// The editor (@opentui/core) tracks cursor/extmark positions as display-WIDTH
// offsets: a wide CJK character counts as 2 columns. The plainText we slice in
// JS is a UTF-16 string where that same character is 1 unit. These helpers
// translate between the two coordinate systems so the two never get mixed.
// Inputs are assumed to sit on character (code-point) boundaries, which is all
// the editor ever emits; an offset landing inside a wide char rounds up to the
// next boundary.

export function widthToStringIndex(text: string, widthOffset: number): number {
  let width = 0
  let index = 0
  for (const ch of text) {
    if (width >= widthOffset) break
    width += Bun.stringWidth(ch)
    index += ch.length
  }
  return index
}

export function stringIndexToWidth(text: string, stringIndex: number): number {
  return Bun.stringWidth(text.slice(0, stringIndex))
}

// The character immediately after a width-based cursor offset, or undefined at
// end of input. Used to decide whether an inserted mention needs a trailing space.
export function charAfterCursor(text: string, cursorWidth: number): string | undefined {
  return text.at(widthToStringIndex(text, cursorWidth))
}
