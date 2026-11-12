import { MessageV2 } from "./message-v2"

/**
 * Outcome of classifying a single assistant step. Pure data — `runLoop` decides
 * what side effect (nudge / retry / error / break) each category triggers.
 *
 * `final` with `rawFinish` marks an abnormal-but-delivered completion (unified
 * finish `other` carrying the provider's raw reason): it ends the turn and the
 * caller logs the raw reason.
 */
export type StepClassification =
  | { type: "final"; rawFinish?: string }
  | { type: "continue" }
  | { type: "text-tool-call" }
  | { type: "filtered" }
  | { type: "invalid"; reason: string }
  | { type: "failed"; reason: string }

/**
 * Unified finish `other` with no raw reason: the AI SDK default when the stream
 * closed before the provider sent a finish frame. The step did not finish.
 */
export function isStreamIncomplete(assistant: Pick<MessageV2.Assistant, "finish" | "rawFinish">): boolean {
  return assistant.finish === "other" && !assistant.rawFinish
}

/**
 * Finish reasons that end the turn once the step carries final text: `stop`
 * and `other` with a provider raw reason.
 * Raw-less `other` (stream incomplete) is never terminal.
 */
export function isTerminalFinish(assistant: Pick<MessageV2.Assistant, "finish" | "rawFinish">): boolean {
  return assistant.finish === "stop" || (assistant.finish === "other" && !!assistant.rawFinish)
}

/**
 * Single source of truth for "is this assistant step terminal, or should the
 * loop keep going?". Called from all three classification sites in `runLoop`
 * (existing-assistant top break, fork json_schema gate, main json_schema gate)
 * so a fix lands in one place instead of three.
 *
 * Pure: no Effect, no I/O, no mutation.
 *
 * Core guarantee (all downstream tasks depend on it): any finish reason plus a
 * pending non-`providerExecuted` client tool part ⇒ `continue`, with higher
 * priority than final/refusal text or any other category.
 */
export function classifyAssistantStep(input: {
  lastUser: MessageV2.User
  assistant: MessageV2.Assistant
  parts: MessageV2.Part[]
  phase: "existing-assistant" | "after-process"
  // Reserved for T01–T05 (stop/overflow control flow stays in runLoop for T00).
  processResult?: "continue" | "stop" | "overflow" | "text-repeat"
}): StepClassification {
  const assistant = input.assistant

  // 1. Core guarantee — beats everything: a pending client tool call must
  // re-loop so its observation is fed back to the model. EXCLUDE error-state
  // tool parts: cleanup after SSE timeout / abort marks pending tool parts
  // as state.status === "error". Those are NOT pending observation — they're
  // terminal failures. Without this guard, classify mis-routes errored steps
  // to "continue", runLoop re-enters and gets stranded on permission.ask
  // from the in-flight tool that won't ever resolve. See Spec ③.
  // In-flight client tools (pending/running) must re-loop so their observations
  // are fed back. COMPLETED tools alone must NOT force continue once the step
  // already carries a terminal finish + final text — otherwise a finished turn
  // (tools + summary on one message) classifies as continue forever and the
  // session never idles. Provider quirk "finish=stop with tool calls" still
  // re-loops when tools are not yet terminal, or when there is no final text.
  {
    const clientTools = input.parts.filter(
      (part): part is Extract<MessageV2.Part, { type: "tool" }> =>
        part.type === "tool" && !part.metadata?.providerExecuted,
    )
    const inFlight = clientTools.some(
      (part) => part.state.status === "pending" || part.state.status === "running",
    )
    const hasFinalText = input.parts.some(
      (part) => part.type === "text" && !part.synthetic && !part.ignored && part.text.trim().length > 0,
    )
    // Live raw-less `other` never reaches classify (see #8), so a stored `other`
    // counts as terminal here like `stop`, judged by its content.
    const terminalFinish = assistant.finish === "stop" || assistant.finish === "other"
    if (inFlight) return { type: "continue" }
    if (clientTools.some((part) => part.state.status !== "error") && !(terminalFinish && hasFinalText))
      return { type: "continue" }
  }

  // 2. Nothing finalized yet.
  if (!assistant.finish) return { type: "continue" }

  // 3a. Text-form tool call: the model serialized a tool call as PROSE TEXT
  // instead of emitting a structured tool_use. Signature: finish "tool-calls"
  // but NO structured tool part (a real tool part would have re-looped at #1)
  // and text carrying tool-call markup. Must precede the unconditional
  // tool-calls continue below, which would otherwise swallow this state.
  // Guards: skip if this turn was already discarded (assistant.error set — let
  // it fall through to `failed` at #5), and skip a stale/resumed turn the
  // conversation already moved past (mirrors the #4 staleness guard) so a
  // degraded turn left in history can't re-fire across turns/resumes.
  if (
    assistant.finish === "tool-calls" &&
    !assistant.error &&
    input.lastUser.id < assistant.id &&
    !input.parts.some((part) => part.type === "tool") &&
    input.parts.some(
      (part) =>
        part.type === "text" &&
        !part.synthetic &&
        !part.ignored &&
        /<invoke name=|<parameter name=|<\/invoke>|<function_calls>/.test(part.text),
    )
  )
    return { type: "text-tool-call" }

  // 3. Provider-executed-only tool step (no client tool part left, see #1).
  if (assistant.finish === "tool-calls") return { type: "continue" }

  // 4. Stale assistant predating the current user turn — don't terminate on it.
  if (input.phase === "existing-assistant" && !(input.lastUser.id < assistant.id))
    return { type: "continue" }

  // 5. Errored step — checked before content so an errored message that also
  // carries text isn't misjudged `final`.
  if (assistant.error) return { type: "failed", reason: assistant.error.name }

  // 6. Already-resolved structured output / summary — terminal, never nudge-able.
  if (assistant.structured !== undefined) return { type: "final" }
  if (assistant.summary) return { type: "final" }

  // 7. Safety / error finish reasons.
  if (assistant.finish === "content-filter") return { type: "filtered" }
  if (assistant.finish === "error") return { type: "failed", reason: "model error finish" }

  // 8. stop / length / other → inspect produced content. Text or reasoning
  // alone ends the turn: a reasoning-only stop is the model's answer. A live
  // step whose stream closed without a finish frame never gets here
  // (processor.process raises StreamIncompleteError and max-mode drops such
  // candidates), so a raw-less `other` seen here is persisted history
  // (pre-upgrade, or a step interrupted before the check) and is judged by its
  // content. `other`
  // with a raw reason is an abnormal-but-delivered completion; surface the raw
  // reason so runLoop logs it.
  const hasText = input.parts.some(
    (part) => part.type === "text" && !part.synthetic && !part.ignored && part.text.trim().length > 0,
  )
  const hasReasoning = input.parts.some((part) => part.type === "reasoning" && part.text.trim().length > 0)
  if (hasText || hasReasoning)
    return assistant.finish === "other" && assistant.rawFinish
      ? { type: "final", rawFinish: assistant.rawFinish }
      : { type: "final" }
  return { type: "invalid", reason: "empty output" }
}
