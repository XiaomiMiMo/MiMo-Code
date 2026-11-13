// packages/cli/src/cli/cmd/run-completion.ts

export type StatusInfo = { type: "idle" | "busy" | "retry" | "notice"; [k: string]: unknown }

/**
 * Returns the tracked session's current status, or undefined when it has no
 * record. That covers both a session that has not turned busy yet and one that
 * has just gone idle, so an absent record alone is not a completion signal.
 */
export type StatusQuery = () => Promise<StatusInfo | undefined>

export interface CompletionTracker {
  markStarted(): void
  onEvent(event: unknown): void
  readonly done: boolean
  readonly completion: Promise<void>
  stop(): void
}

export interface CreateOpts {
  sessionID: string
  query: StatusQuery
  intervalMs?: number
}

export function createCompletionTracker(opts: CreateOpts): CompletionTracker {
  let done = false
  let started = false
  let seenLive = false
  let resolve!: () => void
  const completion = new Promise<void>((r) => { resolve = r })

  const matchesSession = (e: unknown): boolean => {
    const ev = e as { properties?: { sessionID?: string; part?: { sessionID?: string } } } | null
    return !!ev && (
      ev.properties?.sessionID === opts.sessionID ||
      ev.properties?.part?.sessionID === opts.sessionID
    )
  }

  const statusForSession = (e: unknown): StatusInfo | undefined => {
    const ev = e as { type?: string; properties?: { sessionID?: string; status?: StatusInfo } } | null
    if (!ev || ev.type !== "session.status" || ev.properties?.sessionID !== opts.sessionID) return undefined
    return ev.properties?.status
  }

  const poll = async () => {
    if (done) return
    let info: StatusInfo | undefined
    try {
      info = await opts.query()
    } catch {
      return // transient failure; next tick will retry
    }
    if (done || !started) return
    if (info) {
      if (info.type === "idle") finish()
      else seenLive = true
      return
    }
    // An absent record is ambiguous: it is what a session that has not turned
    // busy yet and one that has just gone idle both look like, because idle
    // deletes the record rather than replacing it. Only the second is terminal,
    // and only a live status seen earlier tells the two apart.
    if (seenLive) finish()
  }

  const intervalMs = opts.intervalMs ?? 750
  const timer = setInterval(() => { poll().catch(() => {}) }, intervalMs)

  const finish = () => {
    if (done) return
    done = true
    clearInterval(timer)
    resolve()
  }

  return {
    markStarted() { started = true },
    onEvent(event) {
      if (done) return
      if (matchesSession(event)) started = true
      const status = statusForSession(event)
      if (!status) return
      if (status.type === "idle") finish()
      else seenLive = true
    },
    get done() { return done },
    completion,
    stop() { finish() },
  }
}
