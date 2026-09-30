import { expect, test } from "bun:test"
import { watchModelsCatalogReload } from "../../src/provider/models-catalog-reload"

test("watchModelsCatalogReload debounces and coalesces catalog publishes", async () => {
  const listeners = new Set<() => void>()
  let reloads = 0
  const stop = watchModelsCatalogReload({
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reload: async () => {
      reloads++
    },
    delayMs: 5,
  })
  for (const listener of listeners) listener()
  for (const listener of listeners) listener()
  for (const listener of listeners) listener()
  await new Promise((r) => setTimeout(r, 20))
  expect(reloads).toBe(1)
  stop()
  for (const listener of [...listeners]) listener()
  await new Promise((r) => setTimeout(r, 20))
  expect(reloads).toBe(1)
})

test("watchModelsCatalogReload swallows reload failures", async () => {
  const listeners = new Set<() => void>()
  const stop = watchModelsCatalogReload({
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reload: async () => {
      throw new Error("busy")
    },
    delayMs: 1,
  })
  for (const listener of listeners) listener()
  await new Promise((r) => setTimeout(r, 10))
  stop()
})
