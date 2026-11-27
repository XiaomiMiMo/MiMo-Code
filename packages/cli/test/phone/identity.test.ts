import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadDebugIdentity, platformUserIds } from "../../src/phone/identity"

const NOW = 1_800_000_000_000
const valid = {
  version: 1,
  mode: "isolated-debug",
  origin: "https://connect.example.test",
  environment: "china-test",
  subject: "debug:7f6c2f9e-0000-4000-8000-000000000001",
  issuedAt: NOW - 1000,
  expiresAt: NOW + 60_000,
  role: "cli",
  loginInstanceId: "0123456789abcdef0123456789abcdef",
  accessToken: "t".repeat(43),
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
  test("a valid CLI profile becomes a bare-bearer connector account", async () => {
    await withFile(valid, async (file) => {
      expect(await loadDebugIdentity(file, () => NOW)).toEqual({
        origin: "https://connect.example.test",
        environment: "china-test",
        subject: valid.subject,
        serviceToken: "t".repeat(43),
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
      [{ environment: "china-production" }, "invalid"],
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

describe("MiMo platform sign-in", () => {
  test("user ids of the Xiaomi model credentials are read; other providers are ignored", async () => {
    await withFile(
      {
        xiaomi: { type: "api", key: "sk-1", metadata: { uid: "2469486853", base_url: "https://api.example" } },
        "xiaomi-token-plan-cn": { type: "api", key: "sk-2", metadata: { uid: "2469486853" } },
        anthropic: { type: "api", key: "sk-3", metadata: { uid: "999" } },
      },
      async (file) => expect(await platformUserIds(file)).toEqual(["2469486853"]),
    )
  })

  test("no credentials file or an unreadable one means no platform sign-in", async () => {
    expect(await platformUserIds("/nonexistent/auth.json")).toEqual([])
    await withFile("{not json", async (file) => expect(await platformUserIds(file)).toEqual([]))
  })
})
