import { describe, expect, test, beforeEach } from "bun:test"
import {
  birthIdentity,
  hostErrorCatalog,
  hostRetryClass,
  isBirthIdentity,
  isRetryClass,
  loadHostErrorCatalog,
  loadHostErrorCatalogFile,
  stampHostError,
  HostErrorRegistry,
} from "../../src/error/host-registry"
import { decide } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

function resetCatalog() {
  loadHostErrorCatalog({ protocolVersion: 1, rules: {} })
}

describe("host-registry catalog", () => {
  beforeEach(resetCatalog)

  test("rejects malformed doc and keeps previous snapshot", () => {
    loadHostErrorCatalog({
      protocolVersion: 1,
      rules: { "NamedError:InvalidOutputError": { code: "host.a", retryClass: "terminal" } },
    })
    expect(hostErrorCatalog().rules["NamedError:InvalidOutputError"]?.code).toBe("host.a")
    const bad = loadHostErrorCatalog({
      protocolVersion: 1,
      rules: { "NamedError:InvalidOutputError": { code: "host.b", retryClass: "nope" } },
    })
    expect(bad.ok).toBe(false)
    expect(hostErrorCatalog().rules["NamedError:InvalidOutputError"]?.code).toBe("host.a")
  })

  test("rejects invalid birth identity keys", () => {
    const res = loadHostErrorCatalog({
      protocolVersion: 1,
      rules: { "Regex:foo": { code: "host.a", retryClass: "terminal" } },
    })
    expect(res.ok).toBe(false)
  })

  test("accepts empty rules and atomic replace", () => {
    loadHostErrorCatalog({
      protocolVersion: 1,
      rules: { "NamedError:InvalidOutputError": { code: "host.a", retryClass: "terminal" } },
    })
    const ok = loadHostErrorCatalog({ protocolVersion: 1, rules: {} })
    expect(ok.ok).toBe(true)
    expect(Object.keys(hostErrorCatalog().rules).length).toBe(0)
  })

  test("loadHostErrorCatalogFile reads JSON", () => {
    const file = path.join(os.tmpdir(), `host-err-${Date.now()}.json`)
    fs.writeFileSync(
      file,
      JSON.stringify({
        protocolVersion: 1,
        rules: { "APIError:429": { code: "host.rate", retryClass: "rate_limit" } },
      }),
    )
    const res = loadHostErrorCatalogFile(file)
    expect(res.ok).toBe(true)
    expect(hostRetryClass({ name: "APIError", data: { statusCode: 429, message: "x", isRetryable: true } })).toBe(
      "rate_limit",
    )
    fs.unlinkSync(file)
  })
})

describe("birthIdentity", () => {
  test("APIError with status wins over NamedError name", () => {
    expect(birthIdentity({ name: "APIError", data: { statusCode: 429, message: "m", isRetryable: true } })).toBe(
      "APIError:429",
    )
  })

  test("APIError without status is NamedError:APIError", () => {
    expect(birthIdentity({ name: "APIError", data: { message: "m", isRetryable: true } })).toBe("NamedError:APIError")
  })

  test("NamedError toObject shape", () => {
    expect(birthIdentity({ name: "InvalidOutputError", data: { message: "empty output" } })).toBe(
      "NamedError:InvalidOutputError",
    )
  })

  test("plain TypeError is ErrorName", () => {
    const e = new TypeError("j.map is not a function")
    expect(birthIdentity(e)).toBe("ErrorName:TypeError")
  })

  test("guards", () => {
    expect(isBirthIdentity("NamedError:Foo")).toBe(true)
    expect(isBirthIdentity("nope")).toBe(false)
    expect(isRetryClass("rate_limit")).toBe(true)
    expect(isRetryClass("defer")).toBe(false)
  })
})

