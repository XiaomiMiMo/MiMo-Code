import { stringIndexToWidth, widthToStringIndex } from "./offset"

export type TriggerKind = "@" | "$" | "/"

// Decide whether an autocomplete popup should open for the current input.
//
// `value` is the editor plainText (UTF-16) and `cursorWidth` is the editor's
// display-width cursor offset (CJK = 2 columns). We convert the cursor to a
// UTF-16 index before doing any string work, then report the trigger position
// back in width coordinates so it matches the editor's extmark/cursor space.
export function detectTrigger(value: string, cursorWidth: number): { kind: TriggerKind; index: number } | undefined {
  if (cursorWidth === 0) return undefined

  const cursorIndex = widthToStringIndex(value, cursorWidth)

  // "/" command only when it is the very first character and nothing before the cursor is whitespace.
  if (value.startsWith("/") && !value.slice(0, cursorIndex).match(/\s/)) {
    return { kind: "/", index: 0 }
  }

  // Nearest "@" (files) or "$" (agents) before the cursor with no whitespace in between.
  const text = value.slice(0, cursorIndex)
  const idx = Math.max(text.lastIndexOf("@"), text.lastIndexOf("$"))
  if (idx === -1) return undefined

  const kind: TriggerKind = idx === text.lastIndexOf("$") ? "$" : "@"
  const before = idx === 0 ? undefined : value[idx - 1]
  const between = text.slice(idx)
  if ((before === undefined || /\s/.test(before)) && !between.match(/\s/)) {
    return { kind, index: stringIndexToWidth(value, idx) }
  }

  return undefined
}
