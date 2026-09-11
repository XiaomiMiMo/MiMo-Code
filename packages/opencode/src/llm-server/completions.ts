import { streamText, wrapLanguageModel, jsonSchema, tool, type ToolSet } from "ai"
import { Effect } from "effect"
import { mergeDeep, pipe } from "remeda"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { AppRuntime } from "@/effect/app-runtime"
import { Provider, ProviderTransform } from "@/provider"
import { Plugin } from "@/plugin"
import { Log } from "@/util"
import {
  ChatCompletionRequest,
  chunk,
  completion,
  completionID,
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
 * This is the whole point of the local server: the `getLanguage` constructor below
 * builds the upstream SDK from credentials held inside `Provider.Service`. The key is
 * never returned, never serialized, and never crosses this boundary — the caller only
 * ever learns whether the model exists.
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
      return { model, language: yield* provider.getLanguage(model) }
    }),
  ).catch(notFound(ref))
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
