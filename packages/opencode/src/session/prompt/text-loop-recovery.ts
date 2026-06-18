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

STOP immediately and take a DIFFERENT approach:
1. Re-read the original user request — are you solving the right problem?
2. If you were about to call a tool, use a DIFFERENT tool or different arguments.
3. If you were planning an action, choose a fundamentally different strategy.
4. If you are blocked, explain the specific blocker and ask the user for help.
5. Do NOT continue with the same approach — it has already failed.

The user is waiting for progress, not repetition.
</system-reminder>`

export const RECOVERY_PROMPT_STRONG = `<system-reminder>
CRITICAL FAILURE: You are STILL stuck in a loop after a previous recovery attempt.

Your current approach has failed repeatedly and MUST be abandoned entirely.
You are required to:

1. ABANDON your current plan completely — do not continue it in any form.
2. State clearly what you were trying to do and explain why it failed.
3. Propose 2-3 alternative approaches and ask the user which to try.
4. If you cannot think of alternatives, say so honestly — the user will guide you.

DO NOT attempt the same action again. Repeating it a third time would be a critical failure.
The session will be terminated if you continue looping.
</system-reminder>`
