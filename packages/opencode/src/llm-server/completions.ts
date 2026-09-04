import {
  streamText,
  wrapLanguageModel,
  jsonSchema,
  tool,
  experimental_generateSpeech as generateSpeech,
  type ToolSet,
} from "ai"
import { Effect } from "effect"
import { mergeDeep, pipe } from "remeda"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { AppRuntime } from "@/effect/app-runtime"
import { Provider, ProviderTransform } from "@/provider"
import { Plugin } from "@/plugin"
import { AudioChat } from "./audio-chat"
import { Log } from "@/util"
import {
  ChatCompletionRequest,
  chunk,
  completion,
  completionID,
  speechContentType,
  SpeechRequest,
  TranscriptionRequest,
  toModelMessages,
  toToolChoice,
  usageChunk,
  type EmittedToolCall,
} from "./protocol"

const log = Log.create({ service: "llm-server.completions" })

/**
 * Which models a request may reach: `undefined` is unrestricted, an array is exactly
 * those refs, and an empty array denies everything.
 *
 * Declared here rather than imported from `server.ts` to keep the dependency
 * one-directional; `server.ts` re-exports the same shape.
 */
export type ModelScope = readonly string[] | undefined

export class RequestError extends Error {
  constructor(
    // Typed as hono's contentful status so the error handler can hand it to
    // `c.json` without a narrowing cast that would claim more than it knows.
    readonly status: ContentfulStatusCode,
    message: string,
    readonly type = "invalid_request_error",
    readonly code?: string,
  ) {
    super(message)
  }
}

/**
 * Resolve `provider/model` against the running instance.
 *
 * This is the whole point of the local server: the `getLanguage`/`getSpeech`
 * constructors below build the upstream SDK from credentials held inside
 * `Provider.Service`. The key is never returned, never serialized, and never
 * crosses this boundary — the caller only ever learns whether the model exists.
 */
function lookupModel(ref: string, allowlist: ModelScope) {
  // Shape first: a caller who wrote the reference wrong should hear about the
  // shape, not be told the model is unavailable to their token.
  const parsed = Provider.parseModel(ref)
  if (!parsed.modelID) {
    throw new RequestError(400, `Model \`${ref}\` must be given as \`provider/model\``, "invalid_request_error")
  }
  // `undefined` is unrestricted; an array is exactly it. An EMPTY array therefore
  // denies everything, which is what an empty server/token intersection must mean.
  if (allowlist && !allowlist.includes(ref)) {
    throw new RequestError(
      404,
      `Model \`${ref}\` is not available to this token`,
      "invalid_request_error",
      "model_not_found",
    )
  }
  return { parsed, ref }
}

function notFound(ref: string) {
  return (cause: unknown) => {
    if (cause instanceof Provider.ModelNotFoundError) {
      throw new RequestError(404, `Model \`${ref}\` not found`, "invalid_request_error", "model_not_found")
    }
    throw cause
  }
}

export function resolveLanguageModel(ref: string, allowlist: ModelScope) {
  const found = lookupModel(ref, allowlist)
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const model = yield* provider.getModel(found.parsed.providerID, found.parsed.modelID)
      // Naming the right endpoint matters more than the status code here: a caller
      // that posts a TTS model to the chat route would otherwise get whatever
      // opaque failure the provider produces for a nonsensical request.
      // Naming the right endpoint matters more than the status code: a caller who
      // posts an audio model here would otherwise get whatever opaque failure the
      // provider produces for a nonsensical request.
      const kind = Provider.modelKind(model)
      if (kind !== "language") {
        throw new RequestError(
          400,
          kind === "speech"
            ? `Model \`${ref}\` synthesizes speech; use POST /v1/audio/speech`
            : `Model \`${ref}\` transcribes audio; use POST /v1/audio/transcriptions`,
          "invalid_request_error",
        )
      }
      return { model, language: yield* provider.getLanguage(model) }
    }),
  ).catch(notFound(ref))
}

