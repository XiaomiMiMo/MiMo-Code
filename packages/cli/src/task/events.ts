import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import z from "zod"
import { Task, TaskEventKind } from "./schema"

export const Created = BusEvent.define(
  "task.created",
  z.object({
    sessionID: SessionID.zod,
    task: Task,
  }),
)

// `kind` narrows the lifecycle transition that produced this event. `created`
// is excluded — new rows ride [[Created]] so external consumers can split
// "row appeared" from "row mutated" without an if-kind branch (matching
// actor.registered vs actor.status).
export const UpdatedKind = TaskEventKind.exclude(["created"])
export type UpdatedKind = z.infer<typeof UpdatedKind>

export const Updated = BusEvent.define(
  "task.updated",
  z.object({
    sessionID: SessionID.zod,
    task: Task,
    kind: UpdatedKind,
  }),
)
