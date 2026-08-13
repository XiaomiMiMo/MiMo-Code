import { Hono } from "hono"
import { streamSSE, type SSEStreamingApi } from "hono/streaming"
import { adapter } from "#hono"
import { Effect } from "effect"
import { timingSafeEqual } from "node:crypto"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider"
import { Log } from "@/util"
import { collect, RequestError, start, stream, synthesize } from "./completions"
import { ChatCompletionRequest, errorBody, SpeechRequest, speechUnsupported, unsupported } from "./protocol"

const log = Log.create({ service: "llm-server" })

/**
 * A temporary, OpenAI-compatible endpoint in front of the models this MiMoCode
 * instance is already configured for.
 *
 * It exists so that a skill or subprocess that "needs a model" can be handed a
 * `base_url` and a throwaway token instead of a real provider API key. The key
 * stays inside `Provider.Service`; it never enters a prompt, a config file a
 * skill can read, or an agent's context.
 *
 * The capability boundary is deliberately narrow. This is a SEPARATE Hono app
 * from `server/server.ts` — reusing that one would hand every holder of a task
 * token the full control surface (filesystem, sessions, config, auth
 * management). Here there are three routes, one pinned directory, and no way to
 * reach anything else.
 */

export const MODELS_PATH = "/v1/models"
export const COMPLETIONS_PATH = "/v1/chat/completions"
export const SPEECH_PATH = "/v1/audio/speech"

/**
 * Mint a bearer token for one server process.
 *
 * 256 bits from the CSPRNG, held only in memory: it is never written to disk, so
 * killing the process is what revokes it, and two servers started for two
 * different tasks cannot replay each other's token.
 */
export function generateToken() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
}

/**
 * Compare in constant time, and only after the lengths match.
 *
 * `timingSafeEqual` throws on a length mismatch rather than returning false, so
 * the length check is required for correctness here, not just for speed. Length
 * is not a secret — every token this server mints is the same size.
 */
function tokenMatches(expected: string, actual: string) {
  const a = Buffer.from(expected)
  const b = Buffer.from(actual)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function bearer(header: string | undefined) {
  if (!header) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]
}

/**
 * Pull the presented token out of whichever header carried it.
 *
 * `Authorization` must be the `Bearer <token>` form. `x-api-key` carries the RAW
 * token — that is the whole convention of the header, and clients that send it
 * (Anthropic's SDK among them) never add a prefix. Accepting a prefixed value
 * there too costs nothing and spares the next caller a confusing 401.
 */
function presentedToken(header: (name: string) => string | undefined) {
  const authorization = bearer(header("authorization"))
  if (authorization) return authorization
  const apiKey = header("x-api-key")?.trim()
  if (!apiKey) return undefined
  return bearer(apiKey) ?? apiKey
}

export type Options = {
  /** Token clients must present. Generated per process by the CLI. */
  token: string
  /** Directory whose MiMoCode instance (and therefore provider config) is used. */
  directory: string
  /**
   * Models this token may call, as `provider/model`. Empty means every model the
   * instance has configured.
   */
  models?: readonly string[]
}