/**
 * Resolve a model for one of the audio routes.
 *
 * Returns the model plus, when the provider package has one, its native factory. A
 * MISSING factory is not an error: providers that carry audio over chat completions
 * (MiMo, `gpt-4o-audio-preview`) have no such factory and are served by
 * `AudioChat` instead. Refusing here is what made such a model unusable in both
 * directions — the chat route sent it to the audio route and the audio route
 * refused it.
 */
export function resolveAudioModel(input: {
  ref: string
  allowlist: ModelScope
  kind: "speech" | "transcription"
  /** A second kind this route can serve, with a different request shape. */
  alsoAccept?: (model: Provider.Model) => boolean
  wrongEndpoint: string
}) {
  const found = lookupModel(input.ref, input.allowlist)
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const model = yield* provider.getModel(found.parsed.providerID, found.parsed.modelID)
      if (Provider.modelKind(model) !== input.kind && !input.alsoAccept?.(model)) {
        throw new RequestError(
          400,
          `Model \`${input.ref}\` is a ${Provider.modelKind(model)} model; use ${input.wrongEndpoint}`,
          "invalid_request_error",
        )
      }
      return { model }
    }),
  )
    .then(async ({ model }) => {
      if (input.kind !== "speech") return { model, speech: undefined }
      // `getSpeech` raises SpeechUnsupportedError with a bare `throw` inside
      // `Effect.promise`, which makes it a DEFECT rather than a failure — so
      // `Effect.catch` never sees it. Caught here at the promise boundary instead,
      // where `runPromise` rejects with the raw error.
      //
      // A missing factory means "this provider carries audio over chat completions",
      // not "give up": that is the fallback, not the failure.
      const speech = await AppRuntime.runPromise(
        Effect.gen(function* () {
          return yield* (yield* Provider.Service).getSpeech(model)
        }),
      ).catch((cause) => {
        if (cause instanceof Provider.SpeechUnsupportedError) return undefined
        throw cause
      })
      return { model, speech }
    })
    .catch(notFound(input.ref))
}

export function resolveSpeechModel(ref: string, allowlist: ModelScope) {
  return resolveAudioModel({ ref, allowlist, kind: "speech", wrongEndpoint: "POST /v1/chat/completions" })
}

/**
 * Resolve a model for transcription, accepting a multimodal chat model as a fallback.
 *
 * A dedicated ASR model is preferred and served with the shape it demands. But a
 * multimodal model that can hear will transcribe perfectly well when told to — measured
 * on `mimo-v2.5`, whose verbatim output was actually CLEANER than the dedicated
 * `mimo-v2.5-asr` under `language: "en"`, which leaks `think>\n<chinese> `.
 *
 * The two need different requests, which is why the kind still matters: an ASR endpoint
 * REFUSES text parts while a chat model REQUIRES the instruction. The caller does not
 * have to care, and the response says which mode served it.
 */
export function resolveTranscriptionModel(ref: string, allowlist: ModelScope) {
  return resolveAudioModel({
    ref,
    allowlist,
    kind: "transcription",
    alsoAccept: (model) => Provider.modelKind(model) === "language" && model.capabilities.input.audio,
    wrongEndpoint: "POST /v1/chat/completions",
  })
}

/**
 * Packages whose endpoint speaks OpenAI chat completions.
 *
 * The audio-over-chat fallback is only sound for these. Everything else in the
 * family talks something entirely different — Anthropic's `/v1/messages`, Google's
 * `:generateContent`, Bedrock's signed API — and POSTing a chat completion there
 * produces a 404 that looks like the provider's fault rather than our wrong guess.
 *
 * This matters against real registry data, not hypotheticals:
 * `google/gemini-2.5-pro-preview-tts` is declared `output: ["audio"]`, and
 * `@ai-sdk/google` exposes no speech factory, so without this gate any operator with
 * a Google provider would hit the nonsense path.
 */
