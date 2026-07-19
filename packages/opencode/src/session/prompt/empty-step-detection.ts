import { Flag } from "@/flag/flag"
import type { MessageV2 } from "../message-v2"

/**
 * Empty tool-call loop guard.
 *
 * Narrow purpose: some models (including frontier ones under certain workloads)
 * occasionally emit a tool call with a completely empty argument object —
 * i.e. they "called a tool" but passed nothing actionable. Re-looping just
 * repeats the same empty call. This guard detects that specific shape and
 * escalates via a soft→hard recovery ladder mirroring text-ngram-detection.
 *
 * IMPORTANT scope note: this guard does NOT try to catch "empty terminals"
 * (steps that emit no tool call and no text). An empty terminal is a natural
 * turn end, not a spin — the next user input drives the next turn. Treating
 * it as a loop caused frequent false positives on legitimate quiet steps
 * (task done, sub-agent returned, reasoning-only steps, provider-executed
 * tool calls). Wall-clock / active deadlines and provider stream timeouts
 * already backstop any actual "model produces nothing" pathology.
 */

export const EMPTY_STEP_MAX_RECOVERY = Flag.MIMOCODE_EMPTY_STEP_MAX_RECOVERY

/**
 * Is this assistant step an empty tool call?
 *
 * True iff the step emitted one or more client (non-providerExecuted) tool
 * parts AND every such tool part has an empty/invalid input — no keys, or
 * only keys whose values are null/undefined/empty-string/whitespace.
 *
 * A step with ANY tool part that has real input is NOT empty.
 * A step with no client tool part is NOT empty (empty terminals are allowed).
 * A step with substantive text or reasoning alongside a bad tool call is NOT
 * empty (the model is making some kind of progress).
 *
 * Provider-executed tool parts (e.g. server-side web search) are ignored:
 * they are not client actions.
 */
export function isEmptyStep(parts: readonly MessageV2.Part[]): boolean {
  const clientToolParts = parts.filter(
    (part): part is Extract<MessageV2.Part, { type: "tool" }> =>
      part.type === "tool" && !part.metadata?.providerExecuted,
  )

  // No client tool part → not an empty tool call. Empty terminals fall through
  // to natural turn end; this guard only targets the specific "called a tool
  // with no args" pathology.
  if (clientToolParts.length === 0) return false

  // Substantive text or reasoning alongside a bad tool call → model is making
  // progress, don't flag.
  const hasSubstantiveText = parts.some(
    (part) => part.type === "text" && !part.synthetic && !part.ignored && part.text.trim().length > 0,
  )
  if (hasSubstantiveText) return false
  const hasSubstantiveReasoning = parts.some(
    (part) => part.type === "reasoning" && part.text.trim().length > 0,
  )
  if (hasSubstantiveReasoning) return false

  // Every client tool part must have empty input.
  return clientToolParts.every((part) => isEmptyInput(part.state.input))
}

/**
 * An input object counts as empty when it has no keys, or every value is
 * null/undefined/empty-string/whitespace-only. Nested objects/arrays with any
 * content count as non-empty (the model passed *something*).
 */
function isEmptyInput(input: Record<string, unknown> | undefined | null): boolean {
  if (input === undefined || input === null) return true
  const keys = Object.keys(input)
  if (keys.length === 0) return true
  return keys.every((k) => isEmptyValue(input[k]))
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === "string") return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0
  // number / boolean → the model passed a real value.
  return false
}

export const EMPTY_STEP_RECOVERY_REMIND = [
  "<system-reminder>",
  "Your previous tool call had empty or missing arguments — the tool needs real input to make progress.",
  "Retry the call with COMPLETE arguments, or if the tool is not the right next step, answer the user in plain text.",
  "</system-reminder>",
].join("\n")

export const EMPTY_STEP_RECOVERY_REPLAN = [
  "<system-reminder>",
  "Second empty tool call. Final chance before this turn is halted.",
  "Either issue a tool call with fully-populated arguments, or give a plain-text reply.",
  "Any further empty-argument tool call will terminate this turn.",
  "</system-reminder>",
].join("\n")
