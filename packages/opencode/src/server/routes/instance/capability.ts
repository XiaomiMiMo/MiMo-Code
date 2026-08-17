import { Hono } from "hono"
import { Effect } from "effect"
import { streamSSE, type SSEStreamingApi } from "hono/streaming"
import { AppRuntime } from "@/effect/app-runtime"
import { Provider } from "@/provider"
import { Log } from "@/util"
import { lazy } from "@/util/lazy"
import { Instance } from "@/project/instance"
import { LLMServerTokens } from "@/llm-server/tokens"
import {
  RequestError,
  collect,
  start,
  stream,
  synthesize,
  transcribe,
  type ModelScope,
} from "@/llm-server/completions"
import {
  ChatCompletionRequest,
  SpeechRequest,
  TranscriptionRequest,
  transcriptionMediaType,
  transcriptionUnsupported,
  unsupported,
} from "@/llm-server/protocol"

/**
 * An OpenAI-compatible surface over the models this instance already has.
 *
 * WHY IT LIVES ON THIS SERVER rather than in a listener of its own: provider credentials
 * are not uniformly a static key. For plugin-authenticated providers they are supplied by a
 * `chat.headers` hook (`src/plugin/mimo.ts`), applied on the agent's LLM path. A separate
 * process cannot see those plugins, and — the part that is easy to miss — even the same
 * process cannot serve such a provider unless the request path actually TRIGGERS the hook.
 * `completions.ts` now does, mirroring `session/llm.ts`.
 *
 * The point of the surface: stop handing real provider keys to things that only need "a
 * model". A task gets this instance's `base_url` plus a throwaway scoped token, and the
 * real credential never leaves `Provider.Service`.
 */

const log = Log.create({ service: "llm-api" })

export const CAPABILITY_PREFIX = "/v1"

/**
 * Where a task token may ride.
 *
 * `authorization` is the OpenAI convention; `x-api-key` is Anthropic's, and clients
 * configured for either reach the same place. `api-key` is Azure's.
 */
function presented(c: { req: { header: (name: string) => string | undefined } }) {
  const authorization = c.req.header("authorization")
  if (authorization) {
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization)
    return (bearer ? bearer[1] : authorization).trim() || undefined
  }
  return (c.req.header("x-api-key") ?? c.req.header("api-key"))?.trim() || undefined
}

/** An error thrown mid-stream carries no status; report what it said, not a shrug. */
function upstreamText(err: unknown) {
  return err instanceof Error ? err.message : "upstream failed after the response began"
}

function errorBody(input: { message: string; type: string; code?: string; param?: string }) {
  return {
    error: {
      message: input.message,
      type: input.type,
      ...(input.code ? { code: input.code } : {}),
      ...(input.param ? { param: input.param } : {}),
    },
  }
}

/**
 * A token's model scope, carried per-request.
 *
 * A `WeakMap` on the raw `Request` rather than `c.set`, so no route can read it without
 * having been through the auth step, and nothing has to widen a shared context type.
 * WRAPPED, because `undefined` is meaningful here — it means "unrestricted", which is
 * exactly what a missing map entry would also look like.
 */
const scopes = new WeakMap<Request, { models: ModelScope }>()

function scopeFor(request: Request): ModelScope {
  const found = scopes.get(request)
  if (!found) {
    // Unreachable through the router, and a throw rather than a permissive default: if
    // this ever became reachable, "unrestricted" is the one wrong answer to guess.
    throw new RequestError(500, "request reached a model route without an authorization scope", "api_error")
  }
  return found.models
}