const OPENAI_CHAT_SHAPED = ["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/openai-compatible"]

/**
 * Can this model's audio be carried over chat completions?
 *
 * Answered from the provider PACKAGE rather than from the absence of a speech
 * factory. "No factory" only means the SDK cannot help; it says nothing about which
 * protocol the endpoint actually speaks.
 */
function audioOverChat(model: Provider.Model) {
  return OPENAI_CHAT_SHAPED.includes(model.api.npm)
}

function unsupportedAudio(model: Provider.Model, capability: "synthesize speech" | "transcribe audio") {
  return new RequestError(
    501,
    `Model \`${model.providerID}/${model.id}\` cannot ${capability} through this server: ` +
      `provider package \`${model.api.npm}\` exposes no ${capability === "synthesize speech" ? "speech" : "transcription"} ` +
      `model, and its endpoint does not speak OpenAI chat completions, so audio cannot be carried there either`,
    "invalid_request_error",
    "unsupported_capability",
  )
}

/**
 * Translate an OpenAI `reasoning_effort` into whatever this model's provider calls it.
 *
 * No mapping table is invented here. `ProviderTransform.variants` already encodes the
 * per-provider spelling — `reasoningEffort` for OpenAI, a `thinking` budget for
 * Anthropic, `thinkingConfig.thinkingBudget` for Google — and `Model.variants` carries
 * the result, merged with whatever the user configured. Reusing it means the proxy
 * honors effort exactly as a session does.
 *
 * An effort the model does not offer is a 400 that lists what it does, because the
 * alternative is a silent downgrade: a caller who asked for `high` and received the
 * default has no way to notice.
 */
function variantFor(model: Provider.Model, effort: string) {
  const available = model.variants ?? {}
  const variant = available[effort]
  if (variant) return variant
  const names = Object.keys(available)
  throw new RequestError(
    400,
    names.length === 0
      ? `Model \`${model.providerID}/${model.id}\` does not support reasoning_effort`
      : `reasoning_effort \`${effort}\` is not available for \`${model.providerID}/${model.id}\`; supported: ${names.join(", ")}`,
    "invalid_request_error",
  )
}

/**
 * Declare the caller's tools to the SDK without ever executing them.
 *
 * A proxy must not run tools: the caller owns that loop. Each tool is registered
 * schema-only (no `execute`), which makes the SDK emit `tool-call` parts and
 * stop — exactly the OpenAI contract, where tool calls come back to the client
 * and results return on a later request.
 */
function toolSet(tools: NonNullable<ChatCompletionRequest["tools"]>): ToolSet {
  return Object.fromEntries(
    tools.map((entry) => [
      entry.function.name,
      tool({
        description: entry.function.description,
        inputSchema: jsonSchema(entry.function.parameters ?? { type: "object", properties: {} }),
      }),
    ]),
  )
}

/**
 * Start one upstream call.
 *
 * Runs entirely inside the caller's instance context so that credential and
 * config lookups resolve, and returns before the stream is drained — draining
 * belongs to the response writer, which may outlive this function when the
 * response is SSE.
 */
/**
 * What the plugin hooks are told this request's "agent" is.
 *
 * A real name rather than a borrowed one: a hook that logs or branches on the agent should
 * be able to tell an API caller apart from the agent loop.
 */
const HOOK_AGENT = "llm-api"

