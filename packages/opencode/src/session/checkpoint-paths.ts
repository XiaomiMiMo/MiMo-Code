import path from "path"
import fs from "fs/promises"
import { Global } from "@/global"
import type { ProjectID } from "@/project/schema"
import { SessionID } from "./schema"

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/**
 * Session memory root. Houses checkpoint artifacts, task narratives, and
 * other per-session memory files under `<data>/memory/sessions/<sid>/`.
 */
export function metaDir(sessionID: SessionID): string {
  return path.join(Global.Path.data, "memory", "sessions", sessionID)
}

/**
 * v5 single-file checkpoint at `<sid>/checkpoint.md` (no subdir).
 */
export function checkpointPath(sessionID: SessionID): string {
  return path.join(metaDir(sessionID), "checkpoint.md")
}

/**
 * v5 per-project memory file at `<data>/memory/projects/<pid>/MEMORY.md`.
 */
export function memoryPath(projectID: ProjectID): string {
  return path.join(Global.Path.data, "memory", "projects", projectID, "MEMORY.md")
}

/**
 * Single global memory file at `<data>/memory/global/MEMORY.md`. User-level
 * cross-project preferences. Read-only from the agent side; no auto-create.
 */
export function globalMemoryPath(): string {
  return path.join(Global.Path.data, "memory", "global", "MEMORY.md")
}

/**
 * One-shot rename of a legacy `projects/<pid>/memory.md` to the canonical
 * `MEMORY.md`. Idempotent: no-op when the uppercase file already exists or
 * when neither exists. The rename is atomic, so concurrent readers see either
 * the old or new name, never a missing file. Call before reading/writing
 * project memory so the uppercase path is authoritative.
 */
export async function migrateProjectMemory(projectID: ProjectID): Promise<void> {
  const upper = memoryPath(projectID)
  const lower = path.join(path.dirname(upper), "memory.md")
  if (await Bun.file(upper).exists()) return
  if (await Bun.file(lower).exists())
    // Two migrators (e.g. concurrent sessions/writers on the same project) can
    // both pass the exists() checks; the loser's rename then sees lower already
    // gone. ENOENT means the peer won — treat as success. Re-throw real FS
    // errors (permissions, disk).
    await fs.rename(lower, upper).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
    })
}

/**
 * v8 session-scoped notes file at `<sid>/notes.md`. Main-agent-only
 * scratchpad; writer reconciles entries at checkpoint events.
 */
export function notesPath(sessionID: SessionID): string {
  return path.join(metaDir(sessionID), "notes.md")
}

/**
 * Per-session tasks directory at `<sid>/tasks/`. Houses per-task progress
 * journals authored either by subagents (Spec ②) or by the splitover
 * plugin (when main checkpoint.md grows past caps).
 */
export function tasksDir(sessionID: SessionID): string {
  return path.join(metaDir(sessionID), "tasks")
}

/**
 * Per-task progress journal at `<sid>/tasks/<TID>/progress.md`. Authored
 * by subagents (Spec ② actor.postStop) and read by the checkpoint writer's
 * reconcile preprocessor (Spec ② Chain 2).
 */
export function progressPath(sessionID: SessionID, taskID: string): string {
  return path.join(tasksDir(sessionID), taskID, "progress.md")
}
