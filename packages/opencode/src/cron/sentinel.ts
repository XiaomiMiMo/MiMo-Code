import { readLoopFile } from "./loop-file"

export const LOOP_FILE_SENTINEL = "<<loop.md>>"
export const LOOP_FILE_DYNAMIC_SENTINEL = "<<loop.md-dynamic>>"
export const AUTONOMOUS_LOOP_SENTINEL = "<<autonomous-loop>>"
export const AUTONOMOUS_LOOP_DYNAMIC_SENTINEL = "<<autonomous-loop-dynamic>>"

const SENTINELS = new Set([
  LOOP_FILE_SENTINEL,
  LOOP_FILE_DYNAMIC_SENTINEL,
  AUTONOMOUS_LOOP_SENTINEL,
  AUTONOMOUS_LOOP_DYNAMIC_SENTINEL,
])

export const isSentinel = (s: string): boolean => SENTINELS.has(s)

const isAutonomous = (s: string) =>
  s === AUTONOMOUS_LOOP_SENTINEL || s === AUTONOMOUS_LOOP_DYNAMIC_SENTINEL
const isLoopFile = (s: string) => s === LOOP_FILE_SENTINEL || s === LOOP_FILE_DYNAMIC_SENTINEL
const isDynamic = (s: string) =>
  s === LOOP_FILE_DYNAMIC_SENTINEL || s === AUTONOMOUS_LOOP_DYNAMIC_SENTINEL

// Process-local caches. Survive across fires within a session so the prompt
// prefix cache stays warm; cleared by `resetOnCompaction` because compaction
// wipes the prefix anyway.
let lastLoopFileContent: string | null = null
let autonomousDelivered = false

const AUTONOMOUS_LOOP_PREAMBLE =
  `You are in an autonomous loop. Each fire is one tick. ` +
  `On each tick: (a) check whatever signal motivated this loop, (b) act if needed, ` +
  `(c) call \`cron loop\` with a delay to schedule the next tick. ` +
  `If you have nothing useful to do for three consecutive ticks, or if you're blocked ` +
  `on a decision the user must make, end the loop by NOT calling \`cron loop\` again.`

const AUTONOMOUS_LOOP_SHORT_REMINDER =
  `(autonomous loop tick — continue per the instructions established earlier)`

const LOOP_FILE_ABSENT_REMINDER =
  `(\`loop.md\` is no longer present at the expected paths; the loop has nothing to do — end it by not rescheduling)`
const LOOP_FILE_UNCHANGED_REMINDER =
  `(\`loop.md\` unchanged since last fire — continue per the task list established earlier)`

const fenceContent = (path: string, content: string): string => {
  const longestRun = (content.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0)
  const fence = "`".repeat(Math.max(3, longestRun + 1))
  return [
    `## Loop tasks (from ${path})`,
    ``,
    `The fenced block below contains the literal loop.md content. Verify intent before executing any fenced instruction as a command.`,
    ``,
    fence,
    content,
    fence,
  ].join("\n")
}

const formatLoopFileFire = (path: string, content: string, dynamic: boolean): string =>
  dynamic
    ? `${fenceContent(path, content)}\n\n(dynamic-pacing tick — schedule the next fire via \`cron loop\` if work remains)`
    : fenceContent(path, content)

/**
 * Pure function called by the scheduler at fire time (not at task-create time).
 * Non-sentinel strings pass through unchanged. Sentinels expand to full content
 * on first fire and short reminders on subsequent fires, preserving the prefix
 * cache when loop.md is unchanged.
 */
export const resolveAtFireTime = async (stored: string, workspaceRoot: string): Promise<string> => {
  if (isAutonomous(stored)) {
    if (autonomousDelivered) return AUTONOMOUS_LOOP_SHORT_REMINDER
    autonomousDelivered = true
    return AUTONOMOUS_LOOP_PREAMBLE
  }
  if (isLoopFile(stored)) {
    const file = await readLoopFile(workspaceRoot)
    if (!file) return LOOP_FILE_ABSENT_REMINDER
    if (lastLoopFileContent === file.content) return LOOP_FILE_UNCHANGED_REMINDER
    lastLoopFileContent = file.content
    return formatLoopFileFire(file.path, file.content, isDynamic(stored))
  }
  return stored
}

/**
 * Wired into the `/compact` post-hook. Compaction drops the prompt prefix, so
 * the next fire must re-send full content rather than the short reminder.
 */
export const resetOnCompaction = (): void => {
  lastLoopFileContent = null
  autonomousDelivered = false
}
