import { describe, expect, test } from "bun:test"
import { RateLimitMiddleware } from "../../src/server/rate-limit"

const PASSED = new Response(null, { status: 200 })

function makeContext() {
  const headers = new Map<string, string>()
  return {
    req: { path: "/test", header: () => undefined },
    header: (k: string, v: string) => headers.set(k, v),
    json: (body: any, status?: number) => ({ body, status }),
    _headers: headers,
  }
}

describe("RateLimitMiddleware", () => {
  test("allows requests within limit", async () => {
    const mw = RateLimitMiddleware({ windowMs: 60_000, max: 3, keyPrefix: "test-allow" })
    const next = () => PASSED

    for (let i = 0; i < 3; i++) {
      const c = makeContext()
      const result = await mw(c as any, next as any)
      expect(result).toBe(PASSED)
    }
  })

  test("blocks requests exceeding limit", async () => {
    const mw = RateLimitMiddleware({ windowMs: 60_000, max: 2, keyPrefix: "test-block" })
    const next = () => PASSED

    const c1 = makeContext()
    expect(await mw(c1 as any, next as any)).toBe(PASSED)

    const c2 = makeContext()
    expect(await mw(c2 as any, next as any)).toBe(PASSED)

    const c3 = makeContext()
    const result = (await mw(c3 as any, next as any)) as any
    expect(result.status).toBe(429)
    expect(result.body.error).toBe("Too many requests")
  })

  test("sets Retry-After header on 429", async () => {
    const mw = RateLimitMiddleware({ windowMs: 60_000, max: 1, keyPrefix: "test-header" })
    const next = () => PASSED

    await mw(makeContext() as any, next as any)

    const c = makeContext()
    await mw(c as any, next as any)
    expect(c._headers.has("Retry-After")).toBe(true)
  })

  test("resets after window expires", async () => {
    const mw = RateLimitMiddleware({ windowMs: 1, max: 1, keyPrefix: "test-reset" })
    const next = () => PASSED

    await mw(makeContext() as any, next as any)
    await Bun.sleep(5)

    const c = makeContext()
    const result = await mw(c as any, next as any)
    expect(result).toBe(PASSED)
  })
})
