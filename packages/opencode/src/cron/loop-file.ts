import { readFile } from "fs/promises"
import { join } from "path"
import { homedir } from "os"

const MAX_BYTES = 25_000
const TRUNCATION_MARKER =
  "\n\n> WARNING: loop.md was truncated to 25000 bytes. Keep the task list concise."

export type LoopFileResult = { path: string; content: string }

/**
 * Read loop.md from project (.mimocode/loop.md) or home (~/loop.md). Project
 * takes precedence. Content > 25 KB is truncated with a warning marker.
 * Returns null when neither path exists or can be read.
 */
export const readLoopFile = async (workspaceRoot: string): Promise<LoopFileResult | null> => {
  const candidates = [join(workspaceRoot, ".mimocode", "loop.md"), join(homedir(), "loop.md")]
  for (const path of candidates) {
    const raw = await readFile(path, "utf-8").catch(() => null)
    if (raw === null) continue
    if (raw.length > MAX_BYTES) return { path, content: raw.slice(0, MAX_BYTES) + TRUNCATION_MARKER }
    return { path, content: raw }
  }
  return null
}
