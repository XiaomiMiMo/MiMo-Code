import type { ModelMessage, LanguageModel, ToolSet } from "ai"
import { NoSuchToolError, InvalidToolInputError } from "ai"
import {
  OutputOrderGuard,
  emitUiStreamPart,
  emitSyntheticTextDelta,
  emitStepBoundary,
  type UiMessageStreamPart,
} from "./extension/output-order-guard"
import { jsonPartsToModelMessage } from "./extension/json-to-model-message"
import { makeSyntheticTextDelta } from "./extension/synthetic-text-delta"
import type { Part, TextPart, ReasoningPart, ToolPart, StepStartPart, StepFinishPart } from "./extension/types"

/**
 * A minimal re-implementation of the AI SDK `StreamingTextResult` interface
 * that the Renderer uses for provider text chunks.
 */
export interface ToTextDeltaChunk {
  type: "text-delta"
  textDelta: string
  id?: string
}

export interface StepStartPartData {
  type: "step-start"
}

export interface StepFinishPartData {
  type: "step-finish"
  finishReason?: string
  usage?: Record<string, unknown>
}

export interface ToolCallPartData {
  type: "tool-call"
  toolCallId: string
  toolName: string
  input: unknown
}

export interface ToolResultPartData {
  type: "tool-result"
  toolCallId: string
  toolName: string
  output: unknown
}

export interface ToolPartData {
  type: "tool"
  toolCallId: string
  toolName: string
  state: "partial-call" | "call" | "result"
  input?: unknown
  output?: unknown
  toolInvocation: {
    toolCallId: string
    toolName: string
    state: "partial-call" | "call" | "result"
    args?: unknown
    result?: unknown
  }
}

export interface StepStart {
  type: "step-start"
}

export interface StepFinish {
  type: "step-finish"
  finishReason?: string
  usage?: Record<string, unknown>
}

/**
 * The persisted JSON shape for a single assistant message. Mirrors the
 * `MessageV2.Assistant` schema but is loose enough for the Renderer to
 * accept any well-formed JSON.
 */
export interface AssistantJSON {
  id: string
  role: "assistant"
  parts: Array<Part>
  time?: { created?: number }
  system?: string[]
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  error?: string
  mode?: string
  modelID?: string
  providerID?: string
  path?: { cwd?: string; root?: string }
}

export interface UserJSON {
  id: string
  role: "user"
  parts: Array<Part>
  time?: { created?: number }
  system?: string[]
  mode?: string
  modelID?: string
  providerID?: string
  path?: { cwd?: string; root?: string }
}

export interface SystemJSON {
  id: string
  role: "system"
  parts: Array<Part>
  time?: { created?: number }
  system?: string[]
  mode?: string
  modelID?: string
  providerID?: string
  path?: { cwd?: string; root?: string }
}

export type MessageJSON = AssistantJSON | UserJSON | SystemJSON

/**
 * The output text for a single JSON message. Computed from the parts' own
 * display order — the same order the UI shows.
 */
export interface OutputText {
  /** Concatenated text from the `text` parts, in display order. */
  text: string
  /** The full output as a single string (text + reasoning + tool activity markers). */
  full: string
}

/**
 * The Renderer's view of a JSON step: the parts, the output text, and the
 * tool-activity ordering used by the UI.
 */
export interface StepOutput {
  parts: Array<Part>
  text: string
  full: string
  toolOrder: Array<string>
}

/**
 * The Renderer's view of a full JSON conversation: each assistant/user/system
 * message, its parts, its output text, and the step boundaries.
 */
export interface ConversationOutput {
  messages: Array<MessageJSON>
  outputs: Array<OutputText>
  steps: Array<StepOutput>
}

/**
 * The Renderer's `toUIStreamParts` options. `mode` selects the output shape:
 *
 * - `passthrough` (default): the raw JSON parts are emitted in their final
 *   display order (see `OutputOrderGuard.ROLE_ORDER_FINAL`).
 * - `json`: the parts are mapped to `UiMessageStreamPart`s, with
 *   `text-start`/`text-delta`/`text-end` triples synthesized around any
 *   provider `toTextDelta` chunks.
 */
export interface ToUIStreamPartsOptions {
  mode?: "passthrough" | "json"
}