export async function start(input: {
  req: ChatCompletionRequest
  allowlist: ModelScope
  abort: AbortSignal
}) {
  const resolved = await resolveLanguageModel(input.req.model, input.allowlist)
  const model = resolved.model

  // A synthetic per-request id stands in for a session. Providers that key a
  // prompt cache on it (Azure) then scope that cache to one request instead of
  // sharing it across unrelated callers of this server.
  const requestID = completionID()
  // Both sides of this merge are FLAT provider-native option maps;
  // `ProviderTransform.providerOptions` below is what nests the result under the
  // SDK's namespace. Merging a per-provider-keyed object in here would survive
  // typechecking and then be silently dropped by the provider.
  // Same layering as `session/llm.ts`: derived options first, then the variant that
  // reasoning effort selects, then the caller's explicit escape hatch. `mergeDeep`
  // rather than a spread because variant values are nested (a thinking budget lives
  // under its own object) and a shallow merge would drop siblings.
  const merged = pipe(
    ProviderTransform.options({ model, sessionID: requestID }),
    mergeDeep(input.req.reasoning_effort ? variantFor(model, input.req.reasoning_effort) : {}),
    mergeDeep(input.req.provider_options ?? {}),
  )

  log.info("upstream request", {
    model: `${model.providerID}/${model.id}`,
    messages: input.req.messages.length,
    tools: input.req.tools?.length ?? 0,
    stream: input.req.stream === true,
  })

  const tools = input.req.tools?.length ? ProviderTransform.tools(toolSet(input.req.tools), model) : undefined

  // THE HOOKS ARE NOT OPTIONAL POLISH — they are how some providers get authenticated at
  // all. `src/plugin/mimo.ts` supplies its provider's headers from `chat.headers`, and a
  // request path that skips the hook cannot reach such a provider no matter which process
  // it runs in. `session/llm.ts:508` does the same two triggers for the agent's own path;
  // this mirrors it so both paths reach a provider the same way.
  //
  // `sessionID` is the synthetic request id and `agent` names this surface rather than a
  // real agent, because there is no session here. Hooks that key on the model or provider
  // (the case in-tree) work unchanged; one that insists on a real session will see a value
  // that is honestly labelled instead of a fabricated session id.
  const hooked = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const provider = (yield* (yield* Provider.Service).list())[model.providerID]
      const params = yield* plugin.trigger(
        "chat.params",
        { sessionID: requestID, agent: HOOK_AGENT, model, provider, message: undefined },
        {
          // Seeded with the CALLER's value where given, falling back to the derived
          // default — so a hook adjusts an explicit request rather than replacing it with
          // a default it never saw. Note `capabilities.temperature` defaults to FALSE, so
          // this stays undefined for a model that does not accept it.
          temperature: model.capabilities.temperature
            ? (input.req.temperature ?? ProviderTransform.temperature(model))
            : undefined,
          topP: input.req.top_p ?? ProviderTransform.topP(model),
          topK: input.req.top_k ?? ProviderTransform.topK(model),
          maxOutputTokens:
            input.req.max_completion_tokens ?? input.req.max_tokens ?? ProviderTransform.maxOutputTokens(model),
          options: merged,
        },
      )
      const { headers } = yield* plugin.trigger(
        "chat.headers",
        { sessionID: requestID, agent: HOOK_AGENT, model, provider, message: undefined },
        { headers: {} as Record<string, string> },
      )
      return { params, headers }
    }),
  )

  return {
    id: requestID,
    result: streamText({
      model: wrapLanguageModel({
        model: resolved.language,
        middleware: [
          {
            specificationVersion: "v3" as const,
            async transformParams(args) {
              if (args.type === "generate" || args.type === "stream") {
                // @ts-expect-error the SDK types `prompt` as readonly here
                args.params.prompt = ProviderTransform.message(args.params.prompt, model, merged)
              }
              return args.params
            },
          },
        ],
      }),
      messages: toModelMessages(input.req.messages),
      tools,
      toolChoice: tools ? toToolChoice(input.req.tool_choice) : undefined,
      // Gated on the capability exactly as `session/llm.ts` does, because the
      // capability defaults to FALSE: forwarding a caller's temperature to a model
      // that declares it unsupported would contradict the session path and can
      // make the provider reject the whole request.
      // Taken from the hook output rather than recomputed: the same values were fed IN as
      // the seed above, so this is the caller's request after any plugin adjustment.
      temperature: hooked.params.temperature,
      topP: hooked.params.topP,
      topK: hooked.params.topK,
      maxOutputTokens: hooked.params.maxOutputTokens,
      stopSequences: typeof input.req.stop === "string" ? [input.req.stop] : input.req.stop,
      seed: input.req.seed,
      presencePenalty: input.req.presence_penalty,
      frequencyPenalty: input.req.frequency_penalty,
      providerOptions: ProviderTransform.providerOptions(model, hooked.params.options),
      // Model headers first, hook output last — same precedence as `session/llm.ts:737`,
      // so a plugin can override a statically configured header rather than losing to it.
      headers: { ...model.headers, ...hooked.headers },
      // The caller owns retries. A proxy that silently retries turns one client
      // request into several billed upstream calls with no way to observe it.
      maxRetries: 0,
      abortSignal: input.abort,
    }),
    // `model` echoed back is the reference the caller asked for, per OpenAI,
    // which returns the requested model id rather than an internal name.
    ref: input.req.model,
  }
}

