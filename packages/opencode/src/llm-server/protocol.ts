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

/**
 * The only `data:` form this server can carry, shared by the validator and the
 * converter so the two cannot drift apart.
 *
 * A `data:` URL without `;base64,` — `data:image/svg+xml,<svg/>` — is a real thing
 * clients send. The AI SDK intercepts any `data:` URL and tries to base64-decode it,
 * so an un-encoded one throws "The string contains invalid characters" deep inside
 * the call and surfaced as a 502. Validating against the exact same pattern the
 * converter uses turns that into a 400 that says what is wrong.
 */
const DATA_URL = /^data:([^;,]+);base64,(.*)$/s

function acceptableImageUrl(value: string) {
  if (!URL.canParse(value)) return false
  if (!value.startsWith("data:")) return true
  return DATA_URL.test(value)
}

const ContentPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    // OpenAI's audio-input part, which `gpt-4o-audio-preview`, MiMo, and Gemini all
    // accept. Distinct from transcription: this is audio a caller wants REASONED
    // about ("what did they agree to?"), which needs an instruction alongside it and
    // returns an answer rather than the words.
    type: z.literal("input_audio"),
    input_audio: z.object({
      /** Base64, or a `data:` URL. The container is named by `format` or the URL. */
      data: z.string().min(1),
      format: z.enum(["wav", "mp3", "mpeg", "m4a", "flac", "ogg", "webm"]).optional(),
    }),
  }),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({
      // Checked HERE so a URL this server cannot carry is a 400 from validation
      // rather than an opaque 5xx from somewhere inside the provider call.
      url: z
        .string()
        .refine(acceptableImageUrl, "must be an absolute URL or a base64-encoded `data:` URL"),
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
    // Accepted so a multi-turn conversation with a reasoning model can hand its own
    // thinking back. Dropping it silently degrades the next turn, and for providers
    // whose tool use is interleaved with thinking blocks it can break continuity
    // outright. `reasoning_content` is the field name emitted on the way out, so a
    // client can replay verbatim what it received.
    reasoning_content: z.string().optional(),
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
    // Honored by mapping onto whatever the model's provider actually calls it — see
    // `variantFor` in completions.ts. Not a free-form passthrough: an effort the
    // model does not offer is a 400 rather than a silent downgrade.
    reasoning_effort: z.string().optional(),
    // Declared so it can be REFUSED rather than dropped. See `unsupported`.
    verbosity: z.string().optional(),
    // Accepted only at their no-op defaults; see `unsupported`.
    n: z.number().int().optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
    logprobs: z.boolean().nullish(),
    top_logprobs: z.number().int().nullish(),
    logit_bias: z.record(z.string(), z.number()).nullish(),
    response_format: z.unknown().optional(),
    // Escape hatch for provider-native knobs (thinking budgets, cache controls,
    // reasoning summaries) that have no OpenAI equivalent.
    //
    // FLAT, keyed by the SDK's own provider-option name — not keyed by provider.
    // `ProviderTransform.options()` produces a flat map and
    // `ProviderTransform.providerOptions()` nests it under the SDK's namespace, so a
    // per-provider-keyed value here would be nested twice and dropped.
    //
    // Those names are camelCase (`reasoningEffort`, not `reasoning_effort`). A key the
    // SDK does not recognise is discarded without complaint, which is the price of an
    // open passthrough: use `reasoning_effort` instead when a portable spelling exists.
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
  // No provider-agnostic mapping exists for this the way `variants` provides one for
  // reasoning effort, and it demonstrably changes the answer, so silently dropping it
  // is the one outcome that must not happen.
  if (req.verbosity != null)
    return "verbosity is not supported; pass the provider's own option through `provider_options`"
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
/**
 * Decode an OpenAI `input_audio` part into the AI SDK's file part.
 *
 * A media type is REQUIRED by the SDK — it selects the wire format and throws on an
 * unknown one — so a bare base64 payload without `format` cannot be carried. Saying
 * so beats guessing wav and having the provider reject bytes that are not.
 */
function audioPart(part: { data: string; format?: string }) {
  // A `data:` URL names its own type and carries its own payload; a bare base64 string
  // depends on `format` to say what the bytes are.
  const dataUrl = DATA_URL.exec(part.data)
  if (dataUrl) {
    return { type: "file" as const, data: dataUrl[2], mediaType: dataUrl[1] }
  }
  if (!part.format) {
    throw new Error("input_audio requires `format` when `data` is not a data: URL")
  }
  return {
    type: "file" as const,
    data: part.data,
    mediaType: AUDIO_FORMAT_MEDIA_TYPES[part.format] ?? `audio/${part.format}`,
  }
}

const AUDIO_FORMAT_MEDIA_TYPES: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  ogg: "audio/ogg",
  webm: "audio/webm",
}

function imagePart(url: string) {
  const match = DATA_URL.exec(url)
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
        content: msg.content.map((part) => {
          if (part.type === "text") return { type: "text" as const, text: part.text }
          if (part.type === "input_audio") return audioPart(part.input_audio)
          return imagePart(part.image_url.url)
        }),
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
    // Reasoning goes FIRST, matching the order the model produced it: providers that
    // interleave thinking with tool use read the sequence, not just the set.
    const thinking = msg.reasoning_content
      ? [{ type: "reasoning" as const, text: msg.reasoning_content }]
      : []
    if (calls.length === 0 && thinking.length === 0) return { role: "assistant", content: text }
    return {
      role: "assistant",
      content: [...thinking, ...(text ? [{ type: "text" as const, text }] : []), ...calls],
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
  /**
   * Where the timbre comes from. Exactly one source, because a voice has exactly one.
   *
   * A bare string is OpenAI's preset form and stays byte-compatible with it. The object arms
   * are ours, and the shape is not an invention: OpenAI's own `voice` is a union that already
   * admits an object (`{ id }` for a custom voice), so a client library that types this field
   * can express an object arm.
   *
   * A discriminated union rather than sibling `voice_design` / `voice_clone` parameters. That
   * is the whole point: "what if both are supplied" becomes unrepresentable instead of a
   * precedence rule someone has to invent, document, and be surprised by. Two keys inside one
   * object match NEITHER arm under strict parsing, so it is a 400 from the schema rather than
   * hand-written logic.
   *
   * `{ id }` is deliberately absent for now — a voice as a stored resource needs somewhere to
   * store it, and nothing needs that yet. Adding an arm later is backward compatible.
   */
  voice: z
    .union([
      z.string().min(1),
      z.object({ design: z.string().min(1) }).strict(),
      z
        .object({
          clone: z
            .object({
              /** Base64, or a `data:` URL. */
              audio: z.string().min(1),
              format: z.enum(["wav", "mp3", "mpeg"]).optional(),
            })
            .strict(),
        })
        .strict(),
    ])
    .optional(),
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
 * The one media type that carries no information.
 *
 * `generateSpeech` reports `detectMediaType(bytes) ?? "audio/mp3"`, and the
 * detection table spells a successfully sniffed mp3 as `audio/mpeg` — so
 * `audio/mp3` is reached ONLY when sniffing failed. Treating it as authoritative
 * would relabel a flac the caller explicitly asked for as mp3.
 */
const UNDETERMINED_MEDIA_TYPE = "audio/mp3"

/**
 * Content type for a synthesized audio body.
 *
 * A media type the provider genuinely determined wins, because it describes the
 * bytes that actually exist. Failing that, the requested format is the better
 * guess: it is what was actually sent upstream, so it is what the bytes most
 * likely are. `application/octet-stream` is the last resort — mislabeling audio is
 * worse than declining to name it.
 */
export function speechContentType(input: { reported?: string; requested?: string }) {
  if (input.reported && input.reported !== UNDETERMINED_MEDIA_TYPE) return input.reported
  if (input.requested) return SPEECH_MEDIA_TYPES[input.requested] ?? "application/octet-stream"
  // Never the non-standard `audio/mp3` alias, even when that is what was reported.
  return SPEECH_MEDIA_TYPES.mp3
}

/**
 * OpenAI `POST /v1/audio/transcriptions`.
 *
 * The wire form is multipart, not JSON, because that is what the official clients
 * send: `openai.audio.transcriptions.create({ file, model })` builds a form. The
 * route parses the form and validates the non-file fields here.
 */
export const TranscriptionRequest = z.object({
  model: z.string().min(1),
  /** ISO-639-1 hint. Omitted means let the provider detect it. */
  language: z.string().optional(),
  /** Accepted for client compatibility; only `json` and `text` differ in shape. */
  response_format: z.enum(["json", "text", "verbose_json", "srt", "vtt"]).optional(),
  // Declared so it can be REFUSED rather than ignored: a caller who supplies a
  // biasing prompt and silently gets an unbiased transcript cannot tell.
  prompt: z.string().optional(),
  temperature: z.number().optional(),
})
export type TranscriptionRequest = z.infer<typeof TranscriptionRequest>

export function transcriptionUnsupported(req: TranscriptionRequest): string | undefined {
  // A dedicated ASR endpoint refuses text parts outright, so there is nowhere to put
  // a prompt. Measured against MiMo: "ASR request must not include text parts".
  if (req.prompt != null) return "prompt is not supported by transcription models on this server"
  if (req.temperature != null) return "temperature is not supported for transcription"
  if (req.response_format === "verbose_json" || req.response_format === "srt" || req.response_format === "vtt")
    return `response_format ${req.response_format} is not supported; use json or text`
  return undefined
}

/** Audio containers a transcription request may upload, mapped to their media type. */
const TRANSCRIBE_MEDIA_TYPES: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
  mpga: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  flac: "audio/flac",
  ogg: "audio/ogg",
  webm: "audio/webm",
}

/**
 * Historic aliases for the same containers, normalised to the canonical spelling.
 *
 * Not cosmetic. `File` reports a wav upload as `audio/x-wav` on some platforms, and
 * MiMo answers `mime type must be one of: audio/wav, audio/mpeg, audio/mp3. Got:
 * audio/x-wav` — a rejection caused purely by the alias. Passing whatever the
 * platform said through verbatim makes the caller pay for a naming accident.
 */
const MEDIA_TYPE_ALIASES: Record<string, string> = {
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-mpeg": "audio/mpeg",
  "audio/mp3": "audio/mpeg",
  "audio/x-m4a": "audio/mp4",
  "audio/x-flac": "audio/flac",
}

/**
 * Media type for an uploaded file.
 *
 * The upload's own type is preferred when it names audio, after alias normalisation;
 * a form upload from a script frequently reports `application/octet-stream`, in which
 * case the extension is the only signal left. Nothing is guessed beyond that — an
 * unknown container is reported rather than assumed to be wav, because handing a
 * provider mislabelled bytes fails in ways that point at the wrong thing.
 */
export function transcriptionMediaType(input: { reported?: string; filename?: string }) {
  const reported = input.reported?.toLowerCase().split(";")[0]?.trim()
  if (reported) {
    const canonical = MEDIA_TYPE_ALIASES[reported] ?? reported
    if (canonical.startsWith("audio/")) return canonical
  }
  const ext = input.filename?.toLowerCase().split(".").pop()
  return ext ? TRANSCRIBE_MEDIA_TYPES[ext] : undefined
}
