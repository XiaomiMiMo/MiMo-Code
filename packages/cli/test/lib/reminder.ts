import type { MessageV2 } from "../../src/session/message-v2"
import { SessionReminder } from "../../src/session/reminder"

// The run loop persists these once per context window on a user message; tests
// pinning user parts compare everything else.
export function isWindowReminder(part: MessageV2.Part) {
  const key = SessionReminder.tag(part)?.key
  return key === "workspace" || key === "memory-paths"
}
