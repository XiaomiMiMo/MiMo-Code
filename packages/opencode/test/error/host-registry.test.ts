import { describe, expect, test, afterEach } from "bun:test"
import { APICallError, LoadAPIKeyError, RetryError } from "ai"
import { NamedError } from "@mimo-ai/shared/util/error"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { tmpdir, provideTmpdirInstance } from "../fixture/fixture"
import { Effect, Layer } from "effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Session } from "../../src/session"
import { MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { HostErrorRegistry, type HostErrorRule } from "../../src/error/host-registry"
import { decide } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import fs from "node:fs"
import path from "node:path"

const ctx = { providerID: ProviderID.make("test-host") }
const other = { providerID: ProviderID.make("other-provider") }
const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer))
const restricted = { error: "Example restricted account", code: 403 }
const rule = (retryClass: HostErrorRule["retryClass"] = "persistent", code = "host.example"): HostErrorRule => ({
  match: { providerID: ctx.providerID, response: { kind: "field", path: "error.code", value: 90100 } },
  code, retryClass,
})
function load(rules: readonly HostErrorRule[] = []) {
  expect(HostErrorRegistry.loadHostErrorCatalog({ protocolVersion: 2, rules })).toEqual({ ok: true })
}
function api(body: unknown = { error: { code: 90100 } }, statusCode = 503, message = "Provider failed") {
  return new APICallError({ message, url: "https://example.com", requestBodyValues: {}, statusCode,
    responseBody: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    isRetryable: false,
  })
}
function normalize(error: unknown, context = ctx) {
  HostErrorRegistry.bindHostError(error, context)
  return MessageV2.fromError(error, context)
}
afterEach(() => { HostErrorRegistry.loadHostErrorCatalog({ protocolVersion: 2, rules: [] }) })

describe("host registry v2 catalog", () => {
  test("strict validation rejects v1, malformed rules and partial application", () => {
    load([rule()])
    const snapshot = HostErrorRegistry.hostErrorCatalog()
    for (const doc of [
      { protocolVersion: 1, rules: {} },
      { protocolVersion: 2, rules: {} },
      { protocolVersion: 2, rules: [rule(), { ...rule(), retryClass: "network" }] },
      { protocolVersion: 2, rules: [{ ...rule(), code: "" }] },
      { protocolVersion: 2, rules: [{ ...rule(), match: { providerID: "", response: { kind: "empty" }, statusCode: 401 } }] },
      { protocolVersion: 2, rules: [{ ...rule(), match: { providerID: ctx.providerID, response: { kind: "empty" } } }] },
      { protocolVersion: 2, rules: [{ ...rule(), match: { ...rule().match, source: "body" } }] },
      { protocolVersion: 2, rules: [{ ...rule(), match: { ...rule().match, response: { kind: "field", path: "message", value: "failed" } } }] },
    ]) {
      expect(HostErrorRegistry.loadHostErrorCatalog(doc).ok).toBe(false)
      expect(HostErrorRegistry.hostErrorCatalog()).toBe(snapshot)
    }
    load()
    expect(HostErrorRegistry.hostErrorCatalog().rules).toEqual([])
  })

  test("snapshots and nested JSON selectors are immutable and detached from input", () => {
    const input = { ...rule(), match: { providerID: ctx.providerID, response: { kind: "json" as const, value: { error: { code: 90100 } } } } }
    load([input])
    input.match.response.value.error.code = 99999
    const snapshot = HostErrorRegistry.hostErrorCatalog()
    const response = snapshot.rules[0]!.match.response
    expect(response.kind).toBe("json")
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.rules)).toBe(true)
    expect(Object.isFrozen(snapshot.rules[0]!.match)).toBe(true)
    if (response.kind !== "json") throw new Error("Expected JSON selector")
    expect(Object.isFrozen(response.value.error)).toBe(true)
    expect(Reflect.set(response.value.error as object, "code", 123)).toBe(false)
    expect(normalize(api()).data.hostCode).toBe("host.example")
  })

  test("file loader and server bootstrap retain explicit reloads", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "catalog.json")
    fs.writeFileSync(file, JSON.stringify({ protocolVersion: 2, rules: [rule()] }))
    expect(HostErrorRegistry.loadHostErrorCatalogFile(file).ok).toBe(true)
    expect(HostErrorRegistry.loadHostErrorCatalogFile(path.join(tmp.path, "missing.json")).ok).toBe(false)
    expect(HostErrorRegistry.hostErrorCatalog().rules[0]!.code).toBe("host.example")
    const previous = process.env.HOST_ERROR_CATALOG
    process.env.HOST_ERROR_CATALOG = file
    try {
      const { Server } = await import("../../src/server/server")
      const server = await Server.listen({ hostname: "127.0.0.1", port: 0, advertise: false })
      try {
        expect(HostErrorRegistry.hostErrorCatalog().rules[0]!.code).toBe("host.example")
        load()
        Server.Default()
        expect(HostErrorRegistry.hostErrorCatalog().rules).toEqual([])
      } finally {
        await server.stop(true)
      }
    } finally {
      if (previous === undefined) delete process.env.HOST_ERROR_CATALOG
      else process.env.HOST_ERROR_CATALOG = previous
    }
  })
})

