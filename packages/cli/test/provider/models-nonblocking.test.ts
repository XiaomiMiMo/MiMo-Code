import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Data, get, refresh } from "../../src/provider/models"
import { createCatalog } from "../../src/provider/models-catalog"

// globalThis.fetch is process-wide: work left running by earlier files in the
// same `bun test` process can fetch during these tests. Count only models.dev
// catalog requests and pass everything else through.
function spyCatalogFetch() {
  const original = globalThis.fetch
  const spy = { fetched: false, restore: () => void (globalThis.fetch = original) }
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!url.endsWith("/api.json")) return original(input, init)
      spy.fetched = true
      // Hang: a network path must never be taken here.
      return new Promise<Response>(() => {})
    },
    { preconnect: original.preconnect },
  )
  return spy
}

describe("models.dev is local-only for startup", () => {
  test("get() resolves from pinned path/snapshot without network", async () => {
    const spy = spyCatalogFetch()

    try {
      const start = Date.now()
      const data = await get()
      const elapsed = Date.now() - start
      expect(spy.fetched).toBe(false)
      expect(elapsed).toBeLessThan(2000)
      expect(Object.keys(data).length).toBeGreaterThan(0)
    } finally {
      spy.restore()
    }
  })

  test("refresh(true) is a no-op when MIMOCODE_MODELS_PATH is pinned", async () => {
    const spy = spyCatalogFetch()

    try {
      const start = Date.now()
      await refresh(true)
      expect(Date.now() - start).toBeLessThan(1000)
      expect(spy.fetched).toBe(false)
      // reset is fine; a subsequent get must still be local-only
      const data = await Data()
      expect(Object.keys(data).length).toBeGreaterThan(0)
    } finally {
      spy.restore()
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
