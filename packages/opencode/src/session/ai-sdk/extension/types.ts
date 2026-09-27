import type {
  ReasoningUIPart,
  SourceUrlUIPart,
  SourceDocumentUIPart,
  ToolUIPart,
} from "ai"

/** A text part in the persisted JSON. */
export interface TextPart {
  type: "text"
  text: string
  id?: string
  providerMetadata?: Record<string, unknown>
}

/** A reasoning part in the persisted JSON. */
export interface ReasoningPart {
  type: "reasoning"
  text: string
  id?: string
}

/** A tool part in the persisted JSON (AI SDK toolInvocation shape). */
export interface ToolPart {
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

/** A step-start marker in the persisted JSON. */
export interface StepStartPart {
  type: "step-start"
}

/** A step-finish marker in the persisted JSON. */
export interface StepFinishPart {
  type: "step-finish"
  finishReason?: string
  usage?: Record<string, unknown>
}

/** A redacted reasoning block (provider-specific). */
export interface RedactedReasoningPart {
  type: "redacted-reasoning"
  data: string
}

/**
 * A text chunk the Renderer synthesized from an AI SDK `toTextDelta` chunk.
 * Recorded in the JSON output so the UI stream can emit a balanced
 * `text-start`/`text-delta`/`text-end` triple.
 */
export interface SyntheticTextDelta {
  type: "synthetic"
  syntheticType: "text-delta"
  text: string
  source: "ai-sdk"
}

/** An agent part (spawned sub-agent). */
export interface AgentPart {
  type: "agent"
  agentType: string
  callId?: string
  status?: string
  title?: string
  body?: string
  result?: unknown
}

/** Any part the Renderer can carry. */
export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | AgentPart
  | StepStartPart
  | StepFinishPart
  | RedactedReasoningPart
  | SourceUrlUIPart
  | SourceDocumentUIPart
  | SyntheticTextDelta
  | ToolUIPart

/** The display role of a part. */
export type PartRole =
  | "text"
  | "reasoning"
  | "source-url"
  | "source-document"
  | "tool-activity"
  | "tool-input-start"
  | "tool-input-available"
  | "tool-output-available"
  | "tool-output-error"
  | "tool-output-denied"
  | "step-start"
  | "step-finish"
  | "synthetic"
  | "agent"
