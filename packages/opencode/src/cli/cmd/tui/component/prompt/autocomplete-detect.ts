import { stringIndexToWidth, widthToStringIndex } from "./offset"

export type TriggerKind = "@" | "$" | "/"

export function exactSubmitOption<T extends { display: string; submitOnSelect?: boolean }>(
  trigger: TriggerKind | false,
  query: string,
  options: T[],
) {
  if (trigger !== "/") return
  return options.find((option) => option.submitOnSelect && option.display.trimEnd() === "/" + query)
}

// Decide whether an autocomplete popup should open for the current input.
//
// `value` is the editor plainText (UTF-16) and `cursorWidth` is the editor's
// display-width cursor offset (CJK = 2 columns). We convert the cursor to a
// UTF-16 index before doing any string work, then report the trigger position
// back in width coordinates so it matches the editor's extmark/cursor space.
export function detectTrigger(value: string, cursorWidth: number): { kind: TriggerKind; index: number } | undefined {
  if (cursorWidth === 0) return undefined

  const cursorIndex = widthToStringIndex(value, cursorWidth)

  // "/" command at the very first character with no whitespace before the
  // cursor keeps the legacy single-command behavior on Enter.
  if (value.startsWith("/") && !value.slice(0, cursorIndex).match(/\s/)) {
    return { kind: "/", index: 0 }
  }

  // Nearest "@" (files), "$" (agents), or "/" (skills) before the cursor with
  // no whitespace in between. The token must be preceded by whitespace or
  // start-of-string so we don't fire on URL paths (e.g. `https://x.com/api`).
  const text = value.slice(0, cursorIndex)
  const idx = Math.max(text.lastIndexOf("@"), text.lastIndexOf("$"), text.lastIndexOf("/"))
  if (idx === -1) return undefined

  const dollar = text.lastIndexOf("$")
  const slash = text.lastIndexOf("/")
  const kind: TriggerKind = idx === slash ? "/" : idx === dollar ? "$" : "@"
  const before = idx === 0 ? undefined : value[idx - 1]
  const between = text.slice(idx)
  if ((before === undefined || /\s/.test(before)) && !between.match(/\s/)) {
    // For "/" require at least one non-slash character after the trigger so a
    // lone "/" typed mid-message doesn't open the popup with an empty query.
    if (kind === "/" && between.length <= 1) return undefined
    return { kind, index: stringIndexToWidth(value, idx) }
  }

  return undefined
}
