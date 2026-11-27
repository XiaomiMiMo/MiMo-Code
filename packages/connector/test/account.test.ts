import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PassportAccount, SERVICE_TOKEN_LIFETIME_MS, localSubject } from "../src/account"
import { fileSecretStore, protectedOrFileStore } from "../src/keychain"
import { PassportClient, PassportLoginError, exactInteger, type PassportService } from "../src/passport-login"
import { MemorySecrets } from "./doubles"

const SERVICE: PassportService = {
  accountOrigin: "https://account.example",
  sid: "mimopc",
  serviceOrigin: "https://mimo.example",
  stsPath: "/api/sts",
  connectOrigin: "https://connect.example",
  environment: "china-production",
}
/** Larger than Number.MAX_SAFE_INTEGER: JSON.parse would round it. */
const NONCE = "5938216840591872643"
const SSECURITY = "sSecurity+/=="

type Seen = { host: string; path: string; cookie: string | null; authorization: string | null }

/** Account service, MiMo STS endpoint and the two Connect account calls, scripted. */
class FakeServices {
  readonly seen: Seen[] = []
  /** lp answers before the user confirms. */
  pendingPolls = 1
  /** passTokens the account service still accepts. */
  readonly live = new Set<string>()
  issued = 0
  passTokens = 0
  allowed = true
  /** Connect answers 401 for these serviceTokens. */
  readonly rejected = new Set<string>()
  connectDown = false
  accountDown = false
  stsLocation = "https://mimo.example/api/sts?auth=a1&p_ts=1795753530574&d=x"

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const headers = new Headers(init?.headers)
    this.seen.push({
      host: url.host,
      path: url.pathname,
      cookie: headers.get("Cookie"),
      authorization: headers.get("Authorization"),
    })
    if (url.host.endsWith("account.example")) {
      if (this.accountDown) throw new TypeError("network down")
      return this.account(url, headers)
    }
    if (url.host === "mimo.example") return this.mimo(url, headers)
    if (url.host === "connect.example") return this.connect(url, headers)
    throw new Error(`unexpected request to ${url.host}`)
  }) as typeof fetch

  private account(url: URL, headers: Headers): Response {
    const cookie = parseCookie(headers.get("Cookie"))
    switch (url.pathname) {
      case "/longPolling/loginUrl":
        return json({
          code: 0,
          loginUrl: "https://c3.account.example/longPolling/login?ticket=t1",
          lp: "https://c3.lp.account.example/lp/s?k=lp1",
          qr: "https://account.example/pass/qr/login?ticket=t1",
          timeout: 300,
        })
      case "/lp/s": {
        if (this.pendingPolls-- > 0) return json({ code: 700, desc: "waiting" })
        const passToken = `pt${++this.passTokens}`
        this.live.add(passToken)
        return text(
          `{"code":0,"passToken":"${passToken}","userId":2469486853,"cUserId":"cu-1","nonce":${NONCE},` +
            `"ssecurity":"${SSECURITY}","location":"${this.stsLocation}","psecurity":"p"}`,
        )
      }
      case "/pass/serviceLogin":
        if (!this.live.has(cookie.passToken ?? "") || !cookie.deviceId) return json({ code: 70016, desc: "登录验证失败" })
        return text(
          `{"code":0,"nonce":${NONCE},"ssecurity":"${SSECURITY}","location":"https://mimo.example/api/sts?auth=a2&p_ts=1795753530574"}`,
        )
      case "/pass/logout":
        return new Response(null, { status: 302, headers: { Location: "https://logout.account.example/logout" } })
      case "/logout":
        // Ending the login needs the device the login was made on.
        if (cookie.deviceId) this.live.delete(cookie.passToken ?? "")
        return new Response("<html></html>", { status: 200 })
    }
    return new Response("not found", { status: 404 })
  }

  private mimo(url: URL, headers: Headers): Response {
    if (url.pathname === "/api/sts") {
      const expected = createHash("sha1").update(`nonce=${NONCE}&${SSECURITY}`).digest("base64")
      if (headers.get("Cookie") || url.searchParams.get("clientSign") !== expected) return new Response(null, { status: 401 })
      const response = new Response("ok", { status: 200 })
      response.headers.append("Set-Cookie", `serviceToken=st${++this.issued}; Path=/; HttpOnly`)
      response.headers.append("Set-Cookie", "userId=2469486853; Domain=.mimo.example; Path=/")
      response.headers.append("Set-Cookie", "mimopc_ph=hint; Path=/")
      return response
    }
    if (url.pathname === "/api/user/xiaomi/me/basic") {
      // The MiMo service answers plain JSON (no account-service prefix).
      return Response.json({ code: 0, data: { userId: "2469486853", nickname: "  小米用户  " } })
    }
    return new Response("not found", { status: 404 })
  }

  private connect(url: URL, headers: Headers): Response {
    const id = headers.get("Mimo-Request-Id") ?? ""
    const reply = (status: number, body: Record<string, unknown>) =>
      new Response(JSON.stringify({ contractVersion: "1.0", requestId: id, ...body }), {
        status,
        headers: { "Content-Type": "application/json", "Mimo-Request-Id": id, "Mimo-Connect-Version": "1.0" },
      })
    if (this.connectDown) return new Response("bad gateway", { status: 502 })
    const token = headers.get("Authorization")?.replace(/^Bearer /, "") ?? ""
    if (this.rejected.has(token) || headers.get("Mimo-Passport-User") !== "2469486853") {
      return reply(401, { error: { code: "unauthenticated" } })
    }
    if (url.pathname === "/api/connect/mobile-allowlist/check") return reply(200, { data: { allowed: this.allowed } })
    if (url.pathname === "/api/connect/account/signout") {
      this.rejected.add(token)
      return reply(200, { data: { signedOut: true } })
    }
    return reply(404, { error: { code: "not_found" } })
  }
}

