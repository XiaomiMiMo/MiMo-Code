import * as fs from "fs/promises"
import path from "path"
import { Database, eq } from "../storage"
import { Log } from "../util"
import { MemoryFtsTable } from "./fts.sql"
import { parsePath, parseCcPath, parseCcFrontmatterType, type MemoryLocator } from "./paths"

const log = Log.create({ service: "memory.reconcile" })

export async function walkMemoryDir(root: string): Promise<string[]> {
  const out: string[] = []
  async function recurse(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [] as import("fs").Dirent[]
      throw e
    })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await recurse(full)
      else if (entry.isFile() && full.endsWith(".md")) out.push(full)
    }
  }
  await recurse(root)
  return out
}

// Walk <base>/<slug>/memory/**/*.md across every slug under <base>.
// ENOENT on <base> returns []; missing memory subdirs are silently skipped.
export async function walkCcRoot(base: string): Promise<string[]> {
  const slugs = await fs.readdir(base, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [] as import("fs").Dirent[]
    throw e
  })
  const out: string[] = []
  for (const entry of slugs) {
    if (!entry.isDirectory()) continue
    const memoryDir = path.join(base, entry.name, "memory")
    const exists = await fs.stat(memoryDir).then(() => true).catch(() => false)
    if (!exists) continue
    const files = await walkMemoryDir(memoryDir)
    for (const f of files) out.push(f)
  }
  return out
}

export async function indexFromDisk(
  absPath: string,
  loc: MemoryLocator,
  bodyType: "mimo" | "cc",
  oldFingerprint?: string,
): Promise<"hit" | "updated" | "skipped"> {
  const stat = await fs.stat(absPath).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null
    throw e
  })
  if (!stat) return "skipped"
  const fingerprint = `${stat.size}-${stat.mtimeMs}`
  if (oldFingerprint === fingerprint) return "hit"

  const body = await Bun.file(absPath).text()

  // For CC files, derive type from frontmatter; mimo files keep loc.type from path.
  const finalType =
    bodyType === "cc" ? (parseCcFrontmatterType(body) ?? "free") : loc.type

  Database.use((db) =>
    db
      .insert(MemoryFtsTable)
      .values({
        path: absPath,
        scope: loc.scope,
        scope_id: loc.scope_id,
        type: finalType,
        body,
        fingerprint,
        last_indexed_at: Date.now(),
      })
      .onConflictDoUpdate({
        target: MemoryFtsTable.path,
        set: {
          scope: loc.scope,
          scope_id: loc.scope_id,
          type: finalType,
          body,
          fingerprint,
          last_indexed_at: Date.now(),
        },
      })
      .run(),
  )
  return "updated"
}

export async function reconcileMemory(
  roots: { mimo: string; cc?: string },
): Promise<{ indexed: number; pruned: number }> {
  // Collect disk paths from BOTH roots before pruning. If we pruned per-root,
  // enabling CC indexing on a fresh run would prune all mimo rows (and vice
  // versa) because each walk's set is missing the other root's paths.
  const mimoFiles = new Set(await walkMemoryDir(roots.mimo))
  const ccFiles = roots.cc ? new Set(await walkCcRoot(roots.cc)) : new Set<string>()
  const diskPaths = new Set<string>([...mimoFiles, ...ccFiles])

  const indexed = new Map<string, string>(
    Database.use((db) =>
      db
        .select({ path: MemoryFtsTable.path, fingerprint: MemoryFtsTable.fingerprint })
        .from(MemoryFtsTable)
        .all(),
    ).map((r) => [r.path, r.fingerprint]),
  )

  // Direction B: prune dead FTS rows (any path not in either walk).
  let pruned = 0
  for (const p of indexed.keys()) {
    if (!diskPaths.has(p)) {
      Database.use((db) => db.delete(MemoryFtsTable).where(eq(MemoryFtsTable.path, p)).run())
      pruned++
    }
  }

  // Direction A: index disk files. Pick parser by which walk produced the path.
  let indexedCount = 0
  for (const p of mimoFiles) {
    const loc = parsePath(p)
    if (!loc) {
      log.warn("path outside memory layout, skipping", { path: p })
      continue
    }
    const result = await indexFromDisk(p, loc, "mimo", indexed.get(p))
    if (result === "updated") indexedCount++
  }
  for (const p of ccFiles) {
    const loc = parseCcPath(p)
    if (!loc) {
      log.warn("CC path failed to parse, skipping", { path: p })
      continue
    }
    const result = await indexFromDisk(p, loc, "cc", indexed.get(p))
    if (result === "updated") indexedCount++
  }

  return { indexed: indexedCount, pruned }
}