/**
 * Drain the stream and build a single `chat.completion` body.
 *
 * Tool-call arguments are taken from the SDK's completed `tool-call` parts, not
 * assembled from `tool-input-delta`, so a partial-JSON stream cannot leak a
 * truncated `arguments` string into a non-streaming response.
 */
export async function collect(input: {
  id: string
  ref: string
  result: Awaited<ReturnType<typeof start>>["result"]
}) {
  const created = Math.floor(Date.now() / 1000)
  const text: string[] = []
  const reasoning: string[] = []
  const toolCalls: EmittedToolCall[] = []

  for await (const part of input.result.fullStream) {
    if (part.type === "text-delta") text.push(part.text)
    else if (part.type === "reasoning-delta") reasoning.push(part.text)
    else if (part.type === "tool-call") toolCalls.push({ id: part.toolCallId, name: part.toolName, input: part.input })
    else if (part.type === "error") throw part.error
  }

  return completion({
    id: input.id,
    model: input.ref,
    created,
    text: text.join(""),
    reasoning: reasoning.join("") || undefined,
    toolCalls,
    finishReason: await input.result.finishReason,
    usage: await input.result.totalUsage,
  })
}

/**
 * Translate the stream into `chat.completion.chunk` payloads.
 *
 * Yields chunk objects; the caller serializes each into an SSE `data:` frame and
 * appends the `[DONE]` sentinel. Tool calls stream the way OpenAI does it:
 * an opener chunk carrying `index`, `id`, and the function name, then
 * `arguments` fragments with no name repeated.
 */
export async function* stream(input: {
  id: string
  ref: string
  result: Awaited<ReturnType<typeof start>>["result"]
  includeUsage: boolean
}) {
  const created = Math.floor(Date.now() / 1000)
  const base = { id: input.id, model: input.ref, created }
  const indexes = new Map<string, number>()
  let started = false

  const open = () => {
    started = true
    return chunk({ ...base, delta: { role: "assistant", content: "" } })
  }

  for await (const part of input.result.fullStream) {
    if (part.type === "text-delta") {
      if (!started) yield open()
      yield chunk({ ...base, delta: { content: part.text } })
      continue
    }
    if (part.type === "reasoning-delta") {
      if (!started) yield open()
      yield chunk({ ...base, delta: { reasoning_content: part.text } })
      continue
    }
    if (part.type === "tool-input-start") {
      if (!started) yield open()
      const index = indexes.size
      indexes.set(part.id, index)
      yield chunk({
        ...base,
        delta: {
          tool_calls: [{ index, id: part.id, type: "function", function: { name: part.toolName, arguments: "" } }],
        },
      })
      continue
    }
    if (part.type === "tool-input-delta") {
      const index = indexes.get(part.id)
      if (index === undefined) continue
      yield chunk({ ...base, delta: { tool_calls: [{ index, function: { arguments: part.delta } }] } })
      continue
    }
    if (part.type === "tool-call") {
      // Providers that deliver a tool call in one piece never emit
      // `tool-input-start`/`-delta`, so synthesize the whole entry here. When the
      // deltas DID arrive, the id is already known and this is a no-op.
      if (indexes.has(part.toolCallId)) continue
      if (!started) yield open()
      const index = indexes.size
      indexes.set(part.toolCallId, index)
      yield chunk({
        ...base,
        delta: {
          tool_calls: [
            {
              index,
              id: part.toolCallId,
              type: "function",
              function: { name: part.toolName, arguments: JSON.stringify(part.input ?? {}) },
            },
          ],
        },
      })
      continue
    }
    if (part.type === "error") throw part.error
  }

  if (!started) yield open()
  yield chunk({ ...base, delta: {}, finishReason: await input.result.finishReason })
  // Only touched when asked for. These SDK fields are lazy promises, so reading
  // one the caller never requested adds a rejection path for no benefit.
  if (input.includeUsage) yield usageChunk({ ...base, usage: await input.result.totalUsage })
}

