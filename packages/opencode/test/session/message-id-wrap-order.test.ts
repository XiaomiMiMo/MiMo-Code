import { describe, expect, test } from "bun:test"
import { Identifier } from "@/id/id"
import { MessageV2 } from "../../src/session/message-v2"

// The id encoder packs `Date.now() * 0x1000 + counter` into 6 bytes, so the
// sortable prefix wraps every 2^36 ms. The most recent boundary:
const WRAP = 26 * 2 ** 36 // 1786706395136 ms = 2026-08-14 11:19:55 UTC
const PERIOD = 2 ** 36

const msg = (id: string, created: number) => ({ id, time: { created } })

describe("message id wraparound", () => {
  test("encoder really does wrap at the 2^36 ms boundary", () => {
    // Not asserting the bug is fixed in the encoder — asserting it EXISTS, so
    // that widening the encoding later fails this test loudly rather than
    // leaving the ordering fix looking pointless.
    const before = Identifier.create("msg", "ascending", WRAP - 1)
    const after = Identifier.create("msg", "ascending", WRAP + 1)
    expect(before.slice(4, 16) > after.slice(4, 16)).toBe(true)
    expect(after.slice(4, 8)).toBe("0000")
  })

  test("wrap period is ~2.18 years, next boundary ~Oct 2028", () => {
    expect(PERIOD).toBe(68719476736)
    expect(new Date(WRAP).toISOString()).toBe("2026-08-14T11:19:55.136Z")
    expect(new Date(WRAP + PERIOD).getUTCFullYear()).toBe(2028)
  })

  test("compare orders across a wrap where bare id compare inverts", () => {
    // Real ids: pre-wrap tail and post-wrap prompt from the wedged session.
    const pre = msg("msg_fd708d21e001JXYNUE1Jba3VEw", 1786019107358) // Aug 06
    const post = msg("msg_0006f768700114fd6bDaDwzOWs", 1786713700254) // Aug 14

    // The bug: lexicographic id order claims the Aug-14 message is older.
    expect(post.id < pre.id).toBe(true)
    // The fix: chronological order is correct.
    expect(MessageV2.compare(pre, post)).toBeLessThan(0)
    expect(MessageV2.compare(post, pre)).toBeGreaterThan(0)
  })

  test("compare handles the upstream-reported id pair too", () => {
    const pre = msg("msg_ffd4c8ecc001nKKJtMDUGfajRL", 1786700000000)
    const post = msg("msg_000bcb6970013Jm92xkWhlZiOA", 1786718762656)
    expect(post.id < pre.id).toBe(true)
    expect(MessageV2.compare(pre, post)).toBeLessThan(0)
  })

  test("id breaks ties within the same millisecond", () => {
    const a = msg("msg_000aaa", 1786713700254)
    const b = msg("msg_000bbb", 1786713700254)
    expect(MessageV2.compare(a, b)).toBeLessThan(0)
    expect(MessageV2.compare(b, a)).toBeGreaterThan(0)
  })

  test("compare is 0 only for the same message", () => {
    const a = msg("msg_000aaa", 1786713700254)
    expect(MessageV2.compare(a, { ...a })).toBe(0)
  })

  test("sorting a straddling session yields chronological order", () => {
    const msgs = [
      msg("msg_0006f7687001", 1786713700254), // Aug 14, post-wrap
      msg("msg_f4c12734b001", 1783687705445), // Jul 10, pre-wrap
      msg("msg_fd708d21e001", 1786019107358), // Aug 06, pre-wrap
    ]
    expect([...msgs].sort(MessageV2.compare).map((m) => m.time.created)).toEqual([
      1783687705445, 1786019107358, 1786713700254,
    ])
    // Bare id sort puts the newest message first — the wedging behaviour.
    expect([...msgs].sort((a, b) => (a.id < b.id ? -1 : 1))[0]!.time.created).toBe(1786713700254)
  })
})
