import type { MessageV2 } from "../../src/session/message-v2"
import { SessionReminder } from "../../src/session/reminder"

// The run loop persists these on a user message (once per context window; the
// skill catalog also adds deltas when skills change). Tests pinning user parts
// compare everything else.
export function isWindowReminder(part: MessageV2.Part) {
  const key = SessionReminder.tag(part)?.key
  return key === "session-env" || key === "memory-paths" || key === "skills"
}
