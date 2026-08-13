import z from "zod"
import type { FinishReason, LanguageModelUsage, ModelMessage } from "ai"

/**
 * OpenAI Chat Completions wire protocol, and its translation to/from the AI SDK
 * shapes MiMoCode already speaks.
 *
 * Unknown fields are IGNORED rather than rejected. Real OpenAI client libraries
 * send `parallel_tool_calls`, `store`, `metadata`, and `service_tier`
 * unconditionally, and the whole point of this server is that a stock client can
 * be pointed at it by changing `base_url` alone — so a caller who asked for
 * nothing unsupported must not be turned away over a field we merely don't read.
 *
 * A field is REJECTED (see `unsupported`) only when honoring it is impossible AND
 * ignoring it would silently return the wrong shape or quantity of result. A
 * silently-dropped `response_format` yields a plausible-looking answer in the
 * wrong shape with no signal to the caller; that is the case worth a 400.
 */

const ContentPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({
      // Parseability is checked HERE so an unparseable URL is a 400 from
      // validation rather than a 502 from `new URL` throwing inside the handler.
      // `URL.canParse` accepts `data:` URLs too, so both accepted forms pass.
      url: z.string().refine(URL.canParse, "must be a data: URL or an absolute URL"),
      detail: z.string().optional(),
    }),
  }),
])

const ToolCall = z.object({
  id: z.string(),
  type: z.literal("function").optional(),
  function: z.object({ name: z.string(), arguments: z.string() }),
})

const TextContent = z.union([z.string(), z.array(z.object({ type: z.literal("text"), text: z.string() }))])

// Discriminated on `role` so that narrowing in `toModelMessages` actually
// eliminates members; a plain `z.union` leaves every branch live and the
// role-specific fields (`tool_calls`, `tool_call_id`) unreachable.
const Message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: TextContent, name: z.string().optional() }),
  z.object({ role: z.literal("developer"), content: TextContent, name: z.string().optional() }),
  z.object({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(ContentPart)]),
    name: z.string().optional(),
  }),
  z.object({
    role: z.literal("assistant"),
    content: z.union([TextContent, z.null()]).optional(),
    tool_calls: z.array(ToolCall).optional(),
    name: z.string().optional(),
  }),
  z.object({
    role: z.literal("tool"),
    content: TextContent,
    tool_call_id: z.string(),
  }),
])

export const ChatCompletionRequest = z
  .object({
    model: z.string().min(1),
    messages: z.array(Message).min(1),
    tools: z
      .array(
        z.object({
          type: z.literal("function").optional(),
          function: z.object({
            name: z.string(),
            description: z.string().optional(),
            parameters: z.record(z.string(), z.unknown()).optional(),
          }),
        }),
      )
      .optional(),
    tool_choice: z
      .union([
        z.enum(["auto", "none", "required"]),
        z.object({ type: z.literal("function"), function: z.object({ name: z.string() }) }),
      ])
      .optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    top_k: z.number().int().positive().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    seed: z.number().int().optional(),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
    // Accepted-and-ignored: identifies the caller, never reaches the provider.
    user: z.string().optional(),
    // Accepted only at their no-op defaults; see `unsupported`.
    n: z.number().int().optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
    logprobs: z.boolean().nullish(),
    top_logprobs: z.number().int().nullish(),
    logit_bias: z.record(z.string(), z.number()).nullish(),
    response_format: z.unknown().optional(),
    // Escape hatch for MiMoCode/provider-native knobs (reasoning effort, thinking
    // budgets, cache controls) that have no OpenAI equivalent.
    //
    // FLAT, keyed by the provider-native option name — not keyed by provider.
    // `ProviderTransform.options()` produces a flat map and
    // `ProviderTransform.providerOptions()` is what nests it under the SDK's
    // namespace, so a nested value here would be nested twice and silently
    // ignored by the provider.
    provider_options: z.record(z.string(), z.json()).optional(),
  })
  // No `.strict()`: zod strips unknown keys, which is the documented policy above.
  // Fields that must not be silently dropped are caught by `unsupported` instead.
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequest>

