import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { LLMServerTokens } from "../../src/llm-server/tokens"
import { duration } from "../../src/cli/cmd/llm-server"
import { tmpdir } from "../fixture/fixture"

/**
 * The store is keyed by project directory, so a fresh tmpdir is a fresh store and
 * these tests do not interfere with each other or with a real installation.
 */

describe("duration parsing", () => {
  test("reads the unit suffixes", () => {
    expect(duration("30m", "1d")).toBe(1_800_000)
    expect(duration("12h", "1d")).toBe(43_200_000)
    expect(duration("7d", "1d")).toBe(604_800_000)
    expect(duration("500ms", "1d")).toBe(500)
    expect(duration("90s", "1d")).toBe(90_000)
  })

  test("treats an absent value as the configured fallback", () => {
    expect(duration(undefined, "1d")).toBe(86_400_000)
    expect(duration(undefined, "none")).toBeUndefined()
  })

  test("spells unlimited as a value, not an absence", () => {
    // `undefined` here means "no limit", which is why `none` has to be expressible:
    // otherwise unlimited would be indistinguishable from a forgotten flag.
    expect(duration("none", "1d")).toBeUndefined()
    expect(duration("never", "1d")).toBeUndefined()
    expect(duration("0", "1d")).toBeUndefined()
  })

  test("rejects nonsense rather than silently defaulting", () => {
    expect(() => duration("soon", "1d")).toThrow(/Invalid duration/)
    expect(() => duration("1w", "1d")).toThrow(/Invalid duration/)
    expect(() => duration("-5m", "1d")).toThrow(/Invalid duration/)
  })
})

describe("token store", () => {
  test("stores only a hash, never the token", async () => {
    await using tmp = await tmpdir()
    const issued = await LLMServerTokens.issue({ directory: tmp.path, expiry: { idleMs: 60_000 } })
    const records = await LLMServerTokens.list(tmp.path)
    expect(records).toHaveLength(1)
    expect(records[0]!.hash).toMatch(/^[0-9a-f]{64}$/)
    // The point of hashing: reading the file must not yield a usable credential.
    const raw = await fs.readFile(await pathOf(tmp.path), "utf8")
    expect(raw).not.toContain(issued.token)
    expect(raw).toContain(records[0]!.hash)
  })

  test("verifies a good token and rejects an unknown one", async () => {
    await using tmp = await tmpdir()
    const issued = await LLMServerTokens.issue({ directory: tmp.path, expiry: { idleMs: 60_000 } })
    expect(await LLMServerTokens.verify(tmp.path, issued.token)).toMatchObject({ ok: true })
    expect(await LLMServerTokens.verify(tmp.path, "not-a-real-token")).toEqual({ ok: false, reason: "unknown" })
  })

  test("a token scoped to a directory is not valid for another directory", async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    const issued = await LLMServerTokens.issue({ directory: a.path, expiry: { idleMs: 60_000 } })
    expect(await LLMServerTokens.verify(a.path, issued.token)).toMatchObject({ ok: true })
    expect(await LLMServerTokens.verify(b.path, issued.token)).toEqual({ ok: false, reason: "unknown" })
  })

  test("issues distinct tokens that coexist", async () => {
    await using tmp = await tmpdir()
    const one = await LLMServerTokens.issue({ directory: tmp.path, expiry: { idleMs: 60_000 }, label: "skill-a" })
    const two = await LLMServerTokens.issue({ directory: tmp.path, expiry: { idleMs: 60_000 }, label: "skill-b" })
    expect(one.token).not.toBe(two.token)
    expect(one.record.id).not.toBe(two.record.id)
    // Both remain valid: re-issuing for one skill must not revoke another's key.
    expect(await LLMServerTokens.verify(tmp.path, one.token)).toMatchObject({ ok: true })
    expect(await LLMServerTokens.verify(tmp.path, two.token)).toMatchObject({ ok: true })
  })
})

