/**
 * Stub LLM HTTP server fixture for integration tests.
 *
 * The AppRuntime bakes in LLM.defaultLayer at construction time, so
 * Effect.provideService(LLM.Service, fake) cannot override the service after
 * the fact. The established pattern in this codebase (see prompt.test.ts,
 * llm-system-prompt.test.ts) is to spin up a Bun.serve HTTP mock that speaks
 * OpenAI-compatible SSE, then point the project config's provider.baseURL at
 * that mock.
 *
 * This module provides a ScriptedLLMServer that accepts a queue of scripted
 * responses and records the full request body of every call. It mirrors the
 * request mode: SSE for `stream: true`, JSON for non-stream requests.
 */

export interface LLMCapture {
  /** Raw messages array from the OpenAI-compatible request body */
  messages: Array<{ role: string; content: unknown }>
  /** Whether the caller requested SSE. */
  stream: boolean
}

type ScriptedResponse = {
  /** SSE lines to stream back */
  lines: string[]
  /** HTTP status to return (default: 200) */
  status?: number
}

function sseChunk(delta: Record<string, unknown>, finishReason?: string): string {
  const payload = {
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    choices: [
      {
        delta,
        ...(finishReason ? { finish_reason: finishReason } : {}),
      },
    ],
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** Build SSE lines for a plain text stop response */
export function textStopResponse(text: string): string[] {
  return [
    sseChunk({ role: "assistant" }),
    sseChunk({ content: text }),
    sseChunk({}, "stop"),
    "data: [DONE]\n\n",
  ]
}

/**
 * Build SSE lines for a step that finishes with `finish_reason: "stop"` but emits
 * no content/tool/reasoning at all — the "empty" case (T01).
 */
export function emptyStopResponse(): string[] {
  return [sseChunk({ role: "assistant" }), sseChunk({}, "stop"), "data: [DONE]\n\n"]
}

/**
 * Build SSE lines for a "think-only" step: reasoning deltas (OpenAI-compatible
 * `reasoning_content`) followed by `finish_reason: "stop"`, with no text or tool
 * call. Exercises the T01 think-only continuation path.
 */
export function reasoningStopResponse(reasoning: string): string[] {
  return [
    sseChunk({ role: "assistant" }),
    sseChunk({ reasoning_content: reasoning }),
    sseChunk({}, "stop"),
    "data: [DONE]\n\n",
  ]
}

/** Build SSE lines for reasoning-only output that exhausted the output token budget */
export function reasoningLengthResponse(reasoning: string): string[] {
  return [
    sseChunk({ role: "assistant" }),
    sseChunk({ reasoning_content: reasoning }),
    sseChunk({}, "length"),
    "data: [DONE]\n\n",
  ]
}

/**
 * Build SSE lines for a step halted by the provider's content safety filter
 * (`finish_reason: "content_filter"`, mapped to unified "content-filter").
 * `text` is optional partial content emitted before the filter fired.
 */
export function contentFilterResponse(text = ""): string[] {
  return [
    sseChunk({ role: "assistant" }),
    ...(text ? [sseChunk({ content: text })] : []),
    sseChunk({}, "content_filter"),
    "data: [DONE]\n\n",
  ]
}

/**
 * Build SSE lines for a step that emits usable text but finishes with an
 * unrecognized `finish_reason`. The openai-compatible provider maps any unknown
 * reason to unified "other" (see mapOpenAICompatibleFinishReason default branch),
 * so this exercises the T03 `other` + non-empty text degraded-final path.
 */
export function otherFinishResponse(text: string, finishReason = "guardrail"): string[] {
  return [sseChunk({ role: "assistant" }), sseChunk({ content: text }), sseChunk({}, finishReason), "data: [DONE]\n\n"]
}

/** Build SSE lines for a plain text response that hits the output token limit */
export function textLengthResponse(text: string): string[] {
  return [
    sseChunk({ role: "assistant" }),
    sseChunk({ content: text }),
    sseChunk({}, "length"),
    "data: [DONE]\n\n",
  ]
}

/** Build SSE lines for a tool-call response (finish_reason: tool_calls) */
export function toolCallResponse(params: {
  id: string
  name: string
  args: string
}): string[] {
  return [
    sseChunk({ role: "assistant" }),
    sseChunk({
      tool_calls: [
        {
          index: 0,
          id: params.id,
          type: "function",
          function: { name: params.name, arguments: "" },
        },
      ],
    }),
    sseChunk({
      tool_calls: [{ index: 0, function: { arguments: params.args } }],
    }),
    sseChunk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ]
}

/**
 * Build SSE lines for a complete tool call that finishes with
 * `finish_reason: "length"` (provider emits a full client tool call, then caps
 * the step on output tokens). Exercises the T05 "length + tool" contract:
 * autoContinueOutputLength must NOT inject an output-length continuation; the
 * loop continues via the normal tool-observation path instead.
 */
export function toolCallLengthResponse(params: { id: string; name: string; args: string }): string[] {
  return [
    sseChunk({ role: "assistant" }),
    sseChunk({
      tool_calls: [
        {
          index: 0,
          id: params.id,
          type: "function",
          function: { name: params.name, arguments: "" },
        },
      ],
    }),
    sseChunk({
      tool_calls: [{ index: 0, function: { arguments: params.args } }],
    }),
    sseChunk({}, "length"),
    "data: [DONE]\n\n",
  ]
}

/**
 * Build SSE lines for a tool-call that finishes with `finish_reason: "stop"`
 * (provider misreports "stop" while a client tool call is still pending). Used
 * to exercise the classifier's core guarantee: any finish + pending client
 * tool part => continue.
 */
export function toolCallStopResponse(params: { id: string; name: string; args: string }): string[] {
  return [
    sseChunk({ role: "assistant" }),
    sseChunk({
      tool_calls: [
        {
          index: 0,
          id: params.id,
          type: "function",
          function: { name: params.name, arguments: "" },
        },
      ],
    }),
    sseChunk({
      tool_calls: [{ index: 0, function: { arguments: params.args } }],
    }),
    sseChunk({}, "stop"),
    "data: [DONE]\n\n",
  ]
}

export interface ScriptedLLMServer {
  /** Origin URL of the mock server, e.g. http://127.0.0.1:PORT */
  readonly origin: string
  /** Captures one entry per HTTP request, in order */
  readonly captures: LLMCapture[]
  /** Stop the Bun server */
  stop(): Promise<void>
}

/**
 * Start a Bun HTTP mock server that streams scripted SSE responses.
 *
 * Each request to /chat/completions (or similar path) consumes the next
 * entry from `responses`. If responses run out the last entry is repeated.
 * All request bodies are pushed to `captures`.
 */
export function startScriptedLLMServer(responses: ScriptedResponse[]): ScriptedLLMServer {
  const captures: LLMCapture[] = []
  let callIdx = 0

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 })
      }

      const body = (await req.json()) as {
        messages: Array<{ role: string; content: unknown }>
        stream?: boolean
      }
      captures.push({ messages: body.messages, stream: body.stream === true })

      const response = responses[Math.min(callIdx, responses.length - 1)]
      callIdx++

      const lines = response.lines
      if (body.stream !== true && (response.status ?? 200) < 400) {
        const deltas = lines.flatMap((line) => {
          const payload = line.trim().replace(/^data:\s*/, "")
          if (!payload || payload === "[DONE]") return []
          return [JSON.parse(payload) as {
            choices: Array<{
              delta: {
                role?: string
                content?: string
                reasoning_content?: string
                tool_calls?: Array<{
                  index: number
                  id?: string
                  type?: string
                  function?: { name?: string; arguments?: string }
                }>
              }
              finish_reason?: string
            }>
          }]
        })
        const toolCalls = new Map<
          number,
          { id: string; type: string; function: { name: string; arguments: string } }
        >()
        for (const item of deltas) {
          for (const call of item.choices[0]?.delta.tool_calls ?? []) {
            const current = toolCalls.get(call.index) ?? {
              id: "",
              type: "function",
              function: { name: "", arguments: "" },
            }
            toolCalls.set(call.index, {
              id: call.id ?? current.id,
              type: call.type ?? current.type,
              function: {
                name: call.function?.name ?? current.function.name,
                arguments: current.function.arguments + (call.function?.arguments ?? ""),
              },
            })
          }
        }
        const content = deltas.map((item) => item.choices[0]?.delta.content ?? "").join("")
        const reasoning = deltas.map((item) => item.choices[0]?.delta.reasoning_content ?? "").join("")
        const finishReason = deltas.findLast((item) => item.choices[0]?.finish_reason)?.choices[0]?.finish_reason ?? "stop"
        return Response.json(
          {
            id: "chatcmpl-stub",
            object: "chat.completion",
            created: 0,
            model: "stub",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: content || null,
                  ...(reasoning ? { reasoning_content: reasoning } : {}),
                  ...(toolCalls.size > 0 ? { tool_calls: Array.from(toolCalls.values()) } : {}),
                },
                finish_reason: finishReason,
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
          { status: response.status ?? 200 },
        )
      }
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          for (const line of lines) ctrl.enqueue(encoder.encode(line))
          ctrl.close()
        },
      })

      return new Response(stream, {
        status: response.status ?? 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    },
  })

  return {
    get origin() {
      return server.url.origin
    },
    captures,
    stop: () => server.stop(true),
  }
}
