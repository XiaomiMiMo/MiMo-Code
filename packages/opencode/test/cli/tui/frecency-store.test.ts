import { describe, test, expect } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { nextFrecencyData } from "../../../src/cli/cmd/tui/component/prompt/frecency"

// Both whole-map writes of the frecency store are PRUNES, but solid MERGES plain
// objects into the existing node — so the dropped keys used to survive in memory
// while the .jsonl was rewritten without them. The MAX_FRECENCY_ENTRIES cap
// therefore never took effect in the store.
type Entry = { frequency: number; lastOpen: number }

function harness() {
  return createRoot((dispose) => {
    const [store, setStore] = createStore<{ data: Record<string, Entry> }>({ data: {} })
    return {
      store,
      // Mirrors updateFrecency()'s per-path write, which is not a prune.
      touch: (file: string, entry: Entry) => setStore("data", file, entry),
      // Mirrors both whole-map writes: the onMount load and the over-cap prune.
      replace: (data: Record<string, Entry>) => setStore("data", nextFrecencyData(data)),
      dispose,
    }
  })
}

describe("nextFrecencyData", () => {
  test("a prune actually drops the entries it left out", () => {
    const h = harness()
    h.touch("/a.ts", { frequency: 1, lastOpen: 300 })
    h.touch("/b.ts", { frequency: 4, lastOpen: 200 })
    h.touch("/c.ts", { frequency: 9, lastOpen: 100 })
    expect(Object.keys(h.store.data).sort()).toEqual(["/a.ts", "/b.ts", "/c.ts"])

    // The over-cap branch keeps the most-recent survivors and rewrites the file
    // with only those; the store must agree.
    h.replace({ "/a.ts": { frequency: 1, lastOpen: 300 }, "/b.ts": { frequency: 4, lastOpen: 200 } })
    expect(Object.keys(h.store.data).sort()).toEqual(["/a.ts", "/b.ts"])
    expect(h.store.data["/c.ts"]).toBeUndefined()
    h.dispose()
  })

  test("the store never grows past what a prune handed it", () => {
    const h = harness()
    for (let i = 0; i < 12; i++) h.touch(`/f${i}.ts`, { frequency: 1, lastOpen: i })
    expect(Object.keys(h.store.data)).toHaveLength(12)

    const kept = Object.fromEntries(
      Object.entries(h.store.data)
        .sort(([, a], [, b]) => b.lastOpen - a.lastOpen)
        .slice(0, 5),
    )
    h.replace(kept)
    expect(Object.keys(h.store.data)).toHaveLength(5)
    h.dispose()
  })

  test("an authoritative load replaces rather than unions with what was already there", () => {
    const h = harness()
    // A file opened before the async onMount read resolves.
    h.touch("/early.ts", { frequency: 1, lastOpen: 999 })
    h.replace({ "/from-disk.ts": { frequency: 7, lastOpen: 5 } })
    expect(Object.keys(h.store.data)).toEqual(["/from-disk.ts"])
    h.dispose()
  })

  test("surviving entries keep their values through a prune", () => {
    const h = harness()
    h.touch("/keep.ts", { frequency: 3, lastOpen: 10 })
    h.touch("/drop.ts", { frequency: 1, lastOpen: 1 })
    h.replace({ "/keep.ts": { frequency: 3, lastOpen: 10 } })
    expect(h.store.data["/keep.ts"]).toEqual({ frequency: 3, lastOpen: 10 })
    h.dispose()
  })
})
