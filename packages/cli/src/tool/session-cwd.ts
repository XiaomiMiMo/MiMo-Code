import { BusEvent } from "@/bus/bus-event"
import { Instance } from "@/project/instance"
import { SessionID } from "@/session/schema"
import z from "zod"

// Kept for SDK compatibility. Session cwd overrides are no longer mutable.
export const Event = {
  Changed: BusEvent.define(
    "session.cwd",
    z.object({
      sessionID: SessionID.zod,
      cwd: z.string(),
    }),
  ),
}

export function get(_sessionID: SessionID): string {
  return Instance.directory
}

export * as SessionCwd from "./session-cwd"
