// Persisted transcripts outlive the removed automatic worktree policy.
const NOTICE_PREFIX = "<system-reminder>\nAuto-Worktree Notice\n"

export function isLegacyAutoWorktreeNotice(text: string): boolean {
  return text.startsWith(NOTICE_PREFIX)
}

export function replayLegacyWorktreeError(error: string): string {
  // Tool errors persist Error.message, not Error.name. Match the shared parent/child
  // rejection text narrowly so ordinary permission and filesystem failures survive.
  if (
    error.startsWith("Blocked: this path is inside the git MAIN worktree `") &&
    error.includes(
      "`.\n\nThis repo already uses worktrees. Writes to the main worktree are not allowed for this session.\n\n",
    ) &&
    error.includes("Do NOT retry against the main worktree path.")
  )
    return "[This tool call failed under a worktree isolation policy that is no longer active.]"
  return error
}