function json(value: unknown): Response {
  return text(JSON.stringify(value))
}

function text(body: string): Response {
  return new Response(`&&&START&&&${body}`, { status: 200, headers: { "Content-Type": "application/json" } })
}

function parseCookie(header: string | null): Record<string, string> {
  return Object.fromEntries(
    (header ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([name]) => name)
      .map(([name, ...rest]) => [name, rest.join("=")]),
  )
}

function setup(start = 1_800_000_000_000) {
  const services = new FakeServices()
  const clock = { now: start }
  const secrets = new MemorySecrets()
  // Through a closure, so a test can swap the fake's fetch after construction.
  const fetchVia = ((input: string | URL | Request, init?: RequestInit) => services.fetch(input, init)) as typeof fetch
  const client = new PassportClient({
    service: SERVICE,
    fetch: fetchVia,
    now: () => clock.now,
    sleep: async () => {},
  })
  const account = new PassportAccount(secrets, {
    client,
    info: { version: "0.1.0", platform: "linux" },
    fetch: fetchVia,
    now: () => clock.now,
  })
  return { services, clock, secrets, client, account }
}

async function signedIn() {
  const s = setup()
  const attempt = await s.account.signIn()
  await attempt.wait()
  return s
}

describe("Passport sign-in", () => {
  test("a confirmed login becomes the kept account; the long integer nonce is signed exactly", async () => {
    const { services, account } = setup()
    expect(await account.account()).toBeUndefined()
    const attempt = await account.signIn()
    expect(attempt.loginUrl).toBe("https://c3.account.example/longPolling/login?ticket=t1")
    await attempt.wait()
    expect(await account.account()).toEqual({
      origin: "https://connect.example",
      environment: "china-production",
      subject: await localSubject("china-production", "2469486853"),
      userId: "2469486853",
      serviceToken: "st1",
    })
    const credential = await account.credential()
    expect(credential?.passToken).toBe("pt1")
    expect(credential?.cUserId).toBe("cu-1")
    expect(credential?.tokenCookie).toBe("serviceToken")
    // The login start and every poll carry this install's device id.
    const deviceId = await account.deviceId()
    for (const call of services.seen.filter((c) => c.path === "/longPolling/loginUrl" || c.path === "/lp/s")) {
      expect(call.cookie).toBe(`deviceId=${deviceId}`)
    }
    // The STS exchange carries no cookie.
    expect(services.seen.find((c) => c.path === "/api/sts")?.cookie).toBeNull()
  })

  test("the device id is created once and kept across sign-ins", async () => {
    const { account } = setup()
    const first = await account.deviceId()
    expect(first).toMatch(/^mimocode_[0-9a-f]{32}$/)
    await (await account.signIn()).wait()
    await account.signOut()
    expect(await account.deviceId()).toBe(first)
  })

  test("an unconfirmed login expires at the service's deadline", async () => {
    const { services, clock, client } = setup()
    services.pendingPolls = Number.POSITIVE_INFINITY
    const attempt = await client.start("mimocode_device")
    const waiting = attempt.wait()
    clock.now = attempt.expiresAt
    await expect(waiting).rejects.toMatchObject({ code: "expired" })
  })

  test("a cancelled login stops polling", async () => {
    const { services, client } = setup()
    services.pendingPolls = Number.POSITIVE_INFINITY
    const attempt = await client.start("mimocode_device")
    const controller = new AbortController()
    controller.abort()
    await expect(attempt.wait(controller.signal)).rejects.toMatchObject({ code: "cancelled" })
  })

  test("a passing network failure while waiting is retried", async () => {
    const { services, account } = setup()
    const attempt = await account.signIn()
    let failures = 2
    const real = services.fetch
    services.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/lp/s") && failures-- > 0) throw new TypeError("reset")
      return real(input, init)
    }) as typeof fetch
    await attempt.wait()
    expect((await account.credential())?.passToken).toBe("pt1")
  })

  test("an exchange that does not point at the MiMo service is refused before any request", async () => {
    const { services, account } = setup()
    services.stsLocation = "https://evil.example/api/sts?auth=a1"
    const attempt = await account.signIn()
    await expect(attempt.wait()).rejects.toBeInstanceOf(PassportLoginError)
    expect(services.seen.some((c) => c.host === "evil.example")).toBe(false)
    expect(await account.credential()).toBeUndefined()
  })

  test("a login address outside the account service is refused", async () => {
    const { services, client } = setup()
    const real = services.fetch
    services.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/longPolling/loginUrl")) {
        return json({ code: 0, loginUrl: "https://phish.example/login", lp: "https://c3.lp.account.example/lp/s", timeout: 300 })
      }
      return real(input, init)
    }) as typeof fetch
    await expect(client.start("mimocode_device")).rejects.toMatchObject({ code: "rejected" })
  })

  test("exactInteger keeps every digit", () => {
    expect(exactInteger(`{"nonce":${NONCE}}`, "nonce")).toBe(NONCE)
    expect(exactInteger(`{"nonce":"${NONCE}"}`, "nonce")).toBe(NONCE)
    expect(String(JSON.parse(`{"nonce":${NONCE}}`).nonce)).not.toBe(NONCE)
  })
})