describe("stamp + decide", () => {
  beforeEach(resetCatalog)

  test("stamp once from catalog; decide uses class only", () => {
    loadHostErrorCatalog({
      protocolVersion: 1,
      rules: {
        "NamedError:InvalidOutputError": { code: "host.empty", retryClass: "terminal" },
        "APIError:429": { code: "host.rate", retryClass: "rate_limit" },
      },
    })
    const stamped = stampHostError({ name: "InvalidOutputError", data: { message: "empty output" } })
    expect((stamped as any).data.hostCode).toBe("host.empty")
    expect((stamped as any).data.hostRetryClass).toBe("terminal")
    const d = decide(stamped)
    expect(d.retryable).toBe(false)
    expect(d.kind).toBe("terminal")
    expect(d.hostCode).toBe("host.empty")
  })

  test("host rate_limit is retryable and carries hostCode", () => {
    loadHostErrorCatalog({
      protocolVersion: 1,
      rules: { "APIError:429": { code: "host.rate", retryClass: "rate_limit" } },
    })
    const obj = {
      name: "APIError",
      data: { message: "Too Many Requests", statusCode: 429, isRetryable: true, hostCode: "host.rate", hostRetryClass: "rate_limit" },
    }
    const d = decide(obj)
    expect(d.retryable).toBe(true)
    expect(d.kind).toBe("rate_limit")
    expect(d.hostCode).toBe("host.rate")
    expect(d.statusCode).toBe(429)
  })

  test("missing hostRetryClass with hostCode → terminal, no heuristics", () => {
    const d = decide({
      name: "APIError",
      data: { message: "Too Many Requests", statusCode: 429, isRetryable: true, hostCode: "host.rate" },
    })
    expect(d.retryable).toBe(false)
    expect(d.kind).toBe("terminal")
  })

  test("abort invariant cannot be host-overridden", () => {
    loadHostErrorCatalog({
      protocolVersion: 1,
      rules: { "NamedError:MessageAbortedError": { code: "host.abort", retryClass: "network" } },
    })
    const obj = {
      name: "MessageAbortedError",
      data: { message: "Aborted", hostCode: "host.abort", hostRetryClass: "network" },
    }
    // decide checks abort instances first via MessageV2.AbortedError.isInstance — name match
    const d = decide(obj)
    expect(d.retryable).toBe(false)
    expect(d.kind).toBe("terminal")
  })

  test("no hostCode → legacy heuristics", () => {
    const d = decide({
      name: "APIError",
      data: { message: "Too Many Requests", statusCode: 429, isRetryable: true },
    })
    expect(d.retryable).toBe(true)
    expect(d.hostCode).toBeUndefined()
  })

  test("APIError:401 host network is clamped at stamp to terminal (R002)", () => {
    loadHostErrorCatalog({
      protocolVersion: 1,
      rules: { "APIError:401": { code: "host.auth", retryClass: "network" } },
    })
    const stamped = stampHostError({
      name: "APIError",
      data: { message: "Unauthorized", statusCode: 401, isRetryable: true },
    })
    expect((stamped as any).data.hostRetryClass).toBe("terminal")
    const d = decide(stamped)
    expect(d.retryable).toBe(false)
    expect(d.kind).toBe("terminal")
  })

  test("401 without stamp is terminal even if later hostCode would say network (R001)", () => {
    const d = decide({
      name: "APIError",
      data: {
        message: "Unauthorized",
        statusCode: 401,
        isRetryable: true,
        hostCode: "host.rate",
        hostRetryClass: "network",
      },
    })
    expect(d.retryable).toBe(false)
  })

  test("fromError rebuild preserves host fields (stamp-once, R003)", () => {
    loadHostErrorCatalog({
      protocolVersion: 1,
      rules: { "NamedError:InvalidOutputError": { code: "host.empty", retryClass: "terminal" } },
    })
    const first = stampHostError({ name: "InvalidOutputError", data: { message: "empty output" } })
    // simulate rebuild dropping then re-stamping from original with host fields
    const rebuilt = { name: "InvalidOutputError", data: { message: "empty output" } }
    const stampedAgain = stampHostError(rebuilt, first)
    expect((stampedAgain as any).data.hostCode).toBe("host.empty")
    expect((stampedAgain as any).data.hostRetryClass).toBe("terminal")
  })

  test("reload does not restamp already-stamped error (R003)", () => {
    loadHostErrorCatalog({
      protocolVersion: 1,
      rules: { "NamedError:InvalidOutputError": { code: "host.a", retryClass: "terminal" } },
    })
    const stamped = stampHostError({ name: "InvalidOutputError", data: { message: "empty output" } })
    loadHostErrorCatalog({
      protocolVersion: 1,
      rules: { "NamedError:InvalidOutputError": { code: "host.b", retryClass: "network" } },
    })
    const again = stampHostError(stamped)
    expect((again as any).data.hostCode).toBe("host.a")
    expect((again as any).data.hostRetryClass).toBe("terminal")
  })

  test("birthIdentity: random {name,data} is ErrorName not NamedError (R005)", () => {
    expect(birthIdentity({ name: "WeirdBlob", data: { x: 1 } })).toBe("ErrorName:WeirdBlob")
  })

  test("fromError real path preserves host stamp (R003/R011)", async () => {
    loadHostErrorCatalog({
      protocolVersion: 1,
      rules: { "NamedError:InvalidOutputError": { code: "host.empty", retryClass: "terminal" } },
    })
    const { MessageV2 } = await import("../../src/session/message-v2")
    const err = new MessageV2.InvalidOutputError({ message: "empty output" })
    HostErrorRegistry.stampHostError(err)
    const rebuilt = MessageV2.fromError(err, { providerID: "p" as never })
    expect((rebuilt as any).data?.hostCode ?? (rebuilt as any).hostCode).toBe("host.empty")
  })

  test("APIError:404 is not unconditionally clamped (R013); allow404Retry keeps host class", () => {
    loadHostErrorCatalog({
      protocolVersion: 1,
      rules: { "APIError:404": { code: "host.nf", retryClass: "network" } },
    })
    const s = stampHostError({
      name: "APIError",
      data: { message: "nf", statusCode: 404, isRetryable: true, metadata: { allow404Retry: "true" } },
    })
    expect((s as any).data.hostRetryClass).toBe("network")
    // Hard 404 without allow404Retry: stamp leaves rule class; decide() still terminals.
    const hard = stampHostError({
      name: "APIError",
      data: { message: "nf", statusCode: 404, isRetryable: true },
    })
    expect((hard as any).data.hostRetryClass).toBe("network")
    expect(decide(hard).retryable).toBe(false)
  })

  test("budgetFor keeps host class metadata (R006/R011)", () => {
    loadHostErrorCatalog({
      protocolVersion: 1,
      rules: { "APIError:429": { code: "host.rate", retryClass: "rate_limit" } },
    })
    const d = decide({
      name: "APIError",
      data: {
        message: "Too Many Requests",
        statusCode: 429,
        isRetryable: true,
        hostCode: "host.rate",
        hostRetryClass: "rate_limit",
        responseHeaders: { "retry-after-ms": "1500" },
      },
    })
    expect(d.retryable).toBe(true)
    expect(d.kind).toBe("rate_limit")
    expect(d.hostCode).toBe("host.rate")
    expect(d.retryAfterMs).toBe(1500)
    expect(d.statusCode).toBe(429)
  })

  test("abort/auth/overflow NamedError clamp to terminal (R002/R009)", () => {
    loadHostErrorCatalog({
      protocolVersion: 1,
      rules: {
        "NamedError:MessageAbortedError": { code: "host.abort", retryClass: "network" },
        "NamedError:ProviderAuthError": { code: "host.auth", retryClass: "server" },
        "NamedError:ContextOverflowError": { code: "host.ctx", retryClass: "stream" },
        "APIError:400": { code: "host.bad", retryClass: "network" },
        "APIError:401": { code: "host.unauth", retryClass: "network" },
      },
    })
    for (const name of ["MessageAbortedError", "ProviderAuthError", "ContextOverflowError"] as const) {
      const s = stampHostError({ name, data: { message: "m" } })
      expect((s as any).data.hostRetryClass).toBe("terminal")
    }
    for (const status of [400, 401]) {
      const s = stampHostError({ name: "APIError", data: { message: "m", statusCode: status, isRetryable: true } })
      expect((s as any).data.hostRetryClass).toBe("terminal")
    }
  })
})