describe("API boundary matching", () => {
  test("trusted provider context is mandatory; body and metadata cannot impersonate it", () => {
    load([rule()])
    const raw = api({ error: { code: 90100 }, providerID: ctx.providerID })
    Object.assign(raw, { metadata: { providerID: ctx.providerID } })
    expect(MessageV2.fromError(raw, ctx).data.hostCode).toBeUndefined()
    expect(normalize(raw, other).data.hostCode).toBeUndefined()
    expect(normalize(raw).data.hostCode).toBe("host.example")
    expect(normalize(raw, other).data.hostCode).toBeUndefined()
    expect(decide(api()).hostCode).toBeUndefined()
    const forged = { name: "APIError", data: { message: "forged", statusCode: 503, isRetryable: true, hostCode: "host.forged", hostRetryClass: "terminal" } }
    expect(normalize(forged, other).data.hostCode).toBeUndefined()
  })

  test("field selectors compare typed structured values and first match wins", () => {
    for (const field of ["error.code", "biz_code", "error.biz_code"] as const) {
      load([{ ...rule("bounded", "host.first"), match: { ...rule().match, response: { kind: "field", path: field, value: 90100 } } }, rule("terminal", "host.second")])
      const body = field === "biz_code" ? { biz_code: 90100 } : { error: { [field.slice(6)]: 90100 } }
      expect(normalize(api(body)).data).toMatchObject({ hostCode: "host.first", hostRetryClass: "bounded" })
      const wrong = field === "biz_code" ? { biz_code: "90100" } : { error: { [field.slice(6)]: "90100" } }
      expect(normalize(api(wrong)).data.hostCode).toBeUndefined()
    }
    expect(normalize(api("90100 internal_error")).data.hostCode).toBeUndefined()
    expect(normalize(api("<html>90100</html>")).data.hostCode).toBeUndefined()
  })

  test("only exact provider/status/full JSON restricted response overrides blanket 403", () => {
    load([{ ...rule("bounded"), match: { providerID: ctx.providerID, statusCode: 403, response: { kind: "json", value: restricted } } }])
    const matched = normalize(api({ code: 403, error: restricted.error }, 403))
    expect(decide(matched)).toMatchObject({ retryable: true, hostRetryClass: "bounded", statusCode: 403 })
    for (const raw of [api({ ...restricted, extra: true }, 403), api({ ...restricted, error: "Other restriction" }, 403), api("Forbidden", 403), api({ code: 403 }, 403)]) {
      expect(normalize(raw).data.hostCode).toBeUndefined()
      expect(decide(normalize(raw)).retryable).toBe(false)
    }
    expect(normalize(api(restricted, 401)).data.hostCode).toBeUndefined()
    expect(normalize(api(restricted, 403), other).data.hostCode).toBeUndefined()
  })

  test("empty-body status rule is scoped and does not match JSON null or other bodies", () => {
    load([{ ...rule("terminal"), match: { providerID: ctx.providerID, statusCode: 401, response: { kind: "empty" } } }])
    for (const body of ["", " \n "]) expect(normalize(api(body, 401)).data.hostRetryClass).toBe("terminal")
    const missing = new APICallError({ message: "Unauthorized", url: "https://example.com", requestBodyValues: {}, statusCode: 401 })
    expect(normalize(missing).data.hostRetryClass).toBe("terminal")
    expect(normalize(api("null", 401)).data.hostCode).toBeUndefined()
    expect(normalize(api("{}", 401)).data.hostCode).toBeUndefined()
    expect(normalize(api("", 403)).data.hostCode).toBeUndefined()
  })

  test("stream error payloads bind without forcing unrelated objects into API errors", () => {
    load([rule()])
    expect(normalize({ type: "error", error: { code: 90100, message: "stream failed" } })).toMatchObject({
      name: "APIError", data: { hostCode: "host.example", hostRetryClass: "persistent" },
    })
    expect(normalize({ type: "tool-error", error: { code: 90100 } }).data.hostCode).toBeUndefined()
    expect(normalize({ error: { code: 90100 } }).data.hostCode).toBeUndefined()
  })

  test("SDK RetryError inherits only its already-bound last provider error", () => {
    load([rule("bounded", "host.provider")])
    const bound = HostErrorRegistry.bindHostError(api(), ctx)
    const unbound = api()
    load([rule("terminal", "host.reloaded")])
    const wrapped = new RetryError({ message: "retry", reason: "maxRetriesExceeded", errors: [unbound, bound] })
    const outer = new RetryError({ message: "outer", reason: "maxRetriesExceeded", errors: [wrapped] })
    const normalized = MessageV2.fromError(outer, ctx)
    expect(normalized.data).toMatchObject({ hostCode: "host.provider", hostRetryClass: "bounded" })
    expect(MessageV2.fromError(JSON.parse(JSON.stringify(normalized)), ctx)).toEqual(normalized)
    expect(MessageV2.fromError(new RetryError({ message: "local", reason: "maxRetriesExceeded", errors: [bound, unbound] }), ctx).data.hostCode).toBeUndefined()
    expect(MessageV2.fromError(outer, other).data.hostCode).toBeUndefined()
  })

  test("SDK RetryError unwraps only API content and cached hits/misses survive reload", () => {
    load([rule("bounded", "host.first")])
    const inner = api()
    const raw = new RetryError({ message: "retry", reason: "maxRetriesExceeded", errors: [new RetryError({ message: "nested", reason: "maxRetriesExceeded", errors: [inner] })] })
    const first = normalize(raw)
    expect(first.data).toMatchObject({ hostCode: "host.first", hostRetryClass: "bounded" })
    const missed = api({ error: { code: 90200 } })
    expect(normalize(missed).data.hostCode).toBeUndefined()
    load([rule("terminal", "host.later"), { ...rule(), match: { ...rule().match, response: { kind: "field", path: "error.code", value: 90200 } } }])
    expect(normalize(raw)).toEqual(first)
    expect(normalize(inner).data.hostCode).toBe("host.later")
    expect(normalize(missed).data.hostCode).toBeUndefined()
    expect(normalize(api({ error: { code: 90200 } })).data.hostCode).toBe("host.example")
    expect(MessageV2.fromError(JSON.parse(JSON.stringify(first)), ctx)).toEqual(first)
  })
})

