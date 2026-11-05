import { Database } from "bun:sqlite"

export type Attempt = {
  file: string
  id: number
  busyTimeoutMs: number
}

export type AttemptResult = {
  ok: boolean
  elapsedMs: number
  code?: string
  message?: string
}

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

// A blocking busy handler freezes the thread that called it, so the connection
// holding a lock and the connection waiting for it cannot share a thread: the
// holder would never get to commit. This worker owns the waiting connection.
function attempt(input: Attempt): AttemptResult {
  const db = new Database(input.file)
  try {
    db.run(`PRAGMA busy_timeout = ${input.busyTimeoutMs}`)
    const start = performance.now()
    try {
      db.run("INSERT INTO t (id) VALUES (?)", [input.id])
      return { ok: true, elapsedMs: performance.now() - start }
    } catch (error) {
      return {
        ok: false,
        elapsedMs: performance.now() - start,
        code: errorCode(error),
        message: error instanceof Error ? error.message : String(error),
      }
    }
  } finally {
    db.close()
  }
}

self.onmessage = (event: MessageEvent<Attempt>) => {
  self.postMessage(attempt(event.data))
}
