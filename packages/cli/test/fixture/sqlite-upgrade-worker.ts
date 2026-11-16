import { Database } from "bun:sqlite"

export type UpgradeAttempt = {
  file: string
  id: number
  busyTimeoutMs: number
  behavior: "deferred" | "immediate"
}

export type UpgradeResult = {
  ok: boolean
  elapsedMs: number
  code?: string
}

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

// Mirrors the shape of the inbox and ownership transactions: read first, then
// write in the same transaction. The busy handler blocks this thread, so the
// connection lives in a worker while the holder commits from the test thread.
function attempt(input: UpgradeAttempt): UpgradeResult {
  const db = new Database(input.file)
  try {
    db.run(`PRAGMA busy_timeout = ${input.busyTimeoutMs}`)
    const readThenWrite = db.transaction(() => {
      db.query("SELECT count(*) FROM t").get()
      db.run("INSERT INTO t (id) VALUES (?)", [input.id])
    })
    const start = performance.now()
    try {
      readThenWrite[input.behavior]()
      return { ok: true, elapsedMs: performance.now() - start }
    } catch (error) {
      return { ok: false, elapsedMs: performance.now() - start, code: errorCode(error) }
    }
  } finally {
    db.close()
  }
}

self.onmessage = (event: MessageEvent<UpgradeAttempt>) => {
  self.postMessage(attempt(event.data))
}
