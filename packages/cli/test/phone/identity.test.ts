import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadDebugIdentity, readAccountSession } from "../../src/phone/identity"

const NOW = 1_800_000_000_000
const valid = {
  version: 1,
  mode: "isolated-debug",
  origin: "https://connect.example.test",
  environment: "debug-test",
  subject: "debug:7f6c2f9e-0000-4000-8000-000000000001",
  issuedAt: NOW - 1000,
  expiresAt: NOW + 60_000,
  role: "cli",
  accountSessionId: "7f6c2f9e-0000-4000-8000-000000000002",
  accessToken: "token-value",
}

async function withFile(content: unknown, run: (file: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "identity-"))
  try {
    const file = path.join(dir, "cli.json")
    await writeFile(file, typeof content === "string" ? content : JSON.stringify(content))
    await run(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("debug identity", () => {
  test("a valid CLI profile becomes the connector account", async () => {
    await withFile(valid, async (file) => {
      expect(await loadDebugIdentity(file, () => NOW)).toEqual({
        origin: "https://connect.example.test",
        environment: "debug-test",
        subject: valid.subject,
        accountSessionId: valid.accountSessionId,
        accessToken: "token-value",
      })
    })
  })

  test("no configured file, an unreadable one and a malformed one are told apart", async () => {
    expect(await loadDebugIdentity(undefined)).toBe("missing")
    expect(await loadDebugIdentity("/nonexistent/cli.json")).toBe("unreadable")
    await withFile("{not json", async (file) => expect(await loadDebugIdentity(file, () => NOW)).toBe("invalid"))
  })

  test("another role, an expired profile or a non-origin URL is refused", async () => {
    for (const [change, problem] of [
      [{ role: "phone" }, "invalid"],
      [{ mode: "production" }, "invalid"],
      [{ expiresAt: NOW }, "expired"],
      [{ origin: "https://connect.example.test/api" }, "invalid"],
      [{ origin: "http://connect.example.test" }, "invalid"],
    ] as const) {
      await withFile({ ...valid, ...change }, async (file) =>
        expect(await loadDebugIdentity(file, () => NOW)).toBe(problem),
      )
    }
  })

  test("plain HTTP is accepted only for a loopback service", async () => {
    await withFile({ ...valid, origin: "http://127.0.0.1:8080" }, async (file) => {
      expect(await loadDebugIdentity(file, () => NOW)).toMatchObject({ origin: "http://127.0.0.1:8080" })
    })
  })
})

describe("handed-over account session", () => {
  const handoff = {
    accountOrigin: "https://account.example.test",
    connectOrigin: "https://connect.example.test",
    clientInstanceId: "7f6c2f9e-0000-4000-8000-000000000009",
    session: {
      accountSessionId: "7f6c2f9e-0000-4000-8000-000000000002",
      subject: "3001",
      environment: "test-production",
      accessExpiresAt: "2027-02-01T00:00:00Z",
      refreshExpiresAt: "2027-02-02T00:00:00Z",
      renewAfter: "2027-01-31T23:58:00Z",
    },
    credentials: {
      tokenType: "Bearer",
      accessToken: "a".repeat(43),
      refreshToken: "r".repeat(43),
      logoutToken: "l".repeat(43),
    },
  }

  test("becomes a stored session with its origins and tokens", async () => {
    await withFile(handoff, async (file) => {
      expect(await readAccountSession(file, () => NOW)).toMatchObject({
        version: 1,
        accountOrigin: "https://account.example.test",
        connectOrigin: "https://connect.example.test",
        subject: "3001",
        accountSessionId: handoff.session.accountSessionId,
        refreshToken: "r".repeat(43),
      })
    })
  })

  test("a missing, non-HTTPS or expired handoff is refused", async () => {
    expect(await readAccountSession(undefined)).toBe("missing")
    await withFile({ ...handoff, connectOrigin: "http://connect.example.test" }, async (file) =>
      expect(await readAccountSession(file, () => NOW)).toBe("invalid"),
    )
    await withFile(handoff, async (file) =>
      expect(await readAccountSession(file, () => Date.parse("2027-03-01T00:00:00Z"))).toBe("expired"),
    )
  })
})
