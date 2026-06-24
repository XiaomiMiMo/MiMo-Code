// The editor (@opentui/core) tracks cursor/extmark positions as display-WIDTH
// offsets: a wide CJK character counts as 2 columns. The plainText we slice in
// JS is a UTF-16 string where that same character is 1 unit. These helpers
// translate between the two coordinate systems so the two never get mixed.

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