describe("write discipline", () => {
  test("a rejected token does not rewrite the store", async () => {
    // Every request goes through verify, so writing unconditionally let an
    // unauthenticated caller drive unbounded disk writes.
    await using tmp = await tmpdir()
    await LLMServerTokens.issue({ directory: tmp.path, expiry: {} })
    const target = await pathOf(tmp.path)
    const before = (await fs.stat(target)).mtimeMs

    await Bun.sleep(20)
    expect(await LLMServerTokens.verify(tmp.path, "never-issued")).toEqual({ ok: false, reason: "unknown" })

    expect((await fs.stat(target)).mtimeMs).toBe(before)
  })

  test("a successful verify does persist the slide", async () => {
    // The counterpart: the sliding window is only meaningful if it survives.
    await using tmp = await tmpdir()
    const issued = await LLMServerTokens.issue({ directory: tmp.path, expiry: { idleMs: 60_000 } })
    const target = await pathOf(tmp.path)
    const before = await fs.readFile(target, "utf8")

    await Bun.sleep(20)
    expect(await LLMServerTokens.verify(tmp.path, issued.token)).toMatchObject({ ok: true })

    expect(await fs.readFile(target, "utf8")).not.toBe(before)
  })
})

describe("expiry", () => {
  test("no limits means it never expires", async () => {
    await using tmp = await tmpdir()
    const issued = await LLMServerTokens.issue({ directory: tmp.path, expiry: {} })
    expect(LLMServerTokens.expiresAt(issued.record)).toBeUndefined()
    // Far in the future, with no activity at all.
    expect(LLMServerTokens.expired(issued.record, Date.now() + 10 * 365 * 86_400_000)).toBe(false)
  })

  test("the idle window is measured from the last use, so activity keeps it alive", async () => {
    await using tmp = await tmpdir()
    const issued = await LLMServerTokens.issue({ directory: tmp.path, expiry: { idleMs: 1_000 } })

    // Two uses spaced under the window each slide it forward, carrying the token
    // past the point where a fixed lifetime would already have killed it.
    await Bun.sleep(600)
    expect(await LLMServerTokens.verify(tmp.path, issued.token)).toMatchObject({ ok: true })
    await Bun.sleep(600)
    expect(await LLMServerTokens.verify(tmp.path, issued.token)).toMatchObject({ ok: true })

    // Then go quiet for longer than the window.
    await Bun.sleep(1_300)
    expect(await LLMServerTokens.verify(tmp.path, issued.token)).toMatchObject({ ok: false, reason: "expired" })
  })

  test("an issued-but-never-used token still ages out", async () => {
    await using tmp = await tmpdir()
    const issued = await LLMServerTokens.issue({ directory: tmp.path, expiry: { idleMs: 200 } })
    await Bun.sleep(500)
    expect(await LLMServerTokens.verify(tmp.path, issued.token)).toMatchObject({ ok: false, reason: "expired" })
  })

  test("the absolute ceiling wins over any amount of activity", async () => {
    await using tmp = await tmpdir()
    const issued = await LLMServerTokens.issue({
      directory: tmp.path,
      expiry: { idleMs: 60_000, maxAgeMs: 500 },
    })
    await Bun.sleep(200)
    expect(await LLMServerTokens.verify(tmp.path, issued.token)).toMatchObject({ ok: true })
    await Bun.sleep(500)
    // The idle window is nowhere near elapsed; the ceiling is what ends it.
    expect(await LLMServerTokens.verify(tmp.path, issued.token)).toMatchObject({ ok: false, reason: "expired" })
  })

  test("reports the nearer of the two limits", async () => {
    await using tmp = await tmpdir()
    const issued = await LLMServerTokens.issue({
      directory: tmp.path,
      expiry: { idleMs: 86_400_000, maxAgeMs: 60_000 },
    })
    expect(LLMServerTokens.expiresAt(issued.record)).toBe(issued.record.created + 60_000)
  })

  test("an expired record is dropped on the verify that discovers it", async () => {
    await using tmp = await tmpdir()
    const issued = await LLMServerTokens.issue({ directory: tmp.path, expiry: { idleMs: 50 } })
    await Bun.sleep(120)
    await LLMServerTokens.verify(tmp.path, issued.token)
    expect(await LLMServerTokens.list(tmp.path)).toHaveLength(0)
  })
})

