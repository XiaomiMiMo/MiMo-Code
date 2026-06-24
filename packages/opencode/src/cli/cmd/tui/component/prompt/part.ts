import { PartID } from "@/session/schema"
import type { PromptInfo } from "./history"
import { widthToStringIndex } from "./offset"

type Item = PromptInfo["parts"][number]

export function strip(part: Item & { id: string; messageID: string; sessionID: string }): Item {
  const { id: _id, messageID: _messageID, sessionID: _sessionID, ...rest } = part
  return rest
}

export function assign(part: Item): Item & { id: PartID } {
  return {
    ...part,
    id: PartID.ascending(),
  }
}

// Editor extmark offsets are display-WIDTH based (a wide CJK char counts as 2),
// while plainText is a JS UTF-16 string (a CJK char is 1 unit). widthToStringIndex
// converts a width offset into the matching UTF-16 string index so .slice lines up.
// Replace each placeholder span (given in width-based offsets) in the editor
// plainText with its real pasted content. Marks are applied right-to-left so
// earlier offsets stay valid as the string is rewritten.
export function expandPlaceholders(
  plainText: string,
  marks: { start: number; end: number; text: string }[],
): string {
  return [...marks]
    .sort((a, b) => b.start - a.start)
    .reduce((text, mark) => {
      const start = widthToStringIndex(text, mark.start)
      const end = widthToStringIndex(text, mark.end)
      return text.slice(0, start) + mark.text + text.slice(end)
    }, plainText)
}
