import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Data, get, refresh } from "../../src/provider/models"
import { Global } from "../../src/global"
import { Flag } from "../../src/flag/flag"

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

  test("cold start with no cache and no snapshot does one bounded fetch", async () => {
    // Simulate a fresh install: no pinned path, no cache file, no snapshot.
    const cacheFile = path.join(Global.Path.cache, "models.json")
    const snapshotFile = path.join(import.meta.dir, "../../src/provider/models-snapshot.js")
    const hadCache = fs.existsSync(cacheFile)
    const cacheBackup = hadCache ? fs.readFileSync(cacheFile) : undefined
    const hadSnapshot = fs.existsSync(snapshotFile)

    const originalPinned = Flag.MIMOCODE_MODELS_PATH
    const originalFetch = globalThis.fetch

    // Remove cache
    if (hadCache) fs.unlinkSync(cacheFile)
    // Hide snapshot by renaming
    if (hadSnapshot) fs.renameSync(snapshotFile, snapshotFile + ".bak")
    // Unpin so Data() falls through to the fetch path
    ;(Flag as Record<string, unknown>).MIMOCODE_MODELS_PATH = undefined
    Data.reset()

    let fetchCount = 0
    const payload = JSON.stringify({ coldstart: { id: "coldstart", name: "Cold", env: [], models: {} } })
    globalThis.fetch = (async () => {
      fetchCount++
      return new Response(payload, { status: 200 })
    }) as unknown as typeof fetch

    try {
      const data = await get()
      expect(fetchCount).toBe(1)
      expect(data).toHaveProperty("coldstart")
      expect(fs.existsSync(cacheFile)).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      ;(Flag as Record<string, unknown>).MIMOCODE_MODELS_PATH = originalPinned
      if (hadSnapshot) fs.renameSync(snapshotFile + ".bak", snapshotFile)
      if (!hadSnapshot && fs.existsSync(snapshotFile + ".bak")) fs.unlinkSync(snapshotFile + ".bak")
      if (cacheBackup !== undefined) fs.writeFileSync(cacheFile, cacheBackup)
      else if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile)
      Data.reset()
    }
  })
})