describe("revocation", () => {
  test("revokes one token and leaves the rest", async () => {
    await using tmp = await tmpdir()
    const keep = await LLMServerTokens.issue({ directory: tmp.path, expiry: { idleMs: 60_000 } })
    const drop = await LLMServerTokens.issue({ directory: tmp.path, expiry: { idleMs: 60_000 } })
    expect(await LLMServerTokens.revoke(tmp.path, drop.record.id)).toBe(true)
    expect(await LLMServerTokens.verify(tmp.path, drop.token)).toEqual({ ok: false, reason: "unknown" })
    expect(await LLMServerTokens.verify(tmp.path, keep.token)).toMatchObject({ ok: true })
  })

  test("reports an unknown id rather than pretending to succeed", async () => {
    await using tmp = await tmpdir()
    expect(await LLMServerTokens.revoke(tmp.path, "llmk_nope")).toBe(false)
  })

  test("revokes everything at once", async () => {
    await using tmp = await tmpdir()
    await LLMServerTokens.issue({ directory: tmp.path, expiry: {} })
    await LLMServerTokens.issue({ directory: tmp.path, expiry: {} })
    expect(await LLMServerTokens.revokeAll(tmp.path)).toBe(2)
    expect(await LLMServerTokens.list(tmp.path)).toHaveLength(0)
  })
})

describe("server address", () => {
  test("absent until published, and gone again once removed", async () => {
    await using tmp = await tmpdir()
    expect(await LLMServerTokens.address(tmp.path)).toBeUndefined()
    await LLMServerTokens.publish(tmp.path, {
      pid: process.pid,
      hostname: "127.0.0.1",
      port: 1234,
      url: "http://127.0.0.1:1234/v1",
      started: Date.now(),
    })
    expect(await LLMServerTokens.address(tmp.path)).toMatchObject({ port: 1234 })
    await LLMServerTokens.unpublish(tmp.path)
    expect(await LLMServerTokens.address(tmp.path)).toBeUndefined()
  })

  test("treats a dead pid as nothing running", async () => {
    // A crashed server leaves its file behind; handing that port to a skill would
    // produce a connection error far away from the cause.
    await using tmp = await tmpdir()
    await LLMServerTokens.publish(tmp.path, {
      pid: 0x7ffffffe,
      hostname: "127.0.0.1",
      port: 1234,
      url: "http://127.0.0.1:1234/v1",
      started: Date.now(),
    })
    expect(await LLMServerTokens.address(tmp.path)).toBeUndefined()
    // And the file is gone, so a directory does not accumulate one entry per crash.
    expect(await Bun.file(LLMServerTokens.addressFile(tmp.path, 0x7ffffffe)).exists()).toBe(false)
  })

  test("keeps every live listener, newest first, without one overwriting another", async () => {
    // Several sessions can be open on one project and each binds its own port. A single
    // shared file would hand a caller whichever session happened to write last.
    await using tmp = await tmpdir()
    const now = Date.now()
    await LLMServerTokens.publish(tmp.path, {
      pid: process.pid,
      hostname: "127.0.0.1",
      port: 1111,
      url: "http://127.0.0.1:1111/",
      started: now - 5000,
    })
    await LLMServerTokens.publish(tmp.path, {
      pid: process.ppid,
      hostname: "127.0.0.1",
      port: 2222,
      url: "http://127.0.0.1:2222/",
      started: now,
    })

    expect(await LLMServerTokens.addresses(tmp.path)).toMatchObject([{ port: 2222 }, { port: 1111 }])
    // The newest, because with several sessions open that is the one just started.
    expect(await LLMServerTokens.address(tmp.path)).toMatchObject({ port: 2222 })

    // Withdrawing one leaves the other reachable.
    await LLMServerTokens.unpublish(tmp.path, process.ppid)
    expect(await LLMServerTokens.addresses(tmp.path)).toMatchObject([{ port: 1111 }])
  })
})

/** The store file for a directory, derived the same way the module derives it. */
async function pathOf(directory: string) {
  const { Hash } = await import("@mimo-ai/shared/util/hash")
  const { Global } = await import("../../src/global")
  const { Filesystem } = await import("../../src/util")
  const path = await import("path")
  // `Filesystem.resolve`, matching the module: it canonicalises symlinks, so on macOS
  // `/var/…` and `/private/var/…` land in one bucket instead of two.
  return path.join(Global.Path.state, "llm-server", Hash.fast(Filesystem.resolve(directory)), "tokens.json")
}
