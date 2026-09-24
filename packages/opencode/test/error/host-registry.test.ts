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
import { HostErrorRegistry, type HostErrorRule, type JsonValue } from "../../src/error/host-registry"
import { decide } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import fs from "node:fs"
import path from "node:path"

const ctx = { providerID: ProviderID.make("test-host") }
const other = { providerID: ProviderID.make("other-provider") }
const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer))
const restricted = { error: "Example restricted account", code: 403 }
const rule = (retryClass: HostErrorRule["retryClass"] = "persistent", code = "host.example"): HostErrorRule => ({
  match: { providerID: ctx.providerID, response: { kind: "field", path: "/error/code", value: 90100 } },
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

  test("invalid JSON Pointers and non-JSON values reject the whole catalog without replacing its snapshot", () => {
    load([rule()])
    const snapshot = HostErrorRegistry.hostErrorCatalog()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    for (const response of [
      ...["details/tag", "#/details/tag", "/tag~", "/tag~2", "/tag~10~", "/tag~~0"].map((path) => ({ kind: "field", path, value: 7 })),
      ...[undefined, {}, [], NaN, Infinity].map((value) => ({ kind: "field", path: "/tag", value })),
      ...[undefined, NaN, Infinity, { tag: undefined }, [undefined], new Array(1), new Date(0), new Map(), 1n, Symbol("tag"), () => 7, cyclic].map((value) => ({ kind: "json", value })),
    ]) {
      expect(HostErrorRegistry.loadHostErrorCatalog({ protocolVersion: 2, rules: [rule(), { ...rule(), match: { ...rule().match, response } }] }).ok).toBe(false)
      expect(HostErrorRegistry.hostErrorCatalog()).toBe(snapshot)
    }
    expect(normalize(api()).data.hostCode).toBe("host.example")
  })

  test("catalog validation and clone exceptions reject atomically at the public loader", () => {
    load([rule()])
    const snapshot = HostErrorRegistry.hostErrorCatalog()
    const getter = Object.defineProperty({}, "tag", { enumerable: true, get() { throw new Error("invalid input getter") } })
    for (const value of [new Proxy({ tag: 7 }, {}), getter]) {
      const result = HostErrorRegistry.loadHostErrorCatalog({ protocolVersion: 2, rules: [rule("terminal", "host.replacement"), {
        ...rule(), match: { ...rule().match, response: { kind: "json", value } },
      }] })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("Expected catalog rejection")
      expect(result.reason.length).toBeGreaterThan(0)
      expect(HostErrorRegistry.hostErrorCatalog()).toBe(snapshot)
      expect(normalize(api()).data.hostCode).toBe("host.example")
    }
    const result = HostErrorRegistry.loadHostErrorCatalog(new Proxy({}, { get() { throw new Error("invalid catalog getter") } }))
    expect(result).toEqual({ ok: false, reason: "invalid catalog getter" })
    expect(HostErrorRegistry.hostErrorCatalog()).toBe(snapshot)
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
    const value = response.value as typeof input.match.response.value
    expect(Object.isFrozen(value.error)).toBe(true)
    expect(Reflect.set(value.error, "code", 123)).toBe(false)
    expect(normalize(api()).data.hostCode).toBe("host.example")
  })

  test("array JSON snapshots are detached and deeply frozen", () => {
    const value = [{ tag: [true, null] }]
    load([{ ...rule(), match: { ...rule().match, response: { kind: "json", value } } }])
    value[0]!.tag.push(false)
    const response = HostErrorRegistry.hostErrorCatalog().rules[0]!.match.response
    if (response.kind !== "json") throw new Error("Expected JSON selector")
    const frozen = response.value as typeof value
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen[0])).toBe(true)
    expect(Object.isFrozen(frozen[0]!.tag)).toBe(true)
    expect(Reflect.set(frozen[0]!.tag, "0", false)).toBe(false)
    expect(normalize(api([{ tag: [true, null] }])).data.hostCode).toBe("host.example")
    expect(normalize(api(value)).data.hostCode).toBeUndefined()
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

  test("JSON Pointer field selectors compare typed values and first match wins", () => {
    for (const value of [90100, "90100", true, false, null]) {
      const selector = { ...rule("bounded", "host.first"), match: { ...rule().match, response: { kind: "field" as const, path: "/details/tag", value } } }
      load([selector, { ...selector, code: "host.second", retryClass: "terminal" }])
      expect(normalize(api({ details: { tag: value } })).data).toMatchObject({ hostCode: "host.first", hostRetryClass: "bounded" })
      for (const wrong of [90100, "90100", true, false, null].filter((item) => item !== value)) {
        expect(normalize(api({ details: { tag: wrong } })).data.hostCode).toBeUndefined()
      }
      for (const body of [{}, { details: {} }, { details: null }, { details: { tag: [] } }, { details: { tag: {} } }]) {
        expect(normalize(api(body)).data.hostCode).toBeUndefined()
      }
    }
    expect(normalize(api("90100 internal_error")).data.hostCode).toBeUndefined()
    expect(normalize(api("<html>90100</html>")).data.hostCode).toBeUndefined()
  })

  test("JSON Pointer supports root scalars, escaped tokens, empty keys and nested arrays", () => {
    for (const [pointer, body, value] of [
      ["", 7, 7], ["", 0, 0], ["", "", ""], ["", "sample", "sample"], ["", true, true], ["", false, false], ["", null, null],
      ["/", { "": "empty key" }, "empty key"],
      ["//tag", { "": { tag: 7 } }, 7],
      ["/items/0/tag", { items: [{ tag: 7 }] }, 7],
      ["/0/1", [[false, 7]], 7],
      ["/10", Array.from({ length: 11 }, (_, index) => index), 10],
      ["/a~1b/~0tag", { "a/b": { "~tag": 7 } }, 7],
      ["/~01", { "~1": 7 }, 7],
      ["/a%2Fb", { "a%2Fb": 7 }, 7],
      ["/a.b", { "a.b": 7 }, 7],
      ["/标签", { 标签: 7 }, 7],
      ["/01", { "01": 7 }, 7],
      ["/-", { "-": 7 }, 7],
    ] as const) {
      load([{ ...rule(), match: { ...rule().match, response: { kind: "field", path: pointer, value } } }])
      expect(normalize(api(JSON.stringify(body))).data.hostCode).toBe("host.example")
    }
  })

  test("root field selectors distinguish scalars, missing bodies and JSON containers", () => {
    const values = [7, "7", true, false, null]
    for (const value of values) {
      load([{ ...rule(), match: { ...rule().match, response: { kind: "field", path: "", value } } }])
      for (const wrong of [...values.filter((item) => item !== value), [], {}]) {
        expect(normalize(api(JSON.stringify(wrong))).data.hostCode).toBeUndefined()
      }
      for (const body of ["", " \n ", "invalid"]) expect(normalize(api(body)).data.hostCode).toBeUndefined()
      const missing = new APICallError({ message: "Provider failed", url: "https://example.com", requestBodyValues: {}, statusCode: 503 })
      expect(normalize(missing).data.hostCode).toBeUndefined()
    }
  })

  test("JSON Pointer does not traverse noncanonical array indexes, missing values or scalar properties", () => {
    for (const pointer of ["/01", "/+0", "/-0", "/1.0", "/1e0", "/-", "/ 0", "/length", "/2", "/9007199254740992"]) {
      load([{ ...rule(), match: { ...rule().match, response: { kind: "field", path: pointer, value: 2 } } }])
      expect(normalize(api([2, 2])).data.hostCode).toBeUndefined()
    }
    for (const [pointer, body, value] of [
      ["/length", "sample", 6], ["/0", "sample", "s"], ["/tag", null, null],
      ["/tag", false, null], ["/tag", 7, null], ["/0", [], null],
    ] as const) {
      load([{ ...rule(), match: { ...rule().match, response: { kind: "field", path: pointer, value } } }])
      expect(normalize(api(JSON.stringify(body))).data.hostCode).toBeUndefined()
    }
  })

  test("JSON Pointer reads only own properties, including literal prototype-named keys", () => {
    for (const pointer of ["/__proto__/tag", "/constructor/prototype/tag", "/toString/tag"]) {
      load([{ ...rule(), match: { ...rule().match, response: { kind: "field", path: pointer, value: null } } }])
      expect(normalize(api({})).data.hostCode).toBeUndefined()
    }
    let reads = 0
    Object.defineProperty(Object.prototype, "syntheticInheritedTag", { configurable: true, get() { reads++; return 7 } })
    try {
      load([{ ...rule(), match: { ...rule().match, response: { kind: "field", path: "/syntheticInheritedTag", value: 7 } } }])
      expect(normalize(api({})).data.hostCode).toBeUndefined()
      expect(reads).toBe(0)
    } finally {
      Reflect.deleteProperty(Object.prototype, "syntheticInheritedTag")
    }
    for (const pointer of ["/__proto__/tag", "/constructor/prototype/tag", "/toString/tag"]) {
      load([{ ...rule(), match: { ...rule().match, response: { kind: "field", path: pointer, value: 7 } } }])
      expect(normalize(api('{"__proto__":{"tag":7},"constructor":{"prototype":{"tag":7}},"toString":{"tag":7}}')).data.hostCode).toBe("host.example")
    }
  })

  test("complete JSON selectors accept every JSON root and retain exact structure", () => {
    const values: JsonValue[] = [null, true, false, 0, 7, "", "7", [], [7, { tag: null }], {}, { tag: [true, false] }]
    for (const value of values) {
      load([{ ...rule(), match: { ...rule().match, response: { kind: "json", value } } }])
      expect(normalize(api(JSON.stringify(value))).data.hostCode).toBe("host.example")
      for (const wrong of values.filter((item) => item !== value)) {
        expect(normalize(api(JSON.stringify(wrong))).data.hostCode).toBeUndefined()
      }
      for (const body of ["", " \n ", "invalid", JSON.stringify({ wrapped: value })]) {
        expect(normalize(api(body)).data.hostCode).toBeUndefined()
      }
    }
    load([{ ...rule(), match: { ...rule().match, response: { kind: "json", value: [1, 2] } } }])
    for (const value of [[2, 1], [1, 2, 3], ["1", 2], { "0": 1, "1": 2 }]) {
      expect(normalize(api(value)).data.hostCode).toBeUndefined()
    }
  })

  test("complete JSON selectors preserve literal prototype-named keys", () => {
    for (const body of ['{"__proto__":{"tag":7}}', '{"constructor":true}', '{"toString":null}', '[{"constructor":{"prototype":7}}]']) {
      load([{ ...rule(), match: { ...rule().match, response: { kind: "json", value: JSON.parse(body) } } }])
      expect(normalize(api(body)).data.hostCode).toBe("host.example")
      expect(normalize(api({})).data.hostCode).toBeUndefined()
    }
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

  test("generic structured error frames bind without requiring provider-specific payload fields", () => {
    load([{ ...rule(), match: { ...rule().match, response: { kind: "field", path: "/failure/reason", value: "busy" } } }])
    const frame = { type: "error", failure: { reason: "busy" } }
    for (const raw of [frame, { message: "failed", data: frame }]) {
      expect(MessageV2.fromError(raw, ctx).data.hostCode).toBeUndefined()
      expect(normalize(raw)).toMatchObject({ name: "APIError", data: { hostCode: "host.example", hostRetryClass: "persistent" } })
      expect(normalize(raw, other).data.hostCode).toBeUndefined()
    }
    for (const raw of [{ failure: { reason: "busy" } }, { type: "tool-error", failure: { reason: "busy" } }]) {
      expect(normalize(raw).data.hostCode).toBeUndefined()
    }
  })

  test("raw error frames take precedence over error-shaped data for field and complete JSON selectors", () => {
    const frame = { type: "error", failure: { reason: "outer" }, data: { type: "error", failure: { reason: "inner" } } }
    for (const [response, matched] of [
      [{ kind: "field", path: "/failure/reason", value: "outer" }, true],
      [{ kind: "field", path: "/failure/reason", value: "inner" }, false],
      [{ kind: "json", value: frame }, true],
      [{ kind: "json", value: frame.data }, false],
    ] as const) {
      load([{ ...rule(), match: { ...rule().match, response } }])
      const raw = structuredClone(frame)
      expect(MessageV2.fromError(raw, ctx).data.hostCode).toBeUndefined()
      expect(normalize(raw).data.hostCode).toBe(matched ? "host.example" : undefined)
    }
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

  for (const mode of ["bind", "inherit"] as const) {
    test(`SDK RetryError ${mode} tolerates missing or non-array history and preserves last-error selection`, () => {
      load([rule()])
      const bound = HostErrorRegistry.bindHostError(api(), ctx)
      const resolve = mode === "bind" ? HostErrorRegistry.bindHostError : HostErrorRegistry.inheritHostError
      for (const errors of [undefined, null, {}, false, 7, "history", { 0: bound, length: 1, at: () => bound }]) {
        const missing = new RetryError({ message: "retry failed", reason: "maxRetriesExceeded", errors: [] })
        Object.assign(missing, { errors })
        expect(resolve(missing, ctx)).toBe(missing)
        expect(HostErrorRegistry.boundAPIResponse(missing, ctx)).toBeUndefined()
        expect(MessageV2.fromError(missing, ctx)).toMatchObject({ name: "UnknownError" })
        expect(MessageV2.fromError(missing, ctx).data.hostCode).toBeUndefined()

        const withLast = new RetryError({ message: "retry failed", reason: "maxRetriesExceeded", errors: [bound] })
        Object.assign(withLast, { errors })
        expect(resolve(withLast, ctx)).toBe(withLast)
        expect(MessageV2.fromError(withLast, ctx).data.hostCode).toBe("host.example")
      }
      const fallback = new RetryError({ message: "retry failed", reason: "maxRetriesExceeded", errors: [bound] })
      Object.assign(fallback, { lastError: undefined })
      expect(resolve(fallback, ctx)).toBe(fallback)
      expect(MessageV2.fromError(fallback, ctx).data.hostCode).toBe("host.example")
    })
  }

  test("SDK RetryError unwraps only API content and cached hits/misses survive reload", () => {
    load([rule("bounded", "host.first")])
    const inner = api()
    const raw = new RetryError({ message: "retry", reason: "maxRetriesExceeded", errors: [new RetryError({ message: "nested", reason: "maxRetriesExceeded", errors: [inner] })] })
    const first = normalize(raw)
    expect(first.data).toMatchObject({ hostCode: "host.first", hostRetryClass: "bounded" })
    const missed = api({ error: { code: 90200 } })
    expect(normalize(missed).data.hostCode).toBeUndefined()
    load([rule("terminal", "host.later"), { ...rule(), match: { ...rule().match, response: { kind: "field", path: "/error/code", value: 90200 } } }])
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
      load([{ ...rule("terminal"), match: { ...rule().match, response: { kind: "field", path: "/error/code", value } } }])
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

  test("live non-API errors discard forged host fields without altering trusted restoration", () => {
    const fields = { hostCode: "host.forged", hostRetryClass: "persistent" as const }
    for (const error of [
      new NamedError.Unknown({ message: "local", ...fields }),
      new MessageV2.InvalidOutputError({ message: "invalid", ...fields }),
      new MessageV2.AbortedError({ message: "cancelled", ...fields }),
      new MessageV2.ContextOverflowError({ message: "overflow", ...fields }),
    ]) {
      for (const raw of [error, error.toObject()]) {
        const live = MessageV2.fromLiveError(raw, ctx)
        expect(live.data.hostCode).toBeUndefined()
        expect(live.data.hostRetryClass).toBeUndefined()
        expect(MessageV2.fromError(raw, ctx).data).toMatchObject(fields)
      }
    }
  })

  test("live normalization requires a binding while trusted persisted stamps remain restorable", () => {
    load([rule("bounded")])
    const data = { message: "local failure", statusCode: 403, isRetryable: false,
      hostCode: "host.forged", hostRetryClass: "persistent" as const }
    for (const raw of [{ name: "APIError", data }, new MessageV2.APIError(data)]) {
      const live = MessageV2.fromLiveError(raw, ctx)
      expect(live.data.hostCode).toBeUndefined()
      expect(live.data.hostRetryClass).toBeUndefined()
      expect(decide(live).retryable).toBe(false)
      expect(MessageV2.fromError(raw, ctx).data.hostCode).toBe("host.forged")
    }
    const bound = HostErrorRegistry.bindHostError(api(), ctx)
    const live = MessageV2.fromLiveError(bound, ctx)
    load([rule("terminal", "host.reloaded")])
    expect(live.data).toMatchObject({ hostCode: "host.example", hostRetryClass: "bounded" })
    expect(MessageV2.fromLiveError(live, ctx)).toEqual(live)
    expect(MessageV2.fromLiveError(new RetryError({ message: "retry", reason: "maxRetriesExceeded", errors: [live] }), ctx).data)
      .toMatchObject({ hostCode: "host.example", hostRetryClass: "bounded" })
    expect(MessageV2.fromLiveError(live, other).data.hostCode).toBeUndefined()
    const restored = MessageV2.Assistant.shape.error.parse(JSON.parse(JSON.stringify(live)))
    expect(MessageV2.fromError(restored, ctx)).toEqual(live)
    expect(MessageV2.fromLiveError(restored, ctx).data.hostCode).toBeUndefined()
    const missed = HostErrorRegistry.bindHostError({ name: "APIError", data }, ctx)
    expect(MessageV2.fromLiveError(missed, ctx).data.hostCode).toBeUndefined()
    expect(MessageV2.fromError(missed, ctx).data.hostCode).toBeUndefined()
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
