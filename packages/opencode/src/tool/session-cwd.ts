import { Instance } from "@/project/instance"
import type { SessionID } from "@/session/schema"

export function get(_sessionID: SessionID): string {
  return Instance.directory
}

export * as SessionCwd from "./session-cwd"