describe("Passport renewal", () => {
  test("a serviceToken close to its end is replaced from the passToken with the same device id", async () => {
    const { services, clock, account } = await signedIn()
    expect((await account.account())?.serviceToken).toBe("st1")
    expect(services.seen.filter((c) => c.path === "/pass/serviceLogin")).toHaveLength(0)
    clock.now += SERVICE_TOKEN_LIFETIME_MS - 5 * 60 * 60 * 1000
    expect((await account.account())?.serviceToken).toBe("st2")
    const renewal = services.seen.find((c) => c.path === "/pass/serviceLogin")!
    expect(parseCookie(renewal.cookie)).toEqual({
      passToken: "pt1",
      userId: "2469486853",
      cUserId: "cu-1",
      deviceId: await account.deviceId(),
    })
    // The renewed token is not due again right away.
    await account.account()
    expect(services.seen.filter((c) => c.path === "/pass/serviceLogin")).toHaveLength(1)
  })

  test("concurrent readers share one renewal", async () => {
    const { services, account } = await signedIn()
    const outcomes = await Promise.all([account.renew(), account.renew(), account.renew()])
    expect(outcomes).toEqual(["renewed", "renewed", "renewed"])
    expect(services.seen.filter((c) => c.path === "/pass/serviceLogin")).toHaveLength(1)
  })

  test("an ended passToken removes the login and says so", async () => {
    const { services, account } = await signedIn()
    services.live.clear()
    expect(await account.renew()).toBe("signed_out")
    expect(await account.credential()).toBeUndefined()
    expect(account.signInEnded()).toBe(true)
    expect(await account.account()).toBeUndefined()
  })

  test("a failed renewal keeps the current serviceToken and waits before trying again", async () => {
    const { services, clock, account } = await signedIn()
    clock.now += SERVICE_TOKEN_LIFETIME_MS - 60 * 60 * 1000
    services.accountDown = true
    expect((await account.account())?.serviceToken).toBe("st1")
    expect((await account.account())?.serviceToken).toBe("st1")
    expect(services.seen.filter((c) => c.path === "/pass/serviceLogin")).toHaveLength(1)
    services.accountDown = false
    clock.now += 61_000
    expect((await account.account())?.serviceToken).toBe("st2")
  })
})