export const CapabilityRoutes = lazy(() =>
  new Hono()
    /**
     * Own authentication, ALWAYS, independent of the server's own auth.
     *
     * `AuthMiddleware` only enforces Basic auth when `MIMOCODE_SERVER_PASSWORD` is set, and
     * it usually is not — so relying on it would mean any process on the machine could
     * spend the user's model credits. A task token is mandatory here regardless, and it
     * carries the model scope that Basic auth has no concept of.
     */
    .use(async (c, next) => {
      const token = presented(c)
      if (!token) {
        return c.json(
          errorBody({ message: "Missing bearer token", type: "invalid_request_error", code: "invalid_api_key" }),
          401,
        )
      }

      const verdict = await LLMServerTokens.verify(Instance.directory, token)
      if (!verdict.ok) {
        // Expiry gets its own code and says what to do. A caller cannot otherwise tell
        // "this aged out, ask for another" from "this was never valid, stop retrying".
        if (verdict.reason === "expired") {
          return c.json(
            errorBody({
              message: "Token expired; request a new one with `llm-server issue`",
              type: "invalid_request_error",
              code: "expired_api_key",
            }),
            401,
          )
        }
        return c.json(
          errorBody({ message: "Invalid bearer token", type: "invalid_request_error", code: "invalid_api_key" }),
          401,
        )
      }

      scopes.set(c.req.raw, {
        // `undefined` = unrestricted. A token with an empty `models` array means "all
        // configured models" (see tokens.ts), and is mapped to `undefined` here so
        // downstream code sees one shape for "unrestricted" rather than two.
        models: verdict.record.models.length > 0 ? verdict.record.models : undefined,
      })
      return next()
    })
    .get("/models", async (c) => {
      const all = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const providers = yield* (yield* Provider.Service).list()
          return Object.entries(providers).flatMap(([providerID, provider]) =>
            Object.keys(provider.models).map((modelID) => `${providerID}/${modelID}`),
          )
        }),
      )
      const scope = scopeFor(c.req.raw)
      const visible = scope ? all.filter((id) => scope.includes(id)) : all
      return c.json({
        object: "list",
        data: visible.sort().map((id) => ({
          id,
          object: "model",
          created: 0,
          owned_by: id.slice(0, id.indexOf("/")),
        })),
      })
    })
    .post("/chat/completions", async (c) => {
      const parsed = ChatCompletionRequest.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new RequestError(400, `${issue?.path.join(".") || "body"}: ${issue?.message}`, "invalid_request_error")
      }
      const req = parsed.data
      const rejection = unsupported(req)
      if (rejection) throw new RequestError(400, rejection, "invalid_request_error")

      const started = await start({ req, allowlist: scopeFor(c.req.raw), abort: c.req.raw.signal })
      if (req.stream !== true) {
        return c.json(await collect({ id: started.id, ref: started.ref, result: started.result }))
      }

      // Pull the FIRST frame before committing a status line. `streamText` is lazy, so
      // `start()` above performs no upstream I/O: an expired credential or an unreachable
      // provider would otherwise surface as 200 plus an in-band error frame, leaving the
      // caller unable to tell a rejected request from one that died at token 500.
      const frames = stream({
        id: started.id,
        ref: started.ref,
        result: started.result,
        includeUsage: req.stream_options?.include_usage === true,
      })[Symbol.asyncIterator]()
      const first = await frames.next()

      // The SSE body is written after this handler returns, i.e. outside the instance
      // async-local context. `Instance.bind` captures it so provider lookups inside the
      // generator still resolve.
      const write = Instance.bind(async (sse: SSEStreamingApi) => {
        // Caught HERE and never rethrown: hono's `streamSSE` appends its own `event: error`
        // frame after invoking `onError`, so delegating would emit TWO error frames and put
        // content after `[DONE]`.
        try {
          if (!first.done) await sse.writeSSE({ data: JSON.stringify(first.value) })
          for (let next = await frames.next(); !next.done; next = await frames.next()) {
            await sse.writeSSE({ data: JSON.stringify(next.value) })
          }
        } catch (err) {
          log.error("stream failed after first frame", { error: err instanceof Error ? err.message : String(err) })
          await sse.writeSSE({
            data: JSON.stringify(errorBody({ message: upstreamText(err), type: "api_error" })),
          })
        }
        await sse.writeSSE({ data: "[DONE]" })
      })
      return streamSSE(c, write)
    })
    .post("/audio/speech", async (c) => {
      const parsed = SpeechRequest.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new RequestError(400, `${issue?.path.join(".") || "body"}: ${issue?.message}`, "invalid_request_error")
      }
      const out = await synthesize({ req: parsed.data, allowlist: scopeFor(c.req.raw), abort: c.req.raw.signal })
      return new Response(new Uint8Array(out.audio), {
        headers: { "content-type": out.contentType, "content-length": String(out.audio.byteLength) },
      })
    })
    .post("/audio/transcriptions", async (c) => {
      // Multipart, not JSON, because that is what the official clients send:
      // `openai.audio.transcriptions.create({ file, model })` builds a form.
      const form = await c.req.parseBody().catch(() => undefined)
      if (!form) throw new RequestError(400, "expected a multipart/form-data body", "invalid_request_error")
      const file = form["file"]
      if (!(file instanceof File)) {
        throw new RequestError(400, "file: a multipart file field is required", "invalid_request_error")
      }

      const parsed = TranscriptionRequest.safeParse({
        model: form["model"],
        language: form["language"],
        response_format: form["response_format"],
        prompt: form["prompt"],
        // Form values are strings; a numeric field has to be converted before it can be
        // judged, and a non-numeric one must FAIL validation rather than vanish.
        temperature: typeof form["temperature"] === "string" ? Number(form["temperature"]) : undefined,
      })
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new RequestError(400, `${issue?.path.join(".") || "body"}: ${issue?.message}`, "invalid_request_error")
      }
      // Fields that are accepted by the schema but cannot be honoured are REFUSED here
      // rather than ignored: a caller who sends a biasing prompt and silently gets an
      // unbiased transcript has no way to notice.
      const rejection = transcriptionUnsupported(parsed.data)
      if (rejection) throw new RequestError(400, rejection, "invalid_request_error")

      // `File.type` lies often enough to matter — a wav uploads as `audio/x-wav`, which some
      // vendors reject outright — so the container is derived from the reported type AND the
      // filename, and an undeterminable one is a 400 rather than a guess.
      const mediaType = transcriptionMediaType({ reported: file.type, filename: file.name })
      if (!mediaType) {
        throw new RequestError(
          400,
          `file: could not determine an audio media type from \`${file.name || "the upload"}\`; ` +
            `send a recognised extension or an audio/* content type`,
          "invalid_request_error",
        )
      }

      const out = await transcribe({
        req: parsed.data,
        audio: new Uint8Array(await file.arrayBuffer()),
        mediaType,
        allowlist: scopeFor(c.req.raw),
        abort: c.req.raw.signal,
      })
      // `text` returns the transcript bare; every other format that differs in shape was
      // already refused by the schema, so JSON is correct for the rest.
      if (parsed.data.response_format === "text") return c.text(out.text)
      return c.json({ text: out.text })
    })
    .onError((err, c) => {
      if (err instanceof RequestError) {
        log.info("request rejected", { status: err.status, code: err.code })
        return c.json(errorBody({ message: err.message, type: err.type, code: err.code }), err.status)
      }
      if (err instanceof Provider.ModelNotFoundError) {
        return c.json(errorBody({ message: err.message, type: "invalid_request_error", code: "model_not_found" }), 404)
      }
      // The model is real and the request well formed; the provider package simply cannot do
      // this. Neither the caller's mistake (4xx) nor an outage (5xx), so it gets the status
      // that means "not implemented here" and a message naming the package.
      if (err instanceof Provider.SpeechUnsupportedError) {
        return c.json(
          errorBody({
            message:
              `Model \`${err.data.providerID}/${err.data.modelID}\` cannot synthesize speech: ` +
              `provider package \`${err.data.npm}\` exposes no speech model`,
            type: "invalid_request_error",
            code: "unsupported_capability",
          }),
          501,
        )
      }
      log.error("request failed", { error: err })
      // 502, not 500: from the caller's point of view an upstream provider failure is this
      // server's problem, but they still need to tell "MiMoCode broke" from "the provider
      // broke". A bare 500 collapses that distinction.
      return c.json(
        errorBody({ message: err instanceof Error ? err.message : "Internal Server Error", type: "api_error" }),
        502,
      )
    }),
)
