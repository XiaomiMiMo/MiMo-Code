import { describe, expect, test } from "bun:test"
import { Data, get, refresh } from "../../src/provider/models"

describe("models.dev is local-only for startup", () => {
  test("get() resolves from pinned path/snapshot without network", async () => {
    const originalFetch = globalThis.fetch
    let fetched = false
    globalThis.fetch = (async () => {
      fetched = true
      // Hang: a network path must never be taken by get().
      await new Promise(() => {})
      return new Response("{}")
    }) as unknown as typeof fetch

    try {
      const start = Date.now()
      const data = await get()
      const elapsed = Date.now() - start
      expect(fetched).toBe(false)
      expect(elapsed).toBeLessThan(2000)
      expect(Object.keys(data).length).toBeGreaterThan(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("refresh(true) is a no-op when MIMOCODE_MODELS_PATH is pinned", async () => {
    const originalFetch = globalThis.fetch
    let fetched = false
    globalThis.fetch = (async () => {
      fetched = true
      await new Promise(() => {})
      return new Response("{}")
    }) as unknown as typeof fetch

    try {
      const start = Date.now()
      await refresh(true)
      expect(Date.now() - start).toBeLessThan(1000)
      expect(fetched).toBe(false)
      // reset is fine; a subsequent get must still be local-only
      const data = await Data()
      expect(Object.keys(data).length).toBeGreaterThan(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