/**
 * The Renderer: the single entry point for turning persisted JSON messages
 * into (a) the next provider `ModelMessage` and (b) the UI stream parts.
 *
 * Invariant: the output text is computed from the parts' own display order —
 * the same order the UI shows. There is no separate "text extraction" pass
 * that can disagree with the UI.
 */
export class Renderer {
  private guard = new OutputOrderGuard()

  /**
   * Bridge a single JSON step into the next provider call: one `ModelMessage`
   * with `content: Array<Part>`. The parts are copied, not mutated.
   */
  static toModelMessage(
    role: "user" | "assistant" | "system",
    parts: Array<Part>,
    toolCalls?: Array<{ toolCallId: string; toolName: string; input?: unknown }>,
    toolResults?: Array<{ toolCallId: string; toolName: string; output?: unknown; result?: unknown }>,
  ): ModelMessage {
    return jsonPartsToModelMessage(role, parts, toolCalls, toolResults)
  }

  /**
   * Compute the output text for a single JSON message. The text is the
   * concatenation of the `text` parts in display order.
   */
  static outputText(message: MessageJSON): OutputText {
    const guard = new OutputOrderGuard()
    const ordered = guard.orderParts(message.parts.slice())
    const textParts = ordered.filter((p): p is TextPart => p.type === "text")
    const text = textParts.map((p) => p.text).join("")
    const full = ordered
      .map((p) => {
        switch (p.type) {
          case "text":
            return p.text
          case "reasoning":
            return `[reasoning] ${p.text}`
          case "step-start":
            return "[step-start]"
          case "step-finish":
            return "[step-finish]"
          default:
            return ""
        }
      })
      .join("")
    return { text, full }
  }

  /**
   * Compute the full conversation output: each message's parts, output text,
   * and the step boundaries. Steps are computed from the ORIGINAL part order
   * (not the display-sorted order) so `step-start` markers correctly delimit
   * which text belongs to which step.
   */
  static conversation(messages: Array<MessageJSON>): ConversationOutput {
    const outputs = messages.map((m) => Renderer.outputText(m))
    const steps: Array<StepOutput> = []
    let current: StepOutput | null = null

    for (const message of messages) {
      if (message.role !== "assistant") continue
      // Use original order for step delimiting — display order sorts text
      // before step-start, which would break step boundaries.
      for (const part of message.parts) {
        if (part.type === "step-start") {
          current = { parts: [], text: "", full: "", toolOrder: [] }
          steps.push(current)
        }
        if (current) {
          current.parts.push(part)
          if (part.type === "text") current.text += part.text
          if (part.type === "tool") current.toolOrder.push(part.toolName)
        }
      }
      if (current) {
        const textParts = current.parts.filter((p): p is TextPart => p.type === "text")
        current.full = textParts.map((p) => p.text).join("")
      }
    }

    return { messages, outputs, steps }
  }

  /**
   * Emit the UI stream parts for a single JSON message. In `passthrough`
   * mode, the parts go out in their final display order. In `json` mode, the
   * parts are mapped to `UiMessageStreamPart`s, with `text-start`/
   * `text-delta`/`text-end` triples synthesized around any provider
   * `toTextDelta` chunks.
   */
  toUIStreamParts(
    message: MessageJSON,
    writer: { write(part: UiMessageStreamPart): void },
    options: ToUIStreamPartsOptions = {},
  ): void {
    const mode = options.mode ?? "passthrough"
    const guard = this.guard
    guard.noteStart()

    const ordered = guard.orderParts(message.parts.slice())

    for (const part of ordered) {
      switch (part.type) {
        case "step-start": {
          guard.noteStepStart()
          if (mode === "passthrough") {
            writer.write({ type: "start-step" })
          } else {
            emitUiStreamPart(guard, mode, "step-start", part, writer)
          }
          break
        }
        case "step-finish": {
          if (mode === "passthrough") {
            writer.write({ type: "finish-step" })
          } else {
            emitUiStreamPart(guard, mode, "step-finish", part, writer)
          }
          emitStepBoundary(guard, writer)
          break
        }
        case "text": {
          guard.noteText()
          emitUiStreamPart(guard, mode, "text", part, writer)
          break
        }
        case "reasoning": {
          emitUiStreamPart(guard, mode, "reasoning", part, writer)
          break
        }
        case "synthetic": {
          if (part.syntheticType === "text-delta") {
            emitSyntheticTextDelta(guard, part.text, writer)
          }
          break
        }
        case "tool": {
          emitUiStreamPart(guard, mode, "tool-activity", part, writer)
          break
        }
        case "source-url":
        case "source-document": {
          emitUiStreamPart(guard, mode, part.type, part, writer)
          break
        }
        default:
          break
      }
    }

    // Flush anything still deferred (e.g. the last step ended without a
    // step-finish).
    for (const entry of guard.flushDeferred()) {
      const mapped = entry.role === "step-start" ? ({ type: "start-step" } as UiMessageStreamPart) : null
      if (mapped) {
        writer.write(mapped)
      } else if (mode === "passthrough") {
        writer.write(entry.part as UiMessageStreamPart)
      }
    }

    writer.write({ type: "finish" })
  }

