import { Hono } from "hono"
import { streamSSE, type SSEStreamingApi } from "hono/streaming"
import { adapter } from "#hono"
import { Effect } from "effect"
import { timingSafeEqual } from "node:crypto"
import { createServer } from "node:net"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider"
import { Log, Self } from "@/util"
import { collect, RequestError, start, stream, synthesize, type ModelScope } from "./completions"
import { LLMServerTokens } from "./tokens"
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
 * Mint a bearer token without registering it.
 *
 * Kept for callers that supply their own token out of band. Ordinary issuance goes
 * through `LLMServerTokens.issue`, which records the hash and the expiry policy.
 */
export function generateToken() {
  return LLMServerTokens.generate()
}

/**
 * Compare an out-of-band static token in constant time, after a length check.
 *
 * `timingSafeEqual` throws on a length mismatch rather than returning false, so the
 * check is required for correctness, not just speed. Length is not a secret.
 */
function staticTokenMatches(expected: string, actual: string) {
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
  /**
   * A token accepted IN ADDITION to the ones registered in the token store, for a
   * caller that supplied its own out of band (`--token`). Ordinary tokens are
   * issued with `mimo llm-server issue` and carry their own expiry and model
   * scope; this one has neither.
   */
  token?: string
  /** Directory whose MiMoCode instance (and therefore provider config) is used. */
  directory: string
  /**
   * Models this SERVER may call, as `provider/model`. Empty means every model the
   * instance has configured. A token may narrow this further but never widen it.
   */
  models?: readonly string[]
}

/**
 * `ModelScope` is the load-bearing distinction in this file: `undefined` means NO
 * RESTRICTION, an array means EXACTLY those refs, and an empty array therefore means
 * DENY EVERYTHING.
 *
 * The two must be distinct values. An earlier version used `[]` for both
 * "unrestricted" and "empty intersection", so a token whose models were disjoint
 * from the server's granted access to every configured model — widening the token
 * and the server at once, the exact opposite of the invariant. A typo in
 * `issue --model` produced the same full access.
 */

/** An empty `--model` list from the CLI means "no restriction", not "deny all". */
function asScope(list: readonly string[] | undefined): ModelScope {
  return list && list.length > 0 ? list : undefined
}

/**
 * Effective scope for one request: the INTERSECTION of the server's scope and the
 * token's.
 *
 * A union, or letting either side win, would turn a narrowly-issued key into a way
 * to widen the server it was issued against. The result may legitimately be empty,
 * which denies everything.
 */
function intersectScope(server: ModelScope, token: ModelScope): ModelScope {
  if (!server) return token
  if (!token) return server
  return server.filter((ref) => token.includes(ref))
}

/**
 * Per-request model scope, handed from the auth middleware to the route.
 *
 * A WeakMap keyed on the raw `Request` rather than hono's `c.set`/`c.get`, because
 * typing those requires a parameterised `Hono<{Variables}>` that the shared
 * `adapter.create(app: Hono)` will not accept — and neither widening that shared
 * signature nor augmenting hono's global `ContextVariableMap` is worth it for one
 * private key. Weak keys mean a finished request drops out on its own.
 *
 * The value is WRAPPED because `undefined` is a meaningful scope ("unrestricted")
 * and a bare `WeakMap.get` miss is also `undefined`. Without the wrapper, a route
 * that somehow ran without the auth middleware would be indistinguishable from an
 * unrestricted one — and would therefore get everything.
 */
const requestScope = new WeakMap<Request, { models: ModelScope }>()

function scopeFor(request: Request): ModelScope {
  const entry = requestScope.get(request)
  // Absent only if a route ran without the auth middleware, which would be a wiring
  // bug. An empty list denies everything, so this genuinely fails closed.
  if (!entry) return []
  return entry.models
}

