import { BusEvent } from "@/bus/bus-event"
import { Instance } from "@/project/instance"
import { registerDisposer } from "@/effect/instance-registry"
import { SessionID } from "@/session/schema"
import z from "zod"

const store = new Map<string, string>()

registerDisposer(async () => {
  store.clear()
})

export const Event = {
  Changed: BusEvent.define(
    "session.cwd",
    z.object({
      sessionID: SessionID.zod,
      cwd: z.string(),
    }),
  ),
}

export function get(sessionID: SessionID): string {
  return store.get(sessionID) ?? Instance.directory
}

export function set(sessionID: SessionID, dir: string): void {
  store.set(sessionID, dir)
}

export function clear(sessionID: SessionID): void {
  store.delete(sessionID)
}

export * as SessionCwd from "./session-cwd"
