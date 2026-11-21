import { describe, expect, test } from "bun:test"
import { ConnectApi } from "../src/api"
import { ConnectHttp } from "../src/http"
import { generateDeviceKey } from "../src/proof"
import { FakeConnect } from "./fake-connect"
import { harness } from "./helpers"

describe("Connect HTTP rules", () => {
  test("a local clock running ahead still produces proofs the service accepts", async () => {
    const service = new FakeConnect().start()
    try {
      const { key } = await generateDeviceKey()
      const http = new ConnectHttp({
        account: () => service.account(),
        key,
        deviceId: () => undefined,
        client: { version: "1.0.0", platform: "linux" },
        clock: () => Date.now() + 5_000,
      })
      const api = new ConnectApi(http)
      // Proofs are issued at the service time each challenge carries, never the local clock.
      expect(await api.offersCliProfile()).toBe(true)
      expect((await api.register("dev-box")).deviceId).toMatch(/^[0-9a-f-]{36}$/)
    } finally {
      service.stop()
    }
  })

  test("a development build without a release version sends no client version", async () => {
    const service = new FakeConnect().start()
    try {
      const { key } = await generateDeviceKey()
      const http = new ConnectHttp({
        account: () => service.account(),
        key,
        deviceId: () => undefined,
        client: { version: "local", platform: "macos" },
      })
      await new ConnectApi(http).register("dev-box")
      for (const request of service.requests) {
        expect(request.headers.get("X-Client-Version")).toBeNull()
        expect(request.headers.get("X-Client-Platform")).toBe("macos")
      }
    } finally {
      service.stop()
    }
  })

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

  test("every actor request carries the Passport credential, version, request id, client info and the CLI profile", async () => {
    using h = await harness()
    const deviceId = await h.register()
    await h.api.createPairingCode(1)
    const request = h.service.requests.at(-1)!
    expect(request.headers.get("Authorization")).toBe(`Bearer ${h.service.serviceToken}`)
    expect(request.headers.get("Mimo-Passport-User")).toBe(h.service.userId)
    expect(request.headers.get("Mimo-Passport-CUser")).toBeNull()
    expect(request.headers.get("X-Request-Id")).toBeNull()
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

  test("a device challenge outside the contract never signs a proof", async () => {
    using h = await harness()
    await h.register()
    const path = "/api/connect/device-challenges"
    const edit = (change: (data: Record<string, unknown>) => void) => async (response: Response) => {
      const envelope = (await response.clone().json()) as { data: Record<string, unknown> }
      change(envelope.data)
      return new Response(JSON.stringify(envelope), { status: response.status, headers: response.headers })
    }
    const cases: [string, (r: Response) => Promise<Response>][] = [
      ["no service time", edit((d) => delete d.serverTime)],
      ["the retired account session", edit((d) => (d.accountSessionId = crypto.randomUUID()))],
      ["a malformed login instance", edit((d) => (d.loginInstanceId = "ABC"))],
      ["another environment", edit((d) => (d.environment = "global-test"))],
      ["a lifetime beyond the nonce's", edit((d) => (d.expiresAt = new Date(Date.parse(d.serverTime as string) + 120_000).toISOString()))],
    ]
    for (const [name, tamper] of cases) {
      h.service.tamper.set(path, tamper)
      await expect(h.api.createPairingCode(1), name).rejects.toMatchObject({ code: "protocol" })
    }
    // The proof names the login instance and is issued at the service time.
    await h.api.createPairingCode(1)
    const proof = h.service.requests.at(-1)!.headers.get("X-Device-Proof")!
    const claims = JSON.parse(Buffer.from(proof.split(".")[1], "base64url").toString())
    expect(claims.loginInstanceId).toBe(h.service.loginInstanceId)
    expect(claims).not.toHaveProperty("accountSessionId")
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
