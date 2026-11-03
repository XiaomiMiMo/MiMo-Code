import { describe, expect, test } from "bun:test"
import { harness } from "./helpers"

describe("Connect HTTP rules", () => {
  test("discovery: declared profile, empty list and a legal not_found are told apart from failures", async () => {
    using h = await harness()
    expect(await h.api.offersCliProfile()).toBe(true)
    const sent = h.service.requests.at(-1)!
    expect(sent.headers.get("Mimo-Connect-Profile")).toBeNull()
    expect(sent.headers.get("X-Device-Proof")).toBeNull()
    expect(sent.headers.get("Mimo-Connect-Version")).toBe("1.0")
    h.service.discovery = "empty"
    expect(await h.api.offersCliProfile()).toBe(false)
    h.service.discovery = "missing"
    expect(await h.api.offersCliProfile()).toBe(false)
    h.service.failNext.set("/api/connect/connector-capabilities", [500, "internal_error"])
    await expect(h.api.offersCliProfile()).rejects.toMatchObject({ code: "internal_error", status: 500 })
  })

  test("every actor request carries bearer, version, request id, client info and the CLI profile", async () => {
    using h = await harness()
    const deviceId = await h.register()
    await h.api.createPairingCode(1)
    const request = h.service.requests.at(-1)!
    expect(request.headers.get("Authorization")).toBe(`Bearer ${h.service.accessToken}`)
    expect(request.headers.get("Mimo-Connect-Version")).toBe("1.0")
    expect(request.headers.get("Mimo-Connect-Profile")).toBe("cli-connector-v1")
    expect(request.headers.get("X-Device-Id")).toBe(deviceId)
    expect(request.headers.get("X-Client-Version")).toBe("1.2.3")
    expect(request.headers.get("X-Client-Platform")).toBe("linux")
    expect(request.headers.get("Mimo-Request-Id")).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("a response that breaks the envelope contract is a protocol error, not data", async () => {
    using h = await harness()
    await h.register()
    const path = "/api/connect/pairing/challenges"
    const cases: [string, (r: Response) => Response][] = [
      ["missing profile echo", (r) => withHeaders(r, (h) => h.delete("Mimo-Connect-Profile"))],
      ["wrong version", (r) => withHeaders(r, (h) => h.set("Mimo-Connect-Version", "4.0"))],
      ["request id mismatch", (r) => withHeaders(r, (h) => h.set("Mimo-Request-Id", crypto.randomUUID()))],
    ]
    for (const [name, tamper] of cases) {
      h.service.tamper.set(path, tamper)
      await expect(h.api.createPairingCode(1), name).rejects.toMatchObject({ code: "protocol" })
    }
  })

  test("service rejections keep their code; Retry-After starts a cooldown without a request", async () => {
    using h = await harness()
    await h.register()
    h.service.failNext.set("/api/connect/pairing/challenges", [409, "desktop_offline"])
    await expect(h.api.createPairingCode(1)).rejects.toMatchObject({ code: "desktop_offline", transient: true })
    h.service.failNext.set("/api/connect/pairing/challenges", [429, "rate_limited", "3"])
    await expect(h.api.createPairingCode(1)).rejects.toMatchObject({ code: "rate_limited", status: 429 })
    const before = h.service.requests.length
    await expect(h.api.createPairingCode(1)).rejects.toMatchObject({ code: "cooldown" })
    expect(h.service.requests.length).toBe(before)
    expect(h.http.cooldownRemainingMs()).toBeGreaterThan(2000)
  })
})

function withHeaders(response: Response, edit: (headers: Headers) => void): Response {
  const headers = new Headers(response.headers)
  edit(headers)
  return new Response(response.body, { status: response.status, headers })
}