/**
 * Synthesize one audio body.
 *
 * `generateSpeech` is the only entry point the SDK offers — there is no
 * `streamSpeech` — so the whole clip is produced before anything can be written.
 * The caller is told this outright rather than being handed a stalled stream (see
 * `speechUnsupported`).
 *
 * The request's `provider_options` is flat, exactly as on the chat route, and is
 * nested through the same `ProviderTransform.providerOptions` helper so one field
 * name does not mean two different shapes depending on the endpoint.
 * `ProviderTransform` has no speech-side compatibility rules to contribute, so
 * there is nothing to merge it over.
 */
/**
 * Read the `voice` union into the three things a request actually needs to know.
 *
 * Written as a narrowing over the arms rather than optional-field plucking, so adding an arm
 * later is a compile error at every site that has to care instead of a silent fallthrough.
 */
/**
 * The instruction a vendor sees, with a voice DESIGN description folded in.
 *
 * Folded rather than sent as a separate field because that is where the convention puts it:
 * the description IS the style instruction for a design model. Kept ahead of the caller's own
 * instructions so those can refine it rather than be buried by it.
 */
function instructionsFor(source: ReturnType<typeof voiceSource>, instructions?: string) {
  if (source.kind !== "design") return instructions
  return instructions ? `${source.description}\n\n${instructions}` : source.description
}

export function voiceSource(voice: SpeechRequest["voice"]) {
  if (voice === undefined) return { kind: "default" as const }
  if (typeof voice === "string") return { kind: "preset" as const, preset: voice }
  if ("design" in voice) return { kind: "design" as const, description: voice.design }
  return { kind: "clone" as const, sample: voice.clone }
}

/**
 * Which declared capability a voice source needs.
 *
 * `undefined` means "no special capability" — a preset voice or none is what every speech
 * model can do. The other two are DECLARED per model in config (`voice_design` /
 * `voice_clone`), never inferred, because design is indistinguishable from plain TTS by
 * modality and a sample-taking model could equally be speech-to-speech conversion.
 */
function requiredCapability(source: ReturnType<typeof voiceSource>) {
  if (source.kind === "design") return "voiceDesign" as const
  if (source.kind === "clone") return "voiceClone" as const
  return undefined
}