/**
 * Fields we refuse rather than ignore, with the reason surfaced to the caller.
 *
 * Each entry fires only when the field would actually alter the result: `n: 1`
 * and a zero penalty are what an untouched OpenAI client sends, so they are not
 * a request for anything. `response_format` has no honest mapping onto
 * `streamText` — structured output needs a different SDK entrypoint — so it is
 * rejected until that path exists.
 */
export function unsupported(req: ChatCompletionRequest): string | undefined {
  if (req.n != null && req.n !== 1) return "n > 1 is not supported; request one completion at a time"
  if (req.logprobs) return "logprobs is not supported"
  if (req.top_logprobs != null) return "top_logprobs is not supported"
  if (req.logit_bias && Object.keys(req.logit_bias).length > 0) return "logit_bias is not supported"
  if (req.response_format != null) return "response_format is not supported; ask the model for JSON in the prompt"
  return undefined
}

const toText = (content: string | Array<{ type: "text"; text: string }>) =>
  typeof content === "string" ? content : content.map((part) => part.text).join("")

/**
 * Decode an OpenAI `image_url` into the AI SDK's image part.
 *
 * `data:` URLs carry the bytes inline and must be handed over as base64 data
 * (with the media type preserved, since some providers require it); anything
 * else is a reference the provider fetches itself, so it stays a URL.
 */
function imagePart(url: string) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (match) return { type: "image" as const, image: match[2], mediaType: match[1] }
  return { type: "image" as const, image: new URL(url) }
}

/**
 * OpenAI messages → AI SDK `ModelMessage[]`.
 *
 * Two shape mismatches are worth naming. OpenAI puts tool results in their own
 * `role: "tool"` messages keyed by `tool_call_id` and omits the tool name; the
 * SDK's `ToolResultPart` requires `toolName`, so the name is recovered from the
 * assistant `tool_calls` seen earlier in the same conversation. And an assistant
 * turn may carry text and tool calls at once, which becomes one assistant
 * message with both part kinds.
 */
export function toModelMessages(messages: ChatCompletionRequest["messages"]): ModelMessage[] {
  const toolNames = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    for (const call of msg.tool_calls ?? []) toolNames.set(call.id, call.function.name)
  }

  return messages.map((msg): ModelMessage => {
    if (msg.role === "system" || msg.role === "developer") return { role: "system", content: toText(msg.content) }

    if (msg.role === "user") {
      if (typeof msg.content === "string") return { role: "user", content: msg.content }
      return {
        role: "user",
        content: msg.content.map((part) =>
          part.type === "text" ? { type: "text" as const, text: part.text } : imagePart(part.image_url.url),
        ),
      }
    }

    if (msg.role === "tool") {
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: msg.tool_call_id,
            toolName: toolNames.get(msg.tool_call_id) ?? "unknown",
            output: { type: "text", value: toText(msg.content) },
          },
        ],
      }
    }

    const text = msg.content == null ? "" : toText(msg.content)
    const calls = (msg.tool_calls ?? []).map((call) => ({
      type: "tool-call" as const,
      toolCallId: call.id,
      toolName: call.function.name,
      input: parseArguments(call.function.arguments),
    }))
    if (calls.length === 0) return { role: "assistant", content: text }
    return {
      role: "assistant",
      content: [...(text ? [{ type: "text" as const, text }] : []), ...calls],
    }
  })
}

/**
 * Tool-call arguments arrive as a JSON *string*, and a model can emit one that
 * does not parse. Preserving the raw text beats throwing: the request is
 * replaying history the model itself produced, and rejecting it would strand
 * the conversation.
 */
function parseArguments(raw: string): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export function toToolChoice(choice: ChatCompletionRequest["tool_choice"]) {
  if (choice == null) return undefined
  if (typeof choice === "string") return choice
  return { type: "tool" as const, toolName: choice.function.name }
}

export function finishReason(reason: FinishReason | undefined) {
  if (reason === "tool-calls") return "tool_calls"
  if (reason === "length") return "length"
  if (reason === "content-filter") return "content_filter"
  return "stop"
}

export function usage(value: LanguageModelUsage | undefined) {
  const input = value?.inputTokens ?? 0
  const output = value?.outputTokens ?? 0
  const cached = value?.inputTokenDetails?.cacheReadTokens
  const reasoning = value?.outputTokenDetails?.reasoningTokens
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: value?.totalTokens ?? input + output,
    ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(reasoning ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
  }
}

