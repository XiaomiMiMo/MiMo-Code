import { describe, expect, test } from "bun:test"
import { SignedInAccount, type StoredSession } from "../src/account"
import { MemorySecrets } from "./doubles"

const T0 = Date.parse("2026-11-04T01:46:24Z")
const tok = (c: string) => c.repeat(43)
const stored: StoredSession = {
  version: 1,
  accountOrigin: "https://account.example.test",
  connectOrigin: "https://connect.example.test",
  environment: "test-production",
  subject: "3001",
  accountSessionId: "3cb25ca6-bec2-4d12-a99a-b2724f93e816",
  accessToken: tok("a"),
  accessExpiresAt: "2026-11-04T02:01:24Z",
  renewAfter: "2026-11-04T01:59:24Z",
  refreshToken: tok("r"),
  refreshExpiresAt: "2026-11-06T01:46:06Z",
  logoutToken: tok("l"),
}

type Call = { url: string; headers: Record<string, string>; body: Record<string, string> }

function setup(answer: (call: Call) => Response | Promise<Response>) {
  let now = T0
  const calls: Call[] = []
  const secrets = new MemorySecrets()
  const account = new SignedInAccount({
    secrets,
    clientVersion: "1.0.0",
    clock: () => now,
    fetch: (async (url: URL, init: RequestInit) => {
      const call = {
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      }
      calls.push(call)
      return answer(call)
    }) as unknown as typeof fetch,
  })
  return { account, calls, secrets, at: (iso: string) => (now = Date.parse(iso)) }
}

const renewed = (call: Call) =>
  Response.json({
    contractVersion: "1.0",
    requestId: call.headers["Mimo-Request-Id"],
    data: {
      session: {
        accountSessionId: stored.accountSessionId,
        subject: stored.subject,
        accessExpiresAt: "2026-11-04T02:16:24Z",
        refreshExpiresAt: "2026-11-06T01:46:06Z",
        renewAfter: "2026-11-04T02:14:24Z",
      },
      credentials: { tokenType: "Bearer", accessToken: tok("b"), refreshToken: tok("s") },
    },
  })

describe("signed-in account", () => {
  test("a fresh session is used as is", async () => {
    const s = setup(() => new Response("", { status: 500 }))
    await s.account.save(stored)
    expect(await s.account.account()).toEqual({
      origin: "https://connect.example.test",
      environment: "test-production",
      subject: "3001",
      accountSessionId: stored.accountSessionId,
      accessToken: tok("a"),
    })
    expect(s.calls).toEqual([])
  })

  test("a due session is renewed with the refresh token and the rotated pair is kept", async () => {
    const s = setup(renewed)
    await s.account.save(stored)
    s.at("2026-11-04T02:00:00Z")
    expect((await s.account.account())?.accessToken).toBe(tok("b"))
    expect(s.calls[0].url).toBe("https://account.example.test/api/account/renew")
    expect(s.calls[0].headers.Authorization).toBe(`Bearer ${tok("r")}`)
    expect(s.calls[0].headers["Mimo-Account-Version"]).toBe("1.0")
    expect(s.calls[0].body).toEqual({ environment: "test-production", accountSessionId: stored.accountSessionId })
    const kept = JSON.parse((await s.secrets.get("account-session"))!)
    expect(kept.refreshToken).toBe(tok("s"))
    expect(kept.renewKey).toBeUndefined()
    // Concurrent readers share one renewal.
    s.at("2026-11-04T02:15:00Z")
    await Promise.all([s.account.account(), s.account.account()])
    expect(s.calls.length).toBe(2)
  })

  test("a renewal whose answer was lost is repeated with the same key", async () => {
    let first = true
    const s = setup((call) => {
      if (first) {
        first = false
        throw new Error("network")
      }
      return renewed(call)
    })
    await s.account.save(stored)
    s.at("2026-11-04T02:00:00Z")
    await expect(s.account.account()).rejects.toThrow()
    expect((await s.account.account())?.accessToken).toBe(tok("b"))
    expect(s.calls[1].headers["Idempotency-Key"]).toBe(s.calls[0].headers["Idempotency-Key"])
  })

  test("a session the service no longer renews is signed out", async () => {
    const s = setup(() =>
      Response.json({ contractVersion: "1.0", error: { code: "unauthenticated" } }, { status: 401 }),
    )
    await s.account.save(stored)
    s.at("2026-11-04T02:00:00Z")
    expect(await s.account.account()).toBeUndefined()
    expect(await s.secrets.get("account-session")).toBeUndefined()
  })

  test("signing out ends the session at the service and forgets it", async () => {
    const s = setup(() => Response.json({ contractVersion: "1.0", data: {} }))
    await s.account.save(stored)
    await s.account.signOut()
    expect(s.calls[0].url).toBe("https://account.example.test/api/account/logout")
    expect(s.calls[0].headers.Authorization).toBe(`Bearer ${tok("l")}`)
    expect(await s.account.account()).toBeUndefined()
  })
})
