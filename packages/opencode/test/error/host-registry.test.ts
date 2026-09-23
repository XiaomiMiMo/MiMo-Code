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
})
