import z from "zod"
import { SessionID } from "../session/schema"

export const TaskID = z.string().regex(/^T\d+(\.\d+)*$/, "Task ID must be Tn or Tn.m...")
export type TaskID = z.infer<typeof TaskID>

export const TaskStatus = z.enum(["open", "in_progress", "blocked", "done", "abandoned"])
export type TaskStatus = z.infer<typeof TaskStatus>

export const Task = z.object({
  id: TaskID,
  session_id: SessionID.zod,
  parent_task_id: TaskID.optional(),
  status: TaskStatus,
  summary: z.string(),
  owner: z.string().optional(),
  created_at: z.number(),
  last_event_at: z.number(),
  ended_at: z.number().optional(),
  cleanup_after: z.number().optional(),
})
export type Task = z.infer<typeof Task>

export const TaskEventKind = z.enum([
  "created",
  "started",
  "unstarted",
  "blocked",
  "unblocked",
  "done",
  "abandoned",
  "renamed",
])
export type TaskEventKind = z.infer<typeof TaskEventKind>

export const TaskEvent = z.object({
  id: z.number(),
  task_id: TaskID,
  at: z.number(),
  kind: TaskEventKind,
  summary: z.string().optional(),
})
export type TaskEvent = z.infer<typeof TaskEvent>
