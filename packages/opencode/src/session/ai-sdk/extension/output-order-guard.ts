// Renderer-level guards for role/content-block display order and text-stream
// queuing. This is the UI-ordering layer (what appears in the output panel and
// in `ui-message-stream` SSE events). Invariant: `reasoning` parts are never
// emitted before a `start` step (they'd be invalid UI JSON and, on replay
// paths, malformed SSE). Deferred non-tool-call blocks after a step-start are
// flushed on the next `step-finish` so repeated `step-start` → (block) →
// `step-start` → `step-finish` runs don't drop content. Fix for #1496.

import type { ReasoningUIPart, SourceUrlUIPart, SourceDocumentUIPart, ToolUIPart } from "ai"

import type { Part, TextPart, ReasoningPart, ToolPart, AgentPart, StepStartPart, StepFinishPart, RedactedReasoningPart, SyntheticTextDelta } from "./types"

export type UiMessageStreamPart =
  | { type: "start"; messageId?: string }
  | { type: "start-step" }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | { type: "source-url"; sourceId: string; url: string; title?: string }
  | { type: "source-document"; mediaType: string; title: string; filename?: string; sourceId: string }
  | ({ type: "tool-input-start"; toolCallId: string; toolName: string } & Record<string, unknown>)
  | ({ type: "tool-input-available"; toolCallId: string; toolName: string; input: unknown } & Record<string, unknown>)
  | ({ type: "tool-output-available"; toolCallId: string; output: unknown } & Record<string, unknown>)
  | { type: "error"; errorText: string }
  | { type: "finish-step" }
  | { type: "finish"; finishReason?: string; usage?: Record<string, unknown> }

/** Drop pure-whitespace deltas so UI text won't carry trailing blank lines. */
function isMeaningfulText(text: string): boolean {
  return text.replace(/\s+/g, "").length > 0
}

export class OutputOrderGuard {
  /**
   * Final UI order per the Renderer test suite (ROLE_ORDER_FINAL):
   * text → reasoning → source-url/source-document → tool (all types, in tool-activity order) → step-start → step-finish
   */
  private readonly ROLE_ORDER_FINAL: Record<string, number> = {
    text: 0,
    reasoning: 1,
    "source-url": 2,
    "source-document": 2,
    "tool-activity": 3,
    "tool-input-start": 3,
    "tool-input-available": 3,
    "tool-output-available": 3,
    "tool-output-error": 3,
    "tool-output-denied": 3,
    "step-start": 4,
    "step-finish": 5,
    synthetic: 0,
  }

  /** e2e suite only demands the weaker invariants; README asserts the final order above. */
  private readonly ROLE_ORDER_STREAM: Record<string, number> = {
    reasoning: 0,
    "source-url": 1,
    "source-document": 1,
    "tool-activity": 2,
    "tool-input-start": 2,
    "tool-input-available": 2,
    "tool-output-available": 2,
    "tool-output-error": 2,
    "tool-output-denied": 2,
    "step-start": 3,
    "step-finish": 4,
    synthetic: 0,
  }

  /** e2e suite; README documents it as `done_reasoning · … · start_step · … · done_step`. */
  private readonly REASONING_ROLE_ORDER: Record<string, number> = {
    "done_reasoning": 0,
    "tool-activity": 1,
    "tool-input-start": 1,
    "tool-input-available": 1,
    "tool-output-available": 1,
    "tool-output-error": 1,
    "tool-output-denied": 1,
    "start_step": 2,
    "done_step": 3,
  }

  private hasSentText: boolean = false
  private hasSentStart: boolean = false
  private hasSentStartStep: boolean = false
  private deferred: Array<{ role: string; part: Part | UiMessageStreamPart }> = []

  canEmit(role: string): boolean {
    if (role === "reasoning") {
      return this.hasSentStart && this.hasSentStartStep
    }
    if (role === "step-start") {
      return this.hasSentStart
    }
    if (role === "text") {
      return true
    }
    if (this.ROLE_ORDER_STREAM[role] != null) {
      return this.hasSentStart
    }
    return true
  }

  noteStart(): void {
    this.hasSentStart = true
  }

  noteStepStart(): void {
    this.hasSentStartStep = true
  }

  noteText(): void {
    this.hasSentText = true
  }

  /**
   * Defer an emit: a `reasoning` before its `start`/`start_step`, or any
   * deferred block left over from the prior step. Callers emit immediately
   * when this returns `null`.
   */
  defer(role: string, part: Part | UiMessageStreamPart): { role: string; part: Part | UiMessageStreamPart } | null {
    if (!this.canEmit(role)) {
      this.deferred.push({ role, part })
      return { role, part }
    }
    return null
  }

  /**
   * Build the next step boundary to flush after a step-finish: emit
   * `step-start`, then whatever deferred non-text content was waiting on it.
   * `text` is not flushed here — text is emitted at its own display point.
   */
  flushStepStart(): Array<{ role: string; part: Part | UiMessageStreamPart }> {
    const queued = this.deferred
    this.deferred = []
    const nonText = queued.filter((entry) => entry.role !== "text")
    const out: Array<{ role: string; part: Part | UiMessageStreamPart }> = [
      { role: "step-start", part: { type: "step-start" } as StepStartPart },
    ]
    out.push(...nonText)
    this.hasSentStartStep = true
    return out
  }

  /** Drop anything still deferred (e.g. the whole run ends without another step). */
  flushDeferred(): Array<{ role: string; part: Part | UiMessageStreamPart }> {
    const out = this.deferred
    this.deferred = []
    return out
  }

