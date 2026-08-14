import { describe, test, expect } from "bun:test"
import { bucketMessages, compareMessages, compareToMarker, searchMessages, selectMessages } from "../../../src/cli/cmd/tui/context/sync"

// Real ids from a session whose history straddled the 2026-08-14T11:19:55Z id wrap.
// Post-wrap ids restart near msg_000… while pre-wrap ids sit near msg_fff…, so a
// NEWER message sorts BEFORE the whole history under a raw id compare.
const JUL_10 = { id: "msg_f4c12734b001QCMWgJEWl8E2J3", time: { created: 1783687705445 } }
const AUG_06 = { id: "msg_fd708d21e001JXYNUE1Jba3VEw", time: { created: 1786019107358 } }
const AUG_14 = { id: "msg_0006f768700114fd6bDaDwzOWs", time: { created: 1786713700254 } }

const m = (x: typeof JUL_10, extra?: Record<string, unknown>) => ({ ...x, ...extra }) as any

describe("TUI message ordering across an id wraparound", () => {
  test("the premise: id order is inverted for these ids", () => {
    expect(AUG_14.id < AUG_06.id).toBe(true)
    expect(AUG_14.id < JUL_10.id).toBe(true)
  })

  test("compareMessages orders them chronologically", () => {
    expect(compareMessages(JUL_10, AUG_06)).toBeLessThan(0)
    expect(compareMessages(AUG_06, AUG_14)).toBeLessThan(0)
    expect(compareMessages(AUG_14, JUL_10)).toBeGreaterThan(0)
    expect([AUG_14, JUL_10, AUG_06].toSorted(compareMessages).map((x) => x.time.created)).toEqual([
      1783687705445, 1786019107358, 1786713700254,
    ])
  })

  test("id still breaks ties inside one millisecond", () => {
    const a = { id: "msg_000aaa", time: { created: 5 } }
    const b = { id: "msg_000bbb", time: { created: 5 } }
    expect(compareMessages(a, b)).toBeLessThan(0)
    expect(compareMessages(b, a)).toBeGreaterThan(0)
    expect(compareMessages(a, { ...a })).toBe(0)
  })

  // The bug that put new messages at the top of the transcript: the store keeps
  // each bucket sorted and asks searchMessages where an incoming message goes.
  describe("searchMessages picks the append index, not index 0", () => {
    const history = [m(JUL_10), m(AUG_06)]

    test("a post-wrap message appends to the end", () => {
      expect(searchMessages(history, AUG_14.id, AUG_14)).toEqual({ found: false, index: 2 })
    })

    test("an existing message is found at its own index", () => {
      expect(searchMessages(history, AUG_06.id, AUG_06)).toEqual({ found: true, index: 1 })
      expect(searchMessages(history, JUL_10.id, JUL_10)).toEqual({ found: true, index: 0 })
    })

    test("an already-inserted post-wrap message is found, not duplicated", () => {
      const withNew = [...history, m(AUG_14)]
      expect(searchMessages(withNew, AUG_14.id, AUG_14)).toEqual({ found: true, index: 2 })
    })

    test("id-only lookup (message.removed) finds by identity", () => {
      const withNew = [...history, m(AUG_14)]
      expect(searchMessages(withNew, AUG_14.id)).toEqual({ found: true, index: 2 })
      expect(searchMessages(withNew, "msg_absent")).toEqual({ found: false, index: 3 })
    })

    // Regression guard for the data loss: the >100 trim drops list[0] and deletes
    // its parts. Appending correctly is what keeps list[0] the genuinely oldest
    // message; inserting at 0 made the trim delete the newest message instead.
    test("repeated post-wrap appends keep the oldest message at index 0", () => {
      const list = [m(JUL_10), m(AUG_06)]
      for (let i = 0; i < 5; i++) {
        const next = { id: `msg_0006f7687${i}`, time: { created: 1786713700254 + i } }
        const at = searchMessages(list, next.id, next)
        expect(at.found).toBe(false)
        list.splice(at.index, 0, m(next))
      }
      expect(list[0].id).toBe(JUL_10.id)
      expect(list.at(-1)!.time.created).toBe(1786713700258)
      expect(list.map((x) => x.time.created)).toEqual([...list].map((x) => x.time.created).toSorted((a, b) => a - b))
    })
  })

  describe("compareToMarker resolves a session-held marker id", () => {
    const list = [m(JUL_10), m(AUG_06), m(AUG_14)]

    test("orders messages around a post-wrap revert marker", () => {
      expect(compareToMarker(list, m(JUL_10), AUG_14.id)).toBeLessThan(0)
      expect(compareToMarker(list, m(AUG_14), AUG_14.id)).toBe(0)
    })

    test("orders messages around a pre-wrap revert marker", () => {
      // A raw `id >= marker` compare calls the Aug-14 message "before" the Aug-06
      // marker, which is how /undo and the reverted-message strikethrough drifted.
      expect(compareToMarker(list, m(AUG_14), AUG_06.id)).toBeGreaterThan(0)
      expect(compareToMarker(list, m(JUL_10), AUG_06.id)).toBeLessThan(0)
    })

    test("returns undefined when the marker is outside the loaded window", () => {
      expect(compareToMarker(list, m(AUG_14), "msg_notloaded")).toBeUndefined()
    })
  })

  test("selectMessages picks the newest bucket by time, not by id", () => {
    // general-2's tail is post-wrap (smaller id, later time) — an id compare would
    // pick general-1 and render the stale bucket.
    const buckets = bucketMessages([m(AUG_06, { agentID: "general-1" }), m(AUG_14, { agentID: "general-2" })])
    expect(selectMessages(buckets, "main", "ses_actorhost").map((x: any) => x.id)).toEqual([AUG_14.id])
  })
})