describe("Passport sign-out and status", () => {
  test("sign-out tells Connect first, ends the passToken at the account service and removes the login", async () => {
    const { services, account } = await signedIn()
    expect(await account.signOut()).toEqual({ connect: true, account: true })
    expect(services.rejected.has("st1")).toBe(true)
    expect(services.live.has("pt1")).toBe(false)
    expect(await account.credential()).toBeUndefined()
    // The passToken only ever went to the account service.
    for (const call of services.seen) {
      if (call.cookie?.includes("passToken=")) expect(call.host.endsWith("account.example")).toBe(true)
    }
    const order = services.seen.map((c) => c.path)
    expect(order.indexOf("/api/connect/account/signout")).toBeLessThan(order.indexOf("/pass/logout"))
  })

  test("sign-out removes the local login even when both services are unreachable", async () => {
    const { services, account } = await signedIn()
    services.connectDown = true
    services.accountDown = true
    expect(await account.signOut()).toEqual({ connect: false, account: false })
    expect(await account.credential()).toBeUndefined()
  })

  test("eligibility tells accepted, not admitted and rejected apart", async () => {
    const { services, account } = await signedIn()
    expect(await account.eligibility()).toEqual({ kind: "allowed" })
    services.allowed = false
    expect(await account.eligibility()).toEqual({ kind: "not_admitted" })
    services.rejected.add("st1")
    expect(await account.eligibility()).toEqual({ kind: "rejected" })
    services.connectDown = true
    expect(await account.eligibility()).toEqual({ kind: "unknown" })
  })

  test("the nickname comes from the MiMo service with the kept serviceToken", async () => {
    const { services, account } = await signedIn()
    expect(await account.nickname()).toBe("小米用户")
    expect(services.seen.find((c) => c.path === "/api/user/xiaomi/me/basic")?.cookie).toBe(
      "serviceToken=st1; userId=2469486853",
    )
  })

  test("the local subject separates environments and accounts", async () => {
    const a = await localSubject("china-production", "1")
    expect(a).not.toBe(await localSubject("china-test", "1"))
    expect(a).not.toBe(await localSubject("china-production", "2"))
  })
})

describe("secret storage fallback", () => {
  test("protected storage is used when reachable", async () => {
    const primary = new MemorySecrets()
    const dir = await mkdtemp(path.join(tmpdir(), "secrets-"))
    try {
      const store = protectedOrFileStore(primary, fileSecretStore(dir))
      await store.set("passport-credential", "value")
      expect(await store.kind()).toBe("protected")
      expect(primary.values.get("passport-credential")).toBe("value")
      expect(await readdir(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("without protected storage secrets go to files only the user can read", async () => {
    const primary = new MemorySecrets()
    primary.unavailable = true
    const dir = path.join(await mkdtemp(path.join(tmpdir(), "secrets-")), "phone")
    try {
      const store = protectedOrFileStore(primary, fileSecretStore(dir))
      await store.set("passport-credential", "value")
      expect(await store.kind()).toBe("file")
      expect(await store.get("passport-credential")).toBe("value")
      expect(primary.values.size).toBe(0)
      if (process.platform !== "win32") {
        expect((await stat(dir)).mode & 0o777).toBe(0o700)
        expect((await stat(path.join(dir, "passport-credential.secret"))).mode & 0o777).toBe(0o600)
      }
      await store.delete("passport-credential")
      expect(await store.get("passport-credential")).toBeUndefined()
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true })
    }
  })
})