export function create(opts: Options) {
  const allowlist = opts.models ?? []

  const app = new Hono()
    .onError((err, c) => {
      if (err instanceof RequestError) {
        return c.json(errorBody({ message: err.message, type: err.type, code: err.code }), err.status as 400)
      }
      if (err instanceof Provider.ModelNotFoundError) {
        return c.json(
          errorBody({ message: err.message, type: "invalid_request_error", code: "model_not_found" }),
          404,
        )
      }
      log.error("request failed", { error: err })
      // Upstream provider failures are the server's problem from the caller's
      // point of view, so they surface as 502 rather than a bare 500 — a client
      // can then tell "MiMoCode broke" from "the model provider broke".
      return c.json(
        errorBody({ message: err instanceof Error ? err.message : "Internal Server Error", type: "api_error" }),
        502,
      )
    })
    .use(async (c, next) => {
      if (c.req.method === "OPTIONS") return next()
      const provided = presentedToken((name) => c.req.header(name))
      if (!provided) {
        return c.json(
          errorBody({ message: "Missing bearer token", type: "invalid_request_error", code: "invalid_api_key" }),
          401,
        )
      }
      if (!tokenMatches(opts.token, provided)) {
        return c.json(
          errorBody({ message: "Invalid bearer token", type: "invalid_request_error", code: "invalid_api_key" }),
          401,
        )
      }
      return next()
    })
    // The instance is pinned to the directory the server was started in. Unlike
    // the control server there is no `?directory=` override: a task token must
    // not be able to repoint this at another project's provider config.
    .use(async (_c, next) => {
      await Instance.provide({
        directory: opts.directory,
        init: () => AppRuntime.runPromise(InstanceBootstrap),
        fn: () => next(),
      })
    })
    .get(MODELS_PATH, async (c) => {
      const models = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const providers = yield* (yield* Provider.Service).list()
          return Object.entries(providers).flatMap(([providerID, provider]) =>
            Object.keys(provider.models).map((modelID) => `${providerID}/${modelID}`),
          )
        }),
      )
      const visible = allowlist.length > 0 ? models.filter((id) => allowlist.includes(id)) : models
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
    .post(COMPLETIONS_PATH, async (c) => {
      const parsed = ChatCompletionRequest.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new RequestError(
          400,
          `${issue.path.join(".") || "body"}: ${issue.message}`,
          "invalid_request_error",
        )
      }
      const req = parsed.data
      const rejection = unsupported(req)
      if (rejection) throw new RequestError(400, rejection, "invalid_request_error")

      const started = await start({ req, allowlist, abort: c.req.raw.signal })

      if (req.stream !== true) {
        return c.json(await collect({ id: started.id, ref: started.ref, result: started.result }))
      }

      // The SSE body is written after this handler returns, i.e. outside the
      // instance async-local context established above. `Instance.bind` captures
      // that context so provider lookups inside the generator still resolve.
      const write = Instance.bind(async (sse: SSEStreamingApi) => {
        // The failure is caught HERE and never rethrown, which is the only way to
        // emit a single well-formed tail. hono's `streamSSE` runner appends its own
        // `event: error` frame after invoking an `onError` callback
        // (hono/dist/helper/streaming/sse.js: `await onError(...)` then
        // `writeSSE({ event: "error" })`), so delegating to `onError` would always
        // produce two error frames and put content AFTER `[DONE]`.
        try {
          for await (const payload of stream({
            id: started.id,
            ref: started.ref,
            result: started.result,
            includeUsage: req.stream_options?.include_usage === true,
          })) {
            await sse.writeSSE({ data: JSON.stringify(payload) })
          }
        } catch (err) {
          log.error("stream failed", { error: err })
          // The status line is long gone by the time a mid-stream failure happens,
          // so an in-band error frame is the only honest way to report it.
          await sse.writeSSE({
            data: JSON.stringify(
              errorBody({ message: err instanceof Error ? err.message : "stream failed", type: "api_error" }),
            ),
          })
        }
        // Always last, error or not: it is the sentinel the client waits for.
        await sse.writeSSE({ data: "[DONE]" })
      })

      return streamSSE(c, write)
    })
    .post(SPEECH_PATH, async (c) => {
      const parsed = SpeechRequest.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new RequestError(400, `${issue.path.join(".") || "body"}: ${issue.message}`, "invalid_request_error")
      }
      const rejection = speechUnsupported(parsed.data)
      if (rejection) throw new RequestError(400, rejection, "invalid_request_error")

      const result = await synthesize({ req: parsed.data, allowlist, abort: c.req.raw.signal })
      // Re-wrapped because the SDK types its bytes over `ArrayBufferLike`, which
      // admits a shared buffer, while a response body must be the non-shared form.
      // The copy is what makes the narrowing true rather than asserted.
      return c.body(new Uint8Array(result.audio), 200, { "content-type": result.contentType })
    })

  return app
}

export type Listener = {
  hostname: string
  port: number
  url: string
  token: string
  stop: () => Promise<void>
}

const LOOPBACK = ["127.0.0.1", "localhost", "::1"]

/**
 * Ask the OS for an unused port.
 *
 * The shared listener treats `port: 0` as "try 4096, then fall back to random",
 * and 4096 is where the MiMoCode CONTROL server lives. A task server silently
 * landing there is the worst outcome available: it either collides with the real
 * control server or, when that one is not running, occupies its well-known port
 * while serving a completely different API. So a random port is resolved here
 * and passed explicitly, leaving the shared adapter's behavior untouched.
 *
 * The port is released before it is rebound, so a concurrent process could in
 * principle take it in between — the rebind then fails loudly on startup, which
 * is recoverable, unlike quietly answering on 4096.
 */
async function ephemeralPort(hostname: string) {
  const net = await import("node:net")
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer()
    probe.once("error", reject)
    probe.listen({ port: 0, host: hostname }, () => {
      const address = probe.address()
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("failed to resolve an ephemeral port")))
        return
      }
      probe.close(() => resolve(address.port))
    })
  })
}

export async function listen(opts: Options & { port: number; hostname?: string }): Promise<Listener> {
  const hostname = opts.hostname ?? "127.0.0.1"
  // Loopback-only, with no override flag. The token is a task-scoped convenience
  // credential, not an authentication system worth exposing to a network — and a
  // reachable port here would proxy paid model access to anyone who found it.
  if (!LOOPBACK.includes(hostname)) {
    throw new Error(`llm-server binds to loopback only; refusing hostname \`${hostname}\``)
  }

  const runtime = adapter.create(create(opts))
  const server = await runtime.listen({
    port: opts.port === 0 ? await ephemeralPort(hostname) : opts.port,
    hostname,
  })

  let closing: Promise<void> | undefined
  return {
    hostname,
    port: server.port,
    url: `http://${hostname === "::1" ? "[::1]" : hostname}:${server.port}/v1`,
    token: opts.token,
    stop() {
      closing ??= server.stop(true)
      return closing
    },
  }
}

export * as LLMServer from "./server"
