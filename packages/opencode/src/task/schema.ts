import z from "zod"
import { SessionID } from "../session/schema"

export const TaskID = z.string().regex(/^T\d+(\.\d+)*$/, "Task ID must be Tn or Tn.m...")
export type TaskID = z.infer<typeof TaskID>

// Task statuses double as queue names: a task's status IS the queue it sits in.
// `dispatched` = handed to a worker session that has not reported running yet.
// `human_review` = a first-class queue waiting on the USER, not on any worker.
// `failed` = a worker reported failure; terminal but distinct from `abandoned`,
// which is an operator dropping the work.
export const TaskStatus = z.enum([
  "open",
  "dispatched",
  "in_progress",
  "blocked",
  "human_review",
  "done",
  "failed",
  "abandoned",
])
export type TaskStatus = z.infer<typeof TaskStatus>

// Terminal = cannot be resurrected by start(). done/abandon/fail all stamp
// ended_at + cleanup_after, so a restart would leave a self-contradictory row.
export const TERMINAL_TASK_STATUSES = ["done", "failed", "abandoned"] as const satisfies readonly TaskStatus[]
export const NON_TERMINAL_TASK_STATUSES = [
  "open",
  "dispatched",
  "in_progress",
  "blocked",
  "human_review",
] as const satisfies readonly TaskStatus[]

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly TaskStatus[]).includes(status)
}

export const Task = z.object({
  id: TaskID,
  session_id: SessionID.zod,
  parent_task_id: TaskID.optional(),
  status: TaskStatus,
  summary: z.string(),
  owner: z.string().optional(),
  // The peer worker session executing this task. Soft link (no FK): a worker
  // session can be torn down while the task row must survive as history.
  worker_session_id: SessionID.zod.optional(),
  dispatched_at: z.number().optional(),
  // Pointer to the outcome: branch, commit, summary or notification id.
  result_ref: z.string().optional(),
  created_at: z.number(),
  last_event_at: z.number(),
  ended_at: z.number().optional(),
  cleanup_after: z.number().optional(),
})
export type Task = z.infer<typeof Task>

export const TaskEventKind = z.enum([
  "created",
  "dispatched",
  "started",
  "unstarted",
  "blocked",
  "unblocked",
  "review_requested",
  "reworked",
  "done",
  "failed",
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
