import path from "path"
import { existsSync } from "fs"
import { Glob } from "@mimo-ai/shared/util/glob"
import { Global } from "../global"
import { Log } from "../util"
import { Database, eq, count } from "../storage"
import { openReadonly } from "../storage/read-sqlite"
import { ExternalImportTable } from "./external-import.sql"
import { ClaudeImport } from "./claude-import"
import { CodexImport } from "./codex-import"
import { OpencodeImport, DEFAULT_DB_PATH } from "./opencode-import"

const log = Log.create({ service: "external-import" })

export type Source = "cc" | "codex" | "opencode"
export const ALL_SOURCES: readonly Source[] = ["cc", "codex", "opencode"] as const

export type ImportStats = {
  scanned: number
  imported: number
  resynced: number
  skipped: number
  errors: string[]
}

export type RunAllResult = {
  [K in Source]: ImportStats
}

export type SourceScan = {
  available: boolean
  sessions: number
  imported: number
}

export type ScanResult = {
  [K in Source]: SourceScan
}

/** Pre-scan: per-source availability + total/already-imported session counts. Read-only. */
export async function scan(): Promise<ScanResult> {
  const importedBySource = (source: Source) =>
    Database.use((db) =>
      db.select({ n: count() }).from(ExternalImportTable).where(eq(ExternalImportTable.source, source)).get(),
    )?.n ?? 0

  const result: ScanResult = {
    cc: { available: false, sessions: 0, imported: 0 },
    codex: { available: false, sessions: 0, imported: 0 },
    opencode: { available: false, sessions: 0, imported: 0 },
  }

  // 每源独立 try:单源失败(权限/坏文件)不让整个 scan 端点 500,降级为 available:false
  const ccRoot = path.join(Global.Path.home, ".claude", "projects")
  if (existsSync(ccRoot)) {
    try {
      const files = await Glob.scan("*/*.jsonl", { cwd: ccRoot, absolute: false })
      result.cc = { available: true, sessions: files.length, imported: importedBySource("cc") }
    } catch (e) {
      log.warn("cc scan failed", { error: String(e) })
    }
  }

  const codexRoot = path.join(Global.Path.home, ".codex", "sessions")
  if (existsSync(codexRoot)) {
    try {
      const files = await Glob.scan("**/*.jsonl", { cwd: codexRoot, absolute: false })
      result.codex = { available: true, sessions: files.length, imported: importedBySource("codex") }
    } catch (e) {
      log.warn("codex scan failed", { error: String(e) })
    }
  }

  if (existsSync(DEFAULT_DB_PATH)) {
    try {
      const db = openReadonly(DEFAULT_DB_PATH)
      try {
        const row = db.get("SELECT count(*) AS n FROM session") as { n: number } | null
        result.opencode = { available: true, sessions: row?.n ?? 0, imported: importedBySource("opencode") }
      } finally {
        db.close()
      }
    } catch (e) {
      log.warn("opencode scan failed", { error: String(e) })
    }
  }

  return result
}

function emptyStats(): ImportStats {
  return { scanned: 0, imported: 0, resynced: 0, skipped: 0, errors: [] }
}

export async function runAll(opts?: {
  sources?: Source[]
  force?: boolean
}): Promise<RunAllResult> {
  const sources = new Set(opts?.sources ?? ALL_SOURCES)

  const result: RunAllResult = {
    cc: emptyStats(),
    codex: emptyStats(),
    opencode: emptyStats(),
  }

  for (const source of ALL_SOURCES) {
    if (!sources.has(source)) continue
    try {
      if (source === "cc") {
        result.cc = await ClaudeImport.run({ force: opts?.force })
      } else if (source === "codex") {
        result.codex = await CodexImport.run({ force: opts?.force })
      } else {
        result.opencode = await OpencodeImport.run({ force: opts?.force })
      }
    } catch (e) {
      log.warn(`${source} import failed`, { error: String(e) })
      result[source].errors.push(String(e))
    }
  }

  const totals = {
    scanned: result.cc.scanned + result.codex.scanned + result.opencode.scanned,
    imported: result.cc.imported + result.codex.imported + result.opencode.imported,
    resynced: result.cc.resynced + result.codex.resynced + result.opencode.resynced,
    errors: result.cc.errors.length + result.codex.errors.length + result.opencode.errors.length,
  }
  if (totals.imported + totals.resynced > 0 || totals.errors > 0) {
    log.info("external import", totals)
  }

  return result
}

export * as ExternalImport from "./external-import"