describe("usage-limit and fromError class (R006/R011/R015)", () => {
  beforeEach(resetCatalog)

  test("ErrorName:FreeUsageLimitError clamps to terminal", () => {
    loadHostErrorCatalog({
      protocolVersion: 1,
      rules: { "ErrorName:FreeUsageLimitError": { code: "host.quota", retryClass: "network" } },
    })
    const s = stampHostError({ name: "FreeUsageLimitError", data: { message: "quota" } })
    expect((s as any).data.hostRetryClass).toBe("terminal")
  })

  test("fromError preserves hostRetryClass (R003)", async () => {
    loadHostErrorCatalog({
      protocolVersion: 1,
      rules: { "NamedError:InvalidOutputError": { code: "host.empty", retryClass: "terminal" } },
    })
    const { MessageV2 } = await import("../../src/session/message-v2")
    const err = new MessageV2.InvalidOutputError({ message: "empty output" })
    stampHostError(err)
    const rebuilt = MessageV2.fromError(err, { providerID: "p" as never }) as any
    expect(rebuilt.data?.hostCode ?? rebuilt.hostCode).toBe("host.empty")
    expect(rebuilt.data?.hostRetryClass ?? rebuilt.hostRetryClass).toBe("terminal")
  })

  test("malformed stamp (missing class) → terminal + warn once per code (R015)", () => {
    const warned: string[] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => { warned.push(String(a[0])); }
    try {
      const err = { name: "APIError", data: { message: "m", isRetryable: true, hostCode: "host.bad" } }
      expect(hostRetryClass(err)).toBe("terminal")
      expect(hostRetryClass({ ...err, data: { ...err.data } })).toBe("terminal")
      expect(warmedWarns(warned)).toBe(1)
    } finally {
      console.warn = orig
    }
  })
})

function warmedWarns(list: string[]): number {
  return list.filter((l) => l.includes("malformed stamp")).length
}