export function create(opts: Options) {
  const serverScope = asScope(opts.models)

  const app = new Hono()
    .onError((err, c) => {
      if (err instanceof RequestError) {
        return c.json(errorBody({ message: err.message, type: err.type, code: err.code }), err.status)
      }
      if (err instanceof Provider.ModelNotFoundError) {
        return c.json(
          errorBody({ message: err.message, type: "invalid_request_error", code: "model_not_found" }),
          404,
        )
      }
      // The model is real and the request was well formed; the provider package
      // simply cannot do this. That is neither the caller's mistake (4xx) nor a
      // failure (5xx-as-outage), so it gets the status that means "not implemented
      // here" and a message naming the package.
      if (err instanceof Provider.SpeechUnsupportedError) {
        return c.json(
          errorBody({
            message: `Model \`${err.data.providerID}/${err.data.modelID}\` cannot synthesize speech: provider package \`${err.data.npm}\` exposes no speech model`,
            type: "invalid_request_error",
            code: "unsupported_capability",
          }),
          501,
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
      // No OPTIONS carve-out: CORS headers are not served (see the spec), so
      // exempting the method would buy nothing while letting an unauthenticated
      // request reach the instance middleware and boot an instance.
      const provided = presentedToken((name) => c.req.header(name))
      if (!provided) {
        return c.json(
          errorBody({ message: "Missing bearer token", type: "invalid_request_error", code: "invalid_api_key" }),
          401,
        )
      }

      if (opts.token && staticTokenMatches(opts.token, provided)) {
        requestScope.set(c.req.raw, { models: serverScope })
        return next()
      }

      const verdict = await LLMServerTokens.verify(opts.directory, provided)
      if (!verdict.ok) {
        // Expiry is reported with its OWN code and says what to do about it. A
        // caller cannot otherwise tell "this key aged out, ask for another" from
        // "this key was never valid, stop retrying" — and that difference is the
        // whole point of having a lifetime.
        if (verdict.reason === "expired") {
          return c.json(
            errorBody({
              // The command is DERIVED, not the literal string `mimo`: this process
              // may have been started through npx, a node_modules shim, or a source
              // checkout, in which case `mimo` is not a command and naming it would
              // be advice the caller cannot act on.
              message: `Token expired; request a new one with \`${Self.commandLine("llm-server", "issue")}\``,
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

      requestScope.set(c.req.raw, { models: intersectScope(serverScope, asScope(verdict.record.models)) })
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
      // `undefined` lists everything; an array lists exactly it, so an empty scope
      // correctly advertises nothing.
      const scope = scopeFor(c.req.raw)
      const visible = scope ? models.filter((id) => scope.includes(id)) : models
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

      const started = await start({ req, allowlist: scopeFor(c.req.raw), abort: c.req.raw.signal })

      if (req.stream !== true) {
        return c.json(await collect({ id: started.id, ref: started.ref, result: started.result }))
      }

      // Pull the FIRST frame before committing a status line.
      //
      // `streamText` is lazy, so `start()` above performs no upstream I/O: an
      // expired credential or an unreachable provider would otherwise surface as
      // `200` plus an in-band error frame, leaving the caller unable to tell a
      // rejected request from one that died at token 500. Draining one frame here
      // lets a pre-first-byte failure propagate to `onError` and get the status it
      // deserves. Only failures after this point are reported in band, which is
      // what §S2.7 actually promises.
      const frames = stream({
        id: started.id,
        ref: started.ref,
        result: started.result,
        includeUsage: req.stream_options?.include_usage === true,
      })[Symbol.asyncIterator]()
      const first = await frames.next()

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
          if (!first.done) await sse.writeSSE({ data: JSON.stringify(first.value) })
          for (let next = await frames.next(); !next.done; next = await frames.next()) {
            await sse.writeSSE({ data: JSON.stringify(next.value) })
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

      const result = await synthesize({ req: parsed.data, allowlist: scopeFor(c.req.raw), abort: c.req.raw.signal })
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
  /** Only set when the caller supplied a static token; issued tokens live in the store. */
  token?: string
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
function ephemeralPort(hostname: string) {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer()
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
  const url = `http://${hostname === "::1" ? "[::1]" : hostname}:${server.port}/v1`

  // Advertise where we are so `mimo llm-server issue`, running in a DIFFERENT
  // process, can print a base_url that actually works. Removed on stop, and any
  // reader treats a dead pid as no address at all.
  await LLMServerTokens.publish(opts.directory, {
    pid: process.pid,
    hostname,
    port: server.port,
    url,
    started: Date.now(),
  })

  let closing: Promise<void> | undefined
  return {
    hostname,
    port: server.port,
    url,
    token: opts.token,
    stop() {
      closing ??= LLMServerTokens.unpublish(opts.directory)
        .catch(() => {})
        .then(() => server.stop(true))
      return closing
    },
  }
}

export * as LLMServer from "./server"