export function completionID() {
  return `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`
}

export type EmittedToolCall = { id: string; name: string; input: unknown }

export function completion(input: {
  id: string
  model: string
  created: number
  text: string
  reasoning?: string
  toolCalls: EmittedToolCall[]
  finishReason: FinishReason | undefined
  usage: LanguageModelUsage | undefined
}) {
  return {
    id: input.id,
    object: "chat.completion",
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: input.text || null,
          ...(input.reasoning ? { reasoning_content: input.reasoning } : {}),
          ...(input.toolCalls.length
            ? {
                tool_calls: input.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
                })),
              }
            : {}),
        },
        logprobs: null,
        finish_reason: finishReason(input.finishReason),
      },
    ],
    usage: usage(input.usage),
  }
}

/**
 * One `chat.completion.chunk`. `delta` is passed through verbatim so a caller
 * can emit a role-only opener, a text delta, a partial `tool_calls` entry, or
 * the empty delta that accompanies a terminal `finish_reason`.
 */
export function chunk(input: {
  id: string
  model: string
  created: number
  delta: Record<string, unknown>
  finishReason?: FinishReason | undefined
  usage?: LanguageModelUsage
}) {
  return {
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        delta: input.delta,
        logprobs: null,
        finish_reason: input.finishReason === undefined ? null : finishReason(input.finishReason),
      },
    ],
    ...(input.usage ? { usage: usage(input.usage) } : {}),
  }
}

/**
 * A usage-only chunk, sent when the caller asked for
 * `stream_options.include_usage`. OpenAI sends it after the final
 * `finish_reason` chunk and gives it an EMPTY `choices` array.
 */
export function usageChunk(input: { id: string; model: string; created: number; usage: LanguageModelUsage }) {
  return {
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
    choices: [],
    usage: usage(input.usage),
  }
}

export function errorBody(input: { message: string; type: string; code?: string; param?: string }) {
  return {
    error: {
      message: input.message,
      type: input.type,
      param: input.param ?? null,
      code: input.code ?? null,
    },
  }
}

/**
 * OpenAI `POST /v1/audio/speech`.
 *
 * `response_format` is the caller's request for a container, not a guarantee: the
 * SDK forwards it as `outputFormat` and a provider may answer in a different one,
 * which is why the response content type is derived from what came back rather
 * than from what was asked for (see `speechContentType`).
 */
export const SpeechRequest = z.object({
  model: z.string().min(1),
  input: z.string().min(1),
  voice: z.string().optional(),
  response_format: z.enum(["mp3", "opus", "aac", "flac", "wav", "pcm"]).optional(),
  speed: z.number().min(0.25).max(4).optional(),
  instructions: z.string().optional(),
  // OpenAI's streaming TTS knob. Declared so it can be REFUSED rather than
  // ignored: the AI SDK has `generateSpeech` and no `streamSpeech`, so honoring
  // it is impossible and silently returning one buffer would strand a client
  // that is waiting to read incremental frames.
  stream_format: z.enum(["sse", "audio"]).optional(),
  // Flat, for the same reason as the chat route's field of the same name.
  provider_options: z.record(z.string(), z.json()).optional(),
})
export type SpeechRequest = z.infer<typeof SpeechRequest>

export function speechUnsupported(req: SpeechRequest): string | undefined {
  if (req.stream_format === "sse") return "stream_format: sse is not supported; audio is returned as one complete body"
  return undefined
}

const SPEECH_MEDIA_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  opus: "audio/opus",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "audio/pcm",
}

/**
 * Content type for a synthesized audio body.
 *
 * The provider's own reported media type wins, because it describes the bytes
 * that actually exist. The requested format is only a fallback for providers that
 * report nothing, and `application/octet-stream` is the last resort — mislabeling
 * audio is worse than declining to name it.
 */
export function speechContentType(input: { reported?: string; requested?: string }) {
  if (input.reported) return input.reported
  if (input.requested) return SPEECH_MEDIA_TYPES[input.requested] ?? "application/octet-stream"
  return SPEECH_MEDIA_TYPES.mp3!
}

