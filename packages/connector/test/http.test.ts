import { describe, expect, test } from "bun:test"
import { ConnectApi } from "../src/api"
import { ACCOUNT_REJECTION_CODES, ConnectError, ConnectHttp } from "../src/http"
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
    await expect(h.api.offersCliProfile()).rejects.toMatchObject({ code: "discovery_failed", status: 404 })
    h.service.discovery = ["future-connector"]
    await expect(h.api.offersCliProfile()).rejects.toMatchObject({ code: "protocol_incompatible" })
    h.service.discovery = ["future-connector", "cli-connector"]
    expect(await h.api.offersCliProfile()).toBe(true)
    h.service.discovery = ["future-connector", "future-connector"]
    await expect(h.api.offersCliProfile()).rejects.toMatchObject({ code: "protocol" })
    h.service.failNext.set("/api/connect/connector-capabilities", [500, "internal_error"])
    await expect(h.api.offersCliProfile()).rejects.toMatchObject({ code: "internal_error", status: 500 })
  })

  test("[TP-R61-04] only a correlated 426 envelope proves version incompatibility", async () => {
    using h = await harness()
    const path = "/api/connect/connector-capabilities"
    for (const versions of [undefined, [], ["1.0", "1.0"], ["cli-v2"], ["2.0"], ["1.0"]]) {
      h.service.tamper.set(path, (response) => {
        const headers = new Headers(response.headers)
        headers.delete("Mimo-Connect-Version")
        return new Response(JSON.stringify({
          contractVersion: null,
          requestId: headers.get("Mimo-Request-Id"),
          error: { code: "protocol_incompatible" },
          supportedVersions: versions,
        }), { headers, status: 426 })
      })
      const code = versions?.length === 1 && (versions[0] === "2.0" || versions[0] === "1.0")
        ? "protocol_incompatible" : "protocol"
      await expect(h.api.offersCliProfile()).rejects.toMatchObject({ code, status: 426 })
    }
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
    expect(request.headers.get("Mimo-Connect-Profile")).toBe("cli-connector")
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

  // [TP-R63-07] Depth is counted from the envelope, and never excuses a lexical error.
  test("accepts HTTP depth 16 but distinguishes depth 17 from malformed JSON", async () => {
    using h = await harness()
    const path = "/api/connect/connector-capabilities"
    const responseWith = (extra: string) => async (response: Response) => {
      const text = await response.text()
      return new Response(`{"extra":${extra},${text.slice(1)}`, response)
    }
    const nest = (values: string, arrays: number) => "[".repeat(arrays) + values + "]".repeat(arrays)
    h.service.tamper.set(path, responseWith(nest("{}", 14)))
    expect(await h.api.offersCliProfile()).toBe(true)
    h.service.tamper.set(path, responseWith(nest("{}", 15)))
    await expect(h.api.offersCliProfile()).rejects.toMatchObject({ code: "too_deep" })
    h.service.tamper.set(path, responseWith(nest('{"a":1,"\\u0061":2}', 15)))
    await expect(h.api.offersCliProfile()).rejects.toMatchObject({ code: "protocol" })
    h.service.tamper.set(path, responseWith(nest("1e0", 16)))
    await expect(h.api.offersCliProfile()).rejects.toMatchObject({ code: "protocol" })
    expect(await h.api.offersCliProfile()).toBe(true)
  })

  test("rejects invalid UTF-8 even inside an unused HTTP field", async () => {
    using h = await harness()
    h.service.tamper.set("/api/connect/connector-capabilities", async (response) => {
      const text = await response.text()
      const bytes = Buffer.concat([Buffer.from('{"extra":"'), Buffer.from([0xff]), Buffer.from(`",${text.slice(1)}`)])
      return new Response(bytes, response)
    })
    await expect(h.api.offersCliProfile()).rejects.toMatchObject({ code: "protocol" })
  })

  test("proof expiry is a registered 401 admission refusal, not terminal account rejection", async () => {
    using h = await harness()
    await h.register()
    const bindingId = crypto.randomUUID()
    const path = `/api/connect/bindings/${bindingId}/content-grant`
    const publish = () => h.api.publishGrant(bindingId, { connectionEpoch: 1, expectedVersion: 0, state: "active", scopes: [] })
    h.service.failNext.set(path, [401, "proof_expired"])
    const error = await publish().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConnectError)
    expect(error).toMatchObject({ code: "proof_expired", status: 401, unregistered: false, transient: true })
    expect(ACCOUNT_REJECTION_CODES.has((error as ConnectError).code)).toBe(false)
    expect(h.service.grants.has(bindingId)).toBe(false)
    expect(h.service.requests.filter((request) => request.path === path)).toHaveLength(1)
    h.service.failNext.set(path, [500, "proof_expired"])
    await expect(publish()).rejects.toMatchObject({ code: "protocol", status: 500 })
  })

  test("does not surface malformed Connect errors as authoritative grant outcomes", async () => {
    using h = await harness()
    const path = "/api/connect/connector-capabilities"
    const cases = [
      ["duplicate error code", '"error":{"code":"proof_expired","\\u0063ode":"proof_expired"}'],
      ["wrong contract version", '"error":{"code":"proof_expired"},"contractVersion":"2.0"'],
      ["not a Connect media type", '"error":{"code":"proof_expired"},"contractVersion":"1.0"'],
    ] as const
    for (const [label, tail] of cases) {
      h.service.tamper.set(path, (response) => {
        const headers = new Headers(response.headers)
        if (label === "not a Connect media type") headers.set("Content-Type", "text/plain")
        const id = headers.get("Mimo-Request-Id")
        const version = label === "duplicate error code" ? ',"contractVersion":"1.0"' : ""
        return new Response(`{"requestId":"${id}",${tail}${version}}`, { status: 401, headers })
      })
      await expect(h.api.offersCliProfile(), label).rejects.toMatchObject({ code: "protocol", status: 401 })
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
      ["no login instance", edit((d) => delete d.loginInstanceId)],
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
