import type { MessageV2 } from "../message-v2"
import { toolSignature } from "./loop-streak"

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

export type ToolLoopKind = "consecutive" | "periodic"

/**
 * Newest-first tool signatures of completed assistant steps, at most `window`.
 * Stops at the most recent synthetic user turn (a prior recovery prompt) so
 * steps before it never count toward the current loop, and at the first
 * tool-less finished step, since a pure-text turn breaks any action loop.
 */
export function recentToolSignatures(msgs: readonly MessageV2.WithParts[], window: number): string[] {
  const out: string[] = []
  for (let i = msgs.length - 1; i >= 0 && out.length < window; i--) {
    const m = msgs[i]
    if (m.info.role === "user") {
      if (m.parts.some((p) => p.type === "text" && p.synthetic)) break
      continue
    }
    if (!m.info.finish) continue
    const sig = toolSignature(m.parts)
    if (!sig) break
    out.push(sig)
  }
  return out
}

/** Detects repeated completed-tool signatures in newest-first order. */
export function detectToolLoop(
  signatures: readonly string[],
  threshold = 3,
  periodMin = 2,
  periodMax = 4,
): ToolLoopKind | undefined {
  if (signatures.length >= threshold && signatures.slice(0, threshold).every((sig) => sig === signatures[0])) {
    return "consecutive"
  }
  for (let period = periodMin; period <= periodMax; period++) {
    if (signatures.length < period * threshold) continue
    const tail = signatures.slice(0, period * threshold)
    if (tail.every((sig, index) => sig === tail[index % period])) return "periodic"
  }
  return undefined
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

export const TOOL_RECOVERY_PROMPT_MILD = `<system-reminder>
LOOP DETECTED (TOOL): The same tool action has been repeated without progress.
Stop repeating it. Inspect the latest result and choose a different action or explain the blocker.
</system-reminder>`

export const TOOL_RECOVERY_PROMPT_STRONG = `<system-reminder>
CRITICAL TOOL LOOP: Your tool calls are cycling without progress.
Abandon this approach, state why it failed, and write a different plan before using another tool.
</system-reminder>`
