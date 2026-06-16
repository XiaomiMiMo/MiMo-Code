export const TEXT_LOOP_BUFFER_SIZE = 5
export const TEXT_LOOP_TRIGGER_COUNT = 3
export const TEXT_LOOP_MAX_RECOVERY = 2

export function normalizeForLoopDetection(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^(let me |i'll |i will |let's )/i, "")
    .slice(0, 200)
}

export function detectTextLoop(buffer: string[], triggerCount: number): boolean {
  if (buffer.length < triggerCount) return false
  const tail = buffer.slice(-triggerCount)
  return tail.every((t) => t === tail[0])
}

export const RECOVERY_PROMPT_MILD = `<system-reminder>
LOOP DETECTED: Your last several outputs were identical. You are stuck in a repetitive pattern.

STOP what you are doing and take a DIFFERENT approach:
- If you were about to call a tool, try a different tool or different arguments
- If you were planning an action, reconsider and pick an alternative strategy
- If you are blocked, explain what's blocking you and ask the user for help

Do NOT repeat the same text or action again.
</system-reminder>`

export const RECOVERY_PROMPT_STRONG = `<system-reminder>
CRITICAL: You are STILL stuck in a loop after a previous recovery attempt.

Your previous approach has failed repeatedly. You MUST:
1. Abandon your current plan entirely
2. State what you were trying to do and why it failed
3. Ask the user for guidance on how to proceed

If you repeat the same output again, the session will be terminated.
</system-reminder>`
