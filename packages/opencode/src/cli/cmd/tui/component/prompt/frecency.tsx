import path from "path"
import { Global } from "@/global"
import { Filesystem } from "@/util"
import { onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "../../context/helper"
import { appendFile, writeFile } from "fs/promises"

function calculateFrecency(entry?: { frequency: number; lastOpen: number }): number {
  if (!entry) return 0
  const daysSince = (Date.now() - entry.lastOpen) / 86400000 // ms per day
  const weight = 1 / (1 + daysSince)
  return entry.frequency * weight
}

/**
 * Both writes of the whole `data` map are PRUNES: they hand over the surviving
 * entries and mean the rest to be gone.
 *
 * Solid's store setter merges plain objects into the existing node
 * (`mergeStoreNode` only writes `Object.keys(next)`), so the pruned keys used to
 * survive in the store while the on-disk file was rewritten without them. The
 * MAX_FRECENCY_ENTRIES cap therefore never took effect in memory: `store.data`
 * grew without bound, every subsequent open re-ran the prune, and dropped paths
 * kept scoring in the file picker.
 */
export function nextFrecencyData(data: Record<string, { frequency: number; lastOpen: number }>) {
  return reconcile(data)
}

const MAX_FRECENCY_ENTRIES = 1000

export const { use: useFrecency, provider: FrecencyProvider } = createSimpleContext({
  name: "Frecency",
  init: () => {
    const frecencyPath = path.join(Global.Path.state, "frecency.jsonl")
    onMount(async () => {
      const text = await Filesystem.readText(frecencyPath).catch(() => "")
      const lines = text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as { path: string; frequency: number; lastOpen: number }
          } catch {
            return null
          }
        })
        .filter((line): line is { path: string; frequency: number; lastOpen: number } => line !== null)

      const latest = lines.reduce(
        (acc, entry) => {
          acc[entry.path] = entry
          return acc
        },
        {} as Record<string, { path: string; frequency: number; lastOpen: number }>,
      )

      const sorted = Object.values(latest)
        .sort((a, b) => b.lastOpen - a.lastOpen)
        .slice(0, MAX_FRECENCY_ENTRIES)

      setStore(
        "data",
        nextFrecencyData(
          Object.fromEntries(
            sorted.map((entry) => [entry.path, { frequency: entry.frequency, lastOpen: entry.lastOpen }]),
          ),
        ),
      )

      if (sorted.length > 0) {
        const content = sorted.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
        writeFile(frecencyPath, content).catch(() => {})
      }
    })

    const [store, setStore] = createStore({
      data: {} as Record<string, { frequency: number; lastOpen: number }>,
    })

    function updateFrecency(filePath: string) {
      const absolutePath = path.resolve(process.cwd(), filePath)
      const newEntry = {
        frequency: (store.data[absolutePath]?.frequency || 0) + 1,
        lastOpen: Date.now(),
      }
      setStore("data", absolutePath, newEntry)
      appendFile(frecencyPath, JSON.stringify({ path: absolutePath, ...newEntry }) + "\n").catch(() => {})

      if (Object.keys(store.data).length > MAX_FRECENCY_ENTRIES) {
        const sorted = Object.entries(store.data)
          .sort(([, a], [, b]) => b.lastOpen - a.lastOpen)
          .slice(0, MAX_FRECENCY_ENTRIES)
        setStore("data", nextFrecencyData(Object.fromEntries(sorted)))
        const content = sorted.map(([path, entry]) => JSON.stringify({ path, ...entry })).join("\n") + "\n"
        writeFile(frecencyPath, content).catch(() => {})
      }
    }

    return {
      getFrecency: (filePath: string) => calculateFrecency(store.data[path.resolve(process.cwd(), filePath)]),
      updateFrecency,
      data: () => store.data,
    }
  },
})
