/**
 * MockLLM: a lightweight LLM.Service mock that emits pre-canned stream events.
 * No HTTP server, no AI SDK, no provider resolution needed.
 *
 * Records full trajectory (inputs + outputs) for post-hoc inspection.
 *
 * Usage:
 *   const mock = new MockLLM()
 *   mock.enqueue(textReply("hello"))
 *   mock.enqueue(textWithToolReply("thinking", "check", {q: 1}))
 *   const layer = mock.layer()
 *   // after test:
 *   mock.dumpTrajectory("/tmp/traj.json")
 */
import { Effect, Layer, Stream } from "effect"
import { LLM } from "../../src/session/llm"
import fs from "fs"

// Minimal event shapes that satisfy the processor's switch cases
type MockEvent =
  | { type: "start-step" }
  | { type: "text-start"; providerMetadata?: unknown }
  | { type: "text-delta"; text: string; providerMetadata?: unknown }
  | { type: "text-end"; providerMetadata?: unknown }
  | { type: "reasoning-start"; id: string; providerMetadata?: unknown }
  | { type: "reasoning-delta"; id: string; text: string; providerMetadata?: unknown }
  | { type: "reasoning-end"; id: string; providerMetadata?: unknown }
  | { type: "tool-input-start"; id: string; toolName: string; providerExecuted?: boolean }
  | { type: "tool-input-end" }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown; providerMetadata?: unknown }
  | { type: "tool-result"; toolCallId: string; output: unknown }
  | { type: "finish-step"; finishReason: string; usage: { inputTokens: number; outputTokens: number; reasoningTokens?: number }; providerMetadata?: unknown }

export function textReply(text: string): MockEvent[] {
  return [
    { type: "start-step" },
    { type: "text-start" },
    { type: "text-delta", text },
    { type: "text-end" },
    { type: "finish-step", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } },
  ]
}

export function textWithToolReply(text: string, toolName: string, toolInput: unknown, reasoning?: string): MockEvent[] {
  const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const reasonId = `r_${Date.now()}`
  const events: MockEvent[] = [{ type: "start-step" }]
  if (reasoning) {
    events.push(
      { type: "reasoning-start", id: reasonId },
      { type: "reasoning-delta", id: reasonId, text: reasoning },
      { type: "reasoning-end", id: reasonId },
    )
  }
  events.push(
    { type: "text-start" },
    { type: "text-delta", text },
    { type: "text-end" },
    { type: "tool-input-start", id: callId, toolName },
    { type: "tool-input-end" },
    { type: "tool-call", toolCallId: callId, toolName, input: toolInput },
    { type: "tool-result", toolCallId: callId, output: `mock result for ${toolName}` },
    { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 10, outputTokens: 5 } },
  )
  return events
}

export interface TrajectoryStep {
  step: number
  input: {
    sessionID: string
    agentID?: string
    system: string[]
    messages: unknown[]  // ModelMessage[]
    tools: string[]      // tool names available
  }
  output: {
    events: MockEvent[]
    finishReason: string
    text: string | null
    toolCalls: Array<{ name: string; input: unknown }>
  }
}

export class MockLLM {
  #queue: MockEvent[][] = []
  #calls = 0
  #trajectory: TrajectoryStep[] = []

  /** Enqueue a reply (array of events) for the next stream() call */
  enqueue(...replies: MockEvent[][]) {
    this.#queue.push(...replies)
  }

  /** How many times stream() was called */
  get calls() {
    return this.#calls
  }

  /** Get the recorded trajectory */
  get trajectory(): TrajectoryStep[] {
    return this.#trajectory
  }

  /** Reset state between tests */
  reset() {
    this.#queue = []
    this.#calls = 0
    this.#trajectory = []
  }

  /** Dump trajectory to a JSON file */
  dumpTrajectory(filePath: string) {
    fs.writeFileSync(filePath, JSON.stringify(this.#trajectory, null, 2), "utf-8")
  }

  /** Build a Layer<LLM.Service> that uses this mock */
  layer(): Layer.Layer<LLM.Service> {
    const self = this
    return Layer.succeed(
      LLM.Service,
      LLM.Service.of({
        stream: (input) => {
          self.#calls++
          const events = self.#queue.shift() ?? textReply("ok")

          // Extract summary from events for trajectory
          const textParts = events.filter((e) => e.type === "text-delta").map((e) => (e as any).text)
          const toolCalls = events
            .filter((e) => e.type === "tool-call")
            .map((e) => ({ name: (e as any).toolName, input: (e as any).input }))
          const finish = events.find((e) => e.type === "finish-step")
          const finishReason = finish ? (finish as any).finishReason : "unknown"

          // Record trajectory step
          self.#trajectory.push({
            step: self.#calls,
            input: {
              sessionID: input.sessionID,
              agentID: input.agentID,
              system: input.system,
              messages: input.messages,
              tools: Object.keys(input.tools),
            },
            output: {
              events,
              finishReason,
              text: textParts.length > 0 ? textParts.join("") : null,
              toolCalls,
            },
          })

          return Stream.fromIterable(events) as any
        },
        buildSystemArray: (_input) => Effect.succeed([]),
      }),
    )
  }
}