export async function synthesize(input: {
  req: SpeechRequest
  allowlist: ModelScope
  abort: AbortSignal
}) {
  const resolved = await resolveSpeechModel(input.req.model, input.allowlist)

  // Checked BEFORE any upstream call, and against the model the caller actually named. The
  // alternative — let the vendor reject it — spends a request to learn something we already
  // knew, and reports it in the vendor's words rather than ours.
  const source = voiceSource(input.req.voice)
  const needed = requiredCapability(source)
  if (needed && !resolved.model.capabilities[needed]) {
    throw new RequestError(
      400,
      `Model \`${resolved.model.providerID}/${resolved.model.id}\` does not declare ` +
        `\`${needed === "voiceDesign" ? "voice_design" : "voice_clone"}\`, so it cannot take a ` +
        `${source.kind === "design" ? "voice description" : "reference sample"}. Declare the ` +
        `capability on a model that supports it, or send a preset voice name instead`,
      "invalid_request_error",
      "unsupported_capability",
    )
  }

  log.info("upstream speech request", {
    model: `${resolved.model.providerID}/${resolved.model.id}`,
    characters: input.req.input.length,
    format: input.req.response_format ?? "default",
    path: resolved.speech ? "sdk" : "chat-completions",
  })

  // No native speech factory means this provider carries audio over chat
  // completions. Serving both conventions behind one route is the point: a skill
  // should not have to know which one its configured model uses.
  if (!resolved.speech) {
    if (!audioOverChat(resolved.model)) throw unsupportedAudio(resolved.model, "synthesize speech")
    const out = await AudioChat.synthesize({
      providerID: resolved.model.providerID,
      modelID: resolved.model.api.id,
      text: input.req.input,
      // A preset name and a reference sample both ride in the vendor's single `voice` field;
      // a design description does not ride there at all — it goes in the instruction, which is
      // where that vendor convention puts it.
      voice: source.kind === "preset" ? source.preset : source.kind === "clone" ? source.sample.audio : undefined,
      sampleFormat: source.kind === "clone" ? source.sample.format : undefined,
      format: input.req.response_format,
      instructions: instructionsFor(source, input.req.instructions),
      abort: input.abort,
    })
    return {
      audio: out.audio,
      contentType: speechContentType({ requested: out.format }),
    }
  }

  const result = await generateSpeech({
    model: resolved.speech,
    text: input.req.input,
    // The SDK's speech API takes a preset name only. Design and clone were already refused
    // above unless declared, and a provider with a native speech factory that declares them
    // would need its own arm here rather than a silent downgrade to "no voice".
    voice: source.kind === "preset" ? source.preset : undefined,
    outputFormat: input.req.response_format,
    instructions: input.req.instructions,
    speed: input.req.speed,
    providerOptions: input.req.provider_options
      ? ProviderTransform.providerOptions(resolved.model, input.req.provider_options)
      : undefined,
    headers: resolved.model.headers,
    // Same reasoning as the chat path: retry policy belongs to the caller, not to
    // a proxy that would bill several syntheses for one request.
    maxRetries: 0,
    abortSignal: input.abort,
  })

  return {
    audio: result.audio.uint8Array,
    contentType: speechContentType({
      reported: result.audio.mediaType,
      requested: input.req.response_format,
    }),
  }
}

/**
 * The instruction a multimodal model needs in order to transcribe rather than answer.
 *
 * Explicit about "only the transcript" because these models default to being helpful:
 * without it they add commentary, and a transcription endpoint that returns commentary
 * is worse than one that refuses.
 */
function instructionFor(language?: string) {
  const scope = language && language !== "auto" ? ` The audio is in ${language}.` : ""
  return `Transcribe the audio verbatim.${scope} Output only the transcript, with no commentary, labels, or quotation marks.`
}

/**
 * The short container name the wire format uses, derived back from the media type.
 *
 * Constrained to the set the request schema accepts so the two cannot drift; anything
 * outside it was already rejected upstream by `transcriptionMediaType`.
 */
const AUDIO_FORMATS = ["wav", "mp3", "mpeg", "m4a", "flac", "ogg", "webm"] as const
type AudioFormat = (typeof AUDIO_FORMATS)[number]

function audioFormat(mediaType: string): AudioFormat {
  const suffix = mediaType.split("/")[1]
  if (suffix === "mpeg") return "mp3"
  const match = AUDIO_FORMATS.find((f) => f === suffix)
  return match ?? "wav"
}