  /**
   * Bridge a provider `toTextDelta` chunk into the JSON output as a
   * `SyntheticTextDelta` part, and into the UI stream as a balanced
   * `text-start`/`text-delta`/`text-end` triple.
   */
  static bridgeTextDelta(
    guard: OutputOrderGuard,
    chunk: ToTextDeltaChunk,
    writer: { write(part: UiMessageStreamPart): void },
    options: ToUIStreamPartsOptions = {},
  ): Part {
    const part = makeSyntheticTextDelta(chunk.textDelta)
    if (options.mode === "json") {
      emitSyntheticTextDelta(guard, chunk.textDelta, writer)
    }
    return part
  }

  /**
   * Bridge a provider `step-start` chunk into the JSON output as a
   * `StepStartPart`, and into the UI stream as a `start-step`.
   */
  static bridgeStepStart(
    guard: OutputOrderGuard,
    _chunk: StepStartPartData,
    writer: { write(part: UiMessageStreamPart): void },
  ): StepStartPart {
    guard.noteStepStart()
    writer.write({ type: "start-step" })
    return { type: "step-start" }
  }

  /**
   * Bridge a provider `step-finish` chunk into the JSON output as a
   * `StepFinishPart`, and into the UI stream as a `finish-step`.
   */
  static bridgeStepFinish(
    guard: OutputOrderGuard,
    chunk: StepFinishPartData,
    writer: { write(part: UiMessageStreamPart): void },
  ): StepFinishPart {
    writer.write({ type: "finish-step" })
    emitStepBoundary(guard, writer)
    return {
      type: "step-finish",
      finishReason: chunk.finishReason,
      usage: chunk.usage,
    }
  }

  /**
   * Bridge a provider `tool-call` chunk into the JSON output as a `ToolPart`,
   * and into the UI stream as a `tool-input-available`.
   */
  static bridgeToolCall(
    guard: OutputOrderGuard,
    chunk: ToolCallPartData,
    writer: { write(part: UiMessageStreamPart): void },
  ): ToolPart {
    const toolPart: ToolPart = {
      type: "tool",
      toolCallId: chunk.toolCallId,
      toolName: chunk.toolName,
      state: "call",
      input: chunk.input,
      toolInvocation: {
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        state: "call",
        args: chunk.input,
      },
    }
    emitUiStreamPart(guard, "json", "tool-activity", toolPart, writer)
    return toolPart
  }

  /**
   * Bridge a provider `tool-result` chunk into the JSON output as a
   * `ToolPart` with `state: "result"`, and into the UI stream as a
   * `tool-output-available`.
   */
  static bridgeToolResult(
    guard: OutputOrderGuard,
    chunk: ToolResultPartData,
    writer: { write(part: UiMessageStreamPart): void },
  ): ToolPart {
    const toolPart: ToolPart = {
      type: "tool",
      toolCallId: chunk.toolCallId,
      toolName: chunk.toolName,
      state: "result",
      output: chunk.output,
      toolInvocation: {
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        state: "result",
        result: chunk.output,
      },
    }
    emitUiStreamPart(guard, "json", "tool-activity", toolPart, writer)
    return toolPart
  }
}
