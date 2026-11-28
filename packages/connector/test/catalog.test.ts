import { describe, expect, test } from "bun:test"
import { Catalog, clipTitle } from "../src/catalog"
import { hex, sha256 } from "../src/json"
import type { BackendSession } from "../src/ports"

const CURSOR = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/

function sessions(count: number): BackendSession[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `ses_${String(index).padStart(3, "0")}`,
    title: `Session ${index}`,
    updatedAt: 1_700_000_000_000 + index,
  }))
}

describe("catalog", () => {
  test("revision hashes the ordered id and title list, not the update time", async () => {
    const catalog = new Catalog()
    const list = sessions(3)
    const expected = hex(await sha256(JSON.stringify(list.map((s) => ({ sessionId: s.id, title: s.title })))))
    expect(await catalog.revision(list)).toBe(expected)
    expect(await catalog.revision(list.map((s) => ({ ...s, updatedAt: s.updatedAt + 5 })))).toBe(expected)
    expect(await catalog.revision([list[1], list[0], list[2]])).not.toBe(expected)
  })

  test("pages through the list with one revision and an opaque cursor", async () => {
    const catalog = new Catalog()
    const list = sessions(5)
    const first = await catalog.page(list, null, 2)
    if (typeof first === "string") throw new Error(first)
    expect(first.entries.map((e) => e.sessionId)).toEqual(["ses_000", "ses_001"])
    expect(first.entries[0]).toEqual({
      sessionId: "ses_000",
      title: "Session 0",
      updatedAt: new Date(1_700_000_000_000).toISOString(),
    })
    expect(first.nextCursor).toMatch(CURSOR)
    const second = await catalog.page(list, first.nextCursor, 2)
    const third = await catalog.page(list, (second as { nextCursor: string }).nextCursor, 2)
    if (typeof second === "string" || typeof third === "string") throw new Error("page failed")
    expect(second.revision).toBe(first.revision)
    expect(third.entries.map((e) => e.sessionId)).toEqual(["ses_004"])
    expect(third.nextCursor).toBeNull()
  })

  test("an empty catalog is one empty page", async () => {
    expect(await new Catalog().page([], null, 50)).toMatchObject({ entries: [], nextCursor: null })
  })

  test("a changed catalog, a foreign or tampered cursor and an expired one are told apart", async () => {
    let now = 1_000_000
    const catalog = new Catalog(() => now)
    const list = sessions(3)
    const first = (await catalog.page(list, null, 1)) as { nextCursor: string }
    expect(await catalog.page([{ ...list[0], title: "Renamed" }, ...list.slice(1)], first.nextCursor, 1)).toBe(
      "catalog_changed",
    )
    expect(await new Catalog(() => now).page(list, first.nextCursor, 1)).toBe("invalid_cursor")
    const [body, mac] = first.nextCursor.split(".")
    expect(await catalog.page(list, `${body}A.${mac}`, 1)).toBe("invalid_cursor")
    expect(await catalog.page(list, "not-a-cursor", 1)).toBe("invalid_cursor")
    now += 300_000
    expect(await catalog.page(list, first.nextCursor, 1)).toBe("cursor_expired")
  })

  test("pages stay inside the frame budget and a lone oversize entry is reported", async () => {
    const catalog = new Catalog()
    const big = Array.from({ length: 50 }, (_, index) => ({
      id: `ses_${index}`,
      title: "界".repeat(4096),
      updatedAt: 0,
    }))
    const page = await catalog.page(big, null, 50)
    if (typeof page === "string") throw new Error(page)
    expect(page.entries.length).toBeLessThan(50)
    expect(new TextEncoder().encode(JSON.stringify(page.entries)).length).toBeLessThanOrEqual(262_144 - 2_048)
    expect(page.nextCursor).toMatch(CURSOR)
    expect(page.entries[0].updatedAt).toBeUndefined()
  })

  test("titles are clipped to the phone limit without splitting a surrogate pair", () => {
    expect(clipTitle("a".repeat(5000)).length).toBe(4096)
    const emoji = "a".repeat(4095) + "😀"
    expect(clipTitle(emoji)).toBe("a".repeat(4095))
  })

  test("sessions whose id the phone cannot carry are left out", async () => {
    const page = await new Catalog().page([{ id: "bad id", title: "x", updatedAt: 1 }, ...sessions(1)], null, 50)
    expect((page as { entries: { sessionId: string }[] }).entries.map((e) => e.sessionId)).toEqual(["ses_000"])
  })
})
