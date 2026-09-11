import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Data, get, refresh } from "../../src/provider/models"
import { createCatalog } from "../../src/provider/models-catalog"

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

  test("cold start get() stays local; refresh(true) does one bounded fetch", async () => {
    const cacheFile = path.join(os.tmpdir(), `models-nonblocking-${Date.now()}.json`)
    let fetchCount = 0
    const catalog = createCatalog({
      cache: cacheFile,
      snapshot: async () => ({}),
      fetch: async () => {
        fetchCount++
        return Response.json({
          coldstart: {
            id: "coldstart",
            name: "Cold",
            env: [],
            models: {
              m: {
                id: "m",
                name: "M",
                release_date: "2026-01-01",
                attachment: false,
                reasoning: false,
                temperature: true,
                tool_call: true,
                limit: { context: 100, output: 10 },
              },
            },
          },
        })
      },
    })
    try {
      const local = await catalog.get()
      expect(fetchCount).toBe(0)
      expect(Object.keys(local)).toEqual([])
      await catalog.refresh(true)
      expect(fetchCount).toBe(1)
      expect(await catalog.get()).toHaveProperty("coldstart")
      expect(fs.existsSync(cacheFile)).toBe(true)
    } finally {
      if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile)
    }
  })
})