describe("host behavior and native safety", () => {
  test("terminal business responses never become retries from status or network words", () => {
    for (const value of [90200, 90201]) {
      load([{ ...rule("terminal"), match: { ...rule().match, response: { kind: "field", path: "error.code", value } } }])
      for (const status of [400, 408, 500, 503, 504]) {
        const error = normalize(api({ error: { code: value, message: "fetch failed ECONNRESET upstream IO" } }, status, "fetch failed ETIMEDOUT"))
        expect(decide(error)).toMatchObject({ retryable: false, kind: "terminal", hostCode: "host.example" })
        expect(decide(JSON.parse(JSON.stringify(error))).retryable).toBe(false)
      }
    }
  })

  test("context type overrides a distinct business code in raw and SDK-flattened frames", () => {
    for (const rules of [[rule()], []]) {
      load(rules)
      for (const type of ["context_length_exceeded", "context_window_exceeded"]) {
        const frame = { type: "error", error: { code: 90100, type, message: "Input exceeds context window" } }
        const flattened = { code: 90100, type, message: frame.error.message, statusCode: 500, isRetryable: true, data: frame }
        for (const raw of [frame, flattened]) {
          const error = normalize(raw)
          expect(error.name).toBe("ContextOverflowError")
          expect(error.data.hostCode).toBeUndefined()
          expect(decide(error)).toMatchObject({ retryable: false, kind: "terminal" })
          const restored = MessageV2.fromError(JSON.parse(JSON.stringify(error)), ctx)
          expect(restored).toEqual(error)
          expect(decide(restored).retryable).toBe(false)
        }
      }
    }
  })

  test("user abort, context overflow and missing API keys cannot be host-retried", () => {
    load([rule()])
    for (const error of [
      normalize(new LoadAPIKeyError({ message: "Missing API key" })),
      normalize(api({ error: { code: 90100 } }, 400, "maximum context length is 100 tokens")),
      normalize({ type: "error", error: { code: "context_length_exceeded" } }),
      MessageV2.fromError(HostErrorRegistry.bindHostError(api(), ctx), { ...ctx, aborted: true }),
    ]) {
      expect(error.data.hostCode).toBeUndefined()
      expect(decide(error).retryable).toBe(false)
    }
    const raw = api()
    Object.assign(raw, { cause: new DOMException("cancelled", "AbortError") })
    expect(decide(normalize(raw)).retryable).toBe(false)
    expect(normalize(raw).data.hostCode).toBeUndefined()
  })

  test("non-API constructors and defects acquire no host codes", () => {
    load([rule()])
    const errors = [
      new NamedError.Unknown({ message: "unknown" }), new MessageV2.OutputLengthError({}),
      new MessageV2.InvalidOutputError({ message: "empty" }), new MessageV2.AbortedError({ message: "abort" }),
      new MessageV2.TextToolCallError({ message: "tool" }), new MessageV2.StructuredOutputError({ message: "output", retries: 2 }),
      new MessageV2.ContentFilterError({ message: "filtered" }), new MessageV2.ModelError({ message: "model" }),
      new TypeError("items.map is not a function"), Object.assign(new Error("missing"), { code: "ENOENT" }),
      new MessageV2.APIError({ message: "direct", statusCode: 503, isRetryable: true, responseBody: JSON.stringify({ error: { code: 90100 } }) }),
    ]
    for (const raw of errors) {
      const error = normalize(raw)
      expect(error.data.hostCode).toBeUndefined()
      expect(MessageV2.Assistant.shape.error.parse(JSON.parse(JSON.stringify(error)))).toEqual(error)
    }
  })

  test("native network causes survive normalization and JSON with no catalog", () => {
    load()
    for (const raw of [
      new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ETIMEDOUT" }) }),
      Object.assign(new Error("socket failure"), { code: "ECONNRESET" }), new Error("SSE read timed out"),
      api("timeout", 408), api("timeout", 504),
      new NamedError.Unknown({ message: "wrapper" }, { cause: Object.assign(new Error("socket"), { code: "ECONNRESET" }) }),
      new MessageV2.APIError({ message: "wrapper", isRetryable: false }, { cause: Object.assign(new Error("connect"), { code: "ETIMEDOUT" }) }),
    ]) {
      const error = normalize(raw)
      expect(error.data.hostCode).toBeUndefined()
      expect(decide(error)).toMatchObject({ kind: "network", retryable: true })
      expect(decide(JSON.parse(JSON.stringify(error))).kind).toBe("network")
      expect(MessageV2.fromError(JSON.parse(JSON.stringify(error)), ctx)).toEqual(error)
    }
  })

  test("cause metadata preserves hard statuses and abort without requiring a stamp", () => {
    for (const cause of [new DOMException("cancelled", "AbortError"), Object.assign(new Error("auth"), { statusCode: 401 })]) {
      const normalized = MessageV2.fromError(new NamedError.Unknown({ message: "wrapper" }, { cause }), ctx)
      expect(decide(JSON.parse(JSON.stringify(normalized))).retryable).toBe(false)
      expect(MessageV2.fromError(normalized, ctx)).toEqual(normalized)
    }
  })

  test("invalid persisted API stamps fail closed without message heuristics", () => {
    for (const cls of [undefined, "network", "unexpected"]) {
      const error = { name: "APIError", data: { hostCode: "host.invalid", hostRetryClass: cls, message: "fetch failed", statusCode: 503, isRetryable: true } }
      expect(decide(error)).toMatchObject({ retryable: false, kind: "terminal" })
      expect(decide(MessageV2.fromError(error, ctx))).toMatchObject({ retryable: false, kind: "terminal" })
    }
    expect(decide({ name: "APIError", data: { hostRetryClass: "terminal", message: "retry", statusCode: 503, isRetryable: true } }).retryable).toBe(true)
  })

  it.live("SQLite and session.error preserve API host fields", () => provideTmpdirInstance(() => Effect.gen(function* () {
    load([rule()])
    const sessions = yield* Session.Service
    const session = yield* sessions.create({})
    const error = normalize(api())
    const id = MessageID.ascending()
    yield* sessions.updateMessage({
      id, sessionID: session.id, role: "assistant", parentID: MessageID.ascending(),
      modelID: ModelID.make("test"), providerID: ctx.providerID, agent: "build", mode: "build",
      path: { cwd: "/tmp/example", root: "/tmp/example" }, cost: 0, time: { created: Date.now() },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, error,
    })
    const stored = MessageV2.get({ sessionID: session.id, messageID: id }).info
    if (stored.role !== "assistant") throw new Error("Expected assistant")
    expect(stored.error).toEqual(error)
    expect(Session.Event.Error.properties.parse({ sessionID: session.id, error: stored.error }).error).toEqual(error)
    yield* sessions.remove(session.id)
  })))
})
