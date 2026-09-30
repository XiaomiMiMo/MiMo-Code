// The editor (@opentui/core) tracks cursor/extmark positions as display-WIDTH
// offsets: a wide CJK character counts as 2 columns. The plainText we slice in
// JS is a UTF-16 string where that same character is 1 unit. These helpers
// translate between the two coordinate systems so the two never get mixed.
// Inputs are assumed to sit on character (code-point) boundaries, which is all
// the editor ever emits; an offset landing inside a wide char rounds up to the
// next boundary.

// The editor advances its offset by 1 for a newline and 2 for a tab, but
// Bun.stringWidth returns 0 for both, so we special-case them to stay aligned
// with the editor. (Pasted "\r" never reaches here — paste input is normalized
// to "\n" and the editor itself maps "\r" to "\n".)
function charWidth(ch: string): number {
  if (ch === "\n") return 1
  if (ch === "\t") return 2
  return Bun.stringWidth(ch)
}

export function widthToStringIndex(text: string, widthOffset: number): number {
  let width = 0
  let index = 0
  for (const ch of text) {
    if (width >= widthOffset) break
    width += charWidth(ch)
    index += ch.length
  }
  return index
}

export function stringIndexToWidth(text: string, stringIndex: number): number {
  let width = 0
  let index = 0
  for (const ch of text) {
    if (index >= stringIndex) break
    width += charWidth(ch)
    index += ch.length
  }
  return width
}

// The character immediately after a width-based cursor offset, or undefined at
// end of input. Used to decide whether an inserted mention needs a trailing space.
export function charAfterCursor(text: string, cursorWidth: number): string | undefined {
  return text.at(widthToStringIndex(text, cursorWidth))
}

// Find the display-width position of the end of the token starting at `startWidth`.
// A token ends at the next whitespace character or end of text.
export function tokenEndWidth(text: string, startWidth: number): number {
  const startIdx = widthToStringIndex(text, startWidth)
  let endIdx = startIdx
  while (endIdx < text.length && !/\s/.test(text[endIdx]!)) endIdx++
  return stringIndexToWidth(text, endIdx)
}