/**
 * Transcribe one audio payload.
 *
 * Only reached for `transcription`-kind models — audio in, text out, and NO text
 * input. That last part is a protocol fact rather than a taxonomy preference: a
 * dedicated ASR endpoint REFUSES text parts (MiMo answers 400 "ASR request must not
 * include text parts; text prompt is injected by the gateway"), while a multimodal
 * chat model REQUIRES an instruction to know what to do with the audio. One request
 * builder cannot serve both, so this route serves the former and the latter stays on
 * the chat route where the caller supplies the instruction explicitly.
 */
export async function transcribe(input: {
  req: TranscriptionRequest
  audio: Uint8Array
  mediaType: string
  allowlist: ModelScope
  abort: AbortSignal
}) {
  const resolved = await resolveTranscriptionModel(input.req.model, input.allowlist)

  // A multimodal chat model transcribes by being TOLD to. Two paths can carry that, and
  // the raw one is PREFERRED where it applies:
  //
  //  - Raw, for OpenAI-shaped providers: lets `thinking: {type: "disabled"}` go out,
  //    which is what turns this from best-effort into a stable contract. A reasoning
  //    model otherwise puts the transcript in `reasoning_content` some of the time.
  //    `@ai-sdk/openai-compatible` cannot express that field — closed provider-options
  //    schema, no extra-body escape — so the SDK path structurally cannot ask for it.
  //  - SDK, for everything else: an audio file part becomes `input_audio` on the wire,
  //    so any package the SDK supports still works, just without thinking control.
  if (Provider.modelKind(resolved.model) === "language" && audioOverChat(resolved.model)) {
    return AudioChat.transcribe({
      providerID: resolved.model.providerID,
      modelID: resolved.model.api.id,
      audio: input.audio,
      mediaType: input.mediaType,
      instruction: instructionFor(input.req.language),
      disableThinking: true,
      abort: input.abort,
    })
  }

  if (Provider.modelKind(resolved.model) === "language") {
    const result = start({
      req: {
        model: input.req.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "input_audio", input_audio: { data: Buffer.from(input.audio).toString("base64"), format: audioFormat(input.mediaType) } },
              { type: "text", text: instructionFor(input.req.language) },
            ],
          },
        ],
        // Reasoning models spend tokens thinking before answering; the earlier probe
        // returned an EMPTY answer at 300 because 222 went to reasoning first.
        max_tokens: 4096,
      },
      allowlist: input.allowlist,
      abort: input.abort,
    })
    const collected = await result.then((started) =>
      collect({ id: started.id, ref: started.ref, result: started.result }),
    )
    const text = collected.choices[0]?.message.content
    if (typeof text !== "string" || text.length === 0) {
      // Measured on `mimo-v2.5`: a reasoning model sometimes emits the whole transcript
      // as `reasoning_content` with `content: null`. Reading reasoning as the transcript
      // is NOT safe — on other calls that same field held "The user wants a verbatim
      // transcription... The audio contains the phrase: ..." — so the answer is a
      // legible failure rather than a guess. Nor is it retried: a proxy that retries
      // silently bills twice with nothing to show for it.
      throw new RequestError(
        502,
        `Model \`${resolved.model.providerID}/${resolved.model.id}\` returned its answer as reasoning rather than ` +
          `content, so no transcript can be read. Reasoning models are best-effort transcription backends; ` +
          `configure a dedicated speech-to-text model for a stable contract`,
        "api_error",
      )
    }
    return { text, mode: "instructed" as const }
  }

  // Same gate as synthesis: `@ai-sdk/openai-compatible` has no transcription factory
  // either, but that is not licence to assume every other package's endpoint would
  // understand a chat completion.
  if (!audioOverChat(resolved.model)) throw unsupportedAudio(resolved.model, "transcribe audio")
  return AudioChat.transcribe({
    providerID: resolved.model.providerID,
    modelID: resolved.model.api.id,
    audio: input.audio,
    mediaType: input.mediaType,
    language: input.req.language,
    abort: input.abort,
  })
}
