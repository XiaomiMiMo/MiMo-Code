import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { ElicitRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Exit, Fiber } from "effect"
import type { EffectBridge } from "@/effect"
import { Question } from "@/question"
import { SessionID } from "@/session/schema"

export * as McpElicitation from "./elicitation"

interface Call {
  sessionID?: SessionID
  controller: AbortController
}
const calls = new WeakMap<Client, Set<Call>>()

// MCP elicitation carries no parent tools/call ID. Never use a last-session-wins
// pointer: overlapping calls are ambiguous, including after one has finished.
export function beginCall(client: Client, sessionID?: string, signal?: AbortSignal) {
  const active = calls.get(client) ?? new Set<Call>()
  calls.set(client, active)
  const call: Call = { sessionID: sessionID ? SessionID.make(sessionID) : undefined, controller: new AbortController() }
  const abort = () => call.controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  if (active.size) {
    for (const other of active) other.controller.abort()
    abort()
  }
  active.add(call)
  return () => {
    abort()
    signal?.removeEventListener("abort", abort)
    active.delete(call)
  }
}

export function cancelAll(client: Client) {
  for (const call of calls.get(client) ?? []) call.controller.abort()
}

export function serve(server: string, client: Client, bridge: EffectBridge.Shape) {
  const onclose = client.onclose
  client.onclose = () => {
    cancelAll(client)
    onclose?.()
  }
  client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
    const params = request.params
    if (
      params.mode === "url" ||
      Object.keys(params.requestedSchema.properties).length ||
      params.requestedSchema.required?.length
    ) {
      throw new McpError(ErrorCode.InvalidParams, "Only empty confirmation forms are supported by this client.")
    }
    const active = calls.get(client)
    const call = active?.size === 1 ? [...active][0] : undefined
    if (!call?.sessionID || call.controller.signal.aborted || extra.signal.aborted) return { action: "cancel" }
    const subtitle = params._meta?.subtitle
    const fiber = bridge.fork(
      Effect.gen(function* () {
        const question = yield* Question.Service
        return yield* question.ask({
          sessionID: call.sessionID!,
          questions: [
            {
              key: "mcp_elicitation",
              header: server,
              question: [server, params.message, typeof subtitle === "string" ? subtitle : ""]
                .filter(Boolean)
                .join("\n\n"),
              options: [
                { label: "Accept", description: "" },
                { label: "Decline", description: "" },
                { label: "Cancel", description: "" },
              ],
              multiple: false,
              custom: false,
            },
          ],
        })
      }),
    )
    const signal = AbortSignal.any([call.controller.signal, extra.signal])
    const abort = () => {
      void Effect.runPromise(Fiber.interrupt(fiber))
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    try {
      const result = await Effect.runPromise(Fiber.await(fiber))
      if (signal.aborted || !Exit.isSuccess(result)) return { action: "cancel" }
      const answers = result.value
      if (answers.length !== 1 || answers[0].length !== 1) return { action: "cancel" }
      if (answers[0][0] === "Accept") return { action: "accept", content: {} }
      if (answers[0][0] === "Decline") return { action: "decline" }
      return { action: "cancel" }
    } finally {
      signal.removeEventListener("abort", abort)
    }
  })
}
