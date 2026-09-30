import { Locale } from "@/util"

/**
 * Cell budget for the ephemeral status message in the prompt footer. Sized so
 * the message plus the spinner still leaves room for `esc interrupt` and the
 * context counter on an 80-column terminal.
 */
export const STATUS_MESSAGE_MAX = 48

/**
 * The footer packs the spinner + status message onto the same row as the context
 * counter (`52.4K/960K (5%)`). A long server-supplied status string wrapped over
 * several lines and squeezed that row until the counter rendered clipped
 * (`52.4K/96`). Clamp the message — and flatten any newlines — so a status
 * string can never cost the counter its cells.
 */
export function clampStatusMessage(message: string | undefined) {
  if (!message) return undefined
  const flat = message.replace(/\s+/g, " ").trim()
  if (!flat) return undefined
  return Locale.truncate(flat, STATUS_MESSAGE_MAX)
}