  /**
   * Sort parts into the final output order (see ROLE_ORDER_FINAL). Parts of
   * the same role keep their original order — Array.prototype.sort is stable.
   * Ties between a `tool` part and another tool role are broken by their
   * original index so the tool-activity ordering is preserved.
   */
  orderParts<T extends Part>(parts: Array<T>): Array<T> {
    return parts
      .map((part, index) => ({ part, index }))
      .sort((a, b) => {
        const ra = this.ROLE_ORDER_FINAL[this.roleOf(a.part)] ?? 0
        const rb = this.ROLE_ORDER_FINAL[this.roleOf(b.part)] ?? 0
        return ra - rb || a.index - b.index
      })
      .map((entry) => entry.part)
  }

  private roleOf(part: Part): string {
    switch (part.type) {
      case "text":
        return "text"
      case "reasoning":
        return "reasoning"
      case "source-url":
        return "source-url"
      case "source-document":
        return "source-document"
      case "tool-activity":
        return "tool-activity"
      case "step-start":
        return "step-start"
      case "step-finish":
        return "step-finish"
      case "synthetic":
        return "synthetic"
      case "tool":
        return "tool-activity"
      case "agent":
        return "agent"
      default:
        return "text"
    }
  }
}

/**
 * Map a raw JSON `part` (an AI SDK data part with `type`/`data` shape, or a
 * tool part with `toolInvocation`) to a UI-stream part for the Renderer's
 * `ui-message-stream` output.
 *
 * Returns `null` when the part has no stream equivalent (empty text, `step-start`
 * /`step-finish` which the Renderer synthesizes, and `synthetic`).
 */
export function mapJsonPartToUiStream(part: Part): UiMessageStreamPart | null {
  switch (part.type) {
    case "text": {
      if (!part.text) return null
      return { type: "text-delta", id: part.id ?? "t1", delta: part.text }
    }
    case "reasoning": {
      if (!part.text) return null
      return { type: "reasoning-delta", id: part.id ?? "r1", delta: part.text }
    }
    case "tool": {
      const t = part as ToolPart
      const inv = t.toolInvocation
      if (inv.state === "result") {
        return {
          type: "tool-output-available",
          toolCallId: inv.toolCallId,
          toolName: inv.toolName,
          output: inv.result,
        }
      }
      if (inv.state === "partial-call" || inv.state === "call") {
        return {
          type: "tool-input-available",
          toolCallId: inv.toolCallId,
          toolName: inv.toolName,
          input: inv.args ?? {},
        }
      }
      return null
    }
    case "source-url":
      return {
        type: "source-url",
        sourceId: (part as SourceUrlUIPart).sourceId ?? part.url,
        url: part.url,
        title: (part as SourceUrlUIPart).title,
      }
    case "source-document":
      return {
        type: "source-document",
        mediaType: (part as SourceDocumentUIPart).mediaType ?? "text/plain",
        title: (part as SourceDocumentUIPart).title ?? "",
        sourceId: (part as SourceDocumentUIPart).sourceId ?? "",
      }
    default:
      return null
  }
}

/**
 * Emit a UI-message-stream part. In `passthrough` mode, the part goes out
 * unchanged (the Renderer already has it in the final order). In `json` mode,
 * the part is mapped to a `UiMessageStreamPart` and only emitted when
 * `canEmit(role)` holds (otherwise it is deferred).
 *
 * This is the ONE seam the Renderer uses for all parts — content and
 * tool-activity alike — so the UI order is identical to the final output
 * order (ROLE_ORDER_FINAL).
 */
export function emitUiStreamPart(
  guard: OutputOrderGuard,
  mode: "passthrough" | "json",
  role: string,
  part: Part | UiMessageStreamPart,
  writer: { write(part: UiMessageStreamPart): void },
): void {
  if (mode === "passthrough") {
    writer.write(part as UiMessageStreamPart)
    return
  }
  if (!guard.canEmit(role)) {
    guard.defer(role, part)
    return
  }
  const mapped = mapJsonPartToUiStream(part as Part)
  if (mapped) writer.write(mapped)
}

/**
 * Synthesize `text-start`/`text-delta`/`text-end` around an AI SDK
 * `toTextDelta` chunk so the UI stream always carries balanced text ids.
 * Drops pure-whitespace deltas so the UI won't carry trailing blank lines.
 */
export function emitSyntheticTextDelta(
  guard: OutputOrderGuard,
  text: string,
  writer: { write(part: UiMessageStreamPart): void },
): void {
  if (!isMeaningfulText(text)) return
  const id = `t${Date.now()}`
  guard.noteText()
  writer.write({ type: "text-start", id })
  writer.write({ type: "text-delta", id, delta: text })
  writer.write({ type: "text-end", id })
}

/**
 * Emit `step-start` and any non-text parts that were deferred while waiting
 * for it. Called after a `step-finish` so the next step's boundary precedes
 * its content.
 */
export function emitStepBoundary(
  guard: OutputOrderGuard,
  writer: { write(part: UiMessageStreamPart): void },
): void {
  const flushed = guard.flushStepStart()
  for (const entry of flushed) {
    if (entry.role === "step-start") {
      writer.write({ type: "start-step" })
    } else {
      const mapped = mapJsonPartToUiStream(entry.part as Part)
      if (mapped) writer.write(mapped)
    }
  }
}
